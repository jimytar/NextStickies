// Package notes owns the local mirror of the Nextcloud Notes folder, the per-PC note metadata and the two-way
// WebDAV sync. File formats (metadata.json, sync-state.json) match the 1.x and Electron apps so installs upgrade in
// place.
package notes

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Meta is sticky-only window state, kept on this PC only so the .md files stay clean for Nextcloud Notes.
type Meta struct {
	Id string
	// Relative path ("Category/Title.md"); empty until a new note is first saved.
	Path NullString
	// Nextcloud file id; survives renames made by the Nextcloud Notes app.
	FileId NullString
	Color  string
	Left   *float64
	Top    *float64
	Width  float64
	Height float64
	IsOpen bool
}

const DefaultColor = "#e6b905"

var NoteColors = [][2]string{
	{"Yellow", "#e6b905"}, {"Green", "#6fd262"}, {"Pink", "#ea86c2"}, {"Purple", "#c78eff"},
	{"Blue", "#5ac0e7"}, {"Gray", "#aaaaaa"}, {"Charcoal", "#555555"},
}

type NoteInfo struct {
	Path     string
	Title    string
	Content  string
	Modified time.Time
}

const (
	noteExt    = ".md"
	tempSuffix = ".ncsn-tmp"
)

// NullString is a string stored as JSON null when empty (the formats shared with the other app versions use null).
type NullString string

func (s NullString) MarshalJSON() ([]byte, error) {
	if s == "" {
		return []byte("null"), nil
	}
	return json.Marshal(string(s))
}

func (s *NullString) UnmarshalJSON(b []byte) error {
	var v *string
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*s = ""
	if v != nil {
		*s = NullString(*v)
	}
	return nil
}

// Hash is the upper-case hex SHA-256 used in sync-state.json.
func Hash(data []byte) string {
	sum := sha256.Sum256(data)
	return strings.ToUpper(hex.EncodeToString(sum[:]))
}

func ParentOf(rel string) string {
	if i := strings.LastIndex(rel, "/"); i >= 0 {
		return rel[:i]
	}
	return ""
}

func TitleOf(rel string) string {
	base := path.Base(rel)
	return strings.TrimSuffix(base, path.Ext(base))
}

func IsNote(rel string) bool {
	if !strings.HasSuffix(strings.ToLower(rel), noteExt) {
		return false
	}
	for _, seg := range strings.Split(rel, "/") {
		if strings.HasPrefix(seg, ".") {
			return false
		}
	}
	return true
}

func join(dir, name string) string {
	if dir == "" {
		return name
	}
	return dir + "/" + name
}

func SanitizeFileName(name, fallback string) string {
	var b strings.Builder
	for _, c := range name {
		if c >= ' ' && !strings.ContainsRune(`\/:*?"<>|`, c) {
			b.WriteRune(c)
		}
	}
	clean := strings.TrimSpace(strings.Trim(strings.TrimSpace(b.String()), "."))
	if utf8.RuneCountInString(clean) > 100 {
		clean = strings.TrimSpace(string([]rune(clean)[:100]))
	}
	if clean == "" {
		return fallback
	}
	return clean
}

var leadingMarkup = regexp.MustCompile(`^[#\-*>\[\] x]+`)

// FileNameFromContent names a note after its first non-empty line (Nextcloud Notes convention).
func FileNameFromContent(markdown string) string {
	first := ""
	for _, l := range strings.Split(markdown, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			first = l
			break
		}
	}
	first = leadingMarkup.ReplaceAllString(first, "")
	first = strings.ReplaceAll(strings.ReplaceAll(first, "**", ""), "~~", "")
	return SanitizeFileName(first, "New note")
}

// EncodeURIComponent matches JavaScript's encodeURIComponent (attachment links must stay identical across apps).
func EncodeURIComponent(s string) string {
	const unreserved = "-_.!~*'()"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte(unreserved, c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// Store is safe for concurrent use: the UI and the sync engine both call it. Metadata is handed out as copies and
// changed through UpdateMeta so it is only ever touched under the lock.
type Store struct {
	Root     string
	metaFile string
	mu       sync.Mutex
	meta     []*Meta
}

func NewStore(root, metaFile string) (*Store, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	s := &Store{Root: root, metaFile: metaFile}
	if data, err := os.ReadFile(metaFile); err == nil {
		if err := json.Unmarshal(data, &s.meta); err != nil {
			return nil, fmt.Errorf("%s: %w", metaFile, err)
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	return s, nil
}

// FullPath maps a relative note path to the file system, refusing paths outside the notes folder.
func (s *Store) FullPath(rel string) (string, error) {
	full := filepath.Join(append([]string{s.Root}, strings.Split(rel, "/")...)...)
	if full != s.Root && !strings.HasPrefix(full, s.Root+string(filepath.Separator)) {
		return "", fmt.Errorf("path outside notes folder: %s", rel)
	}
	return full, nil
}

func (s *Store) Exists(rel string) bool {
	full, err := s.FullPath(rel)
	if err != nil {
		return false
	}
	_, err = os.Stat(full)
	return err == nil
}

// ---- Notes -----------------------------------------------------------------------------------------------------

func (s *Store) ListNotes() []NoteInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	var notes []NoteInfo
	for _, rel := range s.listFiles() {
		if !IsNote(rel) {
			continue
		}
		full, _ := s.FullPath(rel)
		data, err := os.ReadFile(full)
		info, err2 := os.Stat(full)
		if err != nil || err2 != nil {
			continue
		}
		notes = append(notes, NoteInfo{Path: rel, Title: TitleOf(rel), Content: string(data), Modified: info.ModTime()})
	}
	slices.SortStableFunc(notes, func(a, b NoteInfo) int { return b.Modified.Compare(a.Modified) })
	return notes
}

func (s *Store) ReadNote(rel string) (string, bool) {
	data := s.ReadBytes(rel)
	return string(data), data != nil
}

// SaveNote saves note text and returns the note's path. A note without a path gets a file named after its first line.
func (s *Store) SaveNote(id, markdown string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.byId(id)
	if m == nil {
		return "", fmt.Errorf("unknown note %s", id)
	}
	if m.Path == "" {
		m.Path = NullString(s.uniquePath("", FileNameFromContent(markdown), noteExt))
		if err := s.saveMeta(); err != nil {
			return "", err
		}
	}
	return string(m.Path), s.writeAtomic(string(m.Path), []byte(markdown))
}

func (s *Store) DeleteNote(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.byId(id)
	if m == nil {
		return nil
	}
	if m.Path != "" {
		if full, err := s.FullPath(string(m.Path)); err == nil {
			if err := os.Remove(full); err != nil && !errors.Is(err, fs.ErrNotExist) {
				return err
			}
		}
	}
	s.meta = slices.DeleteFunc(s.meta, func(x *Meta) bool { return x == m })
	return s.saveMeta()
}

// SaveAttachment stores an image under ".attachments.<fileId>/" next to the note, as Nextcloud Text does, and
// returns the markdown src.
func (s *Store) SaveAttachment(notePath, fileId, name string, data []byte) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	attachDir := ".attachments." + fileId
	ext := strings.ToLower(path.Ext(name))
	base := SanitizeFileName(strings.TrimSuffix(path.Base(name), path.Ext(name)), "image")
	rel := s.uniquePath(join(ParentOf(notePath), attachDir), base, ext)
	if err := s.writeAtomic(rel, data); err != nil {
		return "", err
	}
	return attachDir + "/" + EncodeURIComponent(path.Base(rel)), nil
}

func (s *Store) uniquePath(dir, base, ext string) string {
	rel := join(dir, base+ext)
	for i := 2; s.Exists(rel); i++ {
		rel = join(dir, fmt.Sprintf("%s (%d)%s", base, i, ext))
	}
	return rel
}

// ---- Raw files (used by the sync engine) -----------------------------------------------------------------------

func (s *Store) ListFiles() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.listFiles()
}

func (s *Store) listFiles() []string {
	var files []string
	_ = filepath.WalkDir(s.Root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.Type().IsRegular() || strings.HasSuffix(d.Name(), tempSuffix) {
			return nil
		}
		if rel, err := filepath.Rel(s.Root, p); err == nil {
			files = append(files, filepath.ToSlash(rel))
		}
		return nil
	})
	return files
}

// HashOf returns the file's hash, or "" when it does not exist.
func (s *Store) HashOf(rel string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hashOf(rel)
}

func (s *Store) hashOf(rel string) string {
	if data := s.readBytes(rel); data != nil {
		return Hash(data)
	}
	return ""
}

// ReadBytes returns nil when the file does not exist.
func (s *Store) ReadBytes(rel string) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readBytes(rel)
}

func (s *Store) readBytes(rel string) []byte {
	full, err := s.FullPath(rel)
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return nil
	}
	if data == nil {
		data = []byte{}
	}
	return data
}

// LastWrite is the file's modification time (zero when missing).
func (s *Store) LastWrite(rel string) time.Time {
	full, err := s.FullPath(rel)
	if err != nil {
		return time.Time{}
	}
	info, err := os.Stat(full)
	if err != nil {
		return time.Time{}
	}
	return info.ModTime()
}

// WriteIfUnchanged writes only if the file still has expectedHash ("" = must not exist). Guards against overwriting
// edits made during a sync: the check and the write happen under the store lock, so no save can slip in between.
func (s *Store) WriteIfUnchanged(rel string, data []byte, expectedHash string, modified time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hashOf(rel) != expectedHash {
		return false, nil
	}
	if err := s.writeAtomic(rel, data); err != nil {
		return false, err
	}
	if !modified.IsZero() { // keep the server's edit time
		full, _ := s.FullPath(rel)
		if err := os.Chtimes(full, modified, modified); err != nil {
			return true, err
		}
	}
	return true, nil
}

func (s *Store) DeleteIfUnchanged(rel, expectedHash string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hashOf(rel) != expectedHash {
		return false, nil
	}
	full, _ := s.FullPath(rel)
	return true, os.Remove(full)
}

func (s *Store) writeAtomic(rel string, data []byte) error {
	full, err := s.FullPath(rel)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(full+tempSuffix, data, 0o644); err != nil {
		return err
	}
	return os.Rename(full+tempSuffix, full)
}

// ---- Metadata --------------------------------------------------------------------------------------------------

func (s *Store) byId(id string) *Meta {
	for _, m := range s.meta {
		if m.Id == id {
			return m
		}
	}
	return nil
}

func (s *Store) AllMeta() []Meta {
	s.mu.Lock()
	defer s.mu.Unlock()
	all := make([]Meta, len(s.meta))
	for i, m := range s.meta {
		all[i] = *m
	}
	return all
}

func (s *Store) MetaById(id string) (Meta, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if m := s.byId(id); m != nil {
		return *m, true
	}
	return Meta{}, false
}

// MetaFor returns the metadata for a note file, created on first use.
func (s *Store) MetaFor(rel string) Meta {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, m := range s.meta {
		if string(m.Path) == rel {
			return *m
		}
	}
	m := newMeta(rel)
	s.meta = append(s.meta, m)
	_ = s.saveMeta()
	return *m
}

// NewMeta adds an open, unsaved note. It is persisted once SaveNote gives it a path.
func (s *Store) NewMeta() Meta {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := newMeta("")
	m.IsOpen = true
	s.meta = append(s.meta, m)
	return *m
}

// UpdateMeta changes a note's metadata and saves it. Returns the updated copy and false if the note is gone.
func (s *Store) UpdateMeta(id string, change func(*Meta)) (Meta, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.byId(id)
	if m == nil {
		return Meta{}, false
	}
	change(m)
	_ = s.saveMeta()
	return *m, true
}

// Reconcile runs after a sync: follows renames done on Nextcloud via file id, records file ids, and drops metadata
// for notes that no longer exist. Unsaved new notes (no path) are kept.
func (s *Store) Reconcile(fileIds map[string]string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	pathById := map[string]string{}
	paths := make([]string, 0, len(fileIds))
	for p := range fileIds {
		paths = append(paths, p)
	}
	slices.Sort(paths) // deterministic pick when two paths share an id
	for _, p := range paths {
		if _, ok := pathById[fileIds[p]]; !ok {
			pathById[fileIds[p]] = p
		}
	}
	for _, m := range s.meta {
		if current, ok := pathById[string(m.FileId)]; m.FileId != "" && ok {
			m.Path = NullString(current)
		} else if id, ok := fileIds[string(m.Path)]; m.Path != "" && ok {
			m.FileId = NullString(id)
		}
	}
	s.meta = slices.DeleteFunc(s.meta, func(m *Meta) bool { return m.Path != "" && !s.Exists(string(m.Path)) })
	// A rename can leave a fresh entry for the new path next to the followed one; keep the open/older one.
	byPath := map[NullString][]*Meta{}
	for _, m := range s.meta {
		if m.Path != "" {
			byPath[m.Path] = append(byPath[m.Path], m)
		}
	}
	for _, group := range byPath {
		if len(group) < 2 {
			continue
		}
		keep := group[0]
		for _, m := range group {
			if m.IsOpen {
				keep = m
				break
			}
		}
		s.meta = slices.DeleteFunc(s.meta, func(m *Meta) bool { return slices.Contains(group, m) && m != keep })
	}
	return s.saveMeta()
}

func (s *Store) SaveMeta() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveMeta()
}

func (s *Store) saveMeta() error {
	saved := []*Meta{}
	for _, m := range s.meta {
		if m.Path != "" {
			saved = append(saved, m)
		}
	}
	data, err := json.MarshalIndent(saved, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.metaFile), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(s.metaFile+tempSuffix, data, 0o644); err != nil {
		return err
	}
	return os.Rename(s.metaFile+tempSuffix, s.metaFile)
}

func newMeta(rel string) *Meta {
	return &Meta{Id: uuid(), Path: NullString(rel), Color: DefaultColor, Width: 340, Height: 340}
}

func uuid() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
