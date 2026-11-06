import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./index.mjs', import.meta.url), 'utf8')

test('project list selects export cover first and confirmed storyboard frame as fallback', () => {
  assert.match(source, /latest\.cover_url AS latest_export_cover_url/)
  assert.match(source, /WHERE sc\.project_id = p\.id AND ia\.status = 'confirmed'/)
  assert.match(source, /AS latest_project_frame_url/)
  assert.match(source, /coverUrl: row\.latest_export_cover_url \|\| row\.latest_project_frame_url \|\| null/)
})
