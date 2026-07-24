import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractRelatedSpeakerNames,
  transformCharacterName,
  transformCharacterNameJson,
  transformCharacterNames,
} from './character-rename.mjs'

test('character rename replaces every exact occurrence in editable text', () => {
  const result = transformCharacterName(
    '沈砚看向程默。沈砚说：“别跟着沈砚。”',
    '沈砚',
    '陆离',
  )

  assert.equal(result.occurrences, 3)
  assert.equal(result.value, '陆离看向程默。陆离说：“别跟着陆离。”')
})

test('character rename traverses structured outline JSON without changing keys', () => {
  const result = transformCharacterNameJson(
    JSON.stringify({ protagonist: '沈砚', scenes: [{ title: '沈砚醒来' }] }),
    '沈砚',
    '陆离',
  )

  assert.equal(result.valid, true)
  assert.equal(result.occurrences, 2)
  assert.deepEqual(JSON.parse(result.value), {
    protagonist: '陆离',
    scenes: [{ title: '陆离醒来' }],
  })
})

test('invalid outline JSON is never rewritten as plain text', () => {
  const raw = '{"name":"沈砚"'
  const result = transformCharacterNameJson(raw, '沈砚', '陆离')

  assert.equal(result.valid, false)
  assert.equal(result.changed, false)
  assert.equal(result.value, raw)
})

test('current and historical names are replaced in one pass without cascading', () => {
  const result = transformCharacterNames(
    '燐妤走进档案室，系统将燐妤琪标记为 LY-17。',
    ['燐妤琪', '燐妤'],
    '燐妤新',
  )

  assert.equal(result.occurrences, 2)
  assert.equal(result.value, '燐妤新走进档案室，系统将燐妤新标记为 LY-17。')
})

test('related historical names can be recovered from screenplay speaker labels', () => {
  const aliases = extractRelatedSpeakerNames(
    ['燐妤：谁在后台？\n终端女声：建议立即熔断。'],
    '燐妤琪',
    ['终端女声'],
  )

  assert.deepEqual(aliases, ['燐妤'])
})
