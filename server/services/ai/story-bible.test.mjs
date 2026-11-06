import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildStoryBiblePrompts,
  normalizeGeneratedStoryBible,
} from './story-bible.mjs'

const project = {
  id: 12,
  name: '零点回声',
  category: '悬疑推理漫剧',
  visualStyle: '冷峻科幻，冷蓝金属与红色警示灯',
  aspectRatio: '9:16',
}

test('prompt carries the idea plus the style and episode count the creator picked', () => {
  const { systemPrompt, userPrompt } = buildStoryBiblePrompts(project, {
    idea: '深夜广播主持人收到来自十年前的求救电话',
    episodeCount: 6,
  })

  assert.match(systemPrompt, /只返回 JSON/)
  // 输出契约必须写死在提示词里，否则模型会给出一堆无法入库的字段名
  for (const field of [
    'logline',
    'mainPlot',
    'characters',
    'locations',
    'props',
    'worldRules',
    'timeline',
    'relationships',
    'foreshadowing',
    'visualSymbols',
  ]) {
    assert.match(systemPrompt, new RegExp(field))
  }
  assert.match(userPrompt, /深夜广播主持人收到来自十年前的求救电话/)
  assert.match(userPrompt, /冷峻科幻/)
  assert.match(userPrompt, /6 集/)
  assert.match(systemPrompt, /props.*对象数组/u)
  assert.match(systemPrompt, /narrativeRole/u)
  assert.match(systemPrompt, /scriptEvidence/u)
  assert.match(systemPrompt, /visualState/u)
  assert.match(systemPrompt, /剧情推断/u)
  assert.match(systemPrompt, /禁止把推断冒充事实/u)
  assert.match(systemPrompt, /未在剧本明确出现的文字/u)
})

test('prompt asks for the character fields the quality gate actually requires', () => {
  const { systemPrompt } = buildStoryBiblePrompts(project, { idea: 'x', episodeCount: 3 })

  // 这七项是 story-quality 的 CHARACTER_REQUIRED_FIELDS，缺一项角色就过不了门禁
  for (const field of ['name', 'role', 'goal', 'fear', 'secret', 'growthArc', 'visualDescription']) {
    assert.match(systemPrompt, new RegExp(field))
  }
  assert.match(systemPrompt, /主角/)
})

test('generated bible is normalized into exactly the fields the table stores', () => {
  const bible = normalizeGeneratedStoryBible(
    {
      logline: '一通来自十年前的电话',
      mainPlot: '主持人追查真相',
      characters: [
        {
          name: '林夏',
          role: '主角 / 电台主持人',
          goal: '找到电话来源',
          fear: '发现自己是参与者',
          secret: '她删过一盘带子',
          growthArc: '从逃避到直面',
          visualDescription: '短发，深色工装外套',
        },
      ],
      locations: ['电台直播间', '旧居民楼'],
      props: [{ name: '老式开盘录音机', narrativeRole: '保存十年前事故录音', owner: '林夏', visualState: '右侧磁带仓盖缺失', scriptEvidence: '正文写明录音机缺盖' }],
      worldRules: ['电话只在凌晨三点响起'],
      timeline: ['2016 年 直播事故', '2026 年 收到来电'],
      relationships: ['林夏与周衡是同批实习生'],
      foreshadowing: ['第七盘带子始终没出现过'],
      visualSymbols: ['红色 ON AIR 灯'],
    },
    project,
    { episodeCount: 6 },
  )

  assert.equal(bible.logline, '一通来自十年前的电话')
  assert.equal(bible.characters.length, 1)
  assert.equal(bible.characters[0].name, '林夏')
  assert.deepEqual(bible.locations, ['电台直播间', '旧居民楼'])
  assert.deepEqual(bible.props, [{ name: '老式开盘录音机', narrativeRole: '保存十年前事故录音', owner: '林夏', visualState: '右侧磁带仓盖缺失', scriptEvidence: '正文写明录音机缺盖' }])
  assert.deepEqual(bible.worldRules, ['电话只在凌晨三点响起'])
  assert.equal(bible.title, '零点回声')
})

test('character dossiers survive the quality gate shape', () => {
  const bible = normalizeGeneratedStoryBible(
    {
      logline: 'x',
      mainPlot: 'y',
      characters: [
        {
          name: '林夏',
          role: '主角',
          goal: 'g',
          fear: 'f',
          secret: 's',
          growthArc: 'a',
          visualDescription: 'v',
        },
        {
          name: '周衡',
          role: '对手',
          goal: 'g',
          fear: 'f',
          secret: 's',
          growthArc: 'a',
          visualDescription: 'v',
        },
      ],
    },
    project,
  )

  assert.equal(bible.characters.length, 2)
  for (const character of bible.characters) {
    assert.deepEqual(Object.keys(character).sort(), [
      'fear',
      'goal',
      'growthArc',
      'name',
      'role',
      'secret',
      'visualDescription',
    ])
  }
})

test('a model that forgets the protagonist role is repaired instead of failing the gate later', () => {
  const bible = normalizeGeneratedStoryBible(
    {
      logline: 'x',
      mainPlot: 'y',
      characters: [
        { name: '林夏', role: '电台主持人', goal: 'g', fear: 'f', secret: 's', growthArc: 'a', visualDescription: 'v' },
        { name: '周衡', role: '站长', goal: 'g', fear: 'f', secret: 's', growthArc: 'a', visualDescription: 'v' },
      ],
    },
    project,
  )

  // 质量门禁要求至少一名角色定位为「主角」；第一个角色补上这个定位，
  // 而不是生成完让用户在门禁上报错却不知道该改哪个
  assert.match(bible.characters[0].role, /主角/)
})

test('a model that returns nothing usable is rejected rather than saved as an empty bible', () => {
  assert.throws(() => normalizeGeneratedStoryBible(null, project), /没有返回可用/)
  assert.throws(() => normalizeGeneratedStoryBible({}, project), /没有返回可用/)
  assert.throws(
    () => normalizeGeneratedStoryBible({ logline: '', mainPlot: '', characters: [] }, project),
    /没有返回可用/,
  )
})

test('string lists sent as comma text are split instead of stored as one blob', () => {
  const bible = normalizeGeneratedStoryBible(
    {
      logline: 'x',
      mainPlot: 'y',
      characters: [
        { name: '林夏', role: '主角', goal: 'g', fear: 'f', secret: 's', growthArc: 'a', visualDescription: 'v' },
      ],
      locations: '电台直播间，旧居民楼；地下车库',
    },
    project,
  )

  assert.deepEqual(bible.locations, ['电台直播间', '旧居民楼', '地下车库'])
})

test('missing optional list fields become empty arrays, never undefined', () => {
  const bible = normalizeGeneratedStoryBible(
    {
      logline: 'x',
      mainPlot: 'y',
      characters: [
        { name: '林夏', role: '主角', goal: 'g', fear: 'f', secret: 's', growthArc: 'a', visualDescription: 'v' },
      ],
    },
    project,
  )

  for (const field of ['worldRules', 'timeline', 'relationships', 'foreshadowing', 'visualSymbols', 'locations', 'props']) {
    assert.ok(Array.isArray(bible[field]), `${field} 必须是数组`)
  }
})
