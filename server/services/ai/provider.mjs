/**
 * @file AI Provider
 * @description 对接 OpenAI-compatible 接口，统一处理超时、鉴权、JSON 解析和错误输出。
 */

import { getAiConfig, isMockProvider } from './config.mjs'

const LONG_TASKS = new Set([
  'story-bible',
  'outline',
  'season-structure',
  'script',
  'storyboard',
  'scene-extraction',
  'characters',
])

function isTimeoutError(error) {
  return error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT' || error?.code === 'UND_ERR_HEADERS_TIMEOUT'
}

function normalizeUpstreamDetail(error) {
  return String(error?.message || error || '').trim()
}

export function resolveAiRequestTimeoutMs(config, task, longTask = false) {
  return (longTask || LONG_TASKS.has(String(task || '').trim()))
    ? Math.max(config.longTaskTimeoutMs || config.timeoutMs, config.timeoutMs)
    : config.timeoutMs
}

export function describeAiRequestError(error, task, status = 0) {
  const detail = normalizeUpstreamDetail(error).toLowerCase()
  if (isTimeoutError(error)) {
    return `${task === 'story-bible' ? '故事设定' : 'AI'}生成超时，上游模型处理时间较长，请稍后重试。`
  }
  if (status === 401 || status === 403 || /unauthorized|invalid api key|authentication|鉴权|密钥/.test(detail)) {
    return '文本模型接口密钥无效或无权限，请打开模型设置检查文本服务商和接口密钥。'
  }
  if (status === 402 || /insufficient account balance|insufficient balance|余额不足|quota|额度/.test(detail)) {
    return '文本模型额度不足，请打开模型设置更换可用账号或充值后重试。'
  }
  if (/fetch failed|econnrefused|enotfound|connect timeout|socket/.test(detail)) {
    return '文本模型接口暂时无法连接，请打开模型设置检查接口地址，确认服务可访问后重试。'
  }
  return `AI 请求失败：${normalizeUpstreamDetail(error) || '上游服务未返回具体原因'}`
}

class AiProviderError extends Error {
  // 统一包装 AI 调用错误，调用方可以根据 status/detail 判断是配置错、超时还是供应商错误。
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
  // 模型有时会把 JSON 放进 ```json ... ``` 代码块里，先去掉外层标记。
  const raw = String(text || '').trim()
  if (!raw.startsWith('```')) return raw
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}

function extractJsonText(text) {
  // 尽量从模型的自然语言回复中截取最外层 JSON。
  // 这是容错，不代表提示词可以不要求模型只返回 JSON。
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

function findBalancedJsonCandidates(text) {
  const raw = stripCodeFence(text)
  const candidates = []
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== '{' && raw[start] !== '[') continue
    const stack = []
    let inString = false
    let escaped = false
    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') {
        inString = true
        continue
      }
      if (char === '{' || char === '[') stack.push(char)
      else if (char === '}' || char === ']') {
        const expected = char === '}' ? '{' : '['
        if (stack[stack.length - 1] !== expected) break
        stack.pop()
        if (!stack.length) {
          candidates.push(raw.slice(start, index + 1).trim())
          break
        }
      }
    }
  }
  return candidates
}

/**
 * @param {string} text
 * @returns {any}
 */
export function parseJsonPayload(text) {
  // 解析失败时抛出专用错误，方便上层决定是否 fallback 到 mock。
  const jsonText = extractJsonText(text)
  const candidates = [jsonText, ...findBalancedJsonCandidates(text)]
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // Continue with the next balanced object. Some reasoning models put a
      // JSON example or a short explanation before the actual payload.
    }
  }
  throw new AiProviderError('AI 返回内容不是合法 JSON', {
    detail: String(text || '').slice(0, 600),
  })
}

export function buildAiRequestPayload(params, config) {
  const payload = {
    model: String(params.model || config.defaultModel || '').trim(),
    temperature: typeof params.temperature === 'number' ? params.temperature : 0.7,
    messages: [
      { role: 'system', content: String(params.systemPrompt || '').trim() },
      { role: 'user', content: String(params.userPrompt || '').trim() },
    ],
  }

  if (params.responseFormat) {
    payload.response_format = params.responseFormat
  }

  if (Number.isInteger(params.maxTokens) && params.maxTokens > 0) {
    payload.max_tokens = params.maxTokens
  }
  if (params.thinking) {
    payload.thinking = params.thinking
  }

  return payload
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
  // 所有文本生成能力都走这里，统一完成：
  // 配置检查 -> POST /chat/completions -> 超时处理 -> HTTP 错误处理 -> JSON 解析。
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

  const payload = buildAiRequestPayload({ ...params, model }, config)

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(
        resolveAiRequestTimeoutMs(config, params.task, params.longTask === true),
      ),
    })
  } catch (error) {
    const diagnostic = [
      `url=${url}`,
      `model=${model}`,
      `error=${error?.name || 'Error'}`,
      `detail=${normalizeUpstreamDetail(error)}`,
      `cause=${normalizeUpstreamDetail(error?.cause)}`,
    ].join(' ')
    console.error('[ai:provider] request failed', diagnostic)
    throw new AiProviderError(describeAiRequestError(error, params.task), {
      detail: diagnostic,
    })
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
    throw new AiProviderError(describeAiRequestError(new Error(detail), params.task, response.status), {
      status: response.status,
      detail,
    })
  }

  const contentValue = raw?.choices?.[0]?.message?.content
  const content = Array.isArray(contentValue)
    ? contentValue.map((part) => typeof part === 'string' ? part : part?.text || '').join('')
    : contentValue
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
