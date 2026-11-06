import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRuleBasedVoiceDesign,
  buildVoicePerformanceInstructions,
  buildVoicePreviewText,
  normalizeVoiceDesign,
  resolvePersistedCustomVoiceDesign,
} from './voice.mjs'

test('normalizes a voice agent result into a playable voice design contract', () => {
  const design = normalizeVoiceDesign({
    name: '压住恐惧的清润男声',
    age_and_gender: '28岁男性',
    emotion_arc: '先克制，听到邮件后出现短促颤动',
    performance_instructions: '清润偏低，语速中慢，紧张时气息变浅。',
    avoid: ['播音腔', '夸张哭腔'],
    sample_text: '这封邮件，不可能是他发的。',
  })

  assert.equal(design.name, '压住恐惧的清润男声')
  assert.equal(design.ageAndGender, '28岁男性')
  assert.equal(design.emotionArc, '先克制，听到邮件后出现短促颤动')
  assert.deepEqual(design.avoid, ['播音腔', '夸张哭腔'])
  assert.match(design.performanceInstructions, /清润偏低/)
})

test('voice agent turns a scene-aware design into explicit TTS performance instructions', () => {
  const design = normalizeVoiceDesign({
    name: '压住恐惧的清润男声',
    timbre: '清润偏低，气息偏薄',
    emotion_arc: '从克制到听见邮件后的短促惊惧',
    rhythm: '中慢速，关键词前留半拍',
    breathing_and_pauses: '断网前吸气变浅，句尾不拖长',
    performance_instructions: '像一个试图用理性压住恐惧的人说话。',
    avoid: ['播音腔', '夸张哭腔'],
  })
  const instructions = buildVoicePerformanceInstructions({
    design,
    characterName: '林默',
    sceneContext: '深夜公寓，电脑突然亮起，人物怀疑邮件来自死者。',
    dialogueText: '这封邮件，不可能是他发的。',
  })

  assert.match(instructions, /林默/)
  assert.match(instructions, /深夜公寓/)
  assert.match(instructions, /中慢速/)
  assert.match(instructions, /播音腔/)
  assert.match(instructions, /这封邮件/)
})

test('voice preview text keeps metadata out of the spoken dialogue', () => {
  assert.equal(
    buildVoicePreviewText({
      characterName: '林默',
      sampleText: '这封邮件，不可能是他发的。',
      sceneTitle: '深夜公寓',
    }),
    '这封邮件，不可能是他发的。',
  )
})

test('resolves the exact persisted custom voice id and rejects stale or mismatched ids', () => {
  const character = {
    voice_setting: 'cosyvoice-v3.5-flash-vd-zhaoheng-123',
    voice_design_json: JSON.stringify({
      provider: 'qwen',
      voiceId: 'cosyvoice-v3.5-flash-vd-zhaoheng-123',
      targetModel: 'cosyvoice-v3.5-flash',
      timbre: '成年男性，中低音',
    }),
  }

  assert.equal(resolvePersistedCustomVoiceDesign(character, character.voice_setting)?.targetModel, 'cosyvoice-v3.5-flash')
  assert.equal(resolvePersistedCustomVoiceDesign(character, 'other-voice-id'), null)
  assert.equal(resolvePersistedCustomVoiceDesign({ ...character, voice_setting: 'stale-id' }, character.voice_setting), null)
})

test('rule fallback preserves a male character gender and existing story voice style', () => {
  const design = buildRuleBasedVoiceDesign({
    character: {
      name: '赵衡',
      gender: 'male',
      ageGroup: 'middle_aged',
      roleTag: '人事总监',
      voiceStyle: '低声压迫，语速慢而稳，冷硬盘问感，句尾下压',
      personality: '习惯控制局面，不轻易显露情绪。',
    },
    sampleText: '签了，公司按主动离职处理。',
  })

  assert.match(design.timbre, /中年男性/)
  assert.match(design.performanceInstructions, /中年男性/)
  assert.match(design.performanceInstructions, /句尾下压/)
  assert.ok(design.avoid.some((item) => /女性/.test(item)))
  assert.equal(design.generationSource, 'rules_fallback')
  assert.equal(design.sampleText, '签了，公司按主动离职处理。')
})
