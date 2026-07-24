import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractBigModelVideoUrl,
  generateVideoCandidates,
  resolveBigModelVideoSize,
  resolveGeneratedVideoDuration,
  resolveVideoImageInput,
  rewriteVideoPromptForSafety,
} from './video.mjs'

test('BigModel video size falls back to a supported 16:9 value', () => {
  assert.equal(resolveBigModelVideoSize({ size: '', width: 1280, height: 720 }), '1920x1080')
  assert.equal(resolveBigModelVideoSize({ size: '1920x1080', width: 1, height: 1 }), '1920x1080')
})

test('BigModel video URL is read from async results', () => {
  assert.equal(
    extractBigModelVideoUrl({ video_result: [{ url: 'https://example.com/video.mp4' }] }),
    'https://example.com/video.mp4',
  )
})

test('CogVideoX fixed output duration is recorded as five seconds', () => {
  assert.equal(resolveGeneratedVideoDuration({}, 4, 'cogvideox-flash'), 5)
  assert.equal(
    resolveGeneratedVideoDuration({ video_result: [{ duration: 6 }] }, 4, 'cogvideox-flash'),
    6,
  )
})

test('video prompt safety rewrite softens audit-sensitive wording', () => {
  const prompt = rewriteVideoPromptForSafety(
    '头顶灯管闪两下后熄灭，档案室陷入断电黑暗。设备停摆，她感到恐惧。',
  )
  assert.doesNotMatch(prompt, /熄灭|断电黑暗|停摆|恐惧/)
  assert.match(prompt, /变暗|低照度|声音逐渐减弱|紧张/)
  assert.match(prompt, /无血腥|无伤害画面|非暴力/)
})

test('public image URL is passed through without uploading', async () => {
  assert.equal(
    await resolveVideoImageInput('https://cdn.example.com/confirmed.png'),
    'https://cdn.example.com/confirmed.png',
  )
})

test('local persisted image is uploaded and resolved to a public URL', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (calls.length === 1) {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      })
    }
    return new Response(
      JSON.stringify({ data: { url: 'https://files.toapis.com/video-source.png' } }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }

  try {
    const result = await resolveVideoImageInput(
      'http://127.0.0.1:3001/generated/frame/upload-test.png',
      {
        imageUploadBaseUrl: 'https://toapis.com/v1',
        imageUploadApiKey: 'test-key',
        imageUploadTimeoutMs: 1000,
        imageUploadRetryAttempts: 0,
        imageUploadRetryBaseDelayMs: 1,
      },
    )
    assert.equal(result, 'https://files.toapis.com/video-source.png')
    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, 'http://127.0.0.1:3001/generated/frame/upload-test.png')
    assert.equal(calls[1].url, 'https://toapis.com/v1/uploads/images')
    assert.equal(calls[1].options.headers.Authorization, 'Bearer test-key')
    assert.ok(calls[1].options.body instanceof FormData)
    assert.equal(calls[1].options.body.get('purpose'), 'generation')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('local image upload failure preserves the provider detail', async () => {
  const originalFetch = globalThis.fetch
  let callCount = 0
  globalThis.fetch = async () => {
    callCount += 1
    if (callCount === 1) {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      })
    }
    return new Response(JSON.stringify({ message: 'upload quota exceeded' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    await assert.rejects(
      resolveVideoImageInput('http://127.0.0.1:3001/generated/frame/upload-failure-test.png', {
        imageUploadBaseUrl: 'https://toapis.com/v1',
        imageUploadApiKey: 'test-key',
        imageUploadTimeoutMs: 1000,
        imageUploadRetryAttempts: 0,
        imageUploadRetryBaseDelayMs: 1,
      }),
      /Video source image upload failed: upload quota exceeded/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('local image upload retries a transient network error', async () => {
  const originalFetch = globalThis.fetch
  let callCount = 0
  globalThis.fetch = async () => {
    callCount += 1
    if (callCount === 1) {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      })
    }
    if (callCount === 2) {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
    }
    return new Response(
      JSON.stringify({ data: { url: 'https://files.toapis.com/retry-success.png' } }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }

  try {
    const result = await resolveVideoImageInput(
      'http://127.0.0.1:3001/generated/frame/upload-retry-test.png',
      {
        imageUploadBaseUrl: 'https://toapis.com/v1',
        imageUploadApiKey: 'test-key',
        imageUploadTimeoutMs: 1000,
        imageUploadRetryAttempts: 1,
        imageUploadRetryBaseDelayMs: 1,
      },
    )
    assert.equal(result, 'https://files.toapis.com/retry-success.png')
    assert.equal(callCount, 3)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Agnes video generation uploads a private confirmed image before task creation', async () => {
  const originalFetch = globalThis.fetch
  const originalEnv = {
    VIDEO_PROVIDER: process.env.VIDEO_PROVIDER,
    VIDEO_BASE_URL: process.env.VIDEO_BASE_URL,
    VIDEO_API_KEY: process.env.VIDEO_API_KEY,
    AGNES_API_KEY: process.env.AGNES_API_KEY,
    VIDEO_IMAGE_UPLOAD_API_KEY: process.env.VIDEO_IMAGE_UPLOAD_API_KEY,
    VIDEO_CREATE_RETRY_ATTEMPTS: process.env.VIDEO_CREATE_RETRY_ATTEMPTS,
    VIDEO_POLL_INTERVAL_MS: process.env.VIDEO_POLL_INTERVAL_MS,
    VIDEO_POLL_TIMEOUT_MS: process.env.VIDEO_POLL_TIMEOUT_MS,
  }
  const calls = []
  process.env.VIDEO_PROVIDER = 'agnes'
  process.env.VIDEO_BASE_URL = 'https://apihub.agnes-ai.com/v1'
  process.env.VIDEO_API_KEY = 'agnes-key'
  process.env.AGNES_API_KEY = ''
  process.env.VIDEO_IMAGE_UPLOAD_API_KEY = 'upload-key'
  process.env.VIDEO_CREATE_RETRY_ATTEMPTS = '0'
  process.env.VIDEO_POLL_INTERVAL_MS = '1'
  process.env.VIDEO_POLL_TIMEOUT_MS = '100'

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (calls.length === 1) {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      })
    }
    if (calls.length === 2) {
      return new Response(JSON.stringify({ data: { url: 'https://files.toapis.com/agnes.png' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (calls.length === 3) {
      assert.equal(String(url), 'https://apihub.agnes-ai.com/v1/videos')
      const body = JSON.parse(String(options.body || '{}'))
      assert.equal(body.image, 'https://files.toapis.com/agnes.png')
      return new Response(JSON.stringify({ video_id: 'video-1', status: 'pending' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(
      JSON.stringify({ status: 'completed', metadata: { url: 'https://cdn.example.com/video.mp4' } }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }

  try {
    const result = await generateVideoCandidates({
      imageUrl: 'http://127.0.0.1:3001/generated/frame/agnes-local.png',
      prompt: '温叙缓慢走出阴影。',
      motionMode: 'PAN',
      durationSeconds: 5,
      modelName: 'agnes-video-v2.0',
      candidateCount: 1,
    })
    assert.equal(result[0].videoUrl, 'https://cdn.example.com/video.mp4')
    assert.equal(calls[1].url, 'https://toapis.com/v1/uploads/images')
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
