import { Call, Events } from '@wailsio/runtime'

export interface LoadPayload { markdown: string; baseUrl: string; color: string }
export interface NoteCard { id: string; color: string; modified: number; preview: string }
export interface SettingsView {
  serverUrl: string; user: string; folder: string; hasPassword: boolean
  startWithLogin: boolean; startMinimized: boolean; version: string; loginLabel: string
}

/** Calls a method of the Go Backend service (app.go). */
const call = <T = void>(method: string, ...args: unknown[]): Promise<T> => Call.ByName(`main.Backend.${method}`, ...args)
const on = <T>(name: string, cb: (data: T) => void) => void Events.On(name, e => cb(e.data as T))

/** Base64 for image bytes (bound calls carry JSON). */
function toBase64(data: Uint8Array): string {
  let s = ''
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000))
  return btoa(s)
}

/** The sticky window's note id, passed in its URL. */
const stickyId = new URLSearchParams(location.search).get('id') ?? ''

/** The only surface the pages get; same shape as the Electron preload API. */
export const api = {
  sticky: {
    init: () => call<LoadPayload | null>('StickyInit', stickyId),
    changed: (markdown: string) => void call('StickyChanged', stickyId, markdown),
    pasteImage: (data: Uint8Array, mime: string, name: string) =>
      call<{ src?: string; error?: string }>('StickyPasteImage', stickyId, toBase64(data), mime, name),
    openLink: (href: string) => void call('OpenLink', href),
    newNote: () => void call('NewNote'),
    menu: (x: number, y: number) => void call('StickyMenu', stickyId, Math.round(x), Math.round(y)),
    close: () => void call('StickyClose', stickyId),
    onLoad: (cb: (p: LoadPayload) => void) =>
      on<{ id: string; payload: LoadPayload }>('sticky:load', d => d.id === stickyId && cb(d.payload)),
    onColor: (cb: (c: string) => void) => on<{ id: string; color: string }>('sticky:color', d => d.id === stickyId && cb(d.color)),
  },
  list: {
    notes: (query: string) => call<NoteCard[]>('ListNotes', query),
    open: (id: string) => void call('OpenNote', id),
    newNote: () => void call('NewNote'),
    remove: (id: string) => void call('DeleteNote', id),
    settings: () => void call('ShowSettings'),
    close: () => void call('CloseList'),
    onChanged: (cb: () => void) => on('notes-changed', cb),
  },
  settings: {
    get: () => call<SettingsView>('GetSettings'),
    save: (p: object) => call<{ ok: boolean; message: string }>('SaveSettings', p),
    close: () => void call('CloseSettings'),
  },
  status: () => call<string>('Status'),
  onStatus: (cb: (s: string) => void) => on('status', cb),
  syncNow: () => void call('SyncNow'),
}

// Links never navigate the app's own window (Electron blocked this with will-navigate / setWindowOpenHandler).
document.addEventListener('click', e => {
  const a = (e.target as HTMLElement).closest?.('a[href]')
  if (a) e.preventDefault()
})
// Dropping a file or URL outside the editor would navigate the webview to it.
window.addEventListener('dragover', e => e.preventDefault())
window.addEventListener('drop', e => e.preventDefault())
