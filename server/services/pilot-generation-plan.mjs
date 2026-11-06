function text(value) {
  return String(value ?? '').trim()
}

function positiveInteger(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function buildPilotGenerationPlan({
  candidatePlan = {},
  imageModel = 'agnes-image-2.1-flash',
  videoModel = 'agnes-video-2.5-flash',
  audioModel = null,
} = {}) {
  const shots = Array.isArray(candidatePlan.shots) ? candidatePlan.shots : []
  return {
    mode: 'candidate-only',
    selectionGate: 'human-or-agent-review-required',
    stages: ['images', 'selection', 'videos', 'audio', 'selection'],
    jobs: shots.map((shot) => {
      const storyboardId = positiveInteger(shot.storyboardId)
      const dialogueText = text(shot.dialogueText)
      return {
        sceneKey: text(shot.sceneKey),
        shotKey: text(shot.shotKey),
        storyboardId,
        characterId: positiveInteger(shot.characterId),
        characterName: text(shot.characterName),
        audioCharacterId: positiveInteger(shot.audioCharacterId),
        dialogueText,
        durationSeconds: Number(shot.durationSeconds) || 0,
        image: {
          candidateCount: positiveInteger(shot.imageCandidateCount, 1),
          frameRole: 'primary',
          autoConfirm: false,
          modelName: imageModel,
        },
        video: {
          candidateCount: positiveInteger(shot.videoCandidateCount, 1),
          autoConfirm: false,
          modelName: videoModel,
        },
        audio: dialogueText && dialogueText !== '（无对白）'
          ? {
              candidateCount: positiveInteger(shot.audioCandidateCount, 1),
              autoConfirm: false,
              modelName: audioModel,
            }
          : null,
      }
    }),
  }
}

export function validatePilotGenerationPlan(plan = {}) {
  const errors = []
  const jobs = Array.isArray(plan.jobs) ? plan.jobs : []

  if (plan.mode !== 'candidate-only') errors.push('候选生成必须使用 candidate-only 模式')
  if (plan.selectionGate !== 'human-or-agent-review-required') {
    errors.push('候选生成必须保留人工或 Agent 筛选闸门')
  }
  if (!Array.isArray(plan.stages) || plan.stages.join(',') !== 'images,selection,videos,audio,selection') {
    errors.push('候选生成顺序必须先静帧筛选，再视频和音频')
  }
  if (!jobs.length) errors.push('候选生成任务不能为空')

  const seenStoryboardIds = new Set()
  for (const job of jobs) {
    const storyboardId = positiveInteger(job.storyboardId)
    if (!storyboardId || seenStoryboardIds.has(storyboardId)) {
      errors.push(`storyboardId 无效或重复：${job.storyboardId}`)
    }
    seenStoryboardIds.add(storyboardId)
    if (job.image?.autoConfirm !== false) errors.push(`镜头 ${storyboardId} 的静帧不能自动确认`)
    if (job.video?.autoConfirm !== false) errors.push(`镜头 ${storyboardId} 的视频不能自动确认`)
    if (job.audio && job.audio.autoConfirm !== false) {
      errors.push(`镜头 ${storyboardId} 的音频不能自动确认`)
    }
    if (Number(job.image?.candidateCount) < 1 || Number(job.image?.candidateCount) > 3) {
      errors.push(`镜头 ${storyboardId} 的静帧候选数量无效`)
    }
    if (Number(job.video?.candidateCount) < 1 || Number(job.video?.candidateCount) > 3) {
      errors.push(`镜头 ${storyboardId} 的视频候选数量无效`)
    }
  }

  return { valid: errors.length === 0, errors }
}
