/**
 * 道具资产 Agent 的稳定契约。
 * 模型可以返回字符串或对象，但进入画布前必须统一成可生成、可引用的资产。
 */

import { buildPromptTemplateContext } from './ai/prompt-template-skill.mjs'

function text(value) {
  return String(value ?? '').trim()
}

function list(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return value.split(/[\n,，；;]/u)
  return []
}

function compact(value, fallback = '') {
  return text(value) || fallback
}

export function normalizePropAsset(item = {}, index = 0) {
  const source = typeof item === 'string' ? { name: item } : item || {}
  const name = compact(source.name ?? source.title ?? source.label, `道具${index + 1}`)
  const purpose = compact(source.purpose ?? source.function ?? source.narrativeUse, '服务当前剧情动作并保持外观可识别')
  const narrativeRole = compact(source.narrativeRole ?? source.storyFunction, purpose)
  const owner = compact(source.owner ?? source.associatedCharacter)
  const appearance = compact(source.appearance ?? source.visualIdentity)
  const material = compact(source.material ?? source.texture, '符合现实物理属性的常见材质')
  const shape = compact(source.shape ?? source.form, '结构完整、比例可信、边缘清晰')
  const color = compact(source.color ?? source.colour, '自然、稳定、与项目视觉风格协调')
  const dimensions = compact(source.dimensions ?? source.size ?? source.scale, '与人物手部和场景比例真实')
  const details = compact(source.details ?? source.detail, '关键接口、缝隙、磨损和连接关系清晰可见')
  const visualState = compact(source.visualState ?? source.canonicalState)
  const scriptEvidence = compact(source.scriptEvidence ?? source.evidence)
  const narrativeLabel = compact(
    source.narrativeLabel ?? source.labelText ?? source.inscription ?? source.text,
  )
  const prompt = [
    buildPromptTemplateContext('prop'),
    `道具资产：${name}`,
    `剧情用途：${purpose}`,
    `叙事功能：${narrativeRole}`,
    owner ? `剧情归属：${owner}` : '',
    appearance ? `剧情专属外观：${appearance}` : '',
    `形状结构：${shape}`,
    `材质与表面：${material}`,
    `色彩：${color}`,
    `尺寸比例：${dimensions}`,
    `可识别细节：${details}`,
    visualState ? `可固化的剧情视觉状态：${visualState}` : '可固化的剧情视觉状态：无明确要求，不额外添加剧情痕迹或临时状态。',
    scriptEvidence ? `设计依据：${scriptEvidence}` : '设计依据：当前资料未提供可核实的细节；不得虚构品牌、型号、文字、损坏或专属标记。',
    narrativeLabel
      ? `剧情指定标签（允许原样出现在道具上）：${narrativeLabel}`
      : '剧情指定标签：无；标签、屏幕和按钮保持空白或不可读抽象纹理。',
    '生成真实可拍摄的单件剧情专属道具基础资产：白底只负责隔离展示，道具的实体设计、可识别线索和稳定视觉状态必须落实上方剧情用途与设计依据，不能生成无剧情特征的通用商品替代品。采用正面三分之四视角，完整展示从最左边缘到最右边缘、从最高点到底部接触面；道具主体居中，四周保留明确安全边距，道具占画布约60%至75%。',
    '只把可长期保持在道具本体上的设计与状态带入母版，例如固定划痕、缺损、颜色、部件或无字界面布局；一次性动作、手持方式、房间位置和镜头景别留给分镜，不描述剧情场景和操作动作。',
    '这是完整道具展示图，不是角色立绘、场景概念图或局部材质特写；禁止微距摄影、局部特写、细节裁切或只拍一部分，不得让任何边缘贴住画布边界，不得截断底座、把手、线缆、开口或附属结构。背景为纯白或干净中性无缝背景，无人物、无手持、无桌面、无场景、供应商水印、平台Logo或角标，也不生成其它道具。',
    narrativeLabel
      ? `只允许出现上面列出的剧情指定标签“${narrativeLabel}”；不得增加其它文字、乱码、错误数字或平台标记。`
      : '屏幕、标签、按钮和接口不得出现可读文字、字母、数字、邮件、剧情内容或乱码；带屏幕的设备必须使用空白暗屏或无文字抽象界面。',
    '任何模型水印都视为生成失败；剧情指定标签不等于平台水印，也不得把水印伪装成剧情标签。',
    '保留真实接触阴影、材质粗糙度、金属/玻璃/塑料的物理反射、细小磨损、污渍和接缝，避免塑料感、漂浮、重复结构、概念艺术和游戏渲染感。',
  ].join('\n')
  return {
    name,
    purpose,
    material,
    shape,
    color,
    dimensions,
    details,
    narrativeLabel,
    narrativeRole,
    owner,
    appearance,
    prompt,
    visualState,
    scriptEvidence,
  }
}

export function normalizePropAssets(value) {
  const seen = new Set()
  return list(value)
    .map((item, index) => normalizePropAsset(item, index))
    .filter((item) => {
      const key = item.name.toLocaleLowerCase('zh-CN')
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function buildPropAssetViewPrompt({ prop = {}, viewKey = 'front' } = {}) {
  const normalized = normalizePropAsset(prop)
  const view = {
    front: '正面完整视角，结构和正面识别细节清晰',
    side: '严格90度侧面完整视角，显示厚度、侧边结构和真实透视',
    back: '背面完整视角，显示背部结构、接口和材质延续',
    top: '正上方俯视完整视角，显示顶部布局、开口和部件关系',
  }[text(viewKey)]
  if (!view) throw new Error(`未知道具视角：${text(viewKey)}`)
  return [
    buildPromptTemplateContext('prop'),
    '任务类型：道具资产多视角一致性生成。',
    normalized.prompt,
    `本次只输出${view}。`,
    '同一道具的名称、形状、材质、颜色、尺寸比例、磨损、接口和部件数量必须保持一致；只改变摄影机位置，不重设计道具。',
    '屏幕、标签和按钮不得出现可读文字、字母、数字、剧情内容或乱码；带屏幕的设备使用空白暗屏或无文字抽象界面。',
    '单件完整道具，完整边缘可见，四周有安全留白，道具占画布约60%至75%；禁止微距、局部特写、裁切、边缘出框、只显示细节。纯净背景，无人物、手、场景、可读文字、水印、拼贴、九宫格或多件重复道具；屏幕与标签保持空白或不可读抽象纹理。',
  ].join('\n')
}

export const PROP_VIEW_KEYS = Object.freeze(['front', 'side', 'back', 'top'])
