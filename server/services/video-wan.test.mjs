import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  assertVideoModelProvider,
  buildWanVideoPayload,
  generateVideoCandidates,
  getVideoConfig,
  isWanVideoModel,
  resolveWanApiRoot,
  resolveWanMediaInput,
} from './video.mjs'

test('Wan payload uses the official first_frame/last_frame media contract', () => {
  const payload = buildWanVideoPayload({
    modelName: 'wan3.0-video',
    prompt: '唐宁在合规办公室缓慢抬眼。',
    durationSeconds: 5,
    imageRatio: '9:16',
    size: '720P',
    firstFrameUrl: 'data:image/png;base64,AAAA',
    lastFrameUrl: 'data:image/png;base64,BBBB',
    withAudio: true,
  })
  assert.deepEqual(payload, {
    model: 'wan3.0-video',
    input: {
      prompt: '唐宁在合规办公室缓慢抬眼。',
      media: [
        { type: 'first_frame', url: 'data:image/png;base64,AAAA' },
        { type: 'last_frame', url: 'data:image/png;base64,BBBB' },
      ],
    },
    parameters: {
      resolution: '720P',
      ratio: '9:16',
      duration: 5,
      audio: true,
      seed: -1,
      prompt_extend: false,
      watermark: false,
    },
  })
})

test('Wan falls back to reference_image only when no first frame is supplied', () => {
  const payload = buildWanVideoPayload({
    prompt: '保持角色与场景一致。',
    durationSeconds: 6,
    imageRatio: '16:9',
    referenceImages: ['https://cdn.example.com/character.png', 'https://cdn.example.com/scene.png'],
  })
  assert.deepEqual(payload.input.media, [
    { type: 'reference_image', url: 'https://cdn.example.com/character.png' },
    { type: 'reference_image', url: 'https://cdn.example.com/scene.png' },
  ])
})

test('Wan accepts 2-30 second integer shots only', () => {
  assert.throws(() => buildWanVideoPayload({ prompt: '镜头。', durationSeconds: 1 }), /必须是 2-30 秒整数/u)
  assert.throws(() => buildWanVideoPayload({ prompt: '镜头。', durationSeconds: 31 }), /必须是 2-30 秒整数/u)
  assert.equal(buildWanVideoPayload({ prompt: '镜头。', durationSeconds: 30 }).parameters.duration, 30)
})

test('Wan model IDs require the wan provider', () => {
  assert.equal(isWanVideoModel('wan3.0-video'), true)
  assert.equal(isWanVideoModel('wan3.0-video-prime'), true)
  assert.equal(isWanVideoModel('wan2.7-image'), false)
  assert.equal(assertVideoModelProvider('wan3.0-video', { provider: 'wan' }), true)
  assert.throws(
    () => assertVideoModelProvider('wan3.0-video', { provider: 'agnes' }),
    /Wan 模型需要配置视频服务商为 wan/u,
  )
})

test('Wan API root strips the OpenAI-compatible suffix and the native api/v1 suffix', () => {
  assert.equal(
    resolveWanApiRoot({ baseUrl: 'https://ws-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' }),
    'https://ws-test.cn-beijing.maas.aliyuncs.com',
  )
  assert.equal(
    resolveWanApiRoot({ baseUrl: 'https://ws-test.cn-beijing.maas.aliyuncs.com/api/v1/' }),
    'https://ws-test.cn-beijing.maas.aliyuncs.com',
  )
})

test('Wan media is sent as a private Base64 data URL instead of a localhost URL', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8000/storage/frame.jpg?signature=test')
    assert.equal(options.method, undefined)
    return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })
  }
  try {
    const input = await resolveWanMediaInput(
      'http://127.0.0.1:8000/storage/frame.jpg?signature=test',
      { requestTimeoutMs: 5000 },
    )
    assert.match(input, /^data:image\/jpeg;base64,/u)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Wan converts a TIFF continuity frame to a PNG data URL before submission', async (t) => {
  const ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg'
  try {
    await promisify(execFile)(ffmpegBin, ['-version'])
  } catch {
    t.skip('ffmpeg is required for TIFF conversion coverage')
    return
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wan-tiff-test-'))
  const tiffPath = path.join(directory, 'frame.tiff')
  try {
    await promisify(execFile)(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'color=c=red:s=16x16:r=1', '-frames:v', '1',
      '-pix_fmt', 'yuv420p', '-compression_algo', 'deflate', tiffPath,
    ])
    const tiffBytes = await readFile(tiffPath)
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(tiffBytes, {
      status: 200,
      headers: { 'content-type': 'image/tiff' },
    })
    try {
      const input = await resolveWanMediaInput('https://cdn.example.com/frame.tiff', {
        requestTimeoutMs: 5000,
      })
      assert.match(input, /^data:image\/png;base64,/u)
      const pngBytes = Buffer.from(input.split(',')[1], 'base64')
      assert.deepEqual([...pngBytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
    } finally {
      globalThis.fetch = originalFetch
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Wan creates the native async task and polls output.task_status to SUCCEEDED', async () => {
  const originalFetch = globalThis.fetch
  const originalEnv = {
    VIDEO_PROVIDER: process.env.VIDEO_PROVIDER,
    VIDEO_BASE_URL: process.env.VIDEO_BASE_URL,
    VIDEO_API_KEY: process.env.VIDEO_API_KEY,
    VIDEO_MODEL: process.env.VIDEO_MODEL,
    VIDEO_SIZE: process.env.VIDEO_SIZE,
    VIDEO_WITH_AUDIO: process.env.VIDEO_WITH_AUDIO,
    VIDEO_CREATE_RETRY_ATTEMPTS: process.env.VIDEO_CREATE_RETRY_ATTEMPTS,
    VIDEO_CREATE_RATE_LIMIT_MAX_REQUESTS: process.env.VIDEO_CREATE_RATE_LIMIT_MAX_REQUESTS,
    VIDEO_POLL_INTERVAL_MS: process.env.VIDEO_POLL_INTERVAL_MS,
    VIDEO_POLL_TIMEOUT_MS: process.env.VIDEO_POLL_TIMEOUT_MS,
  }
  process.env.VIDEO_PROVIDER = 'wan'
  process.env.VIDEO_BASE_URL = 'https://ws-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
  process.env.VIDEO_API_KEY = 'wan-test-key'
  process.env.VIDEO_MODEL = 'wan3.0-video'
  process.env.VIDEO_SIZE = '720P'
  process.env.VIDEO_WITH_AUDIO = 'true'
  process.env.VIDEO_CREATE_RETRY_ATTEMPTS = '0'
  process.env.VIDEO_CREATE_RATE_LIMIT_MAX_REQUESTS = '100'
  process.env.VIDEO_POLL_INTERVAL_MS = '1'
  process.env.VIDEO_POLL_TIMEOUT_MS = '5000'

  const calls = []
  let polls = 0
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (String(url) === 'https://cdn.example.com/frame.jpg') {
      return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    if (String(url).endsWith('/api/v1/services/aigc/video-generation/video-synthesis')) {
      assert.equal(options.method, 'POST')
      assert.equal(options.headers['X-DashScope-Async'], 'enable')
      const body = JSON.parse(options.body)
      assert.equal(body.model, 'wan3.0-video')
      assert.equal(body.parameters.duration, 5)
      assert.equal(body.parameters.resolution, '720P')
      assert.match(body.input.media[0].url, /^data:image\/jpeg;base64,/u)
      return new Response(JSON.stringify({
        output: { task_id: 'wan-task-1', task_status: 'PENDING' },
        request_id: 'request-1',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (String(url).endsWith('/api/v1/tasks/wan-task-1')) {
      polls += 1
      return new Response(JSON.stringify(polls === 1 ? {
        output: { task_id: 'wan-task-1', task_status: 'RUNNING' },
      } : {
        output: {
          task_id: 'wan-task-1',
          task_status: 'SUCCEEDED',
          video_url: 'https://cdn.example.com/result.mp4',
        },
        usage: { output_video_duration: 5, fps: 30, SR: 720, ratio: '9:16' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`unexpected fetch ${url}`)
  }

  try {
    const results = await generateVideoCandidates({
      firstFrameUrl: 'https://cdn.example.com/frame.jpg',
      prompt: '唐宁缓慢抬眼，保持角色与场景一致。',
      motionMode: 'PAN',
      durationSeconds: 5,
      modelName: 'wan3.0-video',
      candidateCount: 1,
      imageRatio: '9:16',
    })
    assert.equal(results.length, 1)
    assert.equal(results[0].videoUrl, 'https://cdn.example.com/result.mp4')
    assert.equal(results[0].durationSeconds, 5)
    assert.equal(results[0].providerTaskId, 'wan-task-1')
    assert.equal(results[0].modelName, 'wan3.0-video')
    assert.equal(polls, 2)
    assert.equal(calls.filter((call) => call.url.includes('/video-synthesis')).length, 1)
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  }
})
