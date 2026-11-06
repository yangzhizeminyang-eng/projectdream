import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildLockedVoiceInstructions,
  buildNarrationVoiceLockSnapshot,
  buildVoiceLockSnapshot,
  validateVoiceLockSnapshot,
} from './voice-lock-policy.mjs'

test('creates a fixed Chinese voice snapshot for a character', () => {
  const snapshot = buildVoiceLockSnapshot({
    character: {
      id: 18,
      name: '林夏',
      characterVersionNo: 7,
      voice_locked: 1,
      voice_style: '中薄偏冷，语速稳而利落',
    },
    voiceProfile: {
      profileKey: 'female-young-warm',
      voiceId: 'Cherry',
      modelName: 'qwen3-tts-flash',
      languageType: 'Chinese',
    },
  })

  assert.deepEqual(snapshot, {
    version: 'voice-lock-v1',
    characterId: 18,
    characterName: '林夏',
    characterVersionNo: 7,
    voiceProfileKey: 'female-young-warm',
    voiceName: 'Cherry',
    modelName: 'qwen3-tts-flash',
    languageType: 'Chinese',
    voiceStyle: '中薄偏冷，语速稳而利落',
    locked: true,
  })
})

test('voice instructions explicitly forbid language and voice drift', () => {
  const instructions = buildLockedVoiceInstructions({
    characterName: '苏岚',
    voiceProfileKey: 'female-adult-gentle',
    voiceName: 'Serena',
    voiceStyle: '温柔里带虚弱与穿透性的现实感',
  })

  assert.match(instructions, /只使用中文普通话/)
  assert.match(instructions, /不得输出英文/)
  assert.match(instructions, /不得切换声线/)
})

test('voice snapshot rejects a different voice or language', () => {
  const report = validateVoiceLockSnapshot({
    snapshot: {
      locked: true,
      characterId: 20,
      characterVersionNo: 1,
      voiceProfileKey: 'female-adult-gentle',
      voiceName: 'Serena',
      modelName: 'qwen3-tts-instruct-flash',
      languageType: 'Chinese',
    },
    characterId: 20,
    characterVersionNo: 1,
    voiceProfileKey: 'female-adult-gentle',
    voiceName: 'Cherry',
    modelName: 'qwen3-tts-instruct-flash',
    languageType: 'English',
  })

  assert.equal(report.valid, false)
  assert.match(report.errors.join('；'), /voice|语言/)
})

test('creates a locked narration snapshot for Su Lan broadcast speech', () => {
  const snapshot = buildNarrationVoiceLockSnapshot({
    characterName: '苏岚',
    voiceProfile: {
      profileKey: 'female-adult-gentle',
      voiceId: 'Serena',
      modelName: 'qwen3-tts-instruct-flash',
      languageType: 'Chinese',
    },
  })

  assert.deepEqual(snapshot, {
    version: 'voice-lock-v1',
    characterId: null,
    characterName: '苏岚',
    characterVersionNo: null,
    voiceProfileKey: 'female-adult-gentle',
    voiceName: 'Serena',
    modelName: 'qwen3-tts-instruct-flash',
    languageType: 'Chinese',
    voiceStyle: null,
    locked: true,
  })
})
