package notes

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"
)

type SyncResult struct {
	LocalChanges map[string]bool
	FileIds      map[string]string
	Locked       []string
}

// fileState is the per-path state of the last successful sync. Field names match the 1.x sync-state.json.
type fileState struct {
	ETag   string
	Hash   string
	FileId NullString
}

// SyncEngine is a two-way sync between a Store and a WebDAV folder. Three-way compare of local hash and remote etag
// against what was last synced. When both sides changed, the most recent edit wins (local mtime vs server mtime, which
// uploads set via X-OC-Mtime); an edit always beats a delete. Locks left by the Nextcloud Text editor are removed so
// edits made in this app go through.
type SyncEngine struct {
	store     *Store
	dav       *WebDavClient
	stateFile string
	run       sync.Mutex // one sync at a time; concurrent calls queue behind the running one
	mu        sync.Mutex // guards state
	state     map[string]fileState
}

func NewSyncEngine(store *Store, dav *WebDavClient, stateFile string) (*SyncEngine, error) {
	e := &SyncEngine{store: store, dav: dav, stateFile: stateFile, state: map[string]fileState{}}
	if data, err := os.ReadFile(stateFile); err == nil {
		if err := json.Unmarshal(data, &e.state); err != nil {
			return nil, fmt.Errorf("%s: %w", stateFile, err)
		}
	}
	return e, nil
}

// FileIdOf returns the note's Nextcloud file id, or "" if it has not been synced yet.
func (e *SyncEngine) FileIdOf(rel string) string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return string(e.state[rel].FileId)
}

// Sync runs one sync.
func (e *SyncEngine) Sync() (SyncResult, error) {
	e.run.Lock()
	defer e.run.Unlock()
	r := &run{engine: e, localChanges: map[string]bool{}, remoteDirs: map[string]bool{"": true}}
	if err := r.execute(); err != nil {
		return SyncResult{}, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.saveState(); err != nil {
		return SyncResult{}, err
	}
	fileIds := map[string]string{}
	for p, s := range e.state {
		if s.FileId != "" {
			fileIds[p] = string(s.FileId)
		}
	}
	return SyncResult{LocalChanges: r.localChanges, FileIds: fileIds, Locked: r.locked}, nil
}

func (e *SyncEngine) saveState() error {
	data, err := json.Marshal(e.state)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(e.stateFile), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(e.stateFile+".tmp", data, 0o644); err != nil {
		return err
	}
	return os.Rename(e.stateFile+".tmp", e.stateFile)
}

type run struct {
	engine       *SyncEngine
	localChanges map[string]bool
	locked       []string
	remoteDirs   map[string]bool
}

func (r *run) store() *Store      { return r.engine.store }
func (r *run) dav() *WebDavClient { return r.engine.dav }

func (r *run) stateOf(p string) *fileState {
	r.engine.mu.Lock()
	defer r.engine.mu.Unlock()
	if s, ok := r.engine.state[p]; ok {
		return &s
	}
	return nil
}

func (r *run) record(p, etag, hash, fileId string) {
	r.engine.mu.Lock()
	defer r.engine.mu.Unlock()
	r.engine.state[p] = fileState{ETag: etag, Hash: hash, FileId: NullString(fileId)}
}

func (r *run) forget(p string) {
	r.engine.mu.Lock()
	defer r.engine.mu.Unlock()
	delete(r.engine.state, p)
}

func (r *run) execute() error {
	items, err := r.dav().List()
	if err != nil {
		return err
	}
	remote := map[string]*RemoteItem{}
	for i := range items {
		if items[i].IsDirectory {
			r.remoteDirs[items[i].Path] = true
		} else {
			remote[items[i].Path] = &items[i]
		}
	}
	paths := map[string]bool{}
	for _, p := range r.store().ListFiles() {
		paths[p] = true
	}
	for p := range remote {
		paths[p] = true
	}
	r.engine.mu.Lock()
	for p := range r.engine.state {
		paths[p] = true
	}
	r.engine.mu.Unlock()
	sorted := make([]string, 0, len(paths))
	for p := range paths {
		sorted = append(sorted, p)
	}
	slices.Sort(sorted)
	for _, p := range sorted {
		err := r.syncFile(p, r.store().HashOf(p), remote[p], r.stateOf(p))
		if errors.Is(err, ErrLocked) {
			r.locked = append(r.locked, p) // could not unlock; state untouched, so the next run retries
		} else if err != nil {
			return err
		}
	}
	return nil
}

// syncFile compares local hash l ("" = no local file) and remote item rem (nil = none) with the last synced state s.
func (r *run) syncFile(p, l string, rem *RemoteItem, s *fileState) error {
	var localChanged, remoteChanged bool
	if s == nil {
		localChanged, remoteChanged = l != "", rem != nil
	} else {
		localChanged, remoteChanged = l != s.Hash, rem == nil || rem.ETag != s.ETag
	}

	switch {
	case !localChanged && !remoteChanged:
		if l == "" && rem == nil {
			r.forget(p)
		} else if s != nil && s.FileId == "" && rem != nil && rem.FileId != "" {
			r.record(p, s.ETag, s.Hash, rem.FileId)
		}
		return nil

	case !localChanged: // remote changed
		if rem != nil {
			return r.download(p, rem, l)
		}
		deleted := l == ""
		if !deleted {
			var err error
			if deleted, err = r.store().DeleteIfUnchanged(p, l); err != nil {
				return err
			}
		}
		if deleted {
			r.localChanges[p] = true
			r.forget(p)
		}
		return nil

	case !remoteChanged: // local changed
		if l == "" {
			return r.deleteRemote(p, s)
		}
		etag, fileId := "", ""
		if rem != nil {
			etag, fileId = rem.ETag, rem.FileId
		}
		if fileId == "" && s != nil {
			fileId = string(s.FileId)
		}
		return r.upload(p, l, etag, fileId)
	}

	// Both changed.
	switch {
	case l == "" && rem == nil:
		r.forget(p)
		return nil
	case l == "":
		return r.download(p, rem, "") // deleted here, edited there → keep the edit
	case rem == nil:
		return r.upload(p, l, "", "") // edited here, deleted there → keep the edit
	default:
		return r.resolveBothChanged(p, l, rem)
	}
}

// resolveBothChanged handles edits on both sides: the later edit wins, the other is overwritten.
func (r *run) resolveBothChanged(p, localHash string, rem *RemoteItem) error {
	data, err := r.dav().Get(p)
	if err != nil {
		return err
	}
	switch {
	case Hash(data) == localHash: // same content on both sides
		r.record(p, rem.ETag, localHash, rem.FileId)
		return nil
	case !rem.LastModified.IsZero() && rem.LastModified.After(r.store().LastWrite(p)):
		return r.write(p, rem, data, localHash)
	default:
		return r.upload(p, localHash, rem.ETag, rem.FileId)
	}
}

func (r *run) download(p string, rem *RemoteItem, expectedLocal string) error {
	data, err := r.dav().Get(p)
	if err != nil {
		return err
	}
	return r.write(p, rem, data, expectedLocal)
}

func (r *run) write(p string, rem *RemoteItem, data []byte, expectedLocal string) error {
	written, err := r.store().WriteIfUnchanged(p, data, expectedLocal, rem.LastModified)
	if written {
		r.localChanges[p] = true
		r.record(p, rem.ETag, Hash(data), rem.FileId)
	}
	// not written: edited locally meanwhile; next run sees both sides changed and resolves.
	return err
}

func (r *run) upload(p, localHash, ifMatch, fileId string) error {
	data := r.store().ReadBytes(p)
	if data == nil || Hash(data) != localHash {
		return nil // changed meanwhile; next run
	}
	if err := r.ensureRemoteDir(ParentOf(p)); err != nil {
		return err
	}
	err := r.unlocking(fileId, func() error { return r.dav().Put(p, data, ifMatch, r.store().LastWrite(p)) })
	if errors.Is(err, ErrPreconditionFailed) {
		// Changed on the server since we listed it: decide again with its current state.
		current, err := r.dav().Stat(p)
		if err != nil {
			return err
		}
		if current != nil {
			return r.resolveBothChanged(p, localHash, current)
		}
		return r.upload(p, localHash, "", "")
	}
	if err != nil {
		return err
	}
	stat, err := r.dav().Stat(p)
	if err != nil {
		return err
	}
	if stat == nil {
		return fmt.Errorf("upload of %s not found on server", p)
	}
	r.record(p, stat.ETag, localHash, stat.FileId)
	return nil
}

func (r *run) deleteRemote(p string, s *fileState) error {
	err := r.unlocking(string(s.FileId), func() error { return r.dav().Delete(p, s.ETag) })
	if errors.Is(err, ErrPreconditionFailed) {
		// Edited on the server after we deleted it here: keep the edit.
		rem, err := r.dav().Stat(p)
		if err != nil {
			return err
		}
		if rem == nil {
			r.forget(p)
			return nil
		}
		return r.download(p, rem, "")
	}
	if err != nil {
		return err
	}
	r.forget(p)
	return nil
}

// unlocking runs a write; if Nextcloud reports the file locked (Text editor), removes the lock and retries once.
func (r *run) unlocking(fileId string, write func() error) error {
	err := write()
	if !errors.Is(err, ErrLocked) || fileId == "" {
		return err
	}
	unlocked, uerr := r.dav().Unlock(fileId)
	if uerr != nil {
		return uerr
	}
	if !unlocked {
		return err
	}
	return write()
}

func (r *run) ensureRemoteDir(dir string) error {
	if r.remoteDirs[dir] {
		return nil
	}
	if err := r.ensureRemoteDir(ParentOf(dir)); err != nil {
		return err
	}
	if err := r.dav().Mkcol(dir); err != nil {
		return err
	}
	r.remoteDirs[dir] = true
	return nil
}
