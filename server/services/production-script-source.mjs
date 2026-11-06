function text(value, fallback = '') {
  const normalized = String(value ?? '').trim()
  return normalized || fallback
}

function positiveInteger(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function rowRichness(row) {
  return [
    row.actionText,
    row.dialogueText,
    row.visualPrompt,
    row.actingBeat,
    row.audioDirection,
    row.startVisualPrompt,
    row.endVisualPrompt,
  ].filter((value) => text(value)).length
}

export function buildProductionScriptSource(rows = [], {
  projectId = 0,
  episodeNo = 1,
} = {}) {
  const normalizedProjectId = positiveInteger(projectId, 0)
  const normalizedEpisodeNo = positiveInteger(episodeNo, 1)
  const firstSceneNo = (normalizedEpisodeNo - 1) * 2 + 1
  const lastSceneNo = firstSceneNo + 1
  const sceneMap = new Map()
  const shotMap = new Map()

  for (const row of Array.isArray(rows) ? rows : []) {
    const sceneNo = positiveInteger(row?.sceneNo, 0)
    const shotNo = Number.parseInt(String(row?.shotNo || ''), 10)
    if (sceneNo < firstSceneNo || sceneNo > lastSceneNo || !Number.isInteger(shotNo)) continue

    // 项目 12 的第一集保留 01～24 为当前详细脚本，排除历史占位镜头。
    // 其他项目必须完整读取自己的单集蓝图，不能套用项目 12 的旧镜号边界。
    if (normalizedProjectId === 12 && normalizedEpisodeNo === 1 && sceneNo === 1 && (shotNo < 1 || shotNo > 5)) continue
    if (normalizedProjectId === 12 && normalizedEpisodeNo === 1 && sceneNo === 2 && (shotNo < 6 || shotNo > 24)) continue

    if (!sceneMap.has(sceneNo)) {
      sceneMap.set(sceneNo, {
        sceneNo,
        title: text(row?.sceneTitle),
      })
    }

    const key = `${sceneNo}:${shotNo}`
    const candidate = {
      sourceStoryboardId: positiveInteger(row?.storyboardId, 0) || null,
      sceneNo,
      shotNo: text(row?.shotNo, String(shotNo).padStart(2, '0')),
      shotType: text(row?.shotType),
      durationSeconds: Math.max(1, Number(row?.durationSeconds) || 1),
      actionText: text(row?.actionText),
      dialogueText: text(row?.dialogueText),
      visualPrompt: text(row?.visualPrompt),
      shotPurpose: text(row?.shotPurpose),
      actingBeat: text(row?.actingBeat),
      audioDirection: text(row?.audioDirection),
      startVisualPrompt: text(row?.startVisualPrompt),
      endVisualPrompt: text(row?.endVisualPrompt),
    }
    const previous = shotMap.get(key)
    if (!previous || rowRichness(candidate) > rowRichness(previous)) {
      shotMap.set(key, candidate)
    }
  }

  const shots = [...shotMap.values()].sort((left, right) => {
    if (left.sceneNo !== right.sceneNo) return left.sceneNo - right.sceneNo
    return Number.parseInt(left.shotNo, 10) - Number.parseInt(right.shotNo, 10)
  })

  return {
    version: `database-script-project-${normalizedProjectId}-episode-${normalizedEpisodeNo}`,
    scenes: [...sceneMap.values()].sort((left, right) => left.sceneNo - right.sceneNo),
    shots,
  }
}
