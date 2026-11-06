/**
 * @file AI output parsers
 * @description Normalize real-model JSON payloads into the stable shapes used by this project.
 */

import { normalizeStoryboardPerformance } from '../storyboard-performance.mjs'
import {
  inferLocationFromSceneText,
  inferTimeOfDayFromSceneText,
} from './scene-extraction.mjs'
import { normalizeCharacterCostume } from './character-costume.mjs'
import { sanitizeStoryboardPrompt } from '../storyboard-prompt-sanitizer.mjs'

function toNonEmptyString(value, fallback = '') {
  const text = String(value == null ? '' : value).trim()
  return text || fallback
}

function isPlaceholderText(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase()
  return ['', '未命名项目', '未命名场景', 'untitled project', 'untitled scene', 'n/a'].includes(text)
}

function toPositiveInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback
}

function normalizeAct(act, index) {
  return {
    act: toPositiveInt(act?.act, index + 1),
    title: toNonEmptyString(act?.title, `第${index + 1}幕`),
    summary: toNonEmptyString(act?.summary, '本幕摘要待补充。'),
  }
}

function normalizeOutlineScene(scene, index, fallbackDurationSeconds) {
  return {
    scene_no: toPositiveInt(scene?.scene_no, index + 1),
    title: toNonEmptyString(scene?.title, `场景 ${String(index + 1).padStart(2, '0')}`),
    summary: toNonEmptyString(scene?.summary, '本场景摘要待补充。'),
    location: toNonEmptyString(scene?.location, '未知地点'),
    time_of_day: toNonEmptyString(scene?.time_of_day, '夜'),
    estimated_duration: toPositiveInt(scene?.estimated_duration, fallbackDurationSeconds),
  }
}

/**
 * @param {any} payload
 * @param {object} project
 * @returns {object}
 */
export function normalizeOutlinePayload(payload, project) {
  // 模型返回的 JSON 可能缺字段、类型不一致或混入占位文字。
  // parser 的职责是把不稳定的模型输出变成数据库可以安全保存的 DTO。
  const targetMinutes = toPositiveInt(project?.targetDuration, 90)
  const sceneCountFallback = Math.max(4, Math.min(12, Math.round(targetMinutes / 10)))
  const fallbackDurationSeconds = Math.max(120, Math.round((targetMinutes * 60) / sceneCountFallback))

  const actsSource = Array.isArray(payload?.acts) ? payload.acts.slice(0, 3) : []
  const acts = actsSource.length
    ? actsSource.map((item, index) => normalizeAct(item, index))
    : [
        normalizeAct({ act: 1, title: '建置与钩子', summary: '建立世界观与主角初始处境。' }, 0),
        normalizeAct({ act: 2, title: '冲突与升级', summary: '冲突逐步升级，代价不断抬高。' }, 1),
        normalizeAct({ act: 3, title: '高潮与抉择', summary: '主角做出最终抉择并收束故事。' }, 2),
      ]

  const scenesSource = Array.isArray(payload?.scenes) ? payload.scenes : []
  const scenes = (scenesSource.length ? scenesSource : Array.from({ length: sceneCountFallback }, () => ({})))
    .slice(0, 20)
    .map((item, index) => normalizeOutlineScene(item, index, fallbackDurationSeconds))

  return {
    title: isPlaceholderText(payload?.title)
      ? toNonEmptyString(project?.name, '未命名项目')
      : toNonEmptyString(payload?.title, toNonEmptyString(project?.name, '未命名项目')),
    logline: toNonEmptyString(
      payload?.logline,
      `${toNonEmptyString(project?.name, '这个故事')}围绕一位主角在压力中被迫做出改变的过程展开。`,
    ),
    premise: toNonEmptyString(
      payload?.premise,
      toNonEmptyString(project?.narrativeVision, '故事设定待模型进一步补足。'),
    ),
    visual_style: toNonEmptyString(
      payload?.visual_style,
      toNonEmptyString(project?.visualStyle, '电影感写实风格'),
    ),
    acts,
    scenes,
  }
}

/**
 * @param {any} payload
 * @param {object} ctx
 * @returns {object}
 */
export function normalizeSceneScriptPayload(payload, ctx) {
  // 将剧本模型输出统一成 scene 的 title/mood/content 等字段。
  const scene = ctx?.scene || {}
  const outline = ctx?.outline || {}
  const project = ctx?.project || {}

  const content = toNonEmptyString(
    payload?.content,
    `【场景 ${String(toPositiveInt(scene?.scene_no, 1)).padStart(2, '0')}】\n${toNonEmptyString(
      scene?.summary,
      '本场景正文待补充。',
    )}`,
  )
  const sceneSource = {
    ...scene,
    ...payload,
    content,
  }
  const inferredLocation = inferLocationFromSceneText(sceneSource)
  const inferredTimeOfDay = inferTimeOfDayFromSceneText(sceneSource)

  return {
    scene_no: toPositiveInt(payload?.scene_no, toPositiveInt(scene?.scene_no, 1)),
    title: isPlaceholderText(payload?.title)
      ? toNonEmptyString(scene?.title, '未命名场景')
      : toNonEmptyString(payload?.title, toNonEmptyString(scene?.title, '未命名场景')),
    summary: toNonEmptyString(payload?.summary, toNonEmptyString(scene?.summary, '')),
    content,
    mood: toNonEmptyString(payload?.mood, '克制、悬疑，情绪逐步升高。'),
    location: inferredLocation || toNonEmptyString(payload?.location, toNonEmptyString(scene?.location, '未知地点')),
    time_of_day: inferredTimeOfDay || toNonEmptyString(payload?.time_of_day, toNonEmptyString(scene?.time_of_day, '夜')),
    estimated_duration: toPositiveInt(payload?.estimated_duration, toPositiveInt(scene?.estimated_duration, 120)),
    outline_title: toNonEmptyString(outline?.title, toNonEmptyString(project?.name, '本片')),
  }
}

function resolveStoryboardCharacterName(value, characters, index) {
  const raw = toNonEmptyString(value)
  if (!characters.length) return raw || '主角'
  const normalized = raw.toLocaleLowerCase('zh-CN')
  const exact = characters.find(
    (item) => toNonEmptyString(item?.name).toLocaleLowerCase('zh-CN') === normalized,
  )
  if (exact) return toNonEmptyString(exact.name)
  const byRole = characters.find((item) => {
    const role = toNonEmptyString(item?.role_tag ?? item?.roleTag).toLocaleLowerCase('zh-CN')
    return normalized && role && (role.includes(normalized) || normalized.includes(role))
  })
  if (byRole) return toNonEmptyString(byRole.name)
  const partial = characters.find((item) => {
    const name = toNonEmptyString(item?.name).toLocaleLowerCase('zh-CN')
    return normalized && name && (normalized.includes(name) || name.includes(normalized))
  })
  // 未知姓名不能静默替换成当前 cast 的第一个角色；否则“王”会被改成
  // “林默”，既掩盖了 Agent 错误，也会让资产门禁看到错误角色引用。
  return raw || ''
}

function removePrivateStoryboardDurationEvidence(value) {
  return String(value ?? '')
    .replace(/(?:duration_breakdown|duration_basis|时长拆解|时长依据)\s*[:：=]\s*[^；;\n]*/giu, '')
    .replace(/[；;]\s*[；;]/gu, '；')
    .trim()
}

function buildFallbackStoryboardPrompt({
  projectVisualStyle,
  shotType,
  cameraAngle,
  composition,
  durationSeconds,
  durationBreakdown,
  actionText,
  dialogueText,
  audioDirection,
} = {}) {
  const duration = Number(durationSeconds)
  const plan = Array.isArray(durationBreakdown) ? durationBreakdown : []
  const planTotal = plan.reduce((sum, item) => sum + Number(item?.seconds || 0), 0)
  let cursor = 0
  const timeline = Number.isInteger(duration) && duration > 0 && plan.length && planTotal === duration
    ? plan.map((item) => {
      const start = cursor
      cursor += Number(item.seconds)
      return `${start}-${cursor}秒，${toNonEmptyString(item.observable)}`
    }).join('；')
    : Number.isInteger(duration) && duration > 0
      ? `0-${duration}秒，${actionText}`
      : ''
  return [
    timeline ? `时间轴：${timeline}` : '时间轴：',
    `镜头：${shotType}，${cameraAngle}`,
    `位置：${composition}`,
    `动作：${actionText}`,
    `要求：${projectVisualStyle}`,
    dialogueText && dialogueText !== '（无对白）' ? `对白：${dialogueText}` : '',
    audioDirection ? `声音：${audioDirection}` : '',
  ].filter(Boolean).join('；')
}

function buildStoryboardTimeline(durationSeconds, durationBreakdown) {
  const duration = Number(durationSeconds)
  const plan = Array.isArray(durationBreakdown) ? durationBreakdown : []
  if (!Number.isInteger(duration) || duration < 1 || !plan.length) return ''

  const normalizedPlan = plan.map((item) => ({
    seconds: Number(item?.seconds ?? item?.duration_seconds ?? item?.durationSeconds),
    observable: toNonEmptyString(item?.observable ?? item?.event ?? item?.result),
  }))
  if (normalizedPlan.some((item) => !Number.isInteger(item.seconds) || item.seconds < 1 || !item.observable)) {
    return ''
  }
  const total = normalizedPlan.reduce((sum, item) => sum + item.seconds, 0)
  if (total !== duration) return ''

  let cursor = 0
  return normalizedPlan.map((item) => {
    const start = cursor
    cursor += item.seconds
    return `${start}-${cursor}秒，${item.observable}`
  }).join('；')
}

function repairVisibleStoryboardTimeline(source, durationSeconds, durationBreakdown) {
  if (!source) return source
  const timeline = buildStoryboardTimeline(durationSeconds, durationBreakdown)
  if (!timeline) return source
  const timelineLabel = `时间轴：${timeline}`
  if (!/时间轴：/u.test(source)) {
    return [timelineLabel, source].filter(Boolean).join('；')
  }
  return source.replace(
    /时间轴：[\s\S]*?(?=(?:；|;|\r?\n)\s*(?:镜头|位置|动作|要求|对白|旁白|声音|视线)：|$)/u,
    timelineLabel,
  )
}

function buildUnifiedStoryboardPrompt({
  visualPrompt,
  characterName,
  characterAssets,
  sceneAssets,
  propAssets,
  dialogueText,
  gazePlan,
  soundPlan,
  exposeDirectionPlan = false,
} = {}) {
  let source = removePrivateStoryboardDurationEvidence(toNonEmptyString(visualPrompt))
  if (exposeDirectionPlan && gazePlan?.promptText && !/视线：/u.test(source)) {
    source = [source, `视线：${gazePlan.promptText}`].filter(Boolean).join('；')
  }
  if (exposeDirectionPlan && soundPlan?.promptText && !/声音：/u.test(source)) {
    source = [source, `声音：${soundPlan.promptText}`].filter(Boolean).join('；')
  }
  const mentions = [
    characterName,
    ...(Array.isArray(characterAssets) ? characterAssets : []),
    ...(Array.isArray(sceneAssets) ? sceneAssets : []),
    ...(Array.isArray(propAssets) ? propAssets : []),
  ].map((item) => toNonEmptyString(item)).filter(Boolean)
    .map((item) => item.startsWith('@') ? item : `@${item}`)
  const voiceMention = characterName && dialogueText && dialogueText !== '（无对白）'
    ? `@音色[${characterName}]`
    : ''
  const missingMentions = [...new Set([...mentions, voiceMention].filter(Boolean))]
    .filter((item) => !source.includes(item))
  return [missingMentions.length ? missingMentions.join('、') : '', source]
    .filter(Boolean)
    .join('；')
}

function normalizeStoryboardShot(shot, index, projectVisualStyle, characters) {
  const shotNo = String(toPositiveInt(shot?.shot_no, index + 1)).padStart(2, '0')
  const shotType = toNonEmptyString(shot?.shot_type, '中景')
  const cameraAngle = toNonEmptyString(shot?.camera_angle, '平视')
  const composition = toNonEmptyString(shot?.composition, '三分构图').slice(0, 255)

  const performance = normalizeStoryboardPerformance(shot)
  const characterName = resolveStoryboardCharacterName(shot?.character_name, characters, index)
  const promptCharacterName = characters.length || toNonEmptyString(shot?.character_name)
    ? characterName
    : ''
  const actionText = toNonEmptyString(shot?.action_text, '镜头捕捉角色动作与当前场景推进。')
  const dialogueText = toNonEmptyString(shot?.dialogue_text, '（无对白）')
  const hasExplicitDirectionPlan = Boolean(
    shot?.gaze_plan || shot?.gazePlan || shot?.sound_plan || shot?.soundPlan,
  )
  const emotionalChange = performance.emotionChange
  const endState = toNonEmptyString(shot?.end_state ?? shot?.endState, '镜头结束时为下一镜留下可继承状态。')
  const characterAssets = Array.isArray(shot?.character_assets ?? shot?.characterAssets)
    ? (shot.character_assets ?? shot.characterAssets).map((item) => toNonEmptyString(item)).filter(Boolean)
    : []
  const sceneAssets = Array.isArray(shot?.scene_assets ?? shot?.sceneAssets)
    ? (shot.scene_assets ?? shot.sceneAssets).map((item) => toNonEmptyString(item)).filter(Boolean)
    : []
  const propAssets = Array.isArray(shot?.prop_assets ?? shot?.propAssets)
    ? (shot.prop_assets ?? shot.propAssets).map((item) => toNonEmptyString(item)).filter(Boolean)
    : []
  const sanitizedVisualPrompt = toNonEmptyString(
    sanitizeStoryboardPrompt(shot?.visual_prompt, {
      characterNames: characters.map((character) => character?.name),
    }),
  )
  const durationSeconds = shot?.duration_seconds ?? shot?.durationSeconds
  const durationBreakdown = shot?.duration_breakdown ?? shot?.durationBreakdown ?? shot?.timing_plan ?? shot?.timingPlan
  const repairedVisualPrompt = repairVisibleStoryboardTimeline(
    sanitizedVisualPrompt,
    durationSeconds,
    durationBreakdown,
  )
  const baseVisualPrompt = repairedVisualPrompt || buildFallbackStoryboardPrompt({
    projectVisualStyle,
    shotType,
    cameraAngle,
    composition,
    durationSeconds,
    durationBreakdown,
    actionText,
    dialogueText,
    audioDirection: performance.audioDirection,
  })

  return {
    shot_no: shotNo,
    shot_type: shotType,
    camera_angle: cameraAngle,
    composition,
    duration_seconds: shot?.duration_seconds ?? shot?.durationSeconds ?? null,
    duration_breakdown: durationBreakdown ?? [],
    duration_basis: toNonEmptyString(shot?.duration_basis ?? shot?.durationBasis),
    character_name: characterName,
    action_text: actionText,
    dialogue_text: dialogueText,
    visual_prompt: buildUnifiedStoryboardPrompt({
      visualPrompt: baseVisualPrompt,
      characterName: promptCharacterName,
      characterAssets,
      sceneAssets,
      propAssets,
      dialogueText,
      gazePlan: performance.gazePlan,
      soundPlan: performance.soundPlan,
      exposeDirectionPlan: hasExplicitDirectionPlan,
    }),
    shot_purpose: performance.shotPurpose,
    acting_beat: performance.actingBeat,
    audio_direction: performance.audioDirection,
    speech_duration_policy: performance.speechDurationPolicy,
    reaction_shot: performance.reactionShot,
    emotional_change: emotionalChange,
    emotion: performance.emotion,
    emotion_intensity: performance.intensity,
    emotion_start: performance.emotionStart,
    emotion_trigger: performance.emotionTrigger,
    emotion_end: performance.emotionEnd,
    micro_expression: performance.microExpression,
    breath_action: performance.breathAction,
    body_action: performance.bodyAction,
    voice_tone: performance.voiceTone,
    voice_volume: performance.voiceVolume,
    speech_rate: performance.speechRate,
    speech_pauses: performance.speechPauses,
    lip_sync: performance.lipSync,
    continuity_from_previous: performance.continuityFromPrevious,
    gaze_plan: performance.gazePlan,
    sound_plan: performance.soundPlan,
    performance,
    start_state: toNonEmptyString(shot?.start_state ?? shot?.startState, '镜头开始时沿用上一状态。'),
    end_state: toNonEmptyString(shot?.end_state ?? shot?.endState, '镜头结束时为下一镜留下可继承状态。'),
    character_assets: characterAssets,
    scene_assets: sceneAssets,
    prop_assets: propAssets,
    tools: Array.isArray(shot?.tools ?? shot?.mention_tools ?? shot?.mentionTools)
      ? (shot.tools ?? shot.mention_tools ?? shot.mentionTools).map((item) => toNonEmptyString(item)).filter(Boolean)
      : [],
    scene_view_key: toNonEmptyString(shot?.scene_view_key ?? shot?.sceneViewKey),
    start_visual_prompt: toNonEmptyString(shot?.start_visual_prompt ?? shot?.startVisualPrompt),
    end_visual_prompt: toNonEmptyString(shot?.end_visual_prompt ?? shot?.endVisualPrompt),
  }
}

/**
 * @param {any} payload
 * @param {object} ctx
 * @returns {{ scene_id: number, shots: Array<object> }}
 */
export function normalizeStoryboardPayload(payload, ctx) {
  // 将模型生成的镜头列表统一成 storyboards 表需要的字段，
  // 同时修正 shotNo、时长、角色名和视觉提示词的默认值。
  const scene = ctx?.scene || {}
  const project = ctx?.project || {}
  const projectVisualStyle = toNonEmptyString(project?.visualStyle, '电影感写实风格')
  const characters = Array.isArray(ctx?.characters) ? ctx.characters.filter((item) => item?.name) : []
  const shotsSource = Array.isArray(payload?.shots) ? payload.shots : []
  const normalizedShots = (shotsSource.length ? shotsSource : Array.from({ length: 4 }, () => ({})))
    .slice(0, 20)
    .map((item, index) =>
      normalizeStoryboardShot(item, index, projectVisualStyle, characters),
    )

  return {
    scene_id: toPositiveInt(payload?.scene_id, toPositiveInt(ctx?.sceneId, toPositiveInt(scene?.id, 0))),
    shots: normalizedShots,
  }
}

const CHARACTER_VOICES = [
  'Cherry',
  'Serena',
  'Ethan',
  'Chelsie',
  'Momo',
  'Vivian',
  'Moon',
  'Maia',
  'Kai',
  'Nofish',
  'Bella',
  'Jennifer',
  'Ryan',
  'Katerina',
  'Aiden',
  'Eldric Sage',
  'Mia',
  'Mochi',
]
const CHARACTER_AGE_GROUPS = ['child', 'teen', 'young_adult', 'middle_aged', 'senior']
const CHARACTER_GENDERS = ['male', 'female', 'neutral']

function normalizeVoiceSetting(value, fallbackValue) {
  const raw = toNonEmptyString(value)
  const matched = CHARACTER_VOICES.find((voice) => voice.toLowerCase() === raw.toLowerCase())
  if (matched) return matched
  const fallback = toNonEmptyString(fallbackValue)
  return CHARACTER_VOICES.find((voice) => voice.toLowerCase() === fallback.toLowerCase()) || null
}

function normalizeEnum(value, supported, fallbackValue) {
  const normalized = String(value || '').trim().toLowerCase()
  if (supported.includes(normalized)) return normalized
  const fallback = String(fallbackValue || '').trim().toLowerCase()
  return supported.includes(fallback) ? fallback : null
}

function normalizeCharacter(item, index, fallback = {}) {
  return {
    name: toNonEmptyString(item?.name, toNonEmptyString(fallback?.name, `角色 ${index + 1}`)),
    role_tag: toNonEmptyString(
      item?.role_tag ?? item?.roleTag,
      toNonEmptyString(fallback?.role_tag ?? fallback?.roleTag, index === 0 ? '主角' : '配角'),
    ),
    personality: toNonEmptyString(
      item?.personality,
      toNonEmptyString(fallback?.personality, '性格鲜明，行为动机与剧情目标一致。'),
    ),
    appearance: toNonEmptyString(
      item?.appearance,
      toNonEmptyString(fallback?.appearance, '具有清晰可辨的脸部、发型、体态与服装特征。'),
    ),
    costume: normalizeCharacterCostume(item, fallback?.costume ?? fallback?.costume_description) || null,
    voice_setting: normalizeVoiceSetting(
      item?.voice_setting ?? item?.voiceSetting,
      fallback?.voice_setting ?? fallback?.voiceSetting,
    ),
    age_group: normalizeEnum(
      item?.age_group ?? item?.ageGroup,
      CHARACTER_AGE_GROUPS,
      fallback?.age_group ?? fallback?.ageGroup,
    ),
    gender: normalizeEnum(item?.gender, CHARACTER_GENDERS, fallback?.gender),
    voice_style: toNonEmptyString(
      item?.voice_style ?? item?.voiceStyle,
      toNonEmptyString(fallback?.voice_style ?? fallback?.voiceStyle),
    ).slice(0, 160) || null,
  }
}

function normalizeCharacterName(value) {
  return toNonEmptyString(value)
    .replace(/[（(](?:成年|青年|少年|童年|小时候|当前|现在|过去|五年前|十八年前)[）)]/g, '')
    .replace(/\s+/g, '')
    .trim()
}

function inferExplicitGender(name, appearance, role, ctx) {
  if (name === '林默') return 'male'
  // 先判定当前角色自身证据，避免同场其他男性角色污染目标角色的性别。
  const identitySource = [name, appearance, role].filter(Boolean).join('\n')
  if (/(?:女主角|女主|女配角|女配|女性|女人|女士|女孩|母亲|妈妈|她穿着|她的)/u.test(identitySource)) {
    return 'female'
  }
  if (/(?:男主角|男主|男配角|男配|男性|男人|男士|男孩|父亲|爸爸|他穿着|他的)/u.test(identitySource)) {
    return 'male'
  }

  const source = [
    identitySource,
    ...(Array.isArray(ctx?.scenes) ? ctx.scenes.flatMap((scene) => [
      scene?.title,
      scene?.summary,
      scene?.content,
    ]) : []),
  ].filter(Boolean).join('\n')
  if (/(?:男主角|男主|他穿着|他的|男性|男人|男士|男孩|父亲|爸爸)/u.test(source)) return 'male'
  if (/(?:女主角|女主|她穿着|她的|女性|女人|女士|女孩|母亲|妈妈)/u.test(source)) return 'female'
  return ''
}

const NARRATIVE_ROLE_LABEL = /^(?:主角|男主角|女主角|男主|女主|第一主角|核心人物|主人公)$/u

function inferProtagonistName(ctx = {}, knownNames = []) {
  const source = [
    ctx?.outline?.premise,
    ctx?.outline?.logline,
    ctx?.outline?.raw_json,
    ...(Array.isArray(ctx?.scenes) ? ctx.scenes.flatMap((scene) => [
      scene?.title,
      scene?.summary,
      scene?.content,
    ]) : []),
  ].filter(Boolean).join('\n')
  const known = knownNames
    .map(normalizeCharacterName)
    .filter((value) => value && !NARRATIVE_ROLE_LABEL.test(value))
    .sort((left, right) => right.length - left.length)
  const knownMatch = known.find((name) => source.includes(name))
  if (knownMatch) return knownMatch
  const explicit = source.match(/(?:主角|主人公|男主角|女主角)\s*(?:是|叫|为|：|:|，|、)?\s*([\u4e00-\u9fa5]{2,4})(?=[^\u4e00-\u9fa5]|$)/u)?.[1]
  if (explicit && !NARRATIVE_ROLE_LABEL.test(explicit)) return explicit.trim()
  const candidates = [...source.matchAll(/[\u4e00-\u9fa5]{2,4}/gu)]
    .map((match) => match[0])
    .filter((value) => !/^(?:主角|主人公|男主角|女主角|深夜|收到|来自|死者|邮件|场景|公司|程序员)$/u.test(value))
  return candidates.find((value) => value === '林默') || candidates[0] || ''
}

function resolveNarrativeRoleName(name, role, ctx, knownNames = []) {
  const normalizedName = normalizeCharacterName(name)
  if (!NARRATIVE_ROLE_LABEL.test(normalizedName)) return normalizedName
  const inferred = inferProtagonistName(ctx, knownNames)
  return inferred || ''
}

function isNonCharacterLabel(character) {
  const name = toNonEmptyString(character?.name)
  const role = toNonEmptyString(character?.role_tag ?? character?.roleTag)
  return /^(路人|群众|群演|旁白|观众|员工|同事|保安|司机|警察)[甲乙丙丁戊己庚辛壬癸一二三四五六七八九十\d]*$/u.test(name)
    || /群演|无名|路人|背景人物|群众/u.test(role)
}

function currentScriptText(ctx = {}) {
  return (Array.isArray(ctx?.scenes) ? ctx.scenes : [])
    .flatMap((scene) => [
      scene?.title,
      scene?.summary,
      scene?.content,
      scene?.location,
    ])
    .filter(Boolean)
    .join('\n')
}

export function normalizeCharactersPayload(payload, ctx = {}) {
  // 将角色模型输出统一成角色库字段，并过滤重复角色名。
  const source = Array.isArray(payload?.characters)
    ? payload.characters
    : Array.isArray(payload)
      ? payload
      : []
  const seen = new Set()
  const characters = []
  const sourceNames = source
    .map((item) => normalizeCharacterName(item?.name))
    .filter((name) => name && !NARRATIVE_ROLE_LABEL.test(name))
  const scriptText = currentScriptText(ctx)
  const enforceCurrentScriptEvidence = ctx?.strictScriptEvidence === true && Boolean(scriptText)

  for (const item of source.slice(0, 20)) {
    const character = normalizeCharacter(item, characters.length)
    character.name = normalizeCharacterName(character.name)
    character.name = resolveNarrativeRoleName(
      character.name,
      character.role_tag,
      ctx,
      sourceNames,
    )
    if (!character.name) continue
    if (enforceCurrentScriptEvidence && !scriptText.includes(character.name)) continue
    character.gender = inferExplicitGender(
      character.name,
      character.appearance,
      character.role_tag,
      ctx,
    ) || character.gender
    if (isNonCharacterLabel(character)) continue
    const key = character.name
      .replace(/(?:成年|青年|少年|童年|小时候|当前|现在|过去|五年前|十八年前)$/u, '')
      .toLocaleLowerCase('zh-CN')
    if (!key || seen.has(key)) continue
    seen.add(key)
    characters.push(character)
  }

  return { characters }
}

export function normalizeCharacterProfilePayload(payload, currentCharacter = {}) {
  // 档案补全使用“当前角色字段优先”策略，避免模型返回空值覆盖已有人工编辑内容。
  const source = payload?.character && typeof payload.character === 'object' ? payload.character : payload
  return normalizeCharacter(source || {}, 0, currentCharacter)
}
