/**
 * @file 场景剧本 AI 服务
 * @description 支持 mock / real provider 双模式。真实模式失败时可按配置回退 mock。
 */

import { getAiConfig, isMockProvider } from './config.mjs'
import { normalizeSceneScriptPayload } from './parsers.mjs'
import { buildSceneScriptPrompts } from './prompts/script.mjs'
import { generateStructuredJson } from './provider.mjs'

const BEAT_TEMPLATES = [
  {
    setup: '画面停留，环境细节被强调。',
    development: '角色做出一个微小但关键的选择。',
    escalation: '外部信号介入，氛围被打破。',
    turn: '角色被迫回应，刚刚的选择引发连锁反应。',
    resolution: '场景在不安的安静中收束，伏笔被压进下一场。',
  },
]

function pickByIndex(arr, index) {
  return arr[index % arr.length]
}

/**
 * @description 生成单场戏的完整剧本
 * @param {object} ctx
 * @param {object} ctx.scene 场景信息（title/summary/location/time_of_day）
 * @param {object} ctx.outline 总纲
 * @param {object} ctx.project 项目
 * @returns {Promise<object>} 单场戏剧本结构
 */
function generateMockSceneScript(ctx) {
  const scene = ctx.scene || {}
  const outline = ctx.outline || {}
  const project = ctx.project || {}

  const title = scene.title || '未命名场景'
  const location = scene.location || '未知地点'
  const time = scene.time_of_day || '夜'
  const summary = scene.summary || ''

  const beat = pickByIndex(BEAT_TEMPLATES, (scene.scene_no || 1) - 1)

  const content = `【场景 ${String(scene.scene_no || 1).padStart(2, '0')}】${location} - ${time}

${beat.setup} ${summary || '故事在这里翻开新的一页。'}

${beat.development} 主角停住呼吸，让远处的噪音自己消解。世界仍然在转，但主角已经知道——这场戏的真正节奏，由他自己决定。

${beat.escalation} 一束非常规的信号穿透了环境，${title} 的真正含义在这一刻被压到桌面。

${beat.turn} 主角没有立刻回应。他/她选择先看清来路，再决定是否要承担起回应之后的代价。

${beat.resolution} 镜头缓缓拉远。城市的底噪重新涌回。${outline.title || project.name || '本片'}的叙事在这里被轻轻推了一格。
`.trim()

  const mood = `${title.includes('夜') || time === '夜' ? '冷峻、悬疑' : '克制、内敛'}，${title.includes('对决') || title.includes('战') ? '压迫感高' : '情绪密度高'}。`

  return {
    scene_no: scene.scene_no || 1,
    title,
    summary,
    content,
    mood,
    location,
    time_of_day: time,
    estimated_duration: scene.estimated_duration || 120,
  }
}

export async function generateSceneScript(ctx) {
  const config = getAiConfig()
  if (isMockProvider(config)) {
    return generateMockSceneScript(ctx)
  }

  const { systemPrompt, userPrompt } = buildSceneScriptPrompts(ctx)

  try {
    const result = await generateStructuredJson({
      task: 'scene-script',
      systemPrompt,
      userPrompt,
      model: config.scriptModel,
      temperature: 0.85,
    })
    return normalizeSceneScriptPayload(result.json, ctx)
  } catch (error) {
    console.error('[ai:scene-script]', error)
    if (config.fallbackToMock) {
      console.warn('[ai:scene-script] real provider failed, fallback to mock')
      return generateMockSceneScript(ctx)
    }
    throw error
  }
}
