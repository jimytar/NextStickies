import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, clipboard, ClipboardItem, ipcMain, Menu, nativeImage, nativeTheme, net, protocol, screen, shell, Tray } from 'electron'
import { NOTE_COLORS } from '../colors'
import { NoteMeta, NoteStore, parentOf, titleOf } from './store'
import { SyncEngine, SyncResult } from './sync'
import { WebDavClient } from './webdav'
import * as cfg from './settings'

// ---- Paths & single instance -------------------------------------------------------------------------------

const DATA_DIR = migrateDataDir(path.join(app.getPath('appData'), 'NcStickyNotes'), path.join(app.getPath('appData'), 'NextStickies'))
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
const STATE_FILE = path.join(DATA_DIR, 'sync-state.json')
const ASSETS = __dirname // dist/: html, js, css, icons
app.setPath('userData', path.join(DATA_DIR, 'electron')) // Chromium caches stay out of the notes folder

/** One-time move of the pre-rename data folder ("NC Sticky Notes" 1.x/2.0). Keeps using it if it is still in use. */
function migrateDataDir(old: string, next: string): string {
  if (fs.existsSync(next) || !fs.existsSync(old)) return next
  try {
    fs.renameSync(old, next)
    return next
  } catch {
    return old
  }
}

const exitRequested = process.argv.includes('--exit') // sent by the Windows installer before upgrading
if (!app.requestSingleInstanceLock() || exitRequested) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => (argv.includes('--exit') ? quit() : showList()))
  protocol.registerSchemesAsPrivileged([{ scheme: 'notes', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
  app.whenReady().then(start)
}

// ---- State -------------------------------------------------------------------------------------------------

let store: NoteStore
let settings: cfg.Settings
let engine: SyncEngine | null = null
let status = 'Sync not set up'
let tray: Tray | null = null
let list: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let quitting = false
let syncDebounce: NodeJS.Timeout | undefined

interface Sticky {
  win: BrowserWindow
  meta: NoteMeta
  lastSaved: string
  pending: string | null
  saveTimer?: NodeJS.Timeout
  discarded: boolean
}
const stickies = new Map<string, Sticky>() // by meta id

const icon = () => nativeImage.createFromPath(path.join(ASSETS, 'icon.png'))
const webPreferences = { preload: path.join(ASSETS, 'preload.cjs'), sandbox: true, contextIsolation: true }

function start() {
  nativeTheme.themeSource = 'dark'
  Menu.setApplicationMenu(null)
  fs.mkdirSync(DATA_DIR, { recursive: true })
  store = new NoteStore(path.join(DATA_DIR, 'Notes'), path.join(DATA_DIR, 'metadata.json'))
  settings = cfg.loadSettings(SETTINGS_FILE)
  cfg.migrateStartWithLogin()
  createEngine()

  // Images in notes are relative (.attachments.<id>/x.png); serve the notes folder as notes://local/.
  protocol.handle('notes', req => {
    try {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '')
      return net.fetch(pathToFileURL(store.fullPath(rel)).toString())
    } catch {
      return new Response(null, { status: 404 })
    }
  })

  createTray()
  registerIpc()
  app.on('window-all-closed', () => {}) // keep running in the tray
  app.on('before-quit', () => {
    quitting = true
    for (const s of stickies.values()) flush(s)
  })

  const open = store.allMeta.filter(m => m.IsOpen && m.Path !== null && fs.existsSync(store.fullPath(m.Path)))
  for (const meta of open) openSticky(meta)
  if (open.length === 0 && !settings.StartMinimized) showList()
  void syncNow()
  setInterval(() => void syncNow(), 60_000)
}

function quit() {
  quitting = true
  app.quit()
}

// ---- Sync --------------------------------------------------------------------------------------------------

function createEngine() {
  engine = null
  if (!cfg.isConfigured(settings)) return setStatus('Sync not set up')
  let password: string
  try {
    password = cfg.getPassword(settings)
  } catch {
    return setStatus('Saved password could not be read on this machine — re-enter it in Settings')
  }
  const dav = new WebDavClient(settings.ServerUrl, settings.User, password, settings.Folder)
  engine = new SyncEngine(store, dav, STATE_FILE)
}

function setStatus(s: string) {
  status = s
  for (const w of [list, settingsWin]) w?.webContents.send('status', s)
}

/** Called after every local edit; batches edits into one sync. */
function requestSync() {
  notesChanged()
  clearTimeout(syncDebounce)
  syncDebounce = setTimeout(() => void syncNow(), 2000)
}

async function syncNow() {
  if (!engine) return
  for (const s of stickies.values()) flush(s)
  setStatus('Syncing…')
  try {
    const result = await engine.sync()
    store.reconcile(result.fileIds)
    for (const s of [...stickies.values()]) onSynced(s, result)
    notesChanged()
    let text = `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    if (result.locked.length) text += ` · locked on Nextcloud and could not unlock, will retry: ${result.locked.map(titleOf).join(', ')}`
    setStatus(text)
  } catch (e) {
    setStatus(`Sync failed: ${(e as Error).message}`) // background sync never takes the app down
  }
}

function notesChanged() {
  list?.webContents.send('notes-changed')
}

// ---- Tray & list ------------------------------------------------------------------------------------------

function createTray() {
  tray = new Tray(icon().resize({ width: 32, height: 32 }))
  tray.setToolTip('NextStickies')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Notes list', click: showList },
    { label: 'New note', click: () => openSticky(store.newMeta()) },
    { label: 'Sync now', click: () => void syncNow() },
    { type: 'separator' },
    { label: 'Exit', click: quit },
  ]))
  tray.on('click', showList)
}

function showList() {
  if (!list) {
    list = new BrowserWindow({
      width: 400, height: 780, minWidth: 300, minHeight: 300, frame: false, backgroundColor: '#202020',
      title: 'NextStickies', icon: icon(), show: false, webPreferences,
    })
    list.loadFile(path.join(ASSETS, 'list.html'))
    list.once('ready-to-show', () => list?.show())
    list.on('close', e => {
      if (quitting) return
      e.preventDefault() // closing hides to the tray
      list?.hide()
    })
    list.on('closed', () => (list = null))
    return
  }
  if (list.isMinimized()) list.restore()
  list.show()
  list.focus()
}

function showSettings() {
  if (settingsWin) return settingsWin.focus()
  settingsWin = new BrowserWindow({
    width: 440, height: 630, resizable: false, backgroundColor: '#202020', title: 'Settings', icon: icon(),
    parent: list ?? undefined, autoHideMenuBar: true, webPreferences,
  })
  settingsWin.loadFile(path.join(ASSETS, 'settings.html'))
  settingsWin.on('closed', () => (settingsWin = null))
}

function noteCards(query: string) {
  const q = query.trim().toLocaleLowerCase()
  return store.listNotes()
    .filter(n => !q || n.title.toLocaleLowerCase().includes(q) || n.content.toLocaleLowerCase().includes(q))
    .map(n => {
      const meta = store.metaFor(n.path)
      const today = n.modified.toDateString() === new Date().toDateString()
      const time = today
        ? n.modified.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : n.modified.toLocaleDateString([], { day: 'numeric', month: 'short' })
      return { id: meta.Id, color: meta.Color, time, preview: preview(n.content) }
    })
}

/** Plain-text preview of a markdown note. */
function preview(markdown: string): string {
  let text = markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, '🖼').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+)/gm, '').replace(/(\*\*|__|~~|\*|`)/g, '')
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, '$1')
  return text.split('\n').map(l => l.trim()).filter(l => l && l !== '---').slice(0, 6).join('\n')
}

/** Deletes locally and (via sync) on Nextcloud. The renderer has already asked for confirmation. */
function deleteNote(meta: NoteMeta) {
  const s = stickies.get(meta.Id)
  if (s) closeDiscarded(s)
  store.deleteNote(meta)
  requestSync()
}

// ---- Sticky windows ----------------------------------------------------------------------------------------

function openSticky(meta: NoteMeta) {
  const existing = stickies.get(meta.Id)
  if (existing) return existing.win.focus()
  meta.IsOpen = true
  store.saveMeta()

  const bounds = { width: meta.Width, height: meta.Height, ...position(meta) }
  const win = new BrowserWindow({
    ...bounds, minWidth: 220, minHeight: 160, frame: false, backgroundColor: '#333333', show: false, alwaysOnTop: !!meta.OnTop,
    title: meta.Path ? titleOf(meta.Path) : 'New note', icon: icon(), webPreferences,
  })
  const s: Sticky = { win, meta, lastSaved: '', pending: null, discarded: false }
  stickies.set(meta.Id, s)
  win.loadFile(path.join(ASSETS, 'sticky.html'))
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault()
    openExternal(url)
  })
  win.on('close', () => {
    flush(s)
    if (!s.discarded && !win.isMinimized() && !win.isMaximized()) {
      const b = win.getBounds()
      Object.assign(meta, { Left: b.x, Top: b.y, Width: b.width, Height: b.height })
      store.saveMeta()
    }
  })
  win.on('closed', () => stickies.delete(meta.Id))
}

/** Saved position if it is still on a screen, else cascaded near the centre. */
function position(meta: NoteMeta): { x?: number; y?: number } {
  if (meta.Left !== null && meta.Top !== null) {
    const p = { x: Math.round(meta.Left), y: Math.round(meta.Top) }
    const visible = screen.getAllDisplays().some(d =>
      p.x >= d.workArea.x - 50 && p.y >= d.workArea.y - 10 &&
      p.x < d.workArea.x + d.workArea.width - 50 && p.y < d.workArea.y + d.workArea.height - 30)
    if (visible) return p
  }
  const area = screen.getPrimaryDisplay().workArea
  const offset = 30 * stickies.size
  return { x: Math.round(area.x + area.width / 2 - meta.Width / 2 + offset), y: Math.round(area.y + area.height / 3 - meta.Height / 3 + offset) }
}

const stickyOf = (sender: Electron.WebContents) => [...stickies.values()].find(s => s.win.webContents === sender)

function baseUrl(meta: NoteMeta) {
  const dir = meta.Path === null ? '' : parentOf(meta.Path)
  return 'notes://local/' + dir.split('/').filter(Boolean).map(seg => encodeURIComponent(seg) + '/').join('')
}

function loadPayload(s: Sticky) {
  s.lastSaved = s.meta.Path === null ? '' : store.readNote(s.meta.Path) ?? ''
  return { markdown: s.lastSaved, baseUrl: baseUrl(s.meta), color: s.meta.Color, onTop: !!s.meta.OnTop }
}

/** Writes pending editor text to disk. Empty new notes are not created. */
function flush(s: Sticky) {
  clearTimeout(s.saveTimer)
  if (s.pending === null || s.discarded) return
  const text = s.pending
  s.pending = null
  if (text === s.lastSaved || (s.meta.Path === null && !text.trim())) return
  store.saveNote(s.meta, text)
  s.lastSaved = text
  s.win.setTitle(titleOf(s.meta.Path!))
  requestSync()
}

/** After a sync: close if deleted on Nextcloud, reload if changed there. */
function onSynced(s: Sticky, result: SyncResult) {
  if (s.meta.Path === null) return
  if (!fs.existsSync(store.fullPath(s.meta.Path))) return closeDiscarded(s)
  s.win.setTitle(titleOf(s.meta.Path))
  if (!result.localChanges.has(s.meta.Path) || store.readNote(s.meta.Path) === s.lastSaved) return
  // Typing that hasn't been saved yet is the newest edit: keep it; saving it overwrites the server version.
  if (s.pending !== null && s.pending !== s.lastSaved) return
  s.win.webContents.send('sticky:load', loadPayload(s))
}

function closeDiscarded(s: Sticky) {
  s.discarded = true
  s.win.close()
}

async function addImage(s: Sticky, data: Uint8Array, mime: string, name: string) {
  if (!engine) return { error: 'Set up Nextcloud sync (gear in the notes list) to add images.' }
  flush(s)
  if (s.meta.Path === null) {
    store.saveNote(s.meta, s.lastSaved)
    s.win.setTitle(titleOf(s.meta.Path!))
  }
  let fileId = engine.fileIdOf(s.meta.Path!)
  if (fileId === null) {
    await syncNow() // the note must exist on Nextcloud: images live in .attachments.<fileId>/
    fileId = engine?.fileIdOf(s.meta.Path!) ?? null
  }
  if (fileId === null) return { error: `Can't add images until the note is on Nextcloud. ${status}` }
  const ext = ({ 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg' } as Record<string, string>)[mime] ?? '.png'
  if (!path.extname(name)) name = (name || 'image') + ext
  const src = store.saveAttachment(s.meta.Path!, fileId, name, data)
  requestSync()
  return { src }
}

/** Reads an image shown in a note (notes:// or http(s)) for the renderer to decode; http(s) is CORS-blocked there. */
async function fetchImage(url: string) {
  try {
    if (!['notes:', 'http:', 'https:'].includes(new URL(url).protocol)) return null
    const res = await net.fetch(url)
    if (!res.ok) return null
    return { data: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? '' }
  } catch {
    return null
  }
}

function openExternal(url: string) {
  try {
    if (['http:', 'https:', 'mailto:'].includes(new URL(url).protocol)) void shell.openExternal(url)
  } catch {
    // relative or malformed link: ignore
  }
}

function setColor(s: Sticky, hex: string) {
  if (!NOTE_COLORS.some(([, c]) => c === hex)) return
  s.meta.Color = hex
  store.saveMeta()
  s.win.webContents.send('sticky:color', hex)
  notesChanged()
}

// ---- IPC ---------------------------------------------------------------------------------------------------

function registerIpc() {
  // Sticky
  ipcMain.handle('sticky:init', e => {
    const s = stickyOf(e.sender)
    return s ? loadPayload(s) : null
  })
  ipcMain.on('sticky:changed', (e, markdown: string) => {
    const s = stickyOf(e.sender)
    if (!s) return
    s.pending = markdown
    clearTimeout(s.saveTimer)
    s.saveTimer = setTimeout(() => flush(s), 500)
  })
  ipcMain.handle('sticky:pasteImage', (e, data: Uint8Array, mime: string, name: string) => {
    const s = stickyOf(e.sender)
    return s ? addImage(s, data, mime, name) : { error: 'Note window not found' }
  })
  ipcMain.handle('sticky:fetchImage', (_e, url: string) => fetchImage(url))
  ipcMain.handle('sticky:copyImage', (_e, png: Uint8Array) =>
    clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]))
  ipcMain.on('sticky:openLink', (_e, href: string) => openExternal(href))
  ipcMain.on('sticky:new', () => openSticky(store.newMeta()))
  ipcMain.on('sticky:color', (e, hex: string) => {
    const s = stickyOf(e.sender)
    if (s) setColor(s, hex)
  })
  ipcMain.on('sticky:onTop', (e, on: boolean) => {
    const s = stickyOf(e.sender)
    if (!s) return
    s.meta.OnTop = !!on
    store.saveMeta()
    s.win.setAlwaysOnTop(s.meta.OnTop)
    s.win.webContents.send('sticky:onTop', s.meta.OnTop)
  })
  ipcMain.on('sticky:showList', showList)
  ipcMain.on('sticky:delete', e => {
    const s = stickyOf(e.sender)
    if (s) deleteNote(s.meta)
  })
  /** The × button: hide the note (it stays in the list). A note that was never typed in is dropped. */
  ipcMain.on('sticky:close', e => {
    const s = stickyOf(e.sender)
    if (!s) return
    flush(s)
    s.meta.IsOpen = false
    if (s.meta.Path === null) store.deleteNote(s.meta)
    else store.saveMeta()
    s.win.close()
  })

  // List
  ipcMain.handle('list:notes', (_e, query: string) => noteCards(query))
  ipcMain.on('list:open', (_e, id: string) => {
    const meta = store.metaById(id)
    if (meta) openSticky(meta)
  })
  ipcMain.on('list:new', () => openSticky(store.newMeta()))
  ipcMain.on('list:delete', (_e, id: string) => {
    const meta = store.metaById(id)
    if (meta) deleteNote(meta)
  })
  ipcMain.on('list:settings', showSettings)
  ipcMain.on('list:close', () => list?.close())
  ipcMain.handle('status', () => status)
  ipcMain.handle('confirmDelete:get', () => settings.ConfirmDelete)
  ipcMain.on('confirmDelete:set', (_e, on: boolean) => {
    settings.ConfirmDelete = !!on
    cfg.saveSettings(SETTINGS_FILE, settings)
  })

  // Settings
  ipcMain.handle('settings:get', () => ({
    serverUrl: settings.ServerUrl, user: settings.User, folder: settings.Folder,
    hasPassword: !!settings.EncryptedPassword, startWithLogin: cfg.getStartWithLogin(),
    startMinimized: settings.StartMinimized, confirmDelete: settings.ConfirmDelete, version: app.getVersion(),
    loginLabel: process.platform === 'win32' ? 'Start with Windows' : 'Start on login',
  }))
  ipcMain.handle('settings:save', async (_e, p: { serverUrl: string; user: string; password: string; folder: string; startWithLogin: boolean; startMinimized: boolean; confirmDelete: boolean }) => {
    cfg.setStartWithLogin(p.startWithLogin)
    settings.ConfirmDelete = !!p.confirmDelete
    settings.StartMinimized = p.startMinimized // app preferences apply even if the connection test fails
    cfg.saveSettings(SETTINGS_FILE, settings)

    let url = p.serverUrl.trim().replace(/\/+$/, '')
    if (url && !url.includes('://')) url = 'https://' + url
    const next: cfg.Settings = { ...settings, ServerUrl: url, User: p.user.trim(), Folder: p.folder.trim().replace(/^\/+|\/+$/g, '') || 'Notes' }
    if (p.password) cfg.setPassword(next, p.password)
    if (!url || !next.User) {
      next.EncryptedPassword = undefined // cleared → local-only
    } else {
      if (!next.EncryptedPassword) return { ok: false, message: 'Enter the app password.' }
      try {
        const dav = new WebDavClient(next.ServerUrl, next.User, cfg.getPassword(next), next.Folder)
        const items = await dav.list()
        const count = items.filter(i => !i.isDirectory && i.path.toLowerCase().endsWith('.md') && !i.path.split('/').some(s => s.startsWith('.'))).length
        setStatus(`Connected — ${count} notes in /${next.Folder}. Syncing…`)
      } catch (e) {
        return { ok: false, message: `Connection failed: ${(e as Error).message}` }
      }
    }
    // Different folder: compare everything afresh (identical files stay, differing ones resolve by newest edit).
    if (cfg.remoteKey(next) !== cfg.remoteKey(settings)) fs.rmSync(STATE_FILE, { force: true })
    settings = next
    cfg.saveSettings(SETTINGS_FILE, settings)
    createEngine()
    void syncNow()
    return { ok: true, message: status }
  })
  ipcMain.on('sync:now', () => void syncNow())
}
