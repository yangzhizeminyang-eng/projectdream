import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeCharacterCostume } from './character-costume.mjs'

test('keeps the Agent costume field as the authoritative costume baseline', () => {
  assert.equal(
    normalizeCharacterCostume({ costume: '浅蓝衬衫、米色西装外套、银色腕表' }),
    '浅蓝衬衫、米色西装外套、银色腕表',
  )
})

test('recovers exact costume text when the Agent misplaced it in voice_setting', () => {
  const value = '整季默认穿浅蓝棉质衬衫、米色垂感西装外套，固定随身左腕银色腕表。'
  assert.equal(normalizeCharacterCostume({ voice_setting: value }), value)
})

test('does not turn an ordinary voice description into costume', () => {
  assert.equal(normalizeCharacterCostume({ voice_setting: '低沉、克制、语速偏慢' }), '')
})
