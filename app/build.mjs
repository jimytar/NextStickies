import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync } from 'node:fs'

// Bundles main (Node), preload (sandboxed CJS) and the three renderer pages into dist/.
const out = 'dist'
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const common = { bundle: true, minify: true, sourcemap: false, logLevel: 'warning' }
await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: `${out}/main.cjs`, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/preload.ts'], outfile: `${out}/preload.cjs`, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/renderer/sticky.ts', 'src/renderer/list.ts', 'src/renderer/settings.ts'], outdir: out, format: 'iife', target: 'chrome130' }),
])
for (const f of ['sticky.html', 'list.html', 'settings.html', 'common.css', 'editor.css', 'list.css']) cpSync(`src/renderer/${f}`, `${out}/${f}`)
cpSync('node_modules/emoji-picker-element-data/en/emojibase/data.json', `${out}/emoji-data.json`)
cpSync('build/icon.png', `${out}/icon.png`)
