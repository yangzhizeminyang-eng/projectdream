import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAtempoFilter,
  buildBroadcastVisualCropFilter,
  buildLegacySceneAudioOffsets,
  buildMediaTimeline,
  buildSpeechVisualSegments,
  hasStoryboardTimelineEntry,
  resolveMediaStartSeconds,
  resolveRequiredSpeechDuration,
} from './media-timeline.mjs'

test('builds a timeline from enabled storyboard clips', () => {
  const timeline = buildMediaTimeline([
    { storyboardId: 10, sceneId: 1, durationSeconds: 4 },
    { storyboardId: 11, sceneId: 1, durationSeconds: 3, enabled: false },
    { storyboardId: 12, sceneId: 2, durationSeconds: 2 },
  ])

  assert.equal(timeline.durationSeconds, 6)
  assert.deepEqual(timeline.byStoryboardId.get(12), {
    index: 2,
    storyboardId: 12,
    sceneId: 2,
    startSeconds: 4,
    endSeconds: 6,
    durationSeconds: 2,
  })
})

test('prefers storyboard placement and preserves an explicit offset', () => {
  const timeline = buildMediaTimeline([
    { storyboardId: 10, sceneId: 1, durationSeconds: 4 },
    { storyboardId: 11, sceneId: 1, durationSeconds: 3 },
  ])
  const placement = resolveMediaStartSeconds(
    { storyboardId: 11, sceneId: 1, startOffsetSeconds: 0.25 },
    timeline,
  )

  assert.equal(placement.startSeconds, 4.25)
  assert.equal(placement.clipEndSeconds, 7)
})

test('sequentially places legacy scene audio instead of overlapping it', () => {
  const timeline = buildMediaTimeline([
    { storyboardId: 10, sceneId: 1, durationSeconds: 4 },
    { storyboardId: 11, sceneId: 1, durationSeconds: 4 },
  ])
  const placements = buildLegacySceneAudioOffsets(
    [
      { id: 1, trackType: 'dialogue', sceneId: 1, durationSeconds: 1.5 },
      { id: 2, trackType: 'dialogue', sceneId: 1, durationSeconds: 1.25 },
    ],
    timeline,
  )

  assert.equal(placements.get(1).startSeconds, 0)
  assert.equal(placements.get(2).startSeconds, 1.5)
})

test('creates a bounded atempo chain for overlong speech', () => {
  assert.equal(buildAtempoFilter(12, 3), 'atempo=2,atempo=2')
  assert.equal(buildAtempoFilter(3, 4), '')
})

test('strict storyboard audio only accepts clips present in the final timeline', () => {
  const timeline = buildMediaTimeline([
    { storyboardId: 11, sceneId: 1, durationSeconds: 4 },
  ])

  assert.equal(hasStoryboardTimelineEntry({ storyboardId: 11 }, timeline), true)
  assert.equal(hasStoryboardTimelineEntry({ storyboardId: 12 }, timeline), false)
  assert.equal(hasStoryboardTimelineEntry({ sceneId: 1 }, timeline), false)
})

test('speech duration does not add a phantom second at zero offset', () => {
  assert.equal(resolveRequiredSpeechDuration({ durationSeconds: 5, startOffsetSeconds: 0 }), 5.18)
  assert.equal(resolveRequiredSpeechDuration({ durationSeconds: 5, startOffsetSeconds: 1.25 }), 6.43)
})

test('cuts a broadcast visual segment instead of showing the talking character for narration', () => {
  assert.deepEqual(
    buildSpeechVisualSegments({
      clip: {
        storyboardId: 186,
        sourceType: 'video',
        durationSeconds: 3,
        broadcastVisual: { type: 'source-video-crop', preset: 'left-control-panel' },
      },
      audioTracks: {
        narration: [{
          id: 171,
          storyboardId: 186,
          startOffsetSeconds: 1.1,
          durationSeconds: 0.56,
        }],
      },
    }),
    [
      {
        startSeconds: 0,
        endSeconds: 1.1,
        visualSource: 'original-video',
        speechTrack: null,
        audioId: null,
      },
      {
        startSeconds: 1.1,
        endSeconds: 1.66,
        visualSource: 'broadcast-device',
        visualPreset: 'left-control-panel',
        speechTrack: 'narration',
        audioId: 171,
      },
      {
        startSeconds: 1.66,
        endSeconds: 3,
        visualSource: 'original-video',
        speechTrack: null,
        audioId: null,
      },
    ],
  )
})

test('uses the left control panel as the default broadcast visual crop', () => {
  assert.equal(
    buildBroadcastVisualCropFilter(),
    'crop=trunc(iw*0.32/2)*2:trunc(ih*0.96/2)*2:min(iw-ow\\,max(0\\,trunc(iw*0.47*(t-0.8)/2)*2)):trunc(ih*0.02/2)*2',
  )
})

test('blocks a video narration when no non-face visual source is configured', () => {
  assert.throws(
    () => buildSpeechVisualSegments({
      clip: {
        storyboardId: 186,
        sourceType: 'video',
        durationSeconds: 3,
      },
      audioTracks: {
        narration: [{
          id: 171,
          storyboardId: 186,
          startOffsetSeconds: 1.1,
          durationSeconds: 0.56,
        }],
      },
    }),
    (error) => error?.code === 'narration-visual-source-missing',
  )
})
