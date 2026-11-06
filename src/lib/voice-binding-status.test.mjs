import assert from 'node:assert/strict'
import test from 'node:test'

import { getDialogueSpeakerNames, getShotVoiceBindingState, getVoiceBindingState } from './voice-binding-status.ts'

test('marks dialogue ready when every character in the shot has a locked voice', () => {
  assert.equal(getVoiceBindingState([
    { name: '唐宁', voiceLocked: true, voiceProfileKey: 'female-calm' },
    { name: '赵衡', voiceLocked: true, referenceAudioUrl: 'https://cdn.test/zhao.wav' },
  ], true), 'ready')
})

test('a locked reference recording is ready, but an unlocked recording is not', () => {
  assert.equal(getVoiceBindingState([
    { name: '唐宁', voiceLocked: true, referenceAudioUrl: 'https://cdn.test/tangning.wav' },
  ], true), 'ready')
  assert.equal(getVoiceBindingState([
    { name: '唐宁', voiceLocked: false, referenceAudioUrl: 'https://cdn.test/tangning.wav' },
  ], true), 'pending')
})

test('keeps dialogue pending when one referenced character is not bound', () => {
  assert.equal(getVoiceBindingState([
    { name: '唐宁', voiceLocked: true },
    { name: '赵衡', voiceLocked: false },
  ], true), 'pending')
})

test('does not require a voice for a silent shot', () => {
  assert.equal(getVoiceBindingState([], false), 'none')
})

test('falls back to the shot prompt when the legacy allowed entity list is absent', () => {
  assert.equal(getShotVoiceBindingState([
    { name: '唐宁', voiceLocked: true, voiceProfileKey: 'female-calm' },
    { name: '赵衡', voiceLocked: true, referenceAudioUrl: 'https://cdn.test/zhao.wav' },
    { name: '赵启明', voiceLocked: false },
  ], {
    visualPrompt: '@唐宁、@赵衡；两人隔着长桌对坐',
    dialogueText: '赵衡：签了，对大家都好。',
  }), 'ready')
})

test('does not require an unrelated project character included by a broad context list', () => {
  assert.equal(getShotVoiceBindingState([
    { name: '唐宁', voiceLocked: true, voiceProfileKey: 'female-calm' },
    { name: '赵衡', voiceLocked: true, voiceProfileKey: 'male-calm' },
    { name: '赵启明', voiceLocked: false },
  ], {
    allowedEntities: ['唐宁', '赵衡', '赵启明'],
    visualPrompt: '@唐宁、@赵衡；两人隔着长桌对坐',
    dialogueText: '赵衡：签了，对大家都好。',
  }), 'ready')
})

test('uses the primary character fallback without requiring unrelated project voices', () => {
  assert.equal(getShotVoiceBindingState([
    { name: '唐宁', voiceLocked: true, voiceProfileKey: 'female-calm' },
    { name: '赵启明', voiceLocked: false },
  ], {
    dialogueText: '唐宁：我知道。',
    primaryCharacterName: '唐宁',
  }), 'ready')
})

test('counts explicit speakers in multi-speaker dialogue and excludes silent characters', () => {
  assert.deepEqual(
    getDialogueSpeakerNames([
      { dialogueText: '赵衡：签了。唐宁：我拒绝。', characterName: '唐宁' },
      { dialogueText: '（无对白）', characterName: '赵启明' },
    ], ['唐宁', '赵衡', '赵启明']),
    ['唐宁', '赵衡'],
  )
})
