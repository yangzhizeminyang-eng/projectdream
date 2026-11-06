const REVIEW_DECISIONS = new Set(['approved', 'rework'])
const REQUIRED_APPROVAL_CHECKS = [
  'visualReviewed',
  'subtitleReviewed',
  'audioReviewed',
  'characterConsistencyReviewed',
]
const APPROVAL_CONFIRMATION_TOKEN = 'APPROVE_FINAL_QUALITY_REVIEW'
const AUDIO_REVIEW_DETAIL_KEYS = [
  'listeningConfirmed',
  'clarityReviewed',
  'loudnessReviewed',
  'clippingReviewed',
  'syncReviewed',
  'syncNotApplicable',
]

function normalizeEvidence(checklist = {}, key, legacyReviewedKey, legacyNoteKey) {
  const source = checklist[key] && typeof checklist[key] === 'object' ? checklist[key] : {}
  const reviewed = source.reviewed === true || checklist[legacyReviewedKey] === true
  const notApplicable =
    source.notApplicable === true || source.status === 'not-applicable'
  const note = String(source.note ?? checklist[legacyNoteKey] ?? '').trim()
  return {
    ...(notApplicable ? { notApplicable: true } : {}),
    reviewed,
    note,
  }
}

function normalizeAudioEvidence(checklist = {}) {
  const source =
    checklist.audioEvidence && typeof checklist.audioEvidence === 'object'
      ? checklist.audioEvidence
      : {}
  const base = normalizeEvidence(checklist, 'audioEvidence', 'audioReviewed', 'audioNote')
  const hasDetailedFields = AUDIO_REVIEW_DETAIL_KEYS.some((key) =>
    Object.prototype.hasOwnProperty.call(source, key),
  )
  if (!hasDetailedFields) return base

  return {
    ...base,
    listeningConfirmed: source.listeningConfirmed === true,
    clarityReviewed: source.clarityReviewed === true,
    loudnessReviewed: source.loudnessReviewed === true,
    clippingReviewed: source.clippingReviewed === true,
    syncReviewed: source.syncReviewed === true,
    syncNotApplicable: source.syncNotApplicable === true,
  }
}

export function hasCompleteAudioHumanEvidence(checklist = {}) {
  const evidence =
    checklist.audioEvidence && typeof checklist.audioEvidence === 'object'
      ? checklist.audioEvidence
      : {}
  return (
    evidence.reviewed === true &&
    evidence.listeningConfirmed === true &&
    evidence.clarityReviewed === true &&
    evidence.loudnessReviewed === true &&
    evidence.clippingReviewed === true &&
    (evidence.syncReviewed === true || evidence.syncNotApplicable === true)
  )
}

export function hasAudibleSignalEvidence(automaticReport = {}) {
  return String(automaticReport?.inspectedMedia?.audioSignal || '').trim() === 'measurable'
}

export function isAutomaticFinalQualityPassed({
  automaticPassed,
  automaticReport,
} = {}) {
  return automaticPassed === true && hasAudibleSignalEvidence(automaticReport)
}

export function normalizeFinalQualityReview(raw = {}) {
  const decision = String(raw.decision || '').trim()
  if (!REVIEW_DECISIONS.has(decision)) {
    throw new Error('人工结论只允许 approved 或 rework')
  }
  if (decision === 'approved' && raw.automaticPassed !== true) {
    throw new Error('自动技术门禁未通过，不能批准为可发布候选')
  }
  if (decision === 'approved' && !hasAudibleSignalEvidence(raw.automaticReport)) {
    throw new Error('音轨检测未确认存在有效声音，不能批准为可发布候选')
  }
  if (
    decision === 'approved' &&
    (raw.confirm !== true || String(raw.confirmationToken || '').trim() !== APPROVAL_CONFIRMATION_TOKEN)
  ) {
    throw new Error('批准为可发布候选前必须输入精确确认口令')
  }

  const visualEvidence = normalizeEvidence(
    raw.checklist,
    'visualEvidence',
    'visualReviewed',
    'visualNote',
  )
  const subtitleEvidence = normalizeEvidence(
    raw.checklist,
    'subtitleEvidence',
    'subtitleReviewed',
    'subtitleNote',
  )
  const audioEvidence = normalizeAudioEvidence(raw.checklist)
  const characterConsistencyEvidence = normalizeEvidence(
    raw.checklist,
    'characterConsistencyEvidence',
    'characterConsistencyReviewed',
    'characterConsistencyNote',
  )
  const checklist = {
    visualReviewed: visualEvidence.reviewed,
    subtitleReviewed: subtitleEvidence.reviewed,
    audioReviewed: audioEvidence.reviewed,
    characterConsistencyReviewed: characterConsistencyEvidence.reviewed,
    characterConsistencyNotApplicable: characterConsistencyEvidence.notApplicable === true,
    visualEvidence,
    subtitleEvidence,
    audioEvidence,
    characterConsistencyEvidence,
  }
  const approvalChecksSatisfied = REQUIRED_APPROVAL_CHECKS.every((key) => {
    if (checklist[key]) return true
    return (
      key === 'characterConsistencyReviewed' &&
      checklist.characterConsistencyNotApplicable === true
    )
  })
  if (decision === 'approved' && !approvalChecksSatisfied) {
    throw new Error('批准前必须完成画面、字幕、音频和人物一致性复核')
  }
  if (
    decision === 'approved' &&
    [visualEvidence, subtitleEvidence, audioEvidence, characterConsistencyEvidence].some(
      (item) => !item.note,
    )
  ) {
    throw new Error('批准前必须填写画面、字幕、音频和人物一致性终审证据')
  }
  if (decision === 'approved' && !hasCompleteAudioHumanEvidence(checklist)) {
    throw new Error('批准前必须完成实际听感、清晰度、响度、失真和对白同步复核')
  }

  return {
    decision,
    checklist,
    note: String(raw.note || '').trim() || null,
  }
}
