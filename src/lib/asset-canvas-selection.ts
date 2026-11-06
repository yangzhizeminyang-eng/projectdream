function finite(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

export function nodesIntersectingSelection(nodes: Array<{ id: number; x: number; y: number; width: number; height: number }>, rect: { left: number; top: number; right: number; bottom: number }): number[] {
  const left = Math.min(finite(rect.left), finite(rect.right))
  const right = Math.max(finite(rect.left), finite(rect.right))
  const top = Math.min(finite(rect.top), finite(rect.bottom))
  const bottom = Math.max(finite(rect.top), finite(rect.bottom))
  return nodes
    .filter((node) => {
      const x = finite(node.x)
      const y = finite(node.y)
      return x <= right && x + Math.max(0, finite(node.width)) >= left
        && y <= bottom && y + Math.max(0, finite(node.height)) >= top
    })
    .map((node) => node.id)
}

type AssetNodeImageLike = {
  status?: string | null
  visionStatus?: string | null
  viewSetType?: string | null
  viewKey?: string | null
}

export function getAssetNodeGenerationPlan(node: { nodeType: string; images: AssetNodeImageLike[] }) {
  const active = (node.images || []).filter((image) => image.status !== 'superseded')
  if (node.nodeType === 'character') {
    const pack = active.find((image) => image.viewSetType === 'character-asset-pack')
    if (pack && pack.status !== 'failed' && pack.visionStatus !== 'failed') {
      return { kind: 'skip' as const, reason: pack.status === 'confirmed' ? '角色资产板已采用' : '角色资产板检查中' }
    }
    return { kind: 'base' as const }
  }
  if (node.nodeType === 'scene') {
    const panorama = active.find((image) => image.viewSetType === 'single'
      && image.status === 'confirmed' && image.visionStatus === 'passed')
    if (!panorama) {
      return active.some((image) => image.viewSetType === 'single' && image.status !== 'failed' && image.status !== 'confirmed')
        ? { kind: 'skip' as const, reason: '全景候选待确认' }
        : { kind: 'panorama' as const }
    }
    const keys = ['front-left', 'front', 'front-right', 'left', 'center', 'right', 'back-left', 'back', 'back-right'] as const
    const views = keys.filter((viewKey) =>
      !active.some((image) => image.viewSetType === 'scene-nine-grid' && image.viewKey === viewKey && image.status !== 'failed'),
    )
    return views.length ? { kind: 'scene-views' as const, views } : { kind: 'skip' as const, reason: '场景视角已存在候选或已确认' }
  }
  if (['prop', 'material'].includes(node.nodeType)) {
    const candidate = active.some((image) => image.viewSetType === 'single'
      && image.status !== 'failed' && image.status !== 'confirmed')
    return candidate
      ? { kind: 'skip' as const, reason: '道具图片检查中' }
      : { kind: 'prop-base' as const }
  }
  return { kind: 'single' as const }
}
