import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeCharacterProfilePayload,
  normalizeCharactersPayload,
  normalizeSceneScriptPayload,
  normalizeStoryboardPayload,
} from './parsers.mjs'
import { buildStoryboardPrompts } from './prompts/storyboard.mjs'

test('storyboard character labels resolve to an existing project character name', () => {
  const result = normalizeStoryboardPayload(
    {
      scene_id: 9,
      shots: [
        {
          shot_no: 1,
          character_name: '主角',
          visual_prompt: '主角站在走廊尽头',
        },
      ],
    },
    {
      sceneId: 9,
      scene: { id: 9, estimated_duration: 60 },
      project: { visualStyle: '电影感写实风格' },
      characters: [
        { id: 5, name: '沈砚', role_tag: '主角｜记忆修复师' },
        { id: 6, name: '程默', role_tag: '关键配角' },
      ],
    },
  )

  assert.equal(result.shots[0].character_name, '沈砚')
})

test('storyboard parser does not silently replace an unknown character with another cast member', () => {
  const result = normalizeStoryboardPayload(
    { scene_id: 9, shots: [{ shot_no: 1, character_name: '王' }] },
    {
      sceneId: 9,
      scene: { id: 9, estimated_duration: 60 },
      project: { visualStyle: '电影感写实风格' },
      characters: [{ id: 5, name: '林默' }],
    },
  )

  assert.equal(result.shots[0].character_name, '王')
})

test('character payload removes duplicate names and normalizes voice traits', () => {
  const result = normalizeCharactersPayload({
    characters: [
      { name: '沈砚', role_tag: '主角', voice_setting: 'unknown', age_group: 'middle_aged', gender: 'female' },
      { name: '沈砚', role_tag: '重复角色', voice_setting: 'Cherry' },
      { name: '程默', role_tag: '配角', voice_setting: 'ethan' },
    ],
  })

  assert.deepEqual(
    result.characters.map((item) => item.name),
    ['沈砚', '程默'],
  )
  assert.equal(result.characters[0].voice_setting, null)
  assert.equal(result.characters[0].age_group, 'middle_aged')
  assert.equal(result.characters[0].gender, 'female')
  assert.equal(result.characters[1].voice_setting, 'Ethan')
})

test('character payload removes age-suffix aliases and non-character crowd labels', () => {
  const result = normalizeCharactersPayload({
    characters: [
      { name: ' 唐宁 ', role_tag: '主角' },
      { name: '唐宁（成年）', role_tag: '主角' },
      { name: '赵衡', role_tag: '人事总监' },
      { name: '赵衡', role_tag: '重复角色' },
      { name: '路人甲', role_tag: '群演' },
    ],
  })

  assert.deepEqual(result.characters.map((item) => item.name), ['唐宁', '赵衡'])
})

test('narrative role labels are not persisted as character names', () => {
  const result = normalizeCharactersPayload(
    {
      characters: [
        { name: '主角', role_tag: '主角', appearance: '年轻男性' },
        { name: '林默', role_tag: '主角·程序员', appearance: '黑框眼镜' },
        { name: '赵衡', role_tag: '人事总监' },
      ],
    },
    {
      scenes: [{
        title: '死后三天',
        content: '主角林默深夜回家，收到一封来自死者的邮件。',
      }],
    },
  )

  assert.deepEqual(result.characters.map((item) => item.name), ['林默', '赵衡'])
  assert.equal(result.characters[0].role_tag, '主角')
})

test('current script evidence fixes Lin Mo as male when the model returns a wrong gender', () => {
  const result = normalizeCharactersPayload(
    {
      characters: [
        { name: '林默', role_tag: '女主角', gender: 'female', appearance: '年轻程序员' },
      ],
    },
    {
      scenes: [{
        title: '深夜公寓客厅',
        content: '林默穿着黑色丧服。他坐在沙发里，低头翻找咖啡杯垫。',
      }],
    },
  )

  assert.equal(result.characters[0].name, '林默')
  assert.equal(result.characters[0].gender, 'male')
})

test('explicit appearance evidence fixes a wrong gender label', () => {
  const result = normalizeCharactersPayload(
    {
      characters: [
        { name: '赵衡', role_tag: '人事总监', gender: 'female', appearance: '38岁男性，短黑发，体态挺拔。' },
      ],
    },
    { scenes: [{ title: '合规会议室', content: '赵衡以人事总监身份向唐宁施压。' }] },
  )

  assert.equal(result.characters[0].gender, 'male')
})

test('explicit narrative role evidence fixes a wrong gender label', () => {
  const result = normalizeCharactersPayload({
    characters: [
      { name: '唐宁', role_tag: '女主角/合规专员/拒签者', gender: 'male', appearance: '28岁东亚女性。' },
    ],
  })

  assert.equal(result.characters[0].gender, 'female')
})

test('character identity evidence wins over male language from the shared scene', () => {
  const result = normalizeCharactersPayload(
    {
      characters: [
        { name: '唐宁', role_tag: '女主角/合规专员/拒签者', gender: 'male', appearance: '28岁，浅蓝衬衫。' },
      ],
    },
    {
      scenes: [{ content: '赵衡站在她身后，老板的遗言提到父亲，男人抬手关闭屏幕。' }],
    },
  )

  assert.equal(result.characters[0].gender, 'female')
})

test('current script evidence removes characters carried over from a stale outline', () => {
  const result = normalizeCharactersPayload(
    {
      characters: [
        { name: '林默', role_tag: '主角', gender: 'male' },
        { name: '陈志远', role_tag: '已故老板', gender: 'male' },
        { name: '唐宁', role_tag: '女主角', gender: 'female' },
        { name: '赵衡', role_tag: '人事总监', gender: 'male' },
      ],
    },
    {
      strictScriptEvidence: true,
      outline: {
        premise: '唐宁收到赵启明的邮件。',
      },
      scenes: [
        {
          title: '深夜公寓客厅',
          content: '林默穿着黑色丧服，电脑屏幕自动亮起。发件人是陈志远。',
        },
      ],
    },
  )

  assert.deepEqual(result.characters.map((item) => item.name), ['林默', '陈志远'])
})

test('character payload preserves a separate costume baseline and profile fallback', () => {
  const extracted = normalizeCharactersPayload({
    characters: [
      {
        name: '沈砚',
        appearance: '黑发，左眉浅疤。',
        costume: '深灰长风衣，银色怀表。',
      },
    ],
  })
  assert.equal(extracted.characters[0].costume, '深灰长风衣，银色怀表。')

  const profile = normalizeCharacterProfilePayload(
    { appearance: '黑发，左眉浅疤。' },
    {
      name: '沈砚',
      costume: '深灰长风衣，银色怀表。',
    },
  )
  assert.equal(profile.costume, '深灰长风衣，银色怀表。')
})

test('scene script parser recovers concrete location and time from generated content', () => {
  const result = normalizeSceneScriptPayload(
    {
      scene_no: 1,
      title: '发件人：陈志远',
      summary: '林默收到已故老板的邮件。',
      content: '深夜，公寓里没有开灯。林默陷在沙发里，电脑屏幕自动亮起。',
      location: '',
      time_of_day: '',
      estimated_duration: 120,
    },
    { scene: { scene_no: 1, title: '发件人：陈志远', summary: '林默收到邮件。' } },
  )

  assert.equal(result.location, '深夜公寓客厅')
  assert.equal(result.time_of_day, '深夜')
})

test('storyboard prompts include the established character bible', () => {
  const prompts = buildStoryboardPrompts({
    project: { name: '记忆修复', visualStyle: '冷色电影感' },
    scene: { scene_no: 1, title: '走廊', content: '沈砚走进走廊。' },
    scriptContent: '沈砚走进走廊。',
    characters: [
      {
        name: '沈砚',
        role_tag: '主角｜记忆修复师',
        gender: 'female',
        age_group: 'young_adult',
        appearance: '黑色短发，深灰制服，右眉有细疤。',
      },
    ],
  })

  assert.match(prompts.systemPrompt, /准确姓名/)
  assert.match(prompts.userPrompt, /姓名=沈砚/)
  assert.match(prompts.userPrompt, /右眉有细疤/)
  assert.match(prompts.userPrompt, /性别=female/)
  assert.match(prompts.userPrompt, /年龄段=young_adult/)
  assert.match(prompts.systemPrompt, /绝对不能改变角色性别/)
  assert.match(prompts.systemPrompt, /身份、性别、年龄、脸型、发型、服装和配饰由已确认角色资产提供/)
  assert.doesNotMatch(prompts.systemPrompt, /角色资产板必须一次生成/)
})

test('storyboard agent plans durations privately and keeps the visible prompt in shot-sheet format', () => {
  const { systemPrompt } = buildStoryboardPrompts({
    scene: { id: 9, estimated_duration: 60, content: '人物停顿后说出关键台词。' },
    project: { visualStyle: '半写实 CG' },
  })
  assert.match(systemPrompt, /第一镜同样必须有有效规划/u)
  assert.match(systemPrompt, /duration_breakdown/)
  assert.match(systemPrompt, /duration_basis/)
  assert.match(systemPrompt, /duration_breakdown 和 duration_basis 只用于系统内部校验/u)
  assert.match(systemPrompt, /绝对不得写入 visual_prompt/u)
  assert.match(systemPrompt, /时间轴：/u)
  assert.match(systemPrompt, /位置：/u)
  assert.match(systemPrompt, /要求：/u)
})

test('storyboard parser never repairs missing, zero, negative or fractional durations', () => {
  for (const duration of [undefined, 0, -1, 2.5]) {
    const result = normalizeStoryboardPayload({
      shots: [{ shot_no: '01', duration_seconds: duration }],
    }, {
      sceneId: 9,
      scene: { id: 9, estimated_duration: 60 },
      project: { visualStyle: '半写实 CG' },
    })
    assert.equal(result.shots[0].duration_seconds, duration ?? null)
  }
})

test('storyboard parser builds a timed shot sheet when the agent omits visual_prompt', () => {
  const result = normalizeStoryboardPayload({
    shots: [{
      shot_no: 1,
      duration_seconds: 5,
      duration_breakdown: [
        { phase: '动作', seconds: 3, observable: '传送窗口滑出红色发卡' },
        { phase: '反应', seconds: 2, observable: '林知夏抬眼锁定发卡' },
      ],
      duration_basis: '动作结束后留出反应时间。',
      character_name: '林知夏',
      character_assets: ['林知夏'],
      scene_assets: ['失物招领处'],
      prop_assets: ['红色发卡'],
      action_text: '传送窗口滑出红色发卡，林知夏抬眼锁定。',
      dialogue_text: '（无对白）',
    }],
  }, {
    scene: { id: 9, estimated_duration: 60 },
    project: { visualStyle: '半写实 CG' },
    characters: [{ id: 5, name: '林知夏' }],
  })

  assert.match(result.shots[0].visual_prompt, /时间轴：0-3秒，传送窗口滑出红色发卡；3-5秒，林知夏抬眼锁定发卡/u)
  assert.match(result.shots[0].visual_prompt, /镜头：中景，平视/u)
  assert.match(result.shots[0].visual_prompt, /@林知夏、@失物招领处、@红色发卡/u)
  assert.doesNotMatch(result.shots[0].visual_prompt, /duration_basis|时长依据/u)
})

test('storyboard parser repairs only a broken visible timeline from valid private duration evidence', () => {
  const result = normalizeStoryboardPayload({
    shots: [{
      shot_no: 1,
      duration_seconds: 5,
      duration_breakdown: [
        { phase: '触发', seconds: 2, observable: '传送窗口亮起并开始滑动' },
        { phase: '动作', seconds: 2, observable: '红色发卡随托盘移出台面' },
        { phase: '反应', seconds: 1, observable: '林知夏抬头锁定发卡' },
      ],
      duration_basis: '动作链需要完成并保留反应停顿。',
      character_name: '林知夏',
      character_assets: ['林知夏'],
      scene_assets: ['场景01'],
      prop_assets: ['红色发卡'],
      visual_prompt: '@林知夏、@场景01、@红色发卡；时间轴：0-5秒，画面保持静止；镜头：中景，固定机位；动作：窗口滑出发卡，人物抬头；要求：动作连续；声音：机械滑动声持续。',
    }],
  }, {
    scene: { id: 9, estimated_duration: 60 },
    project: { visualStyle: '半写实 CG' },
    characters: [{ id: 5, name: '林知夏' }],
  })

  assert.match(result.shots[0].visual_prompt, /时间轴：0-2秒，传送窗口亮起并开始滑动；2-4秒，红色发卡随托盘移出台面；4-5秒，林知夏抬头锁定发卡/u)
  assert.match(result.shots[0].visual_prompt, /镜头：中景，固定机位/u)
  assert.match(result.shots[0].visual_prompt, /动作：窗口滑出发卡，人物抬头/u)
  assert.match(result.shots[0].visual_prompt, /声音：机械滑动声持续/u)
  assert.match(result.shots[0].visual_prompt, /@林知夏、@场景01、@红色发卡/u)
})

test('storyboard parser repairs multiline shot-sheet timelines without swallowing later fields', () => {
  const result = normalizeStoryboardPayload({
    shots: [{
      duration_seconds: 5,
      duration_breakdown: [
        { phase: '准备', seconds: 2, observable: '沈岚低头整理登记单' },
        { phase: '触发', seconds: 2, observable: '手机亮起并震动' },
        { phase: '反应', seconds: 1, observable: '沈岚抬眼看向取件柜' },
      ],
      visual_prompt: '@沈岚；时间轴：\n0-5秒，模型错误地把动作压成一段\n镜头：中近景，平视；位置：柜台前；动作：手机亮起后抬眼。',
    }],
  }, {
    scene: { id: 9, estimated_duration: 60 },
    project: { visualStyle: '半写实 CG' },
    characters: [{ id: 5, name: '沈岚' }],
  })

  assert.match(result.shots[0].visual_prompt, /时间轴：0-2秒，沈岚低头整理登记单；2-4秒，手机亮起并震动；4-5秒，沈岚抬眼看向取件柜/u)
  assert.match(result.shots[0].visual_prompt, /镜头：中近景，平视；位置：柜台前；动作：手机亮起后抬眼/u)
  assert.doesNotMatch(result.shots[0].visual_prompt, /模型错误地把动作压成一段/u)
})

test('storyboard parser does not invent a timeline when duration evidence is invalid', () => {
  const result = normalizeStoryboardPayload({
    shots: [{
      duration_seconds: 5,
      duration_breakdown: [{ phase: '动作', seconds: 4, observable: '窗口滑动' }],
      visual_prompt: '镜头：中景；动作：窗口滑动。',
    }],
  }, {
    scene: { id: 9, estimated_duration: 60 },
    project: { visualStyle: '半写实 CG' },
    characters: [],
  })

  assert.doesNotMatch(result.shots[0].visual_prompt, /时间轴：/u)
  assert.match(result.shots[0].visual_prompt, /镜头：中景/u)
})

test('storyboard parser keeps private duration evidence out of the visible video prompt', () => {
  const result = normalizeStoryboardPayload({
    shots: [{
      duration_seconds: 5,
      duration_breakdown: [
        { phase: '动作', seconds: 3, observable: '发卡滑出并停住' },
        { phase: '反应', seconds: 2, observable: '人物抬眼锁定发卡' },
      ],
      duration_basis: '动作完成和反应停顿需要五秒。',
      visual_prompt: '中景，发卡滑出，人物抬眼；duration_basis：动作完成和反应停顿需要五秒；时长拆解：动作3秒，反应2秒。',
    }],
  }, {
    scene: { id: 9, estimated_duration: 60 },
    project: { visualStyle: '半写实 CG' },
    characters: [],
  })

  assert.deepEqual(result.shots[0].duration_breakdown, [
    { phase: '动作', seconds: 3, observable: '发卡滑出并停住' },
    { phase: '反应', seconds: 2, observable: '人物抬眼锁定发卡' },
  ])
  assert.equal(result.shots[0].duration_basis, '动作完成和反应停顿需要五秒。')
  assert.doesNotMatch(result.shots[0].visual_prompt, /duration_breakdown|duration_basis|时长依据|时长拆解|动作完成和反应停顿/u)
})

test('storyboard prompts include the confirmed scene, prop and tool catalog for executable mentions', () => {
  const prompts = buildStoryboardPrompts({
    project: { name: '死去的老板给我发邮件', visualStyle: '冷峻职场悬疑' },
    scene: { scene_no: 1, title: '别签字', content: '唐宁看向离职协议，手机和电脑同时亮起。' },
    scriptContent: '唐宁看向离职协议，手机和电脑同时亮起。',
    characters: [{ name: '唐宁', gender: 'female', age_group: 'young_adult', appearance: '浅蓝衬衫、米色西装外套' }],
    assetCatalog: {
      scenes: [{ name: '合规办公室', sceneViewKeys: ['front', 'right'] }],
      props: [{ name: '离职协议', promptText: '白色纸质协议' }, { name: '手机', promptText: '黑色手机' }],
      tools: ['片段衔接', '首尾帧参考'],
    },
  })

  assert.match(prompts.userPrompt, /场景资产清单/)
  assert.match(prompts.userPrompt, /合规办公室/)
  assert.match(prompts.userPrompt, /道具资产清单/)
  assert.match(prompts.userPrompt, /离职协议/)
  assert.match(prompts.userPrompt, /工具清单：片段衔接、首尾帧参考/)
  assert.match(prompts.systemPrompt, /严格从下方清单选择/)
  assert.match(prompts.systemPrompt, /每条视觉提示词控制在一个可执行镜头内/)
  assert.match(prompts.systemPrompt, /准确的@资产引用/)
})

test('storyboard parser preserves the compact shot sheet without re-appending structured performance fields', () => {
  const visualPrompt = [
    '@沈砚、@旧城区街口、@手机、@音色[沈砚]',
    '时间轴：0-2秒，沈砚低头看手机；2-5秒，他抬眼看向门口并停住。',
    '镜头：中近景，平视固定机位。',
    '位置：沈砚在画面右侧，门口位于背景左侧。',
    '动作：手机亮起后，沈砚抬眼锁定门口。',
    '要求：眼神变化清晰可见，手机界面文字留白供后期合成。',
    '对白：沈砚：“别回头。”',
    '声音：压低声线说出对白，门外传来短促脚步声。',
  ].join('；')
  const result = normalizeStoryboardPayload({
    shots: [{
      shot_no: 1,
      character_name: '沈砚',
      character_assets: ['沈砚'],
      scene_assets: ['旧城区街口'],
      prop_assets: ['手机'],
      action_text: '沈砚抬眼看向门口。',
      dialogue_text: '别回头。',
      acting_beat: '先停顿，再抬眼锁定门口。',
      emotional_change: '从专注转为警觉。',
      audio_direction: '压低声音，句尾收紧。',
      visual_prompt: visualPrompt,
    }],
  }, {
    scene: { id: 9, estimated_duration: 60 },
    project: { visualStyle: '电影感写实风格' },
    characters: [{ id: 5, name: '沈砚' }],
  })

  assert.equal(result.shots[0].visual_prompt, visualPrompt)
  assert.equal(result.shots[0].acting_beat, '先停顿，再抬眼锁定门口。')
  assert.equal(result.shots[0].audio_direction, '压低声音，句尾收紧。')
})

test('storyboard payload preserves performance beats and speech timing policy', () => {
  const result = normalizeStoryboardPayload(
    {
      scene_id: 9,
      shots: [
        {
          shot_no: 1,
          character_name: '沈砚',
          action_text: '沈砚抬头。',
          dialogue_text: '别回头。',
          shot_purpose: 'dialogue',
          acting_beat: '先停顿，再压低声音说出警告。',
          audio_direction: '压低声音，警告感，句尾收紧。',
          speech_duration_policy: 'preserve',
          reaction_shot: false,
        },
      ],
    },
    {
      sceneId: 9,
      scene: { id: 9, estimated_duration: 60 },
      project: { visualStyle: '电影感写实风格' },
      characters: [{ id: 5, name: '沈砚' }],
    },
  )

  assert.equal(result.shots[0].shot_purpose, 'dialogue')
  assert.equal(result.shots[0].acting_beat, '先停顿，再压低声音说出警告。')
  assert.equal(result.shots[0].audio_direction, '压低声音，警告感，句尾收紧。')
  assert.equal(result.shots[0].speech_duration_policy, 'preserve')
  assert.equal(result.shots[0].reaction_shot, false)
  assert.doesNotMatch(result.shots[0].visual_prompt, /情绪变化：|微表演与动作节拍：|声音、停顿与口型同步：/)
  assert.match(result.shots[0].visual_prompt, /@沈砚/u)
})

test('storyboard parser carries ordered gaze and sound plans into the executable prompt and reference data', () => {
  const result = normalizeStoryboardPayload({
    shots: [{
      shot_no: 1,
      duration_seconds: 8,
      duration_breakdown: [
        { phase: '触发', seconds: 3, observable: '发卡滑出' },
        { phase: '视线', seconds: 5, observable: '人物看向出口灯' },
      ],
      duration_basis: '动作与两次视线落点需要完整时长。',
      character_name: '林知夏',
      character_assets: ['林知夏'],
      scene_assets: ['失物招领处'],
      prop_assets: ['红色发卡'],
      action_text: '林知夏先看红色发卡，再看绿色安全出口灯。',
      dialogue_text: '（无对白）',
      gaze_plan: {
        start_target: '@电脑屏幕',
        transitions: [
          { from_second: 0, to_second: 3, target: '@红色发卡' },
          { from_second: 3, to_second: 8, target: '@绿色安全出口灯' },
        ],
        end_target: '@绿色安全出口灯',
        eye_lead: '眼睛先动，头部延迟半拍跟随',
      },
      sound_plan: {
        bed: '持续夜班值班台通风低鸣',
        cues: [{ at_second: 1, sound: '传送窗口机械滑动声', sync_action: '托盘滑出' }],
        silence_policy: '无对白但底噪不断',
      },
      visual_prompt: '@林知夏、@失物招领处、@红色发卡；时间轴：0-3秒，发卡滑出；3-8秒，视线转向出口灯。',
    }],
  }, {
    scene: { id: 9, estimated_duration: 60 },
    project: { visualStyle: '半写实 CG' },
    characters: [{ id: 5, name: '林知夏' }],
  })

  assert.match(result.shots[0].visual_prompt, /视线：/u)
  assert.match(result.shots[0].visual_prompt, /红色发卡/u)
  assert.match(result.shots[0].visual_prompt, /声音：/u)
  assert.equal(result.shots[0].gaze_plan.transitions.length, 2)
  assert.equal(result.shots[0].sound_plan.cues[0].sound, '传送窗口机械滑动声')
})

test('storyboard payload preserves prop mentions, tools and keyframe prompts', () => {
  const result = normalizeStoryboardPayload(
    {
      scene_id: 9,
      shots: [{
        shot_no: 1,
        character_name: '沈砚',
        character_assets: ['沈砚'],
        scene_assets: ['旧城区街口'],
        prop_assets: ['手机', '钥匙'],
        tools: ['片段衔接'],
        start_visual_prompt: '上一镜尾帧承接。',
        end_visual_prompt: '手机屏幕亮起后停住。',
      }],
    },
    {
      sceneId: 9,
      scene: { id: 9, estimated_duration: 60 },
      project: { visualStyle: '电影感写实风格' },
      characters: [{ id: 5, name: '沈砚' }],
    },
  )

  assert.deepEqual(result.shots[0].prop_assets, ['手机', '钥匙'])
  assert.deepEqual(result.shots[0].tools, ['片段衔接'])
  assert.equal(result.shots[0].start_visual_prompt, '上一镜尾帧承接。')
  assert.equal(result.shots[0].end_visual_prompt, '手机屏幕亮起后停住。')
})

test('storyboard normalization strips leaked image-generation template from executable shot text', () => {
  const result = normalizeStoryboardPayload({
    shots: [{
      character_name: '沈砚',
      dialogue_text: '别回头。',
      visual_prompt: [
        '@沈砚、@旧城区街口；沈砚听见声响后停住并低声说“别回头”。',
        '提示词模板技能：prompt-template-skill-v1',
        '角色资产板必须一次生成横向16:9的一张完整母板。',
      ].join('\n'),
    }],
  }, {
    scene: { id: 9, estimated_duration: 60 },
    project: { visualStyle: '电影感写实风格' },
    characters: [{ id: 5, name: '沈砚' }],
  })

  assert.match(result.shots[0].visual_prompt, /沈砚听见声响后停住并低声说“别回头”/)
  assert.doesNotMatch(result.shots[0].visual_prompt, /prompt-template-skill|资产板必须一次生成/)
})
