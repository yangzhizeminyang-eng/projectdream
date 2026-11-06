import {
  IMAGE_PROMPT_SKILL_RULES,
  SCREENPLAY_SKILL_RULES,
  joinProductionPromptRules,
} from '../skills/production-prompt-rules.mjs'
import { buildPromptTemplateContext } from '../prompt-template-skill.mjs'

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

function compactStoryBibleCharacterContext(characters) {
  return (Array.isArray(characters) ? characters : [])
    .filter((character) => character?.name)
    .map((character) => `${character.name}｜身份：${character.role || ''}｜视觉基线：${character.visualDescription || ''}`)
    .join('\n')
    .slice(0, 12000)
}

const outputRules = [
  '只返回合法 JSON，不要输出解释、Markdown 或代码块。',
  '角色字段必须包含 name、role_tag、personality、appearance、costume、age_group、gender、voice_style。',
  'appearance 必须写出可稳定复现的年龄感、脸型、五官、发型、体态和身份标志，不要把服装细节全部混进 appearance。',
  'costume 必须单独写出整季默认服装、颜色材质、鞋子和固定随身物件；除非剧情明确要求换装，否则后续镜头必须沿用。',
  '禁止把服装、鞋子、配饰或随身物件写入 voice_setting；voice_setting 只写声线参考。即使服装与声线都需要描述，也必须分别写入 costume 和 voice_style。',
  'personality 必须体现欲望、弱点、行为方式和人物关系，不要只堆形容词。',
  'age_group 只能是 child、teen、young_adult、middle_aged、senior；gender 只能是 male、female、neutral。',
  'voice_style 用不超过 60 个中文字符描述声音厚度、语速、情绪和人物气质，不要输出供应商音色 ID。',
]

export function buildCharacterExtractionPrompts(ctx) {
  const project = ctx?.project || {}
  const outline = ctx?.outline || {}
  const storyBibleCharacters = compactStoryBibleCharacterContext(ctx?.storyBible?.characters)
  return {
    systemPrompt: [
      '你是影视项目的角色设定总监，负责从故事总纲与剧本中提取真正参与叙事的角色，并形成可用于后续定妆、生图和配音的角色圣经。',
      buildPromptTemplateContext('character'),
      joinProductionPromptRules(SCREENPLAY_SKILL_RULES, IMAGE_PROMPT_SKILL_RULES),
      ...outputRules,
      '顶层结构必须是 {"characters": [...]}，不要把群演、无名路人、地点或旁白标签误当成角色；旁白只有具备明确人物身份时才保留。当前剧本正文是角色集合的唯一权威来源。',
    ].join(' '),
    userPrompt: [
      `项目名：${project?.name || '未命名项目'}`,
      `题材：${project?.category || '剧情'}`,
      `视觉风格：${project?.visualStyle || '电影感写实风格'}`,
      `叙事愿景：${project?.narrativeVision || ''}`,
      '',
      '当前剧本正文（最高优先级；必须先依据这里提取角色）：',
      compactSceneContext(ctx?.scenes),
      '',
      storyBibleCharacters
        ? `已确认故事设定中的角色视觉基线（只用于补齐服装、鞋履和随身物件，不得新增正文没有的角色）：\n${storyBibleCharacters}`
        : '当前没有可用的故事设定视觉基线，固定服装与随身物件必须从剧本正文提取；没有证据时保留待确认状态。',
      '',
      `旧总纲（仅作背景参考；与当前正文冲突时必须忽略）：标题=${outline?.title || ''}；梗概=${outline?.premise || outline?.logline || ''}`,
      '',
      '只提取当前完整正文中有明确姓名、身份、戏剧功能或对白行动的角色；旧总纲或历史场景与当前正文冲突时不得沿用旧角色。若正文明确写“林默”，必须输出 name=林默、gender=male；不得因为“主角/女主角”等叙事标签推断性别。老板、死者、发件人等身份标签只有在正文出现明确姓名或有效行动时才作为角色。路人甲、群众、群演、员工、旁白、地点和物件都不算角色；同一人物的成年、童年、五年前、现在等状态必须合并为一个角色，不得拆成多个角色。角色数量以当前正文明确人物为准，不为了凑数添加角色；角色名优先沿用当前正文原名。',
    ].join('\n'),
  }
}

export function buildCharacterProfilePrompts(ctx) {
  const project = ctx?.project || {}
  const character = ctx?.character || {}
  return {
    systemPrompt: [
      '你是影视项目的角色设定总监，要为指定角色补全一份能直接用于表演、定妆、生图和配音的结构化档案。',
      buildPromptTemplateContext('character'),
      joinProductionPromptRules(SCREENPLAY_SKILL_RULES, IMAGE_PROMPT_SKILL_RULES),
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
      `当前服装与随身物件：${character?.costume || character?.costume_description || ''}`,
      '',
      '相关场景与剧本：',
      compactSceneContext(ctx?.scenes),
      '',
      '保持角色名与剧本身份一致，在已有设定基础上补全，不要擅自改成另一个人物。',
    ].join('\n'),
  }
}
