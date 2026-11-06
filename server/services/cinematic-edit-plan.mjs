const TRANSITION_TYPES = new Set(['cut', 'fade', 'dip', 'push'])
const MAX_TRANSITION_SECONDS = 2

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function positiveId(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

function text(value, fallback = '') {
  const result = String(value ?? '').trim()
  return result || fallback
}

function clamp(value, min, max, fallback = min) {
  const parsed = finiteNumber(value, fallback)
  return Math.max(min, Math.min(max, parsed))
}

function normalizeTransition(raw = {}, fallback = {}) {
  const requestedType = text(raw.type, fallback.type || 'cut').toLowerCase()
  const type = TRANSITION_TYPES.has(requestedType) ? requestedType : 'cut'
  const durationSeconds = type === 'cut'
    ? 0
    : Number(clamp(raw.durationSeconds, 0.04, MAX_TRANSITION_SECONDS, fallback.durationSeconds || 0.18).toFixed(3))
  return { type, durationSeconds }
}

function resolveSourceDuration(source = {}) {
  return Math.max(
    0.25,
    finiteNumber(source.sourceDurationSeconds, 0) ||
      finiteNumber(source.durationSeconds, 0) ||
      4,
  )
}

function resolveSemanticTransition(previous, current) {
  if (!previous) {
    return {
      type: 'cut',
      durationSeconds: 0,
      reason: '首个镜头不需要转场',
    }
  }

  const previousSceneId = positiveId(previous.sceneId ?? previous.sceneNo)
  const currentSceneId = positiveId(current.sceneId ?? current.sceneNo)
  const sameScene = previousSceneId === 0 || currentSceneId === 0 || previousSceneId === currentSceneId
  const explicitSceneChange = current.sceneChange === true || current.scene_change === true
  const actionContinuity = current.actionContinuity === true || current.action_continuity === true
  const gazeContinuity = current.gazeContinuity === true || current.gaze_continuity === true

  if (sameScene && (actionContinuity || gazeContinuity || current.sceneChange === false)) {
    return {
      type: 'cut',
      durationSeconds: 0,
      reason: '同场景动作或视线连续，优先硬切保持节奏',
    }
  }
  if (sameScene && !explicitSceneChange) {
    return {
      type: 'cut',
      durationSeconds: 0,
      reason: '同场景默认硬切，避免无意义的统一转场',
    }
  }
  return {
    type: 'fade',
    durationSeconds: 0.18,
    reason: '明确换场，使用短暂淡入淡出建立空间分隔',
  }
}

export function buildCinematicEditPlan({ sources = [], mode = 'automatic' } = {}) {
  const normalizedSources = (Array.isArray(sources) ? sources : [])
    .filter((source) => positiveId(source?.storyboardId))
    .map((source, index) => ({
      ...source,
      storyboardId: positiveId(source.storyboardId),
      sourceVideoAssetId: positiveId(source.videoAssetId ?? source.id) || null,
      order: positiveId(source.order) || index + 1,
    }))
    .sort((left, right) => left.order - right.order || left.storyboardId - right.storyboardId)

  const clips = normalizedSources.map((source, index) => {
    const previous = normalizedSources[index - 1]
    const semantic = resolveSemanticTransition(previous, source)
    const hasManualTransition = source.transitionManual === true || source.transition?.manual === true
    const requestedTransition = hasManualTransition && source.transition && typeof source.transition === 'object'
      ? normalizeTransition(source.transition, semantic)
      : semantic
    const sourceDurationSeconds = resolveSourceDuration(source)
    const trimStartSeconds = Number(clamp(source.trimStartSeconds, 0, Math.max(0, sourceDurationSeconds - 0.25), 0).toFixed(3))
    const trimEndSeconds = Number(clamp(
      source.trimEndSeconds == null ? sourceDurationSeconds : source.trimEndSeconds,
      trimStartSeconds + 0.25,
      sourceDurationSeconds,
      sourceDurationSeconds,
    ).toFixed(3))

    return {
      clipId: text(source.clipId, `storyboard-${source.storyboardId}`),
      storyboardId: source.storyboardId,
      sourceVideoAssetId: source.sourceVideoAssetId,
      order: index + 1,
      trimStartSeconds,
      trimEndSeconds,
      transition: requestedTransition,
      transitionManual: hasManualTransition,
      audioBridge: source.audioBridge || { type: 'none', durationSeconds: 0 },
      sceneChange: source.sceneChange === true || source.scene_change === true,
      actionContinuity: source.actionContinuity === true || source.action_continuity === true,
      gazeContinuity: source.gazeContinuity === true || source.gaze_continuity === true,
      reason: source.transition?.reason || semantic.reason,
      sourceCandidatePreserved: true,
    }
  })

  return {
    planVersion: 'cinematic-edit-plan-v1',
    mode: text(mode, 'automatic'),
    sourceCandidatePreserved: true,
    sourceVideoAssetIds: clips.map((clip) => clip.sourceVideoAssetId).filter(Boolean),
    clips,
    createdAt: new Date().toISOString(),
  }
}

export function validateCinematicEditPlan({ plan = {}, sources = [] } = {}) {
  const blockers = []
  const sourceByStoryboardId = new Map(
    (Array.isArray(sources) ? sources : [])
      .map((source) => [positiveId(source?.storyboardId), source])
      .filter(([storyboardId]) => storyboardId > 0),
  )
  const clips = Array.isArray(plan?.clips) ? plan.clips : []

  if (plan?.sourceCandidatePreserved !== true) {
    blockers.push({ code: 'source-preservation-missing', message: '剪辑计划没有声明保留原始分镜视频' })
  }
  if (!clips.length) {
    blockers.push({ code: 'empty-edit-plan', message: '剪辑计划没有可渲染镜头' })
  }

  const seenStoryboardIds = new Set()
  for (const clip of clips) {
    const storyboardId = positiveId(clip?.storyboardId)
    const source = sourceByStoryboardId.get(storyboardId)
    if (!storyboardId || !source) {
      blockers.push({ code: 'source-storyboard-missing', message: `剪辑计划引用了不存在的分镜 ${storyboardId || '未知'}` })
      continue
    }
    if (seenStoryboardIds.has(storyboardId)) {
      blockers.push({ code: 'duplicate-storyboard', message: `分镜 ${storyboardId} 在剪辑计划中重复` })
    }
    seenStoryboardIds.add(storyboardId)
    const expectedAssetId = positiveId(source.videoAssetId ?? source.id)
    const actualAssetId = positiveId(clip.sourceVideoAssetId)
    if (expectedAssetId && actualAssetId !== expectedAssetId) {
      blockers.push({
        code: 'source-video-mismatch',
        message: `分镜 ${storyboardId} 的原始视频引用不一致，拒绝替换已确认视频`,
      })
    }
    const rawTransition = clip?.transition && typeof clip.transition === 'object' ? clip.transition : {}
    const rawTransitionType = text(rawTransition.type, 'cut').toLowerCase()
    const rawTransitionDuration = rawTransition.durationSeconds === undefined || rawTransition.durationSeconds === null
      ? rawTransitionType === 'cut' ? 0 : Number.NaN
      : Number(rawTransition.durationSeconds)
    if (!TRANSITION_TYPES.has(rawTransitionType)) {
      blockers.push({ code: 'transition-type-invalid', message: `分镜 ${storyboardId} 使用了不支持的转场类型` })
    } else if (rawTransitionType === 'cut' && (!Number.isFinite(rawTransitionDuration) || rawTransitionDuration !== 0)) {
      blockers.push({ code: 'cut-transition-duration-invalid', message: `分镜 ${storyboardId} 的硬切转场时长必须为 0` })
    } else if (rawTransitionType !== 'cut' && (
      !Number.isFinite(rawTransitionDuration)
      || rawTransitionDuration < 0.04
      || rawTransitionDuration > MAX_TRANSITION_SECONDS
    )) {
      blockers.push({
        code: 'transition-duration-invalid',
        message: `分镜 ${storyboardId} 的转场时长必须在 0.04 到 ${MAX_TRANSITION_SECONDS} 秒之间`,
      })
    }
    const sourceDuration = resolveSourceDuration(source)
    const trimStart = finiteNumber(clip.trimStartSeconds, 0)
    const trimEnd = finiteNumber(clip.trimEndSeconds, sourceDuration)
    if (trimStart < 0 || trimEnd <= trimStart || trimEnd > sourceDuration + 0.001) {
      blockers.push({ code: 'trim-range-invalid', message: `分镜 ${storyboardId} 的裁切区间超出原始视频范围` })
    }
  }

  return {
    passed: blockers.length === 0,
    blockers,
    summary: blockers.length ? `剪辑计划未通过：${blockers.length} 个问题需要处理` : '剪辑计划校验通过',
  }
}

export function buildCinematicTransitionFilter({ previousLabel, currentLabel, transition, offsetSeconds }) {
  const normalized = normalizeTransition(transition)
  if (normalized.type === 'cut') return null
  const safeOffset = Math.max(0, finiteNumber(offsetSeconds, 0))
  return {
    type: normalized.type,
    durationSeconds: normalized.durationSeconds,
    expression: `${previousLabel}${currentLabel}xfade=transition=${normalized.type === 'dip' ? 'fadeblack' : normalized.type}:duration=${normalized.durationSeconds}:offset=${Math.max(0, safeOffset - normalized.durationSeconds).toFixed(3)}`,
  }
}

export function buildCinematicVideoFilter({ clips = [] } = {}) {
  const items = Array.isArray(clips) ? clips : []
  if (!items.length) return { filterComplex: '', outputLabel: '[vseq]', durationSeconds: 0 }

  const graph = []
  graph.push('[0:v]fps=30,settb=AVTB,setpts=PTS-STARTPTS[vseq0]')
  let currentLabel = '[vseq0]'
  let elapsedSeconds = Math.max(0.25, finiteNumber(items[0]?.durationSeconds, 0.25))
  for (let index = 1; index < items.length; index += 1) {
    const transition = normalizeTransition(items[index]?.transition)
    const nextLabel = `[vseq${index}]`
    const sourceLabel = `[vsrc${index}]`
    const nextDuration = Math.max(0.25, finiteNumber(items[index]?.durationSeconds, 0.25))
    graph.push(`[${index}:v]fps=30,settb=AVTB,setpts=PTS-STARTPTS${sourceLabel}`)
    if (transition.type === 'cut') {
      graph.push(`${currentLabel}${sourceLabel}concat=n=2:v=1:a=0${nextLabel}`)
      elapsedSeconds += nextDuration
    } else {
      const transitionName = transition.type === 'dip'
        ? 'fadeblack'
        : transition.type === 'push'
          ? 'slideleft'
          : 'fade'
      const offsetSeconds = Math.max(0, elapsedSeconds - transition.durationSeconds)
      graph.push(
        `${currentLabel}${sourceLabel}xfade=transition=${transitionName}:duration=${transition.durationSeconds}:offset=${offsetSeconds.toFixed(3)}${nextLabel}`,
      )
      elapsedSeconds += nextDuration - transition.durationSeconds
    }
    currentLabel = nextLabel
  }

  return {
    filterComplex: graph.join(';'),
    outputLabel: currentLabel,
    durationSeconds: Number(Math.max(0.25, elapsedSeconds).toFixed(3)),
  }
}

export function buildCinematicAudioFilter({ clips = [] } = {}) {
  const items = Array.isArray(clips) ? clips : []
  if (!items.length) return { filterComplex: '', outputLabel: '[aseq]', durationSeconds: 0 }

  const graph = []
  graph.push('[0:a]asetpts=PTS-STARTPTS[aseq0]')
  let currentLabel = '[aseq0]'
  let elapsedSeconds = Math.max(0.25, finiteNumber(items[0]?.durationSeconds, 0.25))
  for (let index = 1; index < items.length; index += 1) {
    const transition = normalizeTransition(items[index]?.transition)
    const nextLabel = `[aseq${index}]`
    const sourceLabel = `[asrc${index}]`
    const nextDuration = Math.max(0.25, finiteNumber(items[index]?.durationSeconds, 0.25))
    graph.push(`[${index}:a]asetpts=PTS-STARTPTS${sourceLabel}`)
    if (transition.type === 'cut') {
      graph.push(`${currentLabel}${sourceLabel}concat=n=2:v=0:a=1${nextLabel}`)
      elapsedSeconds += nextDuration
    } else {
      graph.push(`${currentLabel}${sourceLabel}acrossfade=d=${transition.durationSeconds}:c1=tri:c2=tri${nextLabel}`)
      elapsedSeconds += nextDuration - transition.durationSeconds
    }
    currentLabel = nextLabel
  }

  return {
    filterComplex: graph.join(';'),
    outputLabel: currentLabel,
    durationSeconds: Number(Math.max(0.25, elapsedSeconds).toFixed(3)),
  }
}
