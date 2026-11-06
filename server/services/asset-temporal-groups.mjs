import { createHash } from 'node:crypto'

function text(value) {
  return String(value ?? '').trim()
}

export function normalizeAssetGroupKey(value, maxLength = 240) {
  const key = text(value)
  if (!key || key.length <= maxLength) return key
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 12)
  return `${key.slice(0, Math.max(1, maxLength - digest.length - 1))}-${digest}`
}

export function buildPropAssetGroupKey({ projectId, name } = {}) {
  return normalizeAssetGroupKey(`prop:agent:${Number(projectId) || 0}:${text(name)}`)
}

function temporalState(prompt) {
  const value = text(prompt)
  // 资产状态必须优先读取 Agent 明确写出的状态行。
  // 完整角色提示词会包含“父亲五年前的事故”等历史事实，不能把它们
  // 当成当前角色或场景的时空分组依据。
  const explicitState = value.match(/本(?:资产)?时空状态\s*：\s*([^\n]+)/u)?.[1]?.trim()
  if (explicitState) {
    if (/五年前|五年以前|5年前/u.test(explicitState)) {
      return { key: 'past-5-years', label: explicitState }
    }
    if (/十八年前|18年前/u.test(explicitState)) {
      return { key: 'past-18-years', label: explicitState }
    }
    if (/童年|小时候|幼年|儿童时期/u.test(explicitState)) {
      return { key: 'childhood', label: explicitState }
    }
    if (/现在|当前|当下|成年|职场/u.test(explicitState)) {
      return { key: 'current', label: explicitState }
    }
    return { key: 'default', label: explicitState }
  }
  if (/五年前|五年以前|5年前/.test(value)) return { key: 'past-5-years', label: value.split(/[；，。]/)[0] || '五年前' }
  if (/十八年前|18年前/.test(value)) return { key: 'past-18-years', label: '十八年前' }
  if (/童年|小时候|幼年|儿童时期/.test(value)) return { key: 'childhood', label: '童年时期' }
  if (/现在|当前|当下|成年|职场/.test(value)) {
    const label = value.match(/(?:现在|当前|当下|成年|职场)[^；，。]*/)?.[0] || '当前状态'
    return { key: 'current', label }
  }
  return { key: 'default', label: '默认状态' }
}

export function resolveTemporalState(prompt = '') {
  return temporalState(prompt)
}

export function buildTemporalAssetGroupKey({ nodeType, refId, promptText } = {}) {
  const type = text(nodeType) || 'material'
  const id = Number(refId) || 0
  return `${type}:${id}:${temporalState(promptText).key}`
}

export function resolveTemporalAssetGroupKey(node = {}) {
  return buildTemporalAssetGroupKey({
    nodeType: node.nodeType || node.node_type,
    refId: Number(node.refId ?? node.ref_id) || Number(node.id) || 0,
    promptText: node.promptText ?? node.prompt_text,
  })
}

export function buildTemporalAssetGroups(nodes = []) {
  const groups = new Map()
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const state = temporalState(node.promptText ?? node.prompt_text)
    const key = resolveTemporalAssetGroupKey(node)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(node)
  }

  return [...groups.entries()].map(([key, items]) => {
    const first = items[0]
    const state = temporalState(first.promptText ?? first.prompt_text)
    return {
      key,
      nodeType: text(first.nodeType || first.node_type),
      label: `${text(first.label) || '未命名资产'} · ${state.label}`,
      nodeIds: items.map((item) => Number(item.id)).filter(Boolean),
    }
  })
}
