/**
 * Deterministic genre skill profiles used by every narrative and visual agent.
 * These are local, auditable prompt rules rather than untrusted runtime code.
 */
const PROFILES = Object.freeze({
  mystery: {
    key: 'mystery',
    label: '悬疑推理',
    visual: '现实材质、低照度局部光源、冷暖信息差、可追踪的空间锚点',
    composition: '用遮挡、前后景、留白和视线方向制造信息差；线索必须有可复核的画面位置',
    performance: '保留停顿、迟疑、压低声音和微表情，反转前不提前解释答案',
    continuity: '道具、门窗、屏幕、光线方向和人物站位在镜头之间保持可追踪',
    forbidden: '禁止无因果的炫技运镜、凭空新增线索、把氛围词当成剧情信息',
  },
  urban: {
    key: 'urban',
    label: '都市情感',
    visual: '生活化真实空间、自然肤色、可见材质磨损和克制的环境光',
    composition: '用人物距离、视线和空间阻隔表达关系变化，避免摆拍式对称',
    performance: '重视呼吸、停顿、未说出口的反应和细小动作',
    continuity: '服装、手机、杯子、文件和人物相对距离必须连续',
    forbidden: '禁止悬浮道具、塑料皮肤、无生活痕迹的样板间和过度滤镜',
  },
  fantasy: {
    key: 'fantasy',
    label: '古风玄幻',
    visual: '东方建筑、真实织物纹样、自然烟尘和有来源的法术光效',
    composition: '用门廊、台阶、屏风和远近层级组织世界规则与人物关系',
    performance: '动作遵守身份礼法和力量等级，情绪通过姿态与节奏递进',
    continuity: '服饰纹样、兵器、建筑朝向、光源和法术颜色必须锁定',
    forbidden: '禁止现代建筑零件、无来源的霓虹光、纹样漂移和时代混杂',
  },
  sciFi: {
    key: 'sciFi',
    label: '科幻剧情',
    visual: '工业材质、设备尺度、真实反射、冷光与警示色的功能性对比',
    composition: '用设备、门禁、屏幕和空间尺度表达规则，不用泛化的未来感代替细节',
    performance: '人物动作要与设备反馈和风险节拍同步，关键操作必须可见',
    continuity: '设备接口、线缆、门窗、警示灯、屏幕位置和光线方向保持一致',
    forbidden: '禁止随机科技面板、无功能的发光线条、游戏场景感和镜像布局',
  },
  adventure: {
    key: 'adventure',
    label: '热血冒险',
    visual: '真实环境阻力、清楚的动作方向、动态但可信的自然光',
    composition: '先建立目标和路径，再用景别变化强调动作结果与代价',
    performance: '动作前有准备，动作中有受力，动作后有反应，不跳帧式瞬移',
    continuity: '伤痕、装备、方向、地形和动作起止姿态连续',
    forbidden: '禁止没有空间依据的飞跃、装备瞬移、动作方向反转',
  },
  comedy: {
    key: 'comedy',
    label: '轻喜反转',
    visual: '明确信息层级、自然生活色彩和略快的反应节奏',
    composition: '让观众先看见误会来源，再看见角色反应，反转信息不能被构图遮住',
    performance: '重视反应镜头、停顿和节奏错位，台词与口型长度保持真实',
    continuity: '笑点道具和人物视线在前后镜头中保持位置稳定',
    forbidden: '禁止用夸张变形代替表演、无铺垫反转和随机表情',
  },
  growth: {
    key: 'growth',
    label: '成长逆袭',
    visual: '通过服装、环境层级、光线和姿态表现阶段变化',
    composition: '前期保留压迫空间，后期逐步增加主体空间与视线高度',
    performance: '每次选择都留下身体和情绪后果，胜利不能跳过代价',
    continuity: '阶段性服装、道具、伤痕和空间进出轨迹必须有记录',
    forbidden: '禁止突然变强、服装无因果变化和无来源的情绪切换',
  },
  dual: {
    key: 'dual',
    label: '双强关系',
    visual: '平衡的空间重量、清楚的视线轴和克制的光影对峙',
    composition: '用对称或反对称构图表达势均力敌，保持双方都可读',
    performance: '双方都有主动动作和反应，不把一方写成纯粹背景',
    continuity: '对峙轴线、人物距离、视线方向和道具归属保持连续',
    forbidden: '禁止无理由的角色降智、站位跳变和单方面抢镜',
  },
})

const CATEGORY_MAP = [
  ['悬疑', 'mystery'], ['推理', 'mystery'],
  ['都市情感', 'urban'], ['情感', 'urban'],
  ['古风', 'fantasy'], ['玄幻', 'fantasy'],
  ['科幻', 'sciFi'],
  ['热血', 'adventure'], ['冒险', 'adventure'],
  ['轻喜', 'comedy'], ['反转', 'comedy'],
  ['成长', 'growth'], ['逆袭', 'growth'],
  ['双强', 'dual'],
]

function text(value) {
  return String(value ?? '').trim()
}

export function resolveGenreSkillProfile(category = '') {
  const source = text(category)
  const key = CATEGORY_MAP.find(([needle]) => source.includes(needle))?.[1] || 'mystery'
  return PROFILES[key]
}

export function buildGenrePromptContext(category = '', scope = '') {
  const profile = resolveGenreSkillProfile(category)
  const normalizedScope = String(scope || '').trim()
  const scopeRule = {
    character: '资产范围：只输出角色外貌、发型、妆容、身体、服装和配饰的可复现规则；不得把场景、台词或镜头事件写入角色资产。',
    scene: '资产范围：只输出空场空间、建筑、固定物件、材质、光源、色彩和机位规则；不得把人物外貌、服装、动作或对白写入场景资产。',
    prop: '资产范围：只输出道具结构、材质、尺寸、使用痕迹和多视角规则；不得把角色或完整场景写入道具资产。',
    storyboard: '分镜范围：仅在单镜头确有需要时组合角色、场景和道具资产，并保持@引用、情绪表演和时空连续。',
  }[normalizedScope] || ''
  return [
    `题材技能配置：${profile.label}（profile=${profile.key}）`,
    `视觉叙事规则：${profile.visual}`,
    `构图规则：${profile.composition}`,
    `表演节奏规则：${profile.performance}`,
    `连续性规则：${profile.continuity}`,
    `禁止事项：${profile.forbidden}`,
    scopeRule,
  ].join('\n')
}

export { PROFILES as GENRE_SKILL_PROFILES }
