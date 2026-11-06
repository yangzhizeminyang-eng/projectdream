import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getConfirmedCharacterBaseImage,
  getConfirmedCharacterFaceCloseupImage,
  resolveCharacterReferenceImageUrls,
  validateAssetImageConfirmation,
  validateCharacterAssetPackConfirmation,
  validateCharacterTurnaroundConfirmation,
  validateCharacterFaceCloseupConfirmation,
  validateCharacterViewGeneration,
} from './asset-character-workflow.mjs'

const image = (id, viewSetType, status, imageUrl = `https://cdn.test/${id}.png`) => ({
  id,
  viewSetType,
  status,
  imageUrl,
})

test('character turnaround requires a confirmed single base image and adopted face closeup', () => {
  const result = validateCharacterViewGeneration({
    nodeType: 'character',
    viewType: 'character-turnaround',
    images: [image(1, 'single', 'candidate')],
  })

  assert.equal(result.ready, false)
  assert.equal(result.code, 'character-base-image-required')
  assert.match(result.message, /基础正面全身图/)

  const withBase = validateCharacterViewGeneration({
    nodeType: 'character',
    viewType: 'character-turnaround',
    images: [image(1, 'single', 'confirmed'), { ...image(2, 'character-face-closeup', 'candidate'), viewKey: 'face', visionStatus: 'passed' }],
  })
  assert.equal(withBase.ready, false)
  assert.equal(withBase.code, 'character-face-closeup-required')
})

test('character turnaround accepts only a confirmed passed face closeup', () => {
  const result = validateCharacterViewGeneration({
    nodeType: 'character',
    viewType: 'character-turnaround',
    images: [
      { ...image(1, 'single', 'confirmed'), visionStatus: 'passed' },
      { ...image(2, 'character-face-closeup', 'confirmed'), viewKey: 'face', visionStatus: 'passed' },
    ],
  })
  assert.equal(result.ready, true)
  assert.equal(getConfirmedCharacterFaceCloseupImage(result.baseImage ? [
    { ...image(2, 'character-face-closeup', 'confirmed'), viewKey: 'face', visionStatus: 'passed' },
  ] : [])?.id, 2)
})

test('face closeup requires a confirmed single base image', () => {
  const result = validateCharacterViewGeneration({
    nodeType: 'character',
    viewType: 'character-face-closeup',
    images: [image(1, 'single', 'candidate')],
  })
  assert.equal(result.ready, false)
  assert.equal(result.code, 'character-base-image-required')
})

test('derived character views do not use a confirmed base that is still pending vision review', () => {
  const result = validateCharacterViewGeneration({
    nodeType: 'character',
    viewType: 'character-face-closeup',
    images: [{ ...image(1, 'single', 'confirmed'), visionStatus: 'pending' }],
  })
  assert.equal(result.ready, false)
  assert.equal(result.code, 'character-base-image-required')
})

test('face closeup confirmation requires an independently passed face candidate', () => {
  assert.deepEqual(
    validateCharacterFaceCloseupConfirmation({
      viewType: 'character-face-closeup',
      viewKey: 'face',
      imageStatus: 'candidate',
      visionStatus: 'passed',
      imageUrl: 'https://cdn.test/face.png',
      modelName: 'real-image-provider',
    }),
    { ready: true, code: null, message: '' },
  )
})

test('character turnaround uses the newest confirmed single base image', () => {
  const baseImage = getConfirmedCharacterBaseImage([
    image(1, 'single', 'confirmed'),
    image(2, 'single', 'candidate'),
    image(3, 'single', 'confirmed'),
    image(4, 'character-turnaround', 'confirmed'),
  ])

  assert.equal(baseImage?.id, 3)

  const result = validateCharacterViewGeneration({
    nodeType: 'character',
    viewType: 'character-turnaround',
    images: [
      image(1, 'single', 'confirmed'),
      image(3, 'single', 'confirmed'),
      { ...image(5, 'character-face-closeup', 'confirmed'), viewKey: 'face', visionStatus: 'passed' },
    ],
  })

  assert.deepEqual(result, {
    ready: true,
    code: null,
    message: '',
    baseImage: {
      id: 3,
      viewSetType: 'single',
      status: 'confirmed',
      imageUrl: 'https://cdn.test/3.png',
    },
  })
})

test('non-character and single image generation do not require a character base image', () => {
  assert.equal(
    validateCharacterViewGeneration({
      nodeType: 'scene',
      viewType: 'scene-nine-grid',
      images: [],
    }).ready,
    true,
  )
  assert.equal(
    validateCharacterViewGeneration({
      nodeType: 'character',
      viewType: 'single',
      images: [],
    }).ready,
    true,
  )
})

test('a passed real character asset board can be confirmed as one complete character asset', () => {
  assert.deepEqual(
    validateCharacterAssetPackConfirmation({
      viewType: 'character-asset-pack',
      imageStatus: 'candidate',
      visionStatus: 'passed',
      imageUrl: 'https://cdn.test/character-pack.png',
      modelName: 'doubao-seedream-5-0-flash-260915',
    }),
    { ready: true, code: null, message: '' },
  )
})

test('legacy single-image turnaround collage cannot be confirmed as a complete view set', () => {
  const result = validateCharacterTurnaroundConfirmation({
    viewType: 'character-turnaround',
    viewKey: null,
    imageStatus: 'candidate',
  })

  assert.equal(result.ready, false)
  assert.equal(result.code, 'character-view-angle-required')
  assert.match(result.message, /单张拼贴结果/)
})

test('an independently identified character angle may be confirmed', () => {
  assert.deepEqual(
    validateCharacterTurnaroundConfirmation({
      viewType: 'character-turnaround',
      viewKey: 'side',
      imageStatus: 'candidate',
      visionStatus: 'passed',
      imageUrl: 'https://cdn.test/side.png',
      modelName: 'real-image-provider',
    }),
    { ready: true, code: null, message: '' },
  )
})

test('a derived character image cannot be confirmed when identity or wardrobe comparison failed', () => {
  const result = validateCharacterTurnaroundConfirmation({
    viewType: 'character-turnaround',
    viewKey: 'side',
    imageStatus: 'candidate',
    visionStatus: 'passed',
    identityStatus: 'failed',
    identityReason: '脸部和基础图不一致',
    imageUrl: 'https://cdn.test/side.png',
    modelName: 'real-image-provider',
  })
  assert.equal(result.ready, false)
  assert.equal(result.code, 'character-identity-inconsistent')
  assert.match(result.message, /脸部和基础图不一致/)
})

test('character angle confirmation requires a passed visual inspection', () => {
  const result = validateCharacterTurnaroundConfirmation({
    viewType: 'character-turnaround',
    viewKey: 'back',
    imageStatus: 'candidate',
    visionStatus: 'failed',
  })
  assert.equal(result.ready, false)
  assert.equal(result.code, 'character-view-vision-pending')
  assert.match(result.message, /视觉检查/)
})

test('character and scene base images cannot be adopted while visual inspection is pending', () => {
  for (const nodeType of ['character', 'scene']) {
    const result = validateAssetImageConfirmation({
      nodeType,
      viewType: 'single',
      imageStatus: 'candidate',
      visionStatus: 'pending',
      imageUrl: `https://cdn.test/${nodeType}.png`,
      modelName: 'real-image-provider',
    })
    assert.equal(result.ready, false)
    assert.equal(result.code, 'asset-image-vision-pending')
  }
})

test('scene base can be manually adopted when visual inspection is explicitly skipped', () => {
  const result = validateAssetImageConfirmation({
    nodeType: 'scene',
    viewType: 'single',
    imageStatus: 'candidate',
    visionStatus: 'skipped',
    imageUrl: 'https://cdn.test/panorama.png',
    modelName: 'real-image-provider',
  })

  assert.deepEqual(result, {
    ready: true,
    code: null,
    message: '视觉检查未运行；请人工确认场景全景基准',
  })
})

test('mock character angles cannot be confirmed as real assets', () => {
  const result = validateCharacterTurnaroundConfirmation({
    viewType: 'character-turnaround',
    viewKey: 'front',
    imageStatus: 'candidate',
    visionStatus: 'passed',
    imageUrl: 'http://<YOUR_SERVER_IP>/mock-assets/project-28/node-21/v1-1.png',
    modelName: 'mock-asset-lock-v1',
  })

  assert.equal(result.ready, false)
  assert.equal(result.code, 'character-view-not-real')
})

test('legacy mock or unavailable character references are excluded from fresh base generation', () => {
  assert.deepEqual(
    resolveCharacterReferenceImageUrls([
      'http://<YOUR_SERVER_IP>/mock-assets/project-28/characters/tang-ning/reference/v1.png',
      'https://projectdream-media-1454726250.cos.ap-guangzhou.myqcloud.com/legacy.png',
    ]),
    ['https://projectdream-media-1454726250.cos.ap-guangzhou.myqcloud.com/legacy.png'],
  )
})
