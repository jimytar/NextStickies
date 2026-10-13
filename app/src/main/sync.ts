import * as fs from 'node:fs'
import * as path from 'node:path'
import { hash, NoteStore, parentOf } from './store'
import { FileLockedError, PreconditionFailedError, RemoteItem, WebDavClient, WebDavError } from './webdav'

export interface SyncResult {
  localChanges: Set<string>
  fileIds: Record<string, string>
  locked: string[]
}

/** Per-path state of the last successful sync. Property names match the 1.x sync-state.json. */
interface FileState { ETag: string; Hash: string; FileId: string | null }

/**
 * Two-way sync between NoteStore and a WebDAV folder. Three-way compare of local hash and remote etag against what
 * was last synced. When both sides changed, the most recent edit wins (local mtime vs server mtime, which uploads set
 * via X-OC-Mtime); an edit always beats a delete. Locks left by the Nextcloud Text editor are removed so edits made in
 * this app go through.
 */
export class SyncEngine {
  private state: Record<string, FileState>
  private running: Promise<unknown> = Promise.resolve()

  constructor(private store: NoteStore, private dav: WebDavClient, private stateFile: string) {
    this.state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {}
  }

  fileIdOf(rel: string): string | null {
    return this.state[rel]?.FileId ?? null
  }

  /** Runs one sync; concurrent calls queue behind the running one. */
  sync(): Promise<SyncResult> {
    const next = this.running.catch(() => {}).then(() => this.run())
    this.running = next
    return next
  }

  private async run(): Promise<SyncResult> {
    const run = new Run(this.store, this.dav, this.state)
    await run.execute()
    this.saveState()
    const fileIds: Record<string, string> = {}
    for (const [p, s] of Object.entries(this.state)) if (s.FileId) fileIds[p] = s.FileId
    return { localChanges: run.localChanges, fileIds, locked: run.locked }
  }

  private saveState() {
    fs.mkdirSync(path.dirname(path.resolve(this.stateFile)), { recursive: true })
    fs.writeFileSync(this.stateFile + '.tmp', JSON.stringify(this.state))
    fs.renameSync(this.stateFile + '.tmp', this.stateFile)
  }
}

class Run {
  readonly localChanges = new Set<string>()
  readonly locked: string[] = []
  private remoteDirs = new Set<string>([''])

  constructor(private store: NoteStore, private dav: WebDavClient, private state: Record<string, FileState>) {}

  async execute() {
    const remote = new Map<string, RemoteItem>()
    for (const item of await this.dav.list()) {
      if (item.isDirectory) this.remoteDirs.add(item.path)
      else remote.set(item.path, item)
    }
    const paths = new Set([...this.store.listFiles(), ...remote.keys(), ...Object.keys(this.state)])
    for (const p of [...paths].sort()) {
      try {
        await this.syncFile(p, this.store.hashOf(p), remote.get(p) ?? null, this.state[p] ?? null)
      } catch (e) {
        if (!(e instanceof FileLockedError)) throw e
        this.locked.push(p) // could not unlock; state untouched, so the next run retries
      }
    }
  }

  private async syncFile(p: string, l: string | null, r: RemoteItem | null, s: FileState | null) {
    const localChanged = s === null ? l !== null : l !== s.Hash
    const remoteChanged = s === null ? r !== null : r?.etag !== s.ETag

    if (!localChanged && !remoteChanged) {
      if (l === null && r === null) this.forget(p)
      else if (s !== null && s.FileId === null && r?.fileId) this.record(p, s.ETag, s.Hash, r.fileId)
      return
    }

    if (!localChanged) {
      // remote changed
      if (r === null) {
        if (l === null || this.store.deleteIfUnchanged(p, l)) {
          this.localChanges.add(p)
          this.forget(p)
        }
      } else await this.download(p, r, l)
      return
    }

    if (!remoteChanged) {
      // local changed
      if (l === null) await this.deleteRemote(p, s!)
      else await this.upload(p, l, r?.etag ?? null, r?.fileId ?? s?.FileId ?? null)
      return
    }

    // Both changed.
    if (l === null) {
      if (r === null) this.forget(p)
      else await this.download(p, r, null) // deleted here, edited there → keep the edit
    } else if (r === null) await this.upload(p, l, null, null) // edited here, deleted there → keep the edit
    else await this.resolveBothChanged(p, l, r)
  }

  /** Both sides edited: the later edit wins, the other is overwritten. */
  private async resolveBothChanged(p: string, localHash: string, r: RemoteItem) {
    const data = await this.dav.get(p)
    if (hash(data) === localHash) this.record(p, r.etag!, localHash, r.fileId) // same content on both sides
    else if (r.lastModified && r.lastModified > this.store.lastWriteUtc(p)) this.write(p, r, data, localHash)
    else await this.upload(p, localHash, r.etag, r.fileId)
  }

  private async download(p: string, r: RemoteItem, expectedLocal: string | null) {
    this.write(p, r, await this.dav.get(p), expectedLocal)
  }

  private write(p: string, r: RemoteItem, data: Uint8Array, expectedLocal: string | null) {
    if (this.store.writeIfUnchanged(p, data, expectedLocal, r.lastModified ?? undefined)) {
      this.localChanges.add(p)
      this.record(p, r.etag!, hash(data), r.fileId)
    }
    // else: edited locally meanwhile; next run sees both sides changed and resolves.
  }

  private async upload(p: string, localHash: string, ifMatch: string | null, fileId: string | null) {
    const data = this.store.readBytes(p)
    if (data === null || hash(data) !== localHash) return // changed meanwhile; next run
    await this.ensureRemoteDir(parentOf(p))
    try {
      await this.unlocking(fileId, () => this.dav.put(p, data, ifMatch, this.store.lastWriteUtc(p)))
    } catch (e) {
      if (!(e instanceof PreconditionFailedError)) throw e
      // Changed on the server since we listed it: decide again with its current state.
      const current = await this.dav.stat(p)
      if (current) await this.resolveBothChanged(p, localHash, current)
      else await this.upload(p, localHash, null, null)
      return
    }
    const stat = await this.dav.stat(p)
    if (!stat) throw new WebDavError(`Upload of ${p} not found on server`)
    this.record(p, stat.etag!, localHash, stat.fileId)
  }

  private async deleteRemote(p: string, s: FileState) {
    try {
      await this.unlocking(s.FileId, () => this.dav.delete(p, s.ETag))
      this.forget(p)
    } catch (e) {
      if (!(e instanceof PreconditionFailedError)) throw e
      // Edited on the server after we deleted it here: keep the edit.
      const r = await this.dav.stat(p)
      if (r === null) this.forget(p)
      else await this.download(p, r, null)
    }
  }

  /** Runs a write; if Nextcloud reports the file locked (Text editor), removes the lock and retries once. */
  private async unlocking(fileId: string | null, write: () => Promise<void>) {
    try {
      await write()
    } catch (e) {
      if (!(e instanceof FileLockedError) || fileId === null || !(await this.dav.unlock(fileId))) throw e
      await write()
    }
  }

  private async ensureRemoteDir(dir: string) {
    if (this.remoteDirs.has(dir)) return
    await this.ensureRemoteDir(parentOf(dir))
    await this.dav.mkcol(dir)
    this.remoteDirs.add(dir)
  }

  private record(p: string, etag: string, h: string, fileId: string | null) {
    this.state[p] = { ETag: etag, Hash: h, FileId: fileId }
  }

  private forget(p: string) {
    delete this.state[p]
  }
}
