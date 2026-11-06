import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeObjectKey } from './object-storage.mjs'
import { resolveVideoImageInput } from './video.mjs'
import {
  getFrameProviderCapabilities,
  assertFrameReferenceImageSupport as assertProviderReferenceImageSupport,
} from './frame-provider-capabilities.mjs'

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
  error.code = String(options.code || '').trim() || null
  error.upstreamHost = String(options.upstreamHost || '').trim() || null
  return error
}

function describeAgnesNetworkFailure(error, endpoint) {
  let host = ''
  try {
    host = new URL(endpoint).host
  } catch {
    host = 'unknown-host'
  }
  const cause = error?.cause || {}
  const causeCode = String(cause.code || error?.code || '').trim()
  const causeMessage = String(cause.message || '').trim()
  const reason = causeCode || causeMessage || '上游连接未建立'
  return {
    message: `Agnes image request failed: ${reason} (upstream ${host})`,
    code: causeCode || 'UPSTREAM_NETWORK_ERROR',
    host,
  }
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

function buildImageStorageKey({
  projectId,
  ownerId,
  ownerType,
  versionNo,
  candidateNo,
  extension,
  errorMessage,
}) {
  const normalizedProjectId = Number(projectId)
  const normalizedOwnerId = Number(ownerId)
  const normalizedOwnerType = String(ownerType || '').trim()
  const normalizedVersionNo = Number(versionNo)
  const normalizedCandidateNo = Number(candidateNo)
  const normalizedExtension = String(extension || '').trim().toLowerCase()
  if (
    !Number.isSafeInteger(normalizedProjectId) ||
    normalizedProjectId <= 0 ||
    !Number.isSafeInteger(normalizedOwnerId) ||
    normalizedOwnerId <= 0 ||
    !['storyboards', 'characters', 'asset-nodes'].includes(normalizedOwnerType) ||
    !Number.isSafeInteger(normalizedVersionNo) ||
    normalizedVersionNo <= 0 ||
    !Number.isSafeInteger(normalizedCandidateNo) ||
    normalizedCandidateNo <= 0 ||
    !['.png', '.jpg', '.jpeg', '.webp'].includes(normalizedExtension)
  ) {
    throw new Error(errorMessage)
  }
  // 三种归属方共用一套图片键构造，避免出现「平行实现」后其中一份漏掉校验。
  // asset-nodes 必须独立前缀：节点 id 与 storyboard id 会撞号，共前缀会互相覆盖。
  return normalizeObjectKey(
    `projects/${normalizedProjectId}/frames/${normalizedOwnerType}/${normalizedOwnerId}/v${normalizedVersionNo}/c${normalizedCandidateNo}${normalizedExtension}`,
  )
}

export function buildGeneratedFrameStorageKey(args) {
  return buildImageStorageKey({
    projectId: args?.projectId,
    ownerId: args?.storyboardId,
    ownerType: 'storyboards',
    versionNo: args?.versionNo,
    candidateNo: args?.candidateNo,
    extension: args?.extension,
    errorMessage: 'invalid generated frame storage key',
  })
}

export function buildCharacterImageStorageKey(args) {
  return buildImageStorageKey({
    projectId: args?.projectId,
    ownerId: args?.characterId,
    ownerType: 'characters',
    versionNo: args?.versionNo,
    candidateNo: args?.candidateNo,
    extension: args?.extension,
    errorMessage: 'invalid character image storage key',
  })
}

export function buildAssetNodeImageStorageKey(args) {
  return buildImageStorageKey({
    projectId: args?.projectId,
    ownerId: args?.assetNodeId,
    ownerType: 'asset-nodes',
    versionNo: args?.versionNo,
    candidateNo: args?.candidateNo,
    extension: args?.extension,
    errorMessage: 'invalid asset node image storage key',
  })
}

export function extractImageDimensions(value) {
  // 不依赖图片处理库，直接读取常见图片格式的文件头拿宽高。
  // 这样可以在图片入库前校验是否符合项目要求的 16:9 / 9:16 / 1:1。
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
  // 供应商返回的图片比例不一定严格符合请求参数。
  // 如果偏差超过容忍度，就拒绝入库，避免后面视频和导出阶段出现画面变形。
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
        : provider === 'volcengine'
          ? 'https://ark.cn-beijing.volces.com/api/v3'
        : provider === 'bigmodel' || provider === 'zhipu'
          ? 'https://open.bigmodel.cn/api/paas/v4'
        : 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image'
  const configuredBaseUrl = normalizeBaseUrl(process.env.FRAME_BASE_URL || '')
  const baseUrl = provider === 'volcengine' && /agnes-ai\.com/i.test(configuredBaseUrl)
    ? 'https://ark.cn-beijing.volces.com/api/v3'
    : configuredBaseUrl || defaultBaseUrl
  const configuredModel = String(process.env.FRAME_MODEL || '').trim()
  const defaultModel = provider === 'volcengine' && /^agnes-/i.test(configuredModel)
    ? 'doubao-seedream-5-0-flash-260915'
    : configuredModel || (
      provider === 'agnes'
        ? 'agnes-image-2.1-flash'
        : provider === 'toapi'
          ? 'gpt-image-2'
          : provider === 'volcengine'
            ? 'doubao-seedream-5-0-flash-260915'
            : provider === 'bigmodel' || provider === 'zhipu'
              ? 'cogview-3-flash'
              : 'trae-text2image-v1'
    )
  return {
    provider,
    baseUrl,
    apiKey: String(
      provider === 'volcengine'
        ? process.env.ARK_API_KEY || process.env.VOLCENGINE_API_KEY || ''
        : process.env.FRAME_API_KEY ||
          (provider === 'bigmodel' || provider === 'zhipu'
            ? process.env.BIGMODEL_API_KEY || process.env.ZHIPU_API_KEY
            : provider === 'agnes'
              ? process.env.AGNES_API_KEY
              : provider === 'toapi'
                ? process.env.TOAPI_API_KEY
                : process.env.TOAPI_API_KEY || process.env.AGNES_API_KEY) ||
          '',
    ).trim(),
    imageSize: String(
      process.env.FRAME_IMAGE_SIZE ||
        (provider === 'agnes'
          ? '2K'
          : provider === 'toapi'
            ? '2k'
            : provider === 'volcengine'
              ? '2K'
            : provider === 'bigmodel' || provider === 'zhipu'
              ? '1344x768'
              : 'landscape_16_9'),
    ).trim(),
    imageRatio: String(process.env.FRAME_IMAGE_RATIO || '16:9').trim(),
    defaultModel,
    assetPackModel: String(
      provider === 'volcengine' && /^agnes-/i.test(String(process.env.FRAME_ASSET_PACK_MODEL || '').trim())
        ? 'doubao-seedream-5-0-flash-260915'
        : process.env.FRAME_ASSET_PACK_MODEL ||
          (provider === 'volcengine' ? 'doubao-seedream-5-0-flash-260915' : '') ||
          process.env.FRAME_MODEL ||
          '',
    ).trim(),
    characterAssetPackEnabled: parseBoolean(
      process.env.FRAME_CHARACTER_ASSET_PACK_ENABLED,
      provider === 'volcengine' || provider === 'agnes',
    ),
    fallbackModels: parseFrameModelList(
      process.env.FRAME_FALLBACK_MODELS || (provider === 'agnes' ? 'agnes-image-2.0-flash' : ''),
    ).filter((modelName) => provider !== 'volcengine' || !/^agnes-/i.test(modelName)),
    timeoutMs: Number(process.env.FRAME_TIMEOUT_MS || 90000) || 90000,
    retryAttempts: parseNonNegativeInt(process.env.FRAME_RETRY_ATTEMPTS, 2),
    retryBaseDelayMs: parsePositiveInt(process.env.FRAME_RETRY_BASE_DELAY_MS, 5000),
    pollIntervalMs: parsePositiveInt(process.env.FRAME_POLL_INTERVAL_MS, 6000),
    pollTimeoutMs: parsePositiveInt(process.env.FRAME_POLL_TIMEOUT_MS, 180000),
    fallbackToMock: parseBoolean(process.env.FRAME_FALLBACK_TO_MOCK, true),
    // 资产参考图不能带供应商水印；显式传 true 仍允许用户为非资产场景打开。
    watermarkEnabled: parseBoolean(process.env.FRAME_WATERMARK_ENABLED, false),
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
  // 模型降级链：优先使用用户请求模型，再尝试环境变量配置的备用模型。
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

function isVolcengineFrameProvider(config) {
  return config.provider === 'volcengine'
}

function isBigModelFrameProvider(config) {
  return config.provider === 'bigmodel' || config.provider === 'zhipu'
}

export function normalizeFrameReferenceImageUrls(referenceImageUrls = [], limit = 8, { includeDataUrls = false } = {}) {
  return referenceImageUrls
    .map((item) => String(item || '').trim())
    .filter((item) => /^https?:\/\//i.test(item) || (includeDataUrls && /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(item)))
    .slice(0, limit)
}

export function resolveFrameImageRatio(config = getFrameConfig(), requestedRatio = '') {
  const requested = String(requestedRatio || '').trim()
  if (['16:9', '9:16', '1:1'].includes(requested)) return requested
  return String(config.imageRatio || '16:9').trim()
}

export function frameProviderSupportsReferenceImages(config = getFrameConfig()) {
  return getFrameProviderCapabilities(config.provider).supportsReferenceImages
}

export function assertFrameReferenceImageSupport({
  config = getFrameConfig(),
  modelName = '',
  referenceImageUrls = [],
  referenceImageStorageKeys = [],
} = {}) {
  const supportsInlineReferences = isAgnesFrameProvider(config) || isVolcengineFrameProvider(config)
  const normalizedReferences = normalizeFrameReferenceImageUrls(referenceImageUrls, 8, {
    includeDataUrls: supportsInlineReferences,
  })
  return assertProviderReferenceImageSupport({
    provider: config.provider,
    modelName: String(modelName || config.defaultModel || '').trim(),
    referenceImageUrls: normalizedReferences,
    referenceImageStorageKeys,
  })
}

export async function resolveFrameReferenceImageUrls(
  referenceImageUrls = [],
  config = getFrameConfig(),
  { referenceImageStorageKeys = [], createSignedUrl } = {},
) {
  const supportsInlineReferences = isAgnesFrameProvider(config) || isVolcengineFrameProvider(config)
  const storageKeys = [...new Set((Array.isArray(referenceImageStorageKeys) ? referenceImageStorageKeys : [])
    .map((key) => String(key || '').trim()).filter(Boolean))]
  let sourceReferences = referenceImageUrls
  if (storageKeys.length) {
    if (typeof createSignedUrl !== 'function') {
      throw createFrameProviderError('无法刷新已锁定的人物参考图：对象存储签名服务不可用', { retryable: false })
    }
    try {
      const legacyReferences = (Array.isArray(referenceImageUrls) ? referenceImageUrls : []).filter((url) => {
        try {
          const pathname = decodeURIComponent(new URL(String(url)).pathname).replace(/^\/storage\//, '')
          return !storageKeys.some((key) => pathname.endsWith(key))
        } catch {
          return true
        }
      })
      sourceReferences = [
        ...storageKeys.map((key) => createSignedUrl(key)),
        ...legacyReferences,
      ]
    } catch {
      throw createFrameProviderError('无法刷新已锁定的人物参考图：对象不存在或签名失败', { retryable: false })
    }
  }
  const normalizedReferences = normalizeFrameReferenceImageUrls(sourceReferences, 8, {
    includeDataUrls: supportsInlineReferences,
  })
  if (isAgnesFrameProvider(config) || isVolcengineFrameProvider(config)) {
    return Promise.all(
      normalizedReferences.map((url) => resolveAgnesReferenceImageUrl(url, config)),
    )
  }
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

const MAX_AGNES_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024

function isPrivateReferenceHost(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  const hostname = parsed.hostname.toLowerCase()
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname.startsWith('127.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  )
}

async function resolveAgnesReferenceImageUrl(url, config) {
  if (/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(String(url || '').trim())) {
    return String(url).trim()
  }
  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(config.referenceUploadTimeoutMs),
    })
  } catch (error) {
    throw createFrameProviderError(
      `参考图读取失败，无法转换为 Agnes 可读图片：${error instanceof Error ? error.message : 'unknown error'}`,
      { retryable: false },
    )
  }
  if (!response.ok) {
    throw createFrameProviderError(
      `参考图读取失败，HTTP ${response.status}`,
      { retryable: false },
    )
  }

  const contentType = String(response.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType)) {
    throw createFrameProviderError(
      `参考图读取失败，响应不是支持的图片类型：${contentType || 'unknown'}`,
      { retryable: false },
    )
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.length || bytes.length > MAX_AGNES_REFERENCE_IMAGE_BYTES) {
    throw createFrameProviderError(
      `参考图读取失败，图片大小必须在 1 到 ${MAX_AGNES_REFERENCE_IMAGE_BYTES} 字节之间`,
      { retryable: false },
    )
  }
  return `data:${contentType};base64,${bytes.toString('base64')}`
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

function resolveVariantInstructions(generationContext = 'cinematic-frame') {
  if (generationContext === 'scene-environment') {
    return [
      'single empty environment reference photograph, no people, preserve the supplied architecture and fixed furniture layout',
      'single empty environment reference photograph, no people, preserve the same architecture, material finish, light direction and fixed furniture layout',
      'single empty environment reference photograph, no people, preserve the same room geometry and all fixed spatial anchors without restaging',
    ]
  }
  if (generationContext === 'character-reference') {
    return [
      'primary character reference image, preserve the locked face, hair, wardrobe and body proportions',
      'character reference image, preserve the locked face, hair, wardrobe and body proportions under a consistent camera treatment',
      'character reference image, preserve the locked identity, clothing silhouette and accessory placement with natural detail',
    ]
  }
  return [
    'primary cinematic keyframe, preserve the core action and blocking, coherent character design',
    'alternate composition, stronger lighting contrast, richer atmosphere, film still quality',
    'alternative camera treatment, deeper depth, stronger texture detail, premium cinematic still',
  ]
}

export function buildVariantPrompt(
  basePrompt,
  negativePrompt,
  variantIndex,
  imageRatio,
  generationContext = 'cinematic-frame',
) {
  const variants = resolveVariantInstructions(generationContext)

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
  const request = (target) => fetch(target, {
    method: 'GET',
    signal: AbortSignal.timeout(timeoutMs),
  })
  let response
  try {
    response = await request(url)
  } catch (error) {
    // Agnes currently serves generated objects from a host whose TLS
    // certificate does not match the hostname. Restrict the HTTP fallback to
    // this exact vendor output host, then persist the bytes into COS before
    // returning them to the application.
    const parsed = new URL(String(url))
    const isKnownAgnesOutput = parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === 'platform-outputs.agnes-ai.space'
    if (!isKnownAgnesOutput) throw error
    const bytes = await downloadAgnesOutputWithCurl(url, timeoutMs)
    response = {
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => bytes,
    }
  }

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

function decodeImageDataUrl(value) {
  const match = String(value || '').match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/)
  if (!match) throw new Error('Generated image returned an invalid inline data URL')
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length) throw new Error('Generated image returned empty inline data')
  return { bytes, contentType: match[1] }
}

function downloadAgnesOutputWithCurl(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? 'curl.exe' : 'curl'
    const timeoutSeconds = Math.max(10, Math.ceil(Number(timeoutMs || 90000) / 1000))
    const child = spawn(command, [
      '--insecure',
      '--location',
      '--fail',
      '--silent',
      '--show-error',
      '--max-time',
      String(timeoutSeconds),
      url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    const errors = []
    child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => errors.push(Buffer.from(chunk)))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Agnes 图片下载失败（curl ${code}）：${Buffer.concat(errors).toString('utf8').trim()}`))
        return
      }
      const bytes = Buffer.concat(chunks)
      if (!bytes.length) {
        reject(new Error('Agnes 图片下载为空'))
        return
      }
      resolve(bytes)
    })
  })
}

export async function persistRemoteFrameImage({
  sourceUrl,
  sourceDataUrl,
  timeoutMs,
  outputDir,
  publicBaseUrl,
  filePrefix,
  expectedRatio,
}) {
  // 把供应商远程图片下载到本地，并在保存前完成格式、大小、比例校验。
  // 返回的 publicUrl 会写入 image_assets，页面之后直接使用这个 URL。
  if (!outputDir || !publicBaseUrl) {
    return { imageUrl: sourceDataUrl || sourceUrl, dimensions: null }
  }

  const { bytes, contentType } = sourceDataUrl
    ? decodeImageDataUrl(sourceDataUrl)
    : await downloadImageBuffer(sourceUrl, timeoutMs)
  const dimensions = assertFrameImageRatio(extractImageDimensions(bytes), expectedRatio)
  const ext = toExtFromContentType(contentType)
  const contentHash = createHash('sha1').update(bytes).digest('hex').slice(0, 12)
  const fileName = `${safeFileToken(filePrefix)}-${contentHash}${ext}`
  await mkdir(outputDir, { recursive: true })
  await writeFile(path.join(outputDir, fileName), bytes)
  return {
    imageUrl: `${String(publicBaseUrl).replace(/\/+$/, '')}/${fileName}`,
    filePath: path.join(outputDir, fileName),
    dimensions,
  }
}

export function buildAgnesGenerationPayload({
  config,
  prompt,
  modelName,
  imageRatio = '',
  referenceImageUrls = [],
}) {
  const image = referenceImageUrls.length === 1 ? referenceImageUrls[0] : referenceImageUrls
  return {
    model: modelName,
    prompt,
    size: config.imageSize,
    ratio: resolveFrameImageRatio(config, imageRatio),
    extra_body: {
      // Agnes 的输出域名在部分网络会返回跳转页，直接取 base64 可以把供应商
      // 的真实图片内容带回本地，再统一落盘和校验。
      response_format: 'b64_json',
      ...(referenceImageUrls.length ? { image } : {}),
    },
  }
}

export function resolveFrameGenerationEndpoint({ baseUrl } = {}) {
  const normalized = normalizeBaseUrl(baseUrl)
  if (!normalized) return ''
  return /\/images\/generations$/i.test(normalized)
    ? normalized
    : `${normalized}/images/generations`
}

export function normalizeVolcengineModelName(value) {
  const modelName = String(value || '').trim()
  return modelName
    .replace(/^doubao-seedream-4\.5-251128$/i, 'doubao-seedream-4-5-251128')
    .replace(/^seedream-5\.0-flash$/i, 'doubao-seedream-5-0-flash-260915')
}

export function resolveVolcengineImageSize(config = {}, imageRatio = '') {
  const requested = String(config.imageSize || '').trim().toLowerCase()
  if (/^\d+x\d+$/.test(requested)) return requested

  const ratio = String(imageRatio || config.imageRatio || '16:9').trim()
  const dimensionsByRatio = {
    '9:16': '1152x2048',
    '1:1': '2048x2048',
    '4:3': '2048x1536',
    '3:4': '1536x2048',
    '3:2': '2048x1365',
    '2:3': '1365x2048',
    '16:9': '2048x1152',
  }
  return dimensionsByRatio[ratio] || '2048x1152'
}

export function buildVolcengineGenerationPayload({
  config,
  prompt,
  modelName,
  imageRatio = '',
  referenceImageUrls = [],
}) {
  const image = referenceImageUrls.length === 1 ? referenceImageUrls[0] : referenceImageUrls
  return {
    model: normalizeVolcengineModelName(modelName),
    prompt,
    size: resolveVolcengineImageSize(config, imageRatio),
    stream: false,
    response_format: 'url',
    watermark: config.watermarkEnabled !== false,
    ...(referenceImageUrls.length ? { image } : {}),
  }
}

async function generateAgnesImage({
  config,
  prompt,
  modelName,
  imageRatio = '',
  referenceImageUrls = [],
}) {
  if (!config.apiKey) {
    throw new Error('Missing FRAME_API_KEY or AGNES_API_KEY configuration')
  }

  const endpoint = resolveFrameGenerationEndpoint({ baseUrl: config.baseUrl })
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        buildAgnesGenerationPayload({
          config,
          prompt,
          modelName,
          imageRatio,
          referenceImageUrls,
        }),
      ),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      const host = new URL(endpoint).host
      throw createFrameProviderError(`Agnes image generation timed out (upstream ${host})`, {
        retryable: true,
        code: 'UPSTREAM_TIMEOUT',
        upstreamHost: host,
      })
    }
    const failure = describeAgnesNetworkFailure(error, endpoint)
    throw createFrameProviderError(
      failure.message,
      { retryable: true, code: failure.code, upstreamHost: failure.host },
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

  const item = payload?.data?.[0] || {}
  const base64 = String(item.b64_json || '').trim()
  if (base64) {
    const contentType = String(item.mime_type || item.content_type || 'image/png').trim()
    return { sourceDataUrl: `data:${contentType};base64,${base64}` }
  }

  const imageUrl = String(item.url || '').trim()
  if (!/^https?:\/\//i.test(imageUrl)) {
    throw new Error('Agnes image generation returned neither inline image data nor a public image URL')
  }
  return { sourceUrl: imageUrl }
}

async function generateAgnesImageWithRetry(args) {
  const { config } = args
  const modelNames = resolveFrameModelChain(config, args.modelName)
  let lastError = null
  const failures = []

  for (let attempt = 0; attempt <= config.retryAttempts; attempt += 1) {
    for (const modelName of modelNames) {
      try {
        const generated = await generateAgnesImage({ ...args, modelName })
        return { ...generated, modelName }
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

async function generateVolcengineImage({
  config,
  prompt,
  modelName,
  imageRatio = '',
  referenceImageUrls = [],
}) {
  if (!config.apiKey) {
    throw new Error('Missing FRAME_API_KEY or Volcengine API key configuration')
  }

  let response
  try {
    response = await fetch(resolveFrameGenerationEndpoint(config), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        buildVolcengineGenerationPayload({
          config,
          prompt,
          modelName,
          imageRatio,
          referenceImageUrls,
        }),
      ),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      throw createFrameProviderError('Volcengine image generation timed out', { retryable: true })
    }
    throw createFrameProviderError(
      `Volcengine image request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
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
      payload?.error?.message ||
      payload?.message ||
      payload?.detail ||
      text.slice(0, 400) ||
      `HTTP ${response.status}`
    throw createFrameProviderError(`Volcengine image generation failed: ${detail}`, {
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
    throw new Error('Volcengine image generation returned no public image URL')
  }
  return imageUrl
}

async function generateVolcengineImageWithRetry(args) {
  const { config } = args
  const modelNames = resolveFrameModelChain(config, args.modelName)
  let lastError = null
  const failures = []

  for (let attempt = 0; attempt <= config.retryAttempts; attempt += 1) {
    for (const modelName of modelNames) {
      try {
        const imageUrl = await generateVolcengineImage({ ...args, modelName })
        return { imageUrl, modelName }
      } catch (error) {
        lastError = error
        failures.push(`${modelName}: ${error instanceof Error ? error.message : 'unknown error'}`)
        if ([401, 403].includes(Number(error?.status))) throw error
      }
    }

    if (modelNames.length > 1 && failures.length >= modelNames.length) break
    if (attempt < config.retryAttempts) {
      const retryDelayMs = Math.min(
        60000,
        Math.max(config.retryBaseDelayMs * 2 ** attempt, Number(lastError?.retryAfterMs) || 0),
      )
      await sleep(retryDelayMs)
    }
  }

  const detail = failures.slice(-modelNames.length).join(' | ')
  throw createFrameProviderError(`Volcengine image generation failed after model fallback: ${detail}`, {
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

export function buildToApiGenerationPayload({
  config,
  prompt,
  modelName,
  imageRatio = '',
  referenceImageUrls = [],
}) {
  const normalizedReferences = referenceImageUrls
    .map((item) => String(item || '').trim())
    .filter((item) => /^https?:\/\//i.test(item))
    .slice(0, 8)
  return {
    model: modelName,
    prompt,
    n: 1,
    size: resolveFrameImageRatio(config, imageRatio),
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

async function generateToApiImage({
  config,
  prompt,
  modelName,
  imageRatio = '',
  referenceImageUrls = [],
}) {
  if (!config.apiKey) {
    throw new Error('Missing FRAME_API_KEY or TOAPI_API_KEY configuration')
  }

  const createPayload = await requestToApiJson(
    `${config.baseUrl}/images/generations`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildToApiGenerationPayload({
          config,
          prompt,
          modelName,
          imageRatio,
          referenceImageUrls,
        }),
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
  imageRatio = '',
  referenceImageUrls = [],
  referenceImageStorageKeys = [],
  createSignedUrl,
  generationContext = 'cinematic-frame',
}) {
  // 统一的图片生成入口：
  // 根据 provider 选择具体供应商，执行重试/模型降级，最后返回本地持久化后的候选图片。
  const config = getFrameConfig()
  if (isMockFrameProvider(config)) {
    throw new Error('FRAME_PROVIDER=mock')
  }
  if (!config.baseUrl) {
    throw new Error('Missing FRAME_BASE_URL configuration')
  }

  if (!['agnes', 'toapi', 'volcengine', 'bigmodel', 'zhipu', 'trae-url'].includes(config.provider)) {
    throw new Error(`Unsupported FRAME_PROVIDER: ${config.provider}`)
  }

  const normalizedReferenceImageUrls = assertFrameReferenceImageSupport({
    config,
    modelName,
    referenceImageUrls,
    referenceImageStorageKeys,
  })
  const providerReferenceImageUrls = frameProviderSupportsReferenceImages(config)
    ? await resolveFrameReferenceImageUrls(normalizedReferenceImageUrls, config, {
        referenceImageStorageKeys,
        createSignedUrl,
      })
    : []
  const providerReferenceLimit = getFrameProviderCapabilities(config.provider).maxReferenceImages || 0

  if (
    !isAgnesFrameProvider(config) &&
    !isToApiFrameProvider(config) &&
    !isVolcengineFrameProvider(config) &&
    !isBigModelFrameProvider(config)
  ) {
    await mkdir(outputDir, { recursive: true })
  }

  const results = []
  const effectiveImageRatio = resolveFrameImageRatio(config, imageRatio)
  const requestConfig = { ...config, imageRatio: effectiveImageRatio }
  const totalCandidates = Math.max(1, Math.min(3, Number(candidateCount) || 1))
  for (let i = 0; i < totalCandidates; i += 1) {
    const finalPrompt = buildVariantPrompt(
      prompt,
      negativePrompt,
      i,
      effectiveImageRatio,
      generationContext,
    )
    let effectiveModel = String(modelName || '').trim() || config.defaultModel
    if (isAgnesFrameProvider(config)) {
      let imageUrl
      let filePath
      try {
        const generated = await generateAgnesImageWithRetry({
          config: requestConfig,
          prompt: finalPrompt,
          modelName: effectiveModel,
          imageRatio: effectiveImageRatio,
          referenceImageUrls: providerReferenceImageUrls.slice(0, providerReferenceLimit),
        })
        const persisted = await persistRemoteFrameImage({
          sourceUrl: generated.sourceUrl,
          sourceDataUrl: generated.sourceDataUrl,
          timeoutMs: config.timeoutMs,
          outputDir,
          publicBaseUrl,
          filePrefix: `shot-${storyboardId}-v${versionNo}-c${i + 1}`,
          expectedRatio: effectiveImageRatio,
        })
        imageUrl = persisted.imageUrl
        filePath = persisted.filePath
        effectiveModel = generated.modelName
      } catch (error) {
        if (!results.length) throw error
        console.warn(`[frame] returning ${results.length} partial candidate(s):`, error)
        break
      }
      results.push({
        imageUrl,
        filePath,
        thumbnailUrl: imageUrl,
        promptSnapshot: finalPrompt,
        negativePrompt: String(negativePrompt || '').trim() || null,
        modelName: effectiveModel,
      })
      continue
    }

    if (isVolcengineFrameProvider(config)) {
      let imageUrl
      let filePath
      try {
        const generated = await generateVolcengineImageWithRetry({
          config: requestConfig,
          prompt: finalPrompt,
          modelName: effectiveModel,
          imageRatio: effectiveImageRatio,
          referenceImageUrls: providerReferenceImageUrls.slice(0, providerReferenceLimit),
        })
        const persisted = await persistRemoteFrameImage({
          sourceUrl: generated.imageUrl,
          timeoutMs: config.timeoutMs,
          outputDir,
          publicBaseUrl,
          filePrefix: `shot-${storyboardId}-v${versionNo}-c${i + 1}`,
          expectedRatio: effectiveImageRatio,
        })
        imageUrl = persisted.imageUrl
        filePath = persisted.filePath
        effectiveModel = generated.modelName
      } catch (error) {
        if (!results.length) throw error
        console.warn(`[frame] returning ${results.length} partial candidate(s):`, error)
        break
      }
      results.push({
        imageUrl,
        filePath,
        thumbnailUrl: imageUrl,
        promptSnapshot: finalPrompt,
        negativePrompt: String(negativePrompt || '').trim() || null,
        modelName: effectiveModel,
      })
      continue
    }

    if (isBigModelFrameProvider(config)) {
      let imageUrl
      let filePath
      try {
        const remoteImageUrl = await generateBigModelImageWithRetry({
          config: requestConfig,
          prompt: finalPrompt,
          modelName: effectiveModel,
        })
        const persisted = await persistRemoteFrameImage({
          sourceUrl: remoteImageUrl,
          timeoutMs: config.timeoutMs,
          outputDir,
          publicBaseUrl,
          filePrefix: `shot-${storyboardId}-v${versionNo}-c${i + 1}`,
          expectedRatio: effectiveImageRatio,
        })
        imageUrl = persisted.imageUrl
        filePath = persisted.filePath
      } catch (error) {
        if (!results.length) throw error
        console.warn(`[frame] returning ${results.length} partial candidate(s):`, error)
        break
      }
      results.push({
        imageUrl,
        filePath,
        thumbnailUrl: imageUrl,
        promptSnapshot: finalPrompt,
        negativePrompt: String(negativePrompt || '').trim() || null,
        modelName: effectiveModel,
      })
      continue
    }

    if (isToApiFrameProvider(config)) {
      let imageUrl
      let filePath
      try {
        const remoteImageUrl = await generateToApiImageWithRetry({
          config: requestConfig,
          prompt: finalPrompt,
          modelName: effectiveModel,
          imageRatio: effectiveImageRatio,
          referenceImageUrls: providerReferenceImageUrls.slice(0, providerReferenceLimit),
        })
        const persisted = await persistRemoteFrameImage({
          sourceUrl: remoteImageUrl,
          timeoutMs: config.timeoutMs,
          outputDir,
          publicBaseUrl,
          filePrefix: `shot-${storyboardId}-v${versionNo}-c${i + 1}`,
          expectedRatio: effectiveImageRatio,
        })
        imageUrl = persisted.imageUrl
        filePath = persisted.filePath
      } catch (error) {
        if (!results.length) throw error
        console.warn(`[frame] returning ${results.length} partial candidate(s):`, error)
        break
      }
      results.push({
        imageUrl,
        filePath,
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
      filePath: path.join(outputDir, fileName),
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
    `彩色写实人物定妆照，基础正面全身照，自然肤色，清晰五官，人物正面平视站立，从头顶到鞋底完整入镜，标准棚拍光线，纯白背景（#FFFFFF），用于后续角色一致性参考`,
    `professional full-color character design reference for ${character?.name || 'the character'}`,
    character?.roleTag ? `角色身份：${character.roleTag}` : '',
    character?.personality ? `通过站姿和眼神体现性格：${character.personality}` : '',
    character?.appearance ? `固定外貌、发型、服装和随身物件：${character.appearance}` : '',
    '单人出镜，脸部无遮挡，头发、固定服装、鞋子和全部配饰清楚可见，鞋子全部入镜；这是基础正面全身图，服装与配饰是后续三视图唯一穿搭基准，不得改色、换款或增删；人物比例自然，人物完整不裁切，四周留安全边距，中性棚拍效果，色彩正常明亮，不要文字、场景、道具、拼贴或九宫格',
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
