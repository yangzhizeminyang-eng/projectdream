import assert from 'node:assert/strict'
import test from 'node:test'
import { buildEpisodeClips } from './episode-clips.mjs'

test('groups episode shots by scene while preserving empty clips and duration', () => {
  const clips = buildEpisodeClips([
    { id: 10, sceneNo: 1, title: '审讯室', location: '审讯室' },
    { id: 11, sceneNo: 2, title: '走廊' },
  ], [
    { storyboardId: 101, sceneId: 10, shotNo: '02', durationSeconds: 4 },
    { storyboardId: 100, sceneId: 10, shotNo: '01', durationSeconds: 3 },
  ])

  assert.equal(clips.length, 2)
  assert.deepEqual(clips[0].shots.map((shot) => shot.shotNo), ['01', '02'])
  assert.equal(clips[0].shotCount, 2)
  assert.equal(clips[0].durationSeconds, 7)
  assert.equal(clips[1].title, '走廊')
  assert.equal(clips[1].shotCount, 0)
})

test('rejects a storyboard checkpoint with no persisted shots', async () => {
  const { resolveStoryboardStageResult } = await import('../../server/services/agent/storyboard-stage-result.mjs')
  const result = resolveStoryboardStageResult({ sceneCount: 5, shotCount: 0, storyboardIds: [] })

  assert.equal(result.status, 'blocked')
  assert.equal(result.blockers[0].code, 'storyboard-empty')
})

test('allows storyboard approval only when at least one shot was persisted', async () => {
  const { resolveStoryboardStageResult } = await import('../../server/services/agent/storyboard-stage-result.mjs')
  const result = resolveStoryboardStageResult({ sceneCount: 2, shotCount: 3, storyboardIds: [41, 42, 43] })

  assert.equal(result.status, 'waiting_approval')
  assert.equal(result.outputSnapshot.shotCount, 3)
  assert.equal(result.outputSnapshot.storyboardIds.length, 3)
})

test('blocks storyboard approval when fewer IDs were persisted than the reported shot count', async () => {
  const { resolveStoryboardStageResult } = await import('../../server/services/agent/storyboard-stage-result.mjs')
  const result = resolveStoryboardStageResult({ sceneCount: 1, shotCount: 2, storyboardIds: [41] })

  assert.equal(result.status, 'blocked')
  assert.equal(result.outputSnapshot.shotCount, 0)
})
