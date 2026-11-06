import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8')

test('generated video persistence creates the tail-frame directory before ffmpeg', () => {
  const start = source.indexOf('async function persistGeneratedVideo')
  const end = source.indexOf('\nfunction exportResolution', start)
  const implementation = source.slice(start, end)

  assert.match(implementation, /await mkdir\(path\.dirname\(endFramePath\), \{ recursive: true \}\)/)
  assert.match(implementation, /if \(!\(await fileExists\(endFramePath\)\)\)/)
})
