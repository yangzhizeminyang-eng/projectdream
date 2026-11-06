const SECTIONS = [
  ['画面与资产', 'visualPrompt'],
  ['动作与表演', 'actionText'],
  ['对白与声音', 'dialogueText'],
  ['起始帧衔接', 'startVisualPrompt'],
  ['结束帧衔接', 'endVisualPrompt'],
]

export function buildUnifiedStoryboardPrompt(fields = {}) {
  return SECTIONS
    .map(([label, key]) => [label, String(fields[key] ?? '').trim()])
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}：${value}`)
    .join('\n\n')
}

export function parseUnifiedStoryboardPrompt(value = '') {
  const input = String(value ?? '').trim()
  const fields = Object.fromEntries(SECTIONS.map(([, key]) => [key, '']))
  const labels = SECTIONS.map(([label]) => label)
  const header = new RegExp(`(?:^|\\n\\n)(${labels.join('|')})：`, 'g')
  const matches = [...input.matchAll(header)]

  if (!matches.length) {
    fields.visualPrompt = input
    return fields
  }

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const label = match[1]
    const section = SECTIONS.find(([name]) => name === label)
    if (!section) continue
    const start = match.index + match[0].length
    const end = matches[index + 1]?.index ?? input.length
    fields[section[1]] = input.slice(start, end).trim()
  }
  return fields
}
