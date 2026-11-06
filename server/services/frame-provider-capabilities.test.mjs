import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getFrameProviderCapabilities,
  assertFrameReferenceImageSupport,
} from './frame-provider-capabilities.mjs'

test('provider capabilities describe reference support instead of relying on scattered branches', () => {
  assert.equal(getFrameProviderCapabilities('agnes').supportsReferenceImages, true)
  assert.equal(getFrameProviderCapabilities('volcengine').maxReferenceImages, 8)
  assert.equal(getFrameProviderCapabilities('bigmodel').supportsReferenceImages, false)
})

test('unsupported provider refuses identity references with an actionable error', () => {
  assert.throws(
    () => assertFrameReferenceImageSupport({ provider: 'bigmodel', modelName: 'cogview-3-flash', referenceImageUrls: ['https://cdn.test/base.png'] }),
    (error) => error.code === 'FRAME_REFERENCE_UNSUPPORTED' && /参考图/.test(error.message),
  )
})
