import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCharacterAssetPackCropFilter,
  buildCharacterAssetPackDescriptors,
  validateCharacterAssetPackDescriptors,
} from './character-asset-pack.mjs'

test('character asset pack exposes one base, one face and three independent full-body views', () => {
  const descriptors = buildCharacterAssetPackDescriptors()
  assert.deepEqual(descriptors.map((item) => item.viewKey || '__base__'), ['__base__', 'face', 'front', 'side', 'back'])
  assert.equal(validateCharacterAssetPackDescriptors(descriptors).ready, true)
  assert.match(buildCharacterAssetPackCropFilter('face'), /crop=iw\*0\.5:ih\*0\.5:iw\*0\.5:ih\*0/)
  assert.match(buildCharacterAssetPackCropFilter('side'), /iw\*0\.16666666666666666/)
})

test('asset pack validation rejects duplicate or missing regions', () => {
  const result = validateCharacterAssetPackDescriptors([{ viewKey: 'face' }, { viewKey: 'front' }])
  assert.equal(result.ready, false)
  assert.deepEqual(result.missing, ['__base__', 'side', 'back'])
})
