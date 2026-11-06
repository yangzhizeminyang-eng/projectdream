function text(value) {
  return String(value ?? '').trim()
}

function list(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : []
}

export function shouldUseStoryboardContinuity({ tools = [], prompt = '', assetReference = {} } = {}) {
  const names = [
    ...list(tools),
    ...list(assetReference.tools),
  ]
  const source = text(prompt)
  return names.includes('片段衔接')
    || names.includes('首尾帧参考')
    || /@片段衔接|@首尾帧参考|上一镜|前一镜|承接/u.test(source)
}

export function resolveContinuitySourceShotNo({ prompt = '', assetReference = {} } = {}) {
  const source = `${text(prompt)} ${text(assetReference.continuityFromShot)}`
  const match = source.match(/@片段衔接(?:\[([^\]]+)\]|\(([^)]+)\))?/u)
  return text(match?.[1] || match?.[2]).replace(/^镜头/u, '') || null
}

export function buildStoryboardFrameReference({
  continuityEnabled = false,
  previousShot = null,
  previousVideo = null,
  currentShot = null,
  currentEndFrame = null,
} = {}) {
  const previousEndFrameUrl = text(
    previousVideo?.endFrameUrl
      || previousVideo?.end_frame_url
      || previousShot?.endImageUrl
      || previousShot?.end_image_url,
  ) || null
  const previousEndFrameStorageKey = text(
    previousVideo?.endFrameStorageKey
      || previousVideo?.end_frame_storage_key,
  ) || null
  const currentEndFrameUrl = text(
    currentEndFrame?.imageUrl
      || currentEndFrame?.image_url
      || currentShot?.endImageUrl
      || currentShot?.end_image_url,
  ) || null
  const currentEndFrameStorageKey = text(
    currentEndFrame?.storageKey
      || currentEndFrame?.storage_key,
  ) || null

  return {
    enabled: Boolean(continuityEnabled && previousEndFrameUrl),
    sourceStoryboardId: continuityEnabled ? Number(previousShot?.id || previousShot?.storyboardId) || null : null,
    sourceShotNo: continuityEnabled ? text(previousShot?.shotNo || previousShot?.shot_no) || null : null,
    startFrameUrl: continuityEnabled && previousEndFrameUrl ? previousEndFrameUrl : null,
    startFrameStorageKey: continuityEnabled && previousEndFrameStorageKey ? previousEndFrameStorageKey : null,
    endFrameUrl: currentEndFrameUrl,
    endFrameStorageKey: currentEndFrameStorageKey,
    missingStartFrame: Boolean(continuityEnabled && !previousEndFrameUrl),
  }
}

export function buildStoryboardContinuityPrompt(frameReference = {}) {
  if (!frameReference?.enabled) {
    return frameReference?.missingStartFrame
      ? '已选择片段衔接，但上一镜没有可读取的确认尾帧；必须先补齐上一镜尾帧，禁止用随机首帧替代。'
      : ''
  }
  return [
    `@片段衔接[镜头${frameReference.sourceShotNo || frameReference.sourceStoryboardId || '上一镜'}]`,
    '本镜首帧必须直接使用上一镜确认尾帧，不得重新构图、换装、换脸或重排场景。',
    '首帧到本镜尾帧之间只执行当前镜头动作，保持人物、道具、灯光方向和空间布局连续。',
  ].join('\n')
}
