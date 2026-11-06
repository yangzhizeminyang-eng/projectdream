import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('character re-parse can repair an existing explicit gender value', async () => {
  const source = await readFile(new URL('./index.mjs', import.meta.url), 'utf8')
  assert.match(
    source,
    /gender\s*=\s*COALESCE\(NULLIF\(\?,\s*''\),\s*gender\)/,
    're-parse must persist the normalized gender returned by the parser when present',
  )
})

test('asset re-parse refreshes persisted character and scene prompt snapshots', async () => {
  const source = await readFile(new URL('./index.mjs', import.meta.url), 'utf8')
  assert.match(source, /SET prompt_text = \?,\s*turnaround_prompt_text = \?,/)
  assert.match(source, /SET prompt_text = \?,\s*environment_prompt_text = \?,\s*appearance_label = \?,/)
})

test('asset re-parse persists the Agent costume baseline instead of dropping it', async () => {
  const source = await readFile(new URL('./index.mjs', import.meta.url), 'utf8')
  assert.match(source, /costume\s*=\s*COALESCE\(NULLIF\(\?, ''\), costume\)/)
  assert.match(source, /appearance, costume, voice_setting/)
  assert.match(source, /normalizeCharacterCostume\(item\)/)
})
