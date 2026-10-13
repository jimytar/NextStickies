// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import { noteExtensions } from '../src/renderer/extensions'

function roundtrip(md: string): string {
  const editor = new Editor({ extensions: noteExtensions(), content: md, contentType: 'markdown' })
  const out = editor.getMarkdown()
  editor.destroy()
  return out
}

const samples: Record<string, string> = {
  heading: '## 🧭 Основна цел',
  inline: 'Text with **bold**, *italic*, ~~strike~~ and `code`.',
  bullets: '- Изграждане на чиста мускулна маса\n- Намаляване на мазнините\n- Повече енергия',
  ordered: '1. one\n2. two',
  tasks: '- [ ] todo\n- [x] done',
  image: '![](.attachments.12345/image.png)',
  link: '[Nextcloud](https://nextcloud.com)',
  rule: 'above\n\n---\n\nbelow',
  emoji: 'Plan 🗓️ ✅ 👍🏽',
  mixed: '# Title\n\n**Храни:** реални, прости\n\n- **Вода:** 2 литра\n\n- [ ] buy milk',
}

describe('markdown round-trip', () => {
  // Some characters get escaped on first save (`~` → `\\~`); renders identically, must not drift afterwards.
  it('escapes are stable', () => {
    const once = roundtrip('~2 литра, 5 * 3, a_b_c')
    expect(roundtrip(once)).toBe(once)
  })

  for (const [name, md] of Object.entries(samples)) {
    it(name, () => {
      const once = roundtrip(md)
      expect(once.trim()).toBe(md.trim())
      expect(roundtrip(once)).toBe(once) // stable: no drift on repeated saves
    })
  }
})
