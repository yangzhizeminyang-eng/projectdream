/**
 * @file 资产画布（Asset Canvas）纯函数服务
 * @description
 * 画布节点是「形象变体」层，和角色身份层（characters / character_images）严格分开：
 * - characters + character_images 是角色身份：唯一确认、锁定、版本化，管一致性门禁
 * - asset_nodes + asset_node_images 是形象的时空变体：同一角色可以并存多个，各自带提示词和图
 *
 * 这样切分的原因是 confirmCharacterImage 会把同角色其它 confirmed 降级、改写
 * characters.reference_image_url 并推高角色版本，无法承载「小光 5 个形象」。
 *
 * 本模块只做纯计算，不碰数据库，方便用 node --test 直接回归。
 */

import {
  normalizeAssetViewItems,
  selectLatestAssetViewItems,
  validateAssetViewSet,
} from './asset-view-contract.mjs'
import { buildAssetGroups } from './asset-grouping.mjs'
import { isCharacterAssetPackRow } from './asset-pack-lifecycle.mjs'

const ASSET_NODE_TYPES = ['character', 'scene', 'prop', 'material']
const ASSET_NODE_TYPE_SET = new Set(ASSET_NODE_TYPES)

export const ASSET_NODE_DEFAULT_WIDTH = 220
export const ASSET_NODE_DEFAULT_HEIGHT = 260

/** 节点最小/最大边长，防止被缩成一条线或撑爆画布 */
export const ASSET_NODE_MIN_SIDE = 160
export const ASSET_NODE_MAX_SIDE = 640

/** 坐标安全边界：无限画布允许负坐标，但不接受明显是脏数据的量级 */
export const ASSET_NODE_COORDINATE_LIMIT = 100000
export const ASSET_CANVAS_LAYOUT_GAP_X = 72
export const ASSET_CANVAS_LAYOUT_GAP_Y = 56
export const ASSET_CANVAS_LAYOUT_MARGIN = 48
export const ASSET_CANVAS_GROUP_PADDING = 26
// The label may contain a long asset name, detail text, and an action button.
// Reserve a real track for it so it never shares pixels with a node image.
export const ASSET_CANVAS_GROUP_HEADER_HEIGHT = 88

function text(value) {
  return String(value ?? '').trim()
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

function isUsableAssetImage(image = {}, nodeType = '') {
  const imageUrl = text(image.imageUrl ?? image.image_url)
  const modelName = text(image.modelName ?? image.model_name).toLowerCase()
  const status = text(image.status).toLowerCase()
  const visionStatus = text(image.visionStatus ?? image.vision_status).toLowerCase()
  if (!imageUrl || imageUrl.includes('/mock-assets/') || modelName.startsWith('mock-')) return false
  if (status === 'superseded' || status === 'failed') return false
  if (visionStatus && visionStatus !== 'passed' && !(nodeType === 'scene' && visionStatus === 'skipped')) return false
  return true
}

function finiteNumberOrNull(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  const raw = text(value)
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function roundToTwoDecimals(value) {
  return Math.round(value * 100) / 100
}

function layoutSort(left, right) {
  const typeOrder = { character: 0, scene: 1, prop: 2, material: 3 }
  const leftType = typeOrder[normalizeAssetNodeType(left?.nodeType ?? left?.node_type)] ?? 9
  const rightType = typeOrder[normalizeAssetNodeType(right?.nodeType ?? right?.node_type)] ?? 9
  if (leftType !== rightType) return leftType - rightType
  return String(left?.label || '').localeCompare(String(right?.label || ''), 'zh-CN')
    || Number(left?.id || 0) - Number(right?.id || 0)
}

/**
 * 为资产画布生成稳定的整齐布局：
 * 每个角色/场景实体组占一列，组内状态节点从上到下排列。
 * 该函数只计算坐标，不改变节点内容和用户的尺寸。
 */
export function buildAssetCanvasLayout(nodes = [], options = {}) {
  const normalized = (Array.isArray(nodes) ? nodes : []).map((node) => ({
    ...node,
    ...normalizeAssetNodeLayout(node),
    nodeType: normalizeAssetNodeType(node?.nodeType ?? node?.node_type) || 'material',
  }))
  const groups = buildAssetGroups(normalized)
  const byId = new Map(normalized.map((node) => [Number(node.id), node]))
  const gapX = Number(options.gapX) > 0 ? Number(options.gapX) : ASSET_CANVAS_LAYOUT_GAP_X
  const gapY = Number(options.gapY) > 0 ? Number(options.gapY) : ASSET_CANVAS_LAYOUT_GAP_Y
  const margin = Number(options.margin) >= 0 ? Number(options.margin) : ASSET_CANVAS_LAYOUT_MARGIN
  const headerHeight = Number(options.headerHeight) >= 0
    ? Number(options.headerHeight)
    : ASSET_CANVAS_GROUP_HEADER_HEIGHT
  const positioned = []
  let cursorX = margin

  for (const group of groups.sort((left, right) => {
    const leftNode = byId.get(left.nodeIds[0])
    const rightNode = byId.get(right.nodeIds[0])
    return layoutSort(leftNode, rightNode)
  })) {
    const groupNodes = group.nodeIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort((left, right) =>
        String(left.appearanceLabel || '').localeCompare(String(right.appearanceLabel || ''), 'zh-CN')
          || Number(left.id) - Number(right.id),
      )
    const groupWidth = Math.max(...groupNodes.map((node) => node.width))
    let cursorY = margin + headerHeight
    for (const node of groupNodes) {
      positioned.push({
        id: Number(node.id),
        x: cursorX,
        y: cursorY,
        width: node.width,
        height: node.height,
      })
      cursorY += node.height + gapY
    }
    cursorX += groupWidth + gapX
  }
  return positioned
}

/**
 * Recalculate group frames from the coordinates that will actually be rendered.
 * Group frames include their own header space and never depend on persisted stale bounds.
 */
export function buildAssetCanvasGroupBounds(nodes = [], options = {}) {
  const padding = Number(options.padding) >= 0
    ? Number(options.padding)
    : ASSET_CANVAS_GROUP_PADDING
  const headerHeight = Number(options.headerHeight) >= 0
    ? Number(options.headerHeight)
    : ASSET_CANVAS_GROUP_HEADER_HEIGHT
  const normalizedNodes = (Array.isArray(nodes) ? nodes : []).map((node) => ({
    ...node,
    ...normalizeAssetNodeLayout(node),
  }))
  const byId = new Map(normalizedNodes.map((node) => [Number(node.id), node]))

  return buildAssetGroups(normalizedNodes).map((group) => {
    const groupNodes = group.nodeIds.map((id) => byId.get(id)).filter(Boolean)
    const minX = Math.min(...groupNodes.map((node) => Number(node.x) || 0)) - padding
    const minY = Math.min(...groupNodes.map((node) => Number(node.y) || 0)) - padding - headerHeight
    const maxX = Math.max(...groupNodes.map((node) =>
      (Number(node.x) || 0) + normalizeSide(node.width, ASSET_NODE_DEFAULT_WIDTH),
    )) + padding
    const maxY = Math.max(...groupNodes.map((node) =>
      (Number(node.y) || 0) + normalizeSide(node.height, ASSET_NODE_DEFAULT_HEIGHT),
    )) + padding

    return {
      ...group,
      bounds: {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      },
    }
  })
}

/**
 * 归一化节点类型。
 * 未知类型一律返回 null 由调用方报 400，不回落到任何默认分类——
 * 静默归类会让「场景」悄悄变成「素材」，之后再也分不出来。
 */
export function normalizeAssetNodeType(value) {
  const normalized = text(value).toLowerCase()
  return ASSET_NODE_TYPE_SET.has(normalized) ? normalized : null
}

function normalizeSide(value, fallback) {
  const parsed = finiteNumberOrNull(value)
  // 非数字或非正数属于脏数据，回落默认尺寸；正数但越界才钳制
  if (parsed === null || parsed <= 0) return fallback
  return Math.min(ASSET_NODE_MAX_SIDE, Math.max(ASSET_NODE_MIN_SIDE, Math.round(parsed)))
}

function normalizeCoordinate(value) {
  const parsed = finiteNumberOrNull(value)
  if (parsed === null) return 0
  return roundToTwoDecimals(
    Math.min(ASSET_NODE_COORDINATE_LIMIT, Math.max(-ASSET_NODE_COORDINATE_LIMIT, parsed)),
  )
}

/**
 * 归一化节点在画布上的位置与尺寸。
 * 任何 NaN / Infinity / 非数字字符串都不能写进数据库，
 * 否则画布会整片节点错位且刷新后不可恢复。
 */
export function normalizeAssetNodeLayout(node = {}) {
  return {
    x: normalizeCoordinate(node.x),
    y: normalizeCoordinate(node.y),
    width: normalizeSide(node.width, ASSET_NODE_DEFAULT_WIDTH),
    height: normalizeSide(node.height, ASSET_NODE_DEFAULT_HEIGHT),
  }
}

/** 数据库行 → 节点形象 DTO */
export function assetNodeImageRow(row = {}) {
  const imageUrl = text(row.image_url ?? row.imageUrl)
  const thumbnailUrl = text(row.thumbnail_url ?? row.thumbnailUrl) || imageUrl
  return {
    id: Number(row.id),
    assetNodeId: Number(row.asset_node_id ?? row.assetNodeId),
    versionNo: Number(row.version_no ?? row.versionNo ?? 1),
    imageUrl,
    storageKey: text(row.storage_key ?? row.storageKey) || null,
    thumbnailUrl,
    promptSnapshot: text(row.prompt_snapshot ?? row.promptSnapshot),
    modelName: text(row.model_name ?? row.modelName) || null,
    viewSetType: text(row.view_set_type ?? row.viewSetType) || 'single',
    viewSetVersion: Number(row.view_set_version ?? row.viewSetVersion ?? row.version_no ?? 1),
    viewIndex: Number(row.view_index ?? row.viewIndex) || null,
    viewKey: text(row.view_key ?? row.viewKey) || null,
    viewLabel: text(row.view_label ?? row.viewLabel) || null,
    sourceImageId: Number(row.source_image_id ?? row.sourceImageId) || null,
    sourceImageUrl: text(row.source_image_url ?? row.sourceImageUrl) || null,
    crop: parseCrop(row.crop_json ?? row.crop),
    characterIdentityLock: parseCrop(row.character_identity_lock_json ?? row.characterIdentityLock),
    identityStatus: text(row.identity_status ?? row.identityStatus) || 'not_checked',
    identityReason: text(row.identity_reason ?? row.identityReason) || null,
    identitySimilarityScore: finiteNumberOrNull(row.identity_similarity_score ?? row.identitySimilarityScore),
    wardrobeConsistencyScore: finiteNumberOrNull(row.wardrobe_consistency_score ?? row.wardrobeConsistencyScore),
    visionStatus: text(row.vision_status ?? row.visionStatus) || 'pending',
    visionReason: text(row.vision_reason ?? row.visionReason) || null,
    visionCheckedAt: row.vision_checked_at ?? row.visionCheckedAt ?? null,
    status: text(row.status) || 'candidate',
    confirmedAt: row.confirmed_at ?? row.confirmedAt ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
  }
}

/**
 * 节点状态必须从真实图片派生，不读数据库里的 status 字段。
 * 存一个「已完成」标记而实际没有图，就是把展示当真实结论——
 * 这个项目在别处反复栽过这个跟头（把声明比例当真实画布、把 videoUrl 当真实素材）。
 */
export function deriveAssetNodeState(images = [], nodeType = '') {
  const list = Array.isArray(images) ? images : []
  if (list.some((image) => text(image?.status) === 'confirmed' && isUsableAssetImage(image, nodeType))) {
    return 'confirmed'
  }
  if (list.some((image) => {
    const status = text(image?.status).toLowerCase()
    const visionStatus = text(image?.visionStatus ?? image?.vision_status).toLowerCase()
    return status !== 'superseded' && status !== 'failed' && visionStatus !== 'failed'
  })) return 'ready'
  return 'draft'
}

function normalizeNode(row = {}) {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id ?? row.projectId),
    nodeType: normalizeAssetNodeType(row.node_type ?? row.nodeType),
    refId: row.ref_id == null && row.refId == null ? null : Number(row.ref_id ?? row.refId),
    label: text(row.label),
    appearanceLabel: text(row.appearance_label ?? row.appearanceLabel) || null,
    promptText: text(row.prompt_text ?? row.promptText),
    turnaroundPromptText: text(row.turnaround_prompt_text ?? row.turnaroundPromptText),
    environmentPromptText: text(row.environment_prompt_text ?? row.environmentPromptText),
    negativePrompt: text(row.negative_prompt ?? row.negativePrompt),
    x: Number(row.x ?? 0),
    y: Number(row.y ?? 0),
    width: Number(row.width ?? ASSET_NODE_DEFAULT_WIDTH),
    height: Number(row.height ?? ASSET_NODE_DEFAULT_HEIGHT),
    groupKey: text(row.group_key ?? row.groupKey) || null,
    characterIdentityLock: parseCrop(row.character_identity_lock_json ?? row.characterIdentityLock),
    lifecycleStatus: text(row.status) || 'active',
  }
}

/**
 * 按类型计数 + 「待补充」计数。
 * 「待补充」对应参考产品角色卡片上那个橙色数字，只统计完全没有图的节点；
 * 已经有候选图但还没确认的，属于 ready，不算待补充。
 */
export function summarizeAssetCanvas(nodes = []) {
  const byType = { character: 0, scene: 0, prop: 0, material: 0 }
  let pendingCount = 0
  let readyCount = 0
  let confirmedCount = 0

  for (const node of Array.isArray(nodes) ? nodes : []) {
    const type = normalizeAssetNodeType(node?.nodeType ?? node?.node_type)
    if (type) byType[type] += 1

    const state = text(node?.state) || 'draft'
    if (state === 'confirmed') confirmedCount += 1
    else if (state === 'ready') readyCount += 1
    else pendingCount += 1
  }

  return {
    total: byType.character + byType.scene + byType.prop + byType.material,
    byType,
    pendingCount,
    readyCount,
    confirmedCount,
  }
}

/**
 * 为历史场景节点提供确定性关联候选。
 * 旧版本可能只保存了 label，没有保存 ref_id；这里只做纯函数匹配，
 * 数据库写回由路由层在确认唯一匹配后执行，避免把相似场景误绑。
 */
export function findSceneNodeMatch(node = {}, scenes = []) {
  if (normalizeAssetNodeType(node?.nodeType ?? node?.node_type) !== 'scene') return null
  const availableScenes = Array.isArray(scenes) ? scenes : []
  const groupKey = text(node?.groupKey ?? node?.group_key)
  const groupedSceneId = groupKey.match(/^scene:(\d+)(?::|$)/u)?.[1]
  if (groupedSceneId) {
    const groupedScene = availableScenes.find((scene) => Number(scene?.id) === Number(groupedSceneId))
    if (groupedScene) return groupedScene
  }
  const linkedId = Number(node?.refId ?? node?.ref_id)
  if (linkedId > 0) {
    const linkedScene = availableScenes.find((scene) => Number(scene?.id) === linkedId)
    if (linkedScene) return linkedScene
    // 重新解析剧本会删除旧 script_scenes 行，但画布节点可能暂时保留旧 ref_id。
    // 此时继续使用标签做确定性回退，避免旧节点永久失去场景提示词。
  }
  const label = text(node?.label)
  if (!label) return null
  const candidates = availableScenes.filter((scene) => {
    const title = text(scene?.title)
    return title && (title === label || `${title} · ${text(scene?.time_of_day)}` === label)
  })
  if (candidates.length === 1) return candidates[0]

  // 新版画布标签包含“场景01”，旧版节点常只保留这个编号和情绪钩子。
  // 只有项目内该 scene_no 唯一时才回退，跨集同号场景保持阻断，交给显式重绑。
  const sceneNo = label.match(/(?:场景|scene)\s*0*(\d+)/iu)?.[1]
  if (!sceneNo) return null
  const numbered = availableScenes.filter((scene) => Number(scene?.scene_no ?? scene?.sceneNo) === Number(sceneNo))
  return numbered.length === 1 ? numbered[0] : null
}

/**
 * 组装画布视图：节点 + 各自形象 + 汇总计数。
 * 一次返回整张画布，避免前端为每个节点各发一次请求。
 */
export function buildAssetCanvasView({ projectId, nodes = [], images = [] } = {}) {
  const imagesByNode = new Map()
  const nodeTypeById = new Map((Array.isArray(nodes) ? nodes : [])
    .map((node) => [Number(node.id), normalizeAssetNodeType(node.node_type ?? node.nodeType)]))
  for (const image of Array.isArray(images) ? images : []) {
    const nodeId = Number(image?.asset_node_id ?? image?.assetNodeId)
    if (!Number.isSafeInteger(nodeId)) continue
    const normalizedImage = nodeTypeById.get(nodeId) === 'character' && isCharacterAssetPackRow(image)
      ? {
          ...image,
          view_set_type: 'character-asset-pack',
          viewSetType: 'character-asset-pack',
          view_key: null,
          viewKey: null,
          view_index: null,
          viewIndex: null,
          view_label: '角色资产板',
          viewLabel: '角色资产板',
        }
      : image
    if (!imagesByNode.has(nodeId)) imagesByNode.set(nodeId, [])
    imagesByNode.get(nodeId).push(assetNodeImageRow(normalizedImage))
  }

  const viewNodes = (Array.isArray(nodes) ? nodes : []).map((row) => {
    const nodeImages = (imagesByNode.get(Number(row.id)) || [])
      .slice()
      .sort((left, right) => left.id - right.id)
    const latestViewImages = new Map()
    for (const image of nodeImages) {
      if (image.viewSetType === 'character-turnaround' && image.viewKey) {
        const current = latestViewImages.get(image.viewKey)
        if (!current || image.id > current.id) latestViewImages.set(image.viewKey, image)
      }
    }
    const displayImages = nodeImages.filter((image) =>
      image.status !== 'superseded' && image.status !== 'failed'
      && image.visionStatus !== 'failed'
      && (image.viewSetType !== 'character-turnaround'
        || !image.viewKey
        || latestViewImages.get(image.viewKey)?.id === image.id),
    )
    const viewItems = selectLatestAssetViewItems(displayImages
      .flatMap((image) => normalizeAssetViewItems([image]).map((item) => ({
        ...item,
        imageId: image.id,
      })))
    )
    const viewSetValidation = [...new Set(nodeImages.map((image) => image.viewSetType))]
      .filter((type) => type !== 'single')
      .map((type) => ({
        viewSetType: type,
        ...validateAssetViewSet({
          viewSetType: type,
          items: viewItems.filter((item) => item.viewSetType === type),
          requireConfirmed: true,
        }),
      }))
    return {
      ...normalizeNode(row),
      state: deriveAssetNodeState(nodeImages, row.node_type ?? row.nodeType),
      images: nodeImages,
      confirmedImage: displayImages.find((image) =>
        image.status === 'confirmed'
        && (image.viewSetType !== 'character-turnaround' || image.visionStatus === 'passed'),
      ) || null,
      viewItems,
      viewSetValidation,
    }
  })

  const laidOutNodes = viewNodes.map((node) => ({
    ...node,
    ...normalizeAssetNodeLayout(node),
  }))

  return {
    projectId: Number(projectId),
    nodes: laidOutNodes,
    groups: buildAssetCanvasGroupBounds(laidOutNodes),
    summary: summarizeAssetCanvas(laidOutNodes),
  }
}
