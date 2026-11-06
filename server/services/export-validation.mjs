function normalizeCount(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

export function buildMediaCompleteness({
  totalStoryboardCount,
  confirmedVideoCount,
  missingStoryboardSceneCount,
}) {
  // 导出前的最小完整性检查：
  // 场景必须有分镜，所有分镜必须有已确认视频，否则阻止导出。
  const totalStoryboards = normalizeCount(totalStoryboardCount)
  const confirmedVideos = Math.min(normalizeCount(confirmedVideoCount), totalStoryboards)
  const missingStoryboardScenes = normalizeCount(missingStoryboardSceneCount)
  const missingVideos = Math.max(totalStoryboards - confirmedVideos, 0)
  const blockingIssues = []

  if (missingStoryboardScenes > 0) {
    blockingIssues.push({
      code: 'missing-storyboards',
      message: `还有 ${missingStoryboardScenes} 个场景尚未生成分镜，请先完成场景拆镜。`,
    })
  } else if (totalStoryboards === 0) {
    blockingIssues.push({
      code: 'missing-storyboards',
      message: '当前项目还没有分镜，请先完成场景拆镜。',
    })
  } else if (missingVideos > 0) {
    blockingIssues.push({
      code: 'missing-confirmed-videos',
      message: `还有 ${missingVideos} 个分镜未确认最终视频，请全部完成后再导出。`,
    })
  }

  return {
    isComplete: blockingIssues.length === 0,
    totalStoryboardCount: totalStoryboards,
    confirmedVideoCount: confirmedVideos,
    missingVideoCount: missingVideos,
    missingStoryboardSceneCount: missingStoryboardScenes,
    blockingIssues,
  }
}
