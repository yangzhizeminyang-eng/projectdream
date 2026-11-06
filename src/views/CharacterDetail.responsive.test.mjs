import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const sourcePath = new URL('./CharacterDetail.vue', import.meta.url)

test('character detail header keeps the mobile breadcrumb readable', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.match(source, /flex-col items-stretch[\s\S]*sm:flex-row sm:items-center/)
  assert.match(source, /min-w-0 flex flex-1 items-center gap-2/)
  assert.match(source, /class="shrink-0 whitespace-nowrap">角色库<\/span>/)
  assert.match(source, /class="truncate text-primary"/)
})
