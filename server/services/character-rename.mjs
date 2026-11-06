function normalizeSourceNames(sourceNames, newName) {
  return [...new Set((Array.isArray(sourceNames) ? sourceNames : [sourceNames])
    .map((name) => String(name || '').trim())
    .filter((name) => name && name !== newName))]
    .sort((left, right) => right.length - left.length)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function extractRelatedSpeakerNames(textValues, currentName, reservedNames = []) {
  // 角色改名时，从对白/剧本文本里找出可能的历史称呼和说话人标签。
  // 这些名称用于预览影响范围，但不会盲目替换结构化 JSON 的键名。
  const canonicalName = String(currentName || '').trim()
  if (canonicalName.length < 2) return []

  const reserved = new Set(reservedNames.map((name) => String(name || '').trim()))
  const aliases = new Set()
  const speakerPattern = /^[ \t]*([\p{L}\p{N}·_-]{2,30})[：:]/gmu
  for (const value of textValues) {
    const text = String(value || '')
    for (const match of text.matchAll(speakerPattern)) {
      const candidate = String(match[1] || '').trim()
      if (
        candidate !== canonicalName &&
        !reserved.has(candidate) &&
        (canonicalName.includes(candidate) || candidate.includes(canonicalName))
      ) {
        aliases.add(candidate)
      }
    }
  }
  return [...aliases]
}

export function transformCharacterNames(value, sourceNames, newName) {
  // 在可编辑文本中替换角色历史名称，使用一次性正则避免新名称再次被连锁替换。
  const normalizedNames = normalizeSourceNames(sourceNames, newName)
  if (!normalizedNames.length) {
    return { value, occurrences: 0, changed: false }
  }

  if (typeof value === 'string') {
    const pattern = new RegExp(normalizedNames.map(escapeRegExp).join('|'), 'g')
    const matches = value.match(pattern)
    const occurrences = matches?.length || 0
    return {
      value: occurrences ? value.replace(pattern, newName) : value,
      occurrences,
      changed: occurrences > 0,
    }
  }

  if (Array.isArray(value)) {
    let occurrences = 0
    let changed = false
    const nextValue = value.map((item) => {
      const transformed = transformCharacterNames(item, normalizedNames, newName)
      occurrences += transformed.occurrences
      changed ||= transformed.changed
      return transformed.value
    })
    return { value: changed ? nextValue : value, occurrences, changed }
  }

  if (value && typeof value === 'object') {
    let occurrences = 0
    let changed = false
    const nextValue = {}
    for (const [key, item] of Object.entries(value)) {
      const transformed = transformCharacterNames(item, normalizedNames, newName)
      occurrences += transformed.occurrences
      changed ||= transformed.changed
      nextValue[key] = transformed.value
    }
    return { value: changed ? nextValue : value, occurrences, changed }
  }

  return { value, occurrences: 0, changed: false }
}

export function transformCharacterName(value, oldName, newName) {
  return transformCharacterNames(value, [oldName], newName)
}

export function transformCharacterNamesJson(rawJson, sourceNames, newName) {
  // 结构化 JSON 改名只递归修改字符串值，不修改对象 key，避免破坏数据结构。
  if (!String(rawJson || '').trim()) {
    return { value: rawJson, occurrences: 0, changed: false, valid: true }
  }

  try {
    const parsed = JSON.parse(rawJson)
    const transformed = transformCharacterNames(parsed, sourceNames, newName)
    return {
      value: transformed.changed ? JSON.stringify(transformed.value) : rawJson,
      occurrences: transformed.occurrences,
      changed: transformed.changed,
      valid: true,
    }
  } catch {
    return { value: rawJson, occurrences: 0, changed: false, valid: false }
  }
}

export function transformCharacterNameJson(rawJson, oldName, newName) {
  return transformCharacterNamesJson(rawJson, [oldName], newName)
}
