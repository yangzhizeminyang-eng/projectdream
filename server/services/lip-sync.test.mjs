import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDashScopeLipSyncPayload,
  buildDashScopeLipSyncDownloadOptions,
  buildLipSyncPrompt,
  buildSeedanceLipSyncPayload,
  buildLatentSyncPayload,
  createLatentSyncTask,
  resolveDashScopeLipSyncDuration,
  resolveLipSyncDuration,
  waitForLatentSyncTask,
} from './lip-sync.mjs'

test('DashScope lip-sync preparation carries storage keys for private media', () => {
  assert.deepEqual(
    buildDashScopeLipSyncDownloadOptions({
      imageUrl: 'http://localhost/generated/frame/image.png',
      imageStorageKey: 'projects/12/frames/image.png',
      sourceVideoUrl: 'http://localhost/generated/video/clip.mp4',
      sourceVideoStorageKey: 'projects/12/videos/clip.mp4',
      audioUrl: 'http://localhost/generated/audio/dialogue.wav',
      audioStorageKey: 'projects/12/audio/dialogue.wav',
    }),
    {
      image: {
        sourceUrl: 'http://localhost/generated/frame/image.png',
        storageKey: 'projects/12/frames/image.png',
      },
      sourceVideo: {
        sourceUrl: 'http://localhost/generated/video/clip.mp4',
        storageKey: 'projects/12/videos/clip.mp4',
      },
      audio: {
        sourceUrl: 'http://localhost/generated/audio/dialogue.wav',
        storageKey: 'projects/12/audio/dialogue.wav',
      },
    },
  )
})

test('lip-sync duration covers the audio and stays within Seedance limits', () => {
  assert.equal(resolveLipSyncDuration(1.04, 2), 4)
  assert.equal(resolveLipSyncDuration(5.52, 2), 6)
  assert.equal(resolveLipSyncDuration(30, 2), 15)
})

test('Seedance lip-sync payload binds one private image and one reference audio', () => {
  const payload = buildSeedanceLipSyncPayload({
    config: {
      model: 'seedance-2',
      resolution: '720p',
      aspectRatio: '16:9',
      generateAudio: true,
    },
    assetUrl: 'asset://pa_test',
    audioInput: 'data:audio/wav;base64,UklGRg==',
    prompt: 'keep identity and match lips',
    durationSeconds: 5.2,
    clientBusinessId: 'project12-shot193',
  })

  assert.equal(payload.duration, 6)
  assert.deepEqual(payload.image_with_roles, [
    { url: 'asset://pa_test', role: 'reference_image' },
  ])
  assert.deepEqual(payload.audio_with_roles, [
    { url: 'data:audio/wav;base64,UklGRg==', role: 'reference_audio' },
  ])
  assert.equal(payload.generate_audio, true)
  assert.equal(payload.return_last_frame, true)
})

test('LatentSync worker payload binds the rendered video and final dialogue audio', () => {
  assert.deepEqual(
    buildLatentSyncPayload({
      videoUrl: 'https://media.example.com/shot-49.mp4',
      audioUrl: 'https://media.example.com/dialogue-49.wav',
      prompt: '保持林默的眼镜、发型和服装不变，只修正说话口型。',
      durationSeconds: 6,
      inferenceSteps: 30,
      guidanceScale: 1.5,
      seed: 42,
    }),
    {
      video_url: 'https://media.example.com/shot-49.mp4',
      audio_url: 'https://media.example.com/dialogue-49.wav',
      prompt: '保持林默的眼镜、发型和服装不变，只修正说话口型。',
      duration_seconds: 6,
      inference_steps: 30,
      guidance_scale: 1.5,
      seed: 42,
    },
  )
})

test('LatentSync client creates and polls a worker task without requiring a cloud key', async () => {
  const originalFetch = global.fetch
  const calls = []
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (String(url).endsWith('/tasks')) {
      return new Response(JSON.stringify({ task_id: 'ls_task_1', status: 'queued' }), { status: 202 })
    }
    return new Response(JSON.stringify({
      task_id: 'ls_task_1',
      status: 'completed',
      progress: 100,
      video_url: 'https://worker.example.com/outputs/ls_task_1/result.mp4',
    }), { status: 200 })
  }
  const config = {
    provider: 'latentsync',
    baseUrl: 'http://worker.example.com',
    apiKey: '',
    model: 'LatentSync',
    inferenceSteps: 20,
    guidanceScale: 1.5,
    seed: null,
    pollIntervalMs: 1,
    pollTimeoutMs: 1000,
  }
  try {
    const created = await createLatentSyncTask({
      videoUrl: 'https://media.example.com/shot.mp4',
      audioUrl: 'https://media.example.com/dialogue.wav',
      prompt: '只修正嘴型',
      durationSeconds: 5,
      config,
    })
    const completed = await waitForLatentSyncTask(created.taskId, { config })
    assert.equal(created.taskId, 'ls_task_1')
    assert.equal(completed.videoUrl, 'https://worker.example.com/outputs/ls_task_1/result.mp4')
    assert.match(String(calls[0].options.body), /"audio_url":"https:\/\/media\.example\.com\/dialogue\.wav"/)
    assert.equal(calls[0].options.headers.Authorization, undefined)
  } finally {
    global.fetch = originalFetch
  }
})

test('lip-sync prompt makes the audio the mouth timing source', () => {
  const prompt = buildLipSyncPrompt({
    characterName: '林夏',
    dialogueText: '不可能',
    actionText: '短暂停顿后低声说话',
  })
  assert.match(prompt, /嘴唇开合严格跟随音频1/)
  assert.match(prompt, /停顿时闭嘴/)
  assert.match(prompt, /不新增人物/)
})

test('DashScope VideoReTalk payload uses temporary OSS inputs and extends short video', () => {
  const payload = buildDashScopeLipSyncPayload({
    config: { model: 'videoretalk' },
    videoUrl: 'oss://dashscope-instant/test/shot.mp4',
    audioUrl: 'oss://dashscope-instant/test/dialogue.wav',
  })

  assert.equal(payload.model, 'videoretalk')
  assert.equal(payload.input.video_url, 'oss://dashscope-instant/test/shot.mp4')
  assert.equal(payload.input.audio_url, 'oss://dashscope-instant/test/dialogue.wav')
  assert.equal(payload.parameters.video_extension, true)
  assert.equal(resolveDashScopeLipSyncDuration(5.52, 2), 6)
  assert.equal(resolveDashScopeLipSyncDuration(1.04, 2), 3)
})
