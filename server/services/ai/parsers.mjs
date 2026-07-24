/**
 * @file AI output parsers
 * @description Normalize real-model JSON payloads into the stable shapes used by this project.
 */

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
  const scene = ctx?.scene || {}
  const outline = ctx?.outline || {}
  const project = ctx?.project || {}

  return {
    scene_no: toPositiveInt(payload?.scene_no, toPositiveInt(scene?.scene_no, 1)),
    title: isPlaceholderText(payload?.title)
      ? toNonEmptyString(scene?.title, '未命名场景')
      : toNonEmptyString(payload?.title, toNonEmptyString(scene?.title, '未命名场景')),
    summary: toNonEmptyString(payload?.summary, toNonEmptyString(scene?.summary, '')),
    content: toNonEmptyString(
      payload?.content,
      `【场景 ${String(toPositiveInt(scene?.scene_no, 1)).padStart(2, '0')}】\n${toNonEmptyString(
        scene?.summary,
        '本场景正文待补充。',
      )}`,
    ),
    mood: toNonEmptyString(payload?.mood, '克制、悬疑，情绪逐步升高。'),
    location: toNonEmptyString(payload?.location, toNonEmptyString(scene?.location, '未知地点')),
    time_of_day: toNonEmptyString(payload?.time_of_day, toNonEmptyString(scene?.time_of_day, '夜')),
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
  return toNonEmptyString(partial?.name, toNonEmptyString(characters[index % characters.length]?.name, raw || '主角'))
}

function normalizeStoryboardShot(shot, index, fallbackDurationSeconds, projectVisualStyle, characters) {
  const shotNo = String(toPositiveInt(shot?.shot_no, index + 1)).padStart(2, '0')
  const shotType = toNonEmptyString(shot?.shot_type, '中景')
  const cameraAngle = toNonEmptyString(shot?.camera_angle, '平视')
  const composition = toNonEmptyString(shot?.composition, '三分构图').slice(0, 255)

  return {
    shot_no: shotNo,
    shot_type: shotType,
    camera_angle: cameraAngle,
    composition,
    duration_seconds: toPositiveInt(shot?.duration_seconds, fallbackDurationSeconds),
    character_name: resolveStoryboardCharacterName(shot?.character_name, characters, index),
    action_text: toNonEmptyString(shot?.action_text, '镜头捕捉角色动作与当前场景推进。'),
    dialogue_text: toNonEmptyString(shot?.dialogue_text, '（无对白）'),
    visual_prompt: toNonEmptyString(
      shot?.visual_prompt,
      `${projectVisualStyle}，${shotType}，${cameraAngle}，${composition}，电影感构图，可直接用于画面生成`,
    ),
  }
}

/**
 * @param {any} payload
 * @param {object} ctx
 * @returns {{ scene_id: number, shots: Array<object> }}
 */
export function normalizeStoryboardPayload(payload, ctx) {
  const scene = ctx?.scene || {}
  const project = ctx?.project || {}
  const fallbackDurationSeconds = Math.max(
    2,
    Math.min(8, Math.round((toPositiveInt(scene?.estimated_duration, 120) || 120) / 30)),
  )
  const projectVisualStyle = toNonEmptyString(project?.visualStyle, '电影感写实风格')
  const characters = Array.isArray(ctx?.characters) ? ctx.characters.filter((item) => item?.name) : []
  const shotsSource = Array.isArray(payload?.shots) ? payload.shots : []
  const normalizedShots = (shotsSource.length ? shotsSource : Array.from({ length: 4 }, () => ({})))
    .slice(0, 20)
    .map((item, index) =>
      normalizeStoryboardShot(item, index, fallbackDurationSeconds, projectVisualStyle, characters),
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

export function normalizeCharactersPayload(payload) {
  const source = Array.isArray(payload?.characters)
    ? payload.characters
    : Array.isArray(payload)
      ? payload
      : []
  const seen = new Set()
  const characters = []

  for (const item of source.slice(0, 20)) {
    const character = normalizeCharacter(item, characters.length)
    const key = character.name.toLocaleLowerCase('zh-CN')
    if (!key || seen.has(key)) continue
    seen.add(key)
    characters.push(character)
  }

  return { characters }
}

export function normalizeCharacterProfilePayload(payload, currentCharacter = {}) {
  const source = payload?.character && typeof payload.character === 'object' ? payload.character : payload
  return normalizeCharacter(source || {}, 0, currentCharacter)
}
