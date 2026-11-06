import { DEAD_BOSS_SHOTS } from './dead-boss-episode-one-plan.mjs'

const DEAD_BOSS_SCENE_KEYS = ['dead-boss-scene-1', 'dead-boss-scene-2']
const KEY_SHOT_PURPOSES = new Set([
  'hook',
  'mission',
  'evidence',
  'truth-reveal',
  'pressure',
  'interruption',
  'cliffhanger',
])
const SPEAKER_KEYS = {
  唐宁: 'tang-ning',
  赵衡: 'zhao-heng',
  赵启明: 'zhao-qiming',
}

function text(value) {
  return String(value ?? '').trim()
}

function positiveInteger(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function clampCandidateCount(value, fallback) {
  return Math.max(1, Math.min(3, positiveInteger(value, fallback)))
}

function normalizeSpeakerKey(value) {
  const name = text(value).replace(/（[^）]*）|\([^)]*\)/g, '').trim()
  return SPEAKER_KEYS[name] || null
}

function cleanSpokenText(value) {
  return text(value)
    .replace(/^[^：:]+(?:（[^）]*）|\([^)]*\))?\s*[：:]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseDeadBossDialogueSegments({ shot = {}, characterIds = {} } = {}) {
  const lines = text(shot.dialogueText)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  return lines.flatMap((line, lineIndex) => {
    const match = line.match(/^(.+?)\s*[：:]\s*(.+)$/)
    if (!match) return []
    const speakerKey = normalizeSpeakerKey(match[1])
    const spokenText = cleanSpokenText(line)
    if (!speakerKey || !spokenText) return []

    return [{
      key: `${shot.key}-audio-${lineIndex + 1}`,
      shotKey: text(shot.key),
      shotNo: text(shot.shotNo),
      speakerKey,
      characterId: positiveInteger(characterIds[speakerKey]),
      text: spokenText,
      trackType: 'dialogue',
      candidateCount: 2,
      autoConfirm: false,
      requiresHumanSelection: true,
    }]
  })
}

function normalizePolicy(input = {}) {
  return {
    keyShotVideoCandidates: clampCandidateCount(input.keyShotVideoCandidates, 3),
    normalShotVideoCandidates: clampCandidateCount(input.normalShotVideoCandidates, 2),
    imageCandidates: clampCandidateCount(input.imageCandidates, 3),
    audioCandidates: clampCandidateCount(input.audioCandidates, 2),
  }
}

function resolveShotCharacterId(shot, characterIds) {
  return positiveInteger(characterIds[shot.characterKey])
}

export function buildDeadBossPilotCandidatePlan({
  shots = DEAD_BOSS_SHOTS,
  storyboardIds = {},
  characterIds = {},
  candidatePolicy = {},
  productionBatch = 'dead-boss-episode-one-v1',
} = {}) {
  const policy = normalizePolicy(candidatePolicy)
  const normalizedShots = Array.isArray(shots) ? shots : []
  const planShots = normalizedShots.map((shot) => {
    const shotPurpose = text(shot.shotPurpose).toLowerCase()
    const candidateTier = KEY_SHOT_PURPOSES.has(shotPurpose) ? 'key' : 'normal'

    return {
      sceneKey: `dead-boss-scene-${shot.sceneNo}`,
      sceneNo: Number(shot.sceneNo) || null,
      shotKey: text(shot.key),
      shotNo: text(shot.shotNo),
      storyboardId: positiveInteger(storyboardIds[shot.key]),
      candidateTier,
      characterId: resolveShotCharacterId(shot, characterIds),
      characterName: text(shot.characterName),
      durationSeconds: Number(shot.durationSeconds) || 0,
      shotPurpose: text(shot.shotPurpose),
      actionText: text(shot.actionText),
      actingBeat: text(shot.actingBeat),
      audioDirection: text(shot.audioDirection),
      dialogueText: text(shot.dialogueText),
      visualPrompt: text(shot.visualPrompt),
      startVisualPrompt: text(shot.startVisualPrompt),
      endVisualPrompt: text(shot.endVisualPrompt),
      imageCandidateCount: policy.imageCandidates,
      videoCandidateCount:
        candidateTier === 'key'
          ? policy.keyShotVideoCandidates
          : policy.normalShotVideoCandidates,
      autoConfirm: false,
      requiresHumanSelection: true,
    }
  })

  const audioSegments = normalizedShots.flatMap((shot) =>
    parseDeadBossDialogueSegments({ shot, characterIds }).map((segment) => ({
      ...segment,
      candidateCount: policy.audioCandidates,
      durationSeconds: Number(shot.durationSeconds) || 3,
      productionBatch,
    })),
  )

  return {
    mode: 'candidate-only',
    productionBatch,
    sceneKeys: DEAD_BOSS_SCENE_KEYS,
    candidatePolicy: policy,
    shots: planShots,
    audioSegments,
    selectionGate: 'human-or-agent-review-required',
  }
}

export function buildDeadBossGenerationPlan({ candidatePlan = {} } = {}) {
  const jobs = (Array.isArray(candidatePlan.shots) ? candidatePlan.shots : []).map((shot) => ({
    sceneKey: shot.sceneKey,
    shotKey: shot.shotKey,
    shotNo: shot.shotNo,
    storyboardId: positiveInteger(shot.storyboardId),
    characterId: positiveInteger(shot.characterId),
    characterName: text(shot.characterName),
    durationSeconds: Number(shot.durationSeconds) || 0,
    dialogueText: text(shot.dialogueText),
    image: {
      candidateCount: positiveInteger(shot.imageCandidateCount, 1),
      frameRole: 'primary',
      autoConfirm: false,
      modelName: 'agnes-image-2.1-flash',
    },
    video: {
      candidateCount: positiveInteger(shot.videoCandidateCount, 1),
      autoConfirm: false,
      modelName: 'agnes-video-v2.0',
    },
  }))

  return {
    mode: 'candidate-only',
    productionBatch: text(candidatePlan.productionBatch),
    selectionGate: 'human-or-agent-review-required',
    stages: ['images', 'selection', 'videos', 'audio', 'selection'],
    jobs,
    audioJobs: Array.isArray(candidatePlan.audioSegments)
      ? candidatePlan.audioSegments.map((segment) => ({
          ...segment,
          modelName: null,
          autoConfirm: false,
        }))
      : [],
  }
}

export function validateDeadBossPilotCandidatePlan(plan = {}, options = {}) {
  const errors = []
  const shots = Array.isArray(plan.shots) ? plan.shots : []
  const audioSegments = Array.isArray(plan.audioSegments) ? plan.audioSegments : []

  if (plan.mode !== 'candidate-only') errors.push('候选生产必须使用 candidate-only 模式')
  if (plan.selectionGate !== 'human-or-agent-review-required') {
    errors.push('候选生产必须保留人工或 Agent 筛选闸门')
  }
  if (!options.allowPartial && shots.length !== 9) {
    errors.push(`第一集候选计划必须包含 9 个镜头，当前为 ${shots.length} 个`)
  }

  const seenStoryboardIds = new Set()
  for (const shot of shots) {
    const storyboardId = positiveInteger(shot.storyboardId)
    if (!storyboardId || seenStoryboardIds.has(storyboardId)) {
      errors.push(`镜头 ${shot.shotNo || shot.shotKey || 'unknown'} 缺少有效 storyboardId 或重复`)
    }
    seenStoryboardIds.add(storyboardId)
    if (shot.autoConfirm !== false) errors.push(`镜头 ${shot.shotNo} 必须保持 autoConfirm=false`)
    if (shot.requiresHumanSelection !== true) errors.push(`镜头 ${shot.shotNo} 缺少人工筛选闸门`)
    if (!text(shot.startVisualPrompt) || !text(shot.endVisualPrompt)) {
      errors.push(`镜头 ${shot.shotNo} 缺少起止状态`)
    }
    if (/(林夏|苏岚|周衡|广播)：?/.test(text(shot.dialogueText))) {
      errors.push(`镜头 ${shot.shotNo} 混入旧故事，必须只使用《死去的老板给我发邮件》`)
    }
  }

  for (const segment of audioSegments) {
    if (!positiveInteger(segment.characterId)) {
      errors.push(`声音段落 ${segment.key || segment.shotKey} 缺少角色 ID`)
    }
    if (!text(segment.text)) errors.push(`声音段落 ${segment.key || segment.shotKey} 缺少对白`)
    if (/[A-Za-z]/.test(text(segment.text).replaceAll('U盘', '盘'))) {
      errors.push(`声音段落 ${segment.key || segment.shotKey} 不能包含英文`)
    }
    if (segment.autoConfirm !== false) {
      errors.push(`声音段落 ${segment.key || segment.shotKey} 必须保持 autoConfirm=false`)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    summary: {
      shotCount: shots.length,
      keyShotCount: shots.filter((shot) => shot.candidateTier === 'key').length,
      normalShotCount: shots.filter((shot) => shot.candidateTier === 'normal').length,
      audioSegmentCount: audioSegments.length,
    },
  }
}
