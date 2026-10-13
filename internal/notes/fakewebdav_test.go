package notes

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	davPrefix = "/remote.php/dav/files/u/"
	ocsUnlock = "/ocs/v2.php/apps/files_lock/lock/"
)

type fakeFile struct {
	data     []byte
	etag     string
	fileId   string
	modified time.Time
}

// fakeWebDav is an in-memory Nextcloud-like WebDAV server for one user root (/remote.php/dav/files/u/).
type fakeWebDav struct {
	mu     sync.Mutex
	files  map[string]fakeFile
	dirs   map[string]bool
	locked map[string]bool
	// Locks the OCS unlock endpoint refuses to remove (e.g. owned by another user).
	unremovable map[string]bool
	next        int
	srv         *httptest.Server
}

func newFakeWebDav() *fakeWebDav {
	f := &fakeWebDav{files: map[string]fakeFile{}, dirs: map[string]bool{}, locked: map[string]bool{}, unremovable: map[string]bool{}, next: 100}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	return f
}

func (f *fakeWebDav) newETag() string {
	f.next++
	return fmt.Sprintf(`"e%d"`, f.next)
}

// with runs test-side changes and checks under the server lock.
func (f *fakeWebDav) with(fn func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn()
}

func (f *fakeWebDav) put(p, text string, at ...time.Time) {
	f.with(func() {
		etag := f.newETag()
		f.next++
		f.files[p] = fakeFile{data: []byte(text), etag: etag, fileId: strconv.Itoa(f.next), modified: when(at)}
	})
}

func (f *fakeWebDav) edit(p, text string, at ...time.Time) {
	f.with(func() {
		file := f.files[p]
		file.data, file.etag, file.modified = []byte(text), f.newETag(), when(at)
		f.files[p] = file
	})
}

func (f *fakeWebDav) file(p string) (file fakeFile, ok bool) {
	f.with(func() { file, ok = f.files[p] })
	return
}

func (f *fakeWebDav) text(p string) string {
	file, _ := f.file(p)
	return string(file.data)
}

func (f *fakeWebDav) rename(from, to string) {
	f.with(func() {
		f.files[to] = f.files[from]
		delete(f.files, from)
	})
}

func when(at []time.Time) time.Time {
	if len(at) > 0 {
		return at[0]
	}
	return time.Now()
}

func fakeParent(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[:i]
	}
	if p == "" {
		return "\x00"
	}
	return ""
}

func (f *fakeWebDav) serve(w http.ResponseWriter, req *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if strings.HasPrefix(req.URL.Path, ocsUnlock) && req.Method == "DELETE" {
		id := strings.TrimPrefix(req.URL.Path, ocsUnlock)
		for p, file := range f.files {
			if file.fileId == id && f.locked[p] {
				if f.unremovable[p] {
					w.WriteHeader(423)
					return
				}
				delete(f.locked, p)
				w.WriteHeader(200)
				return
			}
		}
		w.WriteHeader(412)
		return
	}
	p := strings.Trim(strings.TrimPrefix(req.URL.Path, davPrefix), "/")
	ifMatch := req.Header.Get("If-Match")
	_, ifNone := req.Header["If-None-Match"]
	file, exists := f.files[p]

	switch req.Method {
	case "PROPFIND":
		if !exists && !f.dirs[p] {
			w.WriteHeader(404)
			return
		}
		entries := []string{f.entry(p)}
		if req.Header.Get("Depth") == "1" && !exists {
			for k := range f.files {
				if fakeParent(k) == p {
					entries = append(entries, f.entry(k))
				}
			}
			for k := range f.dirs {
				if k != p && fakeParent(k) == p {
					entries = append(entries, f.entry(k))
				}
			}
		}
		w.WriteHeader(207)
		fmt.Fprintf(w, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">%s</d:multistatus>`, strings.Join(entries, ""))
	case "GET":
		if !exists {
			w.WriteHeader(404)
			return
		}
		w.Write(file.data)
	case "PUT":
		switch {
		case f.locked[p]:
			w.WriteHeader(423)
		case ifNone && exists || ifMatch != "" && (!exists || file.etag != ifMatch):
			w.WriteHeader(412)
		case !f.dirs[fakeParent(p)]:
			w.WriteHeader(409)
		default:
			data, _ := io.ReadAll(req.Body)
			fileId := file.fileId
			if !exists {
				f.next++
				fileId = strconv.Itoa(f.next)
			}
			modified := time.Now()
			if mtime := req.Header.Get("X-OC-Mtime"); mtime != "" {
				secs, _ := strconv.ParseInt(mtime, 10, 64)
				modified = time.Unix(secs, 0)
			}
			f.files[p] = fakeFile{data: data, etag: f.newETag(), fileId: fileId, modified: modified}
			if exists {
				w.WriteHeader(204)
			} else {
				w.WriteHeader(201)
			}
		}
	case "DELETE":
		switch {
		case f.locked[p]:
			w.WriteHeader(423)
		case !exists:
			w.WriteHeader(404)
		case ifMatch != "" && file.etag != ifMatch:
			w.WriteHeader(412)
		default:
			delete(f.files, p)
			w.WriteHeader(204)
		}
	case "MKCOL":
		if f.dirs[p] {
			w.WriteHeader(405)
			return
		}
		f.dirs[p] = true
		w.WriteHeader(201)
	default:
		w.WriteHeader(405)
	}
}

func (f *fakeWebDav) entry(p string) string {
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	href := davPrefix + strings.Join(segs, "/")
	if f.dirs[p] {
		return `<d:response><d:href>` + href + `/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><oc:fileid>1</oc:fileid></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
	}
	file := f.files[p]
	return fmt.Sprintf(`<d:response><d:href>%s</d:href><d:propstat><d:prop><d:getetag>%s</d:getetag><d:getlastmodified>%s</d:getlastmodified><d:resourcetype/><oc:fileid>%s</oc:fileid></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
		href, strings.ReplaceAll(file.etag, `"`, "&quot;"), file.modified.UTC().Format(http.TimeFormat), file.fileId)
}
