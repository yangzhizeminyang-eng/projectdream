import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractBigModelVideoUrl,
  buildMiniMaxVideoPayload,
  buildOfficialAgnesVideoPayload,
  extractMiniMaxVideoUrl,
  generateVideoCandidates,
  getVideoConfig,
  assertVideoProviderSnapshot,
  assertVideoModelProvider,
  isVideoTaskCreationRetryableError,
  isVideoTaskPollingRetryableError,
  resolveBigModelVideoSize,
  isMiniMaxVideoProvider,
  resolveGeneratedVideoDuration,
  resolveVideoCreateRateLimitWait,
  uploadVideoImageBytes,
  buildVideoContinuityConstraints,
  resolveVideoImageInput,
  rewriteVideoPromptForSafety,
  compactMiniMaxVideoPrompt,
} from './video.mjs'

test('MiniMax video prompts stay below the provider text limit', () => {
  const prompt = compactMiniMaxVideoPrompt('动作与表演：' + '重复资产模板 '.repeat(3000))
  assert.ok(Array.from(prompt).length <= 6800)
  assert.match(prompt, /已省略冗余资产生成模板/u)
})

test('Agnes Video 2.5 payload follows the official keyframe and multimodal request schema', () => {
  const keyframe = buildOfficialAgnesVideoPayload({
    modelName: 'agnes-video-2.5',
    prompt: '唐宁在办公室缓慢抬眼。',
    durationSeconds: 5,
    imageRatio: '9:16',
    imageUrl: 'https://cdn.example.com/shot.png',
  })
  assert.deepEqual(keyframe, {
    model: 'agnes-video-2.5',
    prompt: '唐宁在办公室缓慢抬眼。',
    seconds: '5',
    mode: 'keyframe',
    first_frame: 'https://cdn.example.com/shot.png',
    size: '720P',
    aspect_ratio: '9:16',
  })

  const references = buildOfficialAgnesVideoPayload({
    modelName: 'agnes-video-2.5',
    prompt: '保持角色与场景资产一致。',
    durationSeconds: 6,
    imageRatio: '16:9',
    referenceImages: ['https://cdn.example.com/character.png', 'https://cdn.example.com/scene.png'],
    referenceAudios: ['https://cdn.example.com/voice.wav'],
  })
  assert.deepEqual(references, {
    model: 'agnes-video-2.5',
    prompt: '保持角色与场景资产一致。',
    seconds: '6',
    mode: 'reference',
    images: ['https://cdn.example.com/character.png', 'https://cdn.example.com/scene.png'],
    audios: ['https://cdn.example.com/voice.wav'],
    size: '720P',
    aspect_ratio: '16:9',
  })
})

test('MiniMax H3 payload follows the official multimodal reference schema and preserves 5 seconds', () => {
  const payload = buildMiniMaxVideoPayload({
    modelName: 'MiniMax-H3',
    prompt: '唐宁在会议室停顿后抬眼，保持角色与场景资产一致。',
    durationSeconds: 5,
    imageRatio: '9:16',
    referenceImages: ['https://cdn.example.com/character.png', 'https://cdn.example.com/scene.png'],
  })
  assert.deepEqual(payload, {
    model: 'MiniMax-H3',
    content: [
      { type: 'text', text: '唐宁在会议室停顿后抬眼，保持角色与场景资产一致。' },
      { type: 'image_url', image_url: { url: 'https://cdn.example.com/character.png' }, role: 'reference_image' },
      { type: 'image_url', image_url: { url: 'https://cdn.example.com/scene.png' }, role: 'reference_image' },
    ],
    resolution: '2K',
    duration: 5,
    ratio: '9:16',
  })
})

test('MiniMax maps the configured 720P setting to its supported lower-cost 768P tier', () => {
  const payload = buildMiniMaxVideoPayload({ size: '720P', prompt: '短镜头。', durationSeconds: 5 })
  assert.equal(payload.resolution, '768P')
})

test('MiniMax and official Agnes reject durations outside their exact supported ranges', () => {
  assert.throws(() => buildMiniMaxVideoPayload({ prompt: '短镜头。', durationSeconds: 3 }), /必须是 4-15 秒整数/u)
  assert.throws(() => buildOfficialAgnesVideoPayload({ modelName: 'agnes-video-2.5', prompt: '短镜头。', durationSeconds: 13 }), /必须是 4-12 秒整数/u)
})

test('video provider payloads reject reference images beyond the model limit instead of dropping assets', () => {
  const references = Array.from({ length: 10 }, (_, index) => `https://cdn.example.com/ref-${index + 1}.png`)
  assert.throws(() => buildMiniMaxVideoPayload({ prompt: '镜头动作。', referenceImages: references }), /最多接收 9 张/u)
  assert.throws(() => buildOfficialAgnesVideoPayload({ modelName: 'agnes-video-2.5', prompt: '镜头动作。', referenceImages: references }), /最多接收 5 张/u)
})

test('Agnes multi-reference mode preserves every reference within its provider limit', async () => {
  const originalFetch = globalThis.fetch
  const originalEnv = {
    VIDEO_PROVIDER: process.env.VIDEO_PROVIDER,
    VIDEO_BASE_URL: process.env.VIDEO_BASE_URL,
    VIDEO_API_KEY: process.env.VIDEO_API_KEY,
    VIDEO_CREATE_RETRY_ATTEMPTS: process.env.VIDEO_CREATE_RETRY_ATTEMPTS,
    VIDEO_POLL_INTERVAL_MS: process.env.VIDEO_POLL_INTERVAL_MS,
    VIDEO_POLL_TIMEOUT_MS: process.env.VIDEO_POLL_TIMEOUT_MS,
  }
  process.env.VIDEO_PROVIDER = 'agnes'
  process.env.VIDEO_BASE_URL = 'https://apihub.agnes-ai.com/v1'
  process.env.VIDEO_API_KEY = 'agnes-key'
  process.env.VIDEO_CREATE_RETRY_ATTEMPTS = '0'
  process.env.VIDEO_POLL_INTERVAL_MS = '1'
  process.env.VIDEO_POLL_TIMEOUT_MS = '100'
  const sent = []
  globalThis.fetch = async (_url, options = {}) => {
    sent.push(JSON.parse(String(options.body || '{}')))
    if (sent.length === 1) return new Response(JSON.stringify({ video_id: 'multi-ref-exact' }), { status: 200 })
    return new Response(JSON.stringify({ status: 'completed', metadata: { url: 'https://cdn.example.com/exact.mp4' } }), { status: 200 })
  }
  try {
    await generateVideoCandidates({
      imageUrl: '', prompt: '角色在场景中停住。', motionMode: 'PAN', durationSeconds: 5,
      modelName: 'agnes-video-2.5', candidateCount: 1, generationMode: 'multi_reference',
      referenceImages: Array.from({ length: 5 }, (_, index) => `https://cdn.example.com/ref-${index + 1}.png`),
    })
    assert.deepEqual(sent[0].images, Array.from({ length: 5 }, (_, index) => `https://cdn.example.com/ref-${index + 1}.png`))
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('MiniMax H3 keyframe mode and result parsing use the official fields', () => {
  const payload = buildMiniMaxVideoPayload({
    modelName: 'MiniMax-H3', prompt: '静态机位，角色轻微转头。', durationSeconds: 5,
    imageUrl: 'https://cdn.example.com/first-frame.png',
  })
  assert.deepEqual(payload.content[1], {
    type: 'image_url', image_url: { url: 'https://cdn.example.com/first-frame.png' }, role: 'first_frame',
  })
  assert.equal(extractMiniMaxVideoUrl({ task: { content: { url: 'https://cdn.example.com/result.mp4' } } }), 'https://cdn.example.com/result.mp4')
  assert.equal(isMiniMaxVideoProvider({ provider: 'minimax' }), true)
})

test('MiniMax H3 candidate creates and polls a task through the official v2 endpoints', async () => {
  const originalFetch = globalThis.fetch
  const originalEnv = {
    VIDEO_PROVIDER: process.env.VIDEO_PROVIDER,
    VIDEO_BASE_URL: process.env.VIDEO_BASE_URL,
    VIDEO_API_KEY: process.env.VIDEO_API_KEY,
    MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
    VIDEO_CREATE_RETRY_ATTEMPTS: process.env.VIDEO_CREATE_RETRY_ATTEMPTS,
    VIDEO_POLL_INTERVAL_MS: process.env.VIDEO_POLL_INTERVAL_MS,
    VIDEO_POLL_TIMEOUT_MS: process.env.VIDEO_POLL_TIMEOUT_MS,
  }
  const calls = []
  process.env.VIDEO_PROVIDER = 'minimax'
  process.env.VIDEO_BASE_URL = 'https://api.minimax.cn'
  process.env.VIDEO_API_KEY = 'minimax-test-key'
  process.env.MINIMAX_API_KEY = ''
  process.env.VIDEO_CREATE_RETRY_ATTEMPTS = '0'
  process.env.VIDEO_POLL_INTERVAL_MS = '1'
  process.env.VIDEO_POLL_TIMEOUT_MS = '100'
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (calls.length === 1) {
      const body = JSON.parse(String(options.body || '{}'))
      assert.equal(body.model, 'MiniMax-H3')
      assert.equal(body.duration, 5)
      assert.equal(body.content[1].role, 'reference_image')
      assert.equal(new Headers(options.headers).get('authorization'), 'Bearer minimax-test-key')
      return new Response(JSON.stringify({ task_id: 'minimax-task-1' }), { status: 200 })
    }
    return new Response(JSON.stringify({ task: {
      id: 'minimax-task-1', status: 'succeeded', duration: 5,
      content: { url: 'https://cdn.example.com/minimax-result.mp4' },
    } }), { status: 200 })
  }
  try {
    const result = await generateVideoCandidates({
      prompt: '唐宁在会议室停顿后抬眼。', motionMode: 'HOLD', durationSeconds: 5,
      modelName: 'MiniMax-H3', candidateCount: 1, generationMode: 'multi_reference',
      referenceImages: ['https://cdn.example.com/confirmed-character.png'], imageRatio: '9:16',
    })
    assert.equal(result[0].videoUrl, 'https://cdn.example.com/minimax-result.mp4')
    assert.equal(result[0].durationSeconds, 5)
    assert.equal(calls[0].url, 'https://api.minimax.cn/v2/video_generation')
    assert.equal(calls[1].url, 'https://api.minimax.cn/v2/query/video_generation/minimax-task-1')
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('MiniMax polling retries a transient provider error before declaring failure', async () => {
  const originalFetch = globalThis.fetch
  const originalEnv = {
    VIDEO_PROVIDER: process.env.VIDEO_PROVIDER,
    VIDEO_BASE_URL: process.env.VIDEO_BASE_URL,
    VIDEO_API_KEY: process.env.VIDEO_API_KEY,
    VIDEO_CREATE_RETRY_ATTEMPTS: process.env.VIDEO_CREATE_RETRY_ATTEMPTS,
    VIDEO_POLL_INTERVAL_MS: process.env.VIDEO_POLL_INTERVAL_MS,
    VIDEO_POLL_TIMEOUT_MS: process.env.VIDEO_POLL_TIMEOUT_MS,
  }
  let pollCount = 0
  process.env.VIDEO_PROVIDER = 'minimax'
  process.env.VIDEO_BASE_URL = 'https://api.minimax.cn'
  process.env.VIDEO_API_KEY = 'minimax-test-key'
  process.env.VIDEO_CREATE_RETRY_ATTEMPTS = '0'
  process.env.VIDEO_POLL_INTERVAL_MS = '1'
  process.env.VIDEO_POLL_TIMEOUT_MS = '200'
  globalThis.fetch = async (url, options = {}) => {
    if (String(options.method || 'GET') === 'POST') {
      return new Response(JSON.stringify({ task_id: 'minimax-retry-task' }), { status: 200 })
    }
    pollCount += 1
    if (pollCount === 1) {
      return new Response(JSON.stringify({ message: 'temporary upstream failure' }), { status: 503 })
    }
    return new Response(JSON.stringify({
      task: { status: 'succeeded', duration: 5, content: { url: 'https://cdn.example.com/retry.mp4' } },
    }), { status: 200 })
  }
  try {
    const result = await generateVideoCandidates({
      prompt: '镜头保持稳定，角色抬眼。',
      motionMode: 'HOLD',
      durationSeconds: 5,
      modelName: 'MiniMax-H3',
      candidateCount: 1,
    })
    assert.equal(result[0].videoUrl, 'https://cdn.example.com/retry.mp4')
    assert.equal(pollCount, 2)
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('completed provider task URLs are reused without polling or creating a new paid task', async () => {
  const originalFetch = globalThis.fetch
  const originalEnv = {
    VIDEO_PROVIDER: process.env.VIDEO_PROVIDER,
    VIDEO_BASE_URL: process.env.VIDEO_BASE_URL,
    VIDEO_API_KEY: process.env.VIDEO_API_KEY,
    VIDEO_POLL_INTERVAL_MS: process.env.VIDEO_POLL_INTERVAL_MS,
    VIDEO_POLL_TIMEOUT_MS: process.env.VIDEO_POLL_TIMEOUT_MS,
  }
  process.env.VIDEO_PROVIDER = 'minimax'
  process.env.VIDEO_BASE_URL = 'https://api.minimax.cn'
  process.env.VIDEO_API_KEY = 'minimax-test-key'
  process.env.VIDEO_POLL_INTERVAL_MS = '1'
  process.env.VIDEO_POLL_TIMEOUT_MS = '100'
  globalThis.fetch = async () => {
    throw new Error('a completed provider task must not be queried again')
  }
  try {
    const result = await generateVideoCandidates({
      prompt: '复用已完成任务。',
      motionMode: 'HOLD',
      durationSeconds: 5,
      modelName: 'MiniMax-H3',
      candidateCount: 1,
      providerTasks: [{
        videoId: 'minimax-completed-task',
        candidatePrompt: '复用已完成任务。',
        videoUrl: 'https://cdn.example.com/already-complete.mp4',
        payload: { status: 'succeeded', duration: 5 },
      }],
    })
    assert.equal(result[0].videoUrl, 'https://cdn.example.com/already-complete.mp4')
    assert.equal(result[0].durationSeconds, 5)
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('MiniMax H3 uses its service URL and MiniMax-specific environment key fallback', () => {
  const originalEnv = {
    VIDEO_PROVIDER: process.env.VIDEO_PROVIDER,
    VIDEO_BASE_URL: process.env.VIDEO_BASE_URL,
    VIDEO_MODEL: process.env.VIDEO_MODEL,
    VIDEO_API_KEY: process.env.VIDEO_API_KEY,
    MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  }
  process.env.VIDEO_PROVIDER = 'minimax'
  delete process.env.VIDEO_BASE_URL
  delete process.env.VIDEO_MODEL
  process.env.VIDEO_API_KEY = ''
  process.env.MINIMAX_API_KEY = 'minimax-test-key'
  try {
    const config = getVideoConfig()
    assert.equal(config.baseUrl, 'https://api.minimax.cn')
    assert.equal(config.defaultModel, 'MiniMax-H3')
    assert.equal(config.apiKey, 'minimax-test-key')
    assert.equal(isMiniMaxVideoProvider(config), true)
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('video jobs reject a provider change instead of sending a paid model to another adapter', () => {
  assert.throws(
    () => assertVideoProviderSnapshot('minimax', { provider: 'agnes' }),
    /服务商配置已变化/,
  )
  assert.equal(assertVideoProviderSnapshot('minimax', { provider: 'minimax' }), 'minimax')
  assert.equal(assertVideoProviderSnapshot('', { provider: 'agnes' }), 'agnes')
})

test('provider validation rejects a MiniMax model when the configured adapter is Agnes', () => {
  assert.throws(
    () => assertVideoModelProvider('MiniMax-H3', { provider: 'agnes' }),
    /MiniMax 模型需要配置视频服务商为 minimax/i,
  )
  assert.equal(assertVideoModelProvider('MiniMax-H3', { provider: 'minimax' }), true)
  assert.equal(assertVideoModelProvider('agnes-video-2.5-flash', { provider: 'agnes' }), true)
})

test('Agnes defaults to the currently free 2.5 Flash model and 720P', () => {
  const previous = {
    provider: process.env.VIDEO_PROVIDER,
    model: process.env.VIDEO_MODEL,
    size: process.env.VIDEO_SIZE,
  }
  process.env.VIDEO_PROVIDER = 'agnes'
  delete process.env.VIDEO_MODEL
  delete process.env.VIDEO_SIZE

  try {
    const config = getVideoConfig()
    assert.equal(config.defaultModel, 'agnes-video-2.5-flash')
    assert.equal(config.size, '720P')
  } finally {
    if (previous.provider === undefined) delete process.env.VIDEO_PROVIDER
    else process.env.VIDEO_PROVIDER = previous.provider
    if (previous.model === undefined) delete process.env.VIDEO_MODEL
    else process.env.VIDEO_MODEL = previous.model
    if (previous.size === undefined) delete process.env.VIDEO_SIZE
    else process.env.VIDEO_SIZE = previous.size
  }
})

test('video continuity constraints lock the confirmed character image without replaying its asset-generation prompt', () => {
  const prompt = buildVideoContinuityConstraints({
    characterName: '林默',
    sceneAssetPrompt: '深夜公寓客厅，百叶窗冷蓝光，沙发和挂钟位置固定',
  })
  assert.match(prompt, /不得换装/)
  assert.match(prompt, /已确认角色参考图/)
  assert.doesNotMatch(prompt, /黑色丧服|松垮领带/)
  assert.match(prompt, /场景资产固定设定/)
  assert.doesNotMatch(prompt, /百叶窗冷蓝光/)
  assert.doesNotMatch(prompt, /沙发位置|挂钟位置/u)
  assert.match(prompt, /分镜明确要求移动的角色或道具/u)
  assert.match(prompt, /空间拓扑锁定/u)
  assert.match(prompt, /遮挡顺序/u)
  assert.match(prompt, /不得穿插人体\/道具/u)
  assert.match(prompt, /单一主运动/u)
})

test('opening shot continuity prompt anchors early identity and locked appearance details', () => {
  const prompt = buildVideoContinuityConstraints({
    characterName: '林默',
    characterAppearance: '黑色短发，左眉浅疤',
    characterCostume: '深绿色雨衣，不戴眼镜',
    isOpeningShot: true,
  })

  assert.match(prompt, /开场人物身份锚点/)
  assert.match(prompt, /黑色短发，左眉浅疤/)
  assert.match(prompt, /深绿色雨衣，不戴眼镜/)
  assert.match(prompt, /前段持续保持同一张脸/)
  assert.match(prompt, /重影/)
  assert.match(prompt, /服装结构锁定/u)
  assert.match(prompt, /衣领、前襟、闭合方式/u)
})

test('uploads object-storage image bytes without fetching the signed source URL', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    return new Response(JSON.stringify({ data: { url: 'https://files.toapis.com/object-storage.png' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const result = await uploadVideoImageBytes(
      Buffer.from([137, 80, 78, 71]),
      'image/png',
      'projects/4/characters/13/front.png',
      {
        imageUploadBaseUrl: 'https://toapis.com/v1',
        imageUploadApiKey: 'test-key',
        imageUploadTimeoutMs: 1000,
        imageUploadRetryAttempts: 0,
        imageUploadRetryBaseDelayMs: 1,
      },
    )
    assert.equal(result, 'https://files.toapis.com/object-storage.png')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://toapis.com/v1/uploads/images')
    assert.equal(calls[0].options.body.get('purpose'), 'generation')
    assert.equal(calls[0].options.body.get('file').name, 'front.png')
  } finally {
    globalThis.fetch = originalFetch
  }
})

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

test('Agnes creation limits are recognized from status or response text', () => {
  assert.equal(isVideoTaskCreationRetryableError({ status: 429, message: 'busy' }), true)
  assert.equal(
    isVideoTaskCreationRetryableError({
      status: 400,
      message: 'video generation rate limit exceeded: allows 2 requests per 1 minute(s)',
    }),
    true,
  )
  assert.equal(isVideoTaskCreationRetryableError({ status: 400, message: 'invalid image' }), false)
  assert.equal(isVideoTaskPollingRetryableError({ message: 'status query failed: fetch failed' }), true)
})

test('Agnes video provider uses its own API key when the generic key is empty', () => {
  const originalEnv = {
    VIDEO_PROVIDER: process.env.VIDEO_PROVIDER,
    VIDEO_API_KEY: process.env.VIDEO_API_KEY,
    AGNES_API_KEY: process.env.AGNES_API_KEY,
    BIGMODEL_API_KEY: process.env.BIGMODEL_API_KEY,
    ZHIPU_API_KEY: process.env.ZHIPU_API_KEY,
  }

  process.env.VIDEO_PROVIDER = 'agnes'
  process.env.VIDEO_API_KEY = ''
  process.env.AGNES_API_KEY = 'agnes-test-key'
  process.env.BIGMODEL_API_KEY = 'bigmodel-test-key'
  process.env.ZHIPU_API_KEY = ''

  try {
    assert.equal(getVideoConfig().apiKey, 'agnes-test-key')
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('Agnes creation limiter reserves at most two requests per minute', () => {
  assert.equal(resolveVideoCreateRateLimitWait([0, 1000], 1000, 2, 60000), 59000)
  assert.equal(resolveVideoCreateRateLimitWait([0, 1000], 60001, 2, 60000), 0)
})

test('video prompt safety rewrite softens audit-sensitive wording', () => {
  const prompt = rewriteVideoPromptForSafety(
    '头顶灯管闪两下后熄灭，档案室陷入断电黑暗。设备停摆，她感到恐惧。',
  )
  assert.doesNotMatch(prompt, /熄灭|断电黑暗|停摆|恐惧/)
  assert.match(prompt, /变暗|低照度|声音逐渐减弱|紧张/)
  assert.match(prompt, /无血腥|无伤害画面|非暴力/)
})

test('video prompt safety rewrite preserves explicit prop and character actions', () => {
  const prompt = rewriteVideoPromptForSafety(
    '0-3秒：传送窗口亮起。3-6秒：窗口将红色发卡滑出台面。6-8秒：林知夏抬头看向走廊。',
  )
  assert.match(prompt, /窗口将红色发卡滑出台面/u)
  assert.match(prompt, /林知夏抬头看向走廊/u)
  assert.doesNotMatch(prompt, /只表现人物轻微表情/u)
  assert.match(prompt, /不得弱化原提示词中的可见动作/u)
})

test('public image URL is passed through without uploading', async () => {
  assert.equal(
    await resolveVideoImageInput('https://cdn.example.com/confirmed.png'),
    'https://cdn.example.com/confirmed.png',
  )
})

test('text-to-video mode does not validate a missing static frame URL', async () => {
  const originalFetch = globalThis.fetch
  const originalEnv = {
    VIDEO_PROVIDER: process.env.VIDEO_PROVIDER,
    VIDEO_BASE_URL: process.env.VIDEO_BASE_URL,
    VIDEO_API_KEY: process.env.VIDEO_API_KEY,
    AGNES_API_KEY: process.env.AGNES_API_KEY,
    VIDEO_CREATE_RETRY_ATTEMPTS: process.env.VIDEO_CREATE_RETRY_ATTEMPTS,
    VIDEO_POLL_INTERVAL_MS: process.env.VIDEO_POLL_INTERVAL_MS,
    VIDEO_POLL_TIMEOUT_MS: process.env.VIDEO_POLL_TIMEOUT_MS,
  }
  const calls = []
  process.env.VIDEO_PROVIDER = 'agnes'
  process.env.VIDEO_BASE_URL = 'https://apihub.agnes-ai.com/v1'
  process.env.VIDEO_API_KEY = 'agnes-key'
  process.env.AGNES_API_KEY = ''
  process.env.VIDEO_CREATE_RETRY_ATTEMPTS = '0'
  process.env.VIDEO_POLL_INTERVAL_MS = '1'
  process.env.VIDEO_POLL_TIMEOUT_MS = '100'

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (calls.length === 1) {
      const body = JSON.parse(String(options.body || '{}'))
      assert.equal(body.mode, 'text')
      assert.equal('first_frame' in body, false)
      return new Response(JSON.stringify({ video_id: 'text-video-1', status: 'pending' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(
      JSON.stringify({ status: 'completed', metadata: { url: 'https://cdn.example.com/text-video.mp4' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  try {
    const result = await generateVideoCandidates({
      imageUrl: '',
      prompt: '中景，平视，角色从时间裂缝入口走出，绑定角色音色并保留对白节奏。',
      motionMode: 'PAN',
      durationSeconds: 5,
      modelName: 'agnes-video-2.5',
      candidateCount: 1,
    })
    assert.equal(result[0].videoUrl, 'https://cdn.example.com/text-video.mp4')
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('direct storyboard video mode ignores a static frame input', async () => {
  const originalFetch = globalThis.fetch
  const originalEnv = {
    VIDEO_PROVIDER: process.env.VIDEO_PROVIDER,
    VIDEO_BASE_URL: process.env.VIDEO_BASE_URL,
    VIDEO_API_KEY: process.env.VIDEO_API_KEY,
    VIDEO_CREATE_RETRY_ATTEMPTS: process.env.VIDEO_CREATE_RETRY_ATTEMPTS,
    VIDEO_POLL_INTERVAL_MS: process.env.VIDEO_POLL_INTERVAL_MS,
    VIDEO_POLL_TIMEOUT_MS: process.env.VIDEO_POLL_TIMEOUT_MS,
  }
  const calls = []
  process.env.VIDEO_PROVIDER = 'agnes'
  process.env.VIDEO_BASE_URL = 'https://apihub.agnes-ai.com/v1'
  process.env.VIDEO_API_KEY = 'agnes-key'
  process.env.VIDEO_CREATE_RETRY_ATTEMPTS = '0'
  process.env.VIDEO_POLL_INTERVAL_MS = '1'
  process.env.VIDEO_POLL_TIMEOUT_MS = '100'

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (calls.length === 1) {
      const body = JSON.parse(String(options.body || '{}'))
      assert.equal(body.mode, 'text')
      assert.equal('first_frame' in body, false)
      return new Response(JSON.stringify({ video_id: 'direct-video-1', status: 'pending' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(
      JSON.stringify({ status: 'completed', metadata: { url: 'https://cdn.example.com/direct-video.mp4' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  try {
    const result = await generateVideoCandidates({
      imageUrl: 'https://cdn.example.com/legacy-static-frame.png',
      prompt: '唐宁在合规办公室克制地抬眼，镜头缓慢推进。',
      motionMode: 'PUSH_IN',
      durationSeconds: 5,
      modelName: 'agnes-video-2.5',
      candidateCount: 1,
      generationMode: 'text_to_video',
    })
    assert.equal(result[0].videoUrl, 'https://cdn.example.com/direct-video.mp4')
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('Agnes multi-reference mode sends reference images without a shot still', async () => {
  const originalFetch = globalThis.fetch
  const originalEnv = {
    VIDEO_PROVIDER: process.env.VIDEO_PROVIDER,
    VIDEO_BASE_URL: process.env.VIDEO_BASE_URL,
    VIDEO_API_KEY: process.env.VIDEO_API_KEY,
    VIDEO_CREATE_RETRY_ATTEMPTS: process.env.VIDEO_CREATE_RETRY_ATTEMPTS,
    VIDEO_POLL_INTERVAL_MS: process.env.VIDEO_POLL_INTERVAL_MS,
    VIDEO_POLL_TIMEOUT_MS: process.env.VIDEO_POLL_TIMEOUT_MS,
  }
  process.env.VIDEO_PROVIDER = 'agnes'
  process.env.VIDEO_BASE_URL = 'https://apihub.agnes-ai.com/v1'
  process.env.VIDEO_API_KEY = 'agnes-key'
  process.env.VIDEO_CREATE_RETRY_ATTEMPTS = '0'
  process.env.VIDEO_POLL_INTERVAL_MS = '1'
  process.env.VIDEO_POLL_TIMEOUT_MS = '100'
  let calls = 0
  globalThis.fetch = async (_url, options = {}) => {
    calls += 1
    if (calls === 1) {
      const body = JSON.parse(String(options.body || '{}'))
      assert.equal(body.mode, 'reference')
      assert.deepEqual(body.images, ['https://cdn.example.com/character.png', 'https://cdn.example.com/scene.png'])
      return new Response(JSON.stringify({ video_id: 'multi-ref-video-1' }), { status: 200 })
    }
    return new Response(JSON.stringify({ status: 'completed', metadata: { url: 'https://cdn.example.com/multi-ref.mp4' } }), { status: 200 })
  }
  try {
    const result = await generateVideoCandidates({
      imageUrl: 'https://cdn.example.com/legacy-shot.png',
      prompt: '唐宁在公司合规办公室抬眼。',
      motionMode: 'PUSH_IN',
      durationSeconds: 5,
      modelName: 'agnes-video-2.5',
      candidateCount: 1,
      generationMode: 'multi_reference',
      referenceImages: ['https://cdn.example.com/character.png', 'https://cdn.example.com/scene.png'],
    })
    assert.equal(result[0].videoUrl, 'https://cdn.example.com/multi-ref.mp4')
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('refreshes signed reference images immediately before provider creation', async () => {
  const originalFetch = globalThis.fetch
  const originalEnv = {
    VIDEO_PROVIDER: process.env.VIDEO_PROVIDER,
    VIDEO_BASE_URL: process.env.VIDEO_BASE_URL,
    VIDEO_API_KEY: process.env.VIDEO_API_KEY,
    VIDEO_CREATE_RETRY_ATTEMPTS: process.env.VIDEO_CREATE_RETRY_ATTEMPTS,
    VIDEO_POLL_INTERVAL_MS: process.env.VIDEO_POLL_INTERVAL_MS,
    VIDEO_POLL_TIMEOUT_MS: process.env.VIDEO_POLL_TIMEOUT_MS,
  }
  process.env.VIDEO_PROVIDER = 'agnes'
  process.env.VIDEO_BASE_URL = 'https://apihub.agnes-ai.com/v1'
  process.env.VIDEO_API_KEY = 'agnes-key'
  process.env.VIDEO_CREATE_RETRY_ATTEMPTS = '0'
  process.env.VIDEO_POLL_INTERVAL_MS = '1'
  process.env.VIDEO_POLL_TIMEOUT_MS = '100'
  let calls = 0
  let refreshes = 0
  globalThis.fetch = async (_url, options = {}) => {
    calls += 1
    if (calls === 1) {
      const body = JSON.parse(String(options.body || '{}'))
      assert.deepEqual(body.images, ['https://cdn.example.com/fresh-character.png', 'https://cdn.example.com/fresh-scene.png'])
      return new Response(JSON.stringify({ video_id: 'fresh-reference-video-1' }), { status: 200 })
    }
    return new Response(JSON.stringify({ status: 'completed', metadata: { url: 'https://cdn.example.com/fresh-reference.mp4' } }), { status: 200 })
  }
  try {
    const result = await generateVideoCandidates({
      imageUrl: '',
      prompt: '角色在办公室内保持连续动作。',
      motionMode: 'PAN',
      durationSeconds: 5,
      modelName: 'agnes-video-2.5',
      candidateCount: 1,
      generationMode: 'multi_reference',
      referenceImages: ['https://cdn.example.com/stale-character.png', 'https://cdn.example.com/stale-scene.png'],
      resolveReferenceImages: async () => {
        refreshes += 1
        return ['https://cdn.example.com/fresh-character.png', 'https://cdn.example.com/fresh-scene.png']
      },
    })
    assert.equal(refreshes, 1)
    assert.equal(result[0].videoUrl, 'https://cdn.example.com/fresh-reference.mp4')
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('Agnes multi-reference mode deduplicates and preserves references at the provider limit', async () => {
  const originalFetch = globalThis.fetch
  const originalEnv = {
    VIDEO_PROVIDER: process.env.VIDEO_PROVIDER,
    VIDEO_BASE_URL: process.env.VIDEO_BASE_URL,
    VIDEO_API_KEY: process.env.VIDEO_API_KEY,
    VIDEO_CREATE_RETRY_ATTEMPTS: process.env.VIDEO_CREATE_RETRY_ATTEMPTS,
    VIDEO_POLL_INTERVAL_MS: process.env.VIDEO_POLL_INTERVAL_MS,
    VIDEO_POLL_TIMEOUT_MS: process.env.VIDEO_POLL_TIMEOUT_MS,
  }
  process.env.VIDEO_PROVIDER = 'agnes'
  process.env.VIDEO_BASE_URL = 'https://apihub.agnes-ai.com/v1'
  process.env.VIDEO_API_KEY = 'agnes-key'
  process.env.VIDEO_CREATE_RETRY_ATTEMPTS = '0'
  process.env.VIDEO_POLL_INTERVAL_MS = '1'
  process.env.VIDEO_POLL_TIMEOUT_MS = '100'
  let calls = 0
  globalThis.fetch = async (_url, options = {}) => {
    calls += 1
    if (calls === 1) {
      const body = JSON.parse(String(options.body || '{}'))
      assert.equal(body.mode, 'reference')
      assert.deepEqual(body.images, [
        'https://cdn.example.com/ref-1.png',
        'https://cdn.example.com/ref-2.png',
        'https://cdn.example.com/ref-3.png',
        'https://cdn.example.com/ref-4.png',
        'https://cdn.example.com/ref-5.png',
      ])
      return new Response(JSON.stringify({ video_id: 'multi-ref-video-cap-1' }), { status: 200 })
    }
    return new Response(JSON.stringify({ status: 'completed', metadata: { url: 'https://cdn.example.com/capped.mp4' } }), { status: 200 })
  }
  try {
    const result = await generateVideoCandidates({
      imageUrl: '',
      prompt: '角色在公寓中保持警觉。',
      motionMode: 'PAN',
      durationSeconds: 5,
      modelName: 'agnes-video-2.5',
      candidateCount: 1,
      generationMode: 'multi_reference',
      referenceImages: [
        'https://cdn.example.com/ref-1.png',
        'https://cdn.example.com/ref-2.png',
        'https://cdn.example.com/ref-1.png',
        'https://cdn.example.com/ref-3.png',
        'https://cdn.example.com/ref-4.png',
        'https://cdn.example.com/ref-5.png',
      ],
    })
    assert.equal(result[0].videoUrl, 'https://cdn.example.com/capped.mp4')
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
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
      assert.equal(body.first_frame, 'https://files.toapis.com/agnes.png')
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
    let storedProviderTasks = []
    const result = await generateVideoCandidates({
      imageUrl: 'http://127.0.0.1:3001/generated/frame/agnes-local.png',
      prompt: '温叙缓慢走出阴影。',
      motionMode: 'PAN',
      durationSeconds: 5,
      modelName: 'agnes-video-2.5',
      candidateCount: 1,
      onTasksCreated: async (tasks) => {
        storedProviderTasks = tasks.map((task) => ({
          videoId: task.videoId,
          candidatePrompt: task.candidatePrompt,
        }))
      },
    })
    assert.equal(result[0].videoUrl, 'https://cdn.example.com/video.mp4')
    assert.equal(calls[1].url, 'https://toapis.com/v1/uploads/images')
    assert.equal(storedProviderTasks[0].videoId, 'video-1')

    const callCountBeforeResume = calls.length
    const resumed = await generateVideoCandidates({
      imageUrl: 'http://127.0.0.1:3001/generated/frame/agnes-local.png',
      prompt: '温叙缓慢走出阴影。',
      motionMode: 'PAN',
      durationSeconds: 5,
      modelName: 'agnes-video-2.5',
      candidateCount: 1,
      providerTasks: storedProviderTasks,
    })
    assert.equal(resumed[0].videoUrl, 'https://cdn.example.com/video.mp4')
    assert.equal(calls.length, callCountBeforeResume + 1)
    assert.equal(calls.at(-1).options.method, 'GET')
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
