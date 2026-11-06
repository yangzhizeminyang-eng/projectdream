import assert from 'node:assert/strict'
import test from 'node:test'

import { buildVoiceBindingSummary } from './voice-binding-status.ts'

test('summarizes only speakers in the current project scripts', () => {
  const summary = buildVoiceBindingSummary([
    { character: { id: 1, name: '唐宁', voiceLocked: true, referenceAudioUrl: '/tang.wav' }, ready: true },
    { character: { id: 2, name: '赵衡', voiceLocked: true, referenceAudioUrl: '/zhao.wav' }, ready: true },
    { character: { id: 3, name: '赵启明', voiceLocked: false }, ready: false },
  ], [
    { dialogueText: '赵衡：签了。', characterName: '唐宁' },
    { dialogueText: '唐宁：不。', characterName: '唐宁' },
    { dialogueText: '（无对白）', characterName: '赵启明' },
  ])

  assert.deepEqual(summary, { total: 2, ready: 2, pending: 0, speakerNames: ['赵衡', '唐宁'] })
})

test('keeps an unlocked voice and its character marked pending', () => {
  const summary = buildVoiceBindingSummary([
    { character: { id: 1, name: '唐宁', voiceLocked: false, referenceAudioUrl: '/tang.wav' }, ready: false },
  ], [{ dialogueText: '唐宁：我知道。', characterName: '唐宁' }])

  assert.deepEqual(summary, { total: 1, ready: 0, pending: 1, speakerNames: ['唐宁'] })
})
