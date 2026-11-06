function normalizePromptPart(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

const UNIFIED_STORYBOARD_SECTION = /(?:^|\n\n)(?:画面与资产|动作与表演|对白与声音|起始帧衔接|结束帧衔接)：/
const COMPACT_SHOT_SHEET = /(?:^|[；;\n])时间轴：[\s\S]*?(?:^|[；;\n])镜头：[\s\S]*?(?:^|[；;\n])位置：[\s\S]*?(?:^|[；;\n])动作：[\s\S]*?(?:^|[；;\n])要求：/u

export function hasUnifiedStoryboardPrompt(prompt) {
  const value = String(prompt || '').trim()
  return UNIFIED_STORYBOARD_SECTION.test(value) || COMPACT_SHOT_SHEET.test(value)
}

export function buildStoryboardVideoPromptParts({
  prompt = '',
  contextParts = [],
  legacyFieldParts = [],
} = {}) {
  return [
    prompt,
    ...contextParts,
    ...(hasUnifiedStoryboardPrompt(prompt) ? [] : legacyFieldParts),
  ].filter((part) => String(part || '').trim())
}

export function buildVideoReferenceImageGuide(assetRows = [], transitionImageCount = 0) {
  const lines = (Array.isArray(assetRows) ? assetRows : []).map((asset, index) => {
    const kind = String(asset?.node_type || '').trim()
    const name = normalizePromptPart(asset?.label) || '未命名资产'
    const version = Number(asset?.version_no ?? asset?.versionNo)
    const versionLabel = Number.isInteger(version) && version > 0 ? `版本${version}` : '当前已确认版本'
    const scope = kind === 'character'
      ? `角色「${name}」${versionLabel}服装锁定：只锁定身份、外貌、服装结构和配饰，不限定本镜动作。${normalizePromptPart(asset?.costume) ? `服装基准：${normalizePromptPart(asset.costume)}。` : ''}`
      : kind === 'scene'
        ? `场景「${name}」${asset?.view_key || asset?.viewKey ? `视角${normalizePromptPart(asset.view_key || asset.viewKey)}` : ''}：只锁定空间拓扑、前中后景、固定设施、材质和光线，不把参考图构图当作本镜首帧。`
        : `道具「${name}」：只锁定道具外观与材质，不代表本镜初始位置；位置和移动以本镜动作与时间轴为准。`
    return `参考图${index + 1}（${kind === 'character' ? '角色' : kind === 'scene' ? '场景' : '道具'}）：${scope}`
  })
  if (Number(transitionImageCount) > 0) {
    lines.push(`其后${Math.floor(Number(transitionImageCount))}张为镜头首尾状态参考，只约束对应时刻的构图与状态；中间动作必须按时间轴连续完成。`)
  }
  lines.push('空间交互：写清主体前后景遮挡、手与道具的接触点及移动路径；身体、道具与固定设施不得互相穿插。')
  return lines.join('\n')
}

export function buildPerformanceVideoPrompt({
  basePrompt = '',
  actionText = '',
  actingBeat = '',
  startVisualPrompt = '',
  endVisualPrompt = '',
  continuityContract = null,
} = {}) {
  const parts = [
    normalizePromptPart(basePrompt),
    normalizePromptPart(actionText) ? `动作过程：${normalizePromptPart(actionText)}` : '',
    normalizePromptPart(actingBeat) ? `表演节拍：${normalizePromptPart(actingBeat)}` : '',
    normalizePromptPart(startVisualPrompt)
      ? `起始状态：${normalizePromptPart(startVisualPrompt)}`
      : '',
    normalizePromptPart(endVisualPrompt)
      ? `结束状态：${normalizePromptPart(endVisualPrompt)}`
      : '',
    '本镜只演完一个主事件；动作过程必须有清楚的可见变化和结果，按镜头时长留出动作完成与结尾停顿，不把多个连续剧情事件挤在同一镜。视线变化必须落到明确的画内目标。',
    '从起始状态连续完成动作，动作要有清晰的开始、过程和结束，角色的眼神、手部、肩颈和呼吸要随情绪变化自然推进。',
    '不要静止摆拍，不要只做背景平移，不要跳切，不要突然改变人物姿态、脸型、服装或空间位置。',
    continuityContract
      ? buildContinuityContractPrompt(continuityContract)
      : '',
  ]

  return parts.filter(Boolean).join(' ')
}

export function buildStoryboardDirectionPrompt({ gazePlan = null, soundPlan = null } = {}) {
  const gaze = gazePlan && typeof gazePlan === 'object' ? gazePlan : null
  const sound = soundPlan && typeof soundPlan === 'object' ? soundPlan : null
  const transitions = Array.isArray(gaze?.transitions)
    ? gaze.transitions.filter((item) => item && item.target)
    : []
  const gazeLines = transitions.map((item) => {
    const start = Number(item.fromSecond)
    const end = Number(item.toSecond)
    const range = Number.isFinite(start) && Number.isFinite(end) && end > start
      ? `${start}-${end}秒`
      : `约${Number.isFinite(start) ? start : 0}秒`
    return `${range}视线落到${item.target}${item.observable ? `（${item.observable}）` : ''}`
  })
  const cueLines = Array.isArray(sound?.cues)
    ? sound.cues.filter((item) => item && item.sound).map((item) => {
      const at = Number(item.atSecond)
      const timing = Number.isFinite(at) ? `${at}秒` : '动作发生时'
      return `${timing}${item.sound}${item.syncAction ? `，与${item.syncAction}同步` : ''}`
    })
    : []
  return [
    gaze ? `【视线执行合同】${gaze.startTarget ? `起始注视${gaze.startTarget}；` : ''}${gazeLines.join('；') || gaze.promptText || '保持当前目标稳定'}；${gaze.eyeLead || '眼睛先动，头部延迟半拍跟随'}；结束锁定${gaze.endTarget || '动作结果'}` : '',
    sound ? `【声音执行合同】从0秒到镜头结束保持${sound.bed || '连续空间底噪'}；${cueLines.join('；') || sound.promptText || '动作拟音与画面同步'}；${sound.silencePolicy || '无对白不等于无声'}` : '',
  ].filter(Boolean).join('\n')
}

function buildContinuityContractPrompt(contract) {
  const visibleEntities = Array.isArray(contract.visibleEntities)
    ? contract.visibleEntities.filter(Boolean).join('、')
    : ''
  const forbiddenEntities = Array.isArray(contract.forbiddenEntities)
    ? contract.forbiddenEntities.filter(Boolean).join('、')
    : ''
  const revealEntities = Array.isArray(contract.nextShotForeshadow?.entities)
    ? contract.nextShotForeshadow.entities.filter(Boolean).join('、')
    : ''
  return [
    '【镜头连续性契约】',
    `本镜头唯一主主体：${contract.primarySubject || '当前画面主体'}`,
    `本镜头唯一主动作：${contract.primaryAction || '保持当前动作连续完成'}`,
    `本镜头允许看见：${visibleEntities || '仅当前已确认静帧中的主体和环境'}`,
    `本镜头禁止出现：${forbiddenEntities || '未声明人物、未声明道具、英文对白或字幕'}`,
    '不得新增未声明道具，不得新增人物，不得添加未写入对白的声音、数字、英文对白或英文字幕。',
    revealEntities
      ? `下一镜揭示预告：${contract.nextShotForeshadow.prompt || revealEntities}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function withVideoGenerationProjectId(request, projectId) {
  const id = Number(projectId)
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('invalid video generation project id')
  }

  return {
    ...request,
    projectId: id,
  }
}
