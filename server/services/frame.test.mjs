import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertFrameImageRatio,
  assertFrameReferenceImageSupport,
  buildCharacterReferencePrompt,
  buildBigModelFramePayload,
  buildToApiGenerationPayload,
  extractToApiImageUrl,
  extractImageDimensions,
  generateFrameCandidates,
  normalizeFramePromptAspectRatio,
  parseFrameModelList,
  resolveFrameReferenceImageUrls,
  resolveBigModelFrameSize,
  resolveFrameModelChain,
} from './frame.mjs'

test('frame fallback model list ignores empty entries', () => {
  assert.deepEqual(parseFrameModelList('agnes-image-2.0-flash, ,backup-image'), [
    'agnes-image-2.0-flash',
    'backup-image',
  ])
})

test('requested frame model stays first and duplicate fallbacks are removed', () => {
  assert.deepEqual(
    resolveFrameModelChain(
      {
        defaultModel: 'agnes-image-2.1-flash',
        fallbackModels: ['agnes-image-2.0-flash', 'agnes-image-2.1-flash'],
      },
      'agnes-image-2.1-flash',
    ),
    ['agnes-image-2.1-flash', 'agnes-image-2.0-flash'],
  )
})

test('ToAPI image URL is read from completed async task responses', () => {
  assert.equal(
    extractToApiImageUrl({ result: { data: [{ url: 'https://example.com/frame.png' }] } }),
    'https://example.com/frame.png',
  )
  assert.equal(
    extractToApiImageUrl({ data: [{ url: 'https://example.com/direct.png' }] }),
    'https://example.com/direct.png',
  )
})

test('BigModel CogView uses the nearest supported landscape size', () => {
  assert.equal(resolveBigModelFrameSize({ imageSize: '1344x768', imageRatio: '16:9' }), '1344x768')
  assert.equal(resolveBigModelFrameSize({ imageSize: '1k', imageRatio: '16:9' }), '1344x768')
  assert.deepEqual(
    buildBigModelFramePayload({
      config: { imageSize: '1344x768', imageRatio: '16:9' },
      prompt: 'cinematic subway frame',
      modelName: 'cogview-3-flash',
    }),
    {
      model: 'cogview-3-flash',
      prompt: 'cinematic subway frame',
      size: '1344x768',
    },
  )
})

test('ToAPI request keeps native 16:9 output and public reference images', () => {
  assert.deepEqual(
    buildToApiGenerationPayload({
      config: { imageRatio: '16:9', imageSize: '1k' },
      prompt: 'wide cinematic frame',
      modelName: 'gpt-image-2',
      referenceImageUrls: ['https://example.com/a.png', '', 'data:image/png;base64,ignored'],
    }),
    {
      model: 'gpt-image-2',
      prompt: 'wide cinematic frame',
      n: 1,
      size: '16:9',
      resolution: '1k',
      response_format: 'url',
      image_urls: ['https://example.com/a.png'],
    },
  )
})

test('BigModel blocks reference images because it cannot lock character identity', () => {
  assert.throws(
    () =>
      assertFrameReferenceImageSupport({
        config: { provider: 'bigmodel', defaultModel: 'cogview-3-flash' },
        modelName: 'cogview-3-flash',
        referenceImageUrls: ['http://127.0.0.1:3001/generated/frame/ref.png'],
      }),
    /不支持定妆参考图输入/,
  )
})

test('ToAPI allows reference images for character consistency', () => {
  assert.deepEqual(
    assertFrameReferenceImageSupport({
      config: { provider: 'toapi', defaultModel: 'gpt-image-2' },
      modelName: 'gpt-image-2',
      referenceImageUrls: ['http://127.0.0.1:3001/generated/frame/ref.png', 'data:image/png;base64,ignored'],
    }),
    ['http://127.0.0.1:3001/generated/frame/ref.png'],
  )
})

test('local character reference image is uploaded before ToAPI generation', async () => {
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
      JSON.stringify({ data: { url: 'https://files.toapis.com/reference.png' } }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }

  try {
    const refs = await resolveFrameReferenceImageUrls(
      ['http://127.0.0.1:3001/generated/frame/character-ref.png'],
      {
        referenceUploadBaseUrl: 'https://toapis.com/v1',
        referenceUploadApiKey: 'test-key',
        referenceUploadTimeoutMs: 1000,
        referenceUploadRetryAttempts: 0,
        referenceUploadRetryBaseDelayMs: 1,
      },
    )
    assert.deepEqual(refs, ['https://files.toapis.com/reference.png'])
    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, 'http://127.0.0.1:3001/generated/frame/character-ref.png')
    assert.equal(calls[1].url, 'https://toapis.com/v1/uploads/images')
    assert.equal(calls[1].options.headers.Authorization, 'Bearer test-key')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('generated PNG dimensions are parsed and checked against 16:9', () => {
  const png = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
  png.writeUInt32BE(1672, 16)
  png.writeUInt32BE(941, 20)

  const dimensions = extractImageDimensions(png)
  assert.deepEqual(dimensions, { width: 1672, height: 941 })
  assert.deepEqual(assertFrameImageRatio(dimensions, '16:9'), dimensions)
  assert.throws(
    () => assertFrameImageRatio({ width: 1024, height: 1024 }, '16:9'),
    /1024x1024.*16:9/,
  )
})

test('legacy cinemascope prompts are normalized to a full 16:9 canvas', () => {
  const prompt = normalizeFramePromptAspectRatio(
    '地下档案室，俯拍，电影感构图，cinemascope 2.39:1',
    '16:9',
  )
  assert.doesNotMatch(prompt, /2\.39:1|cinemascope/i)
  assert.match(prompt, /native 16:9 full-frame composition/i)
  assert.match(prompt, /no letterbox, no black bars/i)
})

test('character reference prompt stays full color even when project style is noir', () => {
  const prompt = buildCharacterReferencePrompt({
    prompt: '黑色电影风格，黑白灰为主，低照度，高反差，noir 氛围',
    character: {
      name: '温叙',
      roleTag: '女主角',
      personality: '安静而警觉',
      appearance: '约28岁，黑色齐肩直发低束，深灰风衣，米白针织衫',
    },
  })

  assert.match(prompt, /彩色写实人物定妆照/)
  assert.match(prompt, /自然肤色/)
  assert.match(prompt, /full-color character design reference/)
  assert.doesNotMatch(prompt, /黑色电影风格|黑白灰为主|低照度|高反差|noir 氛围/)
  assert.match(prompt, /色彩正常明亮/)
})

test('ToAPI retries a temporary 503 during task creation', async () => {
  const originalFetch = globalThis.fetch
  const originalEnv = {
    FRAME_PROVIDER: process.env.FRAME_PROVIDER,
    FRAME_API_KEY: process.env.FRAME_API_KEY,
    FRAME_BASE_URL: process.env.FRAME_BASE_URL,
    FRAME_MODEL: process.env.FRAME_MODEL,
    FRAME_IMAGE_SIZE: process.env.FRAME_IMAGE_SIZE,
    FRAME_IMAGE_RATIO: process.env.FRAME_IMAGE_RATIO,
    FRAME_RETRY_ATTEMPTS: process.env.FRAME_RETRY_ATTEMPTS,
    FRAME_RETRY_BASE_DELAY_MS: process.env.FRAME_RETRY_BASE_DELAY_MS,
  }
  let calls = 0
  let requestBody = null

  process.env.FRAME_PROVIDER = 'toapi'
  process.env.FRAME_API_KEY = 'test-key'
  process.env.FRAME_BASE_URL = 'https://example.test/v1'
  process.env.FRAME_MODEL = 'gpt-image-2'
  process.env.FRAME_IMAGE_SIZE = '1k'
  process.env.FRAME_IMAGE_RATIO = '16:9'
  process.env.FRAME_RETRY_ATTEMPTS = '2'
  process.env.FRAME_RETRY_BASE_DELAY_MS = '1'
  globalThis.fetch = async (_url, options) => {
    calls += 1
    requestBody = JSON.parse(options.body)
    if (calls < 3) {
      return new Response(JSON.stringify({ message: 'channels temporarily unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ data: [{ url: 'https://example.test/result.png' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const result = await generateFrameCandidates({
      storyboardId: 1,
      versionNo: 1,
      prompt: 'test frame',
      candidateCount: 1,
      referenceImageUrls: ['https://files.toapis.com/reference.png'],
      publicBaseUrl: '',
      outputDir: '',
    })
    assert.equal(calls, 3)
    assert.equal(result[0].imageUrl, 'https://example.test/result.png')
    assert.equal(requestBody.size, '16:9')
    assert.equal(requestBody.resolution, '1k')
    assert.deepEqual(requestBody.image_urls, ['https://files.toapis.com/reference.png'])
    assert.equal(requestBody.reference_images, undefined)
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('ToAPI image status invalid JSON is retried during polling', async () => {
  const originalFetch = globalThis.fetch
  const originalEnv = {
    FRAME_PROVIDER: process.env.FRAME_PROVIDER,
    FRAME_API_KEY: process.env.FRAME_API_KEY,
    FRAME_BASE_URL: process.env.FRAME_BASE_URL,
    FRAME_MODEL: process.env.FRAME_MODEL,
    FRAME_IMAGE_SIZE: process.env.FRAME_IMAGE_SIZE,
    FRAME_IMAGE_RATIO: process.env.FRAME_IMAGE_RATIO,
    FRAME_POLL_INTERVAL_MS: process.env.FRAME_POLL_INTERVAL_MS,
    FRAME_POLL_TIMEOUT_MS: process.env.FRAME_POLL_TIMEOUT_MS,
    FRAME_RETRY_ATTEMPTS: process.env.FRAME_RETRY_ATTEMPTS,
  }
  const calls = []

  process.env.FRAME_PROVIDER = 'toapi'
  process.env.FRAME_API_KEY = 'test-key'
  process.env.FRAME_BASE_URL = 'https://example.test/v1'
  process.env.FRAME_MODEL = 'gpt-image-2'
  process.env.FRAME_IMAGE_SIZE = '1k'
  process.env.FRAME_IMAGE_RATIO = '16:9'
  process.env.FRAME_POLL_INTERVAL_MS = '1'
  process.env.FRAME_POLL_TIMEOUT_MS = '100'
  process.env.FRAME_RETRY_ATTEMPTS = '0'

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (calls.length === 1) {
      return new Response(JSON.stringify({ id: 'task-1', status: 'queued' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (calls.length === 2) {
      return new Response('<html>gateway busy</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    }
    return new Response(
      JSON.stringify({
        status: 'completed',
        result: { data: [{ url: 'https://example.test/final.png' }] },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }

  try {
    const result = await generateFrameCandidates({
      storyboardId: 1,
      versionNo: 1,
      prompt: 'test frame',
      candidateCount: 1,
      publicBaseUrl: '',
      outputDir: '',
    })
    assert.equal(result[0].imageUrl, 'https://example.test/final.png')
    assert.equal(calls.length, 3)
    assert.equal(calls[1].url, 'https://example.test/v1/images/generations/task-1')
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
