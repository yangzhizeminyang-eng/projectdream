import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveVideoImageInput } from './video.mjs'

const PLACEHOLDER_IMAGE_SHA256 =
  'E330CD023298A812503E10A067A3F88E1CBC094F37F6FD2A88FDB6799495B37E'

function parseBoolean(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue
  const normalized = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return defaultValue
}

function parseNonNegativeInt(value, defaultValue) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : defaultValue
}

function parsePositiveInt(value, defaultValue) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue
}

export function parseFrameModelList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseRetryAfter(value) {
  const raw = String(value || '').trim()
  if (!raw) return 0

  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000)
  }

  const retryAt = Date.parse(raw)
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createFrameProviderError(message, options = {}) {
  const error = new Error(message)
  error.status = Number(options.status) || 0
  error.retryAfterMs = Number(options.retryAfterMs) || 0
  error.retryable = Boolean(options.retryable)
  return error
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim()
  return raw.replace(/\/+$/, '')
}

function toExtFromContentType(contentType) {
  const normalized = String(contentType || '').toLowerCase()
  if (normalized.includes('png')) return '.png'
  if (normalized.includes('webp')) return '.webp'
  return '.jpg'
}

export function extractImageDimensions(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || [])

  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }

  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const startOfFrameMarkers = new Set([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
    ])
    let offset = 2
    while (offset + 8 < bytes.length) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
      const marker = bytes[offset]
      offset += 1
      if (marker === 0xd8 || marker === 0xd9) continue
      if (offset + 2 > bytes.length) break
      const segmentLength = bytes.readUInt16BE(offset)
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break
      if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
        return {
          width: bytes.readUInt16BE(offset + 5),
          height: bytes.readUInt16BE(offset + 3),
        }
      }
      offset += segmentLength
    }
  }

  if (
    bytes.length >= 30 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const chunkType = bytes.toString('ascii', 12, 16)
    if (chunkType === 'VP8X') {
      return {
        width: bytes.readUIntLE(24, 3) + 1,
        height: bytes.readUIntLE(27, 3) + 1,
      }
    }
    if (
      chunkType === 'VP8 ' &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      }
    }
    if (chunkType === 'VP8L' && bytes[20] === 0x2f) {
      return {
        width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]),
        height: 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | (bytes[22] >> 6)),
      }
    }
  }

  return null
}

export function assertFrameImageRatio(dimensions, expectedRatio, tolerance = 0.02) {
  if (!dimensions?.width || !dimensions?.height) {
    throw new Error('Generated image has an unsupported or invalid file format')
  }

  const ratioMatch = String(expectedRatio || '').trim().match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/)
  if (!ratioMatch) return dimensions

  const expected = Number(ratioMatch[1]) / Number(ratioMatch[2])
  const actual = dimensions.width / dimensions.height
  if (!Number.isFinite(expected) || expected <= 0) return dimensions
  if (Math.abs(actual - expected) / expected > tolerance) {
    throw new Error(
      `Generated image is ${dimensions.width}x${dimensions.height}; expected aspect ratio ${expectedRatio}`,
    )
  }
  return dimensions
}

function safeFileToken(value) {
  return String(value || 'frame')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'frame'
}

export function getFrameConfig() {
  const provider = String(process.env.FRAME_PROVIDER || 'trae-url').trim().toLowerCase()
  const defaultBaseUrl =
    provider === 'agnes'
      ? 'https://apihub.agnes-ai.com/v1'
      : provider === 'toapi'
        ? 'https://toapis.com/v1'
        : provider === 'bigmodel' || provider === 'zhipu'
          ? 'https://open.bigmodel.cn/api/paas/v4'
        : 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image'
  return {
    provider,
    baseUrl: normalizeBaseUrl(process.env.FRAME_BASE_URL || defaultBaseUrl),
    apiKey: String(
      process.env.FRAME_API_KEY ||
        (provider === 'bigmodel' || provider === 'zhipu'
          ? process.env.BIGMODEL_API_KEY || process.env.ZHIPU_API_KEY
          : process.env.TOAPI_API_KEY || process.env.AGNES_API_KEY) ||
        '',
    ).trim(),
    imageSize: String(
      process.env.FRAME_IMAGE_SIZE ||
        (provider === 'agnes'
          ? '1K'
          : provider === 'toapi'
            ? '1k'
            : provider === 'bigmodel' || provider === 'zhipu'
              ? '1344x768'
              : 'landscape_16_9'),
    ).trim(),
    imageRatio: String(process.env.FRAME_IMAGE_RATIO || '16:9').trim(),
    defaultModel: String(
      process.env.FRAME_MODEL ||
        (provider === 'agnes'
          ? 'agnes-image-2.1-flash'
          : provider === 'toapi'
            ? 'gpt-image-2'
            : provider === 'bigmodel' || provider === 'zhipu'
              ? 'cogview-3-flash'
              : 'trae-text2image-v1'),
    ).trim(),
    fallbackModels: parseFrameModelList(
      process.env.FRAME_FALLBACK_MODELS || (provider === 'agnes' ? 'agnes-image-2.0-flash' : ''),
    ),
    timeoutMs: Number(process.env.FRAME_TIMEOUT_MS || 90000) || 90000,
    retryAttempts: parseNonNegativeInt(process.env.FRAME_RETRY_ATTEMPTS, 2),
    retryBaseDelayMs: parsePositiveInt(process.env.FRAME_RETRY_BASE_DELAY_MS, 5000),
    pollIntervalMs: parsePositiveInt(process.env.FRAME_POLL_INTERVAL_MS, 6000),
    pollTimeoutMs: parsePositiveInt(process.env.FRAME_POLL_TIMEOUT_MS, 180000),
    fallbackToMock: parseBoolean(process.env.FRAME_FALLBACK_TO_MOCK, true),
    referenceUploadBaseUrl: normalizeBaseUrl(
      process.env.FRAME_REFERENCE_UPLOAD_BASE_URL ||
        process.env.VIDEO_IMAGE_UPLOAD_BASE_URL ||
        (provider === 'toapi' ? process.env.FRAME_BASE_URL || defaultBaseUrl : 'https://toapis.com/v1'),
    ),
    referenceUploadApiKey: String(
      process.env.FRAME_REFERENCE_UPLOAD_API_KEY ||
        process.env.VIDEO_IMAGE_UPLOAD_API_KEY ||
        process.env.TOAPI_API_KEY ||
        process.env.FRAME_API_KEY ||
        '',
    ).trim(),
    referenceUploadTimeoutMs: parsePositiveInt(
      process.env.FRAME_REFERENCE_UPLOAD_TIMEOUT_MS,
      120000,
    ),
    referenceUploadRetryAttempts: parseNonNegativeInt(
      process.env.FRAME_REFERENCE_UPLOAD_RETRY_ATTEMPTS,
      2,
    ),
    referenceUploadRetryBaseDelayMs: parsePositiveInt(
      process.env.FRAME_REFERENCE_UPLOAD_RETRY_BASE_DELAY_MS,
      1500,
    ),
  }
}

export function resolveFrameModelChain(config = getFrameConfig(), requestedModel = '') {
  return [...new Set([String(requestedModel || '').trim() || config.defaultModel, ...config.fallbackModels])]
    .filter(Boolean)
}

export function isMockFrameProvider(config = getFrameConfig()) {
  return config.provider === 'mock'
}

function isAgnesFrameProvider(config) {
  return config.provider === 'agnes'
}

function isToApiFrameProvider(config) {
  return config.provider === 'toapi'
}

function isBigModelFrameProvider(config) {
  return config.provider === 'bigmodel' || config.provider === 'zhipu'
}

export function normalizeFrameReferenceImageUrls(referenceImageUrls = [], limit = 8) {
  return referenceImageUrls
    .map((item) => String(item || '').trim())
    .filter((item) => /^https?:\/\//i.test(item))
    .slice(0, limit)
}

export function frameProviderSupportsReferenceImages(config = getFrameConfig()) {
  return isAgnesFrameProvider(config) || isToApiFrameProvider(config)
}

export function assertFrameReferenceImageSupport({
  config = getFrameConfig(),
  modelName = '',
  referenceImageUrls = [],
} = {}) {
  const normalizedReferences = normalizeFrameReferenceImageUrls(referenceImageUrls)
  if (normalizedReferences.length && !frameProviderSupportsReferenceImages(config)) {
    const effectiveModel = String(modelName || config.defaultModel || '').trim()
    const error = new Error(
      `当前图片生成通道 ${config.provider}${effectiveModel ? ` / ${effectiveModel}` : ''} 不支持定妆参考图输入，不能保证角色同脸一致。请到模型设置把图片生成通道切换为支持 reference_images 的通道后再生成。`,
    )
    error.code = 'FRAME_REFERENCE_UNSUPPORTED'
    error.statusCode = 409
    throw error
  }
  return normalizedReferences
}

export async function resolveFrameReferenceImageUrls(referenceImageUrls = [], config = getFrameConfig()) {
  const normalizedReferences = normalizeFrameReferenceImageUrls(referenceImageUrls)
  const uploadConfig = {
    imageUploadBaseUrl: config.referenceUploadBaseUrl,
    imageUploadApiKey: config.referenceUploadApiKey || config.apiKey,
    imageUploadTimeoutMs: config.referenceUploadTimeoutMs,
    imageUploadRetryAttempts: config.referenceUploadRetryAttempts,
    imageUploadRetryBaseDelayMs: config.referenceUploadRetryBaseDelayMs,
  }

  try {
    return await Promise.all(
      normalizedReferences.map((url) => resolveVideoImageInput(url, uploadConfig)),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误'
    throw createFrameProviderError(
      `参考图上传失败，外部图片模型无法访问本地定妆图：${message.replace(/^Video source image upload failed:\s*/i, '')}`,
      { retryable: false },
    )
  }
}

export function normalizeFramePromptAspectRatio(prompt, targetRatio) {
  const ratio = String(targetRatio || '').trim()
  let normalized = String(prompt || '')
    .replace(/\b(?:cinemascope\s*)?\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?\b/gi, '')
    .replace(/\b(?:letterbox(?:ed)?|ultra-?wide)\b/gi, '')
    .replace(/\s*([,，])\s*(?:[,，]\s*)+/g, '$1 ')
    .replace(/^[\s,，]+|[\s,，]+$/g, '')
    .trim()

  if (ratio === '16:9') {
    normalized = normalized.replace(/\bcinemascope\b/gi, '').trim()
  }
  if (!ratio) return normalized
  return [
    normalized,
    `native ${ratio} full-frame composition, fill the entire image edge to edge, no letterbox, no black bars`,
  ]
    .filter(Boolean)
    .join(', ')
}

function buildVariantPrompt(basePrompt, negativePrompt, variantIndex, imageRatio) {
  const variants = [
    'primary cinematic keyframe, preserve the core action and blocking, coherent character design',
    'alternate composition, stronger lighting contrast, richer atmosphere, film still quality',
    'alternative camera treatment, deeper depth, stronger texture detail, premium cinematic still',
  ]

  const parts = [
    normalizeFramePromptAspectRatio(basePrompt, imageRatio),
    variants[variantIndex] || variants[0],
  ].filter(Boolean)
  const negative = String(negativePrompt || '').trim()
  if (negative) {
    parts.push(`avoid: ${negative}`)
  }
  return parts.join(', ')
}

async function downloadImageBuffer(url, timeoutMs) {
  const response = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    throw new Error(`Frame provider request failed with HTTP ${response.status}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  const bytes = Buffer.from(arrayBuffer)
  const digest = createHash('sha256').update(bytes).digest('hex').toUpperCase()
  if (digest === PLACEHOLDER_IMAGE_SHA256) {
    throw new Error('Frame provider returned a generation placeholder instead of a final image')
  }

  return {
    bytes,
    contentType: response.headers.get('content-type') || 'image/jpeg',
  }
}

export async function persistRemoteFrameImage({
  sourceUrl,
  timeoutMs,
  outputDir,
  publicBaseUrl,
  filePrefix,
  expectedRatio,
}) {
  if (!outputDir || !publicBaseUrl) {
    return { imageUrl: sourceUrl, dimensions: null }
  }

  const { bytes, contentType } = await downloadImageBuffer(sourceUrl, timeoutMs)
  const dimensions = assertFrameImageRatio(extractImageDimensions(bytes), expectedRatio)
  const ext = toExtFromContentType(contentType)
  const contentHash = createHash('sha1').update(bytes).digest('hex').slice(0, 12)
  const fileName = `${safeFileToken(filePrefix)}-${contentHash}${ext}`
  await mkdir(outputDir, { recursive: true })
  await writeFile(path.join(outputDir, fileName), bytes)
  return {
    imageUrl: `${String(publicBaseUrl).replace(/\/+$/, '')}/${fileName}`,
    dimensions,
  }
}

async function generateAgnesImage({ config, prompt, modelName, referenceImageUrls = [] }) {
  if (!config.apiKey) {
    throw new Error('Missing FRAME_API_KEY or AGNES_API_KEY configuration')
  }

  let response
  try {
    response = await fetch(`${config.baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelName,
        prompt,
        size: config.imageSize,
        ratio: config.imageRatio,
        extra_body: {
          response_format: 'url',
          ...(referenceImageUrls.length ? { image: referenceImageUrls } : {}),
        },
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      throw createFrameProviderError('Agnes image generation timed out', { retryable: true })
    }
    throw createFrameProviderError(
      `Agnes image request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      { retryable: true },
    )
  }

  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }

  if (!response.ok) {
    const detail =
      payload?.error?.message || payload?.message || payload?.detail || text.slice(0, 400) || `HTTP ${response.status}`
    throw createFrameProviderError(`Agnes image generation failed: ${detail}`, {
      status: response.status,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      retryable:
        response.status === 408 ||
        response.status === 409 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500,
    })
  }

  const imageUrl = String(payload?.data?.[0]?.url || '').trim()
  if (!/^https?:\/\//i.test(imageUrl)) {
    throw new Error('Agnes image generation returned no public image URL')
  }
  return imageUrl
}

async function generateAgnesImageWithRetry(args) {
  const { config } = args
  const modelNames = resolveFrameModelChain(config, args.modelName)
  let lastError = null
  const failures = []

  for (let attempt = 0; attempt <= config.retryAttempts; attempt += 1) {
    for (const modelName of modelNames) {
      try {
        const imageUrl = await generateAgnesImage({ ...args, modelName })
        return { imageUrl, modelName }
      } catch (error) {
        lastError = error
        failures.push(`${modelName}: ${error instanceof Error ? error.message : 'unknown error'}`)
        if ([401, 403].includes(Number(error?.status))) {
          throw error
        }
      }
    }

    if (modelNames.length > 1 && failures.length >= modelNames.length) {
      break
    }

    if (attempt < config.retryAttempts) {
      const retryDelayMs = Math.min(
        60000,
        Math.max(config.retryBaseDelayMs * 2 ** attempt, Number(lastError?.retryAfterMs) || 0),
      )
      await sleep(retryDelayMs)
    }
  }

  const detail = failures.slice(-modelNames.length).join(' | ')
  throw createFrameProviderError(`Agnes image generation failed after model fallback: ${detail}`, {
    status: Number(lastError?.status) || 0,
    retryable: Boolean(lastError?.retryable),
  })
}

export function resolveBigModelFrameSize(config = getFrameConfig()) {
  const supported = new Set([
    '1024x1024',
    '768x1344',
    '864x1152',
    '1344x768',
    '1152x864',
    '1440x720',
    '720x1440',
  ])
  const requested = String(config.imageSize || '').trim().toLowerCase()
  if (supported.has(requested)) return requested
  return String(config.imageRatio || '').trim() === '9:16' ? '768x1344' : '1344x768'
}

export function buildBigModelFramePayload({ config, prompt, modelName }) {
  return {
    model: modelName,
    prompt,
    size: resolveBigModelFrameSize(config),
  }
}

async function generateBigModelImage({ config, prompt, modelName }) {
  if (!config.apiKey) {
    throw new Error('Missing FRAME_API_KEY or BIGMODEL_API_KEY configuration')
  }

  let response
  try {
    response = await fetch(`${config.baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildBigModelFramePayload({ config, prompt, modelName })),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (error) {
    throw createFrameProviderError(
      `BigModel image request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      { retryable: true },
    )
  }

  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  if (!response.ok) {
    const detail =
      payload?.error?.message || payload?.message || payload?.detail || text.slice(0, 400) || `HTTP ${response.status}`
    throw createFrameProviderError(`BigModel image generation failed: ${detail}`, {
      status: response.status,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    })
  }

  const imageUrl = String(payload?.data?.[0]?.url || '').trim()
  if (!/^https?:\/\//i.test(imageUrl)) {
    throw createFrameProviderError('BigModel image generation returned no public image URL')
  }
  return imageUrl
}

async function generateBigModelImageWithRetry(args) {
  const { config } = args
  let lastError = null
  for (let attempt = 0; attempt <= config.retryAttempts; attempt += 1) {
    try {
      return await generateBigModelImage(args)
    } catch (error) {
      lastError = error
      if (!error?.retryable || [401, 403].includes(Number(error?.status)) || attempt >= config.retryAttempts) {
        throw error
      }
      const retryDelayMs = Math.min(
        60000,
        Math.max(config.retryBaseDelayMs * 2 ** attempt, Number(error?.retryAfterMs) || 0),
      )
      await sleep(retryDelayMs)
    }
  }
  throw lastError || createFrameProviderError('BigModel image generation failed')
}

export function extractToApiImageUrl(payload) {
  const values = [
    payload?.result?.data?.[0]?.url,
    payload?.data?.[0]?.url,
    payload?.result?.url,
    payload?.output?.[0]?.url,
    payload?.url,
  ]
  return String(values.find((value) => /^https?:\/\//i.test(String(value || '').trim())) || '').trim()
}

export function buildToApiGenerationPayload({ config, prompt, modelName, referenceImageUrls = [] }) {
  const normalizedReferences = referenceImageUrls
    .map((item) => String(item || '').trim())
    .filter((item) => /^https?:\/\//i.test(item))
    .slice(0, 8)
  return {
    model: modelName,
    prompt,
    n: 1,
    size: config.imageRatio,
    resolution: String(config.imageSize || '1k').toLowerCase(),
    response_format: 'url',
    ...(normalizedReferences.length ? { image_urls: normalizedReferences } : {}),
  }
}

async function requestToApiJson(url, options, config, label) {
  let response
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (error) {
    throw createFrameProviderError(
      `${label}失败：${error instanceof Error ? error.message : '未知错误'}`,
      { retryable: true },
    )
  }

  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  if (!response.ok) {
    const detail =
      payload?.error?.message || payload?.message || payload?.detail || text.slice(0, 400) || `HTTP ${response.status}`
    throw createFrameProviderError(`${label}失败：${detail}`, {
      status: response.status,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    })
  }
  if (!payload || typeof payload !== 'object') {
    const preview = String(text || '').replace(/\s+/g, ' ').slice(0, 120)
    throw createFrameProviderError(
      `${label}返回了非 JSON 响应，可能是供应商网关繁忙或限流${preview ? `：${preview}` : ''}`,
      { retryable: true },
    )
  }
  return payload
}

async function generateToApiImage({ config, prompt, modelName, referenceImageUrls = [] }) {
  if (!config.apiKey) {
    throw new Error('Missing FRAME_API_KEY or TOAPI_API_KEY configuration')
  }

  const createPayload = await requestToApiJson(
    `${config.baseUrl}/images/generations`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildToApiGenerationPayload({ config, prompt, modelName, referenceImageUrls }),
      ),
    },
    config,
    'ToAPI 图片任务创建',
  )

  const immediateUrl = extractToApiImageUrl(createPayload)
  if (immediateUrl) return immediateUrl

  const taskId = String(createPayload.id || createPayload.task_id || '').trim()
  if (!taskId) {
    throw createFrameProviderError('ToAPI 图片任务创建成功但没有返回任务 ID')
  }

  const deadline = Date.now() + config.pollTimeoutMs
  let delayMs = config.pollIntervalMs
  while (Date.now() < deadline) {
    await sleep(delayMs)
    let latest
    try {
      latest = await requestToApiJson(
        `${config.baseUrl}/images/generations/${encodeURIComponent(taskId)}`,
        { method: 'GET' },
        config,
        'ToAPI 图片状态查询',
      )
      delayMs = config.pollIntervalMs
    } catch (error) {
      if (Number(error?.status) !== 429 && !error?.retryable) throw error
      delayMs = Math.min(
        60000,
        Math.max(config.pollIntervalMs, Number(error?.retryAfterMs) || delayMs * 2),
      )
      continue
    }

    const imageUrl = extractToApiImageUrl(latest)
    const status = String(latest.status || '').trim().toLowerCase()
    if (imageUrl && (!status || ['completed', 'success', 'succeeded'].includes(status))) {
      return imageUrl
    }
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      const detail =
        latest?.error?.message ||
        latest?.result?.error?.message ||
        latest?.result?.message ||
        latest?.metadata?.error?.message ||
        latest?.metadata?.error ||
        latest?.error ||
        latest?.message ||
        status
      const taskHint = taskId ? ` (task id: ${taskId})` : ''
      throw createFrameProviderError(`ToAPI 图片生成失败：${detail}${taskHint}`)
    }
  }

  throw createFrameProviderError(`ToAPI 图片生成超时，已等待 ${config.pollTimeoutMs}ms`, {
    retryable: true,
  })
}

async function generateToApiImageWithRetry(args) {
  const { config } = args
  let lastError = null

  for (let attempt = 0; attempt <= config.retryAttempts; attempt += 1) {
    try {
      return await generateToApiImage(args)
    } catch (error) {
      lastError = error
      if (!error?.retryable || [401, 403].includes(Number(error?.status)) || attempt >= config.retryAttempts) {
        throw error
      }

      const retryDelayMs = Math.min(
        60000,
        Math.max(config.retryBaseDelayMs * 2 ** attempt, Number(error?.retryAfterMs) || 0),
      )
      await sleep(retryDelayMs)
    }
  }

  throw lastError || createFrameProviderError('ToAPI 图片生成失败')
}

export async function generateFrameCandidates({
  storyboardId,
  versionNo,
  prompt,
  negativePrompt,
  modelName,
  publicBaseUrl,
  outputDir,
  candidateCount = 1,
  referenceImageUrls = [],
}) {
  const config = getFrameConfig()
  if (isMockFrameProvider(config)) {
    throw new Error('FRAME_PROVIDER=mock')
  }
  if (!config.baseUrl) {
    throw new Error('Missing FRAME_BASE_URL configuration')
  }

  if (!['agnes', 'toapi', 'bigmodel', 'zhipu', 'trae-url'].includes(config.provider)) {
    throw new Error(`Unsupported FRAME_PROVIDER: ${config.provider}`)
  }

  const normalizedReferenceImageUrls = assertFrameReferenceImageSupport({
    config,
    modelName,
    referenceImageUrls,
  })
  const providerReferenceImageUrls = frameProviderSupportsReferenceImages(config)
    ? await resolveFrameReferenceImageUrls(normalizedReferenceImageUrls, config)
    : []

  if (!isAgnesFrameProvider(config) && !isToApiFrameProvider(config) && !isBigModelFrameProvider(config)) {
    await mkdir(outputDir, { recursive: true })
  }

  const results = []
  const totalCandidates = Math.max(1, Math.min(3, Number(candidateCount) || 1))
  for (let i = 0; i < totalCandidates; i += 1) {
    const finalPrompt = buildVariantPrompt(prompt, negativePrompt, i, config.imageRatio)
    let effectiveModel = String(modelName || '').trim() || config.defaultModel
    if (isAgnesFrameProvider(config)) {
      let imageUrl
      try {
        const generated = await generateAgnesImageWithRetry({
          config,
          prompt: finalPrompt,
          modelName: effectiveModel,
          referenceImageUrls: providerReferenceImageUrls.slice(0, 3),
        })
        imageUrl = generated.imageUrl
        effectiveModel = generated.modelName
      } catch (error) {
        if (!results.length) throw error
        console.warn(`[frame] returning ${results.length} partial candidate(s):`, error)
        break
      }
      results.push({
        imageUrl,
        thumbnailUrl: imageUrl,
        promptSnapshot: finalPrompt,
        negativePrompt: String(negativePrompt || '').trim() || null,
        modelName: effectiveModel,
      })
      continue
    }

    if (isBigModelFrameProvider(config)) {
      let imageUrl
      try {
        const remoteImageUrl = await generateBigModelImageWithRetry({
          config,
          prompt: finalPrompt,
          modelName: effectiveModel,
        })
        const persisted = await persistRemoteFrameImage({
          sourceUrl: remoteImageUrl,
          timeoutMs: config.timeoutMs,
          outputDir,
          publicBaseUrl,
          filePrefix: `shot-${storyboardId}-v${versionNo}-c${i + 1}`,
          expectedRatio: config.imageRatio,
        })
        imageUrl = persisted.imageUrl
      } catch (error) {
        if (!results.length) throw error
        console.warn(`[frame] returning ${results.length} partial candidate(s):`, error)
        break
      }
      results.push({
        imageUrl,
        thumbnailUrl: imageUrl,
        promptSnapshot: finalPrompt,
        negativePrompt: String(negativePrompt || '').trim() || null,
        modelName: effectiveModel,
      })
      continue
    }

    if (isToApiFrameProvider(config)) {
      let imageUrl
      try {
        const remoteImageUrl = await generateToApiImageWithRetry({
          config,
          prompt: finalPrompt,
          modelName: effectiveModel,
          referenceImageUrls: providerReferenceImageUrls.slice(0, 8),
        })
        const persisted = await persistRemoteFrameImage({
          sourceUrl: remoteImageUrl,
          timeoutMs: config.timeoutMs,
          outputDir,
          publicBaseUrl,
          filePrefix: `shot-${storyboardId}-v${versionNo}-c${i + 1}`,
          expectedRatio: config.imageRatio,
        })
        imageUrl = persisted.imageUrl
      } catch (error) {
        if (!results.length) throw error
        console.warn(`[frame] returning ${results.length} partial candidate(s):`, error)
        break
      }
      results.push({
        imageUrl,
        thumbnailUrl: imageUrl,
        promptSnapshot: finalPrompt,
        negativePrompt: String(negativePrompt || '').trim() || null,
        modelName: effectiveModel,
      })
      continue
    }

    const url = `${config.baseUrl}?prompt=${encodeURIComponent(finalPrompt)}&image_size=${encodeURIComponent(
      config.imageSize,
    )}`
    const { bytes, contentType } = await downloadImageBuffer(url, config.timeoutMs)
    const ext = toExtFromContentType(contentType)
    const hash = createHash('sha1')
      .update(`${storyboardId}-${versionNo}-${i + 1}-${finalPrompt}`)
      .digest('hex')
      .slice(0, 12)
    const fileName = `shot-${storyboardId}-v${versionNo}-c${i + 1}-${hash}${ext}`
    await writeFile(path.join(outputDir, fileName), bytes)
    const publicUrl = `${publicBaseUrl}/${fileName}`
    results.push({
      imageUrl: publicUrl,
      thumbnailUrl: publicUrl,
      promptSnapshot: finalPrompt,
      negativePrompt: String(negativePrompt || '').trim() || null,
      modelName: effectiveModel,
    })
  }

  return results
}

const CHARACTER_REFERENCE_NEGATIVE_PROMPT = [
  '黑白照片',
  '灰度照片',
  '单色',
  '黑色电影',
  'noir',
  'film noir',
  '低照度',
  '强阴影',
  '过暗',
  'colorless',
  'monochrome',
  'grayscale',
  'black and white',
  'multiple people',
  'duplicate body',
  'extra limbs',
  'obscured face',
  'cropped head',
  'inconsistent costume',
  'text',
  'watermark',
].join(', ')

function cleanCharacterReferencePrompt(value) {
  return String(value || '')
    .replace(/黑色电影风格|黑白灰为主|黑白照片|灰度照片|单色照片|单色|film noir|noir\s*氛围|noir|低照度|高反差|强阴影/gi, '')
    .replace(/[，,、]\s*[，,、]+/g, '，')
    .replace(/^[，,、\s]+|[，,、\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildCharacterReferencePrompt({ character, prompt } = {}) {
  return [
    cleanCharacterReferencePrompt(prompt),
    `彩色写实人物定妆照，自然肤色，清晰五官，正面半身或四分之三身，标准棚拍光线，浅灰或纯色背景，用于后续角色一致性参考`,
    `professional full-color character design reference for ${character?.name || 'the character'}`,
    character?.roleTag ? `角色身份：${character.roleTag}` : '',
    character?.personality ? `通过站姿和眼神体现性格：${character.personality}` : '',
    character?.appearance ? `固定外貌、发型、服装和随身物件：${character.appearance}` : '',
    '单人出镜，脸部无遮挡，发型和服装清楚可见，人物比例自然，中性棚拍效果，色彩正常明亮，不要文字',
  ]
    .filter(Boolean)
    .join(', ')
}

export function generateCharacterImageCandidates({
  characterId,
  versionNo,
  character,
  projectVisualStyle,
  prompt,
  modelName,
  publicBaseUrl,
  outputDir,
  candidateCount = 1,
  referenceImageUrls = [],
}) {
  void projectVisualStyle
  const profilePrompt = buildCharacterReferencePrompt({ character, prompt })

  return generateFrameCandidates({
    storyboardId: `character-${characterId}`,
    versionNo,
    prompt: profilePrompt,
    negativePrompt: CHARACTER_REFERENCE_NEGATIVE_PROMPT,
    modelName,
    publicBaseUrl,
    outputDir,
    candidateCount,
    referenceImageUrls,
  })
}
