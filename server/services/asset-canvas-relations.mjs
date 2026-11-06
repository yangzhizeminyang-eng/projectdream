/**
 * 从已持久化的分镜 asset_reference_json 计算画布关系。
 * 关系只接受真实节点 ID，避免前端根据名称臆造连线。
 */

function positive(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function parse(value) {
  if (value && typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function storyboardNodeId(value) {
  const id = positive(value)
  return id ? -id : null
}

function referenceAssetIds(reference, allowed) {
  return [
    reference.characterAssetNodeId ?? reference.characterId,
    reference.sceneAssetNodeId ?? reference.sceneAssetId,
    ...(Array.isArray(reference.propAssetRefs) ? reference.propAssetRefs.map((item) => item.assetNodeId) : []),
    ...(Array.isArray(reference.assetNodeIds) ? reference.assetNodeIds : []),
  ].map(positive).filter((id, index, values) =>
    id && (!allowed || allowed.has(id)) && values.indexOf(id) === index,
  )
}

export function buildAssetCanvasRelations({ nodeIds = [], storyboards = [] } = {}) {
  const allowed = new Set((Array.isArray(nodeIds) ? nodeIds : []).map(positive).filter(Boolean))
  const relations = new Map()
  const add = (from, to, kind, label, storyboardId = null) => {
    const source = positive(from)
    const target = positive(to)
    if (!source || !target || source === target || !allowed.has(source) || !allowed.has(target)) return
    const ordered = source < target ? [source, target] : [target, source]
    const key = `${ordered[0]}:${ordered[1]}:${kind}`
    const current = relations.get(key) || {
      id: key,
      fromNodeId: ordered[0],
      toNodeId: ordered[1],
      kind,
      label,
      storyboardIds: [],
    }
    if (storyboardId && !current.storyboardIds.includes(storyboardId)) current.storyboardIds.push(storyboardId)
    relations.set(key, current)
  }

  for (const storyboard of Array.isArray(storyboards) ? storyboards : []) {
    const reference = parse(storyboard.asset_reference_json ?? storyboard.assetReference)
    const storyboardId = positive(storyboard.id)
    const ids = referenceAssetIds(reference, allowed)
    const anchor = ids[0]
    for (const target of ids.slice(1)) {
      add(anchor, target, 'storyboard-asset', `镜头 ${storyboard.shot_no || storyboardId || ''} 资产绑定`, storyboardId)
    }
  }
  return [...relations.values()]
}

/**
 * 为无限画布生成真实分镜节点和关系。
 * 分镜节点使用负数虚拟 ID，仅用于画布坐标和 UI，不会伪造 asset_nodes 主键。
 */
export function buildStoryboardCanvasNodes({ storyboards = [], assetNodes = [] } = {}) {
  const rows = Array.isArray(storyboards) ? storyboards : []
  const maxBottom = (Array.isArray(assetNodes) ? assetNodes : []).reduce(
    (bottom, node) => Math.max(bottom, Number(node?.y || 0) + Number(node?.height || 260)),
    260,
  )
  const startY = maxBottom + 180
  return rows.map((storyboard, index) => {
    const id = positive(storyboard.id)
    const reference = parse(storyboard.asset_reference_json ?? storyboard.assetReference)
    const column = index % 3
    const row = Math.floor(index / 3)
    return {
      id: storyboardNodeId(id),
      storyboardId: id,
      sceneId: positive(storyboard.scene_id ?? storyboard.sceneId),
      shotNo: String(storyboard.shot_no ?? storyboard.shotNo ?? '').trim(),
      sceneTitle: String(storyboard.scene_title ?? storyboard.sceneTitle ?? '').trim(),
      label: `镜头 ${String(storyboard.shot_no ?? storyboard.shotNo ?? index + 1).padStart(2, '0')}`,
      x: 48 + column * 340,
      y: startY + row * 210,
      width: 300,
      height: 168,
      imageUrl: String(storyboard.image_url ?? storyboard.imageUrl ?? '').trim() || null,
      endImageUrl: String(storyboard.end_image_url ?? storyboard.endImageUrl ?? '').trim() || null,
      dialogueText: String(storyboard.dialogue_text ?? storyboard.dialogueText ?? '').trim(),
      characterName: String(storyboard.character_name ?? storyboard.characterName ?? '').trim(),
      voiceProfileKey: String(reference.voiceProfileKey || '').trim() || null,
      voiceLocked: reference.voiceLocked === true,
      continuityFromShot: String(reference.continuityFromShot || '').trim() || null,
      assetReference: reference,
      status: String(storyboard.status || 'pending').trim(),
    }
  }).filter((node) => node.id && node.storyboardId)
}

export function buildStoryboardCanvasRelations({ storyboards = [], assetNodes = [], storyboardNodes } = {}) {
  const allowedAssets = new Set((Array.isArray(assetNodes) ? assetNodes : []).map((node) => positive(node?.id)).filter(Boolean))
  const nodes = Array.isArray(storyboardNodes) ? storyboardNodes : buildStoryboardCanvasNodes({ storyboards, assetNodes })
  const byShot = new Map(nodes.map((node) => [`${node.sceneId}:${node.shotNo}`, node]))
  const rows = Array.isArray(storyboards) ? storyboards : []
  const relations = []
  const seen = new Set()
  const push = (relation) => {
    if (!relation.fromNodeId || !relation.toNodeId || relation.fromNodeId === relation.toNodeId || seen.has(relation.id)) return
    seen.add(relation.id)
    relations.push(relation)
  }

  for (const row of rows) {
    const storyboardId = positive(row.id)
    const target = nodes.find((node) => node.storyboardId === storyboardId)
    if (!target) continue
    const reference = parse(row.asset_reference_json ?? row.assetReference)
    for (const assetId of referenceAssetIds(reference, allowedAssets)) {
      push({
        id: `storyboard-asset:${storyboardId}:${assetId}`,
        fromNodeId: assetId,
        toNodeId: target.id,
        kind: 'storyboard-asset',
        label: `@资产 → ${target.label}`,
        storyboardIds: [storyboardId],
      })
    }
    const sourceShot = String(reference.continuityFromShot || '').trim()
    if (sourceShot) {
      const source = byShot.get(`${positive(row.scene_id ?? row.sceneId)}:${sourceShot}`)
      if (source) {
        push({
          id: `storyboard-continuity:${source.storyboardId}:${storyboardId}`,
          fromNodeId: source.id,
          toNodeId: target.id,
          kind: 'storyboard-continuity',
          label: `片段衔接：镜头 ${source.shotNo} 尾帧 → 镜头 ${target.shotNo} 首帧`,
          storyboardIds: [source.storyboardId, storyboardId],
        })
      }
    }
  }
  return relations
}
