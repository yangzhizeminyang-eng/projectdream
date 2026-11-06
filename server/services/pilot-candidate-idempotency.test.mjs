import assert from 'node:assert/strict'
import test from 'node:test'

import { selectReusablePilotCandidates } from './pilot-candidate-idempotency.mjs'

test('reuses only current-batch video candidates tied to the confirmed image and model', () => {
  const result = selectReusablePilotCandidates(
    [
      { id: 10, status: 'candidate', production_batch: 'legacy-history', model_name: 'agnes-video-v2.0', image_asset_id: 50, version_no: 9 },
      { id: 11, status: 'candidate', production_batch: 'episode-one-v2-continuity', model_name: 'agnes-video-v2.0', image_asset_id: 49, version_no: 1 },
      { id: 12, status: 'candidate', production_batch: 'episode-one-v2-continuity', model_name: 'agnes-video-v2.0', image_asset_id: 50, version_no: 2 },
      { id: 13, status: 'candidate', production_batch: 'episode-one-v2-continuity', model_name: 'agnes-video-v2.0', image_asset_id: 50, version_no: 2 },
    ],
    {
      candidateCount: 2,
      productionBatch: 'episode-one-v2-continuity',
      modelName: 'agnes-video-v2.0',
      imageAssetId: 50,
    },
  )

  assert.equal(result.enough, true)
  assert.deepEqual(result.items.map((item) => item.id), [12, 13])
})

test('returns a partial reusable set so the caller can generate only the missing candidates', () => {
  const result = selectReusablePilotCandidates(
    [
      { id: 21, status: 'candidate', production_batch: 'episode-one-v2-continuity', model_name: 'qwen3-tts-flash', character_id: 18, version_no: 3 },
      { id: 22, status: 'archived', production_batch: 'episode-one-v2-continuity', model_name: 'qwen3-tts-flash', character_id: 18, version_no: 3 },
    ],
    {
      candidateCount: 2,
      productionBatch: 'episode-one-v2-continuity',
      modelName: 'qwen3-tts-flash',
      characterId: 18,
    },
  )

  assert.equal(result.enough, false)
  assert.equal(result.matchedCount, 1)
  assert.deepEqual(result.items.map((item) => item.id), [21])
})

test('does not reuse audio candidates without a locked voice snapshot', () => {
  const result = selectReusablePilotCandidates(
    [
      {
        id: 31,
        status: 'candidate',
        production_batch: 'episode-one-v2-continuity',
        model_name: 'qwen3-tts-instruct-flash',
        character_id: null,
        voice_lock_snapshot_json: null,
        version_no: 4,
      },
      {
        id: 32,
        status: 'candidate',
        production_batch: 'episode-one-v2-continuity',
        model_name: 'qwen3-tts-instruct-flash',
        character_id: null,
        voice_lock_snapshot_json: JSON.stringify({
          version: 'voice-lock-v1',
          characterName: '苏岚',
          voiceProfileKey: 'female-adult-gentle',
          voiceName: 'Serena',
          modelName: 'qwen3-tts-instruct-flash',
          languageType: 'Chinese',
          locked: true,
        }),
        version_no: 4,
      },
    ],
    {
      candidateCount: 2,
      productionBatch: 'episode-one-v2-continuity',
      modelName: 'qwen3-tts-instruct-flash',
      requireVoiceLockSnapshot: true,
      voiceLockSnapshot: {
        version: 'voice-lock-v1',
        characterName: '苏岚',
        voiceProfileKey: 'female-adult-gentle',
        voiceName: 'Serena',
        modelName: 'qwen3-tts-instruct-flash',
        languageType: 'Chinese',
        locked: true,
      },
    },
  )

  assert.equal(result.matchedCount, 1)
  assert.deepEqual(result.items.map((item) => item.id), [32])
})
