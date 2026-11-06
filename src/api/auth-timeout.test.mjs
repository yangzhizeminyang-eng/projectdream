import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

test('authentication requests put a hard timeout around each network attempt', async () => {
  const source = await readFile(new URL('./auth.ts', import.meta.url), 'utf8')

  assert.match(source, /AbortSignal\.timeout\(API_REQUEST_TIMEOUT_MS\)/)
  assert.match(source, /API_REQUEST_TIMEOUT_MS\s*=\s*12_000/)
})
