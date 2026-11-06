function positiveNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function buildMediaTimeline(clips = []) {
  // 把最终剪辑里的镜头列表转换成连续时间线。
  // 每个启用镜头都会得到 startSeconds/endSeconds，后面的对白和旁白据此定位。
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
  // 音频优先按 storyboardId 定位；没有分镜绑定时再按 sceneId 定位。
  // startOffsetSeconds 用于同一镜头内的细微前后调整。
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

export function buildBroadcastVisualCropFilter(preset = 'left-control-panel') {
  switch (String(preset || '').trim()) {
    case 'right-device':
      return 'crop=trunc(iw*0.34/2)*2:trunc(ih*0.92/2)*2:trunc(iw*0.66/2)*2:trunc(ih*0.04/2)*2'
    case 'left-control-panel':
    default:
      return 'crop=trunc(iw*0.32/2)*2:trunc(ih*0.96/2)*2:min(iw-ow\\,max(0\\,trunc(iw*0.47*(t-0.8)/2)*2)):trunc(ih*0.02/2)*2'
  }
}

export function buildSpeechVisualSegments({ clip = {}, audioTracks = {} } = {}) {
  const durationSeconds = Math.max(
    0.25,
    positiveNumber(clip?.durationSeconds, 4),
  )
  const storyboardId = Number(clip?.storyboardId) || 0
  const isVideoClip = String(clip?.sourceType || '').trim().toLowerCase() === 'video'
  const narrationItems = (Array.isArray(audioTracks?.narration) ? audioTracks.narration : [])
    .filter((item) => Number(item?.storyboardId) === storyboardId)
    .map((item) => {
      const startSeconds = Math.min(
        durationSeconds,
        nonNegativeNumber(item?.startOffsetSeconds, 0),
      )
      const endSeconds = Math.min(
        durationSeconds,
        startSeconds + Math.max(0.25, positiveNumber(item?.durationSeconds, 0.25)),
      )
      return {
        audioId: Number(item?.id) || null,
        startSeconds: Number(startSeconds.toFixed(3)),
        endSeconds: Number(endSeconds.toFixed(3)),
      }
    })
    .filter((item) => item.endSeconds > item.startSeconds)
    .sort(
      (left, right) =>
        left.startSeconds - right.startSeconds ||
        (left.audioId || 0) - (right.audioId || 0),
    )

  if (!narrationItems.length || !isVideoClip) {
    return [{
      startSeconds: 0,
      endSeconds: Number(durationSeconds.toFixed(3)),
      visualSource: isVideoClip ? 'original-video' : 'static-frame',
      speechTrack: null,
      audioId: null,
    }]
  }

  const broadcastVisual = clip?.broadcastVisual
  const visualType = String(broadcastVisual?.type || '').trim()
  if (!['source-video-crop', 'confirmed-image'].includes(visualType)) {
    const error = new Error(
      `分镜 ${storyboardId || 'unknown'} 存在广播旁白，但没有配置广播视觉源，已阻断人物口型画面回退。`,
    )
    error.code = 'narration-visual-source-missing'
    throw error
  }

  const narrationStartSeconds = narrationItems[0].startSeconds
  // 广播视觉只覆盖真实旁白的时间窗，结束后恢复原视频，避免
  // 后半段继续裁切人物画面而造成声音与画面语义错位。
  const narrationEndSeconds = narrationItems[0].endSeconds
  const segments = []
  if (narrationStartSeconds > 0) {
    segments.push({
      startSeconds: 0,
      endSeconds: narrationStartSeconds,
      visualSource: 'original-video',
      speechTrack: null,
      audioId: null,
    })
  }
  segments.push({
    startSeconds: narrationStartSeconds,
    endSeconds: narrationEndSeconds,
    visualSource: visualType === 'confirmed-image' ? 'static-frame' : 'broadcast-device',
    visualPreset: String(broadcastVisual?.preset || 'left-control-panel').trim(),
    speechTrack: 'narration',
    audioId: narrationItems[0].audioId,
  })
  if (narrationEndSeconds < durationSeconds) {
    segments.push({
      startSeconds: narrationEndSeconds,
      endSeconds: Number(durationSeconds.toFixed(3)),
      visualSource: 'original-video',
      speechTrack: null,
      audioId: null,
    })
  }
  return segments
}

export function buildLegacySceneAudioOffsets(audioItems = [], timeline) {
  // 兼容旧数据：以前只绑定到 scene，没有 storyboard。
  // 同一场景、同一音轨的旧音频会按持续时间顺序排开。
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
  // 当音频比目标镜头长很多时，生成 FFmpeg atempo 链进行适度变速。
  // atempo 单个滤镜通常不能处理任意倍速，所以这里会拆成多个 <= 2 倍的滤镜。
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
