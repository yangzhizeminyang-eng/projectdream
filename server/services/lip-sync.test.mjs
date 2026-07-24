import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDashScopeLipSyncPayload,
  buildLipSyncPrompt,
  buildSeedanceLipSyncPayload,
  resolveDashScopeLipSyncDuration,
  resolveLipSyncDuration,
} from './lip-sync.mjs'

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
