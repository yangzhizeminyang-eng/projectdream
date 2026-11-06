import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
)

test('API and Worker load the shared COS production environment', () => {
  for (const scriptName of ['server', 'worker']) {
    assert.match(
      packageJson.scripts[scriptName],
      /--env-file=\.env\.local --env-file-if-exists=\.env\.production/,
    )
  }
})
