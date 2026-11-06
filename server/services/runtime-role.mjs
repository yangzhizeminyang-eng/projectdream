const DEFAULT_QUEUE_POLL_INTERVAL_MS = 15_000

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function resolveAppRuntimeRole(env = process.env) {
  const role = String(env.APP_RUNTIME_ROLE || 'api').trim().toLowerCase()
  if (!['api', 'worker'].includes(role)) {
    throw new Error('APP_RUNTIME_ROLE must be api or worker')
  }

  return {
    role,
    runsHttpApi: role === 'api',
    runsBackgroundJobs: role === 'worker',
    runsMigrations: role === 'api',
    requiresCaptchaSecret: env.NODE_ENV === 'production' && role === 'api',
    queuePollIntervalMs: positiveInteger(
      env.BACKGROUND_QUEUE_POLL_INTERVAL_MS,
      DEFAULT_QUEUE_POLL_INTERVAL_MS,
    ),
  }
}
