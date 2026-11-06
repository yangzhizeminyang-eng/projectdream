import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const serverSource = await readFile(new URL('./index.mjs', import.meta.url), 'utf8')

test('project asset listing keeps archived assets out of the active library', () => {
  assert.match(serverSource, /FROM characters[\s\S]+WHERE project_id = \? AND status <> 'archived'/)
  assert.match(serverSource, /FROM image_assets[\s\S]+WHERE sc\.project_id = \? AND ia\.status <> 'archived'/)
  assert.match(serverSource, /FROM video_assets[\s\S]+WHERE sc\.project_id = \? AND va\.status <> 'archived'/)
  assert.match(serverSource, /FROM audio_assets[\s\S]+WHERE aa\.project_id = \? AND aa\.status <> 'archived'/)
})

test('project asset library exposes an owner-scoped archive endpoint', () => {
  assert.match(
    serverSource,
    /const projectAssetArchiveMatch = pathname\.match/,
  )
  assert.match(serverSource, /canArchiveProjectAsset\(/)
  assert.match(serverSource, /项目资产不存在或无权访问/)
  assert.match(serverSource, /已确认或定稿资产不能直接归档/)
})
