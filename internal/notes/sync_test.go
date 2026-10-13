package notes

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type env struct {
	t      *testing.T
	dir    string
	server *fakeWebDav
	store  *Store
	engine *SyncEngine
}

func setup(t *testing.T) *env {
	t.Helper()
	e := &env{t: t, dir: t.TempDir(), server: newFakeWebDav()}
	t.Cleanup(e.server.srv.Close)
	e.server.dirs["Notes"] = true
	var err error
	if e.store, err = NewStore(filepath.Join(e.dir, "Notes"), filepath.Join(e.dir, "meta.json")); err != nil {
		t.Fatal(err)
	}
	e.newEngine()
	return e
}

func (e *env) newEngine() {
	dav := NewWebDavClient(e.server.srv.URL, "u", "pw", "Notes", e.server.srv.Client())
	var err error
	if e.engine, err = NewSyncEngine(e.store, dav, filepath.Join(e.dir, "state.json")); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) full(rel string) string {
	full, err := e.store.FullPath(rel)
	if err != nil {
		e.t.Fatal(err)
	}
	return full
}

func (e *env) local(rel string) string {
	data, err := os.ReadFile(e.full(rel))
	if err != nil {
		e.t.Fatal(err)
	}
	return string(data)
}

func (e *env) writeLocal(rel, text string) {
	os.MkdirAll(filepath.Dir(e.full(rel)), 0o755)
	if err := os.WriteFile(e.full(rel), []byte(text), 0o644); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) setLocalTime(rel string, t time.Time) { os.Chtimes(e.full(rel), t, t) }

func (e *env) sync() SyncResult {
	e.t.Helper()
	res, err := e.engine.Sync()
	if err != nil {
		e.t.Fatal(err)
	}
	return res
}

func minutesAgo(m int) time.Time { return time.Now().Add(-time.Duration(m) * time.Minute) }

func eq[T comparable](t *testing.T, got, want T) {
	t.Helper()
	if got != want {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestDownloadsNewRemoteNotesIncludingCategoriesAndUnicode(t *testing.T) {
	e := setup(t)
	e.server.with(func() { e.server.dirs["Notes/Работа"] = true })
	e.server.put("Notes/Основна цел.md", "## 🧭 Основна цел")
	e.server.put("Notes/Работа/todo.md", "- [ ] x")
	res := e.sync()
	eq(t, e.local("Основна цел.md"), "## 🧭 Основна цел")
	eq(t, e.local("Работа/todo.md"), "- [ ] x")
	eq(t, res.LocalChanges["Работа/todo.md"], true)
	f, _ := e.server.file("Notes/Работа/todo.md")
	eq(t, res.FileIds["Работа/todo.md"], f.fileId)
}

func TestUploadsNewAndEditedLocalNotes(t *testing.T) {
	e := setup(t)
	e.writeLocal("a.md", "one")
	e.sync()
	eq(t, e.server.text("Notes/a.md"), "one")
	e.writeLocal("a.md", "two")
	e.sync()
	eq(t, e.server.text("Notes/a.md"), "two")
}

func TestCreatesMissingRemoteRootAndSubfolders(t *testing.T) {
	e := setup(t)
	e.server.with(func() { delete(e.server.dirs, "Notes") })
	e.writeLocal("Cat/Sub/n.md", "x")
	e.sync() // first run creates the root
	e.sync()
	eq(t, e.server.text("Notes/Cat/Sub/n.md"), "x")
}

func TestAppliesRemoteEditAndDelete(t *testing.T) {
	e := setup(t)
	e.server.put("Notes/a.md", "v1")
	e.server.put("Notes/b.md", "keep?")
	e.sync()
	e.server.edit("Notes/a.md", "v2")
	e.server.with(func() { delete(e.server.files, "Notes/b.md") })
	e.sync()
	eq(t, e.local("a.md"), "v2")
	eq(t, e.store.Exists("b.md"), false)
}

func TestPropagatesLocalDelete(t *testing.T) {
	e := setup(t)
	e.server.put("Notes/a.md", "v1")
	e.sync()
	os.Remove(e.full("a.md"))
	e.sync()
	_, ok := e.server.file("Notes/a.md")
	eq(t, ok, false)
}

func TestBothEditedNewerLocalEditWins(t *testing.T) {
	e := setup(t)
	e.server.put("Notes/a.md", "base")
	e.sync()
	e.server.edit("Notes/a.md", "older web edit", minutesAgo(5))
	e.writeLocal("a.md", "newer app edit")
	e.sync()
	eq(t, e.server.text("Notes/a.md"), "newer app edit")
	eq(t, e.local("a.md"), "newer app edit")
	eq(t, len(e.store.ListFiles()), 1)
	eq(t, len(e.sync().LocalChanges), 0) // settled
}

func TestBothEditedNewerRemoteEditWins(t *testing.T) {
	e := setup(t)
	e.server.put("Notes/a.md", "base")
	e.sync()
	e.writeLocal("a.md", "older app edit")
	e.setLocalTime("a.md", minutesAgo(5))
	e.server.edit("Notes/a.md", "newer edit from other PC")
	e.sync()
	eq(t, e.local("a.md"), "newer edit from other PC")
	eq(t, e.server.text("Notes/a.md"), "newer edit from other PC")
	eq(t, len(e.store.ListFiles()), 1)
}

func TestUploadCarriesLocalEditTime(t *testing.T) {
	e := setup(t)
	e.writeLocal("a.md", "x")
	edited := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	e.setLocalTime("a.md", edited)
	e.sync()
	f, _ := e.server.file("Notes/a.md")
	eq(t, f.modified.Equal(edited), true)
}

func TestEditBeatsDeleteOnEitherSide(t *testing.T) {
	e := setup(t)
	e.server.put("Notes/a.md", "base")
	e.server.put("Notes/b.md", "base")
	e.sync()
	e.server.with(func() { delete(e.server.files, "Notes/a.md") })
	e.writeLocal("a.md", "edited here")
	os.Remove(e.full("b.md"))
	e.server.edit("Notes/b.md", "edited there")
	e.sync()
	eq(t, e.server.text("Notes/a.md"), "edited here")
	eq(t, e.local("b.md"), "edited there")
}

func TestRemovesTextEditorLockAndUploadsTheEdit(t *testing.T) {
	e := setup(t)
	e.server.put("Notes/a.md", "base")
	e.sync()
	e.server.with(func() { e.server.locked["Notes/a.md"] = true })
	e.writeLocal("a.md", "edited")
	res := e.sync()
	eq(t, len(res.Locked), 0)
	e.server.with(func() { eq(t, len(e.server.locked), 0) })
	eq(t, e.server.text("Notes/a.md"), "edited")
}

func TestSkipsUnremovableLockAndRetriesLaterWithoutBlockingOthers(t *testing.T) {
	e := setup(t)
	e.server.put("Notes/a.md", "base")
	e.sync()
	e.server.with(func() {
		e.server.locked["Notes/a.md"] = true
		e.server.unremovable["Notes/a.md"] = true
	})
	e.writeLocal("a.md", "edited")
	e.writeLocal("b.md", "new")
	res := e.sync()
	eq(t, strings.Join(res.Locked, ","), "a.md")
	eq(t, e.server.text("Notes/a.md"), "base")
	eq(t, e.server.text("Notes/b.md"), "new")
	e.server.with(func() { clear(e.server.unremovable) })
	res = e.sync()
	eq(t, len(res.Locked), 0)
	eq(t, e.server.text("Notes/a.md"), "edited")
}

func TestIdenticalFilesWithoutStateAreNotReuploaded(t *testing.T) {
	e := setup(t)
	e.server.put("Notes/a.md", "same")
	f, _ := e.server.file("Notes/a.md")
	e.writeLocal("a.md", "same")
	e.sync()
	eq(t, len(e.store.ListFiles()), 1)
	f2, _ := e.server.file("Notes/a.md")
	eq(t, f2.etag, f.etag)
}

func TestStateSurvivesRestart(t *testing.T) {
	e := setup(t)
	e.server.put("Notes/a.md", "v1")
	e.sync()
	e.newEngine()
	e.writeLocal("a.md", "v2")
	e.sync()
	eq(t, e.server.text("Notes/a.md"), "v2")
}

func TestSyncsAttachmentsAndExposesFileIdForNewNote(t *testing.T) {
	e := setup(t)
	meta := e.store.NewMeta()
	notePath, err := e.store.SaveNote(meta.Id, "Shopping list\n- milk")
	if err != nil {
		t.Fatal(err)
	}
	e.sync()
	fileId := e.engine.FileIdOf(notePath)
	if fileId == "" {
		t.Fatal("no file id")
	}
	src, err := e.store.SaveAttachment(notePath, fileId, "Screen shot.PNG", []byte{1, 2, 3})
	if err != nil {
		t.Fatal(err)
	}
	e.sync()
	eq(t, src, fmt.Sprintf(".attachments.%s/Screen%%20shot.png", fileId))
	f, _ := e.server.file(fmt.Sprintf("Notes/.attachments.%s/Screen shot.png", fileId))
	eq(t, string(f.data), "\x01\x02\x03")
	eq(t, notePath, "Shopping list.md")
	eq(t, len(e.store.ListNotes()), 1) // attachments are not listed as notes
}

func TestMetadataFollowsRenameDoneInNextcloud(t *testing.T) {
	e := setup(t)
	e.server.put("Notes/old.md", "x")
	e.sync()
	id := e.store.MetaFor("old.md").Id
	e.store.UpdateMeta(id, func(m *Meta) { m.Color = "#5ac0e7" })
	e.store.Reconcile(e.sync().FileIds)
	e.server.rename("Notes/old.md", "Notes/new.md")
	e.store.Reconcile(e.sync().FileIds)
	meta, _ := e.store.MetaById(id)
	eq(t, string(meta.Path), "new.md")
	eq(t, meta.Color, "#5ac0e7")
	eq(t, e.store.MetaFor("new.md").Id, id)
}

func TestReadsStateWrittenByEarlierAppsWithoutRetransferring(t *testing.T) {
	e := setup(t)
	e.server.put("Notes/a.md", "hello")
	e.writeLocal("a.md", "hello")
	f, _ := e.server.file("Notes/a.md")
	sum := sha256.Sum256([]byte("hello"))
	state := fmt.Sprintf(`{"a.md":{"ETag":%q,"Hash":%q,"FileId":%q}}`, f.etag, strings.ToUpper(hex.EncodeToString(sum[:])), f.fileId)
	os.WriteFile(filepath.Join(e.dir, "state.json"), []byte(state), 0o644)
	e.newEngine()
	res := e.sync()
	eq(t, len(res.LocalChanges), 0)
	f2, _ := e.server.file("Notes/a.md")
	eq(t, f2.etag, f.etag)
}

func TestFileNameFromFirstLine(t *testing.T) {
	for md, want := range map[string]string{
		"## 🧭 Основна цел\nbody": "🧭 Основна цел",
		"- [ ] **buy** milk":     "buy milk",
		"  \n\n":                 "New note",
		"a/b:c*?":                "abc",
	} {
		eq(t, FileNameFromContent(md), want)
	}
}

func TestGivesNewNotesUniqueNames(t *testing.T) {
	e := setup(t)
	a, _ := e.store.SaveNote(e.store.NewMeta().Id, "Same")
	b, _ := e.store.SaveNote(e.store.NewMeta().Id, "Same")
	eq(t, a, "Same.md")
	eq(t, b, "Same (2).md")
}

func TestRejectsPathsOutsideNotesFolder(t *testing.T) {
	e := setup(t)
	if _, err := e.store.FullPath("../evil.md"); err == nil {
		t.Fatal("expected error")
	}
}

func TestMetadataJsonMatchesEarlierApps(t *testing.T) {
	e := setup(t)
	id := e.store.MetaFor("a.md").Id
	data, _ := os.ReadFile(filepath.Join(e.dir, "meta.json"))
	want := fmt.Sprintf(`"Id": %q,
    "Path": "a.md",
    "FileId": null,
    "Color": "#e6b905",
    "Left": null,
    "Top": null,
    "Width": 340,
    "Height": 340,
    "IsOpen": false`, id)
	if !strings.Contains(string(data), want) {
		t.Fatalf("metadata.json:\n%s", data)
	}
}
