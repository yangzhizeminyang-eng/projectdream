import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyFinalEditDraftToAudioTracks,
  applyFinalEditDraftToVideoItems,
  normalizeFinalEditOverlayClips,
  partitionFinalEditAudioTracks,
  resolveFinalEditAudioWarning,
  normalizeFinalEditDraft,
  selectFinalEditDraftForEpisode,
  saveFinalEditDraftForEpisode,
} from './final-edit-draft.mjs'

const contextVideoItems = [
  {
    id: 101,
    storyboardId: 11,
    sceneId: 1,
    durationSeconds: 5,
    sourceDurationSeconds: 5,
    videoUrl: 'https://example.com/v101.mp4',
    versionNo: 1,
  },
  {
    id: 102,
    storyboardId: 12,
    sceneId: 1,
    durationSeconds: 4,
    sourceDurationSeconds: 4,
    videoUrl: 'https://example.com/v102.mp4',
    versionNo: 1,
  },
]

test('normalizes non-destructive trim and replacement choices against current clips', () => {
  const draft = normalizeFinalEditDraft({
    videoClips: [
      {
        storyboardId: 11,
        enabled: true,
        order: 2,
        videoAssetId: 222,
        trimStartSeconds: 1.2,
        trimEndSeconds: 4.7,
      },
      {
        storyboardId: 999,
        enabled: true,
        order: 1,
        videoAssetId: 333,
        trimStartSeconds: 0,
        trimEndSeconds: 10,
      },
      {
        storyboardId: 12,
        enabled: false,
        order: 1,
        trimStartSeconds: -4,
        trimEndSeconds: 99,
      },
    ],
  }, {
    videoItems: contextVideoItems,
    audioTracks: {},
  })

  assert.deepEqual(draft.videoClips, [
    {
      storyboardId: 11,
      enabled: true,
      order: 2,
      videoAssetId: 222,
      trimStartSeconds: 1.2,
      trimEndSeconds: 4.7,
    },
    {
      storyboardId: 12,
      enabled: false,
      order: 1,
      videoAssetId: null,
      trimStartSeconds: 0,
      trimEndSeconds: 4,
    },
  ])
})

test('stores episode drafts independently while preserving legacy and other episode edits', () => {
  const legacyDraft = {
    videoClips: [{ storyboardId: 91, enabled: true, order: 1 }],
    audioMix: { music: { enabled: true, volume: 80 } },
  }
  const episodeOneDraft = { videoClips: [{ storyboardId: 11, enabled: false, order: 1 }] }
  const episodeTwoDraft = { videoClips: [{ storyboardId: 21, enabled: true, order: 1 }] }

  const afterEpisodeOne = saveFinalEditDraftForEpisode(legacyDraft, 1, episodeOneDraft)
  const afterEpisodeTwo = saveFinalEditDraftForEpisode(afterEpisodeOne, 2, episodeTwoDraft)

  assert.deepEqual(selectFinalEditDraftForEpisode(afterEpisodeTwo, 1), episodeOneDraft)
  assert.deepEqual(selectFinalEditDraftForEpisode(afterEpisodeTwo, 2), episodeTwoDraft)
  assert.deepEqual(selectFinalEditDraftForEpisode(afterEpisodeTwo, 3), legacyDraft)
  assert.deepEqual(selectFinalEditDraftForEpisode(afterEpisodeTwo), legacyDraft)
})

test('saving the project-wide legacy draft does not discard saved episode overrides', () => {
  const episodeDrafts = {
    '1': { videoClips: [{ storyboardId: 11, enabled: false, order: 1 }] },
  }
  const updatedLegacyDraft = { videoClips: [{ storyboardId: 91, enabled: true, order: 1 }] }

  const saved = saveFinalEditDraftForEpisode({ ...updatedLegacyDraft, episodeDrafts }, null, updatedLegacyDraft)

  assert.deepEqual(saved, { ...updatedLegacyDraft, episodeDrafts })
  assert.deepEqual(selectFinalEditDraftForEpisode(saved, 1), episodeDrafts['1'])
})

test('applies replacement video metadata without overwriting the source candidate', () => {
  const clips = applyFinalEditDraftToVideoItems(contextVideoItems, {
    videoClips: [
      {
        storyboardId: 11,
        enabled: true,
        order: 1,
        videoAssetId: 222,
        trimStartSeconds: 0.5,
        trimEndSeconds: 3.5,
      },
    ],
  }, new Map([
    [222, {
      id: 222,
      storyboardId: 11,
      videoUrl: 'https://example.com/candidate-222.mp4',
      storageKey: 'videos/storyboard-11/candidate-222.mp4',
      thumbnailUrl: 'https://example.com/candidate-222.jpg',
      durationSeconds: 6,
      sourceType: 'generated_video',
      versionNo: 5,
      status: 'candidate',
    }],
  ]))

  assert.equal(clips[0].id, 222)
  assert.equal(clips[0].originalVideoAssetId, 101)
  assert.equal(clips[0].videoAssetId, 222)
  assert.equal(clips[0].videoUrl, 'https://example.com/candidate-222.mp4')
  assert.equal(clips[0].storageKey, 'videos/storyboard-11/candidate-222.mp4')
  assert.equal(clips[0].sourceDurationSeconds, 6)
  assert.equal(clips[0].durationSeconds, 3)
  assert.equal(clips[0].trimStartSeconds, 0.5)
  assert.equal(clips[0].trimEndSeconds, 3.5)
  assert.equal(clips[0].nonDestructiveEdit.replacedFromVideoAssetId, 101)
})

test('normalizes per-clip audio alignment while preserving source audio assets', () => {
  const audioTracks = {
    dialogue: [
      { id: 501, storyboardId: 11, startOffsetSeconds: 0, durationSeconds: 1.4, volume: 100 },
      { id: 502, storyboardId: 12, startOffsetSeconds: 0, durationSeconds: 2, volume: 100 },
    ],
    narration: [],
    music: [],
    sfx: [],
  }

  const aligned = applyFinalEditDraftToAudioTracks(audioTracks, {
    audioClips: [
      { audioId: 501, enabled: true, startOffsetSeconds: 0.65, volume: 72 },
      { audioId: 502, enabled: false, startOffsetSeconds: 9, volume: 110 },
    ],
  })

  assert.equal(aligned.dialogue[0].id, 501)
  assert.equal(aligned.dialogue[0].startOffsetSeconds, 0.65)
  assert.equal(aligned.dialogue[0].volume, 72)
  assert.equal(aligned.dialogue[0].nonDestructiveEdit.audioAssetPreserved, true)
  assert.equal(aligned.dialogue[1].enabled, false)
  assert.equal(aligned.dialogue[1].volume, 100)
})

test('keeps speech out of the playable timeline until its storyboard has a matching video clip', () => {
  const result = partitionFinalEditAudioTracks(
    {
      dialogue: [
        { id: 501, storyboardId: 11, durationSeconds: 1.4 },
        { id: 502, storyboardId: 99, durationSeconds: 2 },
      ],
      narration: [
        { id: 503, storyboardId: 98, durationSeconds: 2.2 },
      ],
      music: [
        { id: 504, storyboardId: null, durationSeconds: 12 },
      ],
      sfx: [
        { id: 505, storyboardId: 99, durationSeconds: 0.4 },
      ],
    },
    [{ storyboardId: 11 }],
  )

  assert.deepEqual(result.tracks.dialogue.map((item) => item.id), [501])
  assert.deepEqual(result.tracks.narration, [])
  assert.deepEqual(result.tracks.music.map((item) => item.id), [504])
  assert.deepEqual(result.tracks.sfx.map((item) => item.id), [505])
  assert.deepEqual(result.unmatched.map((item) => [item.trackType, item.id, item.storyboardId]), [
    ['dialogue', 502, 99],
    ['narration', 503, 98],
  ])
})

test('points creators at the matching shot instead of asking for audio that already exists', () => {
  const waitingForShot = resolveFinalEditAudioWarning({
    availableAudioTrackCount: 0,
    enabledAudioTrackCount: 0,
    unmatchedAudioCount: 1,
  })
  assert.equal(waitingForShot, null)

  const missing = resolveFinalEditAudioWarning({
    availableAudioTrackCount: 0,
    enabledAudioTrackCount: 0,
    unmatchedAudioCount: 0,
  })
  assert.equal(missing.code, 'missing-audio')

  const disabled = resolveFinalEditAudioWarning({
    availableAudioTrackCount: 2,
    enabledAudioTrackCount: 0,
    unmatchedAudioCount: 1,
  })
  assert.equal(disabled.code, 'all-audio-disabled')

  const healthy = resolveFinalEditAudioWarning({
    availableAudioTrackCount: 2,
    enabledAudioTrackCount: 2,
    unmatchedAudioCount: 0,
  })
  assert.equal(healthy, null)
})

test('keeps picture-in-picture overlays on their own track without touching the main sequence', () => {
  const overlays = normalizeFinalEditOverlayClips(
    [
      {
        clipId: 'pip-1',
        storyboardId: 11,
        startSeconds: 1.2,
        durationSeconds: 2,
        position: 'bottom-right',
        scale: 0.4,
        opacity: 80,
      },
      { storyboardId: 99, startSeconds: 0.5 },
      { clipId: 'pip-1', storyboardId: 11, startSeconds: 9 },
      {
        storyboardId: 11,
        startSeconds: -3,
        durationSeconds: 99,
        scale: 9,
        opacity: 999,
        position: 'nope',
      },
    ],
    contextVideoItems,
    12,
  )

  assert.equal(overlays.length, 2)
  assert.deepEqual(overlays[0], {
    clipId: 'pip-1',
    storyboardId: 11,
    startSeconds: 1.2,
    durationSeconds: 2,
    trimStartSeconds: 0,
    enabled: true,
    position: 'bottom-right',
    scale: 0.4,
    opacity: 80,
  })
  assert.equal(overlays[1].storyboardId, 11)
  assert.equal(overlays[1].startSeconds, 0)
  assert.equal(overlays[1].scale, 1)
  assert.equal(overlays[1].opacity, 100)
  assert.equal(overlays[1].position, 'bottom-right')
  assert.ok(overlays[1].durationSeconds <= 5)

  // 画中画是独立轨道：不进入主轨顺序，也不会把主轨片段顶掉。
  const draft = normalizeFinalEditDraft(
    {
      videoClips: [{ storyboardId: 11, enabled: true, order: 1 }],
      overlayClips: [{ storyboardId: 11, startSeconds: 1, durationSeconds: 1.5 }],
    },
    { videoItems: contextVideoItems, audioTracks: { dialogue: [], narration: [], music: [], sfx: [] } },
  )
  assert.equal(draft.videoClips.length, 1)
  assert.equal(draft.overlayClips.length, 1)
  assert.equal(draft.overlayClips[0].durationSeconds, 1.5)
})

test('keeps split clip segments, transitions, beat markers, emotion curve, and rollback snapshots', () => {
  const draft = normalizeFinalEditDraft({
    videoClips: [
      {
        clipId: 'clip-11-a',
        storyboardId: 11,
        enabled: true,
        order: 1,
        trimStartSeconds: 0,
        trimEndSeconds: 2.4,
        transition: { type: 'fade', durationSeconds: 0.3 },
      },
      {
        clipId: 'clip-11-b',
        storyboardId: 11,
        enabled: true,
        order: 2,
        trimStartSeconds: 2.4,
        trimEndSeconds: 5,
        transition: { type: 'cut', durationSeconds: 0 },
      },
    ],
    audioClips: [
      { audioId: 501, enabled: true, startOffsetSeconds: -0.45, volume: 88 },
    ],
    beatMarkers: [
      { markerId: 'beat-1', atSeconds: 1.2, label: '手机亮屏' },
      { markerId: '', atSeconds: -1, label: '' },
    ],
    emotionCurve: [
      { pointId: 'emotion-1', atSeconds: 0, intensity: 35, label: '克制' },
      { pointId: 'emotion-2', atSeconds: 5, intensity: 140, label: '惊惧' },
    ],
    versionHistory: [
      {
        versionId: 'snapshot-1',
        label: '拆分前',
        createdAt: '2026-09-28T12:00:00.000Z',
        payload: { videoClips: [] },
      },
    ],
  }, {
    videoItems: contextVideoItems,
    audioTracks: {
      dialogue: [{ id: 501, storyboardId: 11, startOffsetSeconds: 0, durationSeconds: 1.4, volume: 100 }],
      narration: [],
      music: [],
      sfx: [],
    },
  })

  assert.equal(draft.videoClips.length, 2)
  assert.equal(draft.videoClips[0].clipId, 'clip-11-a')
  assert.equal(draft.videoClips[1].clipId, 'clip-11-b')
  assert.deepEqual(draft.videoClips.map((item) => item.transition), [
    { type: 'fade', durationSeconds: 0.3 },
    { type: 'cut', durationSeconds: 0 },
  ])
  assert.equal(draft.audioClips[0].startOffsetSeconds, -0.45)
  assert.deepEqual(draft.beatMarkers, [
    { markerId: 'beat-1', atSeconds: 1.2, label: '手机亮屏' },
  ])
  assert.deepEqual(draft.emotionCurve, [
    { pointId: 'emotion-1', atSeconds: 0, intensity: 35, label: '克制' },
    { pointId: 'emotion-2', atSeconds: 5, intensity: 100, label: '惊惧' },
  ])
  assert.equal(draft.versionHistory[0].versionId, 'snapshot-1')

  const clips = applyFinalEditDraftToVideoItems(contextVideoItems, draft)
  assert.equal(clips.length, 2)
  assert.deepEqual(clips.map((item) => item.clipId), ['clip-11-a', 'clip-11-b'])
  assert.deepEqual(clips.map((item) => item.durationSeconds), [2.4, 2.6])
  assert.deepEqual(clips.map((item) => item.transition?.type), ['fade', 'cut'])
})

test('preserves an explicit manual transition override in the saved draft', () => {
  const draft = normalizeFinalEditDraft({
    videoClips: [{
      storyboardId: 11,
      enabled: true,
      order: 1,
      transition: { type: 'push', durationSeconds: 0.5, manual: true },
    }],
  }, {
    videoItems: contextVideoItems,
    audioTracks: {},
  })

  assert.deepEqual(draft.videoClips[0].transition, {
    type: 'push',
    durationSeconds: 0.5,
    manual: true,
  })
})
