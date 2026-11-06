import { generateStructuredJson } from './provider.mjs'
import { getAiConfig, isMockProvider } from './config.mjs'
import { buildGenrePromptContext } from './genre-skill-profile.mjs'

function text(value) {
  return String(value ?? '').trim()
}

function list(value) {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean)
  return []
}

function normalizeEpisode(item, index) {
  return {
    episodeNo: Number(item?.episodeNo) > 0 ? Number(item.episodeNo) : index + 1,
    title: text(item?.title),
    logline: text(item?.logline),
    openingHook: text(item?.openingHook),
    goal: text(item?.goal),
    coreConflict: text(item?.coreConflict),
    irreversibleChange: text(item?.irreversibleChange),
    endingHook: text(item?.endingHook),
    protagonistChoice: text(item?.protagonistChoice),
    reversal: text(item?.reversal),
    visualSetPieces: list(item?.visualSetPieces),
  }
}

export function buildSeasonStructurePrompts(project = {}, bible = {}, episodeCount = 1) {
  const count = Math.max(1, Math.min(50, Number(episodeCount) || 1))
  const genreContext = buildGenrePromptContext(project.category)
  const systemPrompt = [
    '你是影视项目的季播结构编剧。',
    '请把故事圣经拆成可以直接进入剧本阶段的分集结构。',
    '只返回 JSON，不要 Markdown、解释或额外字段。',
    'JSON 必须包含 seasonTheme、coreConflict、structureType、episodeCount、episodes、foreshadowingPlan、characterArcs。',
    'episodes 必须正好有计划集数，每集必须包含 episodeNo、title、logline、openingHook、goal、coreConflict、irreversibleChange、endingHook、protagonistChoice、reversal、visualSetPieces。',
    '每集要有主动选择、明确冲突和不可逆变化，结尾留下推动下一集的钩子。',
    `计划集数：${count}`,
    genreContext,
  ].join('\n')
  const userPrompt = [
    `项目：${text(project.name)}`,
    `类型：${text(project.category)}`,
    `视觉方向：${text(project.visual_style || project.visualStyle)}`,
    `一句话故事：${text(bible.logline)}`,
    `故事主线：${text(bible.mainPlot)}`,
    `人物：${JSON.stringify(bible.characters || [])}`,
    `世界规则：${JSON.stringify(bible.worldRules || [])}`,
    `伏笔：${JSON.stringify(bible.foreshadowing || [])}`,
    genreContext,
    '',
    `请生成 ${count} 集完整分集结构。`,
  ].join('\n')
  return { systemPrompt, userPrompt }
}

export async function generateSeasonStructure(project, bible, { episodeCount = 1 } = {}) {
  const config = getAiConfig()
  if (isMockProvider(config)) {
    throw new Error('当前为 mock 模式，不会真实调用模型生成分集大纲')
  }
  const { systemPrompt, userPrompt } = buildSeasonStructurePrompts(project, bible, episodeCount)
  const result = await generateStructuredJson({
    task: 'season-structure',
    systemPrompt,
    userPrompt,
    model: config.outlineModel || config.defaultModel,
    temperature: 0.75,
  })
  const payload = result.json && typeof result.json === 'object' ? result.json : {}
  const count = Math.max(1, Math.min(50, Number(episodeCount) || 1))
  const episodes = Array.from({ length: count }, (_, index) =>
    normalizeEpisode(payload.episodes?.[index], index),
  )
  if (episodes.some((episode) => !episode.title || !episode.logline)) {
    throw new Error('模型返回的分集大纲不完整，请重试或补充故事设定')
  }
  return {
    seasonTheme: text(payload.seasonTheme) || text(bible.logline),
    coreConflict: text(payload.coreConflict) || text(bible.mainPlot),
    structureType: text(payload.structureType) || 'linear',
    episodeCount: count,
    episodes,
    foreshadowingPlan: list(payload.foreshadowingPlan),
    characterArcs: list(payload.characterArcs),
  }
}
