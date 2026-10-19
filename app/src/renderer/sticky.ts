import { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import Placeholder from '@tiptap/extension-placeholder'
import 'emoji-picker-element'
import { NOTE_COLORS } from '../colors'
import { confirmDelete } from './confirm'
import { noteExtensions } from './extensions'
import { icons, renderIcons } from './icons'
import type { LoadPayload } from './api'

const api = window.api.sticky
// Resolved before <base> is pointed at the note's folder for images.
const emojiData = new URL('emoji-data.json', location.href).href
const base = document.head.appendChild(document.createElement('base'))

document.getElementById('new')!.onclick = () => api.newNote()
document.getElementById('close')!.onclick = () => api.close()
const pin = document.getElementById('pin')!
pin.onclick = () => api.setOnTop(pin.getAttribute('aria-pressed') !== 'true')
function setOnTop(on: boolean) {
  pin.setAttribute('aria-pressed', String(on))
  pin.title = on ? 'Stop keeping on top' : 'Keep on top'
}

// Note menu (in-window, like Windows Sticky Notes): color strip, notes list, delete.
const menu = document.getElementById('menu-pop')!
const swatches = document.getElementById('swatches')!
for (const [name, hex] of NOTE_COLORS) {
  const b = document.createElement('button')
  b.title = name
  b.setAttribute('aria-label', name)
  b.dataset.color = hex
  b.style.background = hex
  b.onclick = () => {
    api.setColor(hex)
    toggleMenu(false)
  }
  swatches.append(b)
}
function toggleMenu(open = menu.hidden) {
  menu.hidden = !open
  if (open) (swatches.querySelector('[aria-pressed=true]') as HTMLElement ?? swatches.firstElementChild)?.focus()
}
document.getElementById('menu')!.onclick = e => {
  e.stopPropagation()
  toggleMenu()
}
document.getElementById('show-list')!.onclick = () => {
  toggleMenu(false)
  api.showList()
}
document.getElementById('delete')!.onclick = async () => {
  toggleMenu(false)
  if (await confirmDelete()) api.remove()
}
document.addEventListener('mousedown', e => {
  if (!menu.hidden && !menu.contains(e.target as Node) && !(e.target as Element).closest('#menu')) toggleMenu(false)
})
renderIcons()

// Unfocused: the header shrinks to a colored strip and the toolbar hides.
const setFocused = (on: boolean) => document.body.classList.toggle('blurred', !on)
window.addEventListener('focus', () => setFocused(true))
window.addEventListener('blur', () => {
  setFocused(false)
  toggleMenu(false)
})
setFocused(document.hasFocus())

const editor = new Editor({
  element: document.getElementById('editor')!,
  extensions: noteExtensions([Placeholder.configure({ placeholder: 'Take a note…' })]),
  editorProps: {
    handlePaste: (_view, event) => sendImages(event.clipboardData?.files),
    handleDrop: (_view, event) => sendImages((event as DragEvent).dataTransfer?.files),
    handleDOMEvents: {
      copy: (_view, event) => copyImage(event, false),
      cut: (_view, event) => copyImage(event, true),
    },
    handleClick: (_view, _pos, event) => {
      const a = (event.target as HTMLElement).closest('a')
      if (a && (event.ctrlKey || event.metaKey)) {
        api.openLink(a.getAttribute('href') ?? '')
        return true
      }
      return false
    },
  },
})

// Suppress the change echo while loading content from disk.
let loading = false
editor.on('update', () => {
  if (!loading) api.changed(editor.getMarkdown())
  updateToolbar()
})
editor.on('selectionUpdate', updateToolbar)

function load(p: LoadPayload) {
  // Relative image paths (.attachments.<id>/x.png) resolve against the note's folder.
  base.href = p.baseUrl
  setColor(p.color)
  setOnTop(p.onTop)
  loading = true
  editor.commands.setContent(p.markdown, { contentType: 'markdown' })
  loading = false
}
api.onLoad(load)
api.onColor(setColor)
api.onOnTop(setOnTop)
void api.init().then(p => {
  if (p) load(p)
  editor.commands.focus('end')
})

function setColor(color: string) {
  document.documentElement.style.setProperty('--accent', color)
  for (const b of swatches.querySelectorAll<HTMLElement>('button')) {
    const current = b.dataset.color!.toLowerCase() === color.toLowerCase()
    b.setAttribute('aria-pressed', String(current))
    b.innerHTML = current ? icons.check : ''
  }
}

function sendImages(files: FileList | undefined | null): boolean {
  const images = Array.from(files ?? []).filter(f => f.type.startsWith('image/'))
  for (const file of images) {
    void file.arrayBuffer().then(async buf => {
      const res = await api.pasteImage(new Uint8Array(buf), file.type, file.name)
      if (res.src) editor.chain().focus().setImage({ src: res.src }).run()
      else showError(res.error ?? 'Could not add the image.')
    })
  }
  return images.length > 0
}

/** A selected image is copied as the picture itself (pasteable anywhere), not as HTML with a notes:// link. */
function copyImage(event: ClipboardEvent, cut: boolean): boolean {
  const sel = editor.state.selection
  if (!(sel instanceof NodeSelection) || sel.node.type.name !== 'image') return false
  event.preventDefault()
  toPng(new URL(sel.node.attrs.src, document.baseURI).href)
    .then(png => api.copyImage(png))
    .catch(() => showError('Could not copy the image.'))
  if (cut) editor.commands.deleteSelection()
  return true
}

/** Any format the note can show (PNG, JPEG, GIF, WebP, SVG) as PNG bytes; animations give their first frame. */
async function toPng(url: string): Promise<Uint8Array> {
  const img = await api.fetchImage(url)
  if (!img) throw new Error('fetch failed')
  // A blob: URL is same-origin, so the canvas stays readable (the notes:// <img> in the note would taint it).
  const blobUrl = URL.createObjectURL(new Blob([new Uint8Array(img.data)], { type: img.mime }))
  try {
    const el = new Image()
    el.src = blobUrl
    await el.decode()
    const canvas = document.createElement('canvas')
    canvas.width = el.naturalWidth || 300 // an SVG without width/height has no natural size
    canvas.height = el.naturalHeight || 150
    canvas.getContext('2d')!.drawImage(el, 0, 0, canvas.width, canvas.height)
    const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!png) throw new Error('encode failed')
    return new Uint8Array(await png.arrayBuffer())
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

function showError(message: string) {
  const el = document.getElementById('error')!
  el.textContent = message
  el.hidden = false
  setTimeout(() => (el.hidden = true), 5000)
}

// Toolbar
const emojiPop = document.getElementById('emoji-pop')!
const actions: Record<string, { run: () => unknown; active?: () => boolean }> = {
  heading: { run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(), active: () => editor.isActive('heading') },
  bold: { run: () => editor.chain().focus().toggleBold().run(), active: () => editor.isActive('bold') },
  italic: { run: () => editor.chain().focus().toggleItalic().run(), active: () => editor.isActive('italic') },
  strike: { run: () => editor.chain().focus().toggleStrike().run(), active: () => editor.isActive('strike') },
  bullets: { run: () => editor.chain().focus().toggleBulletList().run(), active: () => editor.isActive('bulletList') },
  tasks: { run: () => editor.chain().focus().toggleTaskList().run(), active: () => editor.isActive('taskList') },
  link: {
    run: async () => {
      const prev = editor.getAttributes('link').href ?? ''
      const href = await askLink(prev)
      if (href === null) return
      const chain = editor.chain().focus().extendMarkRange('link')
      if (href) chain.setLink({ href }).run()
      else chain.unsetLink().run()
    },
    active: () => editor.isActive('link'),
  },
  image: { run: () => (document.getElementById('file') as HTMLInputElement).click() },
  emoji: { run: () => emojiPop.toggleAttribute('hidden') },
}

for (const button of document.querySelectorAll<HTMLButtonElement>('#toolbar button')) {
  button.addEventListener('mousedown', e => e.preventDefault()) // keep editor selection
  button.addEventListener('click', () => void actions[button.dataset.action!].run())
}

/** Electron has no window.prompt: a small modal <dialog> instead. Resolves null on cancel. */
function askLink(value: string): Promise<string | null> {
  const dialog = document.getElementById('link-dialog') as HTMLDialogElement
  const input = dialog.querySelector('input')!
  input.value = value
  dialog.returnValue = ''
  dialog.showModal()
  input.select()
  return new Promise(resolve =>
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' ? input.value.trim() : null), { once: true }))
}

function updateToolbar() {
  for (const button of document.querySelectorAll<HTMLButtonElement>('#toolbar button'))
    button.classList.toggle('active', actions[button.dataset.action!].active?.() ?? false)
}

const fileInput = document.getElementById('file') as HTMLInputElement
fileInput.addEventListener('change', () => {
  sendImages(fileInput.files)
  fileInput.value = ''
})

const picker = document.querySelector('emoji-picker')!
picker.setAttribute('data-source', emojiData)
picker.addEventListener('emoji-click', (e: any) => {
  editor.chain().focus().insertContent(e.detail.unicode).run()
  emojiPop.hidden = true
})
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    emojiPop.hidden = true
    toggleMenu(false)
  }
  if (e.ctrlKey && e.key.toLowerCase() === 'n') api.newNote()
})
