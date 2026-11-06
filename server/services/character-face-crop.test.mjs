import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCharacterFaceCropFilter,
  calculateCharacterFaceCrop,
  validateCharacterFaceCropLayout,
  buildCharacterQualityRepairPrompt,
  characterDerivedQualityAttempts,
} from './character-face-crop.mjs'

test('face crop is calculated from each image head bounds and includes the full jaw', () => {
  const crop = calculateCharacterFaceCrop({
    imageWidth: 1024,
    imageHeight: 1536,
    headBox: { left: 0.4, top: 0.07, right: 0.6, bottom: 0.2 },
  })
  assert.ok(crop.x <= 409)
  assert.ok(crop.y <= 107)
  assert.ok(crop.x + crop.width >= 615)
  assert.ok(crop.y + crop.height >= 307)
  assert.equal(crop.width, crop.height)
  assert.match(buildCharacterFaceCropFilter({
    imageWidth: 1024,
    imageHeight: 1536,
    headBox: { left: 0.4, top: 0.07, right: 0.6, bottom: 0.2 },
  }), new RegExp(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`))
})

test('different head positions produce different crop coordinates instead of reusing a fixed window', () => {
  const leftHead = calculateCharacterFaceCrop({
    imageWidth: 1024,
    imageHeight: 1536,
    headBox: { left: 0.1, top: 0.12, right: 0.3, bottom: 0.28 },
  })
  const rightHead = calculateCharacterFaceCrop({
    imageWidth: 1024,
    imageHeight: 1536,
    headBox: { left: 0.65, top: 0.18, right: 0.85, bottom: 0.34 },
  })
  assert.notEqual(leftHead.x, rightHead.x)
  assert.notEqual(leftHead.y, rightHead.y)
})

test('face crop expands a white canvas for a complete head close to the image edge', () => {
  const crop = calculateCharacterFaceCrop({
    imageWidth: 1024,
    imageHeight: 1536,
    headBox: { left: 0.38, top: 0.001, right: 0.62, bottom: 0.161 },
  })
  assert.ok(crop.padTop > 0)
  assert.equal(crop.cropY, 0)
})

test('face crop rejects a head that is actually clipped at the source edge', () => {
  assert.throws(() => calculateCharacterFaceCrop({
    imageWidth: 1024,
    imageHeight: 1536,
    headBox: { left: 0.38, top: 0, right: 0.62, bottom: 0.18 },
  }), /贴住基础图边缘/)
})

test('face crop uses the current composition for a wide image and never falls back to a portrait window', () => {
  const left = calculateCharacterFaceCrop({
    imageWidth: 2048,
    imageHeight: 1024,
    headBox: { left: 0.08, top: 0.18, right: 0.24, bottom: 0.48 },
  })
  const right = calculateCharacterFaceCrop({
    imageWidth: 2048,
    imageHeight: 1024,
    headBox: { left: 0.7, top: 0.24, right: 0.86, bottom: 0.54 },
  })
  assert.ok(left.x < right.x)
  assert.equal(left.width, left.height)
  assert.equal(right.width, right.height)
  assert.ok(left.x + left.width <= 1024)
  assert.ok(right.x + right.width <= 2048)
})

test('face crop rejects missing, invalid, or out-of-frame head bounds', () => {
  assert.throws(() => calculateCharacterFaceCrop({ imageWidth: 1024, imageHeight: 1536 }), /头部定位框/)
  assert.throws(() => calculateCharacterFaceCrop({
    imageWidth: 1024,
    imageHeight: 1536,
    headBox: { left: 0.7, top: 0.2, right: 0.2, bottom: 0.4 },
  }), /头部定位框/)
  assert.throws(() => calculateCharacterFaceCrop({
    imageWidth: 320,
    imageHeight: 320,
    headBox: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 },
  }), /原图尺寸/)
})

test('face crop filter scales a per-image square crop with white padding', () => {
  const filter = buildCharacterFaceCropFilter({
    imageWidth: 1024,
    imageHeight: 1536,
    headBox: { left: 0.4, top: 0.07, right: 0.6, bottom: 0.2 },
  })
  assert.match(filter, /scale=1024:1024/)
  assert.match(filter, /pad=1024:1024.*color=white/)
})

test('face crop accepts the media probe dimensions through the worker field mapping', () => {
  const media = { width: 2624, height: 1472 }
  const filter = buildCharacterFaceCropFilter({
    imageWidth: media.width,
    imageHeight: media.height,
    headBox: { left: 0.465, top: 0.011, right: 0.534, bottom: 0.153 },
  })
  assert.match(filter, /crop=\d+:\d+:\d+:\d+/)
  assert.match(filter, /scale=1024:1024/)
})

test('face crop keeps a conservative lower safety margin for a tall narrow head near the bottom edge', () => {
  const headBox = { left: 0.42, top: 0.58, right: 0.58, bottom: 0.84 }
  const crop = calculateCharacterFaceCrop({
    imageWidth: 1200,
    imageHeight: 1200,
    headBox,
  })
  const layout = validateCharacterFaceCropLayout({
    imageWidth: 1200,
    imageHeight: 1200,
    headBox,
    crop,
  })
  assert.equal(layout.ok, true)
  assert.ok(layout.margins.bottom >= layout.required.bottom)
  assert.ok(layout.margins.top >= layout.required.top)
})

test('face crop layout rejects a crop spec that would cut the chin', () => {
  const result = validateCharacterFaceCropLayout({
    imageWidth: 1000,
    imageHeight: 1000,
    headBox: { left: 0.4, top: 0.2, right: 0.6, bottom: 0.6 },
    crop: {
      cropX: 200,
      cropY: 210,
      width: 400,
      height: 400,
      padLeft: 0,
      padTop: 0,
      padRight: 0,
      padBottom: 0,
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /下巴|下颌/u)
})

test('quality attempts are bounded to protect the worker and provider quota', () => {
  assert.equal(characterDerivedQualityAttempts(0), 1)
  assert.equal(characterDerivedQualityAttempts(3), 3)
  assert.equal(characterDerivedQualityAttempts(99), 4)
  assert.equal(characterDerivedQualityAttempts('bad'), 3)
})

test('quality repair prompt preserves the identity lock and names the previous failure', () => {
  const prompt = buildCharacterQualityRepairPrompt({
    viewKey: 'side',
    previousReason: '仍然是正面图并出现水杯',
    attempt: 2,
  })
  assert.match(prompt, /严格90度左侧面/)
  assert.match(prompt, /仍然是正面图并出现水杯/)
  assert.match(prompt, /不要改变脸、发型、妆容、服装/)
})
