import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

test('public mock asset placeholder is a real PNG file', async () => {
  const filePath = path.join(process.cwd(), 'public', 'images', 'login-hero-clean.png')
  const bytes = await readFile(filePath)

  assert.ok(bytes.length > 8)
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
})
