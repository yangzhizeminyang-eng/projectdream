import { buildDefaultSubtitleCues, normalizeSubtitleCues } from './subtitle-cues.mjs'

export const FINAL_EDIT_AUDIO_TRACKS = ['dialogue', 'narration', 'music', 'sfx']

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function selectFinalEditDraftForEpisode(rawDraft, episodeNo) {
  const draft = parseObject(rawDraft)
  const parsedEpisodeNo = positiveId(episodeNo)
  const { episodeDrafts: _episodeDrafts, ...legacyDraft } = draft
  if (!parsedEpisodeNo) return legacyDraft
  const episodeDrafts = parseObject(draft.episodeDrafts)
  const scopedDraft = episodeDrafts[String(parsedEpisodeNo)]
  if (scopedDraft && typeof scopedDraft === 'object' && !Array.isArray(scopedDraft)) return scopedDraft
  // Existing projects have one project-wide draft. Keep it as a read fallback
  // until the user saves an episode-specific version.
  return legacyDraft
}

export function saveFinalEditDraftForEpisode(rawDraft, episodeNo, nextDraft) {
  const parsedEpisodeNo = positiveId(episodeNo)
  const draft = parseObject(rawDraft)
  if (!parsedEpisodeNo) {
    const { episodeDrafts, ...legacyDraft } = draft
    return {
      ...legacyDraft,
      ...nextDraft,
      ...(Object.keys(parseObject(episodeDrafts)).length ? { episodeDrafts: parseObject(episodeDrafts) } : {}),
    }
  }
  const episodeDrafts = parseObject(draft.episodeDrafts)
  return {
    ...draft,
    episodeDrafts: {
      ...episodeDrafts,
      [String(parsedEpisodeNo)]: nextDraft,
    },
  }
}

function positiveId(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

function positiveNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function boundedNumber(value, min, max, fallback = min) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function safeText(value, fallback = '') {
  const text = String(value ?? '').trim()
  return text || fallback
}

function clampNumber(value, min, max, fallback = min) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function clampVolume(value, fallback = 100) {
  return Math.round(clampNumber(value, 0, 100, fallback))
}

function normalizeClipId(item = {}, storyboardId, index) {
  const raw = safeText(item.clipId)
  if (raw) return raw.slice(0, 96)
  return `storyboard-${storyboardId}`
}

function normalizeTransition(rawTransition = {}) {
  const transition = parseObject(rawTransition)
  const type = safeText(transition.type, 'cut').toLowerCase()
  const allowedTypes = new Set(['cut', 'fade', 'dip', 'push'])
  const normalizedType = allowedTypes.has(type) ? type : 'cut'
  const maxDuration = normalizedType === 'cut' ? 0 : 2
  return {
    type: normalizedType,
    durationSeconds: Number(clampNumber(transition.durationSeconds, 0, maxDuration, 0).toFixed(3)),
    ...(transition.manual === true ? { manual: true } : {}),
  }
}

function normalizeBeatMarkers(rawMarkers = [], maxDurationSeconds = 0) {
  const maxDuration = Math.max(0, Number(maxDurationSeconds) || 0)
  return (Array.isArray(rawMarkers) ? rawMarkers : [])
    .map((item, index) => {
      const label = safeText(item?.label)
      if (!label) return null
      return {
        markerId: safeText(item?.markerId, `beat-${index + 1}`).slice(0, 96),
        atSeconds: Number(clampNumber(item?.atSeconds, 0, maxDuration || 9999, 0).toFixed(3)),
        label: label.slice(0, 120),
      }
    })
    .filter(Boolean)
}

function normalizeEmotionCurve(rawPoints = [], maxDurationSeconds = 0) {
  const maxDuration = Math.max(0, Number(maxDurationSeconds) || 0)
  return (Array.isArray(rawPoints) ? rawPoints : [])
    .map((item, index) => {
      const label = safeText(item?.label)
      if (!label) return null
      return {
        pointId: safeText(item?.pointId, `emotion-${index + 1}`).slice(0, 96),
        atSeconds: Number(clampNumber(item?.atSeconds, 0, maxDuration || 9999, 0).toFixed(3)),
        intensity: Math.round(clampNumber(item?.intensity, 0, 100, 50)),
        label: label.slice(0, 120),
      }
    })
    .filter(Boolean)
}

function normalizeVersionHistory(rawHistory = []) {
  return (Array.isArray(rawHistory) ? rawHistory : [])
    .slice(0, 8)
    .map((item, index) => {
      const payload = parseObject(item?.payload)
      if (!Object.keys(payload).length) return null
      return {
        versionId: safeText(item?.versionId, `snapshot-${index + 1}`).slice(0, 96),
        label: safeText(item?.label, `版本 ${index + 1}`).slice(0, 80),
        createdAt: safeText(item?.createdAt, new Date(0).toISOString()),
        payload,
      }
    })
    .filter(Boolean)
}

export function buildDefaultFinalEditAudioMix(audioTracks = {}) {
  return Object.fromEntries(
    FINAL_EDIT_AUDIO_TRACKS.map((trackKey) => [
      trackKey,
      {
        enabled: Array.isArray(audioTracks?.[trackKey]) && audioTracks[trackKey].length > 0,
        volume: 100,
      },
    ]),
  )
}

function normalizeTrim(rawClip = {}, sourceDurationSeconds = 0) {
  const sourceDuration = Math.max(0.25, positiveNumber(sourceDurationSeconds, 4))
  const maxStart = Math.max(0, sourceDuration - 0.25)
  const trimStartSeconds = Number(
    clampNumber(rawClip.trimStartSeconds, 0, maxStart, 0).toFixed(3),
  )
  const requestedEnd =
    rawClip.trimEndSeconds == null || rawClip.trimEndSeconds === ''
      ? sourceDuration
      : Number(rawClip.trimEndSeconds)
  const trimEndSeconds = Number(
    clampNumber(
      requestedEnd,
      trimStartSeconds + 0.25,
      sourceDuration,
      sourceDuration,
    ).toFixed(3),
  )

  return {
    trimStartSeconds,
    trimEndSeconds,
  }
}

export function normalizeFinalEditVideoClips(rawVideoClips = [], contextVideoItems = []) {
  const clipByStoryboardId = new Map(
    (Array.isArray(contextVideoItems) ? contextVideoItems : [])
      .map((item) => [positiveId(item?.storyboardId), item])
      .filter(([storyboardId]) => storyboardId > 0),
  )
  const seenClipKeys = new Set()
  const result = []

  for (const [index, item] of (Array.isArray(rawVideoClips) ? rawVideoClips : []).entries()) {
    const storyboardId = positiveId(item?.storyboardId)
    const sourceClip = clipByStoryboardId.get(storyboardId)
    if (!storyboardId || !sourceClip) continue
    const clipId = normalizeClipId(item, storyboardId, index)
    const clipKey = item?.clipId ? clipId : `storyboard-${storyboardId}`
    if (seenClipKeys.has(clipKey)) continue
    seenClipKeys.add(clipKey)
    const sourceDurationSeconds =
      positiveNumber(sourceClip.sourceDurationSeconds, 0) ||
      positiveNumber(sourceClip.durationSeconds, 4)
    const trim = normalizeTrim(item, sourceDurationSeconds)
    const normalizedClip = {
      storyboardId,
      enabled: item?.enabled !== false,
      order: positiveId(item?.order) || index + 1,
      videoAssetId: positiveId(item?.videoAssetId) || null,
      ...trim,
    }
    if (item?.clipId) normalizedClip.clipId = clipId
    if (item?.transition) normalizedClip.transition = normalizeTransition(item.transition)
    result.push(normalizedClip)
  }

  return result
}

export function normalizeFinalEditAudioClips(rawAudioClips = [], audioTracks = {}) {
  const allowedAudioIds = new Set(
    FINAL_EDIT_AUDIO_TRACKS.flatMap((trackKey) =>
      Array.isArray(audioTracks?.[trackKey]) ? audioTracks[trackKey] : [],
    )
      .map((item) => positiveId(item?.id))
      .filter((audioId) => audioId > 0),
  )
  const seenAudioIds = new Set()
  const result = []

  for (const item of (Array.isArray(rawAudioClips) ? rawAudioClips : [])) {
    const audioId = positiveId(item?.audioId ?? item?.id)
    if (!audioId || !allowedAudioIds.has(audioId) || seenAudioIds.has(audioId)) continue
    seenAudioIds.add(audioId)
    result.push({
      audioId,
      enabled: item?.enabled !== false,
      startOffsetSeconds: Number(boundedNumber(item?.startOffsetSeconds, -5, 9999, 0).toFixed(3)),
      volume: clampVolume(item?.volume, 100),
    })
  }

  return result
}

const OVERLAY_POSITIONS = new Set([
  'center',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
])

/**
 * Picture-in-picture overlays are a separate track on purpose: the main track
 * stays a single ordered sequence, and an overlay only references an already
 * confirmed shot with its own start time, size and opacity. Nothing here
 * writes to source assets, and overlays never reorder the main sequence.
 */
export function normalizeFinalEditOverlayClips(
  rawOverlayClips = [],
  contextVideoItems = [],
  maxDurationSeconds = 0,
) {
  const clipByStoryboardId = new Map(
    (Array.isArray(contextVideoItems) ? contextVideoItems : [])
      .map((item) => [positiveId(item?.storyboardId), item])
      .filter(([storyboardId]) => storyboardId > 0),
  )
  const timelineLimit = positiveNumber(maxDurationSeconds, 0) || 9999
  const seenClipIds = new Set()
  const result = []

  for (const item of Array.isArray(rawOverlayClips) ? rawOverlayClips : []) {
    const storyboardId = positiveId(item?.storyboardId)
    const sourceClip = clipByStoryboardId.get(storyboardId)
    if (!storyboardId || !sourceClip) continue
    const clipId = safeText(item?.clipId, `overlay-${storyboardId}`).slice(0, 96)
    if (seenClipIds.has(clipId)) continue
    seenClipIds.add(clipId)

    const sourceDuration = Math.max(
      0.25,
      positiveNumber(sourceClip.sourceDurationSeconds, 0) ||
        positiveNumber(sourceClip.durationSeconds, 4),
    )
    const position = safeText(item?.position, 'bottom-right').toLowerCase()

    result.push({
      clipId,
      storyboardId,
      startSeconds: Number(clampNumber(item?.startSeconds, 0, timelineLimit, 0).toFixed(3)),
      durationSeconds: Number(
        clampNumber(item?.durationSeconds, 0.25, Math.min(30, sourceDuration), Math.min(3, sourceDuration)).toFixed(
          3,
        ),
      ),
      trimStartSeconds: Number(
        clampNumber(item?.trimStartSeconds, 0, Math.max(0, sourceDuration - 0.25), 0).toFixed(3),
      ),
      enabled: item?.enabled !== false,
      position: OVERLAY_POSITIONS.has(position) ? position : 'bottom-right',
      scale: Number(clampNumber(item?.scale, 0.1, 1, 0.36).toFixed(3)),
      opacity: Math.round(clampNumber(item?.opacity, 0, 100, 100)),
    })

    if (result.length >= 24) break
  }

  return result
}

export function normalizeFinalEditDraft(rawDraft, context = {}) {
  const draft = parseObject(rawDraft)
  const videoItems = Array.isArray(context.videoItems) ? context.videoItems : []
  const audioTracks = context.audioTracks || {}

  const defaultAudioMix = buildDefaultFinalEditAudioMix(audioTracks)
  const rawAudioMix = parseObject(draft.audioMix)
  const audioMix = Object.fromEntries(
    FINAL_EDIT_AUDIO_TRACKS.map((trackKey) => {
      const rawTrack = parseObject(rawAudioMix[trackKey])
      const fallback = defaultAudioMix[trackKey]
      return [
        trackKey,
        {
          enabled: rawTrack.enabled !== undefined ? rawTrack.enabled !== false : fallback.enabled,
          volume: clampVolume(rawTrack.volume, fallback.volume),
        },
      ]
    }),
  )

  const videoClips = normalizeFinalEditVideoClips(draft.videoClips, videoItems)
  const audioClips = normalizeFinalEditAudioClips(draft.audioClips, audioTracks)
  const enabledDurationSeconds = applyFinalEditDraftToVideoItems(videoItems, { videoClips })
    .filter((item) => item.enabled !== false)
    .reduce((sum, item) => sum + (Number(item.durationSeconds) || 0), 0)
  const subtitleCues = normalizeSubtitleCues(
    Array.isArray(draft.subtitleCues)
      ? draft.subtitleCues
      : buildDefaultSubtitleCues(videoItems),
    applyFinalEditDraftToVideoItems(videoItems, { videoClips }),
  )

  return {
    videoClips,
    overlayClips: normalizeFinalEditOverlayClips(
      draft.overlayClips,
      videoItems,
      enabledDurationSeconds,
    ),
    audioMix,
    audioClips,
    subtitleCues,
    beatMarkers: normalizeBeatMarkers(draft.beatMarkers, enabledDurationSeconds),
    emotionCurve: normalizeEmotionCurve(draft.emotionCurve, enabledDurationSeconds),
    versionHistory: normalizeVersionHistory(draft.versionHistory),
  }
}

export function applyFinalEditDraftToVideoItems(
  videoItems = [],
  draft = {},
  replacementCandidates = new Map(),
) {
  const sourceByStoryboardId = new Map(
    (Array.isArray(videoItems) ? videoItems : [])
      .map((item, index) => [positiveId(item?.storyboardId), { ...item, sourceIndex: index }])
      .filter(([storyboardId]) => storyboardId > 0),
  )
  const draftVideoClips = Array.isArray(draft?.videoClips) ? draft.videoClips : []
  const hasDraftVideoClips = draftVideoClips.length > 0
  const timelineSource = hasDraftVideoClips
    ? draftVideoClips
    : (Array.isArray(videoItems) ? videoItems : []).map((item, index) => ({
        ...item,
        order: positiveId(item?.order) || index + 1,
      }))

  return timelineSource
    .map((draftItem, index) => {
      const storyboardId = positiveId(draftItem?.storyboardId)
      const item = sourceByStoryboardId.get(storyboardId)
      if (!storyboardId || !item) return null
      const replacementId = positiveId(draftItem?.videoAssetId)
      const replacement = replacementId ? replacementCandidates.get(replacementId) : null
      const replacementMatchesStoryboard =
        replacement && positiveId(replacement.storyboardId) === storyboardId
      const source = replacementMatchesStoryboard ? replacement : item
      const sourceDurationSeconds =
        positiveNumber(source?.sourceDurationSeconds, 0) ||
        positiveNumber(source?.durationSeconds, 0) ||
        positiveNumber(item?.sourceDurationSeconds, 0) ||
        positiveNumber(item?.durationSeconds, 4)
      const trim = normalizeTrim(draftItem || {}, sourceDurationSeconds)
      const durationSeconds = Number(
        Math.max(0.25, trim.trimEndSeconds - trim.trimStartSeconds).toFixed(3),
      )
      const originalVideoAssetId = positiveId(item?.originalVideoAssetId) || positiveId(item?.id) || null
      const selectedVideoAssetId = positiveId(source?.id) || originalVideoAssetId

      return {
        ...item,
        ...(replacementMatchesStoryboard
          ? {
              id: selectedVideoAssetId,
              videoAssetId: selectedVideoAssetId,
              videoUrl: source.videoUrl || item.videoUrl || null,
              storageKey: source.storageKey || item.storageKey || null,
              thumbnailUrl: source.thumbnailUrl || item.thumbnailUrl || null,
              versionNo: source.versionNo || item.versionNo,
              sourceType: source.sourceType || item.sourceType || 'video',
              syncSourceType: source.syncSourceType || source.sourceType || item.syncSourceType,
              syncAudioAssetId: source.syncAudioAssetId || source.audioAssetId || item.syncAudioAssetId || null,
              audioAssetId: source.audioAssetId || item.audioAssetId || null,
            }
          : {
              videoAssetId: originalVideoAssetId,
        }),
        originalVideoAssetId,
        enabled: draftItem ? draftItem.enabled !== false : !hasDraftVideoClips && item?.enabled !== false,
        order: draftItem ? positiveId(draftItem.order) || index + 1 : positiveId(item?.order) || index + 1,
        clipId: normalizeClipId(draftItem || item, storyboardId, index),
        transition: normalizeTransition(draftItem?.transition),
        sourceDurationSeconds,
        durationSeconds,
        trimStartSeconds: trim.trimStartSeconds,
        trimEndSeconds: trim.trimEndSeconds,
        nonDestructiveEdit: {
          sourceCandidatePreserved: true,
          replacedFromVideoAssetId:
            replacementMatchesStoryboard && originalVideoAssetId !== selectedVideoAssetId
              ? originalVideoAssetId
          : null,
        },
      }
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.order !== right.order) return left.order - right.order
      if ((left.sceneNo || 0) !== (right.sceneNo || 0)) return (left.sceneNo || 0) - (right.sceneNo || 0)
      if ((left.sortOrder || 0) !== (right.sortOrder || 0)) return (left.sortOrder || 0) - (right.sortOrder || 0)
      return positiveId(left.storyboardId) - positiveId(right.storyboardId)
    })
    .map((item, index) => ({ ...item, order: index + 1 }))
}

export function applyFinalEditDraftToAudioTracks(audioTracks = {}, draft = {}) {
  const draftByAudioId = new Map(
    (Array.isArray(draft?.audioClips) ? draft.audioClips : [])
      .map((item) => [positiveId(item?.audioId ?? item?.id), item])
      .filter(([audioId]) => audioId > 0),
  )

  return Object.fromEntries(
    FINAL_EDIT_AUDIO_TRACKS.map((trackKey) => [
      trackKey,
      (Array.isArray(audioTracks?.[trackKey]) ? audioTracks[trackKey] : []).map((item) => {
        const patch = draftByAudioId.get(positiveId(item?.id))
        if (!patch) {
          return {
            ...item,
            enabled: item?.enabled !== false,
            volume: clampVolume(item?.volume, 100),
            nonDestructiveEdit: { audioAssetPreserved: true },
          }
        }
        return {
          ...item,
          enabled: patch.enabled !== false,
          startOffsetSeconds: Number(boundedNumber(patch.startOffsetSeconds, -5, 9999, 0).toFixed(3)),
          volume: clampVolume(patch.volume, clampVolume(item?.volume, 100)),
          nonDestructiveEdit: { audioAssetPreserved: true },
        }
      }),
    ]),
  )
}

/**
 * Keep audio from entering the playable timeline until a shot-based asset has
 * a matching visual clip. Global music and SFX remain usable without a
 * storyboard binding; speech without a matching shot is surfaced separately
 * so the editor can explain why it is waiting instead of playing it at 00:00.
 */
export function partitionFinalEditAudioTracks(audioTracks = {}, videoItems = []) {
  const storyboardIds = new Set(
    (Array.isArray(videoItems) ? videoItems : [])
      .map((item) => positiveId(item?.storyboardId))
      .filter((storyboardId) => storyboardId > 0),
  )
  const tracks = {}
  const unmatched = []

  for (const trackKey of FINAL_EDIT_AUDIO_TRACKS) {
    tracks[trackKey] = []
    for (const item of Array.isArray(audioTracks?.[trackKey]) ? audioTracks[trackKey] : []) {
      const storyboardId = positiveId(item?.storyboardId)
      const isShotBoundSpeech =
        (trackKey === 'dialogue' || trackKey === 'narration') && storyboardId > 0
      if (isShotBoundSpeech && !storyboardIds.has(storyboardId)) {
        unmatched.push({
          ...item,
          trackType: trackKey,
          storyboardId,
          reason: 'missing-matching-video-clip',
        })
        continue
      }
      tracks[trackKey].push(item)
    }
  }

  return { tracks, unmatched }
}

/**
 * Choose the single audio-side warning the export gate should show.
 *
 * Confirmed audio that is only waiting for its matching shot is not "missing
 * audio": the editor already explains that next step, and repeating it as a
 * request for more audio would send the creator down the wrong path.
 */
export function resolveFinalEditAudioWarning({
  availableAudioTrackCount = 0,
  enabledAudioTrackCount = 0,
  unmatchedAudioCount = 0,
} = {}) {
  const availableCount = Number(availableAudioTrackCount) || 0
  const enabledCount = Number(enabledAudioTrackCount) || 0
  const waitingCount = Number(unmatchedAudioCount) || 0

  if (availableCount === 0 && waitingCount === 0) {
    return {
      code: 'missing-audio',
      message: '当前还没有已确认音频，成片可先预览视频，但导出前建议先补齐音频主版本。',
    }
  }

  if (availableCount > 0 && enabledCount === 0) {
    return {
      code: 'all-audio-disabled',
      message: '当前所有音频轨都被关闭了，如需带音频导出，请至少开启一个轨道。',
    }
  }

  return null
}
