export const SCENE_SPACE_MANIFEST_VERSION = 1

export const SCENE_SPACE_VIEW_KEYS = Object.freeze([
  'front-left', 'front', 'front-right', 'left', 'center', 'right', 'back-left', 'back', 'back-right',
])

const ANCHOR_CATEGORIES = new Set([
  'architecture',
  'opening',
  'fixed_furniture',
  'material',
  'light',
])

const STRUCTURAL_CATEGORIES = new Set(['architecture', 'opening', 'fixed_furniture'])

const EXPLICIT_FIXTURE_RULES = [
  { label: '传送窗口', category: 'fixed_furniture', pattern: /传送窗口|传递窗口|传物窗口/u },
  { label: '值班台', category: 'fixed_furniture', pattern: /值班台|服务台|接待台/u },
  { label: '监控回放设备', category: 'fixed_furniture', pattern: /监控回放区|监控回放设备|监控屏幕|监控终端/u },
  { label: '档案柜', category: 'fixed_furniture', pattern: /档案柜|文件柜/u },
  { label: '旧储物柜', category: 'fixed_furniture', pattern: /旧储物柜|储物柜/u },
  { label: '绿色安全出口灯', category: 'light', pattern: /绿色安全出口灯|安全出口灯|出口指示灯/u },
  { label: '台灯', category: 'light', pattern: /台灯/u },
]

function text(value) {
  return String(value ?? '').trim()
}

function sceneFixtureEvidence(scene = {}) {
  const content = text(scene?.content)
  const sections = [...content.matchAll(/【([^】]+)】([\s\S]*?)(?=【[^】]+】|$)/gu)]
  const scopedContent = sections.length ? sections[0][0] + sections[0][2] : content
  return [scene?.title, scene?.summary, scopedContent].map(text).filter(Boolean).join('\n')
}

function completeExplicitFixtureAnchors(manifest, scene = {}) {
  const evidence = sceneFixtureEvidence(scene)
  const requiredFixtures = EXPLICIT_FIXTURE_RULES.filter(({ pattern }) => pattern.test(evidence))
  const anchors = [...manifest.anchors]
  for (const fixture of requiredFixtures) {
    const exists = anchors.some((anchor) => anchor.category === fixture.category
      && (anchor.label.includes(fixture.label) || anchor.description.includes(fixture.label)))
    if (exists) continue

    const sourceClause = evidence
      .split(/[。！？\n；;]/u)
      .find((clause) => fixture.pattern.test(clause))
      ?.trim() || fixture.label
    let relativePosition = '剧本明确该设施属于本场空间，但未说明精确方位；按最小可拍摄布局推断其位置。'
    if (/台灯/u.test(fixture.label) && /右上方/u.test(sourceClause)) relativePosition = '值班台右上方（剧本明确）'
    else if (/安全出口灯/u.test(fixture.label) && /走廊.{0,8}尽头|尽头.{0,8}走廊/u.test(sourceClause)) relativePosition = '窗外走廊尽头（剧本明确）'
    else if (/值班台/u.test(fixture.label)) relativePosition = '夜班工作区中央（精确房间方位由场景标题及功能推断）'
    else if (/传送窗口/u.test(fixture.label)) relativePosition = '嵌于值班台工作面前沿，窗口下沿朝向台面（依据滑出方向推断）'

    const idBase = `FIXTURE-${String(EXPLICIT_FIXTURE_RULES.indexOf(fixture) + 1).padStart(2, '0')}`
    let id = idBase
    let suffix = 2
    while (anchors.some((anchor) => anchor.id === id)) id = `${idBase}-${suffix++}`
    const anchor = {
      id,
      category: fixture.category,
      label: fixture.label,
      description: fixture.category === 'light'
        ? `${fixture.label}作为本场实体光源；不增加未被剧本提及的灯具或无来源泛光。`
        : `${fixture.label}为本场固定设施；不包含发卡等可移动剧情道具，也不描述剧情动作。`,
      relative_position: relativePosition,
      evidence: `剧本明确写明：${sourceClause}`,
      origin: 'script',
      narrative_reason: fixture.category === 'light'
        ? `按剧本明确的实体灯具与位置形成局部照明；光线范围和衰减依据本场夜间空间关系控制。`
        : '',
    }
    anchors.push(anchor)
  }
  return anchors.length === manifest.anchors.length ? manifest : normalizeSceneSpaceManifest({
    ...manifest,
    anchors,
  })
}

function readObject(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      throw new Error('场景空间锚点必须是有效 JSON')
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

export function normalizeSceneSpaceManifest(value) {
  const source = readObject(value)
  if (!source || !Array.isArray(source.anchors)) {
    throw new Error('场景 Agent 未返回 spatial_anchors JSON')
  }

  const ids = new Set()
  const anchors = source.anchors.map((item) => {
    const id = text(item?.id)
    const category = text(item?.category)
    const anchor = {
      id,
      category,
      label: text(item?.label),
      description: text(item?.description),
      relative_position: text(item?.relative_position),
      evidence: text(item?.evidence),
      origin: text(item?.origin),
      narrative_reason: text(item?.narrative_reason),
    }
    if (!id || ids.has(id)) throw new Error(`场景空间锚点 ID 缺失或重复：${id || 'empty'}`)
    if (!ANCHOR_CATEGORIES.has(category)) throw new Error(`场景空间锚点类别无效：${category || 'empty'}`)
    if (!anchor.label || !anchor.description || !anchor.relative_position || !anchor.evidence) {
      throw new Error(`场景空间锚点 ${id} 缺少名称、描述、相对位置或剧情证据`)
    }
    if (!['script', 'inference'].includes(anchor.origin)) {
      throw new Error(`场景空间锚点 ${id} 必须标记来源为 script 或 inference`)
    }
    if (['material', 'light'].includes(category) && !anchor.narrative_reason) {
      throw new Error('材质和光源锚点必须说明剧情设计依据')
    }
    ids.add(id)
    return anchor
  })

  const categories = new Set(anchors.map((anchor) => anchor.category))
  if (!categories.has('material') || !categories.has('light')) {
    throw new Error('场景空间锚点必须包含根据剧情设计的 material 与 light')
  }

  const viewBindings = {}
  for (const key of SCENE_SPACE_VIEW_KEYS) {
    const boundIds = Array.isArray(source.view_bindings?.[key])
      ? [...new Set(source.view_bindings[key].map(text).filter(Boolean))]
      : []
    const structuralIds = boundIds.filter((id) => {
      const anchor = anchors.find((item) => item.id === id)
      return anchor && STRUCTURAL_CATEGORIES.has(anchor.category)
    })
    if (structuralIds.length < 2 || structuralIds.length !== boundIds.length) {
      throw new Error(`场景机位 ${key} 必须绑定至少两个有效空间锚点`)
    }
    viewBindings[key] = structuralIds
  }

  return {
    version: SCENE_SPACE_MANIFEST_VERSION,
    anchors,
    view_bindings: viewBindings,
  }
}

export function validateSceneSpaceManifestAgainstScene(value, scene = {}) {
  const manifest = normalizeSceneSpaceManifest(value)
  const evidence = sceneFixtureEvidence(scene)
  const requiredFixtures = EXPLICIT_FIXTURE_RULES.filter(({ pattern }) => pattern.test(evidence))
  const missingFixtures = requiredFixtures
    .filter(({ label, category }) => !manifest.anchors.some((anchor) =>
      anchor.category === category
      && (anchor.label.includes(label) || anchor.description.includes(label)),
    ))
    .map(({ label }) => label)
  return { passed: missingFixtures.length === 0, missingFixtures }
}

export function extractExplicitSceneFixtures(scene = {}) {
  const evidence = sceneFixtureEvidence(scene)
  return EXPLICIT_FIXTURE_RULES
    .filter(({ pattern }) => pattern.test(evidence))
    .map(({ label, category }) => ({ label, category }))
}

export async function resolveSceneSpaceManifest({ scene, extract, persist } = {}) {
  const existing = scene?.spatial_anchors ?? scene?.spatial_anchors_json ?? scene?.spatialAnchors
  let manifest = null
  let repairReason = ''
  if (existing) {
    try {
      const normalized = normalizeSceneSpaceManifest(existing)
      const report = validateSceneSpaceManifestAgainstScene(normalized, scene)
      if (report.passed) return normalized
      repairReason = `空间锚点遗漏剧本明确固定设施：${report.missingFixtures.join('、')}`
    } catch (error) {
      if (typeof extract !== 'function' || typeof persist !== 'function') throw error
      repairReason = error instanceof Error ? error.message : String(error)
    }
  }
  if (typeof extract !== 'function' || typeof persist !== 'function') {
    throw new Error('缺少场景空间锚点时，必须先完成 Agent 提取并持久化')
  }

  let lastError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const extracted = normalizeSceneSpaceManifest(await extract({
        ...scene,
        ...(repairReason ? { spatial_anchor_repair_reason: repairReason } : {}),
      }))
      const candidate = completeExplicitFixtureAnchors(extracted, scene)
      const report = validateSceneSpaceManifestAgainstScene(candidate, scene)
      if (!report.passed) throw new Error(`空间锚点遗漏剧本明确固定设施：${report.missingFixtures.join('、')}`)
      manifest = candidate
      break
    } catch (error) {
      lastError = error
      repairReason = error instanceof Error ? error.message : String(error)
    }
  }
  if (!manifest) throw lastError || new Error('场景空间锚点生成失败')
  await persist(manifest)
  return manifest
}

export function buildSceneSpaceAnchorPrompt({ scene = {} } = {}) {
  const title = text(scene.title) || '未命名场景'
  const location = text(scene.location) || '剧本未明确地点，请依据动作路径推断'
  const time = text(scene.time_of_day ?? scene.timeOfDay) || '依据剧情推断'
  const evidence = [scene.summary, scene.content].map(text).filter(Boolean).join('\n')

  return {
    systemPrompt: [
      '你是影视场景空间资产规划 Agent。只把剧本证据转换成可复用的空间锚点与拍摄光材质方案，不生成图片提示词，不补写剧情。',
      '严格返回 JSON 对象：{"spatial_anchors":{"version":1,"anchors":[{"id":"A1","category":"architecture|opening|fixed_furniture|material|light","label":"","description":"","relative_position":"","evidence":"","origin":"script|inference","narrative_reason":""}],"view_bindings":{"front-left":["A1","A2"],"front":["A1","A2"],"front-right":["A1","A2"],"left":["A1","A2"],"center":["A1","A2"],"right":["A1","A2"],"back-left":["A1","A2"],"back":["A1","A2"],"back-right":["A1","A2"]}}}。',
      'anchors 至少包含两个稳定的建筑、门窗或固定家具锚点，并包含至少一个 material 和一个 light 锚点。每个锚点写清相对位置、可见特征和剧情证据；origin=script 表示剧本明确，origin=inference 表示合理推断。不得伪称推断内容来自剧本。',
      '必须完整锚定本场剧本明确出现的固定设施、家具与实体灯具。设施即使出现在动作句中也不能漏掉：只提取静态设施本身作为空场锚点，不把人物、动作或可移动剧情道具写进空间资产。修复时必须补齐校验列出的设施。',
      '材质必须依据地点用途、角色长期使用痕迹、剧情道具接触方式和情绪质感设计；光源必须依据时间、天气、剧情氛围和可见灯具设计，写清实体光源、方向、色温/色彩、照射范围与衰减。material 与 light 都要用 narrative_reason 说明剧情设计依据。',
      '材质与光线不是全项目固定色板。不得机械套用审讯室、冷蓝环境光、暖黄台灯、红色警示灯等固定示例；没有剧情依据时选择克制、现实、符合地点功能的方案。禁止无来源全局色彩滤镜。',
      'view_bindings 的值只能是 anchors 中真实存在的 id，不能写名称或类别；九个固定机位都至少绑定两个 architecture/opening/fixed_furniture ID，按相对位置和墙体遮挡判断可见性，material/light ID 不可绑定为画面参照。',
      scene?.spatial_anchor_repair_reason
        ? `上次输出未通过程序校验：${text(scene.spatial_anchor_repair_reason)}。请先修正该错误，再返回完整 JSON。`
        : '',
      '空间无法从剧本确定时，给出最小合理推断并标记 origin=inference；不要为凑锚点虚构复杂建筑或剧情道具。',
    ].join('\n'),
    userPrompt: [
      `场景：${title}`,
      `地点：${location}`,
      `时间：${time}`,
      `上次校验缺失的固定设施：${text(scene?.spatial_anchor_repair_reason) || '无'}`,
      '场景剧情证据：',
      evidence || '剧本未提供具体空间细节，请只推断容纳该场戏所需的最小空间。',
      '',
      '请输出可持久化、供全景和九视角共同引用的 spatial_anchors。材质和光线要服务本场剧情，不沿用其它场景模板。',
    ].join('\n'),
  }
}
