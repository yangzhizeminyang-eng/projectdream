import { getAiConfig } from './config.mjs'
import { generateStructuredJson } from './provider.mjs'
import {
  buildSceneExtractionPrompts,
  normalizeSceneExtractionPayload,
} from './scene-extraction.mjs'
import { buildSceneSpaceAnchorPrompt, normalizeSceneSpaceManifest } from '../scene-space-manifest.mjs'

export async function extractScenesWithAgent({ projectName, scriptText } = {}) {
  const config = getAiConfig()
  const { systemPrompt, userPrompt } = buildSceneExtractionPrompts({ projectName, scriptText })
  const result = await generateStructuredJson({
    task: 'scene-extraction',
    systemPrompt,
    userPrompt,
    model: config.scriptModel,
    temperature: 0.2,
    longTask: true,
  })
  const scenes = normalizeSceneExtractionPayload(result.json)
  if (!scenes.length) {
    const responseShape = Array.isArray(result.json)
      ? 'array'
      : Object.keys(result.json || {}).join(',') || 'empty'
    throw new Error(`场景解析 Agent 返回了空场景列表（响应字段：${responseShape}），未写入旧场景`)
  }
  if (scenes.some((scene) => !scene.spatial_anchors)) {
    throw new Error('场景解析 Agent 未返回完整空间锚点 JSON，未写入旧场景')
  }
  return scenes
}

export async function extractSceneSpaceAnchorsWithAgent({ scene } = {}) {
  const config = getAiConfig()
  const prompts = buildSceneSpaceAnchorPrompt({ scene })
  const result = await generateStructuredJson({
    task: 'scene-space-anchors',
    ...prompts,
    model: config.scriptModel,
    temperature: 0.1,
    longTask: false,
  })
  return normalizeSceneSpaceManifest(result.json?.spatial_anchors || result.json)
}
