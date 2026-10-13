import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync } from 'node:fs'

// Bundles the three pages into dist/, which the Go binary embeds (main.go).
const out = 'dist'
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
await build({
  entryPoints: ['src/sticky.ts', 'src/list.ts', 'src/settings.ts'],
  outdir: out, bundle: true, minify: true, format: 'iife', target: ['chrome120', 'safari16'], logLevel: 'warning',
})
for (const f of ['sticky.html', 'list.html', 'settings.html', 'common.css', 'editor.css', 'list.css']) cpSync(`src/${f}`, `${out}/${f}`)
cpSync('node_modules/emoji-picker-element-data/en/emojibase/data.json', `${out}/emoji-data.json`)
