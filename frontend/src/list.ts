import { api } from './api'
import { renderIcons } from './icons'

const cards = document.getElementById('cards')!
const search = document.getElementById('search') as HTMLInputElement
const status = document.getElementById('status')!
const syncBtn = document.getElementById('sync')!

renderIcons()
document.getElementById('new')!.onclick = () => api.list.newNote()
syncBtn.onclick = () => api.syncNow()
document.getElementById('settings')!.onclick = () => api.list.settings()
document.getElementById('close')!.onclick = () => api.list.close()
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key.toLowerCase() === 'n') api.list.newNote()
})
search.oninput = () => void refresh()
api.list.onChanged(() => void refresh())
function showStatus(s: string) {
  status.textContent = s
  syncBtn.classList.toggle('spinning', s === 'Syncing…')
}
api.onStatus(showStatus)
void api.status().then(showStatus)

async function refresh() {
  const notes = await api.list.notes(search.value)
  cards.replaceChildren(...notes.map(n => {
    const card = document.createElement('article')
    card.className = 'card'
    card.tabIndex = 0
    card.style.setProperty('--c', n.color)
    const time = document.createElement('time')
    time.textContent = formatTime(n.modified)
    const text = document.createElement('p')
    text.textContent = n.preview
    const del = document.createElement('button')
    del.className = 'icon-btn del'
    del.title = 'Delete note'
    del.dataset.icon = 'close'
    del.onclick = e => {
      e.stopPropagation()
      api.list.remove(n.id)
    }
    card.append(del, time, text)
    card.onclick = () => api.list.open(n.id)
    card.onkeydown = e => {
      if (e.key === 'Enter') api.list.open(n.id)
      if (e.key === 'Delete') api.list.remove(n.id)
    }
    return card
  }))
  renderIcons(cards)
}
void refresh()

/** Time today, else day and month, in the user's locale. */
function formatTime(ms: number): string {
  const d = new Date(ms)
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}
