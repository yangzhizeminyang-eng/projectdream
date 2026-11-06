export function shouldBlockSubtitleFallback({
  burnSubtitle = false,
  subtitleText = '',
  renderFailed = false,
} = {}) {
  return Boolean(
    renderFailed &&
      burnSubtitle !== false &&
      String(subtitleText || '').trim(),
  )
}

export function buildFailedExportConfig(config = {}, { message = 'export failed', code = 'export-failed' } = {}) {
  const blockingIssue = {
    code: String(code || 'export-failed'),
    message: String(message || 'export failed'),
  }

  return {
    ...(config && typeof config === 'object' ? config : {}),
    error: blockingIssue.message,
    subtitleFile: null,
    subtitleStorageKey: null,
    subtitleBurnedIn: false,
    technicalQuality: {
      status: 'failed',
      automaticPassed: false,
      inspectedMedia: null,
      subtitleBurnedIn: false,
      subtitleBurnIn: {
        passed: false,
        reason: blockingIssue.code,
      },
      blockingIssues: [blockingIssue],
    },
  }
}

export function shouldPreserveSpeechTiming({
  sourceDurationSeconds = 0,
  availableDurationSeconds = 0,
} = {}) {
  const source = Number(sourceDurationSeconds)
  const available = Number(availableDurationSeconds)
  return Number.isFinite(source) && source > 0 && Number.isFinite(available) && available > source
}

export function resolveSpeechRenderPolicy({
  trackKey = 'dialogue',
  sourceDurationSeconds = 0,
  availableDurationSeconds = 0,
} = {}) {
  const source = Number(sourceDurationSeconds)
  const available = Number(availableDurationSeconds)
  const overflowSeconds =
    Number.isFinite(source) && Number.isFinite(available) && source > 0 && available > 0
      ? Number(Math.max(0, source - available).toFixed(3))
      : 0
  const speechTrack = ['dialogue', 'narration'].includes(String(trackKey || '').toLowerCase())

  if (speechTrack && overflowSeconds > 0.05) {
    return {
      passed: false,
      shouldCompress: false,
      reason: 'speech-duration-exceeds-shot',
      overflowSeconds,
    }
  }

  return {
    passed: true,
    shouldCompress: !speechTrack && overflowSeconds > 0.05,
    reason: speechTrack ? 'speech-fits-shot' : 'non-speech-track',
    overflowSeconds,
  }
}

export function resolveSpeechSyncOffsetSeconds({
  sourceType = '',
  configuredOffsetSeconds,
} = {}) {
  const configured = Number(configuredOffsetSeconds)
  if (Number.isFinite(configured)) {
    return Number(Math.max(-0.5, Math.min(0.8, configured)).toFixed(3))
  }

  // Lip-sync providers generate the mouth motion against the submitted
  // reference audio. Re-mixing that audio with a default delay breaks the
  // shared source clock, so new lip-sync exports stay source-locked unless a
  // reviewer supplies an explicit calibration value.
  return 0
}
