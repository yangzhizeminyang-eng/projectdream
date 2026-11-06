/**
 * @file 资产组计算
 * @description
 * 把资产节点整理成稳定的角色/场景/道具/素材组。
 * 组是画布和资产库共同使用的视图 DTO，不引入新的持久化表。
 */
import { resolveTemporalAssetGroupKey } from './asset-temporal-groups.mjs'

const TYPE_LABELS = {
  character: '角色',
  scene: '场景',
  prop: '道具',
  material: '素材',
}

const GROUP_FRAME_PADDING = 26
// Keep the grouping service in lockstep with the canvas layout service.
const GROUP_HEADER_HEIGHT = 88

function text(value) {
  return String(value ?? '').trim()
}

function safeId(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function normalizeType(value) {
  const type = text(value).toLowerCase()
  return Object.hasOwn(TYPE_LABELS, type) ? type : 'material'
}

/**
 * 历史解析逻辑曾写入通用的「角色 / 场景」分组键。
 * 这类键不能把所有角色揉成一组，因此优先按 refId 修复为稳定实体组。
 */
export function resolveAssetGroupKey(node = {}) {
  const type = normalizeType(node.nodeType ?? node.node_type)
  const refId = safeId(node.refId ?? node.ref_id)
  const explicit = text(node.groupKey ?? node.group_key)

  if (explicit === '角色' || explicit === '场景') {
    return refId ? `${type}:${refId}` : `${type}:${safeId(node.id) || text(node.label) || 'unassigned'}`
  }
  if (explicit) return explicit
  if (refId && (type === 'character' || type === 'scene')) return `${type}:${refId}`
  return `${type}:${safeId(node.id) || text(node.label) || 'unassigned'}`
}

function normalizeCoordinate(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeSide(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function groupBounds(nodes) {
  const minX = Math.min(...nodes.map((node) => normalizeCoordinate(node.x))) - GROUP_FRAME_PADDING
  const minY =
    Math.min(...nodes.map((node) => normalizeCoordinate(node.y))) -
    GROUP_FRAME_PADDING -
    GROUP_HEADER_HEIGHT
  const maxX = Math.max(
    ...nodes.map(
      (node) =>
        normalizeCoordinate(node.x) +
        normalizeSide(node.width, 220),
    ),
  ) + GROUP_FRAME_PADDING
  const maxY = Math.max(
    ...nodes.map(
      (node) =>
        normalizeCoordinate(node.y) +
        normalizeSide(node.height, 260),
    ),
  ) + GROUP_FRAME_PADDING

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

function stateCounts(nodes) {
  const counts = { draft: 0, ready: 0, confirmed: 0 }
  for (const node of nodes) {
    const state = text(node.state) || 'draft'
    counts[state] = (counts[state] || 0) + 1
  }
  return {
    draft: counts.draft,
    ready: counts.ready,
    confirmed: counts.confirmed,
  }
}

/**
 * @param {Array<Record<string, unknown>>} nodes
 * @returns {Array<{
 *   key: string,
 *   nodeType: string,
 *   typeLabel: string,
 *   label: string,
 *   nodeIds: number[],
 *   nodeCount: number,
 *   stateCounts: { draft: number, ready: number, confirmed: number },
 *   bounds: { x: number, y: number, width: number, height: number },
 * }>}
 */
export function buildAssetGroups(nodes = []) {
  const buckets = new Map()

  for (const node of Array.isArray(nodes) ? nodes : []) {
    const key = resolveAssetGroupKey(node)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(node)
  }

  return [...buckets.entries()].map(([key, list]) => {
    const first = list[0] || {}
    const nodeType = normalizeType(first.nodeType ?? first.node_type)
    const label = text(first.label) || `未命名${TYPE_LABELS[nodeType]}`
    const sorted = [...list].sort((left, right) => safeId(left.id) - safeId(right.id))

    return {
      key,
      nodeType,
      typeLabel: TYPE_LABELS[nodeType],
      label,
      nodeIds: sorted.map((node) => safeId(node.id)).filter(Boolean),
      nodeCount: sorted.length,
      stateCounts: stateCounts(sorted),
      bounds: groupBounds(sorted),
    }
  })
}
