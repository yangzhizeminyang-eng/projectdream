import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('character asset-pack requests bypass the camera-view prompt builder', () => {
  const source = fs.readFileSync(new URL('./index.mjs', import.meta.url), 'utf8')
  assert.match(source, /!\['single', 'character-asset-pack'\]\.includes\(requestedViewType\)/u)
})
