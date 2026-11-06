function text(value) {
  return String(value ?? '').trim()
}

function usableImage(value) {
  const url = text(value)
  return Boolean(url) && !url.startsWith('pending://')
}

function shotAssetReference(shot) {
  const source = shot?.assetReference ?? shot?.asset_reference_json ?? {}
  if (source && typeof source === 'object') return source
  try {
    const parsed = JSON.parse(String(source || '{}'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function filterScenesForEpisode(scenes = [], episodeNo = null) {
  const rows = Array.isArray(scenes) ? scenes : []
  if (!Number.isInteger(Number(episodeNo)) || Number(episodeNo) <= 0) return rows
  return rows.filter((scene) => Number(scene?.episodeNo ?? scene?.episode_no ?? 1) === Number(episodeNo))
}

export function buildClipRehearsalReport({ sceneId, shots = [] } = {}) {
  const rows = Array.isArray(shots) ? shots : []
  if (!rows.length) throw new Error('当前片段没有分镜，无法预演')
  const targetSceneId = Number(sceneId)
  if (!Number.isSafeInteger(targetSceneId) || targetSceneId <= 0) throw new Error('片段场景无效')
  if (rows.some((shot) => Number(shot?.sceneId ?? shot?.scene_id) !== targetSceneId)) {
    throw new Error('片段预演只能包含同一片段的分镜')
  }

  const rehearsalShots = rows.map((shot) => {
    const reference = shotAssetReference(shot)
    const blockers = []
    if (!text(shot?.visualPrompt ?? shot?.visual_prompt)) blockers.push('缺少镜头提示词')
    if (!Number(reference.sceneAssetId) || !Number(reference.scenePanoramaVersion)) blockers.push('缺少已确认场景全景基准')
    if (text(reference.sceneViewKey) && !Number(reference.sceneViewSetVersion)) blockers.push('场景角度版本缺失')
    if (!usableImage(shot?.imageUrl ?? shot?.image_url)) blockers.push('缺少起始关键帧')
    if (!usableImage(shot?.endImageUrl ?? shot?.end_image_url)) blockers.push('缺少结束关键帧')
    return {
      storyboardId: Number(shot?.storyboardId ?? shot?.id),
      shotNo: text(shot?.shotNo ?? shot?.shot_no),
      blockers,
      ready: blockers.length === 0,
      keyframes: {
        start: usableImage(shot?.imageUrl ?? shot?.image_url) ? 'ready' : 'missing',
        end: usableImage(shot?.endImageUrl ?? shot?.end_image_url) ? 'ready' : 'missing',
      },
      startUrl: text(shot?.imageUrl ?? shot?.image_url) || null,
      endUrl: text(shot?.endImageUrl ?? shot?.end_image_url) || null,
    }
  })

  const transitions = rows.slice(1).map((shot, index) => {
    const previous = rows[index]
    const sameScene = Number(previous?.sceneId ?? previous?.scene_id) === Number(shot?.sceneId ?? shot?.scene_id)
    if (!sameScene) {
      return {
        fromShotId: Number(previous?.storyboardId ?? previous?.id),
        toShotId: Number(shot?.storyboardId ?? shot?.id),
        status: 'scene-change',
        hasPreviousTail: usableImage(previous?.endImageUrl ?? previous?.end_image_url),
        hasNextStart: usableImage(shot?.imageUrl ?? shot?.image_url),
      }
    }
    const hasPreviousTail = usableImage(previous?.endImageUrl ?? previous?.end_image_url)
    const hasNextStart = usableImage(shot?.imageUrl ?? shot?.image_url)
    return {
      fromShotId: Number(previous?.storyboardId ?? previous?.id),
      toShotId: Number(shot?.storyboardId ?? shot?.id),
      status: hasPreviousTail && hasNextStart ? 'ready-for-review' : 'blocked',
      hasPreviousTail,
      hasNextStart,
    }
  })

  const ready = rehearsalShots.every((shot) => shot.ready)
    && transitions.every((transition) => transition.status !== 'blocked')
  return {
    ready,
    sceneId: targetSceneId,
    shotCount: rows.length,
    readyShotCount: rehearsalShots.filter((shot) => shot.ready).length,
    blockedShotCount: rehearsalShots.filter((shot) => !shot.ready).length,
    videoJobsCreated: 0,
    shots: rehearsalShots,
    transitions,
  }
}
