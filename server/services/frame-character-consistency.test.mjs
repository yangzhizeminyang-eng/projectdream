import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildFrameConsistencyPrompt,
  createFrameCharacterSnapshot,
  resolveFrameCharacterContext,
} from './frame-character-consistency.mjs'

const characters = [
  {
    id: 11,
    name: '沈砚',
    role_tag: '女主角｜记忆修复师',
    gender: 'female',
    age_group: 'young_adult',
    appearance: '25岁女性，黑色短发，深灰制服，右眉有细疤。',
    reference_image_url: 'https://example.com/shenyan.png',
  },
  {
    id: 12,
    name: '程默',
    role_tag: '关键男配角',
    gender: 'male',
    age_group: 'middle_aged',
    appearance: '45岁男性，短寸发，黑色长风衣。',
    reference_image_url: 'https://example.com/chengmo.png',
  },
]

test('generic protagonist resolves to the female lead and enforces gender', () => {
  const storyboard = {
    character_name: '主角',
    action_text: '主角独自走进走廊。',
    visual_prompt: '主角站在冷色走廊尽头，电影感中景。',
  }
  const context = resolveFrameCharacterContext(storyboard, characters)
  const result = buildFrameConsistencyPrompt({
    storyboard,
    context,
    prompt: storyboard.visual_prompt,
  })

  assert.equal(context.ready, true)
  assert.equal(context.primaryCharacterId, 11)
  assert.equal(context.characters[0].gender, 'female')
  assert.match(result.prompt, /沈砚（主要主体）/)
  assert.match(result.prompt, /必须呈现为女性/)
  assert.match(result.prompt, /黑色短发/)
  assert.match(result.prompt, /定妆参考图序号=1/)
  assert.match(result.prompt, /同一张脸/)
  assert.match(result.prompt, /同一五官比例/)
  assert.match(result.negativePrompt, /man replacing female character/)
  assert.match(result.negativePrompt, /换脸/)
  assert.match(result.negativePrompt, /五官不一致/)
  assert.deepEqual(result.referenceImageUrls, ['https://example.com/shenyan.png'])
})

test('multiple named characters receive separate constraints and references', () => {
  const storyboard = {
    character_id: 11,
    character_name: '沈砚',
    action_text: '沈砚与程默在门前对峙。',
    visual_prompt: '沈砚与程默同框，紧张对峙。',
  }
  const context = resolveFrameCharacterContext(storyboard, characters)
  const result = buildFrameConsistencyPrompt({ storyboard, context })
  const snapshot = createFrameCharacterSnapshot(context)

  assert.equal(context.ready, true)
  assert.deepEqual(context.characters.map((item) => item.name), ['沈砚', '程默'])
  assert.match(result.prompt, /沈砚（主要主体）/)
  assert.match(result.prompt, /程默（同框角色）/)
  assert.match(result.prompt, /必须呈现为女性/)
  assert.match(result.prompt, /必须呈现为男性/)
  assert.deepEqual(result.referenceImageUrls, [
    'https://example.com/shenyan.png',
    'https://example.com/chengmo.png',
  ])
  assert.equal(snapshot.characters.length, 2)
  assert.equal(snapshot.characters[0].gender, 'female')
})

test('reference image numbering stays aligned when a character has no image', () => {
  const context = resolveFrameCharacterContext(
    {
      character_id: 11,
      character_name: '沈砚',
      action_text: '沈砚与程默同框。',
      visual_prompt: '沈砚与程默同框。',
    },
    [{ ...characters[0], reference_image_url: null }, characters[1]],
  )
  const result = buildFrameConsistencyPrompt({ storyboard: {}, context })

  assert.equal(context.ready, false)
  assert.match(context.blockers[0], /尚未确认定妆图/)
  assert.deepEqual(result.referenceImageUrls, ['https://example.com/chengmo.png'])
  assert.doesNotMatch(result.prompt, /沈砚（主要主体）[^\n]*定妆参考图序号/s)
  assert.match(result.prompt, /程默（同框角色）[^\n]*定妆参考图序号=1/s)
})

test('visible character without confirmed reference image blocks frame generation', () => {
  const context = resolveFrameCharacterContext(
    {
      character_id: 11,
      character_name: '沈砚',
      action_text: '沈砚站在档案室窗前。',
      visual_prompt: '沈砚站在城市医院旧档案室里，窗外暴雨。',
    },
    [{ ...characters[0], reference_image_url: null }],
  )

  assert.equal(context.ready, false)
  assert.match(context.blockers[0], /尚未确认定妆图/)
})

test('unmatched human subject blocks generation', () => {
  const context = resolveFrameCharacterContext(
    {
      character_name: '神秘人',
      action_text: '神秘人抬头看向镜头。',
      visual_prompt: '一个人物站在雨中。',
    },
    characters,
  )

  assert.equal(context.ready, false)
  assert.equal(context.characterFree, false)
  assert.match(context.blockers[0], /无法匹配角色库/)
})

test('environment-only shot remains eligible without character constraints', () => {
  const context = resolveFrameCharacterContext(
    {
      character_name: '空镜',
      action_text: '雨水沿着窗户滑落。',
      visual_prompt: '无人走廊，冷色灯光，雨夜。',
    },
    characters,
  )

  assert.equal(context.ready, true)
  assert.equal(context.characterFree, true)
  assert.deepEqual(context.characters, [])
})

test('point-of-view wording does not force the observer into an environment shot', () => {
  const context = resolveFrameCharacterContext(
    {
      character_id: 20,
      character_name: '苏岚',
      action_text: '林夏视线中的隧道深处掠过一线车灯反光。',
      visual_prompt: '主观视角看向废弃地铁隧道深处，铁轨反射冷光。',
    },
    [
      {
        id: 18,
        name: '林夏',
        role_tag: '主角',
        gender: 'female',
        age_group: 'young_adult',
        appearance: '24岁女性，黑色低马尾，深色检修工装。',
        reference_image_url: 'https://example.com/linxia.png',
      },
      {
        id: 20,
        name: '苏岚',
        role_tag: '母亲 / 广播中的回应者',
        gender: 'female',
        age_group: 'middle_aged',
        appearance: '中年女性，主要通过广播声音出现。',
      },
    ],
  )

  assert.equal(context.ready, true)
  assert.equal(context.characterFree, true)
  assert.deepEqual(context.characters, [])
})

test('character without resolvable gender blocks generation', () => {
  const context = resolveFrameCharacterContext(
    {
      character_id: 13,
      character_name: '访客',
      visual_prompt: '访客进入大厅。',
    },
    [{ id: 13, name: '访客', role_tag: '访客', appearance: '戴着兜帽。' }],
  )

  assert.equal(context.ready, false)
  assert.match(context.blockers[0], /缺少明确性别/)
})

test('audio-only system voice does not create an extra visible character', () => {
  const context = resolveFrameCharacterContext(
    {
      character_id: 11,
      character_name: '沈砚',
      action_text: '扬声器传出系统女声。沈砚停住，转头看向终端。',
      visual_prompt: '沈砚站在红色灯光下，画面上方可见金属扬声器。',
    },
    [
      characters[0],
      {
        id: 14,
        name: '系统女声',
        role_tag: '终端系统声音',
        gender: 'female',
        appearance: '无实体系统声音。',
      },
    ],
  )

  assert.equal(context.ready, true)
  assert.deepEqual(context.characters.map((item) => item.name), ['沈砚'])
})

test('audio identity becomes visual when the shot explicitly shows it', () => {
  const context = resolveFrameCharacterContext(
    {
      character_id: 15,
      character_name: '陌生声音',
      action_text: '镜头定格在陌生声音离开的背影上。',
      visual_prompt: '陌生声音在门口显露修长背影。',
    },
    [
      {
        id: 15,
        name: '陌生声音',
        role_tag: '门外声音',
        gender: 'male',
        age_group: 'middle_aged',
        appearance: '45岁男性，修长体态，黑色大衣。',
        reference_image_url: 'https://example.com/voice-man.png',
      },
    ],
  )

  assert.equal(context.ready, true)
  assert.equal(context.characterFree, false)
  assert.deepEqual(context.characters.map((item) => item.name), ['陌生声音'])
})

test('character identity wins over relationship mentions during gender inference', () => {
  const context = resolveFrameCharacterContext(
    {
      character_id: 17,
      character_name: '男人声音',
      action_text: '男人声音显露出守在门外的背影。',
      visual_prompt: '男人声音站在小女孩身边，保护她。',
    },
    [
      {
        id: 17,
        name: '男人声音',
        role_tag: '保护者｜小女孩身边的父亲或监护男性',
        appearance: '35至45岁，深色短发，旧夹克。',
        reference_image_url: 'https://example.com/father.png',
      },
    ],
  )

  assert.equal(context.ready, true)
  assert.equal(context.characters[0].gender, 'male')
})

test('audio-only bound character becomes an environment shot when not visible', () => {
  const context = resolveFrameCharacterContext(
    {
      character_id: 16,
      character_name: '终端女声',
      action_text: '镜头停在闪烁的终端指示灯上。',
      visual_prompt: '空旷档案室特写，终端灯光闪烁。',
    },
    [
      {
        id: 16,
        name: '终端女声',
        role_tag: '系统声音',
        gender: 'female',
        appearance: '无实体系统声音。',
      },
    ],
  )

  assert.equal(context.ready, true)
  assert.equal(context.characterFree, true)
  assert.deepEqual(context.characters, [])
})

test('ambiguous visible body for an audio identity requires explicit naming', () => {
  const context = resolveFrameCharacterContext(
    {
      character_id: 18,
      character_name: '陌生声音',
      action_text: '镜头定格在角色离开的背影上。',
      visual_prompt: '门口出现一个修长背影。',
    },
    [
      {
        id: 18,
        name: '陌生声音',
        role_tag: '门外声音',
        gender: 'male',
        appearance: '45岁男性，修长体态。',
      },
    ],
  )

  assert.equal(context.ready, false)
  assert.match(context.blockers[0], /是否实体出镜/)
})

test('explicit offscreen audio identity stays out of frame despite appearance text', () => {
  const context = resolveFrameCharacterContext(
    {
      character_id: 20,
      character_name: '苏岚',
      action_text: '广播机红灯跳亮，喇叭里传出苏岚的声音。',
      visual_prompt: '画面中不出现实体人物，但声音来源明确为苏岚，中年女性，柔和鹅蛋脸。',
    },
    [
      {
        id: 20,
        name: '苏岚',
        role_tag: '母亲 / 广播中的回应者',
        appearance: '中年女性，柔和鹅蛋脸，主要通过广播声音出现。',
        gender: 'female',
        age_group: 'middle_aged',
      },
    ],
  )

  assert.equal(context.ready, true)
  assert.equal(context.characterFree, true)
  assert.deepEqual(context.characters, [])
})

test('subway station wording does not imply a visible audio character', () => {
  const context = resolveFrameCharacterContext(
    {
      character_id: 20,
      character_name: '苏岚',
      action_text: '旧喇叭里传来底噪，像有人在另一端贴近话筒。',
      visual_prompt: '废弃地铁站旧广播机喇叭口特写，画面里只有设备。',
    },
    [
      {
        id: 20,
        name: '苏岚',
        role_tag: '广播中的回应者',
        gender: 'female',
        age_group: 'middle_aged',
      },
    ],
  )

  assert.equal(context.ready, true)
  assert.equal(context.characterFree, true)
  assert.deepEqual(context.characters, [])
})
