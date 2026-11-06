import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertFrameImageRatio,
  assertFrameReferenceImageSupport,
  buildAgnesGenerationPayload,
  buildCharacterReferencePrompt,
  buildVolcengineGenerationPayload,
  resolveVolcengineImageSize,
  buildBigModelFramePayload,
  buildToApiGenerationPayload,
  buildVariantPrompt,
  buildCharacterImageStorageKey,
  buildAssetNodeImageStorageKey,
  buildGeneratedFrameStorageKey,
  extractToApiImageUrl,
  extractImageDimensions,
  generateFrameCandidates,
  getFrameConfig,
  normalizeFramePromptAspectRatio,
  parseFrameModelList,
  resolveFrameReferenceImageUrls,
  resolveBigModelFrameSize,
  resolveFrameImageRatio,
  resolveFrameModelChain,
  resolveFrameGenerationEndpoint,
} from './frame.mjs'

test('empty scene variants never inject character-design language', () => {
  const prompt = buildVariantPrompt(
    '空无一人的深夜公寓客厅，沙发靠墙',
    '人物，文字，水印',
    0,
    '16:9',
    'scene-environment',
  )

  assert.match(prompt, /empty environment/i)
  assert.doesNotMatch(prompt, /character design/i)
  assert.doesNotMatch(prompt, /core action and blocking/i)
})

test('builds stable storage keys for storyboard frames and character images', () => {
  assert.equal(
    buildGeneratedFrameStorageKey({
      projectId: 12,
      storyboardId: 88,
      versionNo: 3,
      candidateNo: 2,
      extension: '.png',
    }),
    'projects/12/frames/storyboards/88/v3/c2.png',
  )
  assert.equal(
    buildCharacterImageStorageKey({
      projectId: 12,
      characterId: 7,
      versionNo: 4,
      candidateNo: 1,
      extension: '.webp',
    }),
    'projects/12/frames/characters/7/v4/c1.webp',
  )
})

test('builds a stable storage key for asset canvas node images', () => {
  assert.equal(
    buildAssetNodeImageStorageKey({
      projectId: 12,
      assetNodeId: 45,
      versionNo: 1,
      candidateNo: 2,
      extension: '.png',
    }),
    'projects/12/frames/asset-nodes/45/v1/c2.png',
  )
  // 资产画布节点图必须和分镜静帧落在不同前缀下，
  // 否则节点 id 和 storyboard id 撞号时会互相覆盖。
  assert.notEqual(
    buildAssetNodeImageStorageKey({
      projectId: 12,
      assetNodeId: 88,
      versionNo: 1,
      candidateNo: 1,
      extension: '.png',
    }),
    buildGeneratedFrameStorageKey({
      projectId: 12,
      storyboardId: 88,
      versionNo: 1,
      candidateNo: 1,
      extension: '.png',
    }),
  )
})

test('rejects unsafe image storage key parts', () => {
  assert.throws(
    () =>
      buildGeneratedFrameStorageKey({
        projectId: 12,
        storyboardId: '../escape',
        versionNo: 1,
        candidateNo: 1,
        extension: '.png',
      }),
    /invalid generated frame storage key/i,
  )
  assert.throws(
    () =>
      buildAssetNodeImageStorageKey({
        projectId: 12,
        assetNodeId: 0,
        versionNo: 1,
        candidateNo: 1,
        extension: '.png',
      }),
    /invalid asset node image storage key/i,
  )
})

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

test('Agnes 2.1 request uses the documented 2K ratio and img2img payload', () => {
  assert.deepEqual(
    buildAgnesGenerationPayload({
      config: { imageSize: '2K', imageRatio: '16:9' },
      prompt: 'cinematic character frame',
      modelName: 'agnes-image-2.1-flash',
      referenceImageUrls: ['https://example.com/character.png'],
    }),
    {
      model: 'agnes-image-2.1-flash',
      prompt: 'cinematic character frame',
      size: '2K',
      ratio: '16:9',
      extra_body: {
        response_format: 'b64_json',
        image: 'https://example.com/character.png',
      },
    },
  )
})

test('Agnes provider enables the unified character asset board by default', () => {
  const original = {
    FRAME_PROVIDER: process.env.FRAME_PROVIDER,
    FRAME_BASE_URL: process.env.FRAME_BASE_URL,
    FRAME_MODEL: process.env.FRAME_MODEL,
    FRAME_ASSET_PACK_MODEL: process.env.FRAME_ASSET_PACK_MODEL,
    FRAME_CHARACTER_ASSET_PACK_ENABLED: process.env.FRAME_CHARACTER_ASSET_PACK_ENABLED,
  }
  process.env.FRAME_PROVIDER = 'agnes'
  process.env.FRAME_BASE_URL = 'https://apihub.agnes-ai.com/v1'
  process.env.FRAME_MODEL = 'agnes-image-2.1-flash'
  delete process.env.FRAME_ASSET_PACK_MODEL
  delete process.env.FRAME_CHARACTER_ASSET_PACK_ENABLED
  try {
    const config = getFrameConfig()
    assert.equal(config.defaultModel, 'agnes-image-2.1-flash')
    assert.equal(config.assetPackModel, 'agnes-image-2.1-flash')
    assert.equal(config.characterAssetPackEnabled, true)
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('Agnes requests inline base64 output so generated assets do not depend on output-host redirects', () => {
  const payload = buildAgnesGenerationPayload({
    config: { imageSize: '2K', imageRatio: '16:9' },
    prompt: 'empty apartment environment',
    modelName: 'agnes-image-2.1-flash',
  })
  assert.equal(payload.extra_body.response_format, 'b64_json')
})

test('asset view generation can override the global frame ratio without changing the default config', () => {
  assert.equal(resolveFrameImageRatio({ imageRatio: '16:9' }, '9:16'), '9:16')
  assert.equal(
    buildAgnesGenerationPayload({
      config: { imageSize: '2K', imageRatio: '16:9' },
      imageRatio: '9:16',
      prompt: 'full-body character asset',
      modelName: 'agnes-image-2.1-flash',
    }).ratio,
    '9:16',
  )
})

test('Volcengine Seedream request uses the Ark image-generation payload', () => {
  assert.deepEqual(
    buildVolcengineGenerationPayload({
      config: { imageSize: '2K', watermarkEnabled: false },
      prompt: 'cinematic character frame',
      modelName: 'doubao-seedream-4.5-251128',
      referenceImageUrls: ['data:image/png;base64,AAAA'],
    }),
    {
      model: 'doubao-seedream-4-5-251128',
      prompt: 'cinematic character frame',
      size: '2048x1152',
      stream: false,
      response_format: 'url',
      watermark: false,
      image: 'data:image/png;base64,AAAA',
    },
  )
})

test('Volcengine defaults to the official Seedream 5.0 Flash model and request contract', () => {
  const originalEnv = {
    FRAME_PROVIDER: process.env.FRAME_PROVIDER,
    FRAME_BASE_URL: process.env.FRAME_BASE_URL,
    FRAME_MODEL: process.env.FRAME_MODEL,
    FRAME_IMAGE_SIZE: process.env.FRAME_IMAGE_SIZE,
    FRAME_WATERMARK_ENABLED: process.env.FRAME_WATERMARK_ENABLED,
    FRAME_API_KEY: process.env.FRAME_API_KEY,
    ARK_API_KEY: process.env.ARK_API_KEY,
    VOLCENGINE_API_KEY: process.env.VOLCENGINE_API_KEY,
    FRAME_ASSET_PACK_MODEL: process.env.FRAME_ASSET_PACK_MODEL,
    FRAME_FALLBACK_MODELS: process.env.FRAME_FALLBACK_MODELS,
  }
  process.env.FRAME_PROVIDER = 'volcengine'
  process.env.FRAME_BASE_URL = 'https://apihub.agnes-ai.com/v1'
  delete process.env.FRAME_MODEL
  delete process.env.FRAME_IMAGE_SIZE
  process.env.FRAME_API_KEY = ''
  process.env.ARK_API_KEY = 'ark-test-key'
  process.env.VOLCENGINE_API_KEY = ''
  process.env.FRAME_ASSET_PACK_MODEL = 'agnes-image-2.1-flash'
  process.env.FRAME_FALLBACK_MODELS = 'agnes-image-2.0-flash, doubao-seedream-5-0-flash-260915'
  process.env.FRAME_WATERMARK_ENABLED = 'false'
  try {
    const config = getFrameConfig()
    assert.equal(config.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3')
    assert.equal(config.apiKey, 'ark-test-key')
    assert.equal(config.defaultModel, 'doubao-seedream-5-0-flash-260915')
    assert.equal(config.assetPackModel, 'doubao-seedream-5-0-flash-260915')
    assert.deepEqual(config.fallbackModels, ['doubao-seedream-5-0-flash-260915'])
    assert.deepEqual(
      buildVolcengineGenerationPayload({
        config,
        prompt: '中文角色资产板',
        modelName: config.defaultModel,
      }),
      {
        model: 'doubao-seedream-5-0-flash-260915',
        prompt: '中文角色资产板',
        size: '2048x1152',
        stream: false,
        response_format: 'url',
        watermark: false,
      },
    )
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('frame asset payload can explicitly disable image watermarks', () => {
  assert.equal(
    buildVolcengineGenerationPayload({
      config: { imageSize: '2K', watermarkEnabled: false },
      prompt: '中文道具资产',
      modelName: 'doubao-seedream-5-0-flash-260915',
    }).watermark,
    false,
  )
})

test('Volcengine converts unsupported 2K presets into valid dimensions', () => {
  assert.equal(resolveVolcengineImageSize({ imageSize: '2K', imageRatio: '16:9' }), '2048x1152')
  assert.equal(resolveVolcengineImageSize({ imageSize: '2K', imageRatio: '9:16' }), '1152x2048')
  assert.equal(resolveVolcengineImageSize({ imageSize: '2K', imageRatio: '1:1' }), '2048x2048')
  assert.equal(resolveVolcengineImageSize({ imageSize: '1024x1024', imageRatio: '16:9' }), '1024x1024')
})

test('Volcengine generation endpoint avoids duplicating the images path', () => {
  assert.equal(
    resolveFrameGenerationEndpoint({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    }),
    'https://ark.cn-beijing.volces.com/api/v3/images/generations',
  )
  assert.equal(
    resolveFrameGenerationEndpoint({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
    }),
    'https://ark.cn-beijing.volces.com/api/v3/images/generations',
  )
})

test('Agnes converts a local signed reference image into a valid image data URL', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(Buffer.from([137, 80, 78, 71]), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  })

  try {
    const refs = await resolveFrameReferenceImageUrls(
      ['http://127.0.0.1:3001/storage/projects/12/characters/18/v7/c1.png?expires=1&signature=test'],
      {
        provider: 'agnes',
        referenceUploadBaseUrl: 'https://toapis.com/v1',
        referenceUploadApiKey: 'test-key',
        referenceUploadTimeoutMs: 1000,
        referenceUploadRetryAttempts: 0,
        referenceUploadRetryBaseDelayMs: 1,
      },
    )
    assert.deepEqual(refs, ['data:image/png;base64,iVBORw=='])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('frame references are re-signed from the locked storage key after an old URL expires', async () => {
  const originalFetch = globalThis.fetch
  const requested = []
  globalThis.fetch = async (url) => {
    requested.push(String(url))
    if (String(url).includes('expires=1')) return new Response('expired', { status: 403 })
    return new Response(Buffer.from([137, 80, 78, 71]), {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    })
  }

  try {
    const refs = await resolveFrameReferenceImageUrls(
      ['https://storage.test/characters/11/approved-v4.png?expires=1'],
      { provider: 'agnes', referenceUploadTimeoutMs: 1000 },
      {
        referenceImageStorageKeys: ['characters/11/approved-v4.png'],
        createSignedUrl: (key) => `https://storage.test/${key}?expires=999`,
      },
    )
    assert.deepEqual(refs, ['data:image/png;base64,iVBORw=='])
    assert.deepEqual(requested, ['https://storage.test/characters/11/approved-v4.png?expires=999'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('frame references fail closed if a locked storage key cannot be signed', async () => {
  let fetched = false
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    fetched = true
    return new Response('stale URL must not be used', { status: 403 })
  }

  try {
    await assert.rejects(
      resolveFrameReferenceImageUrls(
        ['https://storage.test/old.png?expires=1'],
        { provider: 'agnes', referenceUploadTimeoutMs: 1000 },
        {
          referenceImageStorageKeys: ['characters/11/approved-v4.png'],
          createSignedUrl: () => { throw new Error('object unavailable') },
        },
      ),
      /无法刷新已锁定的人物参考图/u,
    )
    assert.equal(fetched, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Agnes converts a COS-style public signed reference image into a valid image data URL', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(Buffer.from([137, 80, 78, 71]), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  })

  try {
    const refs = await resolveFrameReferenceImageUrls(
      ['https://projectdream-media.cos.ap-guangzhou.myqcloud.com/projects/12/characters/18/v1/c17.png?q-signature=test'],
      {
        provider: 'agnes',
        referenceUploadTimeoutMs: 1000,
      },
    )
    assert.deepEqual(refs, ['data:image/png;base64,iVBORw=='])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Agnes retains an already materialized reference image instead of silently dropping it', async () => {
  const inlineReference = 'data:image/png;base64,iVBORw=='
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('an inline reference must not be fetched again')
  }

  try {
    assert.deepEqual(
      assertFrameReferenceImageSupport({
        config: { provider: 'agnes', defaultModel: 'agnes-image-2.1-flash' },
        modelName: 'agnes-image-2.1-flash',
        referenceImageUrls: [inlineReference],
      }),
      [inlineReference],
    )
    assert.deepEqual(
      await resolveFrameReferenceImageUrls([inlineReference], { provider: 'agnes' }),
      [inlineReference],
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Agnes provider uses its own API key when the generic frame key is empty', () => {
  const originalEnv = {
    FRAME_PROVIDER: process.env.FRAME_PROVIDER,
    FRAME_API_KEY: process.env.FRAME_API_KEY,
    AGNES_API_KEY: process.env.AGNES_API_KEY,
    TOAPI_API_KEY: process.env.TOAPI_API_KEY,
  }

  process.env.FRAME_PROVIDER = 'agnes'
  process.env.FRAME_API_KEY = ''
  process.env.AGNES_API_KEY = 'agnes-test-key'
  process.env.TOAPI_API_KEY = 'toapi-test-key'

  try {
    assert.equal(getFrameConfig().apiKey, 'agnes-test-key')
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('Agnes network failures preserve the upstream host and low-level cause', async () => {
  const originalFetch = globalThis.fetch
  const originalEnv = {
    FRAME_PROVIDER: process.env.FRAME_PROVIDER,
    FRAME_API_KEY: process.env.FRAME_API_KEY,
    AGNES_API_KEY: process.env.AGNES_API_KEY,
    FRAME_BASE_URL: process.env.FRAME_BASE_URL,
    FRAME_MODEL: process.env.FRAME_MODEL,
    FRAME_FALLBACK_MODELS: process.env.FRAME_FALLBACK_MODELS,
    FRAME_RETRY_ATTEMPTS: process.env.FRAME_RETRY_ATTEMPTS,
  }

  process.env.FRAME_PROVIDER = 'agnes'
  process.env.FRAME_API_KEY = 'test-key'
  process.env.AGNES_API_KEY = ''
  process.env.FRAME_BASE_URL = 'https://agnes.test/v1'
  process.env.FRAME_MODEL = 'agnes-image-test'
  process.env.FRAME_FALLBACK_MODELS = ' '
  process.env.FRAME_RETRY_ATTEMPTS = '0'
  globalThis.fetch = async () => {
    throw Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ENETUNREACH', message: 'network is unreachable' },
    })
  }

  try {
    await assert.rejects(
      () => generateFrameCandidates({
        storyboardId: 1,
        versionNo: 1,
        prompt: 'test frame',
        candidateCount: 1,
        publicBaseUrl: '',
        outputDir: '',
      }),
      (error) => {
        assert.match(error.message, /ENETUNREACH/)
        assert.match(error.message, /upstream agnes\.test/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
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
  assert.throws(
    () => assertFrameReferenceImageSupport({
      config: { provider: 'bigmodel', defaultModel: 'cogview-3-flash' },
      modelName: 'cogview-3-flash',
      referenceImageStorageKeys: ['characters/11/approved-v4.png'],
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
