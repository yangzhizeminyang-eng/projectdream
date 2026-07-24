import assert from 'node:assert/strict'
import test from 'node:test'

import { inferCharacterVoiceTraits, recommendVoiceProfiles } from './voice-profiles.mjs'

test('infers a 45 year old man and recommends the mature male profile', () => {
  const result = recommendVoiceProfiles({
    name: '高权限男声',
    roleTag: '后台监管者',
    appearance: '男性，稳定年龄感为45岁上下，成熟、克制，带官署压迫感。',
  })

  assert.equal(result.traits.ageGroup, 'middle_aged')
  assert.equal(result.traits.gender, 'male')
  assert.equal(result.items[0].profileKey, 'male-middle-authority')
  assert.equal(result.items[0].voiceId, 'Kai')
})

test('keeps teenage and middle-aged male recommendations separate', () => {
  const teenager = recommendVoiceProfiles({ name: '弟弟', appearance: '十几岁少年，约14到17岁。' })
  const adult = recommendVoiceProfiles({ name: '主管', appearance: '四十岁上下的男性管理者。' })

  assert.equal(teenager.items[0].profileKey, 'male-teen-bright')
  assert.equal(adult.items[0].profileKey, 'male-middle-authority')
})

test('infers child female roles without explicit structured fields', () => {
  const traits = inferCharacterVoiceTraits({ name: '小女孩', appearance: '年龄感7至8岁，瘦小女童。' })
  assert.equal(traits.ageGroup, 'child')
  assert.equal(traits.gender, 'female')
})

test('identity labels win over relationship mentions and relative ages are not absolute ages', () => {
  const sibling = inferCharacterVoiceTraits({
    name: '弟弟',
    roleTag: '记忆退化患者',
    personality: '依赖姐姐，但不愿让她担心。',
    appearance: '十几岁少年，约14到17岁。',
  })
  const pastVersion = inferCharacterVoiceTraits({
    name: '年轻沈砚',
    appearance: '比当前形象略轻两到三岁，整体状态更紧、更硬。',
  })

  assert.equal(sibling.gender, 'male')
  assert.equal(sibling.ageGroup, 'teen')
  assert.equal(pastVersion.ageGroup, 'young_adult')
})

test('senior female roles prefer dedicated elder voice candidates', () => {
  const result = recommendVoiceProfiles({
    name: '慈和长者女声',
    roleTag: '家族长辈',
    gender: 'female',
    ageGroup: 'senior',
    voiceStyle: '偏少亚低厚，语速利落，情绪压着说，重点要有老人感。',
  })

  assert.equal(result.traits.ageGroup, 'senior')
  assert.equal(result.traits.gender, 'female')
  assert.equal(result.items[0].profileKey, 'female-senior-mentor')
  assert.deepEqual(
    result.items.slice(0, 3).map((item) => item.voiceId),
    ['Elias', 'Seren', 'Bellona'],
  )
})

test('senior male roles include rough elder alternatives', () => {
  const result = recommendVoiceProfiles({
    name: '老摊主',
    roleTag: '六十岁以上男性长者',
    appearance: '老人，风霜感强，声音沙哑。',
  })

  assert.equal(result.traits.ageGroup, 'senior')
  assert.equal(result.traits.gender, 'male')
  assert.ok(result.items.some((item) => item.voiceId === 'Arthur'))
  assert.ok(result.items.some((item) => item.voiceId === 'Vincent'))
})
