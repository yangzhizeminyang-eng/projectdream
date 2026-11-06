import {
  EPISODE_ONE_VALIDATION_SCENES,
  validateEpisodeOneValidationScenes,
} from '../../scripts/episode-one-validation-scenes.mjs'

const DEFAULT_SCENE_KEYS = EPISODE_ONE_VALIDATION_SCENES.map((scene) => scene.key)
const ALLOWED_SCENE_KEYS = new Set(DEFAULT_SCENE_KEYS)
const KEY_SHOT_PURPOSES = new Set(['hook', 'dialogue', 'reveal', 'choice', 'cliffhanger'])

function text(value) {
  return String(value ?? '').trim()
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function clampCandidateCount(value, fallback) {
  return Math.max(1, Math.min(3, positiveInteger(value, fallback)))
}

export function normalizePilotCandidateInput(input = {}) {
  const runId = positiveInteger(input.runId, 0)
  const projectId = positiveInteger(input.projectId, 0)
  if (!runId) throw new Error('受控候选生产缺少有效 runId')
  if (!projectId) throw new Error('受控候选生产缺少有效 projectId')

  const requestedSceneKeys = Array.isArray(input.sceneKeys)
    ? [...new Set(input.sceneKeys.map((key) => text(key)).filter(Boolean))]
    : DEFAULT_SCENE_KEYS
  if (!requestedSceneKeys.length) throw new Error('至少选择一个验证场景')

  const unknownSceneKeys = requestedSceneKeys.filter((key) => !ALLOWED_SCENE_KEYS.has(key))
  if (unknownSceneKeys.length) {
    throw new Error(`未知验证场景：${unknownSceneKeys.join(', ')}`)
  }

  return {
    runId,
    projectId,
    sceneKeys: requestedSceneKeys,
    apply: input.apply === true,
    confirmation: text(input.confirmation) || 'RUN_PILOT_CANDIDATES',
  }
}

export function normalizePilotCandidatePolicy(input = {}) {
  return {
    keyShotVideoCandidates: clampCandidateCount(input.keyShotVideoCandidates, 3),
    normalShotVideoCandidates: clampCandidateCount(input.normalShotVideoCandidates, 2),
    imageCandidates: clampCandidateCount(input.imageCandidates, 3),
    audioCandidates: clampCandidateCount(input.audioCandidates, 2),
  }
}

function resolveStoryboardId(scene, shot) {
  const directId = Number(shot?.storyboardId)
  if (Number.isSafeInteger(directId) && directId > 0) return directId
  const overrideId = Number(scene?.storyboardIdOverrides?.[shot?.key])
  return Number.isSafeInteger(overrideId) && overrideId > 0 ? overrideId : null
}

function isKeyShot(shot) {
  return KEY_SHOT_PURPOSES.has(text(shot?.shotPurpose).toLowerCase())
}

function resolveDialogueCharacterId(shot) {
  const dialogueText = text(shot?.dialogueText)
  if (dialogueText.includes('苏岚')) return 20
  if (dialogueText.includes('周衡')) return 19
  if (dialogueText.includes('林夏')) return 18
  return Number(shot?.characterId) || null
}

export function buildPilotCandidatePlan({
  sceneKeys = DEFAULT_SCENE_KEYS,
  scenes = EPISODE_ONE_VALIDATION_SCENES,
  candidatePolicy = {},
} = {}) {
  const selectedSceneKeys = [...new Set(sceneKeys.map((key) => text(key)).filter(Boolean))]
  const policy = normalizePilotCandidatePolicy(candidatePolicy)
  const validation = validateEpisodeOneValidationScenes(scenes)
  const sceneByKey = new Map(validation.scenes.map((scene) => [scene.key, scene]))
  const selectedScenes = selectedSceneKeys
    .map((key) => sceneByKey.get(key))
    .filter(Boolean)

  const shots = selectedScenes.flatMap((scene) =>
    scene.shots.map((shot) => {
      const keyShot = isKeyShot(shot)
      const dialogueText = text(shot.dialogueText)
      return {
        sceneKey: scene.key,
        sceneTitle: scene.title,
        shotKey: text(shot.key),
        shotNo: text(shot.shotNo),
        storyboardId: resolveStoryboardId(scene, shot),
        candidateTier: keyShot ? 'key' : 'normal',
        durationSeconds: Number(shot.durationSeconds) || 0,
        characterId: Number(shot.characterId) || null,
        characterName: text(shot.characterName) || null,
        audioCharacterId: dialogueText ? resolveDialogueCharacterId(shot) : null,
        shotPurpose: text(shot.shotPurpose),
        actionText: text(shot.actionText),
        actingBeat: text(shot.actingBeat),
        audioDirection: text(shot.audioDirection),
        dialogueText,
        visualPrompt: text(shot.visualPrompt),
        startVisualPrompt: text(shot.startVisualPrompt),
        endVisualPrompt: text(shot.endVisualPrompt),
        imageCandidateCount: policy.imageCandidates,
        videoCandidateCount: keyShot
          ? policy.keyShotVideoCandidates
          : policy.normalShotVideoCandidates,
        audioCandidateCount: dialogueText && dialogueText !== '（无对白）'
          ? policy.audioCandidates
          : 0,
        autoConfirm: false,
        requiresHumanSelection: true,
      }
    }),
  )

  return {
    mode: 'candidate-only',
    sceneKeys: selectedSceneKeys,
    candidatePolicy: policy,
    shots,
    selectionGate: 'human-or-agent-review-required',
  }
}

export function validatePilotCandidatePlan(plan = {}) {
  const errors = []
  const shots = Array.isArray(plan.shots) ? plan.shots : []
  const sceneKeys = Array.isArray(plan.sceneKeys) ? plan.sceneKeys : []

  if (plan.mode !== 'candidate-only') {
    errors.push('生产计划必须使用 candidate-only 模式')
  }
  if (plan.selectionGate !== 'human-or-agent-review-required') {
    errors.push('候选生产必须保留人工或 Agent 筛选闸门')
  }
  if (!shots.length) {
    errors.push('候选生产计划不能为空')
  }

  const storyboardIds = new Set()
  for (const shot of shots) {
    const storyboardId = Number(shot.storyboardId)
    if (!Number.isSafeInteger(storyboardId) || storyboardId <= 0) {
      errors.push(`镜头 ${shot.shotNo || shot.shotKey || 'unknown'} 缺少有效 storyboardId`)
    } else if (storyboardIds.has(storyboardId)) {
      errors.push(`storyboardId 重复：${storyboardId}`)
    } else {
      storyboardIds.add(storyboardId)
    }
    if (shot.autoConfirm !== false) {
      errors.push(`镜头 ${shot.shotNo || shot.shotKey || 'unknown'} 的 autoConfirm 必须为 false`)
    }
    if (shot.requiresHumanSelection !== true) {
      errors.push(`镜头 ${shot.shotNo || shot.shotKey || 'unknown'} 缺少人工筛选闸门`)
    }
    if (Number(shot.imageCandidateCount) < 1 || Number(shot.imageCandidateCount) > 3) {
      errors.push(`镜头 ${shot.shotNo || shot.shotKey || 'unknown'} 的静帧候选数量无效`)
    }
    if (Number(shot.videoCandidateCount) < 1 || Number(shot.videoCandidateCount) > 3) {
      errors.push(`镜头 ${shot.shotNo || shot.shotKey || 'unknown'} 的视频候选数量无效`)
    }
    if (text(shot.dialogueText).includes('苏岚（广播）：五')) {
      errors.push('候选生产计划不能包含苏岚广播“五”')
    }
  }

  if (sceneKeys.includes('scene-two-memory-hit')) {
    const dialogue = shots.map((shot) => text(shot.dialogueText)).join('\n')
    if (!dialogue.includes('苏岚（广播）：六。别怕，小夏。')) {
      errors.push('场景二候选计划必须包含完整的“六。别怕，小夏。”')
    }
    if (!dialogue.includes('苏岚（广播）：四。')) {
      errors.push('场景二候选计划必须包含独立的广播“四”')
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    summary: {
      sceneCount: sceneKeys.length,
      shotCount: shots.length,
      keyShotCount: shots.filter((shot) => shot.candidateTier === 'key').length,
      normalShotCount: shots.filter((shot) => shot.candidateTier === 'normal').length,
      dialogueShotCount: shots.filter((shot) => text(shot.dialogueText)).length,
    },
  }
}
