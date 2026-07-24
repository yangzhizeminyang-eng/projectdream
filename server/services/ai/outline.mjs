/**
 * @file 总纲 AI 服务
 * @description 支持 mock / real provider 双模式。真实模式失败时可按配置回退 mock。
 */

import { getAiConfig, isMockProvider } from './config.mjs'
import { normalizeOutlinePayload } from './parsers.mjs'
import { buildOutlinePrompts } from './prompts/outline.mjs'
import { generateStructuredJson } from './provider.mjs'

const ACT_TEMPLATES = [
  {
    act: 1,
    title: '建置与钩子',
    summary: '建立世界观与主角的初始状态，用一个强事件把观众拽进故事。',
  },
  {
    act: 2,
    title: '冲突与升级',
    summary: '主角被迫偏离计划，目标代价不断升高，对手的能力被反复确认。',
  },
  {
    act: 3,
    title: '高潮与抉择',
    summary: '所有伏笔兑现，主角在极端压力下做出选择，留下开放或闭合的结局。',
  },
]

const LOCATION_POOL = ['废弃实验室', '雨夜街头', '霓虹走廊', '地下档案室', '悬浮列车', '旧城天台', '寂静海滩']
const TIME_POOL = ['夜', '晨', '黄昏', '深夜', '午后', '拂晓']

/**
 * @description 伪随机：根据项目名取稳定 hash，保证同一项目多次生成的总纲结构稳定
 * @param {string} seed
 * @returns {() => number} 0-1 之间的伪随机函数
 */
function seededRandom(seed) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return () => {
    h ^= h << 13
    h ^= h >>> 17
    h ^= h << 5
    return ((h >>> 0) % 10000) / 10000
  }
}

function pick(arr, rand) {
  return arr[Math.floor(rand() * arr.length)]
}

/**
 * @description 生成三幕结构 + 场景列表
 * @param {object} project 项目信息
 * @param {string} project.name 项目名
 * @param {string} [project.category] 题材
 * @param {string} [project.narrativeVision] 世界观
 * @param {string} [project.visualStyle] 视觉风格
 * @param {number} [project.targetDuration] 目标时长（分钟）
 * @returns {Promise<object>} 结构化总纲
 */
function generateMockOutline(project) {
  const rand = seededRandom(`${project.name}-${project.id || 'new'}`)
  const category = project.category || '科幻剧情片'

  // 估算场景数：每 8-12 分钟一个场景
  const duration = Number(project.targetDuration) || 90
  const sceneCount = Math.max(4, Math.min(12, Math.round(duration / 10)))

  const logline = `${project.name || '这个故事'} 讲述了一个在${category}背景下，被迫打破自身规则的主角，意外触发连锁反应的故事。`

  const premise =
    project.narrativeVision ||
    '一座被霓虹吞没的城市，记忆成了可被买卖的违禁品。主角作为清道夫，第一次发现自己的记忆也成了某场交易的目标。'

  const acts = ACT_TEMPLATES.map((template, index) => ({
    act: template.act,
    title: template.title,
    summary:
      index === 0
        ? `${template.summary} 场景切入：${pick(LOCATION_POOL, rand)}。`
        : index === 1
          ? `${template.summary} 关键抉择发生在 ${pick(LOCATION_POOL, rand)}。`
          : `${template.summary} 终局落点：${pick(LOCATION_POOL, rand)}。`,
  }))

  const scenes = Array.from({ length: sceneCount }, (_, i) => {
    const sceneNo = i + 1
    const isMid = sceneNo > 1 && sceneNo < sceneCount
    const location = pick(LOCATION_POOL, rand)
    const time = pick(TIME_POOL, rand)
    const minutes = Math.max(2, Math.round(duration / sceneCount))

    const titles = [
      '钩子开场',
      '平静被打破',
      '关键情报',
      '第一次对峙',
      '代价浮出水面',
      '盟友出现',
      '真相一角',
      '中点反转',
      '被迫上路',
      '最终决战',
      '余波',
      '尾声',
    ]
    const title = titles[(sceneNo - 1) % titles.length]
    const summary = isMid
      ? `主角在 ${location}（${time}）收到关于核心秘密的线索，${pick(['信任', '怀疑', '拒绝', '接受'], rand)}。`
      : sceneNo === 1
        ? `用极短时间建立主角身份和世界规则，第一场戏就抛出不寻常的信号。`
        : `收束所有线索，${pick(['角色', '城市', '情感'], rand)}的命运在此定型。`

    return {
      scene_no: sceneNo,
      title,
      summary,
      location,
      time_of_day: time,
      estimated_duration: minutes * 60,
    }
  })

  return {
    title: project.name || '未命名项目',
    logline,
    premise,
    visual_style: project.visualStyle || '黑色电影 / 高反差夜景',
    acts,
    scenes,
  }
}

export async function generateOutline(project) {
  const config = getAiConfig()
  if (isMockProvider(config)) {
    return generateMockOutline(project)
  }

  const { systemPrompt, userPrompt } = buildOutlinePrompts(project)

  try {
    const result = await generateStructuredJson({
      task: 'outline',
      systemPrompt,
      userPrompt,
      model: config.outlineModel,
      temperature: 0.8,
    })
    return normalizeOutlinePayload(result.json, project)
  } catch (error) {
    console.error('[ai:outline]', error)
    if (config.fallbackToMock) {
      console.warn('[ai:outline] real provider failed, fallback to mock')
      return generateMockOutline(project)
    }
    throw error
  }
}
