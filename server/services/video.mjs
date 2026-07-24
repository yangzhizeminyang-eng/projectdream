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

const MAX_VIDEO_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024
const videoSourceUploadCache = new Map()

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
      : 'https://apihub.agnes-ai.com'
  return {
    provider,
    baseUrl: normalizeBaseUrl(process.env.VIDEO_BASE_URL || defaultBaseUrl),
    apiKey: String(
      process.env.VIDEO_API_KEY ||
        process.env.BIGMODEL_API_KEY ||
        process.env.ZHIPU_API_KEY ||
        process.env.AGNES_API_KEY ||
        '',
    ).trim(),
    defaultModel: String(
      process.env.VIDEO_MODEL ||
        (provider === 'bigmodel' || provider === 'zhipu' ? 'cogvideox-flash' : 'agnes-video-v2.0'),
    ).trim(),
    width: parsePositiveInt(process.env.VIDEO_WIDTH, 1280),
    height: parsePositiveInt(process.env.VIDEO_HEIGHT, 720),
    frameRate: parsePositiveInt(process.env.VIDEO_FRAME_RATE, 24),
    size: String(process.env.VIDEO_SIZE || '').trim(),
    quality: String(process.env.VIDEO_QUALITY || 'speed').trim().toLowerCase(),
    withAudio: parseBoolean(process.env.VIDEO_WITH_AUDIO, false),
    watermarkEnabled: parseBoolean(process.env.VIDEO_WATERMARK_ENABLED, false),
    requestTimeoutMs: parsePositiveInt(process.env.VIDEO_REQUEST_TIMEOUT_MS, 60000),
    createRetryAttempts: parseNonNegativeInt(process.env.VIDEO_CREATE_RETRY_ATTEMPTS, 2),
    createRetryBaseDelayMs: parsePositiveInt(process.env.VIDEO_CREATE_RETRY_BASE_DELAY_MS, 5000),
    createRateLimitDelayMs: parsePositiveInt(process.env.VIDEO_CREATE_RATE_LIMIT_DELAY_MS, 60000),
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

function isBigModelVideoProvider(config) {
  return config.provider === 'bigmodel' || config.provider === 'zhipu'
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
    '只表现人物轻微表情、呼吸和观察动作',
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

function uploadFileName(sourceUrl, contentType) {
  const extension = contentType === 'image/png'
    ? '.png'
    : contentType === 'image/webp'
      ? '.webp'
      : contentType === 'image/gif'
        ? '.gif'
        : '.jpg'
  const sourceName = decodeURIComponent(new URL(sourceUrl).pathname.split('/').pop() || '')
  return /\.(?:jpe?g|png|webp|gif)$/i.test(sourceName) ? sourceName : `video-source${extension}`
}

function isRetryableUploadStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function uploadNetworkErrorDetail(error) {
  const message = error instanceof Error ? error.message : 'unknown error'
  const causeCode = String(error?.cause?.code || '').trim()
  return causeCode ? `${message}, ${causeCode}` : message
}

async function uploadPrivateVideoImage(sourceUrl, config) {
  if (!config.imageUploadApiKey) {
    throw new Error(
      'Video source image upload failed: missing VIDEO_IMAGE_UPLOAD_API_KEY or TOAPI_API_KEY',
    )
  }

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
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType)) {
    throw new Error(
      `Video source image upload failed: unsupported local image type ${contentType || 'unknown'}`,
    )
  }
  const bytes = await sourceResponse.arrayBuffer()
  if (!bytes.byteLength || bytes.byteLength > MAX_VIDEO_SOURCE_IMAGE_BYTES) {
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
      new Blob([bytes], { type: contentType }),
      uploadFileName(sourceUrl, contentType),
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

export async function resolveVideoImageInput(value, config = getVideoConfig()) {
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
    const detail =
      payload?.error?.message || payload?.message || payload?.detail || text.slice(0, 400) || `HTTP ${response.status}`
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

async function createAgnesVideoTask({ config, imageUrl, prompt, durationSeconds, modelName }) {
  const payload = await requestJson(
    `${resolveAgnesApiRoot(config)}/v1/videos`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        prompt,
        image: imageUrl,
        mode: 'ti2vid',
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

async function createBigModelVideoTask({ config, imageUrl, prompt, modelName }) {
  const payload = await requestJson(
    `${config.baseUrl}/videos/generations`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        prompt: Array.from(String(prompt || '').trim()).slice(0, 512).join(''),
        image_url: imageUrl,
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

function createProviderVideoTask(args) {
  return isBigModelVideoProvider(args.config)
    ? createBigModelVideoTask(args)
    : createAgnesVideoTask(args)
}

async function createVideoTaskWithRetry(args) {
  const { config } = args
  let lastError = null

  for (let attempt = 0; attempt <= config.createRetryAttempts; attempt += 1) {
    try {
      return await createProviderVideoTask(args)
    } catch (error) {
      lastError = error
      const message = String(error?.message || '')
      const retryable =
        error?.status === 429 ||
        error?.status >= 500 ||
        /timed out|request failed|fetch failed/i.test(message)
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

async function pollAgnesVideoTask(videoId, config, initialDelayMs = config.pollIntervalMs) {
  const deadline = Date.now() + config.pollTimeoutMs
  let latest = null
  let rateLimitDelayMs = config.pollIntervalMs

  if (initialDelayMs > 0) {
    await sleep(initialDelayMs)
  }

  while (Date.now() < deadline) {
    try {
      latest = await requestJson(
        `${resolveAgnesApiRoot(config)}/agnesapi?video_id=${encodeURIComponent(videoId)}`,
        { method: 'GET' },
        config,
        'Agnes 视频状态查询',
      )
      rateLimitDelayMs = config.pollIntervalMs
    } catch (error) {
      const isRateLimited = error?.status === 429 || /rate limit/i.test(String(error?.message || ''))
      if (!isRateLimited) throw error

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
      throw new Error(`Agnes video generation failed: ${detail}`)
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
      throw new Error(`BigModel video generation failed: ${detail}`)
    }

    await sleep(delayMs)
  }

  throw new Error(`BigModel video generation timed out after ${config.pollTimeoutMs}ms`)
}

function pollProviderVideoTask(videoId, config, initialDelayMs) {
  return isBigModelVideoProvider(config)
    ? pollBigModelVideoTask(videoId, config, initialDelayMs)
    : pollAgnesVideoTask(videoId, config, initialDelayMs)
}

export async function generateVideoCandidates({
  imageUrl,
  prompt,
  motionMode,
  durationSeconds,
  modelName,
  candidateCount = 3,
}) {
  const config = getVideoConfig()
  if (isMockVideoProvider(config)) {
    throw new Error('VIDEO_PROVIDER=mock')
  }
  if (!['agnes', 'bigmodel', 'zhipu'].includes(config.provider)) {
    throw new Error(`Unsupported VIDEO_PROVIDER: ${config.provider}`)
  }
  if (!config.baseUrl) {
    throw new Error('Missing VIDEO_BASE_URL configuration')
  }
  if (!config.apiKey) {
    throw new Error('Missing VIDEO_API_KEY or AGNES_API_KEY configuration')
  }

  const parsedImage = parseImageUrl(imageUrl)
  const sourceImageUrl = parsedImage.url
  let providerImageInput = sourceImageUrl
  if (parsedImage.isPrivateHost) {
    providerImageInput = await resolveVideoImageInput(sourceImageUrl, config)
  }
  const effectiveModel = String(modelName || '').trim() || config.defaultModel
  const safeBasePrompt = rewriteVideoPromptForSafety(prompt)
  const tasks = []
  const totalCandidates = Math.max(1, Math.min(3, Number(candidateCount) || 3))
  for (let i = 0; i < totalCandidates; i += 1) {
    const candidatePrompt = buildCandidatePrompt(safeBasePrompt, motionMode, i)
    const task = await createVideoTaskWithRetry({
      config,
      imageUrl: providerImageInput,
      prompt: candidatePrompt,
      durationSeconds,
      modelName: effectiveModel,
    })
    tasks.push({ ...task, candidatePrompt })
  }

  const completed = await Promise.all(
    tasks.map(async (task, index) => ({
      task,
      result: await pollProviderVideoTask(
        task.videoId,
        config,
        config.pollIntervalMs + Math.round((config.pollIntervalMs * index) / tasks.length),
      ),
    })),
  )

  return completed.map(({ task, result }) => {
    return {
      videoUrl: result.videoUrl,
      thumbnailUrl: sourceImageUrl,
      motionMode: String(motionMode || '').trim() || null,
      durationSeconds: resolveGeneratedVideoDuration(result.payload, durationSeconds, effectiveModel),
      modelName: effectiveModel,
      providerTaskId: task.videoId,
      promptSnapshot: task.candidatePrompt,
    }
  })
}
