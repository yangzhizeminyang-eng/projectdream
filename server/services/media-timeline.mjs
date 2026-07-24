function positiveNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function buildMediaTimeline(clips = []) {
  const entries = []
  const byStoryboardId = new Map()
  const bySceneId = new Map()
  let cursor = 0

  for (const [index, clip] of clips.entries()) {
    if (clip?.enabled === false) continue

    const durationSeconds = Math.max(
      0.25,
      positiveNumber(clip?.durationSeconds, 4),
    )
    const entry = {
      index,
      storyboardId: Number(clip?.storyboardId) || null,
      sceneId: Number(clip?.sceneId) || null,
      startSeconds: cursor,
      endSeconds: cursor + durationSeconds,
      durationSeconds,
    }
    entries.push(entry)
    if (entry.storyboardId) byStoryboardId.set(entry.storyboardId, entry)
    if (entry.sceneId && !bySceneId.has(entry.sceneId)) {
      bySceneId.set(entry.sceneId, { ...entry, storyboardId: null })
    } else if (entry.sceneId) {
      const sceneEntry = bySceneId.get(entry.sceneId)
      sceneEntry.endSeconds = entry.endSeconds
      sceneEntry.durationSeconds = sceneEntry.endSeconds - sceneEntry.startSeconds
    }
    cursor = entry.endSeconds
  }

  return {
    entries,
    byStoryboardId,
    bySceneId,
    durationSeconds: cursor,
  }
}

export function resolveMediaStartSeconds(item, timeline) {
  const startOffsetSeconds = nonNegativeNumber(item?.startOffsetSeconds, 0)
  const storyboardId = Number(item?.storyboardId) || 0
  const sceneId = Number(item?.sceneId) || 0
  const entry =
    (storyboardId && timeline?.byStoryboardId?.get(storyboardId)) ||
    (sceneId && timeline?.bySceneId?.get(sceneId)) ||
    null

  return {
    startSeconds: (entry?.startSeconds || 0) + startOffsetSeconds,
    clipEndSeconds: entry?.endSeconds ?? timeline?.durationSeconds ?? 0,
    entry,
  }
}

export function hasStoryboardTimelineEntry(item, timeline) {
  const storyboardId = Number(item?.storyboardId) || 0
  return Boolean(storyboardId && timeline?.byStoryboardId?.has(storyboardId))
}

export function resolveRequiredSpeechDuration(item, endPaddingSeconds = 0.18) {
  const startOffsetSeconds = nonNegativeNumber(item?.startOffsetSeconds, 0)
  const audioDurationSeconds = positiveNumber(item?.durationSeconds, 0)
  const paddingSeconds = nonNegativeNumber(endPaddingSeconds, 0)
  return audioDurationSeconds ? startOffsetSeconds + audioDurationSeconds + paddingSeconds : 0
}

export function buildLegacySceneAudioOffsets(audioItems = [], timeline) {
  const nextBySceneAndTrack = new Map()
  const placements = new Map()

  for (const item of audioItems) {
    if (Number(item?.storyboardId) || Number(item?.startOffsetSeconds || 0) > 0) continue
    const sceneId = Number(item?.sceneId) || 0
    if (!sceneId || !timeline?.bySceneId?.has(sceneId)) continue

    const key = `${String(item?.trackType || 'audio')}:${sceneId}`
    const sceneEntry = timeline.bySceneId.get(sceneId)
    const cursor = nextBySceneAndTrack.get(key) || sceneEntry.startSeconds
    const duration = positiveNumber(item?.durationSeconds, 0)
    placements.set(item?.id, {
      startSeconds: cursor,
      clipEndSeconds: sceneEntry.endSeconds,
      entry: sceneEntry,
    })
    nextBySceneAndTrack.set(key, cursor + duration)
  }

  return placements
}

export function buildAtempoFilter(sourceDurationSeconds, targetDurationSeconds) {
  const source = positiveNumber(sourceDurationSeconds, 0)
  const target = positiveNumber(targetDurationSeconds, 0)
  if (!source || !target || source <= target * 1.05) return ''

  let factor = source / target
  const filters = []
  while (factor > 2) {
    filters.push('atempo=2')
    factor /= 2
  }
  if (factor > 1.05) filters.push(`atempo=${Number(factor.toFixed(4))}`)
  return filters.join(',')
}
