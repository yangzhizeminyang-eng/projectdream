export const CORE_STORYBOARD_IDS = [267, 180, 181, 182, 183, 184, 185, 186, 187]

function parseOnlyIds(value) {
  const rawIds = String(value || '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0)

  if (!rawIds.length) {
    throw new Error('--only must contain at least one positive storyboard id')
  }

  const uniqueIds = [...new Set(rawIds)]
  const invalidIds = uniqueIds.filter((id) => !CORE_STORYBOARD_IDS.includes(id))
  if (invalidIds.length) {
    throw new Error(
      `storyboard ${invalidIds.join(', ')} is not part of the agreed episode-one core`,
    )
  }

  return CORE_STORYBOARD_IDS.filter((id) => uniqueIds.includes(id))
}

export function parseEpisodeProductionOptions(args = []) {
  const onlyOption = args.find((item) => String(item).startsWith('--only='))
  const storyboardIds = onlyOption
    ? parseOnlyIds(String(onlyOption).slice('--only='.length))
    : CORE_STORYBOARD_IDS

  return {
    storyboardIds,
    dryRun: args.includes('--dry-run'),
    skipExport: args.includes('--skip-export'),
    exportOnly: args.includes('--export-only'),
  }
}

export function shouldReuseEpisodeAudio(existingAudio = null, expectedText = '') {
  const existingText = String(existingAudio?.sourceText || '').trim()
  const normalizedExpectedText = String(expectedText || '').trim()
  return Boolean(
    existingAudio?.id &&
      existingAudio.status === 'confirmed' &&
      existingText &&
      normalizedExpectedText &&
      existingText === normalizedExpectedText,
  )
}

export function firstAudioAsset(result = null) {
  if (Array.isArray(result)) return result[0] || null
  if (Array.isArray(result?.items)) return result.items[0] || null
  return null
}

export function resolveEpisodeAudioTrack(segment = {}) {
  if (Number(segment.characterId) === 20) {
    return {
      trackType: 'narration',
      characterId: null,
      voiceProfileKey: 'female-adult-gentle',
      voiceName: 'Serena',
      modelName: 'qwen3-tts-instruct-flash',
      languageType: 'Chinese',
      characterName: '苏岚',
    }
  }
  return {
    trackType: 'dialogue',
    characterId: Number(segment.characterId) || null,
    voiceProfileKey: null,
  }
}
