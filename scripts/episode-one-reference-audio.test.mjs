import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildReferenceAudioSegments,
  cleanReferenceSubtitleText,
  extractSpeakerText,
} from './episode-one-reference-audio.mjs'

test('keeps the complete broadcast sentence after the speaker label', () => {
  assert.deepEqual(extractSpeakerText('苏岚（广播）：六。别怕，小夏。'), {
    speakerName: '苏岚',
    text: '六。别怕，小夏。',
    trackType: 'narration',
    characterId: null,
    voiceProfileKey: 'female-adult-gentle',
  })
})

test('routes Lin Xia speech to dialogue and preserves hesitation', () => {
  assert.deepEqual(extractSpeakerText('林夏：……妈？'), {
    speakerName: '林夏',
    text: '……妈？',
    trackType: 'dialogue',
    characterId: 18,
    voiceProfileKey: 'female-young-warm',
  })
})

test('does not create audio or subtitles for silent reaction shots', () => {
  assert.equal(extractSpeakerText(''), null)
  assert.equal(extractSpeakerText('（无对白）'), null)
  assert.equal(cleanReferenceSubtitleText('（无对白）'), '')
})

test('does not invent the omitted five broadcast', () => {
  const segments = buildReferenceAudioSegments([
    { storyboardId: 1, dialogueText: '苏岚（广播）：六。别怕，小夏。' },
    { storyboardId: 2, dialogueText: '' },
    { storyboardId: 3, dialogueText: '苏岚（广播）：四。' },
  ])
  assert.deepEqual(
    segments.map((item) => item.text),
    ['六。别怕，小夏。', '四。'],
  )
})
