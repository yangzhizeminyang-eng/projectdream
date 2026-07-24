function compactSceneContext(scenes) {
  return (Array.isArray(scenes) ? scenes : [])
    .slice(0, 20)
    .map((scene) => {
      const content = String(scene?.content || scene?.summary || '').trim().slice(0, 2400)
      return `场景 ${scene?.scene_no || '?'}｜${scene?.title || '未命名'}\n${content}`
    })
    .join('\n\n')
    .slice(0, 24000)
}

const outputRules = [
  '只返回合法 JSON，不要输出解释、Markdown 或代码块。',
  '角色字段必须包含 name、role_tag、personality、appearance、age_group、gender、voice_style。',
  'appearance 必须写出可稳定复现的年龄感、脸型、五官、发型、体态、服装和标志性细节。',
  'personality 必须体现欲望、弱点、行为方式和人物关系，不要只堆形容词。',
  'age_group 只能是 child、teen、young_adult、middle_aged、senior；gender 只能是 male、female、neutral。',
  'voice_style 用不超过 60 个中文字符描述声音厚度、语速、情绪和人物气质，不要输出供应商音色 ID。',
]

export function buildCharacterExtractionPrompts(ctx) {
  const project = ctx?.project || {}
  const outline = ctx?.outline || {}
  return {
    systemPrompt: [
      '你是影视项目的角色设定总监，负责从故事总纲与剧本中提取真正参与叙事的角色，并形成可用于后续定妆、生图和配音的角色圣经。',
      ...outputRules,
      '顶层结构必须是 {"characters": [...]}，不要把群演、无名路人、地点或旁白标签误当成角色；旁白只有具备明确人物身份时才保留。',
    ].join(' '),
    userPrompt: [
      `项目名：${project?.name || '未命名项目'}`,
      `题材：${project?.category || '剧情'}`,
      `视觉风格：${project?.visualStyle || '电影感写实风格'}`,
      `叙事愿景：${project?.narrativeVision || ''}`,
      `总纲标题：${outline?.title || ''}`,
      `故事梗概：${outline?.premise || outline?.logline || ''}`,
      '',
      '场景与剧本：',
      compactSceneContext(ctx?.scenes),
      '',
      '提取 1 到 12 个有明确身份、戏剧功能或对白行动的角色。角色名优先沿用剧本原名。',
    ].join('\n'),
  }
}

export function buildCharacterProfilePrompts(ctx) {
  const project = ctx?.project || {}
  const character = ctx?.character || {}
  return {
    systemPrompt: [
      '你是影视项目的角色设定总监，要为指定角色补全一份能直接用于表演、定妆、生图和配音的结构化档案。',
      ...outputRules,
      '顶层直接返回角色对象，不要添加其他 key。',
    ].join(' '),
    userPrompt: [
      `项目名：${project?.name || '未命名项目'}`,
      `题材：${project?.category || '剧情'}`,
      `视觉风格：${project?.visualStyle || '电影感写实风格'}`,
      `叙事愿景：${project?.narrativeVision || ''}`,
      `当前角色名：${character?.name || '新角色'}`,
      `当前角色标签：${character?.role_tag || character?.roleTag || ''}`,
      `当前性格：${character?.personality || ''}`,
      `当前外观：${character?.appearance || ''}`,
      '',
      '相关场景与剧本：',
      compactSceneContext(ctx?.scenes),
      '',
      '保持角色名与剧本身份一致，在已有设定基础上补全，不要擅自改成另一个人物。',
    ].join('\n'),
  }
}
