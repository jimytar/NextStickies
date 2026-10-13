const api = window.api
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const result = $<HTMLDivElement>('result')
const password = $<HTMLInputElement>('password')

void api.settings.get().then(s => {
  $<HTMLInputElement>('server').value = s.serverUrl
  $<HTMLInputElement>('user').value = s.user
  $<HTMLInputElement>('folder').value = s.folder
  password.placeholder = s.hasPassword ? 'Saved — leave empty to keep' : ''
  $<HTMLInputElement>('login').checked = s.startWithLogin
  $<HTMLInputElement>('minimized').checked = s.startMinimized
  $<HTMLInputElement>('confirm-delete').checked = s.confirmDelete
  $('login-label').textContent = s.loginLabel
  $('version').textContent = `NextStickies ${s.version}`
})
void api.status().then(s => (result.textContent = s))
api.onStatus(s => (result.textContent = s))

$<HTMLFormElement>('form').onsubmit = async e => {
  e.preventDefault()
  const save = $<HTMLButtonElement>('save')
  save.disabled = true
  result.textContent = 'Connecting…'
  try {
    const res = await api.settings.save({
      serverUrl: $<HTMLInputElement>('server').value,
      user: $<HTMLInputElement>('user').value,
      password: password.value,
      folder: $<HTMLInputElement>('folder').value,
      startWithLogin: $<HTMLInputElement>('login').checked,
      startMinimized: $<HTMLInputElement>('minimized').checked,
      confirmDelete: $<HTMLInputElement>('confirm-delete').checked,
    })
    result.textContent = res.message
    if (res.ok) {
      password.value = ''
      password.placeholder = 'Saved — leave empty to keep'
    }
  } finally {
    save.disabled = false
  }
}
$('sync').onclick = () => api.syncNow()
$('close').onclick = () => window.close()
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') window.close()
})
