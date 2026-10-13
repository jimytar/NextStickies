import StarterKit from '@tiptap/starter-kit'
import { TaskList, TaskItem } from '@tiptap/extension-list'
import Image from '@tiptap/extension-image'
import { Markdown } from '@tiptap/markdown'
import type { Extensions } from '@tiptap/core'

// Shared by the app editor and the round-trip tests so both serialize identically.
// Underline is off: markdown (and Nextcloud Notes) has no portable form for it.
export function noteExtensions(extra: Extensions = []): Extensions {
  return [
    StarterKit.configure({ underline: false, link: { openOnClick: false, autolink: true } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Image.configure({ inline: false }),
    Markdown,
    ...extra,
  ]
}
