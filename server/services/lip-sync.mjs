import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

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

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function getLipSyncConfig() {
  const provider = String(process.env.LIP_SYNC_PROVIDER || 'toapi').trim().toLowerCase()
  return {
    provider,
    baseUrl: normalizeBaseUrl(
      process.env.LIP_SYNC_BASE_URL ||
        (provider === 'dashscope' ? 'https://dashscope.aliyuncs.com/api/v1' : 'https://toapis.com/v1'),
    ),
    apiKey: String(
      process.env.LIP_SYNC_API_KEY ||
        (provider === 'dashscope' ? process.env.DASHSCOPE_API_KEY : process.env.TOAPI_API_KEY) ||
        '',
    ).trim(),
    model: String(
      process.env.LIP_SYNC_MODEL || (provider === 'dashscope' ? 'videoretalk' : 'seedance-2'),
    ).trim(),
    resolution: String(process.env.LIP_SYNC_RESOLUTION || '720p').trim(),
    aspectRatio: String(process.env.LIP_SYNC_ASPECT_RATIO || '16:9').trim(),
    generateAudio: parseBoolean(process.env.LIP_SYNC_GENERATE_AUDIO, true),
    requestTimeoutMs: parsePositiveInt(process.env.LIP_SYNC_REQUEST_TIMEOUT_MS, 120000),
    pollIntervalMs: parsePositiveInt(process.env.LIP_SYNC_POLL_INTERVAL_MS, 5000),
    pollTimeoutMs: parsePositiveInt(process.env.LIP_SYNC_POLL_TIMEOUT_MS, 1800000),
  }
}

export function resolveLipSyncDuration(audioDurationSeconds, storyboardDurationSeconds) {
  const requested = Math.max(
    Number(audioDurationSeconds) || 0,
    Number(storyboardDurationSeconds) || 0,
    4,
  )
  return Math.min(15, Math.max(4, Math.ceil(requested)))
}

export function resolveDashScopeLipSyncDuration(audioDurationSeconds, storyboardDurationSeconds) {
  const requested = Math.max(
    Number(audioDurationSeconds) || 0,
    Number(storyboardDurationSeconds) || 0,
    3,
  )
  return Math.min(119, Math.max(3, Math.ceil(requested)))
}

export function buildLipSyncPrompt({ characterName, dialogueText, actionText }) {
  const speaker = String(characterName || '人物').trim()
  const dialogue = String(dialogueText || '').trim()
  const action = String(actionText || '').trim()
  return [
    `保持图片1中${speaker}的脸、发型、年龄、服装、构图和光线稳定。`,
    '让图片1中的人物面对当前方向自然说中文，嘴唇开合严格跟随音频1，停顿时闭嘴。',
    '只允许当前说话人物做轻微表情、眨眼和呼吸动作，不改变身份，不新增人物，不切镜头。',
    dialogue ? `对白语义：${dialogue}` : '',
    action ? `表演要求：${action}` : '',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 1000)
}

export function buildDashScopeLipSyncPayload({
  config = getLipSyncConfig(),
  videoUrl,
  audioUrl,
  referenceImageUrl = '',
  extendVideo = true,
}) {
  const normalizedVideoUrl = String(videoUrl || '').trim()
  const normalizedAudioUrl = String(audioUrl || '').trim()
  const normalizedReferenceUrl = String(referenceImageUrl || '').trim()
  if (!/^(?:https?:\/\/|oss:\/\/)/i.test(normalizedVideoUrl)) {
    throw new Error('DashScope lip-sync video input must be an HTTP(S) or oss:// URL')
  }
  if (!/^(?:https?:\/\/|oss:\/\/)/i.test(normalizedAudioUrl)) {
    throw new Error('DashScope lip-sync audio input must be an HTTP(S) or oss:// URL')
  }
  return {
    model: config.model,
    input: {
      video_url: normalizedVideoUrl,
      audio_url: normalizedAudioUrl,
      ...(normalizedReferenceUrl ? { ref_image_url: normalizedReferenceUrl } : {}),
    },
    parameters: {
      video_extension: Boolean(extendVideo),
    },
  }
}

export function buildSeedanceLipSyncPayload({
  config = getLipSyncConfig(),
  assetUrl,
  audioInput,
  prompt,
  durationSeconds,
  clientBusinessId,
}) {
  if (!/^asset:\/\/[A-Za-z0-9_-]+$/.test(String(assetUrl || '').trim())) {
    throw new Error('Lip-sync image asset is not active or has an invalid asset URL')
  }
  if (!/^(?:https?:\/\/|data:audio\/)/i.test(String(audioInput || '').trim())) {
    throw new Error('Lip-sync audio input must be a public URL or an audio data URL')
  }
  return {
    model: config.model,
    client_business_id: String(clientBusinessId || '').trim() || undefined,
    prompt: String(prompt || '').trim(),
    duration: resolveLipSyncDuration(durationSeconds, 0),
    aspect_ratio: config.aspectRatio,
    image_with_roles: [{ url: assetUrl, role: 'reference_image' }],
    audio_with_roles: [{ url: audioInput, role: 'reference_audio' }],
    resolution: config.resolution,
    generate_audio: config.generateAudio,
    return_last_frame: true,
  }
}

async function requestJson(url, options, config, label) {
  if (!config.apiKey) throw new Error('Missing LIP_SYNC_API_KEY or TOAPI_API_KEY configuration')

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
    throw new Error(`${label} failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  }

  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  if (!response.ok || payload?.success === false) {
    const detail =
      payload?.error?.message || payload?.message || payload?.detail || text.slice(0, 400) || `HTTP ${response.status}`
    throw new Error(`${label} failed: ${detail}`)
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error(`${label} returned an invalid JSON response`)
  }
  return payload
}

async function fetchWithRetry(url, options, attempts = 3) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, options)
    } catch (error) {
      lastError = error
      if (attempt < attempts) await sleep(1200 * attempt)
    }
  }
  throw lastError
}

function assertToApiProvider(config) {
  if (config.provider !== 'toapi') {
    throw new Error(`Unsupported lip-sync provider: ${config.provider}`)
  }
}

function assertDashScopeProvider(config) {
  if (config.provider !== 'dashscope') {
    throw new Error(`Unsupported DashScope lip-sync provider: ${config.provider}`)
  }
}

export async function uploadDashScopeLipSyncFile({
  filePath,
  fileName,
  config = getLipSyncConfig(),
}) {
  assertDashScopeProvider(config)
  const policyPayload = await requestJson(
    `${config.baseUrl}/uploads?action=getPolicy&model=${encodeURIComponent(config.model)}`,
    {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    },
    config,
    'DashScope lip-sync upload policy request',
  )
  const policy = policyPayload?.data || {}
  const uploadHost = String(policy.upload_host || '').trim()
  const uploadDir = String(policy.upload_dir || '').replace(/^\/+|\/+$/g, '')
  if (!/^https?:\/\//i.test(uploadHost) || !uploadDir) {
    throw new Error('DashScope lip-sync upload policy returned invalid storage details')
  }

  const bytes = await readFile(filePath)
  if (!bytes.length) throw new Error('DashScope lip-sync upload source is empty')
  const rawName = String(fileName || path.basename(filePath) || 'media.bin').trim()
  const extension = path.extname(rawName).toLowerCase()
  const stem = path.basename(rawName, extension).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'media'
  const safeName = `${stem}-${randomUUID()}${extension || '.bin'}`
  const objectKey = `${uploadDir}/${safeName}`
  const form = new FormData()
  form.append('OSSAccessKeyId', String(policy.oss_access_key_id || ''))
  form.append('Signature', String(policy.signature || ''))
  form.append('policy', String(policy.policy || ''))
  form.append('x-oss-object-acl', String(policy.x_oss_object_acl || 'private'))
  form.append('x-oss-forbid-overwrite', String(policy.x_oss_forbid_overwrite || 'true'))
  form.append('key', objectKey)
  form.append('success_action_status', '200')
  form.append('file', new Blob([bytes]), safeName)

  let response
  try {
    response = await fetchWithRetry(
      uploadHost,
      {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      },
      3,
    )
  } catch (error) {
    throw new Error(
      `口型素材上传失败：网络连接被中断，请稍后重试，或检查 DashScope 密钥、网络代理和阿里 OSS 上传访问。原始错误：${error instanceof Error ? error.message : 'unknown error'}`,
    )
  }
  const responseText = await response.text()
  if (!response.ok) {
    throw new Error(
      `口型素材上传失败：DashScope 临时存储返回 ${responseText.slice(0, 400) || `HTTP ${response.status}`}`,
    )
  }
  return {
    url: `oss://${objectKey}`,
    expiresInSeconds: Number(policy.expire_in_seconds) || null,
  }
}

export async function createDashScopeLipSyncTask({
  videoUrl,
  audioUrl,
  referenceImageUrl,
  extendVideo = true,
  config = getLipSyncConfig(),
}) {
  assertDashScopeProvider(config)
  const payload = await requestJson(
    `${config.baseUrl}/services/aigc/image2video/video-synthesis`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
        'X-DashScope-OssResourceResolve': 'enable',
      },
      body: JSON.stringify(
        buildDashScopeLipSyncPayload({
          config,
          videoUrl,
          audioUrl,
          referenceImageUrl,
          extendVideo,
        }),
      ),
    },
    config,
    'DashScope lip-sync task creation',
  )
  const taskId = String(payload?.output?.task_id || '').trim()
  if (!taskId) throw new Error('DashScope lip-sync task creation returned no task ID')
  return { taskId, payload }
}

export async function getDashScopeLipSyncTask(taskId, config = getLipSyncConfig()) {
  assertDashScopeProvider(config)
  return requestJson(
    `${config.baseUrl}/tasks/${encodeURIComponent(taskId)}`,
    { method: 'GET' },
    config,
    'DashScope lip-sync status request',
  )
}

export async function waitForDashScopeLipSyncTask(
  taskId,
  { config = getLipSyncConfig(), onProgress } = {},
) {
  const deadline = Date.now() + config.pollTimeoutMs
  while (Date.now() < deadline) {
    const payload = await getDashScopeLipSyncTask(taskId, config)
    const status = String(payload?.output?.task_status || '').trim().toUpperCase()
    const progressByStatus = {
      PENDING: 5,
      RUNNING: 45,
      'PRE-PROCESSING': 20,
      PROCESSING: 55,
      'POST-PROCESSING': 85,
      SUCCEEDED: 100,
    }
    onProgress?.({ status, progress: progressByStatus[status] || 0, payload })
    if (status === 'SUCCEEDED') {
      const videoUrl = String(payload?.output?.video_url || '').trim()
      if (!/^https?:\/\//i.test(videoUrl)) {
        throw new Error('DashScope lip-sync task completed without a public video URL')
      }
      return {
        payload,
        videoUrl,
        durationSeconds: Number(payload?.usage?.video_duration) || null,
      }
    }
    if (['FAILED', 'UNKNOWN', 'CANCELED', 'CANCELLED'].includes(status)) {
      const detail = payload?.output?.message || payload?.output?.code || status
      throw new Error(`DashScope lip-sync generation failed: ${detail}`)
    }
    await sleep(config.pollIntervalMs)
  }
  throw new Error(`DashScope lip-sync generation timed out after ${config.pollTimeoutMs}ms`)
}

export async function createPrivateAvatarGroup({ name, description, config = getLipSyncConfig() }) {
  assertToApiProvider(config)
  const payload = await requestJson(
    `${config.baseUrl}/videos/doubao-seedance-2-0/private-avatar/groups`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    },
    config,
    'Lip-sync avatar group creation',
  )
  const groupId = String(payload?.data?.group_id || '').trim()
  if (!groupId) throw new Error('Lip-sync avatar group creation returned no group ID')
  return { groupId, payload }
}

export async function createPrivateAvatarAsset({
  groupId,
  sourceUrl,
  name,
  description,
  config = getLipSyncConfig(),
}) {
  assertToApiProvider(config)
  const payload = await requestJson(
    `${config.baseUrl}/videos/doubao-seedance-2-0/private-avatar/assets`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group_id: groupId,
        asset_type: 'image',
        source_url: sourceUrl,
        name,
        description,
      }),
    },
    config,
    'Lip-sync avatar asset creation',
  )
  const assetId = String(payload?.data?.asset_id || '').trim()
  const assetUrl = String(payload?.data?.asset_url || (assetId ? `asset://${assetId}` : '')).trim()
  if (!assetId || !assetUrl) throw new Error('Lip-sync avatar asset creation returned no asset ID')
  return {
    assetId,
    assetUrl,
    status: String(payload?.data?.status || 'processing').trim().toLowerCase(),
    payload,
  }
}

export async function getPrivateAvatarAsset(assetId, config = getLipSyncConfig()) {
  assertToApiProvider(config)
  const payload = await requestJson(
    `${config.baseUrl}/videos/doubao-seedance-2-0/private-avatar/assets/${encodeURIComponent(assetId)}`,
    { method: 'GET' },
    config,
    'Lip-sync avatar asset status request',
  )
  return {
    assetId: String(payload?.data?.asset_id || assetId).trim(),
    assetUrl: String(payload?.data?.asset_url || `asset://${assetId}`).trim(),
    status: String(payload?.data?.status || '').trim().toLowerCase(),
    payload,
  }
}

export async function waitForPrivateAvatarAsset(
  assetId,
  { config = getLipSyncConfig(), onProgress } = {},
) {
  const deadline = Date.now() + config.pollTimeoutMs
  while (Date.now() < deadline) {
    const result = await getPrivateAvatarAsset(assetId, config)
    onProgress?.(result)
    if (result.status === 'active') return result
    if (result.status === 'failed') throw new Error('Lip-sync avatar asset processing failed')
    await sleep(config.pollIntervalMs)
  }
  throw new Error(`Lip-sync avatar asset timed out after ${config.pollTimeoutMs}ms`)
}

export async function createLipSyncVideoTask({
  assetUrl,
  audioInput,
  prompt,
  durationSeconds,
  clientBusinessId,
  config = getLipSyncConfig(),
}) {
  assertToApiProvider(config)
  const payload = await requestJson(
    `${config.baseUrl}/videos/generations`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildSeedanceLipSyncPayload({
          config,
          assetUrl,
          audioInput,
          prompt,
          durationSeconds,
          clientBusinessId,
        }),
      ),
    },
    config,
    'Lip-sync video task creation',
  )
  const taskId = String(payload?.id || payload?.task_id || '').trim()
  if (!taskId) throw new Error('Lip-sync video task creation returned no task ID')
  return { taskId, payload }
}

export async function getLipSyncVideoTask(taskId, config = getLipSyncConfig()) {
  assertToApiProvider(config)
  return requestJson(
    `${config.baseUrl}/videos/generations/${encodeURIComponent(taskId)}`,
    { method: 'GET' },
    config,
    'Lip-sync video status request',
  )
}

export async function waitForLipSyncVideoTask(
  taskId,
  { config = getLipSyncConfig(), onProgress } = {},
) {
  const deadline = Date.now() + config.pollTimeoutMs
  while (Date.now() < deadline) {
    const payload = await getLipSyncVideoTask(taskId, config)
    const status = String(payload?.status || '').trim().toLowerCase()
    const progress = Math.max(0, Math.min(100, Number(payload?.progress) || 0))
    onProgress?.({ status, progress, payload })
    if (status === 'completed') {
      const videoUrl = String(payload?.result?.data?.[0]?.url || '').trim()
      const lastFrameUrl = String(payload?.result?.data?.[0]?.last_frame_url || '').trim()
      if (!/^https?:\/\//i.test(videoUrl)) {
        throw new Error('Lip-sync video task completed without a public video URL')
      }
      return { payload, videoUrl, lastFrameUrl }
    }
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      const detail = payload?.error?.message || payload?.fail_reason || payload?.message || status
      throw new Error(`Lip-sync video generation failed: ${detail}`)
    }
    await sleep(config.pollIntervalMs)
  }
  throw new Error(`Lip-sync video generation timed out after ${config.pollTimeoutMs}ms`)
}
