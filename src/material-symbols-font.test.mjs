import assert from 'node:assert/strict'
import test from 'node:test'
import { access, readFile } from 'node:fs/promises'

const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8')
const globalStyles = await readFile(new URL('./style.css', import.meta.url), 'utf8')

test('material symbols are self-hosted and do not depend on Google Fonts', async () => {
  assert.doesNotMatch(indexHtml, /fonts\.googleapis\.com\/css2\?family=Material\+Symbols/)
  const fontFace = globalStyles.match(/@font-face\s*\{[^}]+\}/)?.[0] || ''
  assert.match(fontFace, /font-family:\s*['"]Material Symbols Outlined['"];/)
  assert.match(fontFace, /src:\s*url\(['"]\/fonts\/material-symbols-outlined\.woff2['"]\)/)
  assert.match(fontFace, /font-display:\s*block;/)
  await access(new URL('../public/fonts/material-symbols-outlined.woff2', import.meta.url))
})
