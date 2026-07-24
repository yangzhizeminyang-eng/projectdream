/**
 * @file AI Provider
 * @description 对接 OpenAI-compatible 接口，统一处理超时、鉴权、JSON 解析和错误输出。
 */

import { getAiConfig, isMockProvider } from './config.mjs'

class AiProviderError extends Error {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {number} [options.status]
   * @param {string} [options.detail]
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'AiProviderError'
    this.status = options.status || 0
    this.detail = options.detail || ''
  }
}

function stripCodeFence(text) {
  const raw = String(text || '').trim()
  if (!raw.startsWith('```')) return raw
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}

function extractJsonText(text) {
  const raw = stripCodeFence(text)
  const firstBrace = raw.indexOf('{')
  const firstBracket = raw.indexOf('[')
  const startCandidates = [firstBrace, firstBracket].filter((n) => n >= 0)
  if (!startCandidates.length) return raw
  const start = Math.min(...startCandidates)
  const lastBrace = raw.lastIndexOf('}')
  const lastBracket = raw.lastIndexOf(']')
  const end = Math.max(lastBrace, lastBracket)
  if (end < start) return raw.slice(start).trim()
  return raw.slice(start, end + 1).trim()
}

/**
 * @param {string} text
 * @returns {any}
 */
function parseJsonPayload(text) {
  const jsonText = extractJsonText(text)
  try {
    return JSON.parse(jsonText)
  } catch (error) {
    throw new AiProviderError('AI 返回内容不是合法 JSON', {
      detail: jsonText.slice(0, 400),
    })
  }
}

/**
 * @param {object} params
 * @param {string} params.task
 * @param {string} params.systemPrompt
 * @param {string} params.userPrompt
 * @param {string} [params.model]
 * @param {number} [params.temperature]
 * @returns {Promise<{ content: string, json: any, raw: any }>}
 */
export async function generateStructuredJson(params) {
  const config = getAiConfig()
  if (isMockProvider(config)) {
    throw new AiProviderError('当前 AI_PROVIDER=mock，不执行真实模型调用')
  }

  if (!config.baseUrl) {
    throw new AiProviderError('缺少 AI_BASE_URL 配置')
  }
  if (!config.apiKey) {
    throw new AiProviderError('缺少 AI_API_KEY 配置')
  }

  const url = `${config.baseUrl}/chat/completions`
  const model = String(params.model || config.defaultModel || '').trim()
  if (!model) {
    throw new AiProviderError('缺少 AI_MODEL 配置')
  }

  const payload = {
    model,
    temperature: typeof params.temperature === 'number' ? params.temperature : 0.7,
    messages: [
      { role: 'system', content: String(params.systemPrompt || '').trim() },
      { role: 'user', content: String(params.userPrompt || '').trim() },
    ],
  }

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      throw new AiProviderError('AI 请求超时')
    }
    throw new AiProviderError(`AI 请求失败：${error instanceof Error ? error.message : 'unknown error'}`)
  }

  const text = await response.text()
  let raw = null
  try {
    raw = text ? JSON.parse(text) : null
  } catch {
    raw = null
  }

  if (!response.ok) {
    const detail =
      raw?.error?.message ||
      raw?.message ||
      raw?.detail ||
      text.slice(0, 400) ||
      `HTTP ${response.status}`
    throw new AiProviderError(`AI 调用失败：${detail}`, {
      status: response.status,
      detail,
    })
  }

  const content = raw?.choices?.[0]?.message?.content
  if (!content || !String(content).trim()) {
    throw new AiProviderError('AI 没有返回有效内容')
  }

  return {
    content: String(content),
    json: parseJsonPayload(String(content)),
    raw,
  }
}

export { AiProviderError }
