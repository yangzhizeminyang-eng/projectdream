const SILENT_DIALOGUE = /^(?:（无对白）|\(无对白\)|无对白|无台词|none|no dialogue)$/iu

function text(value) {
  return String(value ?? '').trim()
}

function number(value, fallback = null) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function readList(value) {
  return Array.isArray(value) ? value : []
}

function isSilentDialogue(value) {
  const normalized = text(value)
  return !normalized || SILENT_DIALOGUE.test(normalized)
}

function inferGazeTarget(actionText, actingBeat) {
  const source = `${text(actionText)} ${text(actingBeat)}`
  const match = source.match(/(?:看向|望向|看着|盯住|锁定|注视|转向)([^，。；;、。]+)/u)
  return text(match?.[1]) || '当前动作对象'
}

function inferGazePlan(input = {}) {
  const duration = Math.max(1, Math.ceil(number(input.duration_seconds ?? input.durationSeconds, 4) || 4))
  const target = inferGazeTarget(input.action_text ?? input.actionText, input.acting_beat ?? input.actingBeat)
  const endTarget = target === '当前动作对象' ? '本镜动作结果' : target
  return {
    version: 'gaze-control-v1',
    startTarget: '镜头起始时的当前注视目标',
    transitions: [{
      fromSecond: 0,
      toSecond: duration,
      target,
      observable: `视线保持在${target}，眼睛和头部动作不跳变`,
      holdSeconds: duration,
    }],
    endTarget,
    eyeLead: '若发生转移，眼睛先动，头部延迟半拍跟随；没有转移时保持目标稳定',
    promptText: `视线保持在${target}，动作结果出现后停住半拍`,
    inferred: true,
  }
}

export function normalizeGazePlan(input = {}) {
  const raw = input.gaze_plan ?? input.gazePlan
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return inferGazePlan(input)

  const transitions = readList(raw.transitions ?? raw.beats ?? raw.targets)
    .map((item) => ({
      fromSecond: Math.max(0, number(item?.from_second ?? item?.fromSecond ?? item?.at_seconds ?? item?.atSeconds, 0) || 0),
      toSecond: Math.max(0, number(item?.to_second ?? item?.toSecond, 0) || 0),
      target: text(item?.target ?? item?.ref ?? item?.reference),
      observable: text(item?.observable ?? item?.result),
      holdSeconds: Math.max(0, number(item?.hold_seconds ?? item?.holdSeconds, 0) || 0),
    }))
    .filter((item) => item.target)

  const fallback = inferGazePlan(input)
  const rawStartTarget = text(raw.start_target ?? raw.startTarget)
  const rawEndTarget = text(raw.end_target ?? raw.endTarget)
  const sourceTransitions = transitions.length ? transitions : fallback.transitions
  const duration = Math.max(1, Math.ceil(number(input.duration_seconds ?? input.durationSeconds, 4) || 4))
  const normalizedTransitions = []
  let cursor = 0
  for (const item of sourceTransitions.sort((left, right) => left.fromSecond - right.fromSecond)) {
    const fromSecond = Math.min(duration, Math.max(cursor, item.fromSecond))
    const toSecond = Math.min(duration, Math.max(fromSecond, item.toSecond))
    if (fromSecond > cursor) {
      normalizedTransitions.push({
        fromSecond: cursor,
        toSecond: fromSecond,
        target: normalizedTransitions.at(-1)?.target || rawStartTarget || fallback.startTarget,
        observable: '视线保持在当前目标，等待下一次视线转移',
        holdSeconds: fromSecond - cursor,
      })
    }
    if (toSecond > fromSecond) {
      normalizedTransitions.push({ ...item, fromSecond, toSecond })
      cursor = toSecond
    }
  }
  if (!normalizedTransitions.length) normalizedTransitions.push(...fallback.transitions)
  if (cursor < duration) {
    normalizedTransitions.push({
      fromSecond: cursor,
      toSecond: duration,
      target: normalizedTransitions.at(-1)?.target || rawEndTarget || rawStartTarget || fallback.endTarget,
      observable: '视线保持在最终目标直到镜头结束',
      holdSeconds: duration - cursor,
    })
  }
  const promptText = text(raw.prompt_text ?? raw.promptText) || normalizedTransitions.map((item) => {
    const range = item.toSecond > item.fromSecond ? `${item.fromSecond}-${item.toSecond}秒` : `约${item.fromSecond}秒`
    return `${range}视线转向${item.target}并停住`
  }).join('；')

  return {
    version: text(raw.version) || 'gaze-control-v1',
    startTarget: text(raw.start_target ?? raw.startTarget) || fallback.startTarget,
    transitions: normalizedTransitions,
    endTarget: rawEndTarget || normalizedTransitions.at(-1)?.target || fallback.endTarget,
    eyeLead: text(raw.eye_lead ?? raw.eyeLead) || fallback.eyeLead,
    promptText,
    inferred: false,
  }
}

function inferSoundPlan(input = {}) {
  const dialogue = text(input.dialogue_text ?? input.dialogueText)
  const direction = text(input.audio_direction ?? input.audioDirection)
  const action = text(input.action_text ?? input.actionText)
  const hasDialogue = !isSilentDialogue(dialogue)
  const bed = direction || (hasDialogue ? '对白间隙保持连续的空间底噪，不掉入数字静音' : '从0秒到镜头结束保持连续空间底噪')
  const cues = []
  if (action) cues.push({ atSecond: 0, sound: '与主要动作同步的现场拟音', syncAction: action })
  if (hasDialogue) cues.push({ atSecond: 0, sound: '对白清晰进入，环境底床压低但不断', syncAction: dialogue })
  return {
    version: 'sound-design-v1',
    bed,
    cues,
    silencePolicy: '只允许剧本明确要求的短暂停顿；无对白不等于无声',
    mixPriority: hasDialogue ? ['动作拟音', '对白', '空间底床'] : ['动作拟音', '空间底床'],
    promptText: bed,
    inferred: true,
  }
}

export function normalizeSoundPlan(input = {}) {
  const raw = input.sound_plan ?? input.soundPlan
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return inferSoundPlan(input)
  const fallback = inferSoundPlan(input)
  const cues = readList(raw.cues ?? raw.events).map((item) => ({
    atSecond: Math.max(0, number(item?.at_second ?? item?.atSecond ?? item?.at_seconds ?? item?.atSeconds, 0) || 0),
    sound: text(item?.sound ?? item?.label ?? item?.name),
    syncAction: text(item?.sync_action ?? item?.syncAction ?? item?.action),
  })).filter((item) => item.sound)
  const promptText = text(raw.prompt_text ?? raw.promptText) || [
    text(raw.bed ?? raw.ambient_bed ?? raw.ambientBed) || fallback.bed,
    cues.length ? `关键动作音与画面同步：${cues.map((item) => item.sound).join('、')}` : '',
  ].filter(Boolean).join('；')
  return {
    version: text(raw.version) || 'sound-design-v1',
    bed: text(raw.bed ?? raw.ambient_bed ?? raw.ambientBed) || fallback.bed,
    cues: cues.length ? cues : fallback.cues,
    silencePolicy: text(raw.silence_policy ?? raw.silencePolicy) || fallback.silencePolicy,
    mixPriority: readList(raw.mix_priority ?? raw.mixPriority).map(text).filter(Boolean),
    promptText,
    inferred: false,
  }
}

export function validateStoryboardDirectionContract(input = {}) {
  const gaze = normalizeGazePlan(input)
  const sound = normalizeSoundPlan(input)
  const duration = number(input.duration_seconds ?? input.durationSeconds)
  const blockers = []
  if (!gaze.transitions.length) blockers.push('缺少可执行视线转移或停留计划')
  if (duration && gaze.transitions.some((item) => item.toSecond > duration || item.fromSecond < 0)) {
    blockers.push('视线时间段超出镜头时长')
  }
  if (gaze.transitions.some((item) => item.toSecond <= item.fromSecond)) {
    blockers.push('视线时间段起止顺序无效')
  }
  if (duration && gaze.transitions.length && (
    gaze.transitions[0].fromSecond !== 0
    || gaze.transitions.some((item, index) => index > 0 && item.fromSecond !== gaze.transitions[index - 1].toSecond)
    || gaze.transitions.at(-1).toSecond !== duration
  )) {
    blockers.push('视线时间轴必须从0秒连续覆盖到镜头结束')
  }
  if (duration && sound.cues.some((item) => item.atSecond > duration || item.atSecond < 0)) {
    blockers.push('声音 cue 时间点超出镜头时长')
  }
  if (!gaze.endTarget) blockers.push('缺少镜头结束视线目标')
  if (!sound.bed) blockers.push('缺少连续环境底床')
  if (!sound.silencePolicy) blockers.push('缺少静音策略')
  return { passed: blockers.length === 0, blockers, gaze, sound }
}
