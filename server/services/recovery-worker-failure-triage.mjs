const NETWORK_TIMEOUT_PATTERN = /UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ECONNRESET|fetch failed/i

function isPrivateHostname(hostname) {
  const value = String(hostname || '').toLowerCase()
  return (
    value === 'localhost' ||
    value === '::1' ||
    value === '0.0.0.0' ||
    value.startsWith('127.') ||
    value.startsWith('10.') ||
    value.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(value)
  )
}

export function auditRecoverySourceInput({
  imageStorageKey,
  sourceProbe,
  signedUrl,
} = {}) {
  const keyPresent = Boolean(String(imageStorageKey || '').trim())
  let parsed = null
  try {
    parsed = new URL(String(signedUrl || '').trim())
  } catch {
    parsed = null
  }
  const protocol = parsed?.protocol || null
  const hostname = parsed?.hostname || null
  const signedUrlGenerated = Boolean(parsed)
  const publicInput =
    signedUrlGenerated &&
    ['http:', 'https:'].includes(protocol) &&
    !isPrivateHostname(hostname)
  return {
    keyPresent,
    signedUrlGenerated,
    protocol,
    hostname,
    hasQuery: Boolean(parsed?.search),
    providerInputReady: Boolean(
      keyPresent &&
      sourceProbe?.readable === true &&
      publicInput,
    ),
  }
}

function normalizeAttempts(value) {
  return Math.max(0, Number(value) || 0)
}

function normalizeMaxAttempts(value) {
  return Math.max(1, Number(value) || 1)
}

export function classifyRecoveryWorkerFailure({
  status,
  attemptCount,
  maxAttempts,
  lastErrorCode,
  errorText,
  imageStorageKey,
  sourceProbe,
} = {}) {
  const attempts = normalizeAttempts(attemptCount)
  const max = normalizeMaxAttempts(maxAttempts)
  const attemptsRemaining = Math.max(0, max - attempts)
  const sourceReady = Boolean(
    String(imageStorageKey || '').trim() &&
    sourceProbe?.readable === true &&
    Number(sourceProbe?.size) > 0 &&
    String(sourceProbe?.contentType || '').startsWith('image/'),
  )
  const detail = `${lastErrorCode || ''} ${errorText || ''}`.trim()

  if (!sourceReady) {
    return {
      category: 'source-image-blocked',
      retryable: false,
      nextAction: 'repair-or-replicate-source-image',
      sourceReady: false,
      attemptsRemaining,
    }
  }

  if (sourceProbe?.providerInputReady === false) {
    return {
      category: 'provider-input-blocked',
      retryable: false,
      nextAction: 'repair-signed-source-url',
      sourceReady: true,
      attemptsRemaining,
    }
  }

  if (attempts >= max) {
    return {
      category: 'retry-exhausted',
      retryable: false,
      nextAction: 'manual-review-before-new-job',
      sourceReady: true,
      attemptsRemaining: 0,
    }
  }

  if (NETWORK_TIMEOUT_PATTERN.test(detail)) {
    return {
      category: 'provider-network-timeout',
      retryable: true,
      nextAction: 'verify-provider-network-then-single-retry',
      sourceReady: true,
      attemptsRemaining,
    }
  }

  return {
    category: 'unknown-provider-failure',
    retryable: false,
    nextAction: 'manual-error-analysis',
    sourceReady: true,
    attemptsRemaining,
  }
}

export function buildRecoveryFailureTriageReport(items = []) {
  const rows = Array.isArray(items) ? items : []
  const triagedItems = rows.map((item) => ({
    ...item,
    triage: classifyRecoveryWorkerFailure(item),
  }))
  const categories = {}
  for (const item of triagedItems) {
    categories[item.triage.category] = (categories[item.triage.category] || 0) + 1
  }
  return {
    summary: {
      total: triagedItems.length,
      retryable: triagedItems.filter((item) => item.triage.retryable).length,
      blocked: triagedItems.filter((item) => !item.triage.retryable).length,
      categories,
    },
    recommendedJobIds: triagedItems
      .filter((item) => item.triage.retryable)
      .map((item) => Number(item.id))
      .filter((id) => Number.isSafeInteger(id) && id > 0)
      .sort((left, right) => left - right),
    items: triagedItems,
  }
}
