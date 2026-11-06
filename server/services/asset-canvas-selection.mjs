function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

export function nodesIntersectingSelection(nodes = [], rect = {}) {
  const left = Math.min(finite(rect.left), finite(rect.right))
  const right = Math.max(finite(rect.left), finite(rect.right))
  const top = Math.min(finite(rect.top), finite(rect.bottom))
  const bottom = Math.max(finite(rect.top), finite(rect.bottom))
  return (Array.isArray(nodes) ? nodes : [])
    .filter((node) => {
      const x = finite(node?.x)
      const y = finite(node?.y)
      const width = Math.max(0, finite(node?.width))
      const height = Math.max(0, finite(node?.height))
      return x <= right && x + width >= left && y <= bottom && y + height >= top
    })
    .map((node) => Number(node.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0)
}

export function getAssetNodeGenerationPlan(node = {}) {
  const images = Array.isArray(node.images) ? node.images : []
  const active = images.filter((image) => image?.status !== 'superseded')
  if (node.nodeType === 'character') {
    const pack = active.find((image) => image.viewSetType === 'character-asset-pack')
    if (pack && pack.status !== 'failed' && pack.status !== 'confirmed') return { kind: 'skip', reason: '角色资产板检查中' }
    return { kind: 'base' }
  }
  if (node.nodeType === 'scene') {
    const panorama = active.find((image) => image.viewSetType === 'single'
      && image.status === 'confirmed' && ['passed', 'skipped'].includes(image.visionStatus))
    if (!panorama) {
      const candidate = active.some((image) => image.viewSetType === 'single'
        && image.status !== 'failed' && image.status !== 'confirmed')
      return candidate ? { kind: 'skip', reason: '全景候选待确认' } : { kind: 'panorama' }
    }
    const keys = ['front-left', 'front', 'front-right', 'left', 'center', 'right', 'back-left', 'back', 'back-right']
    const views = keys.filter((viewKey) => !active.some((image) => image.viewSetType === 'scene-nine-grid'
      && image.viewKey === viewKey && image.status !== 'failed'))
    return views.length ? { kind: 'scene-views', views } : { kind: 'skip', reason: '场景视角已存在候选或已确认' }
  }
  if (['prop', 'material'].includes(node.nodeType)) {
    const candidate = active.some((image) => image.viewSetType === 'single' && image.status !== 'failed' && image.status !== 'confirmed')
    return candidate ? { kind: 'skip', reason: '道具图片检查中' } : { kind: 'prop-base' }
  }
  return { kind: 'single' }
}
