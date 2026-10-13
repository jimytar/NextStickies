import { XMLParser } from 'fast-xml-parser'

export interface RemoteItem {
  path: string
  isDirectory: boolean
  etag: string | null
  fileId: string | null
  lastModified: Date | null
}

export class PreconditionFailedError extends Error {}
/** HTTP 423: Nextcloud holds a lock on the file, e.g. while it is open in the Notes/Text web editor. */
export class FileLockedError extends Error {}
export class NotFoundError extends Error {}
export class WebDavError extends Error {}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

const PROPFIND_BODY =
  '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop>' +
  '<d:getetag/><d:getlastmodified/><d:resourcetype/><oc:fileid/></d:prop></d:propfind>'

const xml = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false, isArray: n => n === 'response' || n === 'propstat' })
const escapePath = (rel: string) => rel.split('/').map(encodeURIComponent).join('/')

/** Minimal Nextcloud WebDAV client rooted at one folder (e.g. /remote.php/dav/files/<user>/Notes/). */
export class WebDavClient {
  private readonly server: string
  private readonly root: string
  private readonly auth: string

  constructor(serverUrl: string, user: string, appPassword: string, folder = 'Notes', private readonly fetchFn: Fetch = fetch) {
    this.server = serverUrl.replace(/\/+$/, '')
    this.root = `${this.server}/remote.php/dav/files/${encodeURIComponent(user)}/${escapePath(folder.replace(/^\/+|\/+$/g, ''))}/`
    this.auth = 'Basic ' + Buffer.from(`${user}:${appPassword}`, 'utf8').toString('base64')
  }

  private urlOf(rel: string) {
    return this.root + escapePath(rel)
  }

  private async send(method: string, url: string, rel: string, headers: Record<string, string> = {}, body?: BodyInit) {
    const res = await this.fetchFn(url, { method, headers: { Authorization: this.auth, ...headers }, body })
    switch (res.status) {
      case 404: throw new NotFoundError(rel)
      case 412: throw new PreconditionFailedError(`Changed on server: ${rel}`)
      case 423: throw new FileLockedError(`Locked on server: ${rel}`)
      case 401: throw new WebDavError('Nextcloud rejected the login (check user / app password).')
    }
    if (!res.ok) throw new WebDavError(`${method} ${rel}: HTTP ${res.status} ${res.statusText}`)
    return res
  }

  /** All files and folders below the root, recursively. Creates the root folder if missing. */
  async list(): Promise<RemoteItem[]> {
    const result: RemoteItem[] = []
    const pending = ['']
    while (pending.length) {
      const dir = pending.shift()!
      let items: RemoteItem[]
      try {
        items = await this.propfind(dir, '1')
      } catch (e) {
        if (e instanceof NotFoundError && dir === '') {
          await this.mkcol('')
          continue
        }
        throw e
      }
      for (const item of items.filter(i => i.path !== dir)) {
        result.push(item)
        if (item.isDirectory) pending.push(item.path)
      }
    }
    return result
  }

  async stat(rel: string): Promise<RemoteItem | null> {
    try {
      return (await this.propfind(rel, '0'))[0] ?? null
    } catch (e) {
      if (e instanceof NotFoundError) return null
      throw e
    }
  }

  private async propfind(rel: string, depth: string): Promise<RemoteItem[]> {
    const res = await this.send('PROPFIND', this.urlOf(rel), rel, { Depth: depth, 'Content-Type': 'application/xml' }, PROPFIND_BODY)
    const doc = xml.parse(await res.text())
    const rootPath = decodeURIComponent(new URL(this.root).pathname)
    return (doc.multistatus?.response ?? []).map((r: any) => {
      let href = decodeURIComponent(String(r.href))
      if (/^https?:\/\//.test(href)) href = decodeURIComponent(new URL(String(r.href)).pathname)
      const p = (href.startsWith(rootPath) ? href.slice(rootPath.length) : href).replace(/^\/+|\/+$/g, '')
      const prop = (r.propstat as any[]).find(ps => String(ps.status ?? '').includes(' 200'))?.prop ?? r.propstat[0].prop
      const modified = prop.getlastmodified ? new Date(String(prop.getlastmodified)) : null
      return {
        path: p,
        isDirectory: typeof prop.resourcetype === 'object' && prop.resourcetype !== null && 'collection' in prop.resourcetype,
        etag: prop.getetag != null ? String(prop.getetag) : null,
        fileId: prop.fileid != null && prop.fileid !== '' ? String(prop.fileid) : null,
        lastModified: modified && !isNaN(modified.getTime()) ? modified : null,
      } satisfies RemoteItem
    })
  }

  async get(rel: string): Promise<Uint8Array> {
    const res = await this.send('GET', this.urlOf(rel), rel)
    return new Uint8Array(await res.arrayBuffer())
  }

  /**
   * Uploads with optimistic concurrency: ifMatch = expected etag, null = must not exist.
   * modified becomes the server-side mtime (X-OC-Mtime), so edit times compare across machines.
   */
  async put(rel: string, data: Uint8Array, ifMatch: string | null, modified: Date): Promise<void> {
    const headers: Record<string, string> = { 'X-OC-Mtime': String(Math.floor(modified.getTime() / 1000)) }
    if (ifMatch !== null) headers['If-Match'] = ifMatch
    else headers['If-None-Match'] = '*'
    await this.send('PUT', this.urlOf(rel), rel, headers, data as BodyInit)
  }

  async delete(rel: string, ifMatch: string | null): Promise<void> {
    try {
      await this.send('DELETE', this.urlOf(rel), rel, ifMatch !== null ? { 'If-Match': ifMatch } : {})
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e
    }
  }

  /**
   * Removes a files_lock lock (e.g. the one the Text web editor leaves behind). Nextcloud allows this for the file
   * owner. Returns false when the server refused.
   */
  async unlock(fileId: string): Promise<boolean> {
    const res = await this.fetchFn(`${this.server}/ocs/v2.php/apps/files_lock/lock/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      headers: { Authorization: this.auth, 'OCS-APIRequest': 'true' },
    })
    return res.ok || res.status === 412 // 412 = was not locked
  }

  async mkcol(rel: string): Promise<void> {
    const url = this.urlOf(rel).replace(/\/?$/, '/')
    const res = await this.fetchFn(url, { method: 'MKCOL', headers: { Authorization: this.auth } })
    if (res.status === 405) return // already exists
    if (res.status === 401) throw new WebDavError('Nextcloud rejected the login (check user / app password).')
    if (!res.ok) throw new WebDavError(`MKCOL ${rel}: HTTP ${res.status} ${res.statusText}`)
  }
}
