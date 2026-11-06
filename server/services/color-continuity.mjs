/**
 * Build a compact color bible for image/video generation.
 *
 * The model should receive the project's existing color evidence, not a new
 * palette invented by the pipeline. The rules below turn that evidence into
 * stable constraints that can survive shot changes and provider retries.
 */

function text(value) {
  return String(value ?? '').trim()
}

function hasAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value))
}

function compactEvidence(value, maxChars = 420) {
  const source = text(value).replace(/\s+/g, ' ')
  if (source.length <= maxChars) return source

  const evidencePattern = /冷蓝|青蓝|蓝色|红色|暖黄|暖色|黄色|灰绿|色温|色彩|灯具|灯光|光源|光线|白平衡|曝光|材质/iu
  const fragments = source
    .split(/[。；;\n]+/u)
    .map((part) => part.trim())
    .filter((part) => part && evidencePattern.test(part))
  const compact = [...new Set(fragments)].join('；')
  return (compact || source).slice(0, maxChars)
}

export function buildColorContinuityConstraints({
  visualStyle = '',
  scenePrompt = '',
  shotPrompt = '',
} = {}) {
  const style = compactEvidence(visualStyle, 320)
  const scene = compactEvidence(scenePrompt)
  const shot = compactEvidence(shotPrompt, 320)
  const evidence = [text(visualStyle), text(scenePrompt), text(shotPrompt)].filter(Boolean)
  const combined = evidence.join('\n')
  const hasColdBlue = hasAny(combined, [/冷蓝/i, /青蓝/i, /蓝色/i, /teal/i, /cyan/i, /cool\s+blue/i])
  const hasRedAccent = hasAny(combined, [/红色/i, /警示/i, /red/i, /warning/i])
  const hasWarmLight = hasAny(combined, [/暖黄/i, /暖色/i, /黄色/i, /amber/i, /tungsten/i, /warm\s+light/i])
  const hasExplicitPalette = hasColdBlue || hasRedAccent || hasWarmLight

  return [
    '色彩连续性硬约束：项目与场景中的既有色彩设定是唯一调色来源；不得为了“电影感”擅自更换主色、色温或对比关系。',
    style ? `项目色彩证据：${style}` : '',
    scene ? `场景色彩证据：${scene}` : '',
    shot ? `本镜色彩证据：${shot}` : '',
    hasColdBlue ? '主色锚点：冷蓝、青蓝、低饱和金属灰；冷色用于环境和金属材质，不代表给整张画面套蓝色滤镜。' : '',
    hasWarmLight ? '光源锚点：暖黄色只保留在提示词明确的灯具或实际暖色光源上，不能把全场景改成暖橙色。' : '',
    hasRedAccent ? '警示色锚点：红色仅限局部警示灯、状态指示灯或剧情明确的红色光源；不能铺满墙面、人物或全画面。' : '',
    !hasExplicitPalette ? '没有明确色板时，保持参考资产的真实颜色和中性白平衡，不主动发明新配色。' : '',
    '人物保护：肤色、黑色服装和眼镜材质不得被强烈染色；白色/金属材质与固定配饰要保留真实局部颜色。',
    '镜头连续性：起始帧到结束帧保持同一白平衡、曝光和饱和度关系；镜头运动不能造成色温跳变、闪烁或曝光呼吸。',
    '禁止全画面单色滤镜；同时禁止全画面蓝染、红染、过曝、死黑、彩色雾化、彩虹渐变和随机霓虹色。',
    '不得擅自加入青橙、紫色或霓虹渐变，也不得把局部警示色扩展为全局调色。',
  ].filter(Boolean).join('\n')
}
