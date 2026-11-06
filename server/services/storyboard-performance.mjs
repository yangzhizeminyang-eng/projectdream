const DEFAULT_SHOT_PURPOSE = 'story'
const DEFAULT_SPEECH_DURATION_POLICY = 'preserve'
const SILENT_DIALOGUE_PATTERN = /^(?:（无对白）|\(无对白\)|无对白|none|no dialogue)$/i

import {
  normalizeGazePlan,
  normalizeSoundPlan,
} from './storyboard-direction-contract.mjs'

function text(value) {
  return String(value || '').trim()
}

function isSilentDialogue(value) {
  const normalized = text(value)
  return !normalized || SILENT_DIALOGUE_PATTERN.test(normalized)
}

function clampDuration(value, fallback = 1) {
  const duration = Number(value)
  if (!Number.isFinite(duration) || duration <= 0) return fallback
  return Math.max(1, Math.min(12, Math.ceil(duration)))
}

function clampIntensity(value, fallback = 50) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const normalized = parsed >= 0 && parsed <= 1 ? parsed * 100 : parsed
  return Math.max(0, Math.min(100, Math.round(normalized)))
}

function estimateDialogueDurationSeconds(dialogueText) {
  const content = text(dialogueText).replace(/^.{1,30}[:：]\s*/, '')
  const characterCount = Array.from(content).filter((item) => !/\s/.test(item)).length
  return clampDuration(Math.ceil(characterCount / 5), 2)
}

function clonePrompt(basePrompt, suffix) {
  return [text(basePrompt), suffix].filter(Boolean).join('，')
}

export function normalizeStoryboardPerformance(input = {}) {
  const shotPurpose = text(input.shot_purpose ?? input.shotPurpose) || DEFAULT_SHOT_PURPOSE
  const actingBeat = text(input.acting_beat ?? input.actingBeat)
  const audioDirection = text(input.audio_direction ?? input.audioDirection)
  const speechDurationPolicy =
    text(input.speech_duration_policy ?? input.speechDurationPolicy) ||
    DEFAULT_SPEECH_DURATION_POLICY

  return {
    shotPurpose,
    actingBeat,
    audioDirection,
    speechDurationPolicy,
    reactionShot: Boolean(input.reaction_shot ?? input.reactionShot),
    emotion: text(input.emotion ?? input.current_emotion ?? input.currentEmotion) || '情绪随剧情自然推进',
    intensity: clampIntensity(input.intensity ?? input.emotion_intensity ?? input.emotionIntensity),
    emotionStart: text(input.emotion_start ?? input.emotionStart) || '镜头开始时承接上一镜头的情绪状态',
    emotionTrigger: text(input.emotion_trigger ?? input.emotionTrigger) || '由本镜头的剧情信息或动作触发',
    emotionChange: text(input.emotion_change ?? input.emotional_change ?? input.emotionChange) || '情绪随本镜头动作和信息逐步变化',
    emotionEnd: text(input.emotion_end ?? input.emotionEnd) || '镜头结束时保留可供下一镜头承接的情绪余波',
    microExpression: text(input.micro_expression ?? input.microExpression) || '眼神、眉眼、嘴角和下颌保持可读且克制的变化',
    breathAction: text(input.breath_action ?? input.breathAction) || '按情绪完成吸气、呼气或短暂停顿',
    bodyAction: text(input.body_action ?? input.bodyAction) || '身体重心、肩颈、手指和姿态随情绪发生细微变化',
    voiceTone: text(input.voice_tone ?? input.voiceTone) || '与角色固定声线一致，并匹配当前情绪',
    voiceVolume: text(input.voice_volume ?? input.voiceVolume) || '按情绪自然变化，避免无依据夸张',
    speechRate: text(input.speech_rate ?? input.speechRate) || '自然语速，按对白情绪调整',
    speechPauses: text(input.speech_pauses ?? input.speechPauses) || '在语义和情绪转折处保留可听见的停顿',
    lipSync: text(input.lip_sync ?? input.lipSync) || '对白逐字对应口型，停顿时闭唇并保留呼吸和面部反应',
    continuityFromPrevious: text(input.continuity_from_previous ?? input.continuityFromPrevious) || '承接上一镜头的视线、姿态、空间位置和情绪强度',
    gazePlan: normalizeGazePlan(input),
    soundPlan: normalizeSoundPlan(input),
  }
}

export function buildStoryboardPerformancePrompt(input = {}) {
  const performance = normalizeStoryboardPerformance(input)
  return [
    `当前情绪：${performance.emotion}（强度 ${performance.intensity}/100）`,
    `情绪起点：${performance.emotionStart}`,
    `情绪触发：${performance.emotionTrigger}`,
    `情绪变化：${performance.emotionChange}`,
    `情绪结束：${performance.emotionEnd}`,
    `微表情：${performance.microExpression}`,
    `呼吸与停顿：${performance.breathAction}`,
    `身体与手部动作：${performance.bodyAction}`,
    `声音：${performance.voiceTone}；音量：${performance.voiceVolume}；语速：${performance.speechRate}；停顿：${performance.speechPauses}`,
    `口型同步：${performance.lipSync}`,
    `上一镜衔接：${performance.continuityFromPrevious}`,
    `视线执行：${performance.gazePlan.promptText}；眼睛与头部：${performance.gazePlan.eyeLead}；结束锁定：${performance.gazePlan.endTarget}`,
    `声音执行：${performance.soundPlan.promptText}；静音策略：${performance.soundPlan.silencePolicy}`,
  ].join('\n')
}

export function buildPerformanceSubShots({ shot = {}, dialogueDurationSeconds } = {}) {
  const dialogueText = text(shot.dialogue_text ?? shot.dialogueText)
  const actionText = text(shot.action_text ?? shot.actionText) || '角色完成当前动作。'
  const visualPrompt = text(shot.visual_prompt ?? shot.visualPrompt)
  const baseDuration = clampDuration(shot.duration_seconds ?? shot.durationSeconds, 2)
  const common = {
    shotType: text(shot.shot_type ?? shot.shotType) || '中景',
    cameraAngle: text(shot.camera_angle ?? shot.cameraAngle) || '平视',
    composition: text(shot.composition) || '三分构图',
    characterId: shot.character_id ?? shot.characterId ?? null,
    characterName: text(shot.character_name ?? shot.characterName),
    speechDurationPolicy: DEFAULT_SPEECH_DURATION_POLICY,
  }

  if (isSilentDialogue(dialogueText)) {
    const detailDuration = Math.max(1, Math.ceil(baseDuration * 0.55))
    return [
      {
        ...common,
        durationSeconds: detailDuration,
        actionText,
        dialogueText: '',
        visualPrompt: clonePrompt(visualPrompt, '先给动作细节或道具反应一个清晰的视觉落点'),
        startVisualPrompt: clonePrompt(visualPrompt, '动作发生前的稳定准备姿态'),
        endVisualPrompt: clonePrompt(visualPrompt, '动作完成后的停顿与信息落点'),
        shotPurpose: 'insert',
        actingBeat: '先让观众看清动作细节，再留出一个短停顿承接下一拍。',
        audioDirection: '保留环境声和动作声，不添加对白，动作完成后留出短暂静默。',
        reactionShot: true,
      },
      {
        ...common,
        durationSeconds: Math.max(1, baseDuration - detailDuration),
        actionText: '角色或现场对刚刚发生的细节做出可见反应。',
        dialogueText: '',
        visualPrompt: clonePrompt(visualPrompt, '反应镜头，保持角色外貌服装和空间连续'),
        startVisualPrompt: clonePrompt(visualPrompt, '承接上一镜头动作完成的姿态'),
        endVisualPrompt: clonePrompt(visualPrompt, '反应停住，为下一条信息保留余波'),
        shotPurpose: 'reaction',
        actingBeat: '反应先到眼神或身体，再停住半拍，让信息被观众接住。',
        audioDirection: '环境声继续，反应阶段不抢对白，保留半拍静默。',
        reactionShot: true,
      },
    ]
  }

  const speechDuration = clampDuration(
    dialogueDurationSeconds ?? estimateDialogueDurationSeconds(dialogueText),
    Math.max(2, baseDuration),
  )
  const reactionDuration = Math.max(1, Math.min(2, Math.ceil(baseDuration * 0.35)))
  return [
    {
      ...common,
      durationSeconds: Math.max(baseDuration, speechDuration),
      actionText,
      dialogueText,
      visualPrompt: clonePrompt(visualPrompt, '当前说话角色承担口型和主要表演，其他角色只做倾听反应'),
      startVisualPrompt: clonePrompt(visualPrompt, '说话前吸气、确认视线和情绪'),
      endVisualPrompt: clonePrompt(visualPrompt, '说完后保留表情停顿，不立即切走'),
      shotPurpose: 'dialogue',
      actingBeat: '先吸气建立情绪，在关键词处轻微重读，句尾收住并保留说完后的停顿。',
      audioDirection: '对白保留原始语速，关键词轻微重读，句中留短停顿，环境声压低但不断。',
      reactionShot: false,
    },
    {
      ...common,
      durationSeconds: reactionDuration,
      actionText: '听者或现场在对白结束后给出一个明确、可读的反应。',
      dialogueText: '',
      visualPrompt: clonePrompt(visualPrompt, '切到听者或现场反应，不张嘴，保持时空和角色版本连续'),
      startVisualPrompt: clonePrompt(visualPrompt, '对白结束后的瞬间反应'),
      endVisualPrompt: clonePrompt(visualPrompt, '反应停住，承接下一句或下一动作'),
      shotPurpose: 'reaction',
      actingBeat: '对白结束后先用眼神或身体变化接住信息，再停住半拍。',
      audioDirection: '对白结束后保留环境声和呼吸声，不追加无依据台词。',
      reactionShot: true,
    },
  ]
}

export function ensurePerformanceBeatCoverage(shots = [], baseShot = {}) {
  const normalizedShots = Array.isArray(shots) ? shots.filter(Boolean) : []
  const hasDialogue = normalizedShots.some(
    (shot) => !isSilentDialogue(shot.dialogueText ?? shot.dialogue_text),
  )
  const hasReaction = normalizedShots.some(
    (shot) =>
      Boolean(shot.reactionShot ?? shot.reaction_shot) ||
      ['reaction', 'insert'].includes(text(shot.shotPurpose ?? shot.shot_purpose).toLowerCase()),
  )

  if (!hasDialogue || hasReaction) return normalizedShots

  const reactionShot = buildPerformanceSubShots({ shot: baseShot }).find(
    (shot) => shot.shotPurpose === 'reaction',
  )
  return reactionShot ? [...normalizedShots, reactionShot] : normalizedShots
}

export function buildStoryboardPerformancePlan({ shot = {}, subShots } = {}) {
  const sourceDuration = clampDuration(shot.duration_seconds ?? shot.durationSeconds, 2)
  const plannedSubShots = ensurePerformanceBeatCoverage(
    Array.isArray(subShots) && subShots.length ? subShots : buildPerformanceSubShots({ shot }),
    shot,
  )
  const totalDurationSeconds = plannedSubShots.reduce(
    (sum, item) => sum + clampDuration(item.durationSeconds, 1),
    0,
  )
  const hasDialogue = plannedSubShots.some(
    (item) => !isSilentDialogue(item.dialogueText ?? item.dialogue_text),
  )
  const hasReaction = plannedSubShots.some(
    (item) =>
      Boolean(item.reactionShot ?? item.reaction_shot) ||
      ['reaction', 'insert'].includes(text(item.shotPurpose ?? item.shot_purpose).toLowerCase()),
  )

  return {
    version: 'storyboard-performance-v1',
    strategy: 'speaker-reaction-beats',
    source: {
      storyboardId: Number(shot.id ?? shot.storyboardId) || null,
      sceneId: Number(shot.scene_id ?? shot.sceneId) || null,
      shotNo: text(shot.shot_no ?? shot.shotNo),
      durationSeconds: sourceDuration,
    },
    hasDialogue,
    hasReaction,
    speechTimingPreserved: plannedSubShots
      .filter((item) => !isSilentDialogue(item.dialogueText ?? item.dialogue_text))
      .every((item) => text(item.speechDurationPolicy ?? item.speech_duration_policy) === 'preserve'),
    totalDurationSeconds,
    durationDeltaSeconds: totalDurationSeconds - sourceDuration,
    subShots: plannedSubShots,
    blockingIssues: hasDialogue && !hasReaction
      ? ['对白镜头缺少无对白反应节拍']
      : [],
  }
}

export function shouldUseReactionShot({
  dialogueText = '',
  actionText = '',
  shotPurpose = '',
} = {}) {
  const normalizedDialogue = text(dialogueText)
  const hasDialogue =
    normalizedDialogue &&
    !/^(?:（无对白）|\(无对白\)|无对白|none|no dialogue)$/i.test(normalizedDialogue)
  const hasAction = Boolean(text(actionText))
  const purpose = text(shotPurpose).toLowerCase()
  return !hasDialogue && hasAction && ['reaction', 'insert', 'establishing'].includes(purpose)
}
