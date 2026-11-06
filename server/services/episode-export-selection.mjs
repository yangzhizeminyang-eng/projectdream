function selectionError(message, { code, storyboardIds = [] } = {}) {
  const error = new Error(message)
  error.code = code || 'episode-export-selection-blocked'
  error.storyboardIds = storyboardIds
  return error
}

export function selectExportClips(clips = [], draft = {}, { episodeNo, storyboardIds } = {}) {
  const draftItems = Array.isArray(draft.videoClips) ? draft.videoClips : []
  if (Number(episodeNo) > 0) {
    const explicitManifestIds = [...new Set(
      (Array.isArray(storyboardIds) ? storyboardIds : [])
        .map((id) => Number(id))
        .filter((id) => id > 0),
    )]
    if (Array.isArray(storyboardIds) && explicitManifestIds.length === 0) {
      throw selectionError('当前集没有可导出的分镜清单', { code: 'episode-storyboard-manifest-empty' })
    }
    const allDraftIds = [...new Set(draftItems.map((item) => Number(item?.storyboardId)).filter((id) => id > 0))]
    const manifestIds = Array.isArray(storyboardIds)
      ? explicitManifestIds
      : [...new Set([
          ...clips.map((item) => Number(item?.storyboardId)),
          ...allDraftIds,
        ].filter((id) => id > 0))]
    if (!manifestIds.length) {
      throw selectionError('当前集没有可导出的分镜清单', { code: 'episode-storyboard-manifest-empty' })
    }
    const manifestSet = new Set(manifestIds)
    const videos = clips.filter((clip) =>
      manifestSet.has(Number(clip.storyboardId)) && clip.sourceType === 'video' && clip.videoUrl)
    const availableIds = new Set(videos.map((clip) => Number(clip.storyboardId)))
    const draftIds = allDraftIds.filter((id) => manifestSet.has(id))
    // With no saved edit draft the storyboard itself is the export manifest.
    // A static/image-only entry therefore must not silently disappear: it is
    // evidence that the confirmed video for that shot is missing and must
    // block the episode export. Once a draft exists, its ids are the explicit
    // user-selected manifest (partial drafts still fall back to the complete
    // confirmed-video list below).
    const expectedIds = manifestIds
    const missingIds = expectedIds.filter((id) => !availableIds.has(id))
    if (missingIds.length) {
      throw selectionError(`整集导出缺少已确认视频：${missingIds.join(', ')}`, {
        code: 'episode-missing-confirmed-videos',
        storyboardIds: missingIds,
      })
    }
    const draftIsComplete = draftIds.length > 0 && draftIds.length === availableIds.size && draftIds.length === manifestIds.length
    if (draftIsComplete) {
      const selections = new Map(
        draftItems.map((item, index) => [Number(item.storyboardId), {
          enabled: item.enabled !== false,
          order: Number(item.order) || index + 1,
        }]),
      )
      return videos
        .map((clip) => ({ ...clip, ...selections.get(Number(clip.storyboardId)) }))
        .filter((clip) => clip.enabled)
        .sort((left, right) => left.order - right.order || Number(left.storyboardId) - Number(right.storyboardId))
    }
    return videos.sort((left, right) =>
      Number(left.sceneNo || 0) - Number(right.sceneNo || 0)
      || Number(left.sortOrder || 0) - Number(right.sortOrder || 0)
      || Number(left.shotNo || 0) - Number(right.shotNo || 0)
      || Number(left.storyboardId || 0) - Number(right.storyboardId || 0),
    )
  }

  const selections = new Map(
    draftItems
      .filter((item) => Number(item?.storyboardId) > 0)
      .map((item, index) => [Number(item.storyboardId), {
        enabled: item.enabled !== false,
        order: Number(item.order) || index + 1,
      }]),
  )
  if (!selections.size) return []

  return clips
    .filter((clip) => selections.has(Number(clip.storyboardId)))
    .map((clip) => ({ ...clip, ...selections.get(Number(clip.storyboardId)) }))
    .filter((clip) => clip.enabled)
    .sort((left, right) => left.order - right.order || Number(left.storyboardId) - Number(right.storyboardId))
}
