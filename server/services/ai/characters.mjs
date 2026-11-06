import { getAiConfig, isMockProvider } from './config.mjs'
import {
  normalizeCharacterProfilePayload,
  normalizeCharactersPayload,
} from './parsers.mjs'
import {
  buildCharacterExtractionPrompts,
  buildCharacterProfilePrompts,
} from './prompts/characters.mjs'
import { generateStructuredJson } from './provider.mjs'

function mockCharacters(ctx) {
  // 没有真实文本模型时，根据项目场景正文提取少量角色样例。
  const existingNames = new Set()
  const characters = []
  const text = (Array.isArray(ctx?.scenes) ? ctx.scenes : [])
    .map((scene) => String(scene?.content || ''))
    .join('\n')
  const namePattern = /(?:角色|人物|姓名)[：:]\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,16})/g
  for (const match of text.matchAll(namePattern)) {
    const name = String(match[1] || '').trim()
    if (!name || existingNames.has(name)) continue
    existingNames.add(name)
    characters.push({
      name,
      role_tag: characters.length ? '配角' : '主角',
      personality: '目标明确，在压力下展现出稳定而有辨识度的行动方式。',
      appearance: '具有清晰可辨的面部轮廓、发型、体态、服装层次与标志性细节。',
      costume: '深色长外套与简洁内搭，佩戴一件固定的金属身份吊坠。',
      age_group: 'young_adult',
      gender: characters.length % 2 ? 'female' : 'male',
      voice_style: '自然、克制，语速稳定。',
    })
  }
  if (!characters.length) {
    characters.push({
      name: '主角',
      role_tag: '主角',
      personality: '执着、克制，面对核心冲突时会主动承担代价。',
      appearance: '成年角色，轮廓清晰，神情克制，服装与项目世界观一致。',
      costume: '与项目视觉风格一致的固定外套，保留一件可辨识的随身物件。',
      age_group: 'young_adult',
      gender: 'neutral',
      voice_style: '克制、清晰，情绪随剧情变化。',
    })
  }
  return { characters: characters.slice(0, 12) }
}

export async function generateCharacters(ctx) {
  // 角色提取流程：准备提示词 -> 调文本模型 -> 归一化角色字段。
  // 角色最终会写入 characters 表，供分镜图片一致性和 TTS 音色使用。
  const config = getAiConfig()
  if (isMockProvider(config)) return mockCharacters(ctx)
  const { systemPrompt, userPrompt } = buildCharacterExtractionPrompts(ctx)
  try {
    const result = await generateStructuredJson({
      task: 'characters',
      systemPrompt,
      userPrompt,
      model: config.characterModel,
      temperature: 0.6,
    })
    return normalizeCharactersPayload(result.json, {
      ...ctx,
      strictScriptEvidence: true,
    })
  } catch (error) {
    console.error('[ai:characters]', error)
    if (config.fallbackToMock) return mockCharacters(ctx)
    throw error
  }
}


export async function generateCharacterProfile(ctx) {
  // 单个角色档案补全：保留当前角色已有字段，只让模型补齐缺失信息。
  const config = getAiConfig()
  if (isMockProvider(config)) {
    return normalizeCharacterProfilePayload({}, ctx?.character)
  }
  const { systemPrompt, userPrompt } = buildCharacterProfilePrompts(ctx)
  try {
    const result = await generateStructuredJson({
      task: 'character-profile',
      systemPrompt,
      userPrompt,
      model: config.characterModel,
      temperature: 0.65,
    })
    return normalizeCharacterProfilePayload(result.json, ctx?.character)
  } catch (error) {
    console.error('[ai:character-profile]', error)
    if (config.fallbackToMock) return normalizeCharacterProfilePayload({}, ctx?.character)
    throw error
  }
}
