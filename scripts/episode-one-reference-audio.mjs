function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

export function extractSpeakerText(dialogueText = '') {
  const source = normalizeText(dialogueText)
  if (!source || /^(?:（无对白）|\(无对白\)|无对白)$/i.test(source)) return null

  const match = source.match(/^(林夏|苏岚)(?:（[^）]*）)?\s*[：:]\s*(.*)$/)
  if (!match) return null

  return {
    speakerName: match[1],
    text: normalizeText(match[2]),
    trackType: match[1] === '苏岚' ? 'narration' : 'dialogue',
    characterId: match[1] === '苏岚' ? null : 18,
    voiceProfileKey:
      match[1] === '苏岚' ? 'female-adult-gentle' : 'female-young-warm',
  }
}

export function buildReferenceAudioSegments(plan = []) {
  return plan.flatMap((shot) => {
    const segment = extractSpeakerText(shot.dialogueText)
    return segment
      ? [{
          storyboardId: Number(shot.storyboardId) || null,
          storyboardKey: shot.storyboardKey || null,
          ...segment,
        }]
      : []
  })
}

export function cleanReferenceSubtitleText(dialogueText = '') {
  const segment = extractSpeakerText(dialogueText)
  return segment?.text || ''
}
