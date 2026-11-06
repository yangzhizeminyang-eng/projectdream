export function resolveStoryboardStageResult({ episodeNo = 1, sceneCount = 0, shotCount = 0, storyboardIds = [] } = {}) {
  const persistedShotCount = Math.max(0, Number(shotCount) || 0)
  const persistedIds = Array.isArray(storyboardIds) ? storyboardIds.filter((id) => Number(id) > 0) : []
  if (persistedShotCount === 0 || persistedIds.length < persistedShotCount) {
    return {
      status: 'blocked',
      outputSnapshot: { episodeNo, sceneCount: Number(sceneCount) || 0, shotCount: 0, storyboardIds: [] },
      blockers: [{ code: 'storyboard-empty', message: `第 ${episodeNo} 集没有生成并保存任何分镜，不能进入创作页` }],
    }
  }
  return {
    status: 'waiting_approval',
    outputSnapshot: {
      episodeNo,
      sceneCount: Number(sceneCount) || 0,
      shotCount: persistedShotCount,
      storyboardIds: persistedIds,
    },
    blockers: [{ code: 'storyboard-approval-required', message: '分镜脚本已生成，请检查镜头提示词与资产引用后继续' }],
  }
}
