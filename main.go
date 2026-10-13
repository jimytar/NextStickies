// NextStickies: sticky notes stored as Markdown and synced with Nextcloud Notes over WebDAV.
//
// Threading: all UI state (windows, stickies, settings, status) is owned by the UI main thread, like Electron's main
// process. Wails calls bound methods, menu clicks and timers on other goroutines; they hop over with onMain. Network
// sync runs off the main thread; notes.Store has its own lock.
package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/jimytar/NextStickies/internal/notes"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/icon.png
var iconPNG []byte

var version = "0.0.0" // set with -ldflags "-X main.version=…"

// onMain runs fn on the UI thread and waits for it (inline when already there).
func onMain(fn func()) { application.InvokeSync(fn) }

func main() {
	configDir, err := os.UserConfigDir()
	if err != nil {
		log.Fatal(err)
	}
	dataDir := migrateDataDir(filepath.Join(configDir, "NcStickyNotes"), filepath.Join(configDir, "NextStickies"))
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatal(err)
	}
	store, err := notes.NewStore(filepath.Join(dataDir, "Notes"), filepath.Join(dataDir, "metadata.json"))
	if err != nil {
		log.Fatal(err)
	}
	a := &App{
		dataDir:      dataDir,
		settingsFile: filepath.Join(dataDir, "settings.json"),
		stateFile:    filepath.Join(dataDir, "sync-state.json"),
		store:        store,
		status:       "Sync not set up",
		stickies:     map[string]*sticky{},
	}
	if a.settings, err = loadSettings(a.settingsFile); err != nil {
		log.Fatal(err)
	}
	migrateStartWithLogin()

	dist, _ := fs.Sub(assets, "frontend/dist")
	mux := http.NewServeMux()
	// Images in notes are relative (.attachments.<id>/x.png) to the note's folder, served under /notes/.
	mux.HandleFunc("/notes/", func(w http.ResponseWriter, r *http.Request) {
		full, err := store.FullPath(strings.TrimPrefix(r.URL.Path, "/notes/"))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		f, err := os.Open(full)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		http.ServeContent(w, r, info.Name(), info.ModTime(), f)
	})
	mux.Handle("/", http.FileServerFS(dist))

	exitRequested := slices.Contains(os.Args[1:], "--exit") // sent by the Windows installer before upgrading
	a.app = application.New(application.Options{
		Name:        "NextStickies",
		Description: "Sticky notes synced with Nextcloud Notes",
		Icon:        iconPNG,
		Services:    []application.Service{application.NewService(&Backend{a})},
		Assets:      application.AssetOptions{Handler: mux, DisableLogging: true},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "com.jimytar.nextstickies",
			OnSecondInstanceLaunch: func(d application.SecondInstanceData) {
				if slices.Contains(d.Args, "--exit") {
					a.quit()
				} else {
					onMain(a.showList)
				}
			},
		},
		Windows: application.WindowsOptions{
			DisableQuitOnLastWindowClosed: true, // keep running in the tray
			WebviewUserDataPath:           filepath.Join(dataDir, "webview"),
		},
		Linux: application.LinuxOptions{
			DisableQuitOnLastWindowClosed: true,
			ApplicationID:                 "com.jimytar.nextstickies",
		},
		OnShutdown: a.flushAll, // logoff / shutdown: save typing that is still pending
	})
	if exitRequested {
		return // no running instance to stop
	}
	a.app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) { go a.start() })
	if err := a.app.Run(); err != nil {
		log.Fatal(err)
	}
}

// migrateDataDir moves the pre-rename data folder ("NC Sticky Notes" 1.x/2.0) once. Keeps using it if it is in use.
func migrateDataDir(old, next string) string {
	if _, err := os.Stat(next); err == nil {
		return next
	}
	if _, err := os.Stat(old); err != nil {
		return next
	}
	if err := os.Rename(old, next); err != nil {
		return old
	}
	return next
}

func (a *App) start() {
	onMain(func() {
		a.createEngine()
		a.createTray()
		opened := 0
		for _, m := range a.store.AllMeta() {
			if m.IsOpen && m.Path != "" && a.store.Exists(string(m.Path)) {
				a.openSticky(m.Id)
				opened++
			}
		}
		if opened == 0 && !a.settings.StartMinimized {
			a.showList()
		}
	})
	a.syncNow()
	for range time.Tick(time.Minute) {
		a.syncNow()
	}
}

func (a *App) quit() {
	a.flushAll()
	a.app.Quit()
}
