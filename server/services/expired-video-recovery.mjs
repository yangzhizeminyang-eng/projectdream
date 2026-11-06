const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3
const ACTIVE_STATUSES = new Set(['queued', 'running'])
const RECOVERY_REVIEW_DECISIONS = new Set(['approved', 'rework'])
const RECOVERY_CHARACTER_REVIEW_DECISIONS = new Set(['matched', 'rework'])
const REQUIRED_RECOVERY_REVIEW_CHECKS = [
  'visualReviewed',
  'characterConsistencyReviewed',
  'motionContinuityReviewed',
]
const CHARACTER_FREE_RECOVERY_CONSTRAINT =
  '保持空景，禁止新增任何人、脸、人体轮廓、倒影、影子。Keep the scene empty. Do not add people, faces, human silhouettes, reflections, or shadows.'

function isLocalRecoverySourceHost(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname.startsWith('127.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  )
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeId(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return parsed
}

function recoveryExpectedCharacters(value) {
  const characters = Array.isArray(value) ? value : []
  const expected = new Map()
  for (const character of characters) {
    const characterId = Number(character?.characterId)
    if (!Number.isSafeInteger(characterId) || characterId <= 0 || expected.has(characterId)) continue
    expected.set(characterId, String(character?.name || '').trim() || `角色 ${characterId}`)
  }
  return expected
}

function normalizeRecoveryCharacterChecks(value, expectedCharacters) {
  if (!expectedCharacters.size) return []
  if (!Array.isArray(value)) {
    throw new Error('请逐个完成预期出镜角色的一致性复核')
  }

  const checks = new Map()
  for (const item of value) {
    const characterId = Number(item?.characterId)
    if (!Number.isSafeInteger(characterId) || !expectedCharacters.has(characterId)) {
      throw new Error('角色复核包含不属于当前静帧快照的角色')
    }
    if (checks.has(characterId)) {
      throw new Error(`角色“${expectedCharacters.get(characterId)}”不能重复填写复核结论`)
    }
    const decision = String(item?.decision || '').trim()
    if (!RECOVERY_CHARACTER_REVIEW_DECISIONS.has(decision)) {
      throw new Error(`请为角色“${expectedCharacters.get(characterId)}”选择通过或返工`)
    }
    const note = String(item?.note || '').trim() || null
    if (decision === 'rework' && !note) {
      throw new Error(`角色“${expectedCharacters.get(characterId)}”标记返工时必须填写原因`)
    }
    checks.set(characterId, { characterId, decision, note })
  }

  return [...expectedCharacters.keys()].map((characterId) => {
    const check = checks.get(characterId)
    if (!check) {
      throw new Error(`请完成角色“${expectedCharacters.get(characterId)}”的一致性复核`)
    }
    return check
  })
}

function isCharacterFreeSnapshot(snapshot) {
  if (!snapshot) return false
  if (typeof snapshot === 'object') return snapshot.characterFree === true

  try {
    return JSON.parse(snapshot).characterFree === true
  } catch {
    return false
  }
}

export function buildExpiredVideoRecoveryPrompt({
  startVisualPrompt,
  endVisualPrompt,
  characterSnapshot,
} = {}) {
  const start = String(startVisualPrompt || '').trim()
  const end = String(endVisualPrompt || '').trim()
  const characterFree = isCharacterFreeSnapshot(characterSnapshot)
  const parts = [
    start,
    '视频从起始帧构图和人物状态自然发展，不切镜头，不新增人物，角色外貌、服装和场景光线保持一致。',
  ]

  if (characterFree) {
    parts.push(CHARACTER_FREE_RECOVERY_CONSTRAINT)
  }
  if (end) parts.push(`动作终点参考：${end}`)

  return parts.join(' ')
}

export function strengthenExpiredVideoRecoveryPrompt({
  promptSnapshot,
  characterSnapshot,
} = {}) {
  const prompt = String(promptSnapshot || '').trim()
  if (!isCharacterFreeSnapshot(characterSnapshot) || prompt.includes(CHARACTER_FREE_RECOVERY_CONSTRAINT)) {
    return prompt
  }
  return [prompt, CHARACTER_FREE_RECOVERY_CONSTRAINT].filter(Boolean).join(' ')
}

export function buildExpiredVideoRecoveryJobKey({
  projectId,
  storyboardId,
  retryNumber,
} = {}) {
  return [
    'recover-video',
    `project-${normalizeId(projectId, 'projectId')}`,
    `storyboard-${normalizeId(storyboardId, 'storyboardId')}`,
    `retry-${normalizeId(retryNumber, 'retryNumber')}`,
  ].join('-')
}

export function classifyExpiredVideoRecoverySource({
  imageUrl,
  sourceMode = 'all',
} = {}) {
  let parsed
  try {
    parsed = new URL(String(imageUrl || '').trim())
  } catch {
    return {
      action: 'skip',
      reason: 'invalid-image-source-url',
      sourceKind: 'invalid',
    }
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return {
      action: 'skip',
      reason: 'unsupported-image-source-protocol',
      sourceKind: 'invalid',
    }
  }

  const sourceKind = isLocalRecoverySourceHost(parsed.hostname.toLowerCase())
    ? 'local'
    : 'public'
  if (sourceMode === 'public-only' && sourceKind === 'local') {
    return {
      action: 'skip',
      reason: 'local-source-requires-public-upload',
      sourceKind,
    }
  }

  return {
    action: 'queue',
    sourceKind,
  }
}

export function buildExpiredVideoRecoveryRequest({
  projectId,
  storyboardId,
  imageAssetId,
  imageStorageKey,
  imageUrl,
  versionNo,
  motionMode,
  durationSeconds,
  modelName,
  promptSnapshot,
} = {}) {
  const normalizedImageUrl = String(imageUrl || '').trim()
  if (!normalizedImageUrl) {
    throw new TypeError('imageUrl is required')
  }

  return {
    projectId: normalizeId(projectId, 'projectId'),
    storyboardId: normalizeId(storyboardId, 'storyboardId'),
    imageAssetId: normalizeId(imageAssetId, 'imageAssetId'),
    imageStorageKey: String(imageStorageKey || '').trim() || null,
    imageUrl: normalizedImageUrl,
    versionNo: normalizeId(versionNo, 'versionNo'),
    motionMode: String(motionMode || 'PAN').trim() || 'PAN',
    durationSeconds: Math.max(1, Math.min(12, Number(durationSeconds) || 5)),
    candidateCount: 1,
    modelName: String(modelName || '').trim(),
    promptSnapshot: String(promptSnapshot || '').trim(),
    providerTasks: [],
    autoConfirm: false,
  }
}

export function shouldRequireExpiredVideoRecoveryReview({
  jobKey,
  status,
  request,
} = {}) {
  return (
    String(jobKey || '').startsWith('recover-video-') &&
    String(status || '').trim().toLowerCase() === 'confirmed' &&
    request?.autoConfirm === true
  )
}

export function isExpiredVideoRecoveryJobKey(jobKey) {
  return String(jobKey || '').startsWith('recover-video-')
}

export function normalizeExpiredVideoRecoveryReview(raw = {}, { expectedCharacters } = {}) {
  const decision = String(raw.decision || '').trim()
  if (!RECOVERY_REVIEW_DECISIONS.has(decision)) {
    throw new Error('恢复视频复核结论只允许 approved 或 rework')
  }

  const checklist = Object.fromEntries(
    REQUIRED_RECOVERY_REVIEW_CHECKS.map((key) => [key, raw.checklist?.[key] === true]),
  )
  if (decision === 'approved' && REQUIRED_RECOVERY_REVIEW_CHECKS.some((key) => !checklist[key])) {
    throw new Error('批准前必须完成画面、人物一致性和动作连续性复核')
  }
  const characterChecks = normalizeRecoveryCharacterChecks(
    raw.characterChecks ?? raw.checklist?.characterChecks,
    recoveryExpectedCharacters(expectedCharacters),
  )
  if (decision === 'approved' && characterChecks.some((item) => item.decision !== 'matched')) {
    throw new Error('批准前每位预期出镜角色都必须复核为通过')
  }
  if (characterChecks.length) checklist.characterChecks = characterChecks

  return {
    decision,
    checklist,
    note: String(raw.note || '').trim() || null,
  }
}

export function decideExpiredVideoRecovery({
  projectId,
  storyboardId,
  existingJobs = [],
  hasFreshConfirmedVideo = false,
  maxRecoveryAttempts = DEFAULT_MAX_RECOVERY_ATTEMPTS,
} = {}) {
  if (hasFreshConfirmedVideo) {
    return { action: 'skip', reason: 'fresh-confirmed-video-exists' }
  }

  const jobs = Array.isArray(existingJobs) ? existingJobs : []
  const statuses = jobs.map((job) => String(job?.status || '').trim().toLowerCase())
  if (statuses.some((status) => ACTIVE_STATUSES.has(status))) {
    return { action: 'skip', reason: 'recovery-job-active' }
  }
  if (statuses.includes('success')) {
    return { action: 'skip', reason: 'recovery-job-succeeded' }
  }

  const attemptCount = statuses.filter(Boolean).length
  const retryLimit = positiveInteger(maxRecoveryAttempts, DEFAULT_MAX_RECOVERY_ATTEMPTS)
  if (attemptCount >= retryLimit) {
    return { action: 'skip', reason: 'recovery-attempt-limit' }
  }

  const retryNumber = attemptCount + 1
  return {
    action: 'queue',
    retryNumber,
    jobKey: buildExpiredVideoRecoveryJobKey({
      projectId,
      storyboardId,
      retryNumber,
    }),
  }
}
