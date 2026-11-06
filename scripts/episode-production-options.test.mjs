import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CORE_STORYBOARD_IDS,
  firstAudioAsset,
  parseEpisodeProductionOptions,
  resolveEpisodeAudioTrack,
  shouldReuseEpisodeAudio,
} from './episode-production-options.mjs'

test('defaults to the agreed nine-shot first episode core', () => {
  assert.deepEqual(parseEpisodeProductionOptions([]), {
    storyboardIds: CORE_STORYBOARD_IDS,
    dryRun: false,
    skipExport: false,
    exportOnly: false,
  })
})

test('supports a controlled single-storyboard run', () => {
  assert.deepEqual(parseEpisodeProductionOptions(['--only=267']), {
    storyboardIds: [267],
    dryRun: false,
    skipExport: false,
    exportOnly: false,
  })
})

test('rejects storyboard ids outside the agreed episode scope', () => {
  assert.throws(
    () => parseEpisodeProductionOptions(['--only=999']),
    /not part of the agreed episode-one core/,
  )
})

test('supports dry-run and export suppression independently', () => {
  assert.deepEqual(parseEpisodeProductionOptions(['--dry-run', '--skip-export']), {
    storyboardIds: CORE_STORYBOARD_IDS,
    dryRun: true,
    skipExport: true,
    exportOnly: false,
  })
})

test('supports an export-only pass over already produced assets', () => {
  assert.deepEqual(parseEpisodeProductionOptions(['--export-only']), {
    storyboardIds: CORE_STORYBOARD_IDS,
    dryRun: false,
    skipExport: false,
    exportOnly: true,
  })
})

test('does not reuse legacy dialogue audio without a matching text snapshot', () => {
  assert.equal(
    shouldReuseEpisodeAudio(
      { id: 132, status: 'confirmed', sourceText: '' },
      '林夏：回路串频……',
    ),
    false,
  )
  assert.equal(
    shouldReuseEpisodeAudio(
      { id: 172, status: 'confirmed', sourceText: '没人应该在这里活过今晚。' },
      '没人应该在这里活过今晚。',
    ),
    true,
  )
})

test('reads audio assets from the project API envelope', () => {
  assert.equal(firstAudioAsset({ items: [{ id: 173 }] }).id, 173)
  assert.equal(firstAudioAsset([{ id: 174 }]).id, 174)
  assert.equal(firstAudioAsset({ items: [] }), null)
})

test('routes broadcast speech to narration instead of a visible character track', () => {
  assert.deepEqual(resolveEpisodeAudioTrack({ characterId: 20 }), {
    trackType: 'narration',
    characterId: null,
    voiceProfileKey: 'female-adult-gentle',
    voiceName: 'Serena',
    modelName: 'qwen3-tts-instruct-flash',
    languageType: 'Chinese',
    characterName: '苏岚',
  })
  assert.deepEqual(resolveEpisodeAudioTrack({ characterId: 18 }), {
    trackType: 'dialogue',
    characterId: 18,
    voiceProfileKey: null,
  })
})
