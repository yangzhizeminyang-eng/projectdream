const ENTITY_PATTERNS = [
  ['广播机', /广播机|广播控制台/],
  ['扬声器', /扬声器|喇叭|网罩/],
  ['红灯', /红灯|红色指示灯/],
  ['控制台', /控制台|面板/],
  ['总闸', /总闸/],
  ['测试笔', /测试笔/],
  ['导线', /导线|线槽|电缆/],
  ['电压读数', /电压|读数|仪表/],
  ['检修包', /检修包|工具包/],
  ['头灯', /头灯/],
  ['工牌', /工牌/],
  ['绝缘手套', /绝缘手套|手套/],
  ['隧道', /隧道|站台/],
]
const REVEAL_ENTITY_NAMES = new Set([
  '广播机',
  '扬声器',
  '控制台',
  '总闸',
  '测试笔',
  '导线',
  '电压读数',
])

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function unique(values) {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))]
}

function sourceText(shot = {}) {
  return [
    shot.action_text,
    shot.actionText,
    shot.dialogue_text,
    shot.dialogueText,
    shot.visual_prompt,
    shot.visualPrompt,
    shot.start_visual_prompt,
    shot.startVisualPrompt,
    shot.end_visual_prompt,
    shot.endVisualPrompt,
  ]
    .map(text)
    .filter(Boolean)
    .join(' ')
}

function visibleText(shot = {}) {
  return [shot.visual_prompt, shot.visualPrompt].map(text).filter(Boolean).join(' ')
}

function inferEntities(shot = {}, useAllText = false) {
  const source = useAllText ? sourceText(shot) : visibleText(shot)
  return ENTITY_PATTERNS.filter(([, pattern]) => pattern.test(source)).map(([name]) => name)
}

function primarySubject(shot = {}, visibleEntities = []) {
  const characterName = text(shot.character_name || shot.characterName)
  if (characterName) return characterName
  if (visibleEntities.includes('广播机') || visibleEntities.includes('扬声器')) {
    return '广播设备'
  }
  return text(shot.shot_type || shot.shotType) || '当前画面主体'
}

function buildForeshadowPrompt(entities, previousShot = {}, currentShot = {}) {
  if (!entities.length) return ''
  const previousCharacter = text(previousShot.character_name || previousShot.characterName)
  const currentType = text(currentShot.shot_type || currentShot.shotType)
  if (entities.includes('广播机') && previousCharacter) {
    return `${previousCharacter}先用视线锁定画外广播机，手部向画面外靠近后停住；本镜头不完整展示广播机主体，下一镜再揭示。`
  }
  return `上一镜头必须先用动作或视线预告${entities.join('、')}，本镜头不应让这些主体无铺垫地突然出现。`
    + (currentType ? `下一镜头类型为${currentType}。` : '')
}

function readContractOverrides(shot = {}) {
  const raw = shot.continuity_contract_json || shot.continuityContract
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(String(raw))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function buildSceneContinuityContracts(shots = []) {
  const ordered = [...(Array.isArray(shots) ? shots : [])].sort(
    (a, b) => Number(a.sort_order ?? a.sortOrder ?? 0) - Number(b.sort_order ?? b.sortOrder ?? 0),
  )
  const contracts = ordered.map((shot, index) => {
    const previousShot = ordered[index - 1] || null
    const overrides = readContractOverrides(shot)
    const visibleEntities = unique([
      ...inferEntities(shot),
      ...(Array.isArray(overrides.visibleEntities) ? overrides.visibleEntities : []),
    ])
    const referencedEntities = unique([
      ...inferEntities(shot, true),
      ...(Array.isArray(overrides.referencedEntities) ? overrides.referencedEntities : []),
    ])
    const previousVisibleEntities = previousShot
      ? unique([
          ...inferEntities(previousShot),
          ...(Array.isArray(readContractOverrides(previousShot).visibleEntities)
            ? readContractOverrides(previousShot).visibleEntities
            : []),
        ])
      : []
    const revealEntities = previousShot
      ? unique(
          visibleEntities.filter(
            (entity) =>
              REVEAL_ENTITY_NAMES.has(entity) && !previousVisibleEntities.includes(entity),
          ),
        )
      : []
    const primaryAction =
      text(overrides.primaryAction) ||
      text(shot.action_text || shot.actionText) ||
      '保持当前画面主体的单一动作连续完成'

    return {
      version: 'continuity-contract-v1',
      storyboardId: Number(shot.id || shot.storyboardId) || null,
      sceneId: Number(shot.scene_id || shot.sceneId) || null,
      shotNo: text(shot.shot_no || shot.shotNo) || null,
      primarySubject: text(overrides.primarySubject) || primarySubject(shot, visibleEntities),
      primaryAction,
      visibleEntities,
      referencedEntities,
      forbiddenEntities: unique([
        '未声明人物',
        '未声明道具',
        '英文对白或字幕',
        ...(Array.isArray(overrides.forbiddenEntities) ? overrides.forbiddenEntities : []),
      ]),
      transitionFromPrevious: previousShot ? 'continuity' : 'establish',
      reveal: {
        entities: revealEntities,
        requiresForeshadow: revealEntities.length > 0,
        sourceShotId: previousShot ? Number(previousShot.id) || null : null,
      },
      nextShotForeshadow: {
        entities: [],
        prompt: '',
      },
      source: 'storyboard-and-neighbor-snapshots',
    }
  })

  for (let index = 0; index < contracts.length - 1; index += 1) {
    const current = contracts[index]
    const next = contracts[index + 1]
    if (!next.reveal.entities.length) continue
    current.nextShotForeshadow = {
      entities: next.reveal.entities,
      prompt: buildForeshadowPrompt(
        next.reveal.entities,
        ordered[index],
        ordered[index + 1],
      ),
    }
  }

  return contracts
}

export function validateSceneContinuityContracts(contracts = []) {
  const errors = []
  const items = Array.isArray(contracts) ? contracts : []
  for (const contract of items) {
    if (!text(contract.primaryAction)) {
      errors.push(`镜头 ${contract.shotNo || contract.storyboardId || 'unknown'} 缺少唯一主动作`)
    }
    if (
      contract.reveal?.requiresForeshadow &&
      !contract.reveal.entities.every((entity) =>
        items.some((previous) =>
          Number(previous.storyboardId) === Number(contract.reveal.sourceShotId) &&
          previous.nextShotForeshadow?.entities?.includes(entity),
        ),
      )
    ) {
      errors.push(
        `镜头 ${contract.shotNo || contract.storyboardId || 'unknown'} 揭示了未被上一镜预告的内容：${contract.reveal.entities.join('、')}`,
      )
    }
  }
  return {
    valid: errors.length === 0,
    errors,
  }
}

export function selectShotContinuityContract(contracts = [], storyboardId) {
  const targetId = Number(storyboardId)
  if (!Number.isSafeInteger(targetId) || targetId <= 0) return null
  return (
    (Array.isArray(contracts) ? contracts : [])
      .find((contract) => Number(contract.storyboardId) === targetId) || null
  )
}

export function buildShotContinuityPrompt(contract = {}) {
  const visibleEntities = unique(contract.visibleEntities)
  const forbiddenEntities = unique(contract.forbiddenEntities)
  const revealEntities = unique(contract.reveal?.entities)
  const parts = [
    '【镜头连续性契约】',
    `本镜头唯一主主体：${text(contract.primarySubject) || '当前画面主体'}`,
    `本镜头唯一主动作：${text(contract.primaryAction) || '保持当前动作连续完成'}`,
    `本镜头允许看见：${visibleEntities.length ? visibleEntities.join('、') : '仅当前已确认静帧中的主体和环境'}`,
    `本镜头禁止出现：${forbiddenEntities.join('、')}`,
    '不得新增未声明道具，不得新增人物，不得改变已确认角色的脸型、发型、服装、体态或固定随身物件。',
    '不得添加未写入对白的声音、数字、英文对白、英文字幕或随机播报。',
    contract.nextShotForeshadow?.prompt
      ? `下一镜揭示预告：${contract.nextShotForeshadow.prompt}`
      : '',
    revealEntities.length
      ? `本镜头只允许按预告揭示：${revealEntities.join('、')}。`
      : '本镜头不允许引入新的可见主体或道具。',
  ]
  return parts.filter(Boolean).join('\n')
}
