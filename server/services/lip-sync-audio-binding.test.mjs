import assert from 'node:assert/strict'
import test from 'node:test'

import {
  restrictDialogueTracksToLipSyncBindings,
  validateLipSyncAudioBindings,
} from './lip-sync-audio-binding.mjs'

test('requires a lip-sync video to carry the dialogue audio asset used for generation', () => {
  const result = validateLipSyncAudioBindings({
    clips: [
      {
        id: 198,
        storyboardId: 186,
        syncSourceType: 'lip_sync',
        syncAudioAssetId: null,
      },
    ],
    audioTracks: {
      dialogue: [{ id: 169, storyboardId: 186, audioUrl: 'https://example.test/169.wav' }],
    },
  })

  assert.equal(result.passed, false)
  assert.equal(result.blockingIssues[0].code, 'lip-sync-audio-source-missing')
})

test('allows a lip-sync video only when final edit uses the same confirmed dialogue asset', () => {
  const result = validateLipSyncAudioBindings({
    clips: [
      {
        id: 198,
        storyboardId: 186,
        syncSourceType: 'lip_sync',
        syncAudioAssetId: 169,
      },
    ],
    audioTracks: {
      dialogue: [
        { id: 169, storyboardId: 186, status: 'confirmed', audioUrl: 'https://example.test/169.wav' },
        { id: 170, storyboardId: 186, status: 'confirmed', audioUrl: 'https://example.test/170.wav' },
      ],
    },
  })

  assert.equal(result.passed, true)
  assert.deepEqual(result.bindings, [
    {
      videoAssetId: 198,
      storyboardId: 186,
      syncAudioAssetId: 169,
      renderedDialogueAudioAssetId: 169,
      sameSource: true,
    },
  ])
})

test('blocks a lip-sync video when final edit would use another dialogue asset', () => {
  const result = validateLipSyncAudioBindings({
    clips: [
      {
        id: 198,
        storyboardId: 186,
        syncSourceType: 'lip_sync',
        syncAudioAssetId: 169,
      },
    ],
    audioTracks: {
      dialogue: [{ id: 170, storyboardId: 186, status: 'confirmed', audioUrl: 'https://example.test/170.wav' }],
    },
  })

  assert.equal(result.passed, false)
  assert.equal(result.blockingIssues[0].code, 'lip-sync-audio-source-mismatch')
})

test('does not force a lip-sync binding on ordinary generated video', () => {
  const result = validateLipSyncAudioBindings({
    clips: [
      {
        id: 197,
        storyboardId: 186,
        syncSourceType: 'generated_video',
        syncAudioAssetId: null,
      },
    ],
    audioTracks: {
      dialogue: [{ id: 170, storyboardId: 186, status: 'confirmed', audioUrl: 'https://example.test/170.wav' }],
    },
  })

  assert.equal(result.passed, true)
  assert.deepEqual(result.bindings, [])
})

test('keeps narration outside the lip-sync dialogue binding', () => {
  const result = validateLipSyncAudioBindings({
    clips: [
      {
        id: 198,
        storyboardId: 186,
        syncSourceType: 'lip_sync',
        syncAudioAssetId: 169,
      },
    ],
    audioTracks: {
      dialogue: [{ id: 169, storyboardId: 186, status: 'confirmed', audioUrl: 'https://example.test/169.wav' }],
      narration: [{ id: 300, storyboardId: 186, status: 'confirmed', audioUrl: 'https://example.test/300.wav' }],
    },
  })

  assert.equal(result.passed, true)
  assert.equal(result.bindings[0].renderedDialogueAudioAssetId, 169)
})

test('filters alternate confirmed dialogue versions for a lip-sync storyboard only', () => {
  const result = restrictDialogueTracksToLipSyncBindings({
    audioTracks: {
      dialogue: [
        { id: 169, storyboardId: 186 },
        { id: 170, storyboardId: 186 },
        { id: 171, storyboardId: 187 },
      ],
      narration: [{ id: 300, storyboardId: 186 }],
    },
    bindings: [
      {
        videoAssetId: 198,
        storyboardId: 186,
        syncAudioAssetId: 169,
      },
    ],
  })

  assert.deepEqual(result.dialogue.map((item) => item.id), [169, 171])
  assert.deepEqual(result.narration.map((item) => item.id), [300])
})
