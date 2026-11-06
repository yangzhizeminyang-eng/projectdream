import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildOfficialAgnesVideoPayload,
  isOfficialAgnesModel,
  resolveAgnesAspectRatio,
} from './video.mjs'

test('recognizes official Agnes v2.0 and 2.5 models', () => {
  assert.equal(isOfficialAgnesModel('agnes-video-2.5'), true)
  assert.equal(isOfficialAgnesModel('agnes-video-2.5-flash'), true)
  assert.equal(isOfficialAgnesModel('agnes-video-v2.0'), true)
  assert.equal(isOfficialAgnesModel('agnes-video-v2.0-flash'), true)
  assert.equal(isOfficialAgnesModel('agnes-video-2.0'), true)
  assert.equal(isOfficialAgnesModel('agnes-video-1.0'), false)
})

test('maps project ratios to the official Agnes aspect_ratio values', () => {
  assert.equal(resolveAgnesAspectRatio('9:16'), '9:16')
  assert.equal(resolveAgnesAspectRatio('vertical'), '9:16')
  assert.equal(resolveAgnesAspectRatio('16:9'), '16:9')
  assert.equal(resolveAgnesAspectRatio('', { width: 720, height: 1280 }), '9:16')
  assert.equal(resolveAgnesAspectRatio('', { width: 1280, height: 720 }), '16:9')
})

test('builds the official 2.5 reference payload with audio and image bindings', () => {
  const payload = buildOfficialAgnesVideoPayload({
    modelName: 'agnes-video-2.5',
    prompt: '以 <Picture 1> 中的角色为参考，以 <Audio 1> 的节奏和音色氛围为参考，角色说：别签字。',
    durationSeconds: 6,
    imageRatio: '9:16',
    referenceImages: ['https://cdn.example.com/character.png', 'https://cdn.example.com/scene.png'],
    referenceAudios: ['https://cdn.example.com/tang-ning.mp3'],
  })

  assert.deepEqual(payload, {
    model: 'agnes-video-2.5',
    prompt: '以 <Picture 1> 中的角色为参考，以 <Audio 1> 的节奏和音色氛围为参考，角色说：别签字。',
    seconds: '6',
    mode: 'reference',
    size: '720P',
    aspect_ratio: '9:16',
    images: ['https://cdn.example.com/character.png', 'https://cdn.example.com/scene.png'],
    audios: ['https://cdn.example.com/tang-ning.mp3'],
  })
})

test('rejects official Agnes references beyond provider limits instead of truncating them', () => {
  assert.throws(() => buildOfficialAgnesVideoPayload({
    modelName: 'agnes-video-2.5',
    prompt: 'reference',
    durationSeconds: 12,
    referenceImages: Array.from({ length: 8 }, (_, index) => `https://cdn.example.com/${index}.png`),
  }), /最多接收 5 张/u)
  assert.throws(() => buildOfficialAgnesVideoPayload({
    modelName: 'agnes-video-2.5',
    prompt: 'reference',
    durationSeconds: 12,
    referenceAudios: Array.from({ length: 5 }, (_, index) => `https://cdn.example.com/${index}.mp3`),
  }), /最多接收 3 张/u)
  assert.throws(() => buildOfficialAgnesVideoPayload({
    modelName: 'agnes-video-2.5', prompt: 'reference', durationSeconds: 99,
  }), /必须是 4-12 秒整数/u)
})

test('Agnes 2.5 Flash always uses free-tier 720P and preserves all allowed references', () => {
  const payload = buildOfficialAgnesVideoPayload({
    modelName: 'agnes-video-2.5-flash',
    prompt: 'Use the confirmed assets as references.',
    durationSeconds: 4,
    size: '2K',
    referenceImages: Array.from({ length: 5 }, (_, index) => `https://cdn.example.com/${index}.png`),
  })

  assert.equal(payload.size, '720P')
  assert.equal(payload.mode, 'reference')
  assert.equal(payload.images.length, 5)
})
