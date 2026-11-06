const MAX_STORYBOARD_DURATION_SECONDS = 30

/** Missing or invalid durations are a contract error, never an invitation to guess. */
export function normalizeStoryboardDurationSeconds(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_STORYBOARD_DURATION_SECONDS) {
    throw new Error(`分镜时长必须是有效整数（1-${MAX_STORYBOARD_DURATION_SECONDS} 秒）`)
  }
  return parsed
}

export function isValidStoryboardDurationSeconds(value) {
  try {
    normalizeStoryboardDurationSeconds(value)
    return true
  } catch {
    return false
  }
}

export { MAX_STORYBOARD_DURATION_SECONDS }
