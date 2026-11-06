const CHARACTER_VIEW_ANGLES = Object.freeze([
  { key: 'front', label: '正面', index: 1, prompt: '正面全身' },
  { key: 'side', label: '严格侧面', index: 2, prompt: '严格左侧面全身' },
  { key: 'back', label: '背面', index: 3, prompt: '背面全身' },
])

const CHARACTER_FACE_CLOSEUP_ANGLES = Object.freeze([
  { key: 'face', label: '脸部特写', index: 1, prompt: '正面脸部特写' },
])

const SCENE_VIEW_ANGLES = Object.freeze([
  { key: 'front-left', label: '左前', index: 1 },
  { key: 'front', label: '正前', index: 2 },
  { key: 'front-right', label: '右前', index: 3 },
  { key: 'left', label: '左侧', index: 4 },
  { key: 'center', label: '正中', index: 5 },
  { key: 'right', label: '右侧', index: 6 },
  { key: 'back-left', label: '左后', index: 7 },
  { key: 'back', label: '正后', index: 8 },
  { key: 'back-right', label: '右后', index: 9 },
])

const PROP_VIEW_ANGLES = Object.freeze([
  { key: 'front', label: '正面', index: 1 },
  { key: 'side', label: '侧面', index: 2 },
  { key: 'back', label: '背面', index: 3 },
  { key: 'top', label: '俯视', index: 4 },
])

function text(value) {
  return String(value ?? '').trim()
}

function positiveInt(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function latestByViewKey(items = []) {
  const latest = new Map()
  for (const item of items) {
    const key = `${item.viewSetType}:${item.viewKey}`
    const current = latest.get(key)
    const currentVersion = positiveInt(current?.viewSetVersion) || 0
    const nextVersion = positiveInt(item.viewSetVersion) || 0
    if (
      !current
      || nextVersion > currentVersion
      || (nextVersion === currentVersion && (Number(item.imageId) || 0) > (Number(current.imageId) || 0))
    ) {
      latest.set(key, item)
    }
  }
  return [...latest.values()]
}

function normalizeStatus(value) {
  const status = text(value).toLowerCase()
  return status || 'candidate'
}

function parseCrop(value) {
  if (value && typeof value === 'object') return { ...value }
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? { ...parsed } : null
  } catch {
    return null
  }
}

export function getAssetViewAngles(viewSetType) {
  if (viewSetType === 'character-turnaround') return CHARACTER_VIEW_ANGLES
  if (viewSetType === 'character-face-closeup') return CHARACTER_FACE_CLOSEUP_ANGLES
  if (viewSetType === 'scene-nine-grid') return SCENE_VIEW_ANGLES
  if (viewSetType === 'prop-turnaround') return PROP_VIEW_ANGLES
  return []
}

export function normalizeAssetViewType(value) {
  const type = text(value)
  if (type === 'character-turnaround' || type === 'character-face-closeup' || type === 'scene-nine-grid' || type === 'prop-turnaround') return type
  return 'single'
}

export function buildAssetViewItems({
  imageId,
  assetNodeId,
  versionNo = 1,
  viewSetType = 'single',
  status = 'candidate',
  sourceImageUrl = null,
} = {}) {
  const normalizedType = normalizeAssetViewType(viewSetType)
  const angles = getAssetViewAngles(normalizedType)
  if (!angles.length) return []

  return angles.map((angle) => ({
    imageId: positiveInt(imageId),
    assetNodeId: positiveInt(assetNodeId),
    viewSetType: normalizedType,
    viewSetVersion: positiveInt(versionNo) || 1,
    viewIndex: angle.index,
    viewKey: angle.key,
    viewLabel: angle.label,
    sourceImageUrl: text(sourceImageUrl) || null,
    status: normalizeStatus(status),
  }))
}

export function normalizeAssetViewItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      imageId: positiveInt(item?.imageId ?? item?.image_id),
      assetNodeId: positiveInt(item?.assetNodeId ?? item?.asset_node_id),
      viewSetType: normalizeAssetViewType(item?.viewSetType ?? item?.view_set_type),
      viewSetVersion: positiveInt(item?.viewSetVersion ?? item?.view_set_version) || 1,
      viewIndex: positiveInt(item?.viewIndex ?? item?.view_index),
      viewKey: text(item?.viewKey ?? item?.view_key),
      viewLabel: text(item?.viewLabel ?? item?.view_label),
      sourceImageId: positiveInt(item?.sourceImageId ?? item?.source_image_id),
      sourceImageUrl: text(item?.sourceImageUrl ?? item?.source_image_url) || null,
      status: normalizeStatus(item?.status),
      crop: parseCrop(item?.crop ?? item?.crop_json),
      referencedStoryboardIds: Array.isArray(item?.referencedStoryboardIds)
        ? item.referencedStoryboardIds.map(positiveInt).filter(Boolean)
        : [],
    }))
    .filter((item) => item.viewIndex && item.viewKey)
}

/**
 * A retry creates a newer row for the same angle.  Validation must use that
 * row only; otherwise an older confirmed image can mask a newer failed one.
 */
export function selectLatestAssetViewItems(items = []) {
  return latestByViewKey(normalizeAssetViewItems(items))
    .sort((left, right) => left.viewIndex - right.viewIndex)
}

export function validateAssetViewSet({
  viewSetType,
  items = [],
  requireConfirmed = false,
} = {}) {
  const expected = getAssetViewAngles(normalizeAssetViewType(viewSetType))
  if (!expected.length) {
    return { ready: true, blockers: [], missing: [], invalid: [], items: [] }
  }

  const normalized = selectLatestAssetViewItems(items)
  const byIndex = new Map(normalized.map((item) => [item.viewIndex, item]))
  const missing = expected.filter((angle) => !byIndex.has(angle.index))
  const invalid = normalized.filter((item) => {
    const expectedAngle = expected.find((angle) => angle.index === item.viewIndex)
    return !expectedAngle || item.viewKey !== expectedAngle.key
  })
  const unconfirmed = requireConfirmed
    ? normalized.filter((item) => item.status !== 'confirmed')
    : []
  const blockers = [
    ...missing.map((angle) => `缺少${angle.label}视角`),
    ...invalid.map((item) => `视角编号 ${item.viewIndex} 与视角标识不匹配`),
    ...unconfirmed.map((item) => `${item.viewLabel || item.viewKey}视角尚未确认`),
  ]

  return {
    ready: blockers.length === 0,
    blockers,
    missing: missing.map((angle) => angle.key),
    invalid,
    unconfirmed,
    items: normalized,
  }
}

export function buildStoryboardAssetReference({
  storyboardId,
  characterId,
  characterVersionNo,
  characterViewSetVersion,
  characterViewKeys = [],
  sceneAssetId,
  scenePanoramaVersion,
  sceneViewSetVersion,
  sceneViewKey,
  sceneViewIndex,
  promptVersion = 1,
  agentVersion = '1',
} = {}) {
  return {
    schemaVersion: 1,
    storyboardId: positiveInt(storyboardId),
    characterId: positiveInt(characterId),
    characterVersionNo: positiveInt(characterVersionNo),
    characterViewSetVersion: positiveInt(characterViewSetVersion),
    characterViewKeys: Array.isArray(characterViewKeys)
      ? characterViewKeys.map(text).filter(Boolean)
      : [],
    sceneAssetId: positiveInt(sceneAssetId),
    scenePanoramaVersion: positiveInt(scenePanoramaVersion),
    sceneViewSetVersion: positiveInt(sceneViewSetVersion),
    sceneViewKey: text(sceneViewKey) || null,
    sceneViewIndex: positiveInt(sceneViewIndex),
    promptVersion: text(promptVersion) || '1',
    agentVersion: text(agentVersion) || '1',
  }
}

export function validateStoryboardAssetReference(reference = {}, options = {}) {
  const value = buildStoryboardAssetReference(reference)
  const blockers = []
  if (options.requireCharacter && !value.characterId) blockers.push('分镜缺少角色资产引用')
  if (options.requireCharacter && !value.characterVersionNo) blockers.push('分镜缺少角色版本引用')
  if (options.requireCharacter && !value.characterViewSetVersion) blockers.push('分镜缺少角色视角组版本引用')
  if (options.requireScene && !value.sceneAssetId) blockers.push('分镜缺少场景资产引用')
  if (options.requireScene && !value.scenePanoramaVersion) blockers.push('分镜缺少场景全景版本引用')
  // 允许仅使用已确认的全景基准生成视频；九宫格角度是增强引用，不是硬门禁。
  if (options.requireScene && value.sceneViewKey && !value.sceneViewSetVersion) blockers.push('分镜缺少场景视角组版本引用')
  return { ready: blockers.length === 0, blockers, reference: value }
}

export const ASSET_VIEW_ANGLES = Object.freeze({
  character: CHARACTER_VIEW_ANGLES,
  characterFaceCloseup: CHARACTER_FACE_CLOSEUP_ANGLES,
  scene: SCENE_VIEW_ANGLES,
  prop: PROP_VIEW_ANGLES,
})
