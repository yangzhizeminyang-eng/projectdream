function normalizedText(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : ''
}

function stripOuterQuotes(value) {
  let text = normalizedText(value)
  const quotePairs = new Map([
    ['“', '”'],
    ['‘', '’'],
    ['「', '」'],
    ['『', '』'],
    ['"', '"'],
    ["'", "'"],
  ])

  while (text.length >= 2 && quotePairs.get(text[0]) === text.at(-1)) {
    text = text.slice(1, -1).trim()
  }
  return text
}

function normalizeSpeakerName(value) {
  return normalizedText(value)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
}

function isSameSpeaker(left, right) {
  const speaker = normalizeSpeakerName(left)
  const character = normalizeSpeakerName(right)
  if (!speaker || !character) return false
  return speaker === character ||
    (speaker.length >= 2 && character.length >= 2 &&
      (speaker.includes(character) || character.includes(speaker)))
}

export function extractSpokenDialogue(dialogueText, characterName = '') {
  const source = normalizedText(dialogueText)
  if (!source) return ''

  const blocks = []
  const speakerPattern = /(^|\n|[。！？!?…”’」』]\s*)([^：:\n。！？!?；;]{1,40}?)(?:\s*[（(][^）)\n]{0,80}[）)])?\s*[：:]\s*/g
  let currentBlock = null
  let match
  let hasUnlabelledText = false

  while ((match = speakerPattern.exec(source)) !== null) {
    const labelStart = match.index + match[1].length
    const speaker = normalizeSpeakerName(match[2])
    if (!speaker) continue

    if (!currentBlock && source.slice(0, labelStart).trim()) {
      hasUnlabelledText = true
    }
    if (currentBlock) {
      currentBlock.text = source.slice(currentBlock.contentStart, labelStart)
    }
    currentBlock = { speaker, contentStart: speakerPattern.lastIndex, text: '' }
    blocks.push(currentBlock)
  }

  if (currentBlock) {
    currentBlock.text = source.slice(currentBlock.contentStart)
  }

  if (!blocks.length || hasUnlabelledText) return stripOuterQuotes(source)

  const requestedSpeaker = normalizeSpeakerName(characterName)
  const selectedBlocks = requestedSpeaker
    ? blocks.filter((block) => isSameSpeaker(block.speaker, requestedSpeaker))
    : blocks.length === 1
      ? blocks
      : []

  if (!selectedBlocks.length) return stripOuterQuotes(source)

  return selectedBlocks
    .map((block) => stripOuterQuotes(block.text))
    .filter(Boolean)
    .join('\n')
    .trim()
}
