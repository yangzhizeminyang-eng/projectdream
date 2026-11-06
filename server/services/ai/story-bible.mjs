/**
 * @file 从创意生成「故事设定」（故事圣经）
 * @description
 * 创作首页输入创意 + 风格 + 集数后，先产出故事设定，再由人确认。
 * 这一步刻意**不写剧本**：先把人物小传（角色设定）钉死，剧本才有约束可依。
 *
 * 输出契约必须和 `story-quality.mjs` 的门禁字段严格对齐，否则生成完过不了门禁、
 * 用户还得手工补齐一堆字段。角色七项（name/role/goal/fear/secret/growthArc/
 * visualDescription）和「至少一名主角」都是门禁硬要求，见 CHARACTER_REQUIRED_FIELDS。
 */
import { generateStructuredJson } from './provider.mjs'
import { getAiConfig, isMockProvider } from './config.mjs'
import { buildGenrePromptContext } from './genre-skill-profile.mjs'

/** 与 story-quality 的 CHARACTER_REQUIRED_FIELDS 保持一致 */
const CHARACTER_FIELDS = [
  'name',
  'role',
  'goal',
  'fear',
  'secret',
  'growthArc',
  'visualDescription',
]

/** 列表字段，缺失一律补空数组，避免下游 `undefined.map` */
const LIST_FIELDS = [
  'worldRules',
  'timeline',
  'locations',
  'relationships',
  'props',
  'foreshadowing',
  'visualSymbols',
]

function text(value) {
  return value == null ? '' : String(value).trim()
}

/** 数组原样保留，字符串按中英文分隔符拆开——模型两种都可能给 */
function list(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => (item && typeof item === 'object' ? item : text(item)))
      .filter(Boolean)
  }
  if (typeof value === 'string') {
    return value
      .split(/[\n,，；;]/)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

export function buildStoryBiblePrompts(project = {}, { idea = '', episodeCount = 1 } = {}) {
  const projectName = text(project.name) || '未命名项目'
  const category = text(project.category) || '剧情'
  const visualStyle = text(project.visualStyle) || '电影感、写实、可视化明确'
  const aspectRatio = text(project.aspectRatio) || '9:16'
  const episodes = Math.max(1, Math.min(50, Number(episodeCount) || 1))
  const creatorIdea = text(idea) || '请根据项目信息自行补足一个完整的故事前提'
  const genreContext = buildGenrePromptContext(category)

  const systemPrompt = [
    '你是影视项目的故事总监。',
    '你的任务是把创作者的一句话创意，扩写成可以直接开拍的故事设定（故事圣经）。',
    '你必须只返回 JSON，不要输出解释、标题、Markdown、代码块。',
    '',
    '字段必须严格使用这些 key：',
    'title, logline, audience, emotionalPromise, worldRules, timeline, locations,',
    'characters, relationships, props, mainPlot, subplots, foreshadowing, visualSymbols。',
    '',
    '各字段要求：',
    '- title：作品名',
    '- logline：一句话故事，必须包含主角、困境与钩子',
    '- audience：目标观众画像',
    '- emotionalPromise：观众看这部作品要获得的情感体验',
    '- worldRules：世界观的硬性规则数组，每条一句话',
    '- timeline：故事时间线数组，按先后顺序',
    '- locations：主要场景地点数组，用可拍摄的地点名（如「县城医院病房」），不要写抽象概念',
    '- relationships：人物关系数组，每条写清「谁与谁是什么关系」',
    '- props：关键道具对象数组；不要只输出名称，每项必须按剧情定义 name、purpose、narrativeRole、owner、appearance、shape、material、color、dimensions、details、visualState、scriptEvidence、narrativeLabel。',
    '- 道具的 purpose/narrativeRole 说明它推动哪条剧情信息或人物选择；appearance/shape/material/details 描述可复用的实体身份；visualState 只记录能固定在道具本体上的剧情状态。',
    '- scriptEvidence 指明上述设计来自哪条剧本/创意事实；缺乏直接依据的补足必须写为“剧情推断：……”并说明依据，禁止把推断冒充事实或擅自指定品牌、型号、文字。',
    '- 道具母版虽为纯白背景单体展示，但外观必须是本剧专属、可辨认且服务剧情的设计，不得退化成无剧情特征的通用商品图；不得把人物、手、场景或某一镜头的构图/动作放进道具资产。',
    '- 带屏幕或文档的道具可以保留剧情需要的界面分区、空白标签位或无字抽象状态；未在剧本明确出现的文字、编号、签名一律留空，精确正文交由后期合成。',
    '- mainPlot：故事主线，一段完整叙述',
    '- subplots：支线数组',
    '- foreshadowing：伏笔数组，每条写明埋设与回收的落点',
    '- visualSymbols：视觉符号数组，用于统一画面气质',
    '',
    'characters 必须是数组，每项**必须**包含以下七个字段，缺一不可：',
    '- name：人物姓名',
    '- role：人物定位，**必须至少有一名角色的 role 里包含「主角」二字**',
    '- goal：他/她想要什么（外在目标）',
    '- fear：他/她害怕什么',
    '- secret：他/她隐瞒了什么',
    '- growthArc：从故事开始到结束的成长弧线',
    '- visualDescription：可拍摄的外貌与服装描述（发型、体型、常穿衣物、随身物件）',
    '',
    `这是一个 ${episodes} 集的作品，人物与主线要撑得住这个体量。`,
    genreContext,
    '所有内容必须具体、可视化、可拍摄。不要写「某某经历了一系列事件」这种空话。',
  ].join('\n')

  const userPrompt = [
    `项目名：${projectName}`,
    `作品类型：${category}`,
    `视觉方向：${visualStyle}`,
    `画面比例：${aspectRatio}`,
    `计划集数：${episodes} 集`,
    genreContext,
    '',
    '创作者的创意：',
    creatorIdea,
    '',
    '请生成完整的故事设定。角色请给 3 到 6 位，并确保其中至少一位的 role 含「主角」。',
  ].join('\n')

  return { systemPrompt, userPrompt }
}

function buildCoreStoryBiblePrompts(project, options) {
  const projectName = text(project.name) || '未命名项目'
  const category = text(project.category) || '剧情'
  const visualStyle = text(project.visualStyle) || '电影感、写实、可视化明确'
  const aspectRatio = text(project.aspectRatio) || '9:16'
  const episodes = Math.max(1, Math.min(50, Number(options.episodeCount) || 1))
  const idea = text(options.idea)
  const genreContext = buildGenrePromptContext(category)

  return {
    systemPrompt: [
      '你是影视项目的故事总监，只返回 JSON，不要解释、Markdown 或代码块。',
      '只能使用这些字段：title, logline, audience, emotionalPromise, characters, mainPlot, subplots。',
      'characters 必须是 3 到 5 个对象，每个对象必须包含 name, role, goal, fear, secret, growthArc, visualDescription。',
      '至少一名角色的 role 必须包含“主角”。所有内容具体、可视化、可拍摄。',
      genreContext,
    ].join('\n'),
    userPrompt: [
      `项目名：${projectName}`,
      `类型：${category}`,
      `视觉方向：${visualStyle}`,
      `画面比例：${aspectRatio}`,
      `计划集数：${episodes} 集`,
      `创作者创意：${idea}`,
      genreContext,
      '请生成核心故事设定，subplots 控制在 2 条以内。',
    ].join('\n'),
  }
}

function buildWorldStoryBiblePrompts(project, options, core) {
  const projectName = text(project.name) || '未命名项目'
  const visualStyle = text(project.visualStyle) || '电影感、写实、可视化明确'
  const idea = text(options.idea)
  const genreContext = buildGenrePromptContext(project.category)

  return {
    systemPrompt: [
      '你是影视项目的世界观与视觉设定总监，只返回 JSON，不要解释、Markdown 或代码块。',
      '只能使用这些字段：worldRules, timeline, locations, relationships, props, foreshadowing, visualSymbols。',
      '所有字段都必须是数组，每个数组给 2 到 4 条，内容具体、可拍摄，避免空泛形容词。',
      genreContext,
    ].join('\n'),
    userPrompt: [
      `项目名：${projectName}`,
      `视觉方向：${visualStyle}`,
      `创作者创意：${idea}`,
      genreContext,
      `已确定的核心故事：${JSON.stringify(core)}`,
      '请补齐世界观、时间线、场景、人物关系、关键道具、伏笔和视觉符号，不要重复完整人物小传。props 仍须按核心故事提示中的结构输出道具对象，并为每项补齐剧情功能、实体识别设计、可固化状态和事实/推断依据。',
    ].join('\n'),
  }
}

/**
 * 归一化模型返回的故事设定。
 * 模型偶尔会漏掉「主角」定位或把列表写成逗号串，这里就地修好，
 * 而不是把问题留给后面的质量门禁——那时用户已经不知道要改哪里了。
 */
export function normalizeGeneratedStoryBible(payload, project = {}) {
  const source = payload && typeof payload === 'object' ? payload : {}

  const characters = (Array.isArray(source.characters) ? source.characters : [])
    .map((item) => {
      const character = {}
      for (const field of CHARACTER_FIELDS) character[field] = text(item?.[field])
      return character
    })
    // 姓名和定位都没有的条目视为模型噪音，直接丢掉
    .filter((character) => character.name || character.role)

  const logline = text(source.logline)
  const mainPlot = text(source.mainPlot)

  // 三个核心字段全空说明这次生成没有可用产出，如实报错而不是存一份空设定
  if (!logline && !mainPlot && !characters.length) {
    throw new Error('模型没有返回可用的故事设定，请重试或补充更多创意细节')
  }

  if (characters.length && !characters.some((character) => character.role.includes('主角'))) {
    characters[0].role = characters[0].role ? `${characters[0].role} / 主角` : '主角'
  }

  const normalized = {
    title: text(source.title) || text(project.name) || '未命名项目',
    logline,
    audience: text(source.audience),
    emotionalPromise: text(source.emotionalPromise),
    characters,
    mainPlot,
    subplots: list(source.subplots),
  }

  for (const field of LIST_FIELDS) normalized[field] = list(source[field])

  return normalized
}

/**
 * 生成故事设定。
 * mock 模式下直接抛错而不是编一份假设定——创作者会拿它去生成剧本，
 * 假数据会一路污染到分镜和资产。
 */
export async function generateStoryBible(project, options = {}) {
  const config = getAiConfig()
  if (isMockProvider(config)) {
    throw new Error('当前为 mock 模式，不会真实调用模型生成故事设定')
  }

  // 长故事设定拆成两个真实模型请求，避免一次性输出过长触发上游网关断开。
  // 刻意不走 fallbackToMock：编一份假设定会被创作者当成真的拿去生成剧本。
  const corePrompts = buildCoreStoryBiblePrompts(project, options)
  const coreResult = await generateStructuredJson({
    task: 'story-bible',
    systemPrompt: corePrompts.systemPrompt,
    userPrompt: corePrompts.userPrompt,
    model: config.outlineModel || config.defaultModel,
    temperature: 0.6,
    // DeepSeek 的 reasoning token 会计入输出预算；留足空间避免七字段角色
    // 设定在 JSON 尚未闭合时被截断。
    maxTokens: 5200,
    thinking: { type: 'disabled' },
  })

  const core = normalizeGeneratedStoryBible(coreResult.json, project)
  const worldPrompts = buildWorldStoryBiblePrompts(project, options, core)
  const worldResult = await generateStructuredJson({
    task: 'story-bible',
    systemPrompt: worldPrompts.systemPrompt,
    userPrompt: worldPrompts.userPrompt,
    model: config.outlineModel || config.defaultModel,
    temperature: 0.5,
    maxTokens: 3200,
    thinking: { type: 'disabled' },
  })

  return normalizeGeneratedStoryBible({ ...core, ...worldResult.json }, project)
}
