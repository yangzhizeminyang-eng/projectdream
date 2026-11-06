import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { buildColorContinuityConstraints } from './color-continuity.mjs'

const execFileAsync = promisify(execFile)

function parseBoolean(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue
  const normalized = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return defaultValue
}

function parsePositiveInt(value, defaultValue) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue
}

function parseNonNegativeInt(value, defaultValue) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : defaultValue
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

const MINIMAX_VIDEO_PROMPT_MAX_CHARS = 6800

export function compactMiniMaxVideoPrompt(prompt, maxChars = MINIMAX_VIDEO_PROMPT_MAX_CHARS) {
  const normalized = String(prompt || '').replace(/\s+/g, ' ').trim()
  const limit = Math.max(256, Math.floor(Number(maxChars) || MINIMAX_VIDEO_PROMPT_MAX_CHARS))
  const characters = Array.from(normalized)
  if (characters.length <= limit) return normalized

  const suffix = '；已省略冗余资产生成模板，严格以已确认参考图和本镜动作执行。'
  return `${characters.slice(0, Math.max(1, limit - Array.from(suffix).length)).join('').trim()}${suffix}`
}

const MAX_VIDEO_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_WAN_MEDIA_BYTES = 20 * 1024 * 1024
const MAX_WAN_REFERENCE_IMAGES = 9
const MAX_AGNES_MULTI_REFERENCE_IMAGES = 6
const MAX_OFFICIAL_AGNES_REFERENCE_IMAGES = 5
const MAX_OFFICIAL_AGNES_REFERENCE_AUDIOS = 3
const videoSourceUploadCache = new Map()
let videoCreationGate = Promise.resolve()
let videoCreationTimestamps = []
const VIDEO_SOURCE_PREPARATION_CONCURRENCY = 2
let activeVideoSourcePreparations = 0
const pendingVideoSourcePreparations = []

function uniqueReferences(values, limit, label) {
  const references = [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )]
  if (references.length > limit) {
    throw new Error(`${label}本次绑定 ${references.length} 张参考图，模型最多接收 ${limit} 张；已阻止静默丢弃资产引用。`)
  }
  return references
}

function requireProviderDuration(value, min, max, label) {
  const duration = Number(value)
  if (!Number.isInteger(duration) || duration < min || duration > max) {
    throw new Error(`${label}单镜时长必须是 ${min}-${max} 秒整数，当前为 ${String(value ?? '未设置')} 秒；不会自动改写剧本时长。`)
  }
  return duration
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

export function getVideoConfig() {
  const provider = String(process.env.VIDEO_PROVIDER || 'mock').trim().toLowerCase()
  const defaultBaseUrl =
    provider === 'bigmodel' || provider === 'zhipu'
      ? 'https://open.bigmodel.cn/api/paas/v4'
      : provider === 'minimax'
        ? 'https://api.minimax.cn'
        : provider === 'wan'
          ? 'https://dashscope.aliyuncs.com'
          : 'https://apihub.agnes-ai.com'
  return {
    provider,
    baseUrl: normalizeBaseUrl(
      process.env.VIDEO_BASE_URL ||
        (provider === 'wan' ? process.env.WAN_API_BASE_URL : '') ||
        defaultBaseUrl,
    ),
    apiKey: String(
      process.env.VIDEO_API_KEY ||
        (provider === 'bigmodel' || provider === 'zhipu'
          ? process.env.BIGMODEL_API_KEY || process.env.ZHIPU_API_KEY
          : provider === 'minimax'
            ? process.env.MINIMAX_API_KEY
          : provider === 'wan'
            ? process.env.WAN_API_KEY || process.env.DASHSCOPE_API_KEY
          : provider === 'agnes'
            ? process.env.AGNES_API_KEY
            : process.env.AGNES_API_KEY ||
              process.env.BIGMODEL_API_KEY ||
              process.env.ZHIPU_API_KEY) ||
        '',
    ).trim(),
    defaultModel: String(
      process.env.VIDEO_MODEL ||
        (provider === 'bigmodel' || provider === 'zhipu'
          ? 'cogvideox-flash'
          : provider === 'minimax'
            ? 'MiniMax-H3'
            : provider === 'wan'
              ? 'wan3.0-video'
              : 'agnes-video-2.5-flash'),
    ).trim(),
    width: parsePositiveInt(process.env.VIDEO_WIDTH, 1280),
    height: parsePositiveInt(process.env.VIDEO_HEIGHT, 720),
    frameRate: parsePositiveInt(process.env.VIDEO_FRAME_RATE, 24),
    size: String(process.env.VIDEO_SIZE || (['agnes', 'wan'].includes(provider) ? '720P' : '')).trim(),
    quality: String(process.env.VIDEO_QUALITY || 'speed').trim().toLowerCase(),
    withAudio: parseBoolean(process.env.VIDEO_WITH_AUDIO, provider === 'wan'),
    watermarkEnabled: parseBoolean(process.env.VIDEO_WATERMARK_ENABLED, false),
    requestTimeoutMs: parsePositiveInt(process.env.VIDEO_REQUEST_TIMEOUT_MS, 60000),
    createRetryAttempts: parseNonNegativeInt(
      process.env.VIDEO_CREATE_RETRY_ATTEMPTS,
      provider === 'wan' ? 0 : 2,
    ),
    createRetryBaseDelayMs: parsePositiveInt(process.env.VIDEO_CREATE_RETRY_BASE_DELAY_MS, 5000),
    createRateLimitDelayMs: parsePositiveInt(process.env.VIDEO_CREATE_RATE_LIMIT_DELAY_MS, 60000),
    createRateLimitMaxRequests: parsePositiveInt(
      process.env.VIDEO_CREATE_RATE_LIMIT_MAX_REQUESTS,
      provider === 'agnes' ? 2 : provider === 'wan' ? 1 : 1000,
    ),
    createRateLimitWindowMs: parsePositiveInt(
      process.env.VIDEO_CREATE_RATE_LIMIT_WINDOW_MS,
      60000,
    ),
    pollIntervalMs: parsePositiveInt(process.env.VIDEO_POLL_INTERVAL_MS, 10000),
    pollTimeoutMs: parsePositiveInt(process.env.VIDEO_POLL_TIMEOUT_MS, 1200000),
    fallbackToMock: parseBoolean(process.env.VIDEO_FALLBACK_TO_MOCK, true),
    imageUploadBaseUrl: normalizeBaseUrl(
      process.env.VIDEO_IMAGE_UPLOAD_BASE_URL || 'https://toapis.com/v1',
    ),
    imageUploadApiKey: String(
      process.env.VIDEO_IMAGE_UPLOAD_API_KEY ||
        process.env.TOAPI_API_KEY ||
        process.env.FRAME_API_KEY ||
        '',
    ).trim(),
    imageUploadTimeoutMs: parsePositiveInt(process.env.VIDEO_IMAGE_UPLOAD_TIMEOUT_MS, 120000),
    imageUploadRetryAttempts: parseNonNegativeInt(
      process.env.VIDEO_IMAGE_UPLOAD_RETRY_ATTEMPTS,
      2,
    ),
    imageUploadRetryBaseDelayMs: parsePositiveInt(
      process.env.VIDEO_IMAGE_UPLOAD_RETRY_BASE_DELAY_MS,
      1500,
    ),
  }
}

export function isMockVideoProvider(config = getVideoConfig()) {
  return config.provider === 'mock'
}

export function isMiniMaxVideoProvider(config = getVideoConfig()) {
  return config.provider === 'minimax'
}

export function isWanVideoProvider(config = getVideoConfig()) {
  return config.provider === 'wan'
}

export function isWanVideoModel(modelName) {
  return /^wan(?:[0-9.]+)-(?:video|t2v|i2v)(?:-|$)/i.test(String(modelName || '').trim())
}

export function assertVideoProviderSnapshot(snapshotProvider, config = getVideoConfig()) {
  const expected = String(snapshotProvider || '').trim().toLowerCase()
  const actual = String(config.provider || '').trim().toLowerCase()
  if (expected && expected !== actual) {
    throw new Error(`视频服务商配置已变化：任务创建时为 ${expected}，当前为 ${actual}。请恢复原服务商后重试。`)
  }
  return actual
}

export function assertVideoModelProvider(modelName, config = getVideoConfig()) {
  const model = String(modelName || '').trim()
  const provider = String(config.provider || '').trim().toLowerCase()
  const requiredProvider = /^minimax(?:-|$)/i.test(model)
    ? 'minimax'
    : /^agnes-video-/i.test(model)
      ? 'agnes'
      : isWanVideoModel(model)
        ? 'wan'
        : ''
  if (requiredProvider && provider !== requiredProvider) {
    const label = requiredProvider === 'minimax'
      ? 'MiniMax'
      : requiredProvider === 'agnes' ? 'Agnes' : 'Wan'
    throw new Error(`${label} 模型需要配置视频服务商为 ${requiredProvider}，当前为 ${provider || '未配置'}。`)
  }
  return true
}

export function buildMiniMaxVideoPayload({
  modelName = 'MiniMax-H3',
  prompt,
  durationSeconds,
  imageRatio = '16:9',
  size = '2K',
  imageUrl = '',
  referenceImages = [],
} = {}) {
  const content = [{ type: 'text', text: String(prompt || '').trim() }]
  const images = uniqueReferences(referenceImages, 9, 'MiniMax 视频模型')
  if (images.length) {
    content.push(...images.map((url) => ({
      type: 'image_url',
      image_url: { url },
      role: 'reference_image',
    })))
  } else if (String(imageUrl || '').trim()) {
    content.push({
      type: 'image_url',
      image_url: { url: String(imageUrl).trim() },
      role: 'first_frame',
    })
  }
  const ratio = resolveAgnesAspectRatio(imageRatio)
  const requestedResolution = String(size || '').trim().toUpperCase()
  const resolution = requestedResolution === '720P'
    ? '768P'
    : ['768P', '2K'].includes(requestedResolution) ? requestedResolution : '768P'
  return {
    model: String(modelName || 'MiniMax-H3').trim(),
    content,
    resolution,
    duration: requireProviderDuration(durationSeconds, 4, 15, 'MiniMax H3'),
    ratio,
  }
}

export function extractMiniMaxVideoUrl(payload) {
  return String(payload?.task?.content?.url || payload?.content?.url || '').trim()
}

export function isOfficialAgnesModel(modelName) {
  // Agnes 的云端通道同时存在 v2.0 与 2.5 命名；它们都使用官方
  // /v1/videos 协议，必须保留 images/audios 参考绑定，不能落回旧兼容分支。
  return /^agnes-video-(?:v?2\.0|2\.5)(?:-flash)?$/i.test(String(modelName || '').trim())
}

export function resolveAgnesAspectRatio(imageRatio, config = {}) {
  const normalized = String(imageRatio || '').trim().toLowerCase().replace(/\s+/g, '')
  const aliases = {
    portrait: '9:16',
    vertical: '9:16',
    landscape: '16:9',
    square: '1:1',
    '720x1280': '9:16',
    '1280x720': '16:9',
    '720x960': '3:4',
    '960x720': '4:3',
    '1680x720': '21:9',
  }
  const direct = aliases[normalized] || normalized
  if (['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].includes(direct)) return direct

  const width = Number(config.width)
  const height = Number(config.height)
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    const ratio = width / height
    if (ratio < 0.7) return '9:16'
    if (ratio < 0.95) return '3:4'
    if (ratio < 1.18) return '1:1'
    if (ratio < 1.65) return '4:3'
    if (ratio < 2.05) return '16:9'
    return '21:9'
  }
  return '16:9'
}

export function buildOfficialAgnesVideoPayload({
  modelName,
  prompt,
  durationSeconds,
  imageRatio,
  width,
  height,
  size = '720P',
  imageUrl = '',
  referenceImages = [],
  referenceAudios = [],
} = {}) {
  const images = uniqueReferences(referenceImages, MAX_OFFICIAL_AGNES_REFERENCE_IMAGES, '官方 Agnes 视频模型')
  const audios = uniqueReferences(referenceAudios, MAX_OFFICIAL_AGNES_REFERENCE_AUDIOS, '官方 Agnes 视频模型音频参考')
  const seconds = requireProviderDuration(durationSeconds, 4, 12, '官方 Agnes 视频模型')
  const normalizedSize = String(size || '720P').trim().toUpperCase()
  const supportedSizes = new Set(['720P', '1080P', '1K', '2K'])
  const isFlashModel = /^agnes-video-2\.5-flash$/i.test(String(modelName || '').trim())
  const firstFrame = String(imageUrl || '').trim()
  const hasReferences = images.length > 0 || audios.length > 0
  const payload = {
    model: String(modelName || '').trim(),
    prompt: String(prompt || '').trim(),
    seconds: String(seconds),
    mode: hasReferences ? 'reference' : firstFrame ? 'keyframe' : 'text',
    size: isFlashModel ? '720P' : supportedSizes.has(normalizedSize) ? normalizedSize : '720P',
    aspect_ratio: resolveAgnesAspectRatio(imageRatio, { width, height }),
  }
  if (firstFrame && !hasReferences) payload.first_frame = firstFrame
  if (images.length) payload.images = images
  if (audios.length) payload.audios = audios
  return payload
}

export function resolveWanApiRoot(config = getVideoConfig()) {
  return normalizeBaseUrl(config.baseUrl)
    .replace(/\/compatible-mode\/v1$/i, '')
    .replace(/\/api\/v1$/i, '')
}

export function resolveWanAspectRatio(imageRatio, config = {}) {
  const normalized = String(imageRatio || '').trim().toLowerCase().replace(/\s+/g, '')
  if (normalized === 'adaptive') return 'adaptive'
  return resolveAgnesAspectRatio(imageRatio, config)
}

export function resolveWanResolution(value, fallback = '720P') {
  const normalized = String(value || fallback).trim().toUpperCase()
  return ['1080P', '720P', '480P'].includes(normalized) ? normalized : fallback
}

export function buildWanVideoPayload({
  modelName = 'wan3.0-video',
  prompt,
  durationSeconds,
  imageRatio = '16:9',
  size = '720P',
  firstFrameUrl = '',
  lastFrameUrl = '',
  referenceImages = [],
  withAudio = true,
  watermarkEnabled = false,
} = {}) {
  const duration = requireProviderDuration(durationSeconds, 2, 30, 'Wan 3.0')
  const firstFrame = String(firstFrameUrl || '').trim()
  const lastFrame = String(lastFrameUrl || '').trim()
  const references = uniqueReferences(referenceImages, MAX_WAN_REFERENCE_IMAGES, 'Wan 3.0 视频模型')
  const media = []
  if (firstFrame) {
    media.push({ type: 'first_frame', url: firstFrame })
    if (lastFrame) media.push({ type: 'last_frame', url: lastFrame })
  } else if (references.length) {
    media.push(...references.map((url) => ({ type: 'reference_image', url })))
  }
  return {
    model: String(modelName || 'wan3.0-video').trim(),
    input: {
      prompt: String(prompt || '').trim(),
      ...(media.length ? { media } : {}),
    },
    parameters: {
      resolution: resolveWanResolution(size),
      ratio: resolveWanAspectRatio(imageRatio),
      duration,
      audio: Boolean(withAudio),
      seed: -1,
      prompt_extend: false,
      watermark: Boolean(watermarkEnabled),
    },
  }
}

export function extractWanVideoUrl(payload) {
  return String(
    payload?.output?.video_url ||
      payload?.video_url ||
      payload?.output?.results?.[0]?.url ||
      '',
  ).trim()
}

function isBigModelVideoProvider(config) {
  return config.provider === 'bigmodel' || config.provider === 'zhipu'
}

function isMiniMaxProvider(config) {
  return isMiniMaxVideoProvider(config)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function resolveVideoCreateRateLimitWait(
  timestamps,
  now,
  maxRequests = 2,
  windowMs = 60000,
) {
  // 根据最近一段时间的创建记录，计算还要等待多久才能创建下一个视频任务。
  const recent = (Array.isArray(timestamps) ? timestamps : [])
    .map(Number)
    .filter((timestamp) => Number.isFinite(timestamp) && now - timestamp < windowMs)
    .sort((left, right) => left - right)
  if (recent.length < maxRequests) return 0
  return Math.max(0, recent[recent.length - maxRequests] + windowMs - now)
}

async function acquireVideoCreationSlot(config) {
  // 用 Promise 链把并发创建串起来，避免多个请求同时突破供应商限流。
  const reservation = videoCreationGate.then(async () => {
    while (true) {
      const now = Date.now()
      const windowMs = config.createRateLimitWindowMs
      videoCreationTimestamps = videoCreationTimestamps.filter(
        (timestamp) => now - timestamp < windowMs,
      )
      const waitMs = resolveVideoCreateRateLimitWait(
        videoCreationTimestamps,
        now,
        config.createRateLimitMaxRequests,
        windowMs,
      )
      if (waitMs <= 0) {
        videoCreationTimestamps.push(now)
        return
      }
      await sleep(waitMs + 100)
    }
  })
  videoCreationGate = reservation.catch(() => {})
  await reservation
}

function withVideoSourcePreparationSlot(operation) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      activeVideoSourcePreparations += 1
      try {
        resolve(await operation())
      } catch (error) {
        reject(error)
      } finally {
        activeVideoSourcePreparations -= 1
        const next = pendingVideoSourcePreparations.shift()
        if (next) next()
      }
    }
    if (activeVideoSourcePreparations < VIDEO_SOURCE_PREPARATION_CONCURRENCY) run()
    else pendingVideoSourcePreparations.push(run)
  })
}

export function isVideoTaskCreationRetryableError(error) {
  const message = String(error?.message || '')
  return Boolean(
    error?.status === 429 ||
      error?.status >= 500 ||
      /rate\s*limit|too many requests|allows?\s+\d+\s+requests?|timed out|request failed|fetch failed/i.test(
        message,
      ),
  )
}

export function isVideoTaskPollingRetryableError(error) {
  return isVideoTaskCreationRetryableError(error)
}

function buildCandidatePrompt(basePrompt, motionMode, candidateIndex) {
  const variants = [
    'preserve subject identity and composition, natural motion, stable cinematic shot',
    'subtle environmental motion, layered depth, consistent lighting and character details',
    'cinematic movement with smooth pacing, coherent action, no scene cuts',
  ]
  return [
    String(basePrompt || '').trim(),
    `camera movement: ${String(motionMode || 'PAN').trim().toLowerCase()}`,
    variants[candidateIndex] || variants[0],
  ]
    .filter(Boolean)
    .join(', ')
}

const VIDEO_SAFETY_REWRITE_RULES = [
  [/陷入\s*断电\s*黑暗/g, '灯光短暂闪烁后变暗，空间进入低照度氛围'],
  [/断电\s*黑暗/g, '低照度氛围'],
  [/彻底\s*黑暗/g, '光线明显变暗'],
  [/一片\s*漆黑/g, '环境光线很弱'],
  [/熄灭/g, '变暗'],
  [/灭掉/g, '变暗'],
  [/停摆/g, '声音逐渐减弱'],
  [/瘫痪/g, '暂时无法正常运转'],
  [/失控/g, '状态异常'],
  [/恐惧/g, '紧张'],
  [/惊恐/g, '警觉'],
  [/惊悚/g, '悬疑'],
  [/危险/g, '异常'],
  [/求救/g, '联系外界'],
  [/逃跑/g, '离开'],
  [/死亡|尸体|血迹|流血|自杀|杀人|凶杀|暴力|袭击/g, '异常事件'],
]

export function rewriteVideoPromptForSafety(value) {
  // 对动作提示词做供应商安全策略兼容改写。
  // 重点是把容易触发拒绝的暴力/危险表述转成非伤害性的镜头描述。
  let prompt = String(value || '').replace(/\r\n?/g, '\n').trim()
  for (const [pattern, replacement] of VIDEO_SAFETY_REWRITE_RULES) {
    prompt = prompt.replace(pattern, replacement)
  }
  prompt = prompt
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[,，]\s*[,，]+/g, '，')
    .trim()

  const safetyHint = [
    '非暴力悬疑氛围',
    '无血腥',
    '无伤害画面',
    '无危险行为',
    '不得弱化原提示词中的可见动作、物体运动、时间轴顺序和结尾状态',
  ].join('，')
  return [safetyHint, prompt].filter(Boolean).join('。')
}

function durationToFrameCount(durationSeconds, frameRate) {
  const seconds = Math.max(1, Number(durationSeconds) || 4)
  const target = Math.min(441, Math.max(9, Math.round(seconds * frameRate)))
  const step = Math.round((target - 1) / 8)
  return Math.min(441, Math.max(9, step * 8 + 1))
}

function parseImageUrl(value) {
  let parsed
  try {
    parsed = new URL(String(value || '').trim())
  } catch {
    throw new Error('已确认静帧地址无效，请重新确认静帧后再生成视频')
  }

  const hostname = parsed.hostname.toLowerCase()
  const isPrivateHost =
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname.startsWith('127.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('已确认静帧必须是 HTTP 或 HTTPS 图片地址，才能用于图生视频')
  }
  return { url: parsed.toString(), isPrivateHost }
}

function uploadFileNameFromSource(sourceName, contentType) {
  const extension = contentType === 'image/png'
    ? '.png'
    : contentType === 'image/webp'
      ? '.webp'
      : contentType === 'image/gif'
        ? '.gif'
        : '.jpg'
  let normalized = String(sourceName || '').trim().split(/[\\/]/).pop() || ''
  try {
    normalized = decodeURIComponent(new URL(String(sourceName || '')).pathname.split('/').pop() || normalized)
  } catch {
    // Object-storage keys are not URLs; keep the final path segment above.
  }
  return /\.(?:jpe?g|png|webp|gif)$/i.test(normalized) ? normalized : `video-source${extension}`
}

function isRetryableUploadStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function uploadNetworkErrorDetail(error) {
  const message = error instanceof Error ? error.message : 'unknown error'
  const causeCode = String(error?.cause?.code || '').trim()
  return causeCode ? `${message}, ${causeCode}` : message
}

export async function uploadVideoImageBytes(bytes, contentType, sourceName, config = getVideoConfig()) {
  if (!config.imageUploadApiKey) {
    throw new Error(
      'Video source image upload failed: missing VIDEO_IMAGE_UPLOAD_API_KEY or TOAPI_API_KEY',
    )
  }

  const normalizedContentType = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(normalizedContentType)) {
    throw new Error(
      `Video source image upload failed: unsupported image type ${normalizedContentType || 'unknown'}`,
    )
  }
  const imageBytes = Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes || [])
  if (!imageBytes.length || imageBytes.length > MAX_VIDEO_SOURCE_IMAGE_BYTES) {
    throw new Error(
      `Video source image upload failed: image size must be between 1 byte and ${MAX_VIDEO_SOURCE_IMAGE_BYTES} bytes`,
    )
  }

  let uploadResponse
  const retryAttempts = Math.max(0, Number(config.imageUploadRetryAttempts) || 0)
  const retryBaseDelayMs = Math.max(1, Number(config.imageUploadRetryBaseDelayMs) || 1500)
  let lastNetworkError = null
  for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
    const form = new FormData()
    form.append(
      'file',
      new Blob([imageBytes], { type: normalizedContentType }),
      uploadFileNameFromSource(sourceName, normalizedContentType),
    )
    form.append('purpose', 'generation')

    try {
      uploadResponse = null
      uploadResponse = await fetch(`${config.imageUploadBaseUrl}/uploads/images`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.imageUploadApiKey}` },
        body: form,
        signal: AbortSignal.timeout(config.imageUploadTimeoutMs),
      })
      lastNetworkError = null
    } catch (error) {
      lastNetworkError = error
      if (attempt >= retryAttempts) break
      await sleep(retryBaseDelayMs * (attempt + 1))
      continue
    }

    if (!isRetryableUploadStatus(uploadResponse.status) || attempt >= retryAttempts) break
    await uploadResponse.arrayBuffer()
    await sleep(retryBaseDelayMs * (attempt + 1))
  }

  if (!uploadResponse) {
    throw new Error(
      `Video source image upload failed: ToAPI request failed (${uploadNetworkErrorDetail(lastNetworkError)})`,
    )
  }

  const text = await uploadResponse.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  if (!uploadResponse.ok || payload?.success === false) {
    const detail =
      payload?.error?.message || payload?.message || text.slice(0, 300) || `HTTP ${uploadResponse.status}`
    throw new Error(`Video source image upload failed: ${detail}`)
  }

  const uploaded = parseImageUrl(payload?.data?.url)
  if (uploaded.isPrivateHost) {
    throw new Error('Video source image upload failed: ToAPI returned a private image URL')
  }
  return uploaded.url
}

async function uploadPrivateVideoImage(sourceUrl, config) {
  let sourceResponse
  try {
    sourceResponse = await fetch(sourceUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(config.imageUploadTimeoutMs),
    })
  } catch (error) {
    throw new Error(
      `Video source image upload failed: local image could not be read (${error instanceof Error ? error.message : 'unknown error'})`,
    )
  }
  if (!sourceResponse.ok) {
    throw new Error(`Video source image upload failed: local image returned HTTP ${sourceResponse.status}`)
  }
  const contentType = String(sourceResponse.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  return uploadVideoImageBytes(await sourceResponse.arrayBuffer(), contentType, sourceUrl, config)
}

export async function resolveVideoImageInput(value, config = getVideoConfig()) {
  // 图生视频供应商通常不能读取 localhost 图片。
  // 如果输入是本地生成图片，这里会先上传/转换成供应商可访问的 URL。
  const parsed = parseImageUrl(value)
  if (!parsed.isPrivateHost) return parsed.url

  const cacheKey = parsed.url
  if (!videoSourceUploadCache.has(cacheKey)) {
    const upload = uploadPrivateVideoImage(parsed.url, config).catch((error) => {
      videoSourceUploadCache.delete(cacheKey)
      throw error
    })
    videoSourceUploadCache.set(cacheKey, upload)
  }
  return videoSourceUploadCache.get(cacheKey)
}

const WAN_MEDIA_CONTENT_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/bmp'])

async function convertWanFrameToPng(bytes) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wan-frame-'))
  const inputPath = path.join(directory, 'frame.tiff')
  const outputPath = path.join(directory, 'frame.png')
  try {
    await writeFile(inputPath, bytes)
    await execFileAsync(process.env.FFMPEG_BIN || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath, '-pix_fmt', 'rgb24', outputPath,
    ], { maxBuffer: 16 * 1024 * 1024 })
    return { bytes: await readFile(outputPath), contentType: 'image/png' }
  } catch (error) {
    throw new Error(`Wan 首帧 TIFF 转 PNG 失败：${error instanceof Error ? error.message : 'unknown error'}`)
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

export async function resolveWanMediaInput(value, config = getVideoConfig()) {
  // Wan accepts public HTTPS media or Base64. Base64 keeps local/COS-signed
  // reference frames private and avoids exposing an internal storage URL.
  const source = String(value || '').trim()
  if (!source) return ''
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(source)) return source
  if (!/^https?:\/\//i.test(source)) {
    throw new Error('Wan 媒体输入必须是 HTTP(S) 地址或 Base64 图片')
  }

  let response
  try {
    response = await fetch(source, { signal: AbortSignal.timeout(config.requestTimeoutMs) })
  } catch (error) {
    throw new Error(`Wan 媒体读取失败：${error instanceof Error ? error.message : 'unknown error'}`)
  }
  if (!response.ok) throw new Error(`Wan 媒体读取失败：HTTP ${response.status}`)
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  let bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.length) throw new Error('Wan 媒体读取失败：文件为空')
  if (bytes.length > MAX_WAN_MEDIA_BYTES) {
    throw new Error(`Wan 媒体超过 ${MAX_WAN_MEDIA_BYTES} 字节上限`)
  }
  let normalizedType = contentType === 'image/jpg' ? 'image/jpeg' : contentType
  if (normalizedType === 'image/tiff') {
    // TIFF keeps the exact yuv420p boundary pixels for local validation, but
    // the Wan media contract only accepts JPEG/PNG/WEBP/BMP.
    const converted = await convertWanFrameToPng(bytes)
    bytes = converted.bytes
    normalizedType = converted.contentType
  }
  if (!WAN_MEDIA_CONTENT_TYPES.has(normalizedType)) {
    throw new Error(`Wan 媒体格式不支持：${normalizedType || 'unknown'}`)
  }
  return `data:${normalizedType};base64,${bytes.toString('base64')}`
}

export function buildVideoContinuityConstraints({
  characterName,
  characterAppearance,
  characterCostume,
  sceneAssetPrompt,
  isOpeningShot = false,
} = {}) {
  return [
    '视频连续性硬约束：全程只允许同一个角色、同一套服装和同一组随身配饰，不得换装、脱掉、增加或替换任何服装和配饰。',
    '服装结构锁定：按已确认资产复现衣领、前襟、闭合方式、内外层次、口袋、接缝、袖口、下摆、鞋履和固定配饰；转身时只显示同一套服装合理的背面结构。',
    '角色的脸型、发型、发长、眼镜、体型、年龄感、肤色和手部特征从第一帧到最后一帧必须保持一致；禁止把固定服装改成连帽衫、便服或其他替代服装。',
    characterName ? `角色身份锁定：${String(characterName).trim()}，以已确认角色参考图和角色资产版本为唯一外貌、服装与配饰来源；视频提示词不得重新设计角色。` : '',
    characterAppearance ? `已锁定外貌：${String(characterAppearance).trim()}` : '',
    characterCostume ? `已锁定服装与配饰：${String(characterCostume).trim()}` : '',
    isOpeningShot
      ? '【开场人物身份锚点】开场人物一旦出现，必须逐帧贴合已确认角色参考图与锁定外貌/服装；前段持续保持同一张脸、发型、年龄感及固定配饰，不得加减眼镜等配饰，不得换脸、面部融化、闪变或重影。'
      : '',
    sceneAssetPrompt
      ? '场景资产固定设定：以已确认场景参考图为准，保持空间结构、材质、灯光方向和固定物件；不得复述或套用场景生图模板。'
      : '',
    '空间拓扑锁定：维持前景、中景、后景、墙面、台面、门窗和固定设施的相对关系；镜头运动不得重绘空间或穿过实体表面。',
    '动作遵守遮挡顺序与接触点：明确谁在前、谁在后，手与道具、道具与支撑面保持真实接触；不得穿插人体/道具、融合、瞬移或无接触漂浮。',
    '单一主运动：本镜只完成一个主要人物动作和一种可控摄影机运动；复杂多人交互或交叉走位拆成多个镜头，禁止叠加无动机的推拉摇移环绕。',
    '保持角色身份、服装、配饰和场景结构连续；固定设施与背景物件保持稳定。分镜明确要求移动的角色或道具，必须按镜头动作和时间轴完成可见移动，不得锁定在参考图位置，也不得弱化为静止展示。',
  ].filter(Boolean).join('\n')
}

export { buildColorContinuityConstraints }

export function sanitizeVideoProviderDetail(value, maxLength = 400) {
  return String(value || '')
    .replace(/sk-[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .slice(0, maxLength)
}

async function requestJson(url, options, config, label) {
  let response
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      throw new Error(`${label} timed out`)
    }
    throw new Error(`${label} failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  }

  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }

  if (!response.ok) {
    const detail = sanitizeVideoProviderDetail(
      payload?.error?.message || payload?.message || payload?.detail || text || `HTTP ${response.status}`,
    )
    const error = new Error(`${label} failed: ${detail}`)
    error.status = response.status
    error.retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
    throw error
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error(`${label} returned an invalid JSON response`)
  }
  return payload
}

function resolveAgnesApiRoot(config) {
  return normalizeBaseUrl(config.baseUrl).replace(/\/v1$/i, '')
}

async function createAgnesVideoTask({
  config,
  imageUrl,
  prompt,
  durationSeconds,
  modelName,
  generationMode,
  referenceImages = [],
  referenceAudios = [],
  imageRatio = null,
}) {
  const hasImage = Boolean(String(imageUrl || '').trim())
  const references = uniqueReferences(referenceImages, MAX_AGNES_MULTI_REFERENCE_IMAGES, 'Agnes 视频模型')
  const useMultiReference = generationMode === 'multi_reference' && references.length > 0
  if (isOfficialAgnesModel(modelName)) {
    const body = buildOfficialAgnesVideoPayload({
      modelName,
      prompt,
      durationSeconds,
      imageRatio,
      width: config.width,
      height: config.height,
      size: config.size,
      imageUrl: references.length || generationMode === 'multi_reference' ? '' : imageUrl,
      referenceImages: references.length ? references : [],
      referenceAudios,
    })
    const payload = await requestJson(
      `${resolveAgnesApiRoot(config)}/v1/videos`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      config,
      '官方 Agnes 视频任务创建',
    )
    const videoId = String(payload.video_id || payload.task_id || payload.id || '').trim()
    if (!videoId) throw new Error('官方 Agnes 视频任务创建成功但没有返回任务 ID')
    return { videoId, initialPayload: payload }
  }
  const payload = await requestJson(
    `${resolveAgnesApiRoot(config)}/v1/videos`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        prompt,
        ...(useMultiReference
          ? { image: references }
          : hasImage ? { image: imageUrl } : {}),
        mode: useMultiReference
          ? 'multi_reference'
          : hasImage ? 'ti2vid' : 't2v',
        width: config.width,
        height: config.height,
        num_frames: durationToFrameCount(durationSeconds, config.frameRate),
        frame_rate: config.frameRate,
      }),
    },
    config,
    'Agnes 视频任务创建',
  )

  const videoId = String(payload.video_id || payload.task_id || payload.id || '').trim()
  if (!videoId) {
    throw new Error('Agnes 视频任务创建成功但没有返回任务 ID')
  }
  return { videoId, initialPayload: payload }
}

export function resolveBigModelVideoSize(config) {
  const requested = String(config.size || `${config.width}x${config.height}`).trim().toLowerCase()
  const supported = new Set([
    '720x480',
    '1024x1024',
    '1280x960',
    '960x1280',
    '1920x1080',
    '1080x1920',
    '2048x1080',
    '3840x2160',
  ])
  return supported.has(requested) ? requested : '1920x1080'
}

export function extractBigModelVideoUrl(payload) {
  return String(
    payload?.video_result?.[0]?.url || payload?.result?.video_result?.[0]?.url || payload?.url || '',
  ).trim()
}

export function resolveGeneratedVideoDuration(payload, requestedDurationSeconds, modelName) {
  const candidates = [
    payload?.seconds,
    payload?.duration,
    payload?.duration_seconds,
    payload?.usage?.output_video_duration,
    payload?.usage?.duration,
    payload?.output?.duration,
    payload?.output?.usage?.output_video_duration,
    payload?.video_result?.[0]?.duration,
    payload?.video_result?.[0]?.duration_seconds,
  ]
  const reportedDuration = candidates
    .map((value) => Number(value))
    .find((value) => Number.isFinite(value) && value > 0)
  if (reportedDuration) return Math.max(1, Math.round(reportedDuration))

  if (/^cogvideox(?:-|$)/i.test(String(modelName || '').trim())) {
    return 5
  }
  return Math.max(1, Math.round(Number(requestedDurationSeconds) || 4))
}

async function createBigModelVideoTask({ config, imageUrl, prompt, modelName, generationMode }) {
  const hasImage = Boolean(String(imageUrl || '').trim())
  const payload = await requestJson(
    `${config.baseUrl}/videos/generations`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        prompt: Array.from(String(prompt || '').trim()).slice(0, 512).join(''),
        ...(generationMode === 'text_to_video' ? {} : hasImage ? { image_url: imageUrl } : {}),
        quality: config.quality === 'quality' ? 'quality' : 'speed',
        with_audio: config.withAudio,
        watermark_enabled: config.watermarkEnabled,
        size: resolveBigModelVideoSize(config),
        fps: config.frameRate === 60 ? 60 : 30,
      }),
    },
    config,
    'BigModel video task creation',
  )

  const videoId = String(payload.id || payload.task_id || '').trim()
  if (!videoId) {
    throw new Error('BigModel video task creation returned no task ID')
  }
  return { videoId, initialPayload: payload }
}

async function createMiniMaxVideoTask({
  config,
  imageUrl,
  prompt,
  durationSeconds,
  modelName,
  generationMode,
  referenceImages = [],
  imageRatio = null,
}) {
  const body = buildMiniMaxVideoPayload({
    modelName,
    prompt,
    durationSeconds,
    imageRatio,
    size: config.size,
    imageUrl: generationMode === 'multi_reference' ? '' : imageUrl,
    referenceImages: generationMode === 'multi_reference' ? referenceImages : [],
  })
  const payload = await requestJson(
    `${normalizeBaseUrl(config.baseUrl).replace(/\/(?:v1|v2)$/i, '')}/v2/video_generation`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    config,
    '官方 MiniMax 视频任务创建',
  )
  const taskId = String(payload.task_id || payload.task?.id || payload.id || '').trim()
  if (!taskId) throw new Error('官方 MiniMax 视频任务创建成功但没有返回 task_id')
  return { videoId: taskId, initialPayload: payload }
}

async function createWanVideoTask({
  config,
  prompt,
  durationSeconds,
  modelName,
  firstFrameUrl = '',
  lastFrameUrl = '',
  referenceImages = [],
  imageRatio = null,
}) {
  const firstFrame = String(firstFrameUrl || '').trim()
  const lastFrame = String(lastFrameUrl || '').trim()
  const mediaFirstFrame = firstFrame ? await resolveWanMediaInput(firstFrame, config) : ''
  const mediaLastFrame = firstFrame && lastFrame ? await resolveWanMediaInput(lastFrame, config) : ''
  const mediaReferences = firstFrame
    ? []
    : await Promise.all(
      uniqueReferences(referenceImages, MAX_WAN_REFERENCE_IMAGES, 'Wan 3.0 视频模型')
        .map((url) => resolveWanMediaInput(url, config)),
    )
  const body = buildWanVideoPayload({
    modelName,
    prompt,
    durationSeconds,
    imageRatio,
    size: config.size,
    firstFrameUrl: mediaFirstFrame,
    lastFrameUrl: mediaLastFrame,
    referenceImages: mediaReferences,
    withAudio: config.withAudio,
    watermarkEnabled: config.watermarkEnabled,
  })
  const payload = await requestJson(
    `${resolveWanApiRoot(config)}/api/v1/services/aigc/video-generation/video-synthesis`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify(body),
    },
    config,
    'Wan 视频任务创建',
  )
  const taskId = String(payload?.output?.task_id || payload?.task_id || '').trim()
  if (!taskId) throw new Error('Wan 视频任务创建成功但没有返回 task_id')
  return { videoId: taskId, initialPayload: payload }
}

async function createProviderVideoTask(args) {
  await acquireVideoCreationSlot(args.config)
  // Reference URLs may wait behind the provider's creation limiter for many
  // minutes. Resolve them after the slot is acquired so signed object-storage
  // URLs are fresh when Agnes downloads them.
  const referenceImages = typeof args.resolveReferenceImages === 'function'
    ? await args.resolveReferenceImages()
    : args.referenceImages
  const providerArgs = { ...args, referenceImages }
  if (isBigModelVideoProvider(args.config)) return createBigModelVideoTask(providerArgs)
  if (isMiniMaxProvider(args.config)) return createMiniMaxVideoTask(providerArgs)
  if (isWanVideoProvider(args.config)) return createWanVideoTask(providerArgs)
  return createAgnesVideoTask(providerArgs)
}

async function createVideoTaskWithRetry(args) {
  const { config } = args
  let lastError = null

  for (let attempt = 0; attempt <= config.createRetryAttempts; attempt += 1) {
    try {
      return await createProviderVideoTask(args)
    } catch (error) {
      lastError = error
      const retryable = isVideoTaskCreationRetryableError(error)
      if (!retryable || attempt >= config.createRetryAttempts) {
        throw error
      }

      const fallbackDelayMs =
        error?.status === 429
          ? config.createRateLimitDelayMs
          : config.createRetryBaseDelayMs * 2 ** attempt
      await sleep(Math.min(120000, Math.max(fallbackDelayMs, Number(error?.retryAfterMs) || 0)))
    }
  }

  throw lastError || new Error('Agnes video task creation failed')
}

async function pollAgnesVideoTask(videoId, config, initialDelayMs = config.pollIntervalMs, modelName = '') {
  const deadline = Date.now() + config.pollTimeoutMs
  let latest = null
  let rateLimitDelayMs = config.pollIntervalMs

  if (initialDelayMs > 0) {
    await sleep(initialDelayMs)
  }

  while (Date.now() < deadline) {
    try {
      latest = await requestJson(
        `${resolveAgnesApiRoot(config)}/agnesapi?video_id=${encodeURIComponent(videoId)}${
          isOfficialAgnesModel(modelName)
            ? `&model_name=${encodeURIComponent(modelName)}`
            : ''
        }`,
        { method: 'GET' },
        config,
        'Agnes 视频状态查询',
      )
      rateLimitDelayMs = config.pollIntervalMs
    } catch (error) {
      if (!isVideoTaskPollingRetryableError(error)) throw error

      rateLimitDelayMs = Math.min(
        60000,
        Math.max(config.pollIntervalMs, Number(error?.retryAfterMs) || rateLimitDelayMs * 2),
      )
      await sleep(rateLimitDelayMs)
      continue
    }

    const status = String(latest.status || '').trim().toLowerCase()
    if (['completed', 'succeeded', 'success'].includes(status)) {
      const videoUrl = String(latest?.metadata?.url || latest?.url || '').trim()
      if (!/^https?:\/\//i.test(videoUrl)) {
        throw new Error('Agnes video task completed without a public video URL')
      }
      return { payload: latest, videoUrl }
    }
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      const detail = latest?.error?.message || latest?.error || latest?.message || status
      throw terminalProviderTaskError(`Agnes video generation failed: ${detail}`)
    }

    await sleep(config.pollIntervalMs)
  }

  throw new Error(`Agnes video generation timed out after ${config.pollTimeoutMs}ms`)
}

async function pollBigModelVideoTask(videoId, config, initialDelayMs = config.pollIntervalMs) {
  const deadline = Date.now() + config.pollTimeoutMs
  let delayMs = config.pollIntervalMs
  if (initialDelayMs > 0) await sleep(initialDelayMs)

  while (Date.now() < deadline) {
    let latest
    try {
      latest = await requestJson(
        `${config.baseUrl}/async-result/${encodeURIComponent(videoId)}`,
        { method: 'GET' },
        config,
        'BigModel video status request',
      )
      delayMs = config.pollIntervalMs
    } catch (error) {
      const retryable =
        error?.status === 429 || error?.status >= 500 || /timed out|fetch failed/i.test(String(error?.message || ''))
      if (!retryable) throw error
      delayMs = Math.min(
        60000,
        Math.max(config.pollIntervalMs, Number(error?.retryAfterMs) || delayMs * 2),
      )
      await sleep(delayMs)
      continue
    }

    const status = String(latest.task_status || latest.status || '').trim().toLowerCase()
    if (['success', 'completed', 'succeeded'].includes(status)) {
      const videoUrl = extractBigModelVideoUrl(latest)
      if (!/^https?:\/\//i.test(videoUrl)) {
        throw new Error('BigModel video task completed without a public video URL')
      }
      return { payload: latest, videoUrl }
    }
    if (['fail', 'failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      const detail = latest?.error?.message || latest?.error || latest?.message || status
      throw terminalProviderTaskError(`BigModel video generation failed: ${detail}`)
    }

    await sleep(delayMs)
  }

  throw new Error(`BigModel video generation timed out after ${config.pollTimeoutMs}ms`)
}

async function pollMiniMaxVideoTask(videoId, config, initialDelayMs = config.pollIntervalMs) {
  const baseUrl = normalizeBaseUrl(config.baseUrl).replace(/\/(?:v1|v2)$/i, '')
  const deadline = Date.now() + config.pollTimeoutMs
  let delayMs = config.pollIntervalMs
  if (initialDelayMs > 0) await sleep(initialDelayMs)
  while (Date.now() < deadline) {
    let payload
    try {
      payload = await requestJson(
        `${baseUrl}/v2/query/video_generation/${encodeURIComponent(videoId)}`,
        { method: 'GET' },
        config,
        '官方 MiniMax 视频状态查询',
      )
      delayMs = config.pollIntervalMs
    } catch (error) {
      if (!isVideoTaskPollingRetryableError(error)) throw error
      delayMs = Math.min(
        60000,
        Math.max(config.pollIntervalMs, Number(error?.retryAfterMs) || delayMs * 2),
      )
      await sleep(delayMs)
      continue
    }
    const task = payload?.task || payload
    const status = String(task?.status || '').trim().toLowerCase()
    if (['succeeded', 'success', 'completed'].includes(status)) {
      const videoUrl = extractMiniMaxVideoUrl(payload)
      if (!/^https?:\/\//i.test(videoUrl)) {
        throw new Error('MiniMax video task completed without a public video URL')
      }
      return { payload: task, videoUrl }
    }
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      const detail = task?.error?.message || task?.error || task?.message || status
      throw terminalProviderTaskError(`MiniMax video generation failed: ${detail}`)
    }
    await sleep(delayMs)
  }
  throw new Error(`MiniMax video generation timed out after ${config.pollTimeoutMs}ms`)
}

async function pollWanVideoTask(videoId, config, initialDelayMs = config.pollIntervalMs) {
  const deadline = Date.now() + config.pollTimeoutMs
  let delayMs = config.pollIntervalMs
  if (initialDelayMs > 0) await sleep(initialDelayMs)
  while (Date.now() < deadline) {
    let payload
    try {
      payload = await requestJson(
        `${resolveWanApiRoot(config)}/api/v1/tasks/${encodeURIComponent(videoId)}`,
        { method: 'GET' },
        config,
        'Wan 视频状态查询',
      )
      delayMs = config.pollIntervalMs
    } catch (error) {
      if (!isVideoTaskPollingRetryableError(error)) throw error
      delayMs = Math.min(
        60000,
        Math.max(config.pollIntervalMs, Number(error?.retryAfterMs) || delayMs * 2),
      )
      await sleep(delayMs)
      continue
    }

    const status = String(payload?.output?.task_status || payload?.task_status || '').trim().toUpperCase()
    if (status === 'SUCCEEDED') {
      const videoUrl = extractWanVideoUrl(payload)
      if (!/^https?:\/\//i.test(videoUrl)) {
        throw new Error('Wan 视频任务成功但没有返回可播放地址')
      }
      return { payload, videoUrl }
    }
    if (['FAILED', 'CANCELED', 'CANCELLED', 'UNKNOWN'].includes(status)) {
      const code = payload?.output?.code || payload?.code || status
      const message = payload?.output?.message || payload?.message || status
      throw terminalProviderTaskError(`Wan 视频生成失败：${code} ${message}`.trim())
    }
    await sleep(delayMs)
  }
  throw new Error(`Wan 视频生成超时（${config.pollTimeoutMs}ms）`)
}

function pollProviderVideoTask(videoId, config, initialDelayMs, modelName) {
  if (isBigModelVideoProvider(config)) return pollBigModelVideoTask(videoId, config, initialDelayMs)
  if (isMiniMaxProvider(config)) return pollMiniMaxVideoTask(videoId, config, initialDelayMs)
  if (isWanVideoProvider(config)) return pollWanVideoTask(videoId, config, initialDelayMs)
  return pollAgnesVideoTask(videoId, config, initialDelayMs, modelName)
}

function terminalProviderTaskError(message) {
  const error = new Error(message)
  error.providerTerminal = true
  return error
}

export async function generateVideoCandidates({
  imageUrl,
  firstFrameUrl = '',
  lastFrameUrl = '',
  prompt,
  motionMode,
  durationSeconds,
  modelName,
  candidateCount = 3,
  providerTasks = [],
  onTasksCreated,
  onTasksCompleted,
  generationMode = 'image_to_video',
  referenceImages = [],
  referenceAudios = [],
  imageRatio = null,
  resolveReferenceImages,
}) {
  // 统一的视频生成入口：
  // 准备源图 -> 安全改写提示词 -> 限流 -> 创建供应商任务 -> 轮询 -> 下载结果。
  const config = getVideoConfig()
  if (isMockVideoProvider(config)) {
    throw new Error('VIDEO_PROVIDER=mock')
  }
  if (!['agnes', 'bigmodel', 'zhipu', 'minimax', 'wan'].includes(config.provider)) {
    throw new Error(`Unsupported VIDEO_PROVIDER: ${config.provider}`)
  }
  if (!config.baseUrl) {
    throw new Error('Missing VIDEO_BASE_URL configuration')
  }
  if (!config.apiKey) {
    throw new Error('Missing VIDEO_API_KEY, WAN_API_KEY, DASHSCOPE_API_KEY, AGNES_API_KEY, or MINIMAX_API_KEY configuration')
  }

  const directTextToVideo = generationMode === 'text_to_video'
  const rawFirstFrameUrl = directTextToVideo
    ? ''
    : String(firstFrameUrl || imageUrl || '').trim()
  const parsedImage = rawFirstFrameUrl ? parseImageUrl(rawFirstFrameUrl) : null
  const sourceImageUrl = parsedImage?.url || null
  const effectiveModel = String(modelName || '').trim() || config.defaultModel
  const safePrompt = rewriteVideoPromptForSafety(prompt)
  const safeBasePrompt = isMiniMaxProvider(config)
    ? compactMiniMaxVideoPrompt(safePrompt)
    : safePrompt
  const totalCandidates = Math.max(1, Math.min(3, Number(candidateCount) || 3))
  const tasks = (Array.isArray(providerTasks) ? providerTasks : [])
    .map((task) => ({
      videoId: String(task?.videoId || '').trim(),
      initialPayload: task?.initialPayload || null,
      candidatePrompt: String(task?.candidatePrompt || '').trim(),
      videoUrl: String(task?.videoUrl || '').trim(),
      payload: task?.payload || null,
    }))
    .filter((task) => task.videoId)
    .slice(0, totalCandidates)

  let providerImageInput = sourceImageUrl
  if (
    !isWanVideoProvider(config) &&
    tasks.length < totalCandidates &&
    parsedImage?.isPrivateHost
  ) {
    providerImageInput = await withVideoSourcePreparationSlot(() =>
      resolveVideoImageInput(sourceImageUrl, config),
    )
  }
  // Wan accepts Base64 media, so its source frame never needs the ToAPI upload bridge.
  const providerFirstFrameInput = isWanVideoProvider(config) ? sourceImageUrl : providerImageInput
  const providerLastFrameInput = isWanVideoProvider(config)
    ? String(lastFrameUrl || '').trim()
    : ''

  for (let i = tasks.length; i < totalCandidates; i += 1) {
    const candidatePrompt = buildCandidatePrompt(safeBasePrompt, motionMode, i)
    const task = await createVideoTaskWithRetry({
      config,
      imageUrl: providerImageInput,
      firstFrameUrl: providerFirstFrameInput,
      lastFrameUrl: providerLastFrameInput,
      prompt: candidatePrompt,
      durationSeconds,
      modelName: effectiveModel,
      generationMode,
      referenceImages,
      referenceAudios,
      imageRatio,
      resolveReferenceImages,
    })
    tasks.push({ ...task, candidatePrompt, status: 'pending' })
    if (typeof onTasksCreated === 'function') {
      await onTasksCreated(tasks.map((item) => ({ ...item })))
    }
  }

  let taskCheckpoint = Promise.resolve()
  const checkpointTasks = () => {
    if (typeof onTasksCompleted !== 'function') return Promise.resolve()
    const snapshot = tasks.map((item) => ({ ...item }))
    taskCheckpoint = taskCheckpoint.then(() => onTasksCompleted(snapshot))
    return taskCheckpoint
  }
  const completed = await Promise.all(tasks.map(async (task, index) => {
    if (task.videoUrl) {
      return { task, result: { payload: task.payload || task.initialPayload || {}, videoUrl: task.videoUrl } }
    }
    let result
    try {
      result = await pollProviderVideoTask(
        task.videoId,
        config,
        config.pollIntervalMs + Math.round((config.pollIntervalMs * index) / tasks.length),
        effectiveModel,
      )
    } catch (error) {
      if (error?.providerTerminal) {
        tasks[index] = { ...task, status: 'failed' }
        await checkpointTasks()
      }
      throw error
    }
    tasks[index] = { ...task, videoUrl: result.videoUrl, payload: result.payload || null, status: 'succeeded' }
    await checkpointTasks()
    return { task: tasks[index], result }
  }))

  return completed.map(({ task, result }) => {
    return {
      videoUrl: result.videoUrl,
      thumbnailUrl: sourceImageUrl || providerFirstFrameInput,
      motionMode: String(motionMode || '').trim() || null,
      durationSeconds: resolveGeneratedVideoDuration(result.payload, durationSeconds, effectiveModel),
      modelName: effectiveModel,
      providerTaskId: task.videoId,
      promptSnapshot: task.candidatePrompt,
    }
  })
}
