import { Editor } from '@tiptap/core'
import Placeholder from '@tiptap/extension-placeholder'
import 'emoji-picker-element'
import { noteExtensions } from './extensions'
import { renderIcons } from './icons'
import type { LoadPayload } from './api'

const api = window.api.sticky
// Resolved before <base> is pointed at the note's folder for images.
const emojiData = new URL('emoji-data.json', location.href).href
const base = document.head.appendChild(document.createElement('base'))

renderIcons()
document.getElementById('new')!.onclick = () => api.newNote()
document.getElementById('menu')!.onclick = () => api.menu()
document.getElementById('close')!.onclick = () => api.close()

const editor = new Editor({
  element: document.getElementById('editor')!,
  extensions: noteExtensions([Placeholder.configure({ placeholder: 'Take a note…' })]),
  editorProps: {
    handlePaste: (_view, event) => sendImages(event.clipboardData?.files),
    handleDrop: (_view, event) => sendImages((event as DragEvent).dataTransfer?.files),
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
  loading = true
  editor.commands.setContent(p.markdown, { contentType: 'markdown' })
  loading = false
}
api.onLoad(load)
api.onColor(setColor)
void api.init().then(p => {
  if (p) load(p)
  editor.commands.focus('end')
})

function setColor(color: string) {
  document.documentElement.style.setProperty('--accent', color)
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
  if (e.key === 'Escape') emojiPop.hidden = true
  if (e.ctrlKey && e.key.toLowerCase() === 'n') api.newNote()
})
