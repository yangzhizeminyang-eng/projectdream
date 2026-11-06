import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildFrameConsistencyPrompt,
  createFrameCharacterSnapshot,
  isHandOnlyShot,
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

test('character snapshots persist reference storage keys instead of signed URLs', () => {
  const context = resolveFrameCharacterContext(
    {
      character_id: 11,
      character_name: '沈砚',
      action_text: '沈砚站在档案室窗前。',
      visual_prompt: '沈砚站在暴雨中的档案室。',
    },
    [
      {
        ...characters[0],
        reference_image_storage_key: 'projects/12/frames/characters/11/v2/c1.png',
        reference_image_url: null,
      },
    ],
  )

  const snapshot = createFrameCharacterSnapshot(context)

  assert.equal(
    snapshot.characters[0].referenceImageStorageKey,
    'projects/12/frames/characters/11/v2/c1.png',
  )
  assert.equal(snapshot.characters[0].referenceImageUrl, undefined)
  assert.deepEqual(
    buildFrameConsistencyPrompt({ storyboard: {}, context }).referenceImageStorageKeys,
    ['projects/12/frames/characters/11/v2/c1.png'],
  )
  assert.deepEqual(
    buildFrameConsistencyPrompt({ storyboard: {}, context }).referenceImageUrls,
    [],
    'when a stable object key exists, the expiring signed URL must not be captured as task input',
  )
})

test('frame constraints carry the active character version and fixed costume', () => {
  const versionedCharacters = [
    {
      ...characters[0],
      costume: '深灰制服，银色识别牌',
      character_version_no: 4,
    },
  ]
  const storyboard = {
    character_id: 11,
    character_name: '沈砚',
    action_text: '沈砚站在档案室窗前。',
    visual_prompt: '沈砚站在暴雨中的档案室。',
  }
  const context = resolveFrameCharacterContext(storyboard, versionedCharacters)
  const result = buildFrameConsistencyPrompt({ storyboard, context })
  const snapshot = createFrameCharacterSnapshot(context)

  assert.equal(context.ready, true)
  assert.equal(context.characters[0].costume, '深灰制服，银色识别牌')
  assert.equal(context.characters[0].characterVersionNo, 4)
  assert.match(result.prompt, /固定服装与随身物件=深灰制服，银色识别牌/)
  assert.match(result.prompt, /角色版本=v4/)
  assert.equal(snapshot.characters[0].characterVersionNo, 4)
  assert.equal(snapshot.characters[0].costume, '深灰制服，银色识别牌')
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

test('continuity contract constrains a hand-only prop shot even when a character is bound', () => {
  const storyboard = {
    character_id: 11,
    character_name: '沈砚',
    action_text: '只拍沈砚的手、签字笔、协议和手机；手机突然亮起。',
    visual_prompt: '只拍沈砚的手、签字笔、协议和手机，不出现其他人物。',
    continuity_contract_json: JSON.stringify({
      visibleEntities: ['签字笔', '协议', '手机'],
      forbiddenEntities: ['其他人物', '脸部', '完整上半身'],
      primarySubject: '手机与签字笔',
      primaryAction: '手机亮起，手部动作停住。',
    }),
  }
  const context = resolveFrameCharacterContext(storyboard, characters)
  const result = buildFrameConsistencyPrompt({ storyboard, context })

  assert.match(result.prompt, /【画面实体边界】/)
  assert.match(result.prompt, /只允许出现：签字笔、协议、手机/)
  assert.match(result.prompt, /不得出现角色的脸、头部、完整上半身/)
  assert.match(result.negativePrompt, /脸部/)
})

test('does not treat a name inside phone text as a visible character', () => {
  const storyboard = {
    character_id: 11,
    character_name: '沈砚',
    action_text: '只拍沈砚的手和手机。',
    visual_prompt: '只拍沈砚的手和手机；手机屏幕显示“程默：别进来”。',
  }
  const context = resolveFrameCharacterContext(storyboard, characters)

  assert.equal(context.ready, true)
  assert.deepEqual(context.characters.map((item) => item.name), ['沈砚'])
})

test('does not send face references for a hand-only prop shot', () => {
  const storyboard = {
    character_id: 11,
    character_name: '沈砚',
    action_text: '只拍沈砚的手、签字笔和手机。',
    visual_prompt: '只拍沈砚的手、签字笔和手机，不出现脸部或完整上半身。',
    continuity_contract_json: JSON.stringify({
      visibleEntities: ['签字笔', '手机'],
      forbiddenEntities: ['脸部', '完整上半身'],
      primarySubject: '手机与签字笔',
      primaryAction: '手部停住，手机亮起。',
    }),
  }
  const context = resolveFrameCharacterContext(storyboard, characters)
  const result = buildFrameConsistencyPrompt({ storyboard, context })

  assert.deepEqual(result.referenceImageUrls, [])
  assert.match(result.prompt, /准确中文由后期叠加/)
  assert.doesNotMatch(result.prompt, /固定外貌=/)
  assert.doesNotMatch(result.prompt, /同一张脸/)
  assert.match(result.prompt, /仅局部手部身份/)
})

test('treats an explicitly hand-only shot as local even without a face exclusion sentence', () => {
  const storyboard = {
    character_id: 11,
    character_name: '沈砚',
    action_text: '只拍沈砚的手、签字笔、协议和手机；手机突然亮起。',
    visual_prompt: '黑色签字笔停在离职协议上方，手机突然亮起。',
  }
  const context = resolveFrameCharacterContext(storyboard, [
    {
      ...characters[0],
      costume: '深灰衬衫、米色西装外套、米色西裤、银色腕表、白色低跟鞋',
      reference_image_storage_key: 'projects/12/characters/11/v1/c1.png',
    },
  ])
  const result = buildFrameConsistencyPrompt({ storyboard, context })

  assert.deepEqual(result.referenceImageUrls, [])
  assert.deepEqual(result.referenceImageStorageKeys, [])
  assert.match(result.prompt, /仅局部手部身份/)
  assert.doesNotMatch(result.prompt, /固定外貌=/)
  assert.doesNotMatch(result.prompt, /同一张脸/)
  assert.doesNotMatch(result.prompt, /米色西裤/)
  assert.doesNotMatch(result.prompt, /白色低跟鞋/)
  assert.match(result.prompt, /只保留袖口与腕表/)
})

test('recognizes hand-only framing from the storyboard action alone', () => {
  assert.equal(
    isHandOnlyShot({
      action_text: '只拍唐宁的手、签字笔、协议和手机；手机突然亮起。',
      visual_prompt: '桌面特写。',
    }),
    true,
  )
})

test('removes exact screen copy from a hand-only image prompt', () => {
  const storyboard = {
    character_id: 11,
    character_name: '沈砚',
    action_text: '只拍沈砚的手、签字笔、协议和手机；手机突然亮起。',
    visual_prompt:
      '只拍沈砚的手、签字笔、《离职及保密协议》和手机；手机屏幕清楚显示“赵启明：别签字。”，屏幕文字必须为简体中文且只出现这一句。',
  }
  const context = resolveFrameCharacterContext(storyboard, characters)
  const result = buildFrameConsistencyPrompt({ storyboard, context })

  assert.doesNotMatch(result.prompt, /手机屏幕清楚显示/)
  assert.doesNotMatch(result.prompt, /屏幕文字必须为简体中文/)
  assert.doesNotMatch(result.prompt, /离职及保密协议/)
  assert.match(result.prompt, /空白法律文件/)
  assert.match(result.prompt, /手机屏幕保持留白/)
})

test('hand-only prop shots suppress the office background and generated document text', () => {
  const storyboard = {
    character_id: 11,
    character_name: '沈砚',
    action_text: '只拍沈砚的手、签字笔、空白法律文件和手机；手机突然亮起。',
    visual_prompt: '冷色办公室夜景，电脑蓝光，桌面特写，签字笔停在文件上方，手机亮起。',
    continuity_contract_json: JSON.stringify({
      visibleEntities: ['签字笔', '空白法律文件', '手机'],
      forbiddenEntities: ['其他人物', '脸部', '完整上半身', '显示器', '台灯', '键盘', '随机文字'],
      primarySubject: '手机与签字笔',
      primaryAction: '签字笔停住，手机亮起。',
    }),
  }
  const context = resolveFrameCharacterContext(storyboard, characters)
  const result = buildFrameConsistencyPrompt({
    storyboard,
    context,
    projectVisualStyle: '写实都市悬疑漫剧，冷白办公室与电脑蓝光，竖屏',
  })

  assert.match(result.prompt, /局部手部静物特写/)
  assert.match(result.prompt, /不出现躯干、胸口、肩膀/)
  assert.match(result.prompt, /背景只保留不可辨认的浅景深色块/)
  assert.match(result.prompt, /所有文件和屏幕保持无文字留白/)
  assert.match(result.negativePrompt, /显示器/)
  assert.match(result.negativePrompt, /台灯/)
  assert.match(result.negativePrompt, /随机文字/)
})
