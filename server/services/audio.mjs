import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
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

function parseNonNegativeInt(value, defaultValue) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : defaultValue
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
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

async function requestDashScopeAudio({ config, text, voiceName, modelName, instructions }) {
  if (!config.apiKey) throw new Error('Missing DASHSCOPE_API_KEY or AUDIO_API_KEY configuration')

  let response
  try {
    response = await fetch(config.baseUrl, {
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
          language_type: config.languageType,
          ...(instructions
            ? {
                instructions,
                optimize_instructions: true,
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
  publicBaseUrl,
  outputDir,
  candidateCount = 1,
}) {
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
        fallbackModel &&
        fallbackModel !== generationModel &&
        /invalid audio|no audio url|no audio data/i.test(String(error?.message || ''))
      if (!canFallback) throw error
      generationModel = fallbackModel
      generated = await requestAudio(generationModel)
    }

    const durationFloor = expectedSpeechDurationSeconds(normalizedText) * 0.55
    if (
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
      durationSeconds,
      voiceName: effectiveVoice,
      modelName: generationModel,
      voiceInstructions: String(instructions || '').trim() || null,
      providerRequestId: providerResult.requestId,
    })
  }

  return candidates
}
