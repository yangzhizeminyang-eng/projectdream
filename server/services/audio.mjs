import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeObjectKey } from './object-storage.mjs'

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

export function buildGeneratedAudioStorageKey({
  projectId,
  trackType,
  versionNo,
  candidateNo,
  extension,
}) {
  const normalizedProjectId = Number(projectId)
  const normalizedTrackType = String(trackType || '').trim().toLowerCase()
  const normalizedVersionNo = Number(versionNo)
  const normalizedCandidateNo = Number(candidateNo)
  const normalizedExtension = String(extension || '').trim().toLowerCase()
  if (
    !Number.isSafeInteger(normalizedProjectId) ||
    normalizedProjectId <= 0 ||
    !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalizedTrackType) ||
    !Number.isSafeInteger(normalizedVersionNo) ||
    normalizedVersionNo <= 0 ||
    !Number.isSafeInteger(normalizedCandidateNo) ||
    normalizedCandidateNo <= 0 ||
    !['.wav', '.mp3', '.ogg', '.m4a', '.webm'].includes(normalizedExtension)
  ) {
    throw new Error('invalid generated audio storage key')
  }
  return normalizeObjectKey(
    `projects/${normalizedProjectId}/generated-audio/${normalizedTrackType}/v${normalizedVersionNo}/c${normalizedCandidateNo}${normalizedExtension}`,
  )
}

export function buildAudioAssetStorageKey({ projectId, audioAssetId, extension = '.wav' }) {
  const normalizedProjectId = Number(projectId)
  const normalizedAudioAssetId = Number(audioAssetId)
  const normalizedExtension = String(extension || '').trim().toLowerCase()
  if (
    !Number.isSafeInteger(normalizedProjectId) ||
    normalizedProjectId <= 0 ||
    !Number.isSafeInteger(normalizedAudioAssetId) ||
    normalizedAudioAssetId <= 0 ||
    !['.wav', '.mp3', '.ogg', '.m4a', '.webm'].includes(normalizedExtension)
  ) {
    throw new Error('invalid audio asset storage key')
  }
  return normalizeObjectKey(
    `projects/${normalizedProjectId}/audio-assets/${normalizedAudioAssetId}${normalizedExtension}`,
  )
}

function parseRetryAfter(value) {
  const raw = String(value || '').trim()
  if (!raw) return 0

  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)

  const retryAt = Date.parse(raw)
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function getAudioConfig() {
  return {
    provider: String(process.env.AUDIO_PROVIDER || 'mock').trim().toLowerCase(),
    baseUrl: normalizeBaseUrl(
      process.env.AUDIO_BASE_URL ||
        'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    ),
    apiKey: String(process.env.DASHSCOPE_API_KEY || process.env.AUDIO_API_KEY || '').trim(),
    defaultModel: String(process.env.AUDIO_MODEL || 'qwen3-tts-flash').trim(),
    voiceDesignModel: String(process.env.AUDIO_VOICE_DESIGN_MODEL || 'cosyvoice-v3.5-flash').trim(),
    fallbackModel: String(process.env.AUDIO_FALLBACK_MODEL || 'qwen3-tts-instruct-flash').trim(),
    defaultVoice: String(process.env.AUDIO_VOICE || 'Cherry').trim(),
    languageType: String(process.env.AUDIO_LANGUAGE_TYPE || 'Chinese').trim(),
    maxTextLength: parsePositiveInt(process.env.AUDIO_MAX_TEXT_LENGTH, 600),
    timeoutMs: parsePositiveInt(process.env.AUDIO_TIMEOUT_MS, 120000),
    retryAttempts: parseNonNegativeInt(process.env.AUDIO_RETRY_ATTEMPTS, 2),
    retryBaseDelayMs: parsePositiveInt(process.env.AUDIO_RETRY_BASE_DELAY_MS, 3000),
    fallbackToMock: parseBoolean(process.env.AUDIO_FALLBACK_TO_MOCK, false),
  }
}

export function resolveSpeechModelEndpoint(modelName) {
  const model = String(modelName || '').trim().toLowerCase()
  if (model.startsWith('cosyvoice-')) {
    return 'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer'
  }
  if (model.startsWith('qwen-audio-')) {
    return 'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer'
  }
  return ''
}

export function limitCosyVoiceInstruction(value, maxUnits = 100) {
  let output = ''
  let units = 0
  for (const character of String(value || '').trim()) {
    const nextUnits = /\p{Script=Han}/u.test(character) ? 2 : 1
    if (units + nextUnits > maxUnits) break
    output += character
    units += nextUnits
  }
  return output.trim()
}

export async function createQwenDesignedVoice({
  apiKey,
  targetModel = getAudioConfig().voiceDesignModel,
  voicePrompt,
  previewText,
  prefix,
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error('Missing DASHSCOPE_API_KEY or AUDIO_API_KEY configuration')
  const normalizedPrompt = String(voicePrompt || '').trim()
  const normalizedPreviewText = String(previewText || '').trim()
  const normalizedPrefix = String(prefix || '').replace(/[^a-z0-9]/gi, '').slice(0, 10)
  if (!normalizedPrompt || normalizedPrompt.length > 500) {
    throw new Error('Voice design prompt must contain 1 to 500 characters')
  }
  if (normalizedPreviewText.length < 15 || normalizedPreviewText.length > 200) {
    throw new Error('Voice design preview text must contain 15 to 200 characters')
  }
  if (!normalizedPrefix) throw new Error('Voice design prefix must contain letters or digits')
  if (!/^cosyvoice-v3\.5-(?:flash|plus)$/i.test(targetModel)) {
    throw new Error('Qwen text voice design requires a supported CosyVoice v3.5 target model')
  }

  const response = await fetchImpl(
    'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/customization',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'voice-enrollment',
        input: {
          action: 'create_voice',
          target_model: targetModel,
          voice_prompt: normalizedPrompt,
          preview_text: normalizedPreviewText,
          prefix: normalizedPrefix,
          language_hints: ['zh'],
        },
        parameters: { sample_rate: 24000, response_format: 'wav' },
      }),
      signal: AbortSignal.timeout(120000),
    },
  )
  const responseText = await response.text()
  let payload = null
  try { payload = responseText ? JSON.parse(responseText) : null } catch { payload = null }
  if (!response.ok) {
    const detail = payload?.message || payload?.code || responseText.slice(0, 300) || `HTTP ${response.status}`
    throw createProviderError(`Qwen voice design failed: ${detail}`, { status: response.status })
  }
  const output = payload?.output || {}
  const voiceId = String(output.voice_id || '').trim()
  const previewAudioData = String(output.preview_audio?.data || '').trim()
  if (!voiceId || !previewAudioData) throw new Error('Qwen voice design returned no custom voice id or preview audio')
  return {
    voiceId,
    targetModel: String(output.target_model || targetModel),
    previewAudioData,
    previewAudioFormat: String(output.preview_audio?.response_format || 'wav'),
    sampleRate: Number(output.preview_audio?.sample_rate) || 24000,
    requestId: String(payload?.request_id || '').trim() || null,
  }
}

export function isMockAudioProvider(config = getAudioConfig()) {
  return config.provider === 'mock'
}

function createProviderError(message, options = {}) {
  const error = new Error(message)
  error.status = Number(options.status) || 0
  error.retryAfterMs = Number(options.retryAfterMs) || 0
  error.retryable = Boolean(options.retryable)
  return error
}

async function requestDashScopeAudio({
  config,
  text,
  voiceName,
  modelName,
  instructions,
  languageType,
}) {
  // 调用 DashScope TTS 接口。
  // 供应商可能返回远程 audio.url，也可能直接返回 base64 audio.data，下面统一处理。
  if (!config.apiKey) throw new Error('Missing DASHSCOPE_API_KEY or AUDIO_API_KEY configuration')

  let response
  try {
    const endpoint = resolveSpeechModelEndpoint(modelName) || config.baseUrl
    const isCosyVoice = String(modelName || '').toLowerCase().startsWith('cosyvoice-')
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelName,
        input: {
          text,
          voice: voiceName,
          ...(isCosyVoice
            ? { format: 'wav', sample_rate: 24000 }
            : { language_type: String(languageType || config.languageType || 'Chinese').trim() || 'Chinese' }),
          ...(instructions
            ? {
                [isCosyVoice ? 'instruction' : 'instructions']: isCosyVoice
                  ? limitCosyVoiceInstruction(instructions)
                  : instructions,
                ...(!isCosyVoice ? { optimize_instructions: true } : {}),
              }
            : {}),
        },
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      throw createProviderError('DashScope speech synthesis timed out', { retryable: true })
    }
    throw createProviderError(
      `DashScope speech synthesis request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      { retryable: true },
    )
  }

  const responseText = await response.text()
  let payload = null
  try {
    payload = responseText ? JSON.parse(responseText) : null
  } catch {
    payload = null
  }

  if (!response.ok) {
    const detail =
      payload?.message ||
      payload?.error?.message ||
      payload?.code ||
      responseText.slice(0, 400) ||
      `HTTP ${response.status}`
    throw createProviderError(`DashScope speech synthesis failed: ${detail}`, {
      status: response.status,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    })
  }

  const audio = payload?.output?.audio || {}
  const audioUrl = String(audio.url || '').trim()
  const audioData = typeof audio.data === 'string' ? audio.data.trim() : ''
  if (!audioUrl && !audioData) {
    throw new Error('DashScope speech synthesis returned no audio URL or audio data')
  }

  return {
    audioUrl,
    audioData,
    requestId: String(payload?.request_id || audio.id || '').trim() || null,
  }
}

async function requestDashScopeAudioWithRetry(args) {
  // 只对明确可重试的错误进行指数退避重试，并尊重供应商的 Retry-After。
  const { config } = args
  let lastError = null

  for (let attempt = 0; attempt <= config.retryAttempts; attempt += 1) {
    try {
      return await requestDashScopeAudio(args)
    } catch (error) {
      lastError = error
      if (!error?.retryable || attempt >= config.retryAttempts) throw error
      const delayMs = Math.min(
        60000,
        Math.max(config.retryBaseDelayMs * 2 ** attempt, Number(error?.retryAfterMs) || 0),
      )
      await sleep(delayMs)
    }
  }

  throw lastError || new Error('DashScope speech synthesis failed')
}

function extensionFromContentType(contentType) {
  const normalized = String(contentType || '').toLowerCase()
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return '.mp3'
  if (normalized.includes('ogg')) return '.ogg'
  if (normalized.includes('mp4') || normalized.includes('m4a')) return '.m4a'
  return '.wav'
}

async function resolveAudioBytes(result, config) {
  // 把“base64 音频”和“远程 URL 音频”统一转成 Buffer。
  if (result.audioData) {
    const normalized = result.audioData.replace(/^data:audio\/[^;]+;base64,/i, '')
    const bytes = Buffer.from(normalized, 'base64')
    if (!bytes.length) throw new Error('DashScope returned empty audio data')
    return { bytes, contentType: 'audio/wav' }
  }

  let response
  try {
    response = await fetch(result.audioUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (error) {
    throw new Error(
      `DashScope audio download failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  }

  if (!response.ok) {
    throw new Error(`DashScope audio download failed with HTTP ${response.status}`)
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.length) throw new Error('DashScope audio download returned an empty file')
  return {
    bytes,
    contentType: response.headers.get('content-type') || 'audio/wav',
  }
}

function readWavDurationSeconds(bytes) {
  // 从 WAV 的 fmt/data chunk 计算真实时长，供时间线和导出使用。
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') return null
  if (bytes.toString('ascii', 8, 12) !== 'WAVE') return null

  let byteRate = 0
  let dataSize = 0
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString('ascii', offset, offset + 4)
    const chunkSize = bytes.readUInt32LE(offset + 4)
    const dataOffset = offset + 8
    if (chunkId === 'fmt ' && chunkSize >= 12 && dataOffset + 12 <= bytes.length) {
      byteRate = bytes.readUInt32LE(dataOffset + 8)
    }
    if (chunkId === 'data') {
      dataSize = Math.min(chunkSize, Math.max(0, bytes.length - dataOffset))
      break
    }
    offset = dataOffset + chunkSize + (chunkSize % 2)
  }

  if (!byteRate || !dataSize) return null
  return Math.max(0.1, Number((dataSize / byteRate).toFixed(3)))
}

function expectedSpeechDurationSeconds(text) {
  const speechCharacters = [...String(text || '')].filter((character) =>
    /[\p{Script=Han}\p{L}\p{N}]/u.test(character),
  ).length
  return Math.max(0.8, speechCharacters / 5)
}

export async function generateAudioCandidates({
  projectId,
  trackType,
  versionNo,
  text,
  voiceName,
  modelName,
  instructions,
  languageType = null,
  publicBaseUrl,
  outputDir,
  candidateCount = 1,
  allowModelFallback = true,
}) {
  // 音频生成主入口：校验文本 -> 调 TTS -> 下载文件 -> 计算时长 -> 持久化到本地。
  const config = getAudioConfig()
  if (isMockAudioProvider(config)) throw new Error('AUDIO_PROVIDER=mock')
  if (config.provider !== 'dashscope') throw new Error(`Unsupported AUDIO_PROVIDER: ${config.provider}`)
  if (!config.baseUrl) throw new Error('Missing AUDIO_BASE_URL configuration')

  const normalizedText = String(text || '').trim()
  if (!normalizedText) throw new Error('Speech synthesis text is required')
  if (normalizedText.length > config.maxTextLength) {
    throw new Error(`Speech synthesis text exceeds ${config.maxTextLength} characters`)
  }

  const effectiveVoice = String(voiceName || '').trim() || config.defaultVoice
  const effectiveModel = String(modelName || '').trim() || config.defaultModel
  const totalCandidates = Math.max(1, Math.min(3, Number(candidateCount) || 1))
  const candidates = []
  await mkdir(outputDir, { recursive: true })

  for (let index = 0; index < totalCandidates; index += 1) {
    let generationModel = effectiveModel
    const fallbackModel = String(config.fallbackModel || '').trim()
    const requestAudio = async (model) => {
      const providerResult = await requestDashScopeAudioWithRetry({
        config,
        text: normalizedText,
        voiceName: effectiveVoice,
        modelName: model,
        instructions: String(instructions || '').trim() || null,
        languageType,
      })
      const resolved = await resolveAudioBytes(providerResult, config)
      return {
        ...resolved,
        providerResult,
        durationSeconds: readWavDurationSeconds(resolved.bytes),
      }
    }

    let generated
    try {
      generated = await requestAudio(generationModel)
    } catch (error) {
      const canFallback =
        allowModelFallback &&
        fallbackModel &&
        fallbackModel !== generationModel &&
        /invalid audio|no audio url|no audio data/i.test(String(error?.message || ''))
      if (!canFallback) throw error
      generationModel = fallbackModel
      generated = await requestAudio(generationModel)
    }

    const durationFloor = expectedSpeechDurationSeconds(normalizedText) * 0.55
    if (
      allowModelFallback &&
      fallbackModel &&
      fallbackModel !== generationModel &&
      generated.durationSeconds &&
      generated.durationSeconds < durationFloor
    ) {
      generationModel = fallbackModel
      generated = await requestAudio(generationModel)
    }

    const { bytes, contentType, providerResult, durationSeconds } = generated
    const extension = extensionFromContentType(contentType)
    const hash = createHash('sha1')
      .update(
        `${projectId}-${trackType}-${versionNo}-${index + 1}-${normalizedText}-${effectiveVoice}-${generationModel}-${instructions || ''}`,
      )
      .digest('hex')
      .slice(0, 14)
    const fileName = `audio-${projectId}-${trackType}-v${versionNo}-c${index + 1}-${hash}${extension}`
    await writeFile(path.join(outputDir, fileName), bytes)

    candidates.push({
      audioUrl: `${publicBaseUrl}/${fileName}`,
      filePath: path.join(outputDir, fileName),
      durationSeconds,
      voiceName: effectiveVoice,
      modelName: generationModel,
      voiceInstructions: String(instructions || '').trim() || null,
      providerRequestId: providerResult.requestId,
    })
  }

  return candidates
}
