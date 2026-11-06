export type AssetImageGroupKey = 'character-asset-pack' | 'single' | 'character-turnaround' | 'character-face-closeup' | 'scene-nine-grid' | 'prop-turnaround'
export type AssetImageGroupNodeType = 'character' | 'scene' | 'prop' | 'material' | string

export interface AssetImageLike {
  id: number
  imageUrl?: string | null
  thumbnailUrl?: string | null
  viewSetType?: string | null
  viewSetVersion?: number | null
  viewIndex?: number | null
  viewKey?: string | null
  sourceImageId?: number | null
  versionNo?: number | null
  status?: string | null
  visionStatus?: string | null
  createdAt?: string | null
}

export const SCENE_NINE_GRID_VIEW_KEYS = [
  'front-left', 'front', 'front-right',
  'left', 'center', 'right',
  'back-left', 'back', 'back-right',
] as const

export function hasCompleteSceneNineGrid<T extends AssetImageLike>(images: T[] | null | undefined): boolean {
  const views = selectSceneNineGridImages(images)
  return SCENE_NINE_GRID_VIEW_KEYS.every((viewKey) => {
    const image = views.find((item) => item.viewKey === viewKey)
    return Boolean(image && (image.imageUrl || image.thumbnailUrl) && isVisionPassed(image, 'scene'))
  })
}

function sceneBatchVersion<T extends AssetImageLike>(image: T): number {
  return Number(image.viewSetVersion || image.versionNo || 0)
}

/** Never combine angles from different retries into one synthetic nine-grid. */
export function selectSceneNineGridBatch<T extends AssetImageLike>(
  images: T[] | null | undefined,
  sourceImageId: number | null | undefined,
): T[] {
  const sourceId = Number(sourceImageId || 0)
  if (!sourceId) return []
  const scoped = (Array.isArray(images) ? images : [])
    .filter((item) => item.viewSetType === 'scene-nine-grid'
      && item.viewKey
      && Number(item.sourceImageId || 0) === sourceId
      && isVisible(item))
  const batches = new Map<number, T[]>()
  for (const item of scoped) {
    const version = sceneBatchVersion(item)
    batches.set(version, [...(batches.get(version) || []), item])
  }
  const ranked = [...batches.entries()].sort((left, right) => {
    const leftPassed = left[1].filter((image) => isVisionPassed(image, 'scene')).length
    const rightPassed = right[1].filter((image) => isVisionPassed(image, 'scene')).length
    return rightPassed - leftPassed || right[0] - left[0]
  })
  const latestByKey = new Map<string, T>()
  for (const item of (ranked[0]?.[1] || []).slice().sort(byNewest)) {
    if (!latestByKey.has(String(item.viewKey))) latestByKey.set(String(item.viewKey), item)
  }
  return [...latestByKey.values()].sort((left, right) => Number(left.viewIndex || 0) - Number(right.viewIndex || 0))
}

export function hasCompleteSceneNineGridBatch<T extends AssetImageLike>(
  images: T[] | null | undefined,
  sourceImageId: number | null | undefined,
): boolean {
  return hasCompleteSceneNineGrid(selectSceneNineGridBatch(images, sourceImageId))
}

export interface AssetImageGroup<T extends AssetImageLike = AssetImageLike> {
  key: AssetImageGroupKey
  label: string
  images: T[]
  confirmed: T | null
  latest: T | null
}

// 基础图永远先于派生视图展示，和实际创作门禁保持一致。
const GROUP_ORDER: AssetImageGroupKey[] = ['character-asset-pack', 'single', 'character-turnaround', 'character-face-closeup', 'scene-nine-grid', 'prop-turnaround']

function normalizedKey(value: string | null | undefined): AssetImageGroupKey | null {
  const key = String(value || 'single').trim()
  return GROUP_ORDER.includes(key as AssetImageGroupKey) ? (key as AssetImageGroupKey) : null
}

function timestamp(image: AssetImageLike): number {
  const parsed = Date.parse(String(image.createdAt || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function byNewest<T extends AssetImageLike>(left: T, right: T): number {
  const timeDelta = timestamp(right) - timestamp(left)
  if (timeDelta !== 0) return timeDelta
  return Number(right.id || 0) - Number(left.id || 0)
}

function isVisionPassed<T extends AssetImageLike>(image: T, nodeType?: AssetImageGroupNodeType): boolean {
  const visionStatus = String(image.visionStatus || '').toLowerCase()
  return !('visionStatus' in image)
    || visionStatus === 'passed'
    || (nodeType === 'scene' && visionStatus === 'skipped')
}

function isVisible<T extends AssetImageLike>(image: T): boolean {
  const status = String(image.status || '').toLowerCase()
  const visionStatus = String(image.visionStatus || '').toLowerCase()
  return status !== 'superseded' && status !== 'failed' && visionStatus !== 'failed'
}

function pickCurrent<T extends AssetImageLike>(images: T[], nodeType?: AssetImageGroupNodeType): T | null {
  return images.find((image) => isVisionPassed(image, nodeType) || String(image.status || '').toLowerCase() === 'confirmed')
    || images[0]
    || null
}

function labelFor(key: AssetImageGroupKey, nodeType: AssetImageGroupNodeType): string {
  if (nodeType === 'character' && key === 'character-turnaround') return '角色三视图'
  if (nodeType === 'character' && key === 'character-face-closeup') return '角色脸部特写'
  if (nodeType === 'character' && key === 'character-asset-pack') return '角色资产板'
  if (nodeType === 'character' && key === 'single') return '角色基础正面图'
  if (nodeType === 'scene' && key === 'single') return '场景全景基准'
  if (nodeType === 'scene' && key === 'scene-nine-grid') return '场景九宫格'
  if ((nodeType === 'prop' || nodeType === 'material') && key === 'single') return '道具基础图'
  if ((nodeType === 'prop' || nodeType === 'material') && key === 'prop-turnaround') return '道具多视角'
  if (key === 'character-turnaround') return '角色三视图'
  if (key === 'character-face-closeup') return '角色脸部特写'
  if (key === 'character-asset-pack') return '角色资产板'
  if (key === 'scene-nine-grid') return '场景九宫格'
  if (key === 'prop-turnaround') return '道具多视角'
  return '当前资产图'
}

export function selectAssetPreviewImage<T extends AssetImageLike>(
  groups: AssetImageGroup<T>[],
  nodeType: AssetImageGroupNodeType,
): T | null {
  const base = groups.find((group) => group.key === 'single')
  if (nodeType === 'character') {
    return (
      groups.find((group) => group.key === 'character-asset-pack')?.confirmed ||
      groups.find((group) => group.key === 'character-asset-pack')?.latest ||
      base?.confirmed ||
      base?.latest ||
      groups.find((group) => group.key === 'character-turnaround')?.confirmed ||
      groups.find((group) => group.key === 'character-turnaround')?.latest ||
      null
    )
  }

  return (
    groups.find((group) => group.confirmed)?.confirmed ||
    groups[0]?.latest ||
    null
  )
}

export function groupAssetNodeImages<T extends AssetImageLike>(
  images: T[] | null | undefined,
  nodeType: AssetImageGroupNodeType,
  fallbackImage?: T | null,
): AssetImageGroup<T>[] {
  const buckets = new Map<AssetImageGroupKey, T[]>()

  const sourceImages = Array.isArray(images) ? images.slice() : []
  if (fallbackImage && !sourceImages.some((image) => image.id === fallbackImage.id)) {
    sourceImages.push(fallbackImage)
  }

  for (const image of sourceImages) {
    const key = normalizedKey(image?.viewSetType)
    if (!key) continue
    const bucket = buckets.get(key) || []
    bucket.push(image)
    buckets.set(key, bucket)
  }

  return GROUP_ORDER.flatMap((key) => {
    const bucket = buckets.get(key)
    if (!bucket?.length) return []
    const sorted = bucket.slice().sort(byNewest)
    const latestByViewKey = new Map<string, T>()
    const confirmedByViewKey = new Map<string, T>()
    const viewKeys = new Set(sorted.map((image) => String(image.viewKey || '').trim() || '__single__'))
    for (const viewKey of viewKeys) {
      const sameView = sorted.filter((candidate) =>
        (String(candidate.viewKey || '').trim() || '__single__') === viewKey,
      )
      const active = sameView.filter(isVisible)
      const current = pickCurrent(active, nodeType) || sameView[0]
      if (current) latestByViewKey.set(viewKey, current)
      const confirmedImage = active.find((candidate) =>
        String(candidate.status || '').toLowerCase() === 'confirmed' && isVisionPassed(candidate, nodeType),
      )
      if (confirmedImage) confirmedByViewKey.set(viewKey, confirmedImage)
    }
    /*
     * Keep a failed-only view in the current group so the UI can explain why
     * it is empty. When an older usable image exists, pickCurrent above keeps
     * that image visible and the failed retry remains in history.
     */
    for (const image of sorted) {
      const viewKey = String(image.viewKey || '').trim() || '__single__'
      if (!latestByViewKey.has(viewKey)) latestByViewKey.set(viewKey, image)
    }
    const currentImages: T[] = [...latestByViewKey.values()].sort(byNewest)
    const confirmed =
          key === 'character-turnaround' || key === 'prop-turnaround'
        ? ((key === 'character-turnaround' ? ['front', 'side', 'back'] : ['front', 'side', 'back', 'top']).every((viewKey) => {
            return confirmedByViewKey.has(viewKey)
          })
            ? currentImages.find((image) => image.id === Math.max(
                ...(key === 'character-turnaround' ? ['front', 'side', 'back'] : ['front', 'side', 'back', 'top'])
                  .map((viewKey) => confirmedByViewKey.get(viewKey)!.id),
              )) || null
            : null)
      : confirmedByViewKey.get('__single__') || null
    return [{
      key,
      label: labelFor(key, nodeType),
      // Superseded rows remain in the API for audit/history, but the canvas
      // must show one current image per angle instead of growing a candidate list.
      images: currentImages,
      confirmed,
      latest: currentImages[0] || null,
    }]
  })
}

/**
 * Return the newest independent scene cell for each of the nine view keys.
 * The mother image has no view key and is intentionally excluded.
 */
export function selectSceneNineGridImages<T extends AssetImageLike>(
  images: T[] | null | undefined,
): T[] {
  const latestByViewKey = new Map<string, T>()
  for (const image of (Array.isArray(images) ? images : [])
    .filter((item) => item.viewSetType === 'scene-nine-grid'
      && item.viewKey && item.viewIndex
      && isVisible(item))
    .slice()
    .sort(byNewest)) {
    const key = String(image.viewKey)
    if (!latestByViewKey.has(key)) latestByViewKey.set(key, image)
  }
  for (const [viewKey, image] of latestByViewKey) {
    const sameView = (Array.isArray(images) ? images : [])
      .filter((candidate) => candidate.viewSetType === 'scene-nine-grid'
        && candidate.viewKey && candidate.viewIndex
        && String(candidate.viewKey) === viewKey
        && isVisible(candidate))
      .slice()
      .sort(byNewest)
    latestByViewKey.set(viewKey, pickCurrent(sameView) || image)
  }
  return [...latestByViewKey.values()].sort(
    (left, right) => Number(left.viewIndex || 0) - Number(right.viewIndex || 0),
  )
}

/**
 * Return the current attempt for each view, including a failed attempt when
 * no usable image exists. This is for truthful retry feedback only; completion
 * still uses selectSceneNineGridImages + hasCompleteSceneNineGrid.
 */
export function selectSceneNineGridAttempts<T extends AssetImageLike>(
  images: T[] | null | undefined,
): T[] {
  const attemptsByViewKey = new Map<string, T[]>()
  for (const image of (Array.isArray(images) ? images : [])
    .filter((item) => item.viewSetType === 'scene-nine-grid'
      && item.viewKey && item.viewIndex
      && String(item.status || '').toLowerCase() !== 'superseded')
    .slice()
    .sort(byNewest)) {
    const key = String(image.viewKey)
    const attempts = attemptsByViewKey.get(key) || []
    attempts.push(image)
    attemptsByViewKey.set(key, attempts)
  }

  const current = []
  for (const attempts of attemptsByViewKey.values()) {
    const usable = attempts.filter(isVisible)
    current.push(pickCurrent(usable) || attempts[0])
  }
  return current.filter((item): item is T => Boolean(item)).sort(
    (left, right) => Number(left.viewIndex || 0) - Number(right.viewIndex || 0),
  )
}
