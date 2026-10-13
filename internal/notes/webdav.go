package notes

import (
	"bytes"
	"encoding/base64"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type RemoteItem struct {
	Path         string
	IsDirectory  bool
	ETag         string
	FileId       string
	LastModified time.Time // zero when unknown
}

var (
	ErrPreconditionFailed = errors.New("changed on server")
	// ErrLocked is HTTP 423: Nextcloud holds a lock on the file, e.g. while it is open in the Notes/Text web editor.
	ErrLocked   = errors.New("locked on server")
	ErrNotFound = errors.New("not found")
	errLogin    = errors.New("Nextcloud rejected the login (check user / app password).")
)

const propfindBody = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop>` +
	`<d:getetag/><d:getlastmodified/><d:resourcetype/><oc:fileid/></d:prop></d:propfind>`

func escapePath(rel string) string {
	segs := strings.Split(rel, "/")
	for i, s := range segs {
		segs[i] = EncodeURIComponent(s)
	}
	return strings.Join(segs, "/")
}

// WebDavClient is a minimal Nextcloud WebDAV client rooted at one folder (e.g. /remote.php/dav/files/<user>/Notes/).
type WebDavClient struct {
	server string
	root   string
	auth   string
	http   *http.Client
}

func NewWebDavClient(serverUrl, user, appPassword, folder string, client *http.Client) *WebDavClient {
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Minute}
	}
	server := strings.TrimRight(serverUrl, "/")
	return &WebDavClient{
		server: server,
		root:   fmt.Sprintf("%s/remote.php/dav/files/%s/%s/", server, EncodeURIComponent(user), escapePath(strings.Trim(folder, "/"))),
		auth:   "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+appPassword)),
		http:   client,
	}
}

func (c *WebDavClient) urlOf(rel string) string { return c.root + escapePath(rel) }

func (c *WebDavClient) do(method, u string, headers map[string]string, body []byte) (*http.Response, error) {
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, u, r)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", c.auth)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return c.http.Do(req)
}

// send performs a request and maps error statuses; the caller closes the body.
func (c *WebDavClient) send(method, u, rel string, headers map[string]string, body []byte) (*http.Response, error) {
	res, err := c.do(method, u, headers, body)
	if err != nil {
		return nil, err
	}
	switch res.StatusCode {
	case 404:
		err = fmt.Errorf("%w: %s", ErrNotFound, rel)
	case 412:
		err = fmt.Errorf("%w: %s", ErrPreconditionFailed, rel)
	case 423:
		err = fmt.Errorf("%w: %s", ErrLocked, rel)
	case 401:
		err = errLogin
	default:
		if res.StatusCode < 200 || res.StatusCode > 299 {
			err = fmt.Errorf("%s %s: HTTP %d %s", method, rel, res.StatusCode, http.StatusText(res.StatusCode))
		}
	}
	if err != nil {
		res.Body.Close()
		return nil, err
	}
	return res, nil
}

// List returns all files and folders below the root, recursively. Creates the root folder if missing.
func (c *WebDavClient) List() ([]RemoteItem, error) {
	var result []RemoteItem
	pending := []string{""}
	for len(pending) > 0 {
		dir := pending[0]
		pending = pending[1:]
		items, err := c.propfind(dir, "1")
		if errors.Is(err, ErrNotFound) && dir == "" {
			if err := c.Mkcol(""); err != nil {
				return nil, err
			}
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			if item.Path == dir {
				continue
			}
			result = append(result, item)
			if item.IsDirectory {
				pending = append(pending, item.Path)
			}
		}
	}
	return result, nil
}

// Stat returns nil when the path does not exist.
func (c *WebDavClient) Stat(rel string) (*RemoteItem, error) {
	items, err := c.propfind(rel, "0")
	if errors.Is(err, ErrNotFound) || err == nil && len(items) == 0 {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &items[0], nil
}

type multistatus struct {
	Responses []struct {
		Href     string `xml:"href"`
		Propstat []struct {
			Status string `xml:"status"`
			Prop   struct {
				ETag         string `xml:"getetag"`
				LastModified string `xml:"getlastmodified"`
				ResourceType struct {
					Collection *struct{} `xml:"collection"`
				} `xml:"resourcetype"`
				FileId string `xml:"fileid"`
			} `xml:"prop"`
		} `xml:"propstat"`
	} `xml:"response"`
}

var absoluteUrl = regexp.MustCompile(`^https?://`)

func (c *WebDavClient) propfind(rel, depth string) ([]RemoteItem, error) {
	res, err := c.send("PROPFIND", c.urlOf(rel), rel, map[string]string{"Depth": depth, "Content-Type": "application/xml"}, []byte(propfindBody))
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var doc multistatus
	if err := xml.NewDecoder(res.Body).Decode(&doc); err != nil {
		return nil, fmt.Errorf("PROPFIND %s: %w", rel, err)
	}
	rootUrl, _ := url.Parse(c.root)
	rootPath := rootUrl.Path
	var items []RemoteItem
	for _, r := range doc.Responses {
		if len(r.Propstat) == 0 {
			continue
		}
		href, err := url.PathUnescape(r.Href)
		if err != nil {
			href = r.Href
		}
		if absoluteUrl.MatchString(r.Href) {
			if u, err := url.Parse(r.Href); err == nil {
				href = u.Path
			}
		}
		p := strings.Trim(strings.TrimPrefix(href, rootPath), "/")
		prop := r.Propstat[0].Prop
		for _, ps := range r.Propstat {
			if strings.Contains(ps.Status, " 200") {
				prop = ps.Prop
				break
			}
		}
		modified, _ := http.ParseTime(prop.LastModified)
		items = append(items, RemoteItem{
			Path:         p,
			IsDirectory:  prop.ResourceType.Collection != nil,
			ETag:         prop.ETag,
			FileId:       prop.FileId,
			LastModified: modified,
		})
	}
	return items, nil
}

func (c *WebDavClient) Get(rel string) ([]byte, error) {
	res, err := c.send("GET", c.urlOf(rel), rel, nil, nil)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	return io.ReadAll(res.Body)
}

// Put uploads with optimistic concurrency: ifMatch = expected etag, "" = must not exist. modified becomes the
// server-side mtime (X-OC-Mtime), so edit times compare across machines.
func (c *WebDavClient) Put(rel string, data []byte, ifMatch string, modified time.Time) error {
	headers := map[string]string{"X-OC-Mtime": strconv.FormatInt(modified.Unix(), 10)}
	if ifMatch != "" {
		headers["If-Match"] = ifMatch
	} else {
		headers["If-None-Match"] = "*"
	}
	res, err := c.send("PUT", c.urlOf(rel), rel, headers, data)
	if err != nil {
		return err
	}
	return res.Body.Close()
}

func (c *WebDavClient) Delete(rel, ifMatch string) error {
	headers := map[string]string{}
	if ifMatch != "" {
		headers["If-Match"] = ifMatch
	}
	res, err := c.send("DELETE", c.urlOf(rel), rel, headers, nil)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	return res.Body.Close()
}

// Unlock removes a files_lock lock (e.g. the one the Text web editor leaves behind). Nextcloud allows this for the
// file owner. Returns false when the server refused.
func (c *WebDavClient) Unlock(fileId string) (bool, error) {
	res, err := c.do("DELETE", c.server+"/ocs/v2.php/apps/files_lock/lock/"+EncodeURIComponent(fileId), map[string]string{"OCS-APIRequest": "true"}, nil)
	if err != nil {
		return false, err
	}
	res.Body.Close()
	return res.StatusCode >= 200 && res.StatusCode <= 299 || res.StatusCode == 412, nil // 412 = was not locked
}

func (c *WebDavClient) Mkcol(rel string) error {
	u := strings.TrimSuffix(c.urlOf(rel), "/") + "/"
	res, err := c.do("MKCOL", u, nil, nil)
	if err != nil {
		return err
	}
	res.Body.Close()
	switch {
	case res.StatusCode == 405: // already exists
		return nil
	case res.StatusCode == 401:
		return errLogin
	case res.StatusCode < 200 || res.StatusCode > 299:
		return fmt.Errorf("MKCOL %s: HTTP %d %s", rel, res.StatusCode, http.StatusText(res.StatusCode))
	}
	return nil
}
