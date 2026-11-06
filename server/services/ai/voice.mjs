import { generateStructuredJson } from './provider.mjs'

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function list(value) {
  return (Array.isArray(value) ? value : [])
    .map(text)
    .filter(Boolean)
    .slice(0, 12)
}

function limitUtf8(value, maxBytes) {
  const source = text(value)
  if (typeof TextEncoder === 'undefined') return source.slice(0, Math.floor(maxBytes / 2))
  const encoder = new TextEncoder()
  if (encoder.encode(source).length <= maxBytes) return source
  let output = ''
  for (const char of Array.from(source)) {
    const next = `${output}${char}`
    if (encoder.encode(next).length > maxBytes) break
    output = next
  }
  return output.trim()
}

export function normalizeVoiceDesign(value = {}) {
  return {
    name: text(value.name) || '未命名角色声线',
    summary: text(value.summary) || '根据角色身份与剧情压力设计的自然中文表演声线。',
    timbre: text(value.timbre),
    ageAndGender: text(value.age_and_gender ?? value.ageAndGender),
    emotionArc: text(value.emotion_arc ?? value.emotionArc),
    rhythm: text(value.rhythm),
    breathingAndPauses: text(value.breathing_and_pauses ?? value.breathingAndPauses),
    performanceInstructions: text(
      value.performance_instructions ?? value.performanceInstructions,
    ),
    avoid: list(value.avoid),
    sampleText: text(value.sample_text ?? value.sampleText),
    generationSource: text(value.generation_source ?? value.generationSource) || 'agent',
  }
}

export function resolvePersistedCustomVoiceDesign(character = {}, requestedVoiceId = '') {
  const raw = character.voice_design_json ?? character.voiceDesign
  let design = raw
  if (typeof raw === 'string') {
    try { design = JSON.parse(raw) } catch { design = null }
  }
  const voiceId = text(requestedVoiceId)
  if (
    design?.provider !== 'qwen'
    || !voiceId
    || text(design.voiceId) !== voiceId
    || text(character.voice_setting ?? character.voiceSetting) !== voiceId
    || !text(design.targetModel)
  ) return null
  return {
    ...design,
    ...normalizeVoiceDesign(design),
    provider: text(design.provider),
    voiceId,
    targetModel: text(design.targetModel),
  }
}

export function buildRuleBasedVoiceDesign({ character = {}, sampleText = '' } = {}) {
  const gender = text(character.gender).toLowerCase()
  const genderLabel = gender === 'male' ? '男性' : gender === 'female' ? '女性' : '中性'
  const ageGroup = text(character.ageGroup ?? character.age_group)
  const ageLabel = ({
    child: '儿童',
    teen: '青少年',
    young_adult: '青年',
    middle_aged: '中年',
    senior: '老年',
  })[ageGroup] || '成年'
  const style = text(character.voiceStyle ?? character.voice_style)
  const personality = text(character.personality)
  const role = text(character.roleTag ?? character.role_tag)
  const baseStyle = style || '语速适中，吐字清晰，情绪克制'
  return normalizeVoiceDesign({
    name: `${text(character.name) || '角色'}·规则声线设计`,
    summary: `依据角色的${ageLabel}${genderLabel}设定${role ? `与${role}身份` : ''}生成基础声线，并保留剧情要求的表演气质。`,
    timbre: `${ageLabel}${genderLabel}，普通话自然清晰；音色和发声方式遵循角色设定：${baseStyle}。`,
    age_and_gender: `${ageLabel}${genderLabel}声线，必须与角色结构化性别和年龄设定一致。`,
    emotion_arc: personality ? `表演情绪服从角色性格：${personality.slice(0, 180)}` : '情绪随台词语义变化，保持角色身份稳定。',
    rhythm: baseStyle,
    breathing_and_pauses: '在施压或犹豫处使用短停顿和克制换气，不吞字，不用夸张喘息。',
    performance_instructions: `使用${ageLabel}${genderLabel}声线；${baseStyle}；根据当前台词语义控制重音和句尾，不模仿真实人物。`,
    avoid: [
      gender === 'male' ? '女性、少女或甜美客服声线' : '',
      gender === 'female' ? '男性、少年或粗哑男低音' : '',
      '与年龄不符的声线、夸张播音腔、无依据的方言、失控咆哮、机械念稿',
    ].filter(Boolean),
    sample_text: text(sampleText),
    generation_source: 'rules_fallback',
  })
}

export function buildVoicePerformanceInstructions({
  design = {},
  characterName = '',
  sceneContext = '',
  dialogueText = '',
} = {}) {
  const normalized = normalizeVoiceDesign(design)
  return limitUtf8([
    normalized.performanceInstructions,
    normalized.timbre ? `音色质地：${normalized.timbre}` : '',
    normalized.ageAndGender ? `年龄与性别感：${normalized.ageAndGender}` : '',
    normalized.emotionArc ? `情绪弧线：${normalized.emotionArc}` : '',
    normalized.rhythm ? `节奏与重音：${normalized.rhythm}` : '',
    normalized.breathingAndPauses ? `呼吸与停顿：${normalized.breathingAndPauses}` : '',
    characterName ? `说话人：${text(characterName)}` : '',
    sceneContext ? `当前场景：${text(sceneContext)}` : '',
    dialogueText ? `当前台词：${text(dialogueText)}` : '',
    normalized.avoid.length ? `必须避免：${normalized.avoid.join('、')}` : '',
  ]
    .filter(Boolean)
    .join('；'), 1100)
}

export function buildVoicePreviewText({ characterName = '', sampleText = '', sceneTitle = '' } = {}) {
  // 角色名和场景名只用于生成上下文，不能混进真正要朗读的台词。
  return text(sampleText) || '我知道你在说什么，但我现在必须先确认事实。'
}

export async function generateVoiceDesign({
  project = {},
  character = {},
  scenes = [],
  sampleText = '',
} = {}) {
  let result
  try {
    result = await generateStructuredJson({
    task: 'voice-agent',
    longTask: true,
    temperature: 0.55,
    systemPrompt: [
      '你是 AI 漫剧的声音导演 Agent，不是普通的音色推荐器。',
      '根据项目风格、人物身份、性格、剧情冲突、出场场景和示例台词，设计一个可实际试听的中文角色声线。',
      '重点写真实表演：音色质地、年龄与性别感、情绪弧线、语速、重音、呼吸、停顿和台词中的心理变化。',
      '不要把“低沉、温柔、自然”三个词当作完整答案，必须说明它们在本角色和具体剧情中的可听表现。',
      '不得改变角色身份，不得加入与剧情无关的口音、二次元腔、播音腔或夸张拟声。',
      '只返回 JSON，不要 Markdown，不要解释 JSON 之外的内容。',
    ].join('\n'),
    userPrompt: JSON.stringify({
      输出格式: {
        name: '简短的声线方案名',
        summary: '一句话概括声音如何服务这个角色和剧情',
        timbre: '音色质地、音高、厚薄、明暗、颗粒感',
        age_and_gender: '年龄感与性别感，必须和角色设定一致',
        emotion_arc: '本集从开场到关键冲突的情绪变化和声音变化',
        rhythm: '语速、句间节奏、重音和收尾方式',
        breathing_and_pauses: '呼吸、停顿、压抑或失控前的细节',
        performance_instructions: '供真实 TTS 使用的完整中文表演指令',
        avoid: ['需要避免的错误表演'],
        sample_text: '适合试听的一小段中文台词',
      },
      项目: {
        name: text(project.name),
        category: text(project.category),
        visualStyle: text(project.visualStyle),
        narrativeVision: text(project.narrativeVision),
      },
      角色: {
        name: text(character.name),
        roleTag: text(character.roleTag ?? character.role_tag),
        personality: text(character.personality),
        appearance: text(character.appearance),
        ageGroup: text(character.ageGroup ?? character.age_group),
        gender: text(character.gender),
        existingVoiceStyle: text(character.voiceStyle ?? character.voice_style),
      },
      剧情场景: (Array.isArray(scenes) ? scenes : []).slice(0, 20).map((scene) => ({
        sceneNo: scene.scene_no ?? scene.sceneNo,
        title: text(scene.title),
        summary: text(scene.summary),
        content: text(scene.content).slice(0, 1800),
        mood: text(scene.mood),
        location: text(scene.location),
        timeOfDay: text(scene.time_of_day ?? scene.timeOfDay),
      })),
      示例台词: text(sampleText),
    }),
    })
  } catch (error) {
    const detail = String(error?.detail || error?.message || '').toLowerCase()
    if (!/insufficient account balance|insufficient balance|余额不足/.test(detail)) throw error
    return buildRuleBasedVoiceDesign({ character, sampleText })
  }

  return normalizeVoiceDesign(result.json || {})
}
