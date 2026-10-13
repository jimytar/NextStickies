import { renderIcons } from './icons'

const api = window.api
const cards = document.getElementById('cards')!
const search = document.getElementById('search') as HTMLInputElement
const status = document.getElementById('status')!

renderIcons()
document.getElementById('new')!.onclick = () => api.list.newNote()
document.getElementById('settings')!.onclick = () => api.list.settings()
document.getElementById('close')!.onclick = () => api.list.close()
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key.toLowerCase() === 'n') api.list.newNote()
})
search.oninput = () => void refresh()
api.list.onChanged(() => void refresh())
api.onStatus(s => (status.textContent = s))
void api.status().then(s => (status.textContent = s))

async function refresh() {
  const notes = await api.list.notes(search.value)
  cards.replaceChildren(...notes.map(n => {
    const card = document.createElement('article')
    card.className = 'card'
    card.tabIndex = 0
    card.style.setProperty('--c', n.color)
    const time = document.createElement('time')
    time.textContent = n.time
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
