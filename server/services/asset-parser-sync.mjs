function text(value) {
  return String(value ?? '').trim()
}

function key(type, refId, groupKey) {
  return `${type}:${Number(refId)}:${text(groupKey)}`
}

function imageCount(node) {
  const value = Number(node?.imageCount ?? node?.image_count ?? 0)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** Keep one active node per logical asset while preserving existing image work. */
export function buildActiveAssetNodeDedupPlan(existingNodes = []) {
  const groups = new Map()
  for (const node of Array.isArray(existingNodes) ? existingNodes : []) {
    if (text(node.status || 'active') === 'archived') continue
    const type = text(node.nodeType ?? node.node_type)
    const refId = node.refId ?? node.ref_id
    const groupKey = node.groupKey ?? node.group_key
    if (!type || (refId == null && !text(groupKey))) continue
    const logicalKey = key(type, refId, groupKey)
    const group = groups.get(logicalKey) || []
    group.push(node)
    groups.set(logicalKey, group)
  }

  const archiveIds = []
  for (const nodes of groups.values()) {
    if (nodes.length < 2) continue
    const [, ...duplicates] = nodes.slice().sort((left, right) =>
      imageCount(right) - imageCount(left)
      || Number(left.id || 0) - Number(right.id || 0),
    )
    archiveIds.push(...duplicates.map((node) => Number(node.id)))
  }
  return {
    archiveIds: archiveIds.filter(Number.isSafeInteger).sort((left, right) => left - right),
  }
}

export function buildAssetParserSyncPlan({
  existingNodes = [],
  characterNodes = [],
  sceneNodes = [],
  propNodes = [],
} = {}) {
  const desired = new Set([
    ...characterNodes.map((node) => key('character', node.refId, node.groupKey)),
    ...sceneNodes.map((node) => key('scene', node.refId, node.groupKey)),
    ...propNodes.map((node) => key('prop', node.refId, node.groupKey)),
  ])
  const staleArchiveIds = existingNodes
    .filter((node) => text(node.status || 'active') !== 'archived')
    .filter((node) => {
      const type = text(node.nodeType ?? node.node_type)
      if (type === 'prop') {
        if (!String(node.groupKey ?? node.group_key ?? '').startsWith('prop:agent:')) return false
      } else if (type !== 'character' && type !== 'scene') return false
      return !desired.has(key(type, node.refId ?? node.ref_id, node.groupKey ?? node.group_key))
    })
    .map((node) => Number(node.id))
    .filter(Number.isSafeInteger)

  const duplicatePlan = buildActiveAssetNodeDedupPlan(existingNodes)
  return {
    desired,
    archiveIds: [...new Set([...staleArchiveIds, ...duplicatePlan.archiveIds])]
      .sort((left, right) => left - right),
  }
}

export function buildCharacterRecordSyncPlan({
  existingCharacters = [],
  currentCharacters = [],
} = {}) {
  const desiredNames = new Set(
    currentCharacters
      .map((character) => text(character?.name))
      .filter(Boolean)
      .map((name) => name.toLocaleLowerCase('zh-CN')),
  )
  const archiveIds = existingCharacters
    .filter((character) => text(character?.status || 'draft') !== 'archived')
    .filter((character) => !desiredNames.has(text(character?.name).toLocaleLowerCase('zh-CN')))
    .map((character) => Number(character.id))
    .filter(Number.isSafeInteger)

  return { desiredNames, archiveIds }
}
