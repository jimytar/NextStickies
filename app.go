package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/png"
	"net/url"
	"os"
	"path"
	"regexp"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/jimytar/NextStickies/internal/notes"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// App fields are owned by the UI main thread unless noted.
type App struct {
	app          *application.App
	dataDir      string
	settingsFile string
	stateFile    string
	store        *notes.Store // thread-safe
	settings     Settings
	engine       *notes.SyncEngine
	status       string
	list         *application.WebviewWindow
	settingsWin  *application.WebviewWindow
	quitting     atomic.Bool
	syncDebounce *time.Timer
	stickies     map[string]*sticky // by note id
}

type sticky struct {
	id        string
	win       *application.WebviewWindow
	lastSaved string
	pending   *string
	saveTimer *time.Timer
	discarded bool
}

// ---- Sync ------------------------------------------------------------------------------------------------------

func (a *App) createEngine() {
	a.engine = nil
	if !a.settings.isConfigured() {
		a.setStatus("Sync not set up")
		return
	}
	password, err := a.settings.password()
	if err != nil {
		a.setStatus("Saved password could not be read on this machine — re-enter it in Settings")
		return
	}
	dav := notes.NewWebDavClient(a.settings.ServerUrl, a.settings.User, password, a.settings.Folder, nil)
	if a.engine, err = notes.NewSyncEngine(a.store, dav, a.stateFile); err != nil {
		a.setStatus("Sync state could not be read: " + err.Error())
	}
}

func (a *App) setStatus(s string) {
	a.status = s
	a.app.Event.Emit("status", s)
}

func (a *App) notesChanged() { a.app.Event.Emit("notes-changed") }

// requestSync is called after every local edit; batches edits into one sync.
func (a *App) requestSync() {
	a.notesChanged()
	if a.syncDebounce != nil {
		a.syncDebounce.Stop()
	}
	a.syncDebounce = time.AfterFunc(2*time.Second, a.syncNow)
}

// syncNow runs a sync and applies its result. Blocks on the network: never call it on the main thread.
func (a *App) syncNow() {
	var engine *notes.SyncEngine
	onMain(func() {
		if engine = a.engine; engine != nil {
			for _, s := range a.stickies {
				a.flush(s)
			}
			a.setStatus("Syncing…")
		}
	})
	if engine == nil {
		return
	}
	result, err := engine.Sync()
	onMain(func() {
		if err != nil {
			a.setStatus("Sync failed: " + err.Error()) // background sync never takes the app down
			return
		}
		_ = a.store.Reconcile(result.FileIds)
		for _, s := range mapValues(a.stickies) {
			a.onSynced(s, result)
		}
		a.notesChanged()
		text := "Synced " + time.Now().Format("15:04")
		if len(result.Locked) > 0 {
			titles := make([]string, len(result.Locked))
			for i, p := range result.Locked {
				titles[i] = notes.TitleOf(p)
			}
			text += " · locked on Nextcloud and could not unlock, will retry: " + strings.Join(titles, ", ")
		}
		a.setStatus(text)
	})
}

func mapValues[K comparable, V any](m map[K]V) []V {
	values := make([]V, 0, len(m))
	for _, v := range m {
		values = append(values, v)
	}
	return values
}

// ---- Tray & list -----------------------------------------------------------------------------------------------

func (a *App) createTray() {
	tray := a.app.SystemTray.New()
	tray.SetIcon(iconPNG)
	tray.SetTooltip("NextStickies")
	menu := application.NewMenu()
	menu.Add("Notes list").OnClick(func(*application.Context) { onMain(a.showList) })
	menu.Add("New note").OnClick(func(*application.Context) { onMain(a.newNote) })
	menu.Add("Sync now").OnClick(func(*application.Context) { a.syncNow() })
	menu.AddSeparator()
	menu.Add("Exit").OnClick(func(*application.Context) { a.quit() })
	tray.SetMenu(menu)
	tray.OnClick(func() { onMain(a.showList) })
}

func (a *App) showList() {
	if a.list != nil {
		if a.list.IsMinimised() {
			a.list.Restore()
		}
		a.list.Show()
		a.list.Focus()
		return
	}
	a.list = a.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name: "list", Title: "NextStickies", URL: "/list.html",
		Width: 400, Height: 780, MinWidth: 300, MinHeight: 300, Frameless: true,
		BackgroundColour: application.NewRGB(0x20, 0x20, 0x20),
	})
	a.list.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		if a.quitting.Load() {
			return
		}
		e.Cancel() // closing hides to the tray
		a.list.Hide()
	})
}

func (a *App) showSettings() {
	if a.settingsWin != nil {
		a.settingsWin.Focus()
		return
	}
	a.settingsWin = a.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name: "settings", Title: "Settings", URL: "/settings.html",
		Width: 440, Height: 600, DisableResize: true,
		BackgroundColour: application.NewRGB(0x20, 0x20, 0x20),
		Windows:          application.WindowsWindow{Theme: application.Dark}, // dark title bar
	})
	a.settingsWin.RegisterHook(events.Common.WindowClosing, func(*application.WindowEvent) { a.settingsWin = nil })
}

type NoteCard struct {
	Id       string `json:"id"`
	Color    string `json:"color"`
	Modified int64  `json:"modified"` // ms since epoch; the page formats it in the user's locale
	Preview  string `json:"preview"`
}

func (a *App) noteCards(query string) []NoteCard {
	q := strings.ToLower(strings.TrimSpace(query))
	cards := []NoteCard{}
	for _, n := range a.store.ListNotes() {
		if q != "" && !strings.Contains(strings.ToLower(n.Title), q) && !strings.Contains(strings.ToLower(n.Content), q) {
			continue
		}
		meta := a.store.MetaFor(n.Path)
		cards = append(cards, NoteCard{Id: meta.Id, Color: meta.Color, Modified: n.Modified.UnixMilli(), Preview: preview(n.Content)})
	}
	return cards
}

var (
	mdImage    = regexp.MustCompile(`!\[[^\]]*\]\([^)]*\)`)
	mdLink     = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
	mdLineMark = regexp.MustCompile(`(?m)^\s*(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+)`)
	mdInline   = regexp.MustCompile("(\\*\\*|__|~~|\\*|`)")
	mdEscape   = regexp.MustCompile("\\\\([\\\\`*_{}\\[\\]()#+\\-.!~|>])")
)

// preview is a plain-text preview of a markdown note.
func preview(markdown string) string {
	text := mdLink.ReplaceAllString(mdImage.ReplaceAllString(markdown, "🖼"), "$1")
	text = mdInline.ReplaceAllString(mdLineMark.ReplaceAllString(text, ""), "")
	text = mdEscape.ReplaceAllString(text, "$1")
	var lines []string
	for _, l := range strings.Split(text, "\n") {
		if l = strings.TrimSpace(l); l != "" && l != "---" && len(lines) < 6 {
			lines = append(lines, l)
		}
	}
	return strings.Join(lines, "\n")
}

func (a *App) deleteNote(id string, parent *application.WebviewWindow) {
	dialog := a.app.Dialog.Question().SetTitle("Delete note").SetMessage("Delete this note? It is also deleted from Nextcloud.")
	dialog.AddButton("Yes").OnClick(func() {
		onMain(func() {
			if s := a.stickies[id]; s != nil {
				a.closeDiscarded(s)
			}
			_ = a.store.DeleteNote(id)
			a.requestSync()
		})
	})
	no := dialog.AddButton("No")
	dialog.SetDefaultButton(no).SetCancelButton(no)
	if parent != nil {
		dialog.AttachToWindow(parent)
	}
	dialog.Show()
}

// ---- Sticky windows --------------------------------------------------------------------------------------------

func (a *App) newNote() { a.openSticky(a.store.NewMeta().Id) }

func (a *App) openSticky(id string) {
	if s := a.stickies[id]; s != nil {
		s.win.Focus()
		return
	}
	meta, ok := a.store.UpdateMeta(id, func(m *notes.Meta) { m.IsOpen = true })
	if !ok {
		return
	}
	title := "New note"
	if meta.Path != "" {
		title = notes.TitleOf(string(meta.Path))
	}
	opts := application.WebviewWindowOptions{
		Name: "sticky-" + id, Title: title, URL: "/sticky.html?id=" + url.QueryEscape(id),
		Width: int(meta.Width), Height: int(meta.Height), MinWidth: 220, MinHeight: 160, Frameless: true,
		BackgroundColour: application.NewRGB(0x33, 0x33, 0x33),
	}
	opts.InitialPosition, opts.X, opts.Y = a.position(meta)
	s := &sticky{id: id}
	s.win = a.app.Window.NewWithOptions(opts)
	a.stickies[id] = s
	s.win.RegisterHook(events.Common.WindowClosing, func(*application.WindowEvent) {
		a.flush(s)
		if !s.discarded && !s.win.IsMinimised() && !s.win.IsMaximised() {
			b := s.win.Bounds()
			a.store.UpdateMeta(id, func(m *notes.Meta) {
				x, y := float64(b.X), float64(b.Y)
				m.Left, m.Top, m.Width, m.Height = &x, &y, float64(b.Width), float64(b.Height)
			})
		}
		delete(a.stickies, id)
	})
}

// position returns the saved position if it is still on a screen, else cascades near the centre.
func (a *App) position(meta notes.Meta) (application.WindowStartPosition, int, int) {
	if meta.Left != nil && meta.Top != nil {
		x, y := int(*meta.Left+0.5), int(*meta.Top+0.5)
		for _, d := range a.app.Screen.GetAll() {
			w := d.WorkArea
			if x >= w.X-50 && y >= w.Y-10 && x < w.X+w.Width-50 && y < w.Y+w.Height-30 {
				return application.WindowXY, x, y
			}
		}
	}
	primary := a.app.Screen.GetPrimary()
	if primary == nil {
		return application.WindowCentered, 0, 0
	}
	area, offset := primary.WorkArea, 30*len(a.stickies)
	return application.WindowXY, area.X + area.Width/2 - int(meta.Width)/2 + offset, area.Y + area.Height/3 - int(meta.Height)/3 + offset
}

type LoadPayload struct {
	Markdown string `json:"markdown"`
	BaseUrl  string `json:"baseUrl"`
	Color    string `json:"color"`
}

func (a *App) loadPayload(s *sticky) *LoadPayload {
	meta, _ := a.store.MetaById(s.id)
	s.lastSaved = ""
	baseUrl := "/notes/"
	if meta.Path != "" {
		s.lastSaved, _ = a.store.ReadNote(string(meta.Path))
		for _, seg := range strings.Split(notes.ParentOf(string(meta.Path)), "/") {
			if seg != "" {
				baseUrl += notes.EncodeURIComponent(seg) + "/"
			}
		}
	}
	return &LoadPayload{Markdown: s.lastSaved, BaseUrl: baseUrl, Color: meta.Color}
}

// flush writes pending editor text to disk. Empty new notes are not created.
func (a *App) flush(s *sticky) {
	if s.saveTimer != nil {
		s.saveTimer.Stop()
	}
	if s.pending == nil || s.discarded {
		return
	}
	text := *s.pending
	s.pending = nil
	meta, ok := a.store.MetaById(s.id)
	if !ok || text == s.lastSaved || meta.Path == "" && strings.TrimSpace(text) == "" {
		return
	}
	p, err := a.store.SaveNote(s.id, text)
	if err != nil {
		a.setStatus("Could not save note: " + err.Error())
		return
	}
	s.lastSaved = text
	if !a.quitting.Load() {
		s.win.SetTitle(notes.TitleOf(p))
	}
	a.requestSync()
}

// flushAll saves all pending typing before the app exits.
func (a *App) flushAll() {
	if a.quitting.Swap(true) {
		return
	}
	onMain(func() {
		for _, s := range a.stickies {
			a.flush(s)
		}
	})
}

// onSynced runs after a sync: closes the note if it was deleted on Nextcloud, reloads it if it changed there.
func (a *App) onSynced(s *sticky, result notes.SyncResult) {
	meta, ok := a.store.MetaById(s.id)
	if !ok {
		a.closeDiscarded(s) // dropped by Reconcile: deleted on Nextcloud
		return
	}
	if meta.Path == "" {
		return
	}
	p := string(meta.Path)
	if !a.store.Exists(p) {
		a.closeDiscarded(s)
		return
	}
	s.win.SetTitle(notes.TitleOf(p))
	if text, _ := a.store.ReadNote(p); !result.LocalChanges[p] || text == s.lastSaved {
		return
	}
	// Typing that hasn't been saved yet is the newest edit: keep it; saving it overwrites the server version.
	if s.pending != nil && *s.pending != s.lastSaved {
		return
	}
	a.app.Event.Emit("sticky:load", map[string]any{"id": s.id, "payload": a.loadPayload(s)})
}

func (a *App) closeDiscarded(s *sticky) {
	s.discarded = true
	s.win.Close()
}

var imageExt = map[string]string{"image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg"}

type ImageResult struct {
	Src   string `json:"src,omitempty"`
	Error string `json:"error,omitempty"`
}

// addImage stores a pasted/dropped image next to the note. Runs off the main thread (it may wait for a sync).
func (a *App) addImage(id string, data []byte, mime, name string) ImageResult {
	var notePath, errText string
	var engine *notes.SyncEngine
	onMain(func() {
		s := a.stickies[id]
		if engine = a.engine; s == nil || engine == nil {
			errText = "Set up Nextcloud sync (gear in the notes list) to add images."
			return
		}
		a.flush(s)
		meta, _ := a.store.MetaById(id)
		notePath = string(meta.Path)
		if notePath == "" {
			var err error
			if notePath, err = a.store.SaveNote(id, s.lastSaved); err != nil {
				errText = err.Error()
				return
			}
			s.win.SetTitle(notes.TitleOf(notePath))
		}
	})
	if errText != "" {
		return ImageResult{Error: errText}
	}
	fileId := engine.FileIdOf(notePath)
	if fileId == "" {
		a.syncNow() // the note must exist on Nextcloud: images live in .attachments.<fileId>/
		var status string
		onMain(func() {
			engine, status = a.engine, a.status
			if meta, ok := a.store.MetaById(id); ok && meta.Path != "" {
				notePath = string(meta.Path) // may have been renamed on Nextcloud
			}
		})
		if engine != nil {
			fileId = engine.FileIdOf(notePath)
		}
		if fileId == "" {
			return ImageResult{Error: "Can't add images until the note is on Nextcloud. " + status}
		}
	}
	if path.Ext(name) == "" {
		ext, ok := imageExt[mime]
		if !ok {
			ext = ".png"
		}
		if name == "" {
			name = "image"
		}
		name += ext
	}
	src, err := a.store.SaveAttachment(notePath, fileId, name, data)
	if err != nil {
		return ImageResult{Error: err.Error()}
	}
	onMain(a.requestSync)
	return ImageResult{Src: src}
}

func (a *App) openExternal(href string) {
	if u, err := url.Parse(href); err == nil && slices.Contains([]string{"http", "https", "mailto"}, u.Scheme) {
		_ = a.app.Browser.OpenURL(href)
	} // relative or malformed link: ignore
}

func (a *App) showStickyMenu(s *sticky, x, y int) {
	meta, _ := a.store.MetaById(s.id)
	menu := a.app.ContextMenu.New()
	for _, c := range notes.NoteColors {
		name, hex := c[0], c[1]
		menu.AddRadio(name, strings.EqualFold(hex, meta.Color)).SetBitmap(swatch(hex)).OnClick(func(*application.Context) {
			onMain(func() {
				a.store.UpdateMeta(s.id, func(m *notes.Meta) { m.Color = hex })
				a.app.Event.Emit("sticky:color", map[string]string{"id": s.id, "color": hex})
				a.notesChanged()
			})
		})
	}
	menu.AddSeparator()
	menu.Add("Notes list").OnClick(func(*application.Context) { onMain(a.showList) })
	menu.Add("Delete note").OnClick(func(*application.Context) { onMain(func() { a.deleteNote(s.id, s.win) }) })
	a.app.ContextMenu.Add("sticky", menu)
	s.win.OpenContextMenu(&application.ContextMenuData{Id: "sticky", X: x, Y: y})
}

// swatch is a 14×14 PNG of the colour for the menu.
func swatch(hex string) []byte {
	var r, g, b uint8
	fmt.Sscanf(hex, "#%02x%02x%02x", &r, &g, &b)
	img := image.NewNRGBA(image.Rect(0, 0, 14, 14))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = r, g, b, 0xff
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

// ---- Settings --------------------------------------------------------------------------------------------------

type SettingsView struct {
	ServerUrl      string `json:"serverUrl"`
	User           string `json:"user"`
	Folder         string `json:"folder"`
	HasPassword    bool   `json:"hasPassword"`
	StartWithLogin bool   `json:"startWithLogin"`
	StartMinimized bool   `json:"startMinimized"`
	Version        string `json:"version"`
	LoginLabel     string `json:"loginLabel"`
}

type SettingsInput struct {
	ServerUrl      string `json:"serverUrl"`
	User           string `json:"user"`
	Password       string `json:"password"`
	Folder         string `json:"folder"`
	StartWithLogin bool   `json:"startWithLogin"`
	StartMinimized bool   `json:"startMinimized"`
}

type SaveResult struct {
	Ok      bool   `json:"ok"`
	Message string `json:"message"`
}

// saveSettings tests the connection before switching to new settings. Runs off the main thread.
func (a *App) saveSettings(p SettingsInput) SaveResult {
	_ = setStartWithLogin(p.StartWithLogin)
	var current Settings
	onMain(func() {
		a.settings.StartMinimized = p.StartMinimized // app preferences apply even if the connection test fails
		_ = saveSettings(a.settingsFile, a.settings)
		current = a.settings
	})

	serverUrl := strings.TrimRight(strings.TrimSpace(p.ServerUrl), "/")
	if serverUrl != "" && !strings.Contains(serverUrl, "://") {
		serverUrl = "https://" + serverUrl
	}
	next := current
	next.ServerUrl, next.User = serverUrl, strings.TrimSpace(p.User)
	if next.Folder = strings.Trim(strings.TrimSpace(p.Folder), "/"); next.Folder == "" {
		next.Folder = "Notes"
	}
	if p.Password != "" {
		if err := next.setPassword(p.Password); err != nil {
			return SaveResult{Message: "Could not store the password securely: " + err.Error()}
		}
	}
	if serverUrl == "" || next.User == "" {
		_ = next.setPassword("") // cleared → local-only
	} else {
		if !next.hasPassword() {
			return SaveResult{Message: "Enter the app password."}
		}
		password, err := next.password()
		if err != nil {
			return SaveResult{Message: "The saved password could not be read on this machine — enter it again."}
		}
		items, err := notes.NewWebDavClient(next.ServerUrl, next.User, password, next.Folder, nil).List()
		if err != nil {
			return SaveResult{Message: "Connection failed: " + err.Error()}
		}
		count := 0
		for _, i := range items {
			if !i.IsDirectory && notes.IsNote(i.Path) {
				count++
			}
		}
		onMain(func() { a.setStatus(fmt.Sprintf("Connected — %d notes in /%s. Syncing…", count, next.Folder)) })
	}
	// Different folder: compare everything afresh (identical files stay, differing ones resolve by newest edit).
	if next.remoteKey() != current.remoteKey() {
		_ = os.Remove(a.stateFile)
	}
	var message string
	onMain(func() {
		a.settings = next
		_ = saveSettings(a.settingsFile, a.settings)
		a.createEngine()
		if a.engine != nil {
			a.setStatus("Syncing…")
		}
		message = a.status
	})
	go a.syncNow()
	return SaveResult{Ok: true, Message: message}
}

// ---- Bound API (window.api in the pages) -----------------------------------------------------------------------

// Backend is the only surface the pages get. Methods run on Wails goroutines.
type Backend struct{ a *App }

func (b *Backend) withSticky(id string, fn func(*sticky)) {
	onMain(func() {
		if s := b.a.stickies[id]; s != nil {
			fn(s)
		}
	})
}

func (b *Backend) StickyInit(id string) (p *LoadPayload) {
	b.withSticky(id, func(s *sticky) { p = b.a.loadPayload(s) })
	return
}

func (b *Backend) StickyChanged(id, markdown string) {
	b.withSticky(id, func(s *sticky) {
		s.pending = &markdown
		if s.saveTimer != nil {
			s.saveTimer.Stop()
		}
		s.saveTimer = time.AfterFunc(500*time.Millisecond, func() { onMain(func() { b.a.flush(s) }) })
	})
}

func (b *Backend) StickyPasteImage(id, dataBase64, mime, name string) ImageResult {
	data, err := base64.StdEncoding.DecodeString(dataBase64)
	if err != nil {
		return ImageResult{Error: "Could not read the image."}
	}
	return b.a.addImage(id, data, mime, name)
}

func (b *Backend) OpenLink(href string) { b.a.openExternal(href) }

func (b *Backend) NewNote() { onMain(b.a.newNote) }

func (b *Backend) StickyMenu(id string, x, y int) {
	b.withSticky(id, func(s *sticky) { b.a.showStickyMenu(s, x, y) })
}

// StickyClose is the × button: hides the note (it stays in the list). A note that was never typed in is dropped.
func (b *Backend) StickyClose(id string) {
	b.withSticky(id, func(s *sticky) {
		b.a.flush(s)
		meta, _ := b.a.store.UpdateMeta(id, func(m *notes.Meta) { m.IsOpen = false })
		if meta.Path == "" {
			_ = b.a.store.DeleteNote(id)
		}
		s.win.Close()
	})
}

func (b *Backend) ListNotes(query string) []NoteCard { return b.a.noteCards(query) }

func (b *Backend) OpenNote(id string) { onMain(func() { b.a.openSticky(id) }) }

func (b *Backend) DeleteNote(id string) {
	onMain(func() {
		if _, ok := b.a.store.MetaById(id); ok {
			b.a.deleteNote(id, b.a.list)
		}
	})
}

func (b *Backend) ShowSettings() { onMain(b.a.showSettings) }

func (b *Backend) CloseList() {
	onMain(func() {
		if b.a.list != nil {
			b.a.list.Close()
		}
	})
}

func (b *Backend) CloseSettings() {
	onMain(func() {
		if b.a.settingsWin != nil {
			b.a.settingsWin.Close()
		}
	})
}

func (b *Backend) Status() (status string) {
	onMain(func() { status = b.a.status })
	return
}

func (b *Backend) GetSettings() (v SettingsView) {
	onMain(func() {
		s := b.a.settings
		v = SettingsView{ServerUrl: s.ServerUrl, User: s.User, Folder: s.Folder, HasPassword: s.hasPassword(),
			StartMinimized: s.StartMinimized, Version: version, LoginLabel: loginLabel}
	})
	v.StartWithLogin = startWithLogin()
	return
}

func (b *Backend) SaveSettings(p SettingsInput) SaveResult { return b.a.saveSettings(p) }

func (b *Backend) SyncNow() { go b.a.syncNow() }
