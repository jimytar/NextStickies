/** Windows Sticky Notes-style delete confirmation. Resolves true when the note should be deleted. */
export async function confirmDelete(): Promise<boolean> {
  if (!(await window.api.confirmDelete.get())) return true
  const dialog = document.createElement('dialog')
  dialog.className = 'confirm'
  dialog.innerHTML = `<form method="dialog">
      <p>Do you want to delete this note?</p>
      <label><input type="checkbox"> Don't ask me again</label>
      <menu><button class="primary" value="delete">Delete</button><button class="text-btn" value="keep" autofocus>Keep</button></menu>
    </form>`
  document.body.append(dialog)
  dialog.showModal()
  await new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }))
  dialog.remove()
  const ok = dialog.returnValue === 'delete'
  if (ok && dialog.querySelector('input')!.checked) window.api.confirmDelete.set(false)
  return ok
}
