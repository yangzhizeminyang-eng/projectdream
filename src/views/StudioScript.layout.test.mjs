import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./StudioScript.vue', import.meta.url), 'utf8')

test('script editor keeps the agent dock bounded on desktop', () => {
  assert.match(source, /grid-template-columns:minmax\(0,1fr\) minmax\(300px,clamp\(300px,24vw,340px\)\)/)
  assert.match(source, /\.agent-dock\s*\{[^}]*min-width:0/)
})

test('manuscript presentation distinguishes action and dialogue without rewriting stored script text', () => {
  assert.match(source, /function isScriptDialogue\(block: string\)/)
  assert.match(source, /function isScriptAction\(block: string\)/)
  assert.match(source, /script-line-dialogue/)
  assert.match(source, /script-line-action/)
  assert.match(source, /cleanScriptBlock\(block\)/)
})
