import assert from 'node:assert/strict'
import test from 'node:test'

import { buildClipRehearsalReport, filterScenesForEpisode } from './clip-rehearsal.mjs'

const shot = (overrides = {}) => ({
  storyboardId: 10,
  sceneId: 3,
  shotNo: '01',
  visualPrompt: '@唐宁 @审讯室 坐在桌前，压住呼吸。',
  imageUrl: 'https://cdn.test/shot-01-start.jpg',
  endImageUrl: 'https://cdn.test/shot-01-end.jpg',
  assetReference: {
    sceneAssetId: 7,
    scenePanoramaVersion: 2,
    sceneViewSetVersion: 3,
    sceneViewKey: 'front',
  },
  ...overrides,
})

test('clip rehearsal accepts a fully referenced shot and does not create video jobs', () => {
  const report = buildClipRehearsalReport({ sceneId: 3, shots: [shot()] })

  assert.equal(report.ready, true)
  assert.equal(report.shotCount, 1)
  assert.equal(report.videoJobsCreated, 0)
  assert.deepEqual(report.shots[0].blockers, [])
  assert.equal(report.shots[0].keyframes.start, 'ready')
  assert.equal(report.shots[0].keyframes.end, 'ready')
})

test('clip rehearsal blocks a shot with missing prompt, scene baseline, or keyframes', () => {
  const report = buildClipRehearsalReport({
    sceneId: 3,
    shots: [shot({
      visualPrompt: '',
      imageUrl: '',
      endImageUrl: '',
      assetReference: { sceneAssetId: 7, scenePanoramaVersion: 2 },
    })],
  })

  assert.equal(report.ready, false)
  assert.match(report.shots[0].blockers.join(' '), /镜头提示词/)
  assert.match(report.shots[0].blockers.join(' '), /起始关键帧/)
  assert.match(report.shots[0].blockers.join(' '), /结束关键帧/)
  assert.doesNotMatch(report.shots[0].blockers.join(' '), /场景角度/)
})

test('clip rehearsal accepts a confirmed panorama without a nine-grid angle', () => {
  const report = buildClipRehearsalReport({
    sceneId: 3,
    shots: [shot({
      assetReference: { sceneAssetId: 7, scenePanoramaVersion: 2 },
    })],
  })

  assert.equal(report.ready, true)
})

test('clip rehearsal checks inter-shot tail to start continuity within one scene', () => {
  const report = buildClipRehearsalReport({
    sceneId: 3,
    shots: [
      shot(),
      shot({ storyboardId: 11, shotNo: '02', imageUrl: 'https://cdn.test/shot-02-start.jpg', endImageUrl: '' }),
    ],
  })

  assert.equal(report.transitions[0].status, 'ready-for-review')
  assert.equal(report.transitions[0].hasPreviousTail, true)
  assert.equal(report.transitions[0].hasNextStart, true)
  assert.equal(report.shots[1].keyframes.end, 'missing')
})

test('clip rehearsal rejects empty or cross-clip selections', () => {
  assert.throws(() => buildClipRehearsalReport({ sceneId: 3, shots: [] }), /没有分镜/)
  assert.throws(() => buildClipRehearsalReport({ sceneId: 3, shots: [shot(), shot({ sceneId: 4 })] }), /同一片段/)
})

test('episode selection excludes scenes from other episodes', () => {
  const scenes = [
    { id: 1, episodeNo: 1 },
    { id: 2, episode_no: 2 },
    { id: 3 },
  ]
  assert.deepEqual(filterScenesForEpisode(scenes, 1).map((scene) => scene.id), [1, 3])
  assert.deepEqual(filterScenesForEpisode(scenes, 2).map((scene) => scene.id), [2])
  assert.equal(filterScenesForEpisode(scenes).length, 3)
})
