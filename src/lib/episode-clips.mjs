export function formatShotDuration(durationSeconds) {
  const duration = Number(durationSeconds)
  return Number.isFinite(duration) && duration > 0 ? `${duration}s` : '待设置'
}

export function formatAggregateDuration(durationSeconds) {
  const duration = Number(durationSeconds)
  return Number.isFinite(duration) && duration > 0 ? `${duration} 秒` : '待统计'
}

export function buildEpisodeClips(scenes = [], shots = []) {
  const shotsByScene = new Map()
  for (const shot of shots) {
    const sceneId = Number(shot.sceneId)
    if (!shotsByScene.has(sceneId)) shotsByScene.set(sceneId, [])
    shotsByScene.get(sceneId).push(shot)
  }

  return [...scenes]
    .sort((left, right) => Number(left.sortOrder || left.sceneNo || 0) - Number(right.sortOrder || right.sceneNo || 0))
    .map((scene, index) => {
      const sceneShots = (shotsByScene.get(Number(scene.id)) || []).sort((left, right) =>
        String(left.shotNo || '').localeCompare(String(right.shotNo || ''), undefined, { numeric: true }),
      )
      const durationSeconds = sceneShots.reduce((total, shot) => total + Number(shot.durationSeconds || 0), 0)
      return {
        id: Number(scene.id),
        sceneNo: Number(scene.sceneNo || index + 1),
        title: String(scene.title || scene.location || `片段 ${index + 1}`),
        location: String(scene.location || ''),
        timeOfDay: String(scene.timeOfDay || ''),
        mood: String(scene.mood || ''),
        status: String(scene.status || ''),
        shots: sceneShots,
        shotCount: sceneShots.length,
        durationSeconds,
      }
    })
}
