function text(value) {
  return String(value ?? '').trim()
}

function positiveInt(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function isConfirmedAssetImage(row, nodeType) {
  if (text(row?.status) !== 'confirmed') return false
  const visionStatus = text(row?.vision_status)
  return visionStatus === 'passed' || (nodeType === 'scene' && visionStatus === 'skipped')
}

function imageSnapshot(row) {
  return {
    imageId: positiveInt(row?.image_id),
    versionNo: positiveInt(row?.version_no, 1),
    viewSetVersion: positiveInt(row?.view_set_version, 1),
    viewIndex: positiveInt(row?.view_index),
    viewKey: text(row?.view_key) || null,
    viewSetType: text(row?.view_set_type) || 'single',
    status: 'confirmed',
    visionStatus: text(row?.vision_status),
  }
}

function mergeImage(entry, row) {
  const image = imageSnapshot(row)
  if (!image.imageId) return
  const duplicate = entry.confirmedImages.some((item) => item.imageId === image.imageId)
  if (!duplicate) entry.confirmedImages.push(image)
  if (image.viewKey && !entry.sceneViewKeys.includes(image.viewKey)) entry.sceneViewKeys.push(image.viewKey)
  entry.versionNo = Math.max(entry.versionNo, image.versionNo)
  entry.viewSetVersion = Math.max(entry.viewSetVersion, image.viewSetVersion)
}

function newEntry(row) {
  const assetNodeId = positiveInt(row?.asset_node_id)
  return {
    name: text(row?.label),
    assetNodeId,
    nodeType: text(row?.node_type),
    refId: positiveInt(row?.ref_id),
    assetPrompt: text(row?.asset_prompt) || null,
    versionNo: 0,
    viewSetVersion: 0,
    sceneViewKeys: [],
    confirmedImages: [],
  }
}

/**
 * Build the confirmed asset snapshot consumed by storyboard prompts and RAG.
 * The SQL query may contain one row per confirmed image, so this function
 * groups by asset node and deliberately drops unconfirmed image rows.
 */
export function buildStoryboardAssetCatalog(assetRows = [], sceneId = 0) {
  const rows = Array.isArray(assetRows) ? assetRows : []
  const scenes = new Map()
  const props = new Map()
  for (const row of rows) {
    const nodeType = text(row?.node_type)
    if (!isConfirmedAssetImage(row, nodeType)) continue
    const name = text(row?.label)
    const assetNodeId = positiveInt(row?.asset_node_id)
    if (!name || !assetNodeId) continue
    if (nodeType === 'scene' && (!positiveInt(sceneId) || positiveInt(row?.ref_id) === positiveInt(sceneId))) {
      const key = String(assetNodeId)
      const entry = scenes.get(key) || newEntry(row)
      mergeImage(entry, row)
      scenes.set(key, entry)
    }
    if (['prop', 'tool', 'material'].includes(nodeType)) {
      const key = String(assetNodeId)
      const entry = props.get(key) || newEntry(row)
      mergeImage(entry, row)
      props.set(key, entry)
    }
  }
  return {
    scenes: [...scenes.values()],
    props: [...props.values()],
    tools: ['添加时间', '片段衔接', '首尾帧参考', '环境音'],
  }
}
