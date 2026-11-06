function normalizedText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function isMalformedAudioTitle(value) {
  // 判断历史音频标题是否是旧版本生成的占位标题。
  const title = normalizedText(value)
  if (/\?{3,}/.test(title)) return true
  if ((title.match(/\?/g) || []).length < 2) return false

  const meaningfulText = title.replace(/[?\s\d·•._,:：;；/\\|()[\]{}\-–—]+/g, '')
  return meaningfulText.length === 0
}

export function buildAudioSourceTitle({
  trackType,
  sceneNo,
  sceneTitle,
  shotNo,
  characterName,
  projectName,
  customTitle,
}) {
  // 根据轨道、场景、镜头和角色关系生成稳定标题，方便音频列表分组和导出追踪。
  const title = normalizedText(customTitle)
  if (title) return title

  const sceneLabel = sceneNo ? `Scene ${String(sceneNo).padStart(2, '0')}` : ''
  const shotLabel = normalizedText(shotNo)
  const safeSceneTitle = isMalformedAudioTitle(sceneTitle) ? '' : normalizedText(sceneTitle)
  const safeCharacterName = isMalformedAudioTitle(characterName) ? '' : normalizedText(characterName)
  const safeProjectName = isMalformedAudioTitle(projectName) ? '' : normalizedText(projectName)

  if (trackType === 'dialogue') {
    return `对白轨${shotLabel ? ` · ${shotLabel}` : ''} - ${safeCharacterName || safeSceneTitle || sceneLabel || '未命名来源'}`
  }
  if (trackType === 'narration') {
    return `旁白轨${shotLabel ? ` · ${shotLabel}` : ''} - ${safeSceneTitle || sceneLabel || safeProjectName || '项目'}`
  }
  if (trackType === 'music') {
    return `音乐轨 - ${safeSceneTitle || sceneLabel || safeProjectName || '项目'}`
  }
  return `音效轨 - ${safeSceneTitle || sceneLabel || safeProjectName || '项目'}`
}

export function resolveAudioSourceTitle(row) {
  const title = normalizedText(row?.title)
  if (title && !isMalformedAudioTitle(title)) return title

  return buildAudioSourceTitle({
    trackType: row?.track_type || row?.trackType,
    sceneNo: row?.scene_no || row?.sceneNo,
    sceneTitle: row?.scene_title || row?.sceneTitle,
    shotNo: row?.shot_no || row?.storyboard_shot_no || row?.shotNo,
    characterName: row?.character_name || row?.characterName,
    projectName: row?.project_name || row?.projectName,
  })
}
