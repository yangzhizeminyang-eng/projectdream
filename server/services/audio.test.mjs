import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildAudioAssetStorageKey,
  buildGeneratedAudioStorageKey,
  createQwenDesignedVoice,
  generateAudioCandidates,
  resolveSpeechModelEndpoint,
} from './audio.mjs'

test('builds a stable storage key for a persisted audio asset', () => {
  assert.equal(
    buildAudioAssetStorageKey({ projectId: 49, audioAssetId: 234, extension: '.wav' }),
    'projects/49/audio-assets/234.wav',
  )
})

test('builds a stable storage key for a generated audio candidate', () => {
  assert.equal(
    buildGeneratedAudioStorageKey({
      projectId: 12,
      trackType: 'dialogue',
      versionNo: 3,
      candidateNo: 2,
      extension: '.wav',
    }),
    'projects/12/generated-audio/dialogue/v3/c2.wav',
  )
})

test('rejects unsafe generated audio storage key parts', () => {
  assert.throws(
    () =>
      buildGeneratedAudioStorageKey({
        projectId: 12,
        trackType: '../escape',
        versionNo: 3,
        candidateNo: 2,
        extension: '.wav',
      }),
    /invalid generated audio storage key/i,
  )
})

test('creates a Chinese custom voice from a text prompt and returns its preview and voice id', async () => {
  let request
  const result = await createQwenDesignedVoice({
    apiKey: 'test-key',
    targetModel: 'cosyvoice-v3.5-flash',
    voicePrompt: '成年男性，中低音，音色厚实，语速稳，克制但有压迫感。',
    previewText: '我给过你机会，现在把你知道的都说出来。',
    prefix: 'zhao_heng',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) }
      return new Response(JSON.stringify({
        output: {
          voice_id: 'cosyvoice-v3.5-flash-vd-zhaoheng-123',
          target_model: 'cosyvoice-v3.5-flash',
          preview_audio: { data: 'UklGRg==', response_format: 'wav', sample_rate: 24000 },
        },
      }), { status: 200 })
    },
  })

  assert.equal(request.url, 'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/customization')
  assert.equal(request.body.model, 'voice-enrollment')
  assert.equal(request.body.input.action, 'create_voice')
  assert.equal(request.body.input.target_model, 'cosyvoice-v3.5-flash')
  assert.equal(request.body.input.voice_prompt, '成年男性，中低音，音色厚实，语速稳，克制但有压迫感。')
  assert.equal(result.voiceId, 'cosyvoice-v3.5-flash-vd-zhaoheng-123')
  assert.equal(result.previewAudioData, 'UklGRg==')
})

test('routes a custom CosyVoice id through the matching native synthesis endpoint', () => {
  assert.equal(
    resolveSpeechModelEndpoint('cosyvoice-v3.5-flash'),
    'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer',
  )
})

test('synthesizes with a designed voice id on CosyVoice endpoint and does not switch models', async (t) => {
  const previous = {
    provider: process.env.AUDIO_PROVIDER,
    key: process.env.DASHSCOPE_API_KEY,
    fallback: process.env.AUDIO_FALLBACK_MODEL,
  }
  process.env.AUDIO_PROVIDER = 'dashscope'
  process.env.DASHSCOPE_API_KEY = 'test-key'
  process.env.AUDIO_FALLBACK_MODEL = 'qwen3-tts-instruct-flash'
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'projectdream-voice-test-'))
  const originalFetch = globalThis.fetch
  t.after(async () => {
    globalThis.fetch = originalFetch
    if (previous.provider == null) delete process.env.AUDIO_PROVIDER
    else process.env.AUDIO_PROVIDER = previous.provider
    if (previous.key == null) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previous.key
    if (previous.fallback == null) delete process.env.AUDIO_FALLBACK_MODEL
    else process.env.AUDIO_FALLBACK_MODEL = previous.fallback
    await rm(outputDir, { recursive: true, force: true })
  })

  let postBody
  let postCount = 0
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'GET') {
      return new Response(Buffer.from('RIFF0000WAVE'), { status: 200, headers: { 'content-type': 'audio/wav' } })
    }
    postCount += 1
    postBody = JSON.parse(options.body)
    return new Response(JSON.stringify({ output: { audio: { url: 'https://audio.test/preview.wav' } } }), { status: 200 })
  }

  const [candidate] = await generateAudioCandidates({
    projectId: 50,
    trackType: 'voice-preview',
    versionNo: 1,
    text: '我给过你机会，现在把你知道的都说出来。',
    voiceName: 'cosyvoice-v3.5-flash-vd-zhaoheng-123',
    modelName: 'cosyvoice-v3.5-flash',
    instructions: '压低声音，冷硬盘问，句尾下压。',
    allowModelFallback: false,
    publicBaseUrl: 'http://localhost/generated/audio',
    outputDir,
  })

  assert.equal(postCount, 1)
  assert.equal(postBody.model, 'cosyvoice-v3.5-flash')
  assert.equal(postBody.input.voice, 'cosyvoice-v3.5-flash-vd-zhaoheng-123')
  assert.equal(postBody.input.instruction, '压低声音，冷硬盘问，句尾下压。')
  assert.equal('instructions' in postBody.input, false)
  assert.equal(candidate.voiceName, postBody.input.voice)
  assert.equal(candidate.modelName, postBody.model)
})

test('does not silently switch a custom voice id to a different TTS model', async (t) => {
  const previous = {
    provider: process.env.AUDIO_PROVIDER,
    key: process.env.DASHSCOPE_API_KEY,
    fallback: process.env.AUDIO_FALLBACK_MODEL,
  }
  process.env.AUDIO_PROVIDER = 'dashscope'
  process.env.DASHSCOPE_API_KEY = 'test-key'
  process.env.AUDIO_FALLBACK_MODEL = 'qwen3-tts-instruct-flash'
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'projectdream-locked-voice-test-'))
  const originalFetch = globalThis.fetch
  t.after(async () => {
    globalThis.fetch = originalFetch
    if (previous.provider == null) delete process.env.AUDIO_PROVIDER
    else process.env.AUDIO_PROVIDER = previous.provider
    if (previous.key == null) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previous.key
    if (previous.fallback == null) delete process.env.AUDIO_FALLBACK_MODEL
    else process.env.AUDIO_FALLBACK_MODEL = previous.fallback
    await rm(outputDir, { recursive: true, force: true })
  })

  const models = []
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'GET') return new Response(Buffer.from('RIFF0000WAVE'), { status: 200 })
    models.push(JSON.parse(options.body).model)
    return new Response(JSON.stringify({ code: 'InvalidVoice', message: 'voice id is invalid' }), { status: 400 })
  }

  await assert.rejects(generateAudioCandidates({
    projectId: 50,
    trackType: 'dialogue',
    versionNo: 1,
    text: '我给过你机会，现在把你知道的都说出来。',
    voiceName: 'cosyvoice-v3.5-flash-vd-zhaoheng-123',
    modelName: 'cosyvoice-v3.5-flash',
    allowModelFallback: false,
    publicBaseUrl: 'http://localhost/generated/audio',
    outputDir,
  }), /DashScope speech synthesis failed/)

  assert.deepEqual(models, ['cosyvoice-v3.5-flash'])
})
