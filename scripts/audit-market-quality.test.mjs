import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCharacterAuditInput,
  buildExportCharacterAuditInput,
  buildExpectedSubtitleCues,
  buildPacingAuditInput,
  buildExportClips,
  normalizeExpectedSubtitleCuesForBurnIn,
} from './audit-market-quality.mjs'

test('builds character audit evidence from an image snapshot and active baseline', () => {
  const result = buildCharacterAuditInput({
    storyboards: [{ id: 186, character_id: 18 }],
    videoAssets: [{
      id: 196,
      storyboard_id: 186,
      image_character_snapshot: {
        version: 1,
        characters: [{
          characterId: 18,
          characterVersionNo: 7,
          name: '林夏',
          appearance: '黑发、冷白皮',
          costume: '深色工装',
          referenceImageUrl: 'https://example.com/linxia.png',
        }],
      },
    }],
    baselines: [{
      characterId: 18,
      versionNo: 7,
      appearance: '黑发、冷白皮',
      costume: '深色工装',
      referenceImageUrl: 'https://example.com/linxia.png',
    }],
  })

  assert.deepEqual(result.baselines[0].versionNo, 7)
  assert.deepEqual(result.clips[0], {
    videoAssetId: 196,
    storyboardId: 186,
    characterId: 18,
    characterVersionNo: 7,
  })
})

test('builds expected subtitle cues on the export timeline', () => {
  const result = buildExpectedSubtitleCues({
    clips: [{ storyboardId: 186, durationSeconds: 5, dialogueText: '林夏：……妈？' }],
    audioTracks: {
      dialogue: [{
        id: 170,
        storyboardId: 186,
        characterName: '林夏',
        durationSeconds: 0.56,
        startOffsetSeconds: 0,
      }],
      narration: [],
    },
  })

  assert.deepEqual(result, [{
    startSeconds: 0,
    endSeconds: 0.56,
    text: '林夏：……妈？',
  }])
})

test('normalizes database audio row fields when building expected subtitle cues', () => {
  const result = buildExpectedSubtitleCues({
    clips: [{ storyboardId: 186, durationSeconds: 5, dialogueText: '林夏：……妈？苏岚（广播）：五。' }],
    audioTracks: {
      dialogue: [{
        id: 170,
        storyboard_id: 186,
        track_type: 'dialogue',
        character_name: '林夏',
        start_offset_seconds: '0.000',
        duration_seconds: '0.560',
      }],
      narration: [{
        id: 171,
        storyboard_id: 186,
        track_type: 'narration',
        start_offset_seconds: '1.100',
        duration_seconds: '0.560',
      }],
    },
  })

  assert.deepEqual(result, [
    { startSeconds: 0, endSeconds: 0.56, text: '林夏：……妈？' },
    { startSeconds: 1.1, endSeconds: 1.66, text: '苏岚（广播）：五。' },
  ])
})

test('includes the explicit dialogue sync compensation in expected subtitle timing', () => {
  const result = buildExpectedSubtitleCues({
    clips: [{ storyboardId: 186, durationSeconds: 5, dialogueText: '林夏：……妈？' }],
    audioTracks: {
      dialogue: [{
        id: 170,
        storyboardId: 186,
        characterName: '林夏',
        durationSeconds: 0.56,
        startOffsetSeconds: 0,
      }],
      narration: [],
    },
    speechSyncOffsetSeconds: 0.16,
  })

  assert.deepEqual(result, [{
    startSeconds: 0.16,
    endSeconds: 0.72,
    text: '林夏：……妈？',
  }])
})

test('normalizes expected subtitle text to the burned-in reference style', () => {
  const result = normalizeExpectedSubtitleCuesForBurnIn([
    { startSeconds: 0.52, endSeconds: 1.08, text: '林夏：……妈？' },
    { startSeconds: 1.1, endSeconds: 1.66, text: '苏岚（广播）：五。' },
  ])

  assert.deepEqual(result, [
    { startSeconds: 0.52, endSeconds: 1.08, text: '……妈？' },
    { startSeconds: 1.1, endSeconds: 1.66, text: '五。' },
  ])
})

test('limits character audit evidence to the video asset used by the export', () => {
  const result = buildCharacterAuditInput({
    storyboards: [{ id: 186, character_id: 18 }],
    videoAssetIds: [196],
    videoAssets: [
      {
        id: 195,
        storyboard_id: 186,
        image_character_snapshot: {
          characters: [{ characterId: 18, characterVersionNo: 7 }],
        },
      },
      {
        id: 196,
        storyboard_id: 186,
        image_character_snapshot: {
          characters: [{ characterId: 18, characterVersionNo: 7 }],
        },
      },
    ],
    baselines: [{ characterId: 18, versionNo: 7 }],
  })

  assert.equal(result.clips.length, 1)
  assert.equal(result.clips[0].videoAssetId, 196)
  assert.equal(result.clips[0].characterVersionNo, 7)
})

test('uses video-level character evidence before image snapshots', () => {
  const result = buildCharacterAuditInput({
    storyboards: [{ id: 186, character_id: 18 }],
    videoAssetIds: [196],
    videoAssets: [{
      id: 196,
      storyboard_id: 186,
      character_evidence_json: {
        characterSnapshot: {
          characters: [{ characterId: 18, characterVersionNo: 8 }],
        },
      },
      image_character_snapshot: {
        characters: [{ characterId: 18, characterVersionNo: 7 }],
      },
    }],
    baselines: [{ characterId: 18, versionNo: 8 }],
  })

  assert.equal(result.clips[0].characterVersionNo, 8)
})

test('limits export character evidence to the clips used by the export', () => {
  const result = buildExportCharacterAuditInput({
    clips: [{ videoAssetId: 197, storyboardId: 186 }],
    storyboards: [{ id: 186, character_id: 18 }],
    videoAssets: [
      {
        id: 196,
        storyboard_id: 186,
        image_character_snapshot: {
          characters: [{ characterId: 18, characterVersionNo: 1 }],
        },
      },
      {
        id: 197,
        storyboard_id: 186,
        character_evidence_json: {
          characterSnapshot: {
            characters: [{ characterId: 18, characterVersionNo: 7 }],
          },
        },
      },
    ],
    baselines: [{ characterId: 18, versionNo: 7 }],
  })

  assert.deepEqual(result.clips, [{
    videoAssetId: 197,
    storyboardId: 186,
    characterId: 18,
    characterVersionNo: 7,
  }])
})

test('builds pacing evidence from ordered clips and total duration', () => {
  const result = buildPacingAuditInput({
    clips: [
      { storyboardId: 1, durationSeconds: 2, sourceType: 'video' },
      { storyboardId: 2, durationSeconds: 3, sourceType: 'static' },
    ],
    totalDurationSeconds: 5,
  })

  assert.deepEqual(result, {
    clips: [
      { storyboardId: 1, durationSeconds: 2, sourceType: 'video' },
      { storyboardId: 2, durationSeconds: 3, sourceType: 'static' },
    ],
    totalDurationSeconds: 5,
  })
})

test('builds one audit clip for a single-video final-edit export', () => {
  const clips = buildExportClips({
    row: { id: 36 },
    config: {
      pipeline: 'single-video-final-edit-v1',
      singleVideoFinalEdit: {
        videoId: 197,
        storyboardId: 186,
      },
    },
    context: {
      storyboards: [{
        id: 186,
        dialogue_text: '林夏：……妈？',
        duration_seconds: 5,
      }],
    },
    media: { durationSeconds: 5 },
  })

  assert.deepEqual(clips, [{
    videoAssetId: 197,
    storyboardId: 186,
    durationSeconds: 5,
    dialogueText: '林夏：……妈？',
    sourceType: 'video',
  }])
})
