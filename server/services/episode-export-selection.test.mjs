import test from 'node:test'
import assert from 'node:assert/strict'
import { selectExportClips } from './episode-export-selection.mjs'

test('selects only enabled clips in the requested episode draft order', () => {
  const clips = [
    { storyboardId: 11, sceneNo: 1, sourceType: 'video' },
    { storyboardId: 12, sceneNo: 1, sourceType: 'video' },
    { storyboardId: 21, sceneNo: 2, sourceType: 'video' },
  ]
  const selected = selectExportClips(clips, {
    videoClips: [
      { storyboardId: 21, enabled: true, order: 1 },
      { storyboardId: 11, enabled: true, order: 2 },
      { storyboardId: 12, enabled: false, order: 3 },
    ],
  })

  assert.deepEqual(selected.map((item) => item.storyboardId), [21, 11])
})

test('does not fall back to all project clips when an episode selection is empty', () => {
  assert.deepEqual(selectExportClips([{ storyboardId: 11 }], { videoClips: [] }), [])
})

test('episode export defaults to every confirmed video in storyboard order without a draft', () => {
  const clips = [
    { storyboardId: 21, sceneNo: 2, sortOrder: 2, shotNo: 2, sourceType: 'video', videoUrl: '/21.mp4' },
    { storyboardId: 11, sceneNo: 1, sortOrder: 2, shotNo: 2, sourceType: 'video', videoUrl: '/11.mp4' },
    { storyboardId: 12, sceneNo: 1, sortOrder: 1, shotNo: 1, sourceType: 'video', videoUrl: '/12.mp4' },
  ]

  const selected = selectExportClips(clips, {}, { episodeNo: 2 })

  assert.deepEqual(selected.map((item) => item.storyboardId), [12, 11, 21])
})

test('episode export rejects a missing confirmed shot even when there is no saved edit draft', () => {
  assert.throws(
    () => selectExportClips([
      { storyboardId: 11, sceneNo: 1, sortOrder: 1, sourceType: 'video', videoUrl: '/11.mp4' },
      { storyboardId: 12, sceneNo: 1, sortOrder: 2, sourceType: 'static', imageUrl: '/12.png' },
    ], {}, { episodeNo: 1 }),
    /整集导出缺少已确认视频：12/,
  )
})

test('episode export ignores a partial edit draft and preserves the complete episode', () => {
  const clips = [
    { storyboardId: 11, sceneNo: 1, sortOrder: 1, shotNo: 1, sourceType: 'video', videoUrl: '/11.mp4' },
    { storyboardId: 12, sceneNo: 1, sortOrder: 2, shotNo: 2, sourceType: 'video', videoUrl: '/12.mp4' },
    { storyboardId: 21, sceneNo: 2, sortOrder: 1, shotNo: 1, sourceType: 'video', videoUrl: '/21.mp4' },
  ]

  const selected = selectExportClips(clips, {
    videoClips: [
      { storyboardId: 21, enabled: true, order: 1 },
      { storyboardId: 11, enabled: false, order: 2 },
    ],
  }, { episodeNo: 1 })

  assert.deepEqual(selected.map((item) => item.storyboardId), [11, 12, 21])
})

test('episode export respects a complete manual edit order and enabled state', () => {
  const clips = [
    { storyboardId: 11, sceneNo: 1, sortOrder: 1, sourceType: 'video', videoUrl: '/11.mp4' },
    { storyboardId: 12, sceneNo: 1, sortOrder: 2, sourceType: 'video', videoUrl: '/12.mp4' },
    { storyboardId: 21, sceneNo: 2, sortOrder: 1, sourceType: 'video', videoUrl: '/21.mp4' },
  ]

  const selected = selectExportClips(clips, {
    videoClips: [
      { storyboardId: 21, enabled: true, order: 1 },
      { storyboardId: 11, enabled: false, order: 2 },
      { storyboardId: 12, enabled: true, order: 3 },
    ],
  }, { episodeNo: 1 })

  assert.deepEqual(selected.map((item) => item.storyboardId), [21, 12])
})

test('episode export fails explicitly when a manifest shot no longer has a confirmed video', () => {
  assert.throws(
    () => selectExportClips(
      [{ storyboardId: 11, sourceType: 'video', videoUrl: '/11.mp4' }],
      { videoClips: [{ storyboardId: 11 }, { storyboardId: 12 }] },
      { episodeNo: 1 },
    ),
    /整集导出缺少已确认视频：12/,
  )
})

test('episode export limits clips and complete manual ordering to the requested episode', () => {
  const clips = [
    { storyboardId: 11, episodeNo: 1, sceneNo: 1, sortOrder: 1, sourceType: 'video', videoUrl: '/11.mp4' },
    { storyboardId: 12, episodeNo: 1, sceneNo: 1, sortOrder: 2, sourceType: 'video', videoUrl: '/12.mp4' },
    { storyboardId: 21, episodeNo: 2, sceneNo: 1, sortOrder: 1, sourceType: 'video', videoUrl: '/21.mp4' },
  ]

  const selected = selectExportClips(clips, {
    videoClips: [
      { storyboardId: 21, enabled: true, order: 1 },
      { storyboardId: 12, enabled: true, order: 2 },
      { storyboardId: 11, enabled: false, order: 3 },
    ],
  }, { episodeNo: 1, storyboardIds: [11, 12] })

  assert.deepEqual(selected.map((item) => item.storyboardId), [12])
  assert.ok(selected.every((item) => item.episodeNo === 1))
})

test('episode export blocks when the explicit storyboard manifest includes a shot with no confirmed video row', () => {
  assert.throws(
    () => selectExportClips([
      { storyboardId: 11, episodeNo: 1, sourceType: 'video', videoUrl: '/11.mp4' },
    ], {}, { episodeNo: 1, storyboardIds: [11, 12] }),
    (error) => {
      assert.match(error.message, /整集导出缺少已确认视频：12/)
      assert.equal(error.code, 'episode-missing-confirmed-videos')
      assert.deepEqual(error.storyboardIds, [12])
      return true
    },
  )
})

test('episode export blocks when the requested episode has no storyboard manifest', () => {
  assert.throws(
    () => selectExportClips([], {}, { episodeNo: 3, storyboardIds: [] }),
    /当前集没有可导出的分镜清单/,
  )
})
