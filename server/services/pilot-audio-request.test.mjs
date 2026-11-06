import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPilotAudioGenerationRequest } from './pilot-audio-request.mjs'

test('routes broadcast dialogue to narration with the locked broadcast voice profile', () => {
  assert.deepEqual(
    buildPilotAudioGenerationRequest({
      storyboardId: 289,
      audioCharacterId: 20,
      text: '六。别怕，小夏。',
      durationSeconds: 4,
      candidateCount: 2,
    }),
    {
      trackType: 'narration',
      characterId: null,
      voiceProfileKey: 'female-adult-gentle',
      voiceName: 'Serena',
      modelName: 'qwen3-tts-instruct-flash',
      languageType: 'Chinese',
      characterName: '苏岚',
      storyboardId: 289,
      text: '六。别怕，小夏。',
      durationSeconds: 4,
      candidateCount: 2,
    },
  )
})

test('keeps visible character dialogue on the dialogue track', () => {
  const request = buildPilotAudioGenerationRequest({
    storyboardId: 267,
    audioCharacterId: 18,
    text: '广播端口理论离线。',
    durationSeconds: 3,
    candidateCount: 2,
  })

  assert.equal(request.trackType, 'dialogue')
  assert.equal(request.characterId, 18)
  assert.equal(request.voiceProfileKey, null)
  assert.equal(request.voiceName, null)
  assert.equal(request.modelName, null)
  assert.equal(request.languageType, 'Chinese')
  assert.equal(request.characterName, null)
})
