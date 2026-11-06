const STAGES = Object.freeze([
  'story-lock',
  'asset-lock',
  'frame-selection',
  'video-selection',
  'audio-binding',
  'lip-sync',
  'final-export',
])

function positiveInteger(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function text(value) {
  return String(value ?? '').trim()
}

function blocker(code, message, extra = {}) {
  return { code, message, ...extra }
}

function shotEvidence(shot = {}) {
  const requiredEvidence = [
    'character-reference',
    'scene-view-reference',
    'confirmed-frame',
    'confirmed-video',
  ]
  if (shot.dialogue?.required) requiredEvidence.push('measurable-dialogue-audio')
  if (shot.lipSync?.required) requiredEvidence.push('lip-sync-audio-binding')
  return requiredEvidence
}

export function buildFullChainAcceptancePlan({
  projectId = null,
  aspectRatio = '9:16',
  shots = [],
} = {}) {
  return {
    version: 'full-chain-acceptance-v1',
    projectId: positiveInteger(projectId),
    aspectRatio: text(aspectRatio) || '9:16',
    stages: [...STAGES],
    shots: (Array.isArray(shots) ? shots : []).map((shot) => ({
      ...shot,
      storyboardId: positiveInteger(shot.storyboardId),
      requiredEvidence: shotEvidence(shot),
    })),
    humanReviewRequired: true,
  }
}

function evaluateShot(shot, blockers) {
  const id = positiveInteger(shot.storyboardId)
  const label = `镜头 ${text(shot.shotNo) || id || 'unknown'}`
  const character = shot.characterReference
  if (shot.characterId && (!character?.confirmed || !character?.real)) {
    blockers.push(blocker(
      character?.confirmed ? 'character-reference-not-real' : 'character-reference-missing',
      `${label}缺少已确认的真实角色参考图。`,
      { storyboardId: id },
    ))
  }

  const scene = shot.sceneReference
  if (!scene?.confirmed || !scene?.viewKey) {
    blockers.push(blocker('scene-reference-missing', `${label}缺少已确认的场景视角引用。`, { storyboardId: id }))
  } else if (!scene.real) {
    blockers.push(blocker('scene-reference-not-real', `${label}的场景视角仍是 mock 或非真实资产。`, { storyboardId: id }))
  }

  if (!shot.image?.confirmed) {
    blockers.push(blocker('image-not-confirmed', `${label}没有已确认静帧。`, { storyboardId: id }))
  } else if (!shot.image.real) {
    blockers.push(blocker('image-not-real', `${label}静帧不是可用于生产的真实资产。`, { storyboardId: id }))
  } else if (shot.image.visionPassed !== true) {
    blockers.push(blocker('image-vision-not-passed', `${label}静帧尚未通过视觉质量检查。`, { storyboardId: id }))
  }

  if (!shot.video?.confirmed) {
    blockers.push(blocker('video-not-confirmed', `${label}没有已确认视频。`, { storyboardId: id }))
  } else if (!shot.video.real) {
    blockers.push(blocker('video-not-real', `${label}视频不是可用于生产的真实资产。`, { storyboardId: id }))
  } else if (shot.video.playable !== true) {
    blockers.push(blocker('video-not-playable', `${label}视频未通过可播放性检查。`, { storyboardId: id }))
  }

  if (shot.dialogue?.required) {
    if (!shot.dialogue.measurable || !positiveInteger(shot.dialogue.audioAssetId)) {
      blockers.push(blocker('dialogue-audio-not-measurable', `${label}对白音频没有可测声音或资产 ID。`, { storyboardId: id }))
    }
  }

  if (shot.lipSync?.required) {
    if (!shot.lipSync.confirmed) {
      blockers.push(blocker('lip-sync-not-confirmed', `${label}需要口型同步，但没有已确认口型视频。`, { storyboardId: id }))
    } else if (positiveInteger(shot.lipSync.audioAssetId) !== positiveInteger(shot.dialogue?.audioAssetId)) {
      blockers.push(blocker('lip-sync-audio-mismatch', `${label}口型视频绑定的对白音频与终剪对白轨不一致。`, { storyboardId: id }))
    }
  }
}

export function evaluateFullChainAcceptance({ plan = {}, evidence = {} } = {}) {
  const blockers = []
  if (evidence.storyLocked !== true) {
    blockers.push(blocker('story-not-locked', '故事圣经或生产剧本尚未锁定。'))
  }
  for (const shot of Array.isArray(plan.shots) ? plan.shots : []) evaluateShot(shot, blockers)
  if (evidence.export?.technicalPassed !== true) {
    blockers.push(blocker('final-export-not-verified', '终剪导出尚未通过技术媒体检查。'))
  }

  const passed = blockers.length === 0
  return {
    passed,
    status: passed ? 'technical-passed-awaiting-human-review' : 'blocked',
    blockers,
    humanReviewRequired: plan.humanReviewRequired !== false,
    summary: {
      shotCount: Array.isArray(plan.shots) ? plan.shots.length : 0,
      blockerCount: blockers.length,
      technicalPassed: passed,
      humanReviewed: evidence.humanReview?.completed === true,
    },
  }
}

export { STAGES }
