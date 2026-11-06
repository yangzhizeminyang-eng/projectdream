/**
 * @file Storyboard AI service
 * @description Support both mock and real-provider modes for storyboard generation.
 */

import { getAiConfig, isMockProvider } from './config.mjs'
import { getVideoConfig, isOfficialAgnesModel } from '../video.mjs'
import { normalizeStoryboardPayload } from './parsers.mjs'
import { estimateMinimumDialogueSeconds, validateStoryboardDurationContracts } from '../storyboard-duration-contract.mjs'
import { buildStoryboardPrompts } from './prompts/storyboard.mjs'
import { generateStructuredJson } from './provider.mjs'

const SHOT_TYPES = ['全景', '中景', '近景', '特写', '大特写']
const ANGLES = ['平视', '低机位', '高机位', '俯拍', '仰拍']
const COMPOSITIONS = ['居中构图', '三分构图', '对称构图', '对角线构图', '框架式构图']
const FALLBACK_CHARACTERS = ['主角', '对手', '旁白']

function pick(arr, index) {
  return arr[index % arr.length]
}

function getConfiguredVideoDurationRange() {
  const config = getVideoConfig()
  const modelName = String(config.defaultModel || '').trim()
  if (/^minimax(?:-|$)/i.test(modelName)) return { min: 4, max: 15 }
  if (isOfficialAgnesModel(modelName) || config.provider === 'agnes') return { min: 4, max: 12 }
  return { min: 1, max: 30 }
}

function validateConfiguredVideoDurations(shots, range) {
  return shots.flatMap((shot) => {
    const duration = Number(shot.duration_seconds)
    return Number.isInteger(duration) && duration >= range.min && duration <= range.max
      ? []
      : [`镜头 ${shot.shot_no} 时长须符合当前视频模型 ${range.min}-${range.max} 秒范围`]
  })
}

function generateMockStoryboards(ctx) {
  // mock 分镜生成把一场戏拆成若干镜头，并填充景别、机位、动作和视觉提示词。
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
    const baseDuration = 4 + (i % 3)
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

    const dialogue = pick(dialogues, i)
    const action = pick(actions, i)
    const duration = Math.max(baseDuration, estimateMinimumDialogueSeconds(dialogue))

    return {
      shot_no: shotNo,
      shot_type: shotType,
      camera_angle: cameraAngle,
      composition,
      duration_seconds: duration,
      duration_breakdown: [{
        phase: '主要动作与结果',
        seconds: duration,
        observable: action,
      }],
      duration_basis: '按单一可见动作及其结果停留时长规划。',
      character_name: character,
      action_text: action,
      dialogue_text: dialogue,
      visual_prompt: `时间轴：0-${duration}秒，${action}；镜头：${shotType}，${cameraAngle}；位置：${composition}；动作：${action}；要求：${basePrompt}，电影感构图，cinemascope 2.39:1${dialogue && dialogue !== '（无对白）' ? `；对白：${dialogue}` : ''}；声音：${i % 3 === 0 ? '保留环境声，人物不说话时保持短暂静默。' : '语速自然，关键词轻微重读，句中保留短停顿。'}`,
      shot_purpose: i === 0 ? 'hook' : i % 3 === 0 ? 'reaction' : 'dialogue',
      acting_beat:
        i % 3 === 0
          ? `${character}先停顿并观察，再用视线或动作回应刚刚发生的信息。`
          : `${character}先吸气确认情绪，再在关键词处停顿后完成动作或对白。`,
      audio_direction:
        i % 3 === 0 ? '保留环境声，人物不说话时保持短暂静默。' : '语速自然，关键词轻微重读，句中保留短停顿。',
      speech_duration_policy: 'preserve',
      reaction_shot: i % 3 === 0,
    }
  })

  return normalizeStoryboardPayload({
    scene_id: Number(ctx.sceneId) || 0,
    shots,
  }, ctx)
}

export async function generateStoryboards(ctx) {
  // 分镜生成流程：读取场景剧本 -> 调文本模型 -> 归一化镜头字段。
  // 后端随后会把每个镜头写入 storyboards，图片/视频阶段再逐镜头处理。
  const config = getAiConfig()
  const videoDurationRange = getConfiguredVideoDurationRange()
  if (isMockProvider(config)) {
    const normalized = generateMockStoryboards(ctx)
    const contract = validateStoryboardDurationContracts(normalized.shots, { requireVisibleTimeline: true })
    const modelBlockers = validateConfiguredVideoDurations(normalized.shots, videoDurationRange)
    if (!contract.passed || modelBlockers.length) {
      throw new Error(`模拟分镜时长规划无效：${[...contract.blockers, ...modelBlockers].join('；')}`)
    }
    return normalized
  }

  const { systemPrompt, userPrompt } = buildStoryboardPrompts({ ...ctx, videoDurationRange })

  try {
    let blockers = []
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const correction = attempt === 0
        ? ''
        : `\n上一次输出未通过时长或镜头内时间轴契约，请只修正这些问题后重新输出完整 JSON：${blockers.join('；')}`
      const result = await generateStructuredJson({
        task: 'storyboard',
        systemPrompt,
        userPrompt: `${userPrompt}${correction}`,
        model: config.storyboardModel,
        temperature: 0.2,
        responseFormat: { type: 'json_object' },
      })
      const normalized = normalizeStoryboardPayload(result.json, ctx)
      const contract = validateStoryboardDurationContracts(normalized.shots, { requireVisibleTimeline: true })
      const modelBlockers = validateConfiguredVideoDurations(normalized.shots, videoDurationRange)
      if (contract.passed && !modelBlockers.length) return normalized
      blockers = [...contract.blockers, ...modelBlockers]
    }
    const error = new Error(`分镜 Agent 两次输出均未通过时长规划校验：${blockers.join('；')}`)
    error.statusCode = 422
    error.code = 'STORYBOARD_DURATION_CONTRACT_FAILED'
    throw error
  } catch (error) {
    if (error?.code === 'STORYBOARD_DURATION_CONTRACT_FAILED') throw error
    console.error('[ai:storyboard]', error)
    if (!config.fallbackToMock) throw error
    // 分镜是后续资产和视频流程的硬前置。文本模型暂时不可用时，
    // 使用规则化分镜降级，保证用户仍能进入可编辑的分镜创作页。
    // 后续重新生成时仍可切回真实模型，不覆盖用户已经手动调整的镜头。
    console.warn('[ai:storyboard] real provider failed, fallback to editable storyboard')
    return generateMockStoryboards(ctx)
  }
}
