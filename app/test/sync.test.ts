import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileNameFromContent, NoteStore } from '../src/main/store'
import { SyncEngine } from '../src/main/sync'
import { WebDavClient } from '../src/main/webdav'
import { FakeWebDav } from './fakeWebDav'

let dir: string
let server: FakeWebDav
let store: NoteStore
let engine: SyncEngine

const newEngine = () => new SyncEngine(store, new WebDavClient('https://nc.example', 'u', 'pw', 'Notes', server.fetch), path.join(dir, 'state.json'))
const local = (rel: string) => fs.readFileSync(store.fullPath(rel), 'utf8')
const writeLocal = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(store.fullPath(rel)), { recursive: true })
  fs.writeFileSync(store.fullPath(rel), text)
}
const setLocalTime = (rel: string, t: Date) => fs.utimesSync(store.fullPath(rel), t, t)
const sync = () => engine.sync()
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncsn-'))
  server = new FakeWebDav()
  server.dirs.add('Notes')
  store = new NoteStore(path.join(dir, 'Notes'), path.join(dir, 'meta.json'))
  engine = newEngine()
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('sync', () => {
  it('downloads new remote notes including categories and unicode', async () => {
    server.dirs.add('Notes/Работа')
    server.put('Notes/Основна цел.md', '## 🧭 Основна цел')
    server.put('Notes/Работа/todo.md', '- [ ] x')
    const result = await sync()
    expect(local('Основна цел.md')).toBe('## 🧭 Основна цел')
    expect(local('Работа/todo.md')).toBe('- [ ] x')
    expect(result.localChanges.has('Работа/todo.md')).toBe(true)
    expect(result.fileIds['Работа/todo.md']).toBe(server.files.get('Notes/Работа/todo.md')!.fileId)
  })

  it('uploads new and edited local notes', async () => {
    writeLocal('a.md', 'one')
    await sync()
    expect(server.text('Notes/a.md')).toBe('one')
    writeLocal('a.md', 'two')
    await sync()
    expect(server.text('Notes/a.md')).toBe('two')
  })

  it('creates missing remote root and subfolders', async () => {
    server.dirs.delete('Notes')
    writeLocal('Cat/Sub/n.md', 'x')
    await sync() // first run creates the root
    await sync()
    expect(server.text('Notes/Cat/Sub/n.md')).toBe('x')
  })

  it('applies remote edit and delete', async () => {
    server.put('Notes/a.md', 'v1')
    server.put('Notes/b.md', 'keep?')
    await sync()
    server.edit('Notes/a.md', 'v2')
    server.files.delete('Notes/b.md')
    await sync()
    expect(local('a.md')).toBe('v2')
    expect(fs.existsSync(store.fullPath('b.md'))).toBe(false)
  })

  it('propagates local delete', async () => {
    server.put('Notes/a.md', 'v1')
    await sync()
    fs.unlinkSync(store.fullPath('a.md'))
    await sync()
    expect(server.files.has('Notes/a.md')).toBe(false)
  })

  it('both edited: newer local edit wins without copies', async () => {
    server.put('Notes/a.md', 'base')
    await sync()
    server.edit('Notes/a.md', 'older web edit', minutesAgo(5))
    writeLocal('a.md', 'newer app edit')
    await sync()
    expect(server.text('Notes/a.md')).toBe('newer app edit')
    expect(local('a.md')).toBe('newer app edit')
    expect(store.listFiles()).toHaveLength(1)
    expect((await sync()).localChanges.size).toBe(0) // settled
  })

  it('both edited: newer remote edit wins', async () => {
    server.put('Notes/a.md', 'base')
    await sync()
    writeLocal('a.md', 'older app edit')
    setLocalTime('a.md', minutesAgo(5))
    server.edit('Notes/a.md', 'newer edit from other PC')
    await sync()
    expect(local('a.md')).toBe('newer edit from other PC')
    expect(server.text('Notes/a.md')).toBe('newer edit from other PC')
    expect(store.listFiles()).toHaveLength(1)
  })

  it('upload carries local edit time', async () => {
    writeLocal('a.md', 'x')
    const edited = new Date(Date.UTC(2026, 9, 1, 8, 0, 0))
    setLocalTime('a.md', edited)
    await sync()
    expect(server.files.get('Notes/a.md')!.modified.getTime()).toBe(edited.getTime())
  })

  it('edit beats delete on either side', async () => {
    server.put('Notes/a.md', 'base')
    server.put('Notes/b.md', 'base')
    await sync()
    server.files.delete('Notes/a.md')
    writeLocal('a.md', 'edited here')
    fs.unlinkSync(store.fullPath('b.md'))
    server.edit('Notes/b.md', 'edited there')
    await sync()
    expect(server.text('Notes/a.md')).toBe('edited here')
    expect(local('b.md')).toBe('edited there')
  })

  it('removes a Text editor lock and uploads the edit', async () => {
    server.put('Notes/a.md', 'base')
    await sync()
    server.locked.add('Notes/a.md')
    writeLocal('a.md', 'edited')
    const result = await sync()
    expect(result.locked).toEqual([])
    expect(server.locked.size).toBe(0)
    expect(server.text('Notes/a.md')).toBe('edited')
  })

  it('skips a lock that cannot be removed and retries later without blocking others', async () => {
    server.put('Notes/a.md', 'base')
    await sync()
    server.locked.add('Notes/a.md')
    server.unremovable.add('Notes/a.md')
    writeLocal('a.md', 'edited')
    writeLocal('b.md', 'new')
    let result = await sync()
    expect(result.locked).toEqual(['a.md'])
    expect(server.text('Notes/a.md')).toBe('base')
    expect(server.text('Notes/b.md')).toBe('new')
    server.unremovable.clear()
    result = await sync()
    expect(result.locked).toEqual([])
    expect(server.text('Notes/a.md')).toBe('edited')
  })

  it('identical files on both sides without state are not re-uploaded', async () => {
    server.put('Notes/a.md', 'same')
    const etag = server.files.get('Notes/a.md')!.etag
    writeLocal('a.md', 'same')
    await sync()
    expect(store.listFiles()).toHaveLength(1)
    expect(server.files.get('Notes/a.md')!.etag).toBe(etag)
  })

  it('state survives restart', async () => {
    server.put('Notes/a.md', 'v1')
    await sync()
    engine = newEngine()
    writeLocal('a.md', 'v2')
    await sync()
    expect(server.text('Notes/a.md')).toBe('v2')
  })

  it('syncs attachments and exposes file id for a new note', async () => {
    const meta = store.newMeta()
    store.saveNote(meta, 'Shopping list\n- milk')
    await sync()
    const fileId = engine.fileIdOf(meta.Path!)
    expect(fileId).not.toBeNull()
    const src = store.saveAttachment(meta.Path!, fileId!, 'Screen shot.PNG', new Uint8Array([1, 2, 3]))
    await sync()
    expect(src).toBe(`.attachments.${fileId}/Screen%20shot.png`)
    expect([...server.files.get(`Notes/.attachments.${fileId}/Screen shot.png`)!.data]).toEqual([1, 2, 3])
    expect(meta.Path).toBe('Shopping list.md')
    expect(store.listNotes()).toHaveLength(1) // attachments are not listed as notes
  })

  it('metadata follows a rename done in Nextcloud', async () => {
    server.put('Notes/old.md', 'x')
    await sync()
    const meta = store.metaFor('old.md')
    meta.Color = '#5ac0e7'
    store.reconcile((await sync()).fileIds)
    server.rename('Notes/old.md', 'Notes/new.md')
    store.reconcile((await sync()).fileIds)
    expect(meta.Path).toBe('new.md')
    expect(store.metaFor('new.md')).toBe(meta)
  })

  it('reads state written by the 1.x (C#) app without re-transferring', async () => {
    server.put('Notes/a.md', 'hello')
    writeLocal('a.md', 'hello')
    const f = server.files.get('Notes/a.md')!
    fs.writeFileSync(path.join(dir, 'state.json'),
      JSON.stringify({ 'a.md': { ETag: f.etag, Hash: createHash('sha256').update('hello').digest('hex').toUpperCase(), FileId: f.fileId } }))
    engine = newEngine()
    const result = await sync()
    expect(result.localChanges.size).toBe(0)
    expect(server.files.get('Notes/a.md')!.etag).toBe(f.etag)
  })
})

describe('store', () => {
  it.each([
    ['## 🧭 Основна цел\nbody', '🧭 Основна цел'],
    ['- [ ] **buy** milk', 'buy milk'],
    ['  \n\n', 'New note'],
    ['a/b:c*?', 'abc'],
  ])('file name from first line: %j', (md, expected) => expect(fileNameFromContent(md)).toBe(expected))

  it('gives new notes unique names', () => {
    const a = store.newMeta()
    store.saveNote(a, 'Same')
    const b = store.newMeta()
    store.saveNote(b, 'Same')
    expect(a.Path).toBe('Same.md')
    expect(b.Path).toBe('Same (2).md')
  })

  it('rejects paths outside the notes folder', () => {
    expect(() => store.fullPath('../evil.md')).toThrow()
  })
})
