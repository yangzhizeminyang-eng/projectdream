/**
 * @file Storyboard AI service
 * @description Support both mock and real-provider modes for storyboard generation.
 */

import { getAiConfig, isMockProvider } from './config.mjs'
import { normalizeStoryboardPayload } from './parsers.mjs'
import { buildStoryboardPrompts } from './prompts/storyboard.mjs'
import { generateStructuredJson } from './provider.mjs'

const SHOT_TYPES = ['全景', '中景', '近景', '特写', '大特写']
const ANGLES = ['平视', '低机位', '高机位', '俯拍', '仰拍']
const COMPOSITIONS = ['居中构图', '三分构图', '对称构图', '对角线构图', '框架式构图']
const FALLBACK_CHARACTERS = ['主角', '对手', '旁白']

function pick(arr, index) {
  return arr[index % arr.length]
}

function generateMockStoryboards(ctx) {
  const scene = ctx.scene || {}
  const project = ctx.project || {}
  const content = String(ctx.scriptContent || '')
  const projectCharacters = Array.isArray(ctx?.characters) ? ctx.characters : []
  const characterNames = projectCharacters.length
    ? projectCharacters.map((item) => String(item?.name || '').trim()).filter(Boolean)
    : FALLBACK_CHARACTERS
  const paragraphCount = Math.max(2, content.split(/\n{2,}/).length)
  const shotCount = Math.min(8, Math.max(4, Math.round(paragraphCount / 2)))

  const basePrompt = `${project.visualStyle || '电影感写实风格'}，${scene.location || '城市夜景'}，${
    scene.time_of_day || '夜'
  }`

  const shots = Array.from({ length: shotCount }, (_, i) => {
    const shotNo = String(i + 1).padStart(2, '0')
    const character = pick(characterNames, i)
    const shotType = pick(SHOT_TYPES, i)
    const cameraAngle = pick(ANGLES, i + 1)
    const composition = pick(COMPOSITIONS, i + 2)
    const duration = 3 + (i % 3)
    const actions = [
      `${character} 从阴影中缓慢走出，背景里的环境噪声压低成一层底音。`,
      `镜头切到 ${character} 的侧脸，角色开始观察前方不稳定的局面。`,
      `${character} 做出一个关键信息动作，推动场景进入下一拍。`,
      `镜头短暂停在环境细节上，为后续剧情埋下视觉线索。`,
      `${character} 的目光与对手交汇，场面张力明显抬升。`,
      `画面逐渐拉远，空间关系和人物位置被重新建立。`,
      `一条异常信号进入镜头，提示局势已经开始失控。`,
      `镜头定格在角色离开的背影上，留出情绪余波。`,
    ]
    const dialogues = [
      '没人应该在这里活过今晚。',
      '你以为你在追我，其实你一直在追自己。',
      '把档案留下，你就可以走。',
      '我不需要答案，我只需要再多一个选择。',
      '这座城市的规则，今晚会被重写一次。',
      '你听到的不是噪音，是这座城在记忆。',
      '故事到这里，已经没有回头路。',
      '（无对白）',
    ]

    return {
      shot_no: shotNo,
      shot_type: shotType,
      camera_angle: cameraAngle,
      composition,
      duration_seconds: duration,
      character_name: character,
      action_text: pick(actions, i),
      dialogue_text: pick(dialogues, i),
      visual_prompt: `${basePrompt}，${shotType}，${cameraAngle}，${composition}，电影感构图，cinemascope 2.39:1`,
    }
  })

  return {
    scene_id: Number(ctx.sceneId) || 0,
    shots,
  }
}

export async function generateStoryboards(ctx) {
  const config = getAiConfig()
  if (isMockProvider(config)) {
    return generateMockStoryboards(ctx)
  }

  const { systemPrompt, userPrompt } = buildStoryboardPrompts(ctx)

  try {
    const result = await generateStructuredJson({
      task: 'storyboard',
      systemPrompt,
      userPrompt,
      model: config.storyboardModel,
      temperature: 0.8,
    })
    return normalizeStoryboardPayload(result.json, ctx)
  } catch (error) {
    console.error('[ai:storyboard]', error)
    if (config.fallbackToMock) {
      console.warn('[ai:storyboard] real provider failed, fallback to mock')
      return generateMockStoryboards(ctx)
    }
    throw error
  }
}
