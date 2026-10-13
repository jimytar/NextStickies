import { contextBridge, ipcRenderer } from 'electron'

/** The only surface renderer pages get (sandboxed, context-isolated). */
const on = (channel: string, cb: (...args: any[]) => void) => {
  ipcRenderer.on(channel, (_e, ...args) => cb(...args))
}

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  sticky: {
    init: () => ipcRenderer.invoke('sticky:init'),
    changed: (markdown: string) => ipcRenderer.send('sticky:changed', markdown),
    pasteImage: (data: Uint8Array, mime: string, name: string) => ipcRenderer.invoke('sticky:pasteImage', data, mime, name),
    openLink: (href: string) => ipcRenderer.send('sticky:openLink', href),
    newNote: () => ipcRenderer.send('sticky:new'),
    setColor: (hex: string) => ipcRenderer.send('sticky:color', hex),
    setOnTop: (on: boolean) => ipcRenderer.send('sticky:onTop', on),
    showList: () => ipcRenderer.send('sticky:showList'),
    remove: () => ipcRenderer.send('sticky:delete'),
    close: () => ipcRenderer.send('sticky:close'),
    onLoad: (cb: (p: unknown) => void) => on('sticky:load', cb),
    onColor: (cb: (c: string) => void) => on('sticky:color', cb),
    onOnTop: (cb: (v: boolean) => void) => on('sticky:onTop', cb),
  },
  list: {
    notes: (query: string) => ipcRenderer.invoke('list:notes', query),
    open: (id: string) => ipcRenderer.send('list:open', id),
    newNote: () => ipcRenderer.send('list:new'),
    remove: (id: string) => ipcRenderer.send('list:delete', id),
    settings: () => ipcRenderer.send('list:settings'),
    close: () => ipcRenderer.send('list:close'),
    onChanged: (cb: () => void) => on('notes-changed', cb),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (p: unknown) => ipcRenderer.invoke('settings:save', p),
  },
  status: () => ipcRenderer.invoke('status'),
  onStatus: (cb: (s: string) => void) => on('status', cb),
  syncNow: () => ipcRenderer.send('sync:now'),
  confirmDelete: {
    get: () => ipcRenderer.invoke('confirmDelete:get'),
    set: (on: boolean) => ipcRenderer.send('confirmDelete:set', on),
  },
})
