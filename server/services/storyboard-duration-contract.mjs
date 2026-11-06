import {
  MAX_STORYBOARD_DURATION_SECONDS,
  normalizeStoryboardDurationSeconds,
} from './storyboard-duration.mjs'

const SILENT_DIALOGUE = /^(?:（无对白）|\(无对白\)|无对白|无台词|none|no dialogue)$/iu

function text(value) {
  return String(value ?? '').trim()
}

function readDuration(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function list(value) {
  return Array.isArray(value) ? value : []
}

function readVisibleTimelineRanges(prompt) {
  const match = String(prompt || '').match(
    /时间轴\s*[:：]([\s\S]*?)(?=(?:；|;|\r?\n)\s*(?:镜头|位置|动作|要求|对白|旁白|声音|视线)\s*[:：]|$)/u,
  )
  if (!match) return []
  return [...match[1].matchAll(/(\d+(?:\.\d+)?)\s*[-–至]\s*(\d+(?:\.\d+)?)\s*秒/gu)]
}

function normalizeBreakdown(value) {
  return list(value).map((item) => ({
    phase: text(item?.phase ?? item?.label ?? item?.name),
    seconds: readDuration(item?.seconds ?? item?.duration_seconds ?? item?.durationSeconds),
    observable: text(item?.observable ?? item?.event ?? item?.result),
  }))
}

function countSpokenCharacters(value) {
  return Array.from(text(value).replace(/\s+/gu, '').replace(/^.{1,30}[:：]\s*/u, ''))
    .filter((character) => !/[，。！？；、,.!?;:：]/u.test(character)).length
}

function visibleTimelineBlockers(prompt, durationSeconds, required) {
  if (!/时间轴\s*[:：]/u.test(prompt) && !required) return []
  const ranges = readVisibleTimelineRanges(prompt)
  if (!ranges.length || !Number.isFinite(Number(durationSeconds))) {
    return ['镜头内时间轴必须连续覆盖0到镜头时长']
  }
  let cursor = 0
  for (const range of ranges) {
    const start = Number(range[1])
    const end = Number(range[2])
    if (Math.abs(start - cursor) > 0.001 || end <= start) {
      return ['镜头内时间轴必须连续覆盖0到镜头时长']
    }
    cursor = end
  }
  return Math.abs(cursor - Number(durationSeconds)) <= 0.001
    ? []
    : ['镜头内时间轴必须连续覆盖0到镜头时长']
}

/**
 * A conservative speech floor used only for validation. It does not alter the
 * visible prompt or the requested duration.
 */
export function estimateMinimumDialogueSeconds(dialogueText) {
  const dialogue = text(dialogueText)
  if (!dialogue || SILENT_DIALOGUE.test(dialogue)) return 0
  const characters = countSpokenCharacters(dialogue)
  const punctuationPauses = (dialogue.match(/[，。！？；、,.!?;:：]/gu) || []).length
  return Math.max(1, Math.ceil(characters / 5 + punctuationPauses * 0.15))
}

export function normalizeStoryboardDurationEvidence(shot = {}) {
  return {
    durationSeconds: readDuration(shot.duration_seconds ?? shot.durationSeconds),
    durationBreakdown: normalizeBreakdown(
      shot.duration_breakdown ?? shot.durationBreakdown ?? shot.timing_plan ?? shot.timingPlan,
    ),
    durationBasis: text(shot.duration_basis ?? shot.durationBasis),
  }
}

export function validateStoryboardDurationContract(shot = {}, { requireVisibleTimeline = false } = {}) {
  const evidence = normalizeStoryboardDurationEvidence(shot)
  const blockers = []
  const durationSeconds = evidence.durationSeconds

  try {
    normalizeStoryboardDurationSeconds(durationSeconds)
  } catch {
    blockers.push(`镜头 ${text(shot.shot_no ?? shot.shotNo) || '?'} 的时长必须是 1-${MAX_STORYBOARD_DURATION_SECONDS} 秒的正整数`)
  }

  blockers.push(...visibleTimelineBlockers(
    text(shot.visual_prompt ?? shot.visualPrompt),
    durationSeconds,
    requireVisibleTimeline,
  ))

  if (!evidence.durationBreakdown.length) {
    blockers.push('缺少内部时长拆解 duration_breakdown')
  } else {
    const invalidPart = evidence.durationBreakdown.find((part) =>
      !part.phase || !part.observable || !part.seconds,
    )
    if (invalidPart) blockers.push('内部时长拆解的每一段都必须包含 phase、seconds 和 observable')
    const total = evidence.durationBreakdown.reduce((sum, part) => sum + (part.seconds || 0), 0)
    if (durationSeconds && total !== durationSeconds) {
      blockers.push(`时长拆解总和必须等于镜头时长（当前 ${total}s，镜头 ${durationSeconds}s）`)
    }
  }

  if (!evidence.durationBasis) blockers.push('缺少内部时长依据 duration_basis')

  const minimumDialogueSeconds = estimateMinimumDialogueSeconds(
    shot.dialogue_text ?? shot.dialogueText,
  )
  if (durationSeconds && minimumDialogueSeconds > durationSeconds) {
    blockers.push(`对白自然语速至少需要 ${minimumDialogueSeconds}s，不能压缩到 ${durationSeconds}s`)
  }

  return {
    passed: blockers.length === 0,
    blockers,
    ...evidence,
    minimumDialogueSeconds,
  }
}

export function validateStoryboardDurationContracts(shots = [], options = {}) {
  const results = list(shots).map((shot) => validateStoryboardDurationContract(shot, options))
  return {
    passed: results.length > 0 && results.every((result) => result.passed),
    results,
    blockers: results.flatMap((result) => result.blockers),
  }
}
