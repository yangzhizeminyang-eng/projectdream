function text(value) {
  return String(value ?? '').trim()
}

function continuityFromPrompt(value) {
  const match = String(value ?? '').match(/@片段衔接(?:\[([^\]]+)\]|\(([^)]+)\))?/u)
  return text(match?.[1] || match?.[2]) || null
}

const TOOL_RULES = Object.freeze({
  '添加时间': '保留镜头时长标签，视频时长以分镜 duration_seconds 为准，不擅自压缩对白或动作。',
  '片段衔接': '继承上一镜结束时的人物状态、视线方向、道具位置和空间关系，禁止跳变。',
  '首尾帧参考': '读取上一镜确认结束帧作为本镜开始状态，并让动作连续过渡到本镜结束状态。',
  '环境音': '读取当前场景的环境声方向，用于声音生成与混音，不把环境音误当成角色对白。',
})

export function normalizeStoryboardMentionContext({
  referencedAssets = [],
  tools = [],
  voiceBindings = [],
  prompt = '',
} = {}) {
  const assets = (Array.isArray(referencedAssets) ? referencedAssets : [])
    .map((asset) => ({
      id: Number(asset?.id || 0) || null,
      refId: Number(asset?.refId || asset?.ref_id || 0) || null,
      characterId: Number(asset?.characterId || 0) || null,
      sceneViewKey: text(asset?.sceneViewKey || asset?.scene_view_key) || null,
      key: text(asset?.key),
      kind: text(asset?.kind || asset?.type || asset?.nodeType),
      name: text(asset?.name || asset?.label),
      imageUrl: text(asset?.imageUrl || asset?.image_url) || null,
      promptText: text(asset?.promptText) || null,
      viewKeys: Array.isArray(asset?.viewKeys) ? asset.viewKeys.map(text).filter(Boolean) : [],
      viewSetVersion: asset?.viewSetVersion ? Number(asset.viewSetVersion) : null,
      versionNo: asset?.versionNo ? Number(asset.versionNo) : null,
      voiceProfileKey: text(asset?.voiceProfileKey) || null,
      voiceLocked: asset?.voiceLocked === true,
      referenceAudioUrl: text(asset?.referenceAudioUrl) || null,
    }))
    .filter((asset) => asset.name)

  const normalizedTools = (Array.isArray(tools) ? tools : [])
    .map((tool) => {
      const name = text(tool?.name || tool)
      return {
        key: text(tool?.key) || `tool-${name}`,
        name,
        rule: TOOL_RULES[name] || text(tool?.rule),
        from: name === '片段衔接' ? continuityFromPrompt(prompt) : null,
      }
    })
    .filter((tool) => tool.name && tool.rule)

  const voices = (Array.isArray(voiceBindings) ? voiceBindings : [])
    .map((voice) => ({
      characterId: Number(voice?.characterId || 0) || null,
      characterName: text(voice?.characterName || voice?.name),
      voiceProfileKey: text(voice?.voiceProfileKey) || null,
      voiceLocked: voice?.voiceLocked === true,
      referenceAudioUrl: text(voice?.referenceAudioUrl) || null,
    }))
    .filter((voice) => voice.characterName)

  return { assets, tools: normalizedTools, voices }
}

export function buildMentionContextPrompt({ assets = [], tools = [], voices = [] } = {}) {
  const lines = []
  for (const asset of assets) {
    const kind = asset.kind === 'character' ? '角色' : asset.kind === 'scene' ? '场景' : '道具'
    lines.push(
      `@${asset.name}（${kind}）：${[
        asset.kind === 'character' ? '角色身份、外貌、服装和配饰只读取已确认角色参考图与资产版本' : '',
        asset.kind !== 'character' && asset.promptText
          ? '资产外观只读取已确认参考图；不复述资产生成模板或白底展示约束'
          : '',
        asset.imageUrl ? '已绑定参考图，必须读取并保持一致' : '缺少参考图',
        asset.viewKeys.length ? `视角组=${asset.viewKeys.join('/')}` : '',
        asset.voiceProfileKey ? `音色=${asset.voiceProfileKey}${asset.voiceLocked ? '（已锁定）' : ''}` : '',
        asset.referenceAudioUrl ? '已绑定真实参考音频' : '',
      ].filter(Boolean).join('；')}`,
    )
  }
  for (const tool of tools) lines.push(`@${tool.name}（工具）：${tool.rule}`)
  for (const voice of voices) {
    lines.push(
      `@音色[${voice.characterName}]：${voice.voiceProfileKey || '参考音频'}${voice.voiceLocked ? '（已锁定）' : '（未锁定）'}`,
    )
  }
  const continuity = tools.find((tool) => tool.name === '片段衔接')
  if (continuity?.from) lines.push(`@片段衔接[${continuity.from}]：读取该镜头确认尾帧作为本镜首帧`)
  return lines.length ? `本镜 @ 引用执行上下文：\n${lines.join('\n')}` : ''
}
