// Inline SVG icons (Segoe MDL2 Assets exists only on Windows).
const svg = (d: string) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">${d}</svg>`
export const icons = {
  plus: svg('<path d="M8 2.5v11M2.5 8h11"/>'),
  close: svg('<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>'),
  more: svg('<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>'),
  gear: svg('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>'),
  sync: svg('<path d="M13 8a5 5 0 0 1-8.6 3.5M3 8a5 5 0 0 1 8.6-3.5"/><path d="M11.9 1.9v2.8H9.1M4.1 14.1v-2.8h2.8"/>'),
  pin: svg('<path d="M6 2h4l-.6 4.2 2.6 2.3H4l2.6-2.3z" stroke-linejoin="round"/><path d="M8 8.5V14"/>'),
  check: svg('<path d="M3 8.5l3.2 3L13 4.5"/>'),
  list: svg('<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7"/>'),
  trash: svg('<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5"/>'),
  search: svg('<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4l3.6 3.6"/>'),
}

/** Fills every [data-icon] element with its SVG. */
export function renderIcons(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>('[data-icon]')) el.innerHTML = icons[el.dataset.icon as keyof typeof icons]
}
