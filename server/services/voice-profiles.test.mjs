import assert from 'node:assert/strict'
import test from 'node:test'

import { getDialogueSpeakerNames, inferCharacterVoiceTraits, isCharacterVoiceReady, recommendVoiceProfiles, resolveCharacterVoiceProfile } from './voice-profiles.mjs'

test('resolves current-episode dialogue speakers and ignores silent dialogue', () => {
  assert.deepEqual(getDialogueSpeakerNames([
    { characterName: '唐宁', dialogueText: '赵衡：签了。唐宁（冷静）：我拒绝。' },
    { characterName: '赵启明', dialogueText: '（无对白）' },
  ], ['唐宁', '赵衡', '赵启明']), ['唐宁', '赵衡'])
})

test('a locked reference recording counts as a complete voice binding without a catalog profile', () => {
  assert.equal(isCharacterVoiceReady({ voice_locked: 1, reference_audio_url: 'https://cdn.test/tangning.wav' }), true)
  assert.equal(isCharacterVoiceReady({ voice_locked: 1 }), false)
  assert.equal(isCharacterVoiceReady({ voice_locked: 0, voice_profile_key: 'female-adult-gentle' }), false)
})

test('a locked provider-created voice id counts as a complete character voice binding', () => {
  assert.equal(isCharacterVoiceReady({
    voice_locked: 1,
    voice_setting: 'cosyvoice-v3.5-flash-vd-zhaoheng-123',
    voice_design_json: JSON.stringify({
      provider: 'qwen',
      voiceId: 'cosyvoice-v3.5-flash-vd-zhaoheng-123',
      targetModel: 'cosyvoice-v3.5-flash',
    }),
  }), true)
})

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

test('male character voice preview never falls back to the global female voice', () => {
  const result = resolveCharacterVoiceProfile({
    character: { name: '赵衡', gender: 'male', age_group: 'middle_aged' },
  })

  assert.equal(result.profile.gender, 'male')
  assert.notEqual(result.profile.profileKey, 'female-young-warm')
  assert.equal(result.error, null)
})

test('rejects binding a female system voice to a male character', () => {
  const result = resolveCharacterVoiceProfile({
    character: { name: '赵衡', gender: 'male' },
    requestedProfileKey: 'female-adult-gentle',
  })

  assert.equal(result.profile, null)
  assert.match(result.error, /男性角色.*女性声线/)
})

test('accepts a selected voice when its gender matches the character', () => {
  const result = resolveCharacterVoiceProfile({
    character: { name: '赵衡', gender: 'male' },
    requestedProfileKey: 'male-adult-calm',
  })

  assert.equal(result.profile.profileKey, 'male-adult-calm')
  assert.equal(result.error, null)
})
