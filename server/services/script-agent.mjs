/**
 * Script workspace Agent orchestration primitives.
 *
 * The script page performs the real domain mutation (story bible, season,
 * script, asset parsing). This module gives each mutation a durable action
 * identity and a deterministic, structured reaction for the right-hand Agent
 * dock. It intentionally does not pretend that a chat reply is execution.
 */

const ACTIONS = {
  'generate-bible': {
    label: '重新生成故事设定',
    stageKey: 'bible',
    agentKey: 'script-agent',
    nextAction: { key: 'confirm-bible', label: '检查并确认故事设定', actionKey: 'save-bible' },
  },
  'save-bible': {
    label: '保存故事设定',
    stageKey: 'bible',
    agentKey: 'script-agent',
    nextAction: { key: 'generate-season', label: '生成分集大纲', actionKey: 'generate-season' },
  },
  'generate-season': {
    label: '生成分集大纲',
    stageKey: 'season',
    agentKey: 'script-agent',
    nextAction: { key: 'confirm-season', label: '检查并确认分集大纲', actionKey: 'save-season' },
  },
  'save-season': {
    label: '保存分集大纲',
    stageKey: 'season',
    agentKey: 'script-agent',
    nextAction: { key: 'generate-script', label: '生成剧本正文', actionKey: 'generate-script' },
  },
  'generate-script': {
    label: '生成剧本正文',
    stageKey: 'script',
    agentKey: 'script-agent',
    nextAction: { key: 'parse-assets', label: '解析角色与场景资产', actionKey: 'parse-assets' },
  },
  'generate-scene': {
    label: '生成单场正文',
    stageKey: 'script',
    agentKey: 'script-agent',
    nextAction: { key: 'save-script', label: '保存本场修改', actionKey: 'save-script' },
  },
  'generate-all-scenes': {
    label: '批量生成全部剧集正文',
    stageKey: 'script',
    agentKey: 'script-agent',
    nextAction: { key: 'parse-assets', label: '解析角色与场景资产', actionKey: 'parse-assets' },
  },
  'save-script': {
    label: '保存剧本修改',
    stageKey: 'script',
    agentKey: 'script-agent',
    nextAction: { key: 'parse-assets', label: '解析角色与场景资产', actionKey: 'parse-assets' },
  },
  'parse-assets': {
    label: '解析角色与场景资产',
    stageKey: 'script',
    agentKey: 'asset-parser-agent',
    nextAction: { key: 'open-assets', label: '进入资产管理', actionKey: 'open-assets' },
  },
}

const STAGES = new Set(['bible', 'season', 'script'])
const STATUSES = new Set(['running', 'completed', 'blocked', 'failed'])
const SOURCES = new Set(['button', 'chat', 'system'])

function text(value, fallback = '') {
  const normalized = String(value ?? '').trim()
  return normalized || fallback
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function list(value, limit = 12) {
  return Array.isArray(value)
    ? value.map((item) => text(item)).filter(Boolean).slice(0, limit)
    : []
}

export function getScriptAgentAction(actionKey) {
  return ACTIONS[text(actionKey)] || null
}

export function listScriptAgentActions() {
  return Object.entries(ACTIONS).map(([key, value]) => ({ key, ...value }))
}

export function normalizeScriptAgentActivityInput(input = {}) {
  const actionKey = text(input.actionKey)
  const action = ACTIONS[actionKey]
  if (!action) throw new Error(`未知 Script Agent 动作：${actionKey || '空'}`)

  const status = text(input.status, 'running')
  if (!STATUSES.has(status)) throw new Error(`无效 Script Agent 状态：${status}`)

  const stageKey = text(input.stageKey, action.stageKey)
  if (!STAGES.has(stageKey)) throw new Error(`无效 Script Agent 阶段：${stageKey}`)

  const source = text(input.source, 'button')
  if (!SOURCES.has(source)) throw new Error(`无效 Script Agent 来源：${source}`)

  return {
    actionKey,
    agentKey: text(input.agentKey, action.agentKey),
    stageKey,
    source,
    status,
    title: text(input.title, action.label),
    summary: text(input.summary),
    context: object(input.context),
    result: object(input.result),
    errorText: text(input.errorText),
    idempotencyKey: text(input.idempotencyKey),
  }
}

function resolveCount(result, keys) {
  for (const key of keys) {
    const value = Number(result[key])
    if (Number.isFinite(value)) return value
  }
  return null
}

export function buildScriptAgentReaction(input = {}) {
  const normalized = normalizeScriptAgentActivityInput(input)
  const result = normalized.result
  const action = ACTIONS[normalized.actionKey]
  const nextActions = []

  if (normalized.status === 'running') {
    return {
      agentKey: normalized.agentKey,
      tone: 'working',
      headline: `${normalized.title}已开始`,
      message: normalized.summary || `我正在读取当前${normalized.stageKey === 'bible' ? '故事设定' : normalized.stageKey === 'season' ? '分集大纲' : '剧本正文'}并执行这项操作。`,
      facts: [],
      nextActions: [],
    }
  }

  if (normalized.status === 'failed') {
    return {
      agentKey: normalized.agentKey,
      tone: 'danger',
      headline: `${normalized.title}失败`,
      message: normalized.errorText || '这次操作没有完成，当前内容没有被当作新版本写入。',
      facts: [],
      nextActions: [{ key: 'retry', label: '重试当前动作', actionKey: normalized.actionKey }],
    }
  }

  if (normalized.status === 'blocked') {
    return {
      agentKey: normalized.agentKey,
      tone: 'warning',
      headline: `${normalized.title}被阻塞`,
      message: normalized.summary || '当前阶段还有前置内容未完成，我没有继续写入后续结果。',
      facts: list(result.blockers || result.blockingIssues),
      nextActions: list(result.nextActions).map((label, index) => ({
        key: `next-${index}`,
        label,
        actionKey: null,
      })),
    }
  }

  if (normalized.actionKey === 'generate-bible') {
    const characterCount = resolveCount(result, ['characterCount', 'characters'])
    const locationCount = resolveCount(result, ['locationCount', 'locations'])
    if (characterCount !== null) nextActions.push({ key: 'bible-characters', label: `检查 ${characterCount} 个角色设定`, actionKey: 'save-bible' })
    if (locationCount !== null) nextActions.push({ key: 'bible-locations', label: `检查 ${locationCount} 个主要场景`, actionKey: 'save-bible' })
  } else if (normalized.actionKey === 'generate-season') {
    const episodeCount = resolveCount(result, ['episodeCount', 'episodes'])
    if (episodeCount !== null) nextActions.push({ key: 'season-episodes', label: `检查 ${episodeCount} 集结构`, actionKey: 'save-season' })
  } else if (normalized.actionKey === 'generate-script') {
    const sceneCount = resolveCount(result, ['sceneCount', 'scenes'])
    if (sceneCount !== null) nextActions.push({ key: 'script-scenes', label: `检查 ${sceneCount} 个场景正文`, actionKey: 'parse-assets' })
  } else if (normalized.actionKey === 'parse-assets') {
    const characterCount = resolveCount(result, ['characterCount', 'characters'])
    const sceneCount = resolveCount(result, ['sceneCount', 'scenes'])
    if (characterCount !== null || sceneCount !== null) {
      nextActions.push({
        key: 'asset-review',
        label: `复核 ${characterCount ?? 0} 个角色 / ${sceneCount ?? 0} 个场景`,
        actionKey: 'open-assets',
      })
    }
  }

  if (!nextActions.length && action.nextAction) nextActions.push(action.nextAction)

  const facts = [
    ...list(result.facts),
    ...list(result.changed),
  ]
  const versionNo = Number(result.versionNo)
  if (Number.isInteger(versionNo) && versionNo > 0) facts.unshift(`已写入第 ${versionNo} 版结果`)

  return {
    agentKey: normalized.agentKey,
    tone: 'success',
    headline: `${normalized.title}完成`,
    message: normalized.summary || '结果已经写回当前项目，右侧给出了下一步检查项。',
    facts,
    nextActions,
  }
}

export function buildScriptAgentActivityPayload(input = {}) {
  const normalized = normalizeScriptAgentActivityInput(input)
  return {
    ...normalized,
    reaction: buildScriptAgentReaction(normalized),
  }
}
