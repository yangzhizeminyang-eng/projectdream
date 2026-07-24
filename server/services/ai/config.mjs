/**
 * @file AI 配置读取
 * @description 统一从环境变量读取 AI 运行参数，避免各个模块各自散读。
 */

function parseBoolean(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue
  const normalized = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return defaultValue
}

function parsePositiveInt(value, defaultValue) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : defaultValue
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  return raw.replace(/\/+$/, '')
}

export function getAiConfig() {
  const provider = String(process.env.AI_PROVIDER || 'mock')
    .trim()
    .toLowerCase()

  return {
    provider,
    baseUrl: normalizeBaseUrl(process.env.AI_BASE_URL),
    apiKey: String(process.env.AI_API_KEY || '').trim(),
    defaultModel: String(process.env.AI_MODEL || 'gpt-5.4').trim(),
    outlineModel: String(process.env.AI_MODEL_OUTLINE || process.env.AI_MODEL || 'gpt-5.4').trim(),
    scriptModel: String(process.env.AI_MODEL_SCRIPT || process.env.AI_MODEL || 'gpt-5.4').trim(),
    storyboardModel: String(process.env.AI_MODEL_STORYBOARD || process.env.AI_MODEL || 'gpt-5.4').trim(),
    characterModel: String(process.env.AI_MODEL_CHARACTER || process.env.AI_MODEL || 'gpt-5.4').trim(),
    timeoutMs: parsePositiveInt(process.env.AI_TIMEOUT_MS, 60000),
    fallbackToMock: parseBoolean(process.env.AI_FALLBACK_TO_MOCK, true),
  }
}

export function isMockProvider(config = getAiConfig()) {
  return config.provider === 'mock'
}
