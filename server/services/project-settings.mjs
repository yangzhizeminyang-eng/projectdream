/**
 * @file 项目创作参数更新（纯函数）
 * @description
 * `PATCH /api/projects/:id` 的校验层。
 *
 * 为什么值得单独抽出来测：项目创建时一次性写入 category / narrative_vision /
 * visual_style / aspect_ratio，但此前**没有任何更新接口**——这四个字段只能在建项目
 * 时填一次，填错了只能重建项目。现在创作首页要能回头改它们，就必须有一条
 * 语义明确的更新路径：改什么写什么、空值清成 NULL、不认识的字段直接报错。
 */
import { canvasFromRatioLabel } from './media-probe.mjs'

/** 允许更新的字段 → 数据库列。顺序即 UPDATE 语句的列顺序。 */
const UPDATABLE_FIELDS = [
  ['name', 'name'],
  ['category', 'category'],
  ['narrativeVision', 'narrative_vision'],
  ['visualStyle', 'visual_style'],
  ['aspectRatio', 'aspect_ratio'],
]

/** 能通过 canvasFromRatioLabel 之外、但业务上确实在用的比例标签 */
const SPECIAL_RATIO_LABELS = new Set(['自适应', 'auto'])

/** 与建表语句一致的列长度上限，超长必须在应用层拦住，不能让 MySQL 静默截断 */
const COLUMN_LIMITS = new Map([
  ['name', 200],
  ['category', 80],
])

function text(value) {
  return String(value ?? '').trim()
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 校验一次项目更新请求。
 * @returns {{ error: string } | { updates: Array<{ column: string, value: string | null }> }}
 */
export function normalizeProjectUpdateInput(body) {
  if (!isPlainObject(body)) return { error: '请求内容无效' }

  const known = new Set(UPDATABLE_FIELDS.map(([field]) => field))
  const unknown = Object.keys(body).filter((key) => !known.has(key))
  if (unknown.length) {
    // 静默丢掉拼错的字段会让调用方以为已经保存成功，这里如实报出来
    return {
      error: `不支持的字段：${unknown.join('、')}；可更新字段为 ${[...known].join('、')}`,
    }
  }

  const updates = []

  for (const [field, column] of UPDATABLE_FIELDS) {
    if (!Object.hasOwn(body, field)) continue
    const raw = body[field]

    if (field === 'name') {
      const value = text(raw)
      const limit = COLUMN_LIMITS.get('name')
      if (!value) return { error: '项目名不能为空' }
      if (value.length > limit) return { error: `项目名不能超过 ${limit} 个字` }
      updates.push({ column, value })
      continue
    }

    if (field === 'category') {
      const value = text(raw)
      if (!value) {
        updates.push({ column, value: null })
        continue
      }
      const limit = COLUMN_LIMITS.get('category')
      if (value.length > limit) return { error: `作品类型不能超过 ${limit} 个字` }
      updates.push({ column, value })
      continue
    }

    if (field === 'aspectRatio') {
      const value = text(raw)
      if (!value) {
        // 清空声明，而不是写入空字符串——空字符串会被下游当成一个"声明过的比例"
        updates.push({ column, value: null })
        continue
      }
      const resolvable = canvasFromRatioLabel(value) !== null || SPECIAL_RATIO_LABELS.has(value)
      if (!resolvable) {
        return { error: `画面比例「${value}」无法解析，请使用 16:9、9:16、2.39:1 这类格式` }
      }
      updates.push({ column, value })
      continue
    }

    // narrativeVision / visualStyle 是长文本，空值一律清成 NULL
    updates.push({ column, value: text(raw) || null })
  }

  if (!updates.length) return { error: '没有可更新的字段' }

  return { updates }
}
