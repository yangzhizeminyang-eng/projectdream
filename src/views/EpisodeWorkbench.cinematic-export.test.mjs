import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./EpisodeWorkbench.vue', import.meta.url), 'utf8')

test('episode cards surface cinematic quality blockers and do not label them completed', () => {
  assert.match(source, /status === 'blocked'/)
  assert.match(source, /成片质检阻止完成/)
  assert.match(source, /report\?\.issueShots/)
  assert.match(source, /report\?\.blockers/)
  assert.match(source, /按建议重新规划/)
  assert.match(source, /在剪辑页手动调整后重新导出/)
  assert.match(source, /path: '\/workspace\/edit'/)
  assert.match(source, /episodeNo: String\(episodeNo\)/)
  assert.match(source, /\.episode-delivery-error__actions \{ display: flex;/)
  assert.match(source, /flex-wrap: wrap;/)
})
