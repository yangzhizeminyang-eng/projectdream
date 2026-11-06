const NEGATIVE_PROMPT =
  '换脸、改变年龄、改变性别、第二个人、多人、半身裁切、缺失手脚、畸形手指、错误服装、文字、水印、Logo、低清晰度、过度模糊、重复角色'

function text(value) {
  return String(value ?? '').trim()
}

function firstValue(...values) {
  return values.map(text).find(Boolean) || ''
}

function sceneMatchesCharacter(scene, characterName) {
  const haystack = [
    scene?.title,
    scene?.summary,
    scene?.content,
    scene?.location,
  ]
    .map(text)
    .join(' ')
  return characterName && haystack.includes(characterName)
}

function formatScene(scene) {
  const no = scene?.sceneNo ?? scene?.scene_no ?? '?'
  const title = firstValue(scene?.title, '未命名场景')
  const location = firstValue(scene?.location, '地点未提供')
  const timeOfDay = firstValue(scene?.timeOfDay, scene?.time_of_day, '时间未提供')
  const summary = firstValue(scene?.summary, scene?.content)
  return `第${no}场《${title}》：${location}，${timeOfDay}${summary ? `；${summary.slice(0, 260)}` : ''}`
}

export function extractTemporalStates(scenes, characterName) {
  const states = []
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    if (!sceneMatchesCharacter(scene, characterName)) continue
    const source = [
      scene?.title,
      scene?.summary,
      scene?.content,
      scene?.timeOfDay,
      scene?.time_of_day,
    ].map(text).join(' ')
    const match = source.match(/(?:五年前|5年前|十八年前|18年前|童年|小时候|幼年|当前|现在|职场)/)
    if (match) {
      const label = match[0]
      if (!states.includes(label)) states.push(label)
    }
  }
  return states
}

export function buildTemporalVariantPrompt(basePrompt, stateLabel) {
  const state = text(stateLabel)
  if (!state) return text(basePrompt)
  return [
    text(basePrompt),
    `本资产时空状态：${state}`,
    '本状态的年龄呈现、固定服饰、鞋履、配饰和随身物件必须根据对应时空的剧本场景、人物身份与动作重新整理；不得沿用与该状态冲突的服饰。',
    '保持角色身份、脸部特征和发型可识别；本时空状态单独成组，不与其他年龄或时间状态合并。',
  ].filter(Boolean).join('\n')
}

export function buildScriptCharacterPrompt({ character = {}, scenes = [], projectVisualStyle = '' } = {}) {
  const name = firstValue(character.name, character.characterName, '未命名角色')
  const role = firstValue(character.role_tag, character.roleTag)
  const age = firstValue(character.age_group, character.ageGroup)
  const gender = firstValue(character.gender)
  const appearance = firstValue(character.appearance)
  const costume = firstValue(character.costume, character.costume_description, character.costumeDescription)
  const personality = firstValue(character.personality)
  const voiceStyle = firstValue(character.voice_style, character.voiceStyle)
  const matchedScenes = (Array.isArray(scenes) ? scenes : [])
    .filter((scene) => sceneMatchesCharacter(scene, name))
    .slice(0, 12)
  const temporalStates = extractTemporalStates(scenes, name)

  const lines = [
    `角色名：${name}`,
    role ? `叙事身份：${role}` : '叙事身份：未提供',
    age ? `年龄段：${age}` : '年龄段：未提供',
    gender ? `性别：${gender}` : '性别：未提供',
    appearance ? `固定外貌：${appearance}` : '固定外貌：未提供，等待人工补充',
    costume ? `固定服装与随身物件：${costume}` : '固定服装与随身物件：由 Agent 根据剧本场景、时代、身份和动作自动整理，生成前必须补齐',
    personality ? `性格与表演气质：${personality}` : '性格与表演气质：未提供',
    voiceStyle ? `声线参考：${voiceStyle}` : '声线参考：未提供，沿用角色音色绑定',
    projectVisualStyle ? `项目视觉风格：${projectVisualStyle}` : '项目视觉风格：未提供',
    matchedScenes.length
      ? `剧本出场场景：\n${matchedScenes.map(formatScene).join('\n')}`
      : '剧本出场场景：暂未匹配到包含该角色名的场景，不能凭空补写剧情事实',
    temporalStates.length
      ? `Agent 已识别时空状态：${temporalStates.join('、')}；每个状态单独排版为一组资产`
      : 'Agent 暂未识别多个时空状态；按当前状态生成默认资产组',
    '',
    '生成要求：',
    '先生成基础正面全身图，人工确认基础图后，再调用这张图生成三视图；两个阶段不能混为一次生成。',
    '生成一张正面全身单人基础图，也就是基础正面全身图：人物正面站立，完整露出头到脚，使用纯白背景、均匀柔光、无场景干扰；角色面部、发型、体态、固定服装、配饰和年龄感必须稳定可复现。',
    '基础图确认后再生成三视图，不能在基础图阶段直接输出三视图。',
    '如果剧本存在多个时空状态，先按状态拆成独立资产组；每组分别生成对应服饰、随身物件、年龄呈现和场景环境，不把不同状态混在一张图里。',
    '这张基础图将作为角色身份基准；后续三视图必须基于同一张基础图生成正面、左侧面、右侧面和背面，保持同一张脸、同一体态、同一服装和同一配饰。',
    '画面为竖屏资产参考图，背景简洁、光线均匀、人物完整不被裁切，不添加其他人物和无关道具。',
  ]

  return {
    prompt: lines.join('\n'),
    negativePrompt: NEGATIVE_PROMPT,
    source: 'script-agent',
    version: 'script-character-prompt-v1',
  }
}

export function buildScriptScenePrompt({ scene = {}, projectVisualStyle = '' } = {}) {
  const title = firstValue(scene.title, '未命名场景')
  const location = firstValue(scene.location, '地点未明确，须根据本场动作与剧情功能推断最小必要空间')
  const timeOfDay = firstValue(
    scene.timeOfDay,
    scene.time_of_day,
    '时间未明确，须根据剧情事件、光线需求和人物行动推断并标注为推断',
  )
  const screenplay = firstValue(
    scene.content,
    scene.summary,
    '剧本未提供完整场景说明，须依据本场标题、人物行动、关键事件和道具需求建立可执行的空间基准',
  )
  const visualStyle = text(projectVisualStyle)

  return [
    `场景：${title}`,
    `时空：${timeOfDay}`,
    `地点：${location}`,
    `剧情内容与功能：${screenplay.slice(0, 5000)}`,
    visualStyle ? `项目视觉风格：${visualStyle}` : '',
    'Agent 场景推理规则：先从本场人物行动、冲突、关键道具、出入路径和镜头需求推断最小可用空间；剧本没有明确的地点、时间或结构时必须写出推断依据和待确认项，不能只留空或使用示例占位。',
    '详细空间提示词必须写清：空间类型与功能、前后左右关系、中心轴、入口出口、门窗方向、固定建筑结构、主要道具与人物行动位置、距离层级、材质、地面、天花板、光线方向、色彩和镜头可见范围。',
    '场景锚点清单：固定建筑结构、空间尺度、出入口和门窗方向、主要物件位置、材质、光线方向、色彩关系、地面与天花板关系。',
    '空间布局必须可复核；不确定内容标记为待确认，但仍需给出服务于剧情和镜头的合理默认布局。',
    '先生成该时空下的一张完整空间全景基准图；确认后基于全景生成同一空间的严格 3×3 九宫格视角组。',
    '全景图是唯一空间母版；后续所有角度必须读取同一张全景图和同一份锚点清单，禁止因换角度新增、删除、移动建筑结构或关键道具。',
    '九宫格逐格提示：1左前方广角，2正前方中景，3右前方广角，4左侧面中景，5正中轴平视，6右侧面中景，7左后方广角，8正后方中景，9右后方广角；每格只改变摄像机位置、朝向和景别。',
    '九个画格必须保持同一空间的门窗、出入口、墙柱、桌椅、设备、材质、光线方向和色彩关系，禁止镜头切换导致布局漂移。',
    '场景状态由本段剧本自动归组；不同时间、地点或剧情状态必须使用独立场景组，不覆盖其它时空结果。',
    '画面只表现环境，不生成角色主体、字幕、文字或水印。',
  ].filter(Boolean).join('\n')
}

export function buildSceneEnvironmentPrompt({ scene = {}, projectVisualStyle = '' } = {}) {
  const title = firstValue(scene.title, '未命名场景')
  const location = firstValue(
    scene.location,
    '根据本场动作与关键道具推断的最小可用空间；若剧本未明确，默认建立能容纳全部动作的单一室内空间',
  )
  const timeOfDay = firstValue(
    scene.timeOfDay,
    scene.time_of_day,
    '根据剧本光线、声音和事件节奏推断的时间状态',
  )
  const screenplay = firstValue(scene.content, scene.summary, '')
  const style = text(projectVisualStyle)

  return [
    `环境资产场景：${title}`,
    `空间类型与功能：${location}`,
    `时间与光线状态：${timeOfDay}`,
    '只提取并锁定环境信息：建筑结构、空间尺度、前后左右关系、中心轴、入口出口、门窗方向、固定家具、固定设备、主要环境道具、地面、天花板、材质、光线方向、色彩关系和镜头可见范围。',
    `剧本环境证据：${screenplay.slice(0, 5000)}`,
    '环境布局推断规则：从剧本中的人物行动路径、关键道具、出入关系和镜头需求推断最小可用空间；不确定内容标记为推断，但仍给出可复核的默认布局。',
    '固定空间锚点：门窗与出入口方向、墙柱和隔断、沙发或桌椅、电脑工作区、固定设备、主要道具位置、地面与天花板关系、空间材质、主光线方向、辅助光线、色彩关系。',
    '这是空场环境资产提示词，不是角色提示词，不描述人物外貌、服装、表情、姿势或表演。',
    '不要生成任何人物、人物剪影、人物照片、遗像、脸、手、腿、人形、人体倒影、字幕、文字或水印。',
    style ? `项目视觉风格：${style}` : '',
  ].filter(Boolean).join('\n')
}

export { NEGATIVE_PROMPT }
