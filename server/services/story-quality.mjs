const BIBLE_REQUIRED_FIELDS = [
  ['title', '故事标题'],
  ['logline', '一句话卖点'],
  ['audience', '目标受众'],
  ['emotionalPromise', '情绪承诺'],
  ['worldRules', '世界观规则'],
  ['timeline', '时间线'],
  ['locations', '地点与空间'],
  ['characters', '人物档案'],
  ['relationships', '人物关系'],
  ['mainPlot', '主线'],
  ['foreshadowing', '伏笔计划'],
  ['lockedFacts', '禁止改变的事实'],
]

const CHARACTER_REQUIRED_FIELDS = [
  ['name', '姓名'],
  ['role', '角色定位'],
  ['goal', '目标'],
  ['fear', '恐惧'],
  ['secret', '秘密'],
  ['growthArc', '成长弧'],
  ['visualDescription', '视觉描述'],
]

const EPISODE_REQUIRED_FIELDS = [
  ['title', '集标题'],
  ['logline', '一句话卖点'],
  ['openingHook', '开场钩子'],
  ['goal', '本集目标'],
  ['coreConflict', '核心冲突'],
  ['irreversibleChange', '不可逆变化'],
  ['endingHook', '结尾钩子'],
  ['protagonistChoice', '主角主动选择'],
]

import { evaluateMarketSeasonQuality } from './story-market-quality.mjs'

const BIBLE_SCORE_RULES = [
  { key: 'logline', label: '核心卖点', weight: 15, test: (value) => hasText(value) },
  { key: 'characters', label: '人物动机与成长', weight: 20, test: (value) => hasCharacters(value) },
  { key: 'mainPlot', label: '主线冲突', weight: 15, test: (value) => hasText(value) },
  { key: 'worldRules', label: '世界观约束', weight: 10, test: (value) => hasItems(value) },
  { key: 'timeline', label: '时间线连续性基础', weight: 10, test: (value) => hasItems(value) },
  { key: 'relationships', label: '人物关系', weight: 10, test: (value) => hasItems(value) },
  { key: 'foreshadowing', label: '伏笔可回收性基础', weight: 10, test: (value) => hasItems(value) },
  { key: 'visualSymbols', label: '视觉可视化基础', weight: 10, test: (value) => hasItems(value) },
]

function hasText(value) {
  return typeof value === 'string' ? value.trim().length > 0 : Boolean(value)
}

function hasItems(value) {
  return Array.isArray(value) ? value.length > 0 : hasText(value)
}

function hasCharacters(value) {
  return Array.isArray(value) && value.length >= 2 && value.every((character) =>
    CHARACTER_REQUIRED_FIELDS.every(([field]) => hasText(character?.[field])),
  )
}

function toText(value) {
  return value == null ? '' : String(value).trim()
}

function toList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'object' && item !== null ? item : toText(item))).filter(Boolean)
  }
  if (typeof value === 'string') {
    return value
      .split(/[\n,，；;]/)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

function normalizeCharacter(input = {}) {
  return {
    name: toText(input.name),
    role: toText(input.role),
    goal: toText(input.goal),
    fear: toText(input.fear),
    secret: toText(input.secret),
    growthArc: toText(input.growthArc),
    visualDescription: toText(input.visualDescription),
  }
}

function normalizeEpisode(input = {}, index = 0) {
  return {
    episodeNo: Number(input.episodeNo) > 0 ? Number(input.episodeNo) : index + 1,
    title: toText(input.title),
    logline: toText(input.logline),
    openingHook: toText(input.openingHook),
    goal: toText(input.goal),
    coreConflict: toText(input.coreConflict),
    irreversibleChange: toText(input.irreversibleChange),
    endingHook: toText(input.endingHook),
    protagonistChoice: toText(input.protagonistChoice),
    reversal: toText(input.reversal),
    visualSetPieces: toList(input.visualSetPieces),
  }
}

export function normalizeStoryBibleInput(input = {}) {
  return {
    title: toText(input.title),
    logline: toText(input.logline),
    audience: toText(input.audience),
    emotionalPromise: toText(input.emotionalPromise),
    worldRules: toList(input.worldRules),
    timeline: toList(input.timeline),
    locations: toList(input.locations),
    characters: Array.isArray(input.characters) ? input.characters.map(normalizeCharacter) : [],
    relationships: toList(input.relationships),
    props: toList(input.props),
    mainPlot: toText(input.mainPlot),
    subplots: toList(input.subplots),
    foreshadowing: toList(input.foreshadowing),
    lockedFacts: toList(input.lockedFacts),
    flexibleFacts: toList(input.flexibleFacts),
    visualSymbols: toList(input.visualSymbols),
  }
}

export function normalizeSeasonStructureInput(input = {}) {
  const episodes = Array.isArray(input.episodes)
    ? input.episodes.map((episode, index) => normalizeEpisode(episode, index))
    : []

  return {
    seasonTheme: toText(input.seasonTheme),
    coreConflict: toText(input.coreConflict),
    structureType: toText(input.structureType),
    episodeCount: Number(input.episodeCount) > 0 ? Number(input.episodeCount) : episodes.length,
    episodes,
    foreshadowingPlan: toList(input.foreshadowingPlan),
    characterArcs: toList(input.characterArcs),
  }
}

function blocker(field, message) {
  return { field, message, severity: 'blocker' }
}

function warning(field, message) {
  return { field, message, severity: 'warning' }
}

function checkRequiredFields(value, fields, prefix = '') {
  return fields
    .filter(([field]) => !hasText(value[field]) && !hasItems(value[field]))
    .map(([field, label]) => blocker(prefix ? `${prefix}.${field}` : field, `${label}不能为空`))
}

function evaluateCharacters(characters) {
  const blockers = []
  const names = new Set()
  characters.forEach((character, index) => {
    const prefix = `characters[${index}]`
    blockers.push(...checkRequiredFields(character, CHARACTER_REQUIRED_FIELDS, prefix))
    if (character.name) {
      if (names.has(character.name)) {
        blockers.push(blocker(`${prefix}.name`, `人物姓名“${character.name}”重复`))
      }
      names.add(character.name)
    }
  })
  if (!characters.some((character) => character.role.includes('主角'))) {
    blockers.push(blocker('characters', '至少需要一名角色定位为“主角”的人物'))
  }
  if (!characters.some((character) => character.role.includes('反派'))) {
    blockers.push(warning('characters', '尚未明确反派角色，后续冲突强度可能不足'))
  }
  return blockers
}

function scoreFromRules(value, rules) {
  return rules.reduce((total, rule) => total + (rule.test(value[rule.key]) ? rule.weight : 0), 0)
}

export function evaluateStoryBible(input) {
  const bible = normalizeStoryBibleInput(input)
  const blockers = [
    ...checkRequiredFields(bible, BIBLE_REQUIRED_FIELDS),
    ...evaluateCharacters(bible.characters),
  ]
  const warnings = []

  if (!hasItems(bible.props)) warnings.push(warning('props', '尚未配置关键道具，画面记忆点可能不足'))
  if (!hasItems(bible.subplots)) warnings.push(warning('subplots', '尚未配置支线，整季中段可能缺少层次'))
  if (!hasItems(bible.flexibleFacts)) warnings.push(warning('flexibleFacts', '尚未标记可调整设定，后续改稿空间较小'))

  const score = scoreFromRules(bible, BIBLE_SCORE_RULES)
  return {
    type: 'story_bible',
    score,
    threshold: 90,
    canLock: blockers.length === 0 && score >= 90,
    blockers,
    warnings,
    dimensions: BIBLE_SCORE_RULES.map((rule) => ({
      key: rule.key,
      label: rule.label,
      weight: rule.weight,
      passed: rule.test(bible[rule.key]),
      score: rule.test(bible[rule.key]) ? rule.weight : 0,
    })),
    normalized: bible,
  }
}

function evaluateEpisode(episode, index) {
  const blockers = checkRequiredFields(episode, EPISODE_REQUIRED_FIELDS, `episodes[${index}]`)
  const warnings = []
  if (!hasText(episode.reversal)) {
    warnings.push(warning(`episodes[${index}].reversal`, '尚未填写反转或信息揭示'))
  }
  if (!hasItems(episode.visualSetPieces)) {
    warnings.push(warning(`episodes[${index}].visualSetPieces`, '尚未填写可视化场面'))
  }
  return { blockers, warnings }
}

export function evaluateSeasonStructure(input) {
  const season = normalizeSeasonStructureInput(input)
  const blockers = []
  const warnings = []
  const marketQuality = evaluateMarketSeasonQuality(season)

  if (!hasText(season.seasonTheme)) blockers.push(blocker('seasonTheme', '季主题不能为空'))
  if (!hasText(season.coreConflict)) blockers.push(blocker('coreConflict', '整季主线冲突不能为空'))
  if (!season.episodes.length) blockers.push(blocker('episodes', '至少需要一集分集结构'))
  if (season.episodeCount !== season.episodes.length) {
    blockers.push(blocker('episodes', `计划集数为 ${season.episodeCount}，但实际只有 ${season.episodes.length} 集`))
  }

  const seenEpisodeNos = new Set()
  season.episodes.forEach((episode, index) => {
    if (seenEpisodeNos.has(episode.episodeNo)) {
      blockers.push(blocker('episodes', `第 ${episode.episodeNo} 集编号重复`))
    }
    seenEpisodeNos.add(episode.episodeNo)
    const report = evaluateEpisode(episode, index)
    blockers.push(...report.blockers)
    warnings.push(...report.warnings)
  })

  blockers.push(...marketQuality.blockers)
  warnings.push(...marketQuality.warnings)

  if (season.episodes.length > 0 && !hasItems(season.foreshadowingPlan)) {
    warnings.push(warning('foreshadowingPlan', '尚未配置整季伏笔回收计划'))
  }
  if (season.episodes.length > 0 && !hasItems(season.characterArcs)) {
    warnings.push(warning('characterArcs', '尚未配置人物阶段性变化'))
  }

  const episodePassCount = season.episodes.filter(
    (episode) => evaluateEpisode(episode, 0).blockers.length === 0,
  ).length
  const baseScore = season.episodes.length
    ? Math.round((episodePassCount / season.episodes.length) * 80)
    : 0
  const structureScore = hasText(season.seasonTheme) && hasText(season.coreConflict) ? 10 : 0
  const foreshadowingScore = hasItems(season.foreshadowingPlan) ? 5 : 0
  const arcScore = hasItems(season.characterArcs) ? 5 : 0
  const score = Math.min(100, baseScore + structureScore + foreshadowingScore + arcScore)

  return {
    type: 'season_structure',
    score,
    threshold: 90,
    canLock: blockers.length === 0 && score >= 90 && marketQuality.canPass,
    blockers,
    warnings,
    dimensions: [
      { key: 'episodeCompleteness', label: '分集必备字段', weight: 80, score: baseScore },
      { key: 'seasonConflict', label: '整季主题与冲突', weight: 10, score: structureScore },
      { key: 'foreshadowingPlan', label: '伏笔回收计划', weight: 5, score: foreshadowingScore },
      { key: 'characterArcs', label: '人物阶段性变化', weight: 5, score: arcScore },
    ],
    marketQuality,
    normalized: season,
  }
}
