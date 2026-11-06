const ASSET_TEMPLATE_MARKERS = [
  /提示词模板技能：prompt-template-skill-/u,
  /参考模板来源：角色生成提示词模板/u,
  /角色资产板必须一次生成/u,
  /资产范围：只输出角色外貌/u,
]

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

export function sanitizeStoryboardPrompt(value = '', { characterNames = [] } = {}) {
  const source = String(value || '').trim()
  if (!source) return ''

  const markerIndexes = ASSET_TEMPLATE_MARKERS
    .map((marker) => marker.exec(source)?.index)
    .filter((index) => index !== undefined)
  const markerIndex = markerIndexes.length ? Math.min(...markerIndexes) : source.length
  let sanitized = source.slice(0, markerIndex)
  for (const rawName of characterNames) {
    const name = String(rawName || '').trim()
    if (!name) continue
    const escapedName = escapeRegExp(name)
    const profile = new RegExp(
      `@?${escapedName}（[^）]*(?:\\d+岁|男性|女性|青年|中年)[^）]*(?:脸|发|眉|眼|鼻|唇|耳|下颌|衬衫|外套|西装|服装|长发|短发)[^）]*）`,
      'gu',
    )
    sanitized = sanitized.replace(profile, '')
  }
  sanitized = sanitized
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/\s+([，。；：、])/gu, '$1')
    .trim()

  return sanitized
}
