import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { NOTE_COLORS } from '../colors'

/** Sticky-only window state; kept on this PC only so the .md files stay clean for Nextcloud Notes. */
export interface NoteMeta {
  Id: string
  /** Relative path ("Category/Title.md"); null until a new note is first saved. */
  Path: string | null
  /** Nextcloud file id; survives renames made by the Nextcloud Notes app. */
  FileId: string | null
  Color: string
  Left: number | null
  Top: number | null
  Width: number
  Height: number
  IsOpen: boolean
  /** Window stays above other windows (per note, this PC only). */
  OnTop?: boolean
}

export const DEFAULT_COLOR = NOTE_COLORS[0][1]

export interface NoteInfo { path: string; title: string; content: string; modified: Date }

const NOTE_EXT = '.md'
const TEMP_SUFFIX = '.ncsn-tmp'

export const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex').toUpperCase()
export const parentOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
export const titleOf = (rel: string) => path.posix.basename(rel, path.posix.extname(rel))
export const isNote = (rel: string) =>
  rel.toLowerCase().endsWith(NOTE_EXT) && !rel.split('/').some(s => s.startsWith('.'))
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

export function sanitizeFileName(name: string, fallback: string): string {
  let clean = [...name].filter(c => c >= ' ' && !'\\/:*?"<>|'.includes(c)).join('').trim()
  clean = clean.replace(/^\.+|\.+$/g, '').trim()
  if (clean.length > 100) clean = clean.slice(0, 100).trim()
  return clean || fallback
}

/** File name from the first non-empty line (Nextcloud Notes convention). */
export function fileNameFromContent(markdown: string): string {
  let first = markdown.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  first = first.replace(/^[#\-*>[\] x]+/, '').replaceAll('**', '').replaceAll('~~', '')
  return sanitizeFileName(first, 'New note')
}

/**
 * Owns the local mirror of the Nextcloud Notes folder and the per-PC metadata. File formats match the 1.x WPF app
 * (metadata.json, sync-state.json) so existing installs upgrade in place.
 */
export class NoteStore {
  readonly root: string
  private meta: NoteMeta[]

  constructor(root: string, private metaFile: string) {
    this.root = path.resolve(root)
    fs.mkdirSync(this.root, { recursive: true })
    this.meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : []
  }

  fullPath(rel: string): string {
    const full = path.resolve(this.root, ...rel.split('/'))
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error(`Path outside notes folder: ${rel}`)
    return full
  }

  // ---- Notes ---------------------------------------------------------------------------------------------

  listNotes(): NoteInfo[] {
    return this.listFiles()
      .filter(isNote)
      .map(rel => {
        const full = this.fullPath(rel)
        return { path: rel, title: titleOf(rel), content: fs.readFileSync(full, 'utf8'), modified: fs.statSync(full).mtime }
      })
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
  }

  readNote(rel: string): string | null {
    const full = this.fullPath(rel)
    return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null
  }

  /** Saves note text. A note without a path gets a file named after its first line. */
  saveNote(meta: NoteMeta, markdown: string): void {
    if (meta.Path === null) {
      meta.Path = this.uniquePath('', fileNameFromContent(markdown), NOTE_EXT)
      this.saveMeta()
    }
    this.writeAtomic(meta.Path, Buffer.from(markdown, 'utf8'))
  }

  deleteNote(meta: NoteMeta): void {
    if (meta.Path !== null && fs.existsSync(this.fullPath(meta.Path))) fs.unlinkSync(this.fullPath(meta.Path))
    this.meta = this.meta.filter(m => m !== meta)
    this.saveMeta()
  }

  /** Stores an image under ".attachments.<fileId>/" next to the note, as Nextcloud Text does. Returns the markdown src. */
  saveAttachment(notePath: string, fileId: string, name: string, data: Uint8Array): string {
    const attachDir = `.attachments.${fileId}`
    const ext = path.extname(name).toLowerCase()
    const base = sanitizeFileName(path.basename(name, path.extname(name)), 'image')
    const rel = this.uniquePath(join(parentOf(notePath), attachDir), base, ext)
    this.writeAtomic(rel, data)
    return `${attachDir}/${encodeURIComponent(path.posix.basename(rel))}`
  }

  private uniquePath(dir: string, base: string, ext: string): string {
    let rel = join(dir, base + ext)
    for (let i = 2; fs.existsSync(this.fullPath(rel)); i++) rel = join(dir, `${base} (${i})${ext}`)
    return rel
  }

  // ---- Raw files (used by SyncEngine) --------------------------------------------------------------------

  listFiles(): string[] {
    return (fs.readdirSync(this.root, { recursive: true, withFileTypes: true }) as fs.Dirent[])
      .filter(d => d.isFile() && !d.name.endsWith(TEMP_SUFFIX))
      .map(d => path.relative(this.root, path.join(d.parentPath, d.name)).split(path.sep).join('/'))
  }

  hashOf(rel: string): string | null {
    const full = this.fullPath(rel)
    return fs.existsSync(full) ? hash(fs.readFileSync(full)) : null
  }

  readBytes(rel: string): Buffer | null {
    const full = this.fullPath(rel)
    return fs.existsSync(full) ? fs.readFileSync(full) : null
  }

  lastWriteUtc(rel: string): Date {
    return fs.statSync(this.fullPath(rel)).mtime
  }

  /**
   * Writes only if the file still has expectedHash (null = must not exist). Guards against overwriting edits made
   * during a sync; synchronous, so nothing else runs between the check and the write.
   */
  writeIfUnchanged(rel: string, data: Uint8Array, expectedHash: string | null, modified?: Date): boolean {
    if (this.hashOf(rel) !== expectedHash) return false
    this.writeAtomic(rel, data)
    if (modified) fs.utimesSync(this.fullPath(rel), modified, modified) // keep the server's edit time
    return true
  }

  deleteIfUnchanged(rel: string, expectedHash: string): boolean {
    if (this.hashOf(rel) !== expectedHash) return false
    fs.unlinkSync(this.fullPath(rel))
    return true
  }

  private writeAtomic(rel: string, data: Uint8Array): void {
    const full = this.fullPath(rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full + TEMP_SUFFIX, data)
    fs.renameSync(full + TEMP_SUFFIX, full)
  }

  // ---- Metadata ------------------------------------------------------------------------------------------

  get allMeta(): readonly NoteMeta[] {
    return this.meta
  }

  metaById(id: string): NoteMeta | undefined {
    return this.meta.find(m => m.Id === id)
  }

  /** Metadata for a note file, created on first use. */
  metaFor(rel: string): NoteMeta {
    let meta = this.meta.find(m => m.Path === rel)
    if (!meta) {
      meta = newMeta(rel)
      this.meta.push(meta)
      this.saveMeta()
    }
    return meta
  }

  newMeta(): NoteMeta {
    const meta = newMeta(null)
    meta.IsOpen = true
    this.meta.push(meta)
    return meta
  }

  /**
   * After a sync: follow renames done on Nextcloud via file id, record file ids, and drop metadata for notes that
   * no longer exist. Unsaved new notes (Path === null) are kept.
   */
  reconcile(fileIds: Record<string, string>): void {
    const pathById = new Map<string, string>()
    for (const [p, id] of Object.entries(fileIds)) if (!pathById.has(id)) pathById.set(id, p)
    for (const m of this.meta) {
      const current = m.FileId !== null ? pathById.get(m.FileId) : undefined
      if (current !== undefined) m.Path = current
      else if (m.Path !== null && fileIds[m.Path] !== undefined) m.FileId = fileIds[m.Path]
    }
    this.meta = this.meta.filter(m => m.Path === null || fs.existsSync(this.fullPath(m.Path)))
    // A rename can leave a fresh entry for the new path next to the followed one; keep the open/older one.
    const byPath = new Map<string, NoteMeta[]>()
    for (const m of this.meta) if (m.Path !== null) byPath.set(m.Path, [...(byPath.get(m.Path) ?? []), m])
    for (const group of byPath.values()) {
      if (group.length < 2) continue
      const keep = group.find(m => m.IsOpen) ?? group[0]
      this.meta = this.meta.filter(m => !group.includes(m) || m === keep)
    }
    this.saveMeta()
  }

  saveMeta(): void {
    fs.mkdirSync(path.dirname(path.resolve(this.metaFile)), { recursive: true })
    fs.writeFileSync(this.metaFile + TEMP_SUFFIX, JSON.stringify(this.meta.filter(m => m.Path !== null), null, 2))
    fs.renameSync(this.metaFile + TEMP_SUFFIX, this.metaFile)
  }
}

function newMeta(rel: string | null): NoteMeta {
  return { Id: randomUUID(), Path: rel, FileId: null, Color: DEFAULT_COLOR, Left: null, Top: null, Width: 340, Height: 340, IsOpen: false }
}
