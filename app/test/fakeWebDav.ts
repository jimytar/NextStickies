import type { Fetch } from '../src/main/webdav'

const PREFIX = '/remote.php/dav/files/u/'
const OCS_UNLOCK = '/ocs/v2.php/apps/files_lock/lock/'
interface File { data: Uint8Array; etag: string; fileId: string; modified: Date }

/** In-memory Nextcloud-like WebDAV server for one user root (/remote.php/dav/files/u/). */
export class FakeWebDav {
  readonly files = new Map<string, File>()
  readonly dirs = new Set<string>()
  readonly locked = new Set<string>()
  /** Locks the OCS unlock endpoint refuses to remove (e.g. owned by another user). */
  readonly unremovable = new Set<string>()
  private next = 100

  put(p: string, text: string, at = new Date()) {
    this.files.set(p, { data: new TextEncoder().encode(text), etag: this.newETag(), fileId: String(++this.next), modified: at })
  }
  edit(p: string, text: string, at = new Date()) {
    const f = this.files.get(p)!
    this.files.set(p, { ...f, data: new TextEncoder().encode(text), etag: this.newETag(), modified: at })
  }
  text(p: string) {
    return new TextDecoder().decode(this.files.get(p)!.data)
  }
  rename(from: string, to: string) {
    this.files.set(to, this.files.get(from)!)
    this.files.delete(from)
  }
  private newETag() {
    return `"e${++this.next}"`
  }

  fetch: Fetch = async (url, init) => {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    const headers = new Headers(init.headers)
    if (u.pathname.startsWith(OCS_UNLOCK) && method === 'DELETE') {
      const id = u.pathname.slice(OCS_UNLOCK.length)
      const p = [...this.files].find(([k, f]) => f.fileId === id && this.locked.has(k))?.[0]
      if (!p) return new Response(null, { status: 412 })
      if (this.unremovable.has(p)) return new Response(null, { status: 423 })
      this.locked.delete(p)
      return new Response(null, { status: 200 })
    }
    const p = decodeURIComponent(u.pathname).slice(PREFIX.length).replace(/^\/+|\/+$/g, '')
    const ifMatch = headers.get('If-Match')
    const ifNone = headers.has('If-None-Match')
    const file = this.files.get(p)

    switch (method) {
      case 'PROPFIND': {
        if (!file && !this.dirs.has(p)) return new Response(null, { status: 404 })
        const entries = [this.entry(p)]
        if (headers.get('Depth') === '1' && !file)
          for (const k of [...this.files.keys(), ...this.dirs]) if (k !== p && parent(k) === p) entries.push(this.entry(k))
        const body = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${entries.join('')}</d:multistatus>`
        return new Response(body, { status: 207 })
      }
      case 'GET':
        return file ? new Response(file.data as BodyInit, { status: 200 }) : new Response(null, { status: 404 })
      case 'PUT': {
        if (this.locked.has(p)) return new Response(null, { status: 423 })
        if ((ifNone && file) || (ifMatch !== null && (!file || file.etag !== ifMatch))) return new Response(null, { status: 412 })
        if (!this.dirs.has(parent(p))) return new Response(null, { status: 409 })
        const data = new Uint8Array(await new Response(init.body).arrayBuffer())
        const mtime = headers.get('X-OC-Mtime')
        this.files.set(p, {
          data, etag: this.newETag(), fileId: file ? file.fileId : String(++this.next),
          modified: mtime ? new Date(Number(mtime) * 1000) : new Date(),
        })
        return new Response(null, { status: file ? 204 : 201 })
      }
      case 'DELETE':
        if (this.locked.has(p)) return new Response(null, { status: 423 })
        if (!file) return new Response(null, { status: 404 })
        if (ifMatch !== null && file.etag !== ifMatch) return new Response(null, { status: 412 })
        this.files.delete(p)
        return new Response(null, { status: 204 })
      case 'MKCOL':
        if (this.dirs.has(p)) return new Response(null, { status: 405 })
        this.dirs.add(p)
        return new Response(null, { status: 201 })
    }
    return new Response(null, { status: 405 })
  }

  private entry(p: string) {
    const href = PREFIX + p.split('/').map(encodeURIComponent).join('/')
    if (this.dirs.has(p))
      return `<d:response><d:href>${href}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><oc:fileid>1</oc:fileid></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
    const f = this.files.get(p)!
    return `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>${f.etag.replaceAll('"', '&quot;')}</d:getetag><d:getlastmodified>${f.modified.toUTCString()}</d:getlastmodified><d:resourcetype/><oc:fileid>${f.fileId}</oc:fileid></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
  }
}

const parent = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : p === '' ? '\0' : '')
