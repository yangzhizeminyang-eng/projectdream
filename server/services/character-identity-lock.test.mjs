import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCharacterIdentityLockSnapshot,
  buildCharacterIdentityLockPrompt,
  resolveCharacterReferenceSet,
} from './character-identity-lock.mjs'

const images = [
  { id: 10, viewSetType: 'single', viewKey: null, status: 'confirmed', visionStatus: 'passed', imageUrl: 'https://cdn.test/base.png', storageKey: 'base.png' },
  { id: 11, viewSetType: 'character-face-closeup', viewKey: 'face', status: 'confirmed', visionStatus: 'passed', imageUrl: 'https://cdn.test/face.png', storageKey: 'face.png' },
  { id: 12, viewSetType: 'character-turnaround', viewKey: 'front', status: 'confirmed', visionStatus: 'passed', imageUrl: 'https://cdn.test/front.png', storageKey: 'front.png' },
  { id: 13, viewSetType: 'character-turnaround', viewKey: 'side', status: 'confirmed', visionStatus: 'passed', imageUrl: 'https://cdn.test/side.png', storageKey: 'side.png' },
  { id: 14, viewSetType: 'character-turnaround', viewKey: 'back', status: 'confirmed', visionStatus: 'passed', imageUrl: 'https://cdn.test/back.png', storageKey: 'back.png' },
]

test('character identity lock chooses only confirmed passed references in stable order', () => {
  const result = resolveCharacterReferenceSet(images)
  assert.deepEqual(result.imageIds, [10, 11, 12, 13, 14])
  assert.deepEqual(result.storageKeys, ['base.png', 'face.png', 'front.png', 'side.png', 'back.png'])
  assert.deepEqual(result.imageUrls, [
    'https://cdn.test/base.png',
    'https://cdn.test/face.png',
    'https://cdn.test/front.png',
    'https://cdn.test/side.png',
    'https://cdn.test/back.png',
  ])
})

test('identity snapshot locks the base image, face, wardrobe and evidence mode', () => {
  const snapshot = buildCharacterIdentityLockSnapshot({
    character: {
      id: 7,
      name: '唐宁',
      appearance: '黑色长发，鹅蛋脸，左眉尾有浅痣',
      costume: '红色连帽衫，黑色长裤，白色运动鞋，红色发卡',
    },
    baseImage: images[0],
    referenceSet: resolveCharacterReferenceSet(images),
  })
  assert.equal(snapshot.baseImageId, 10)
  assert.equal(snapshot.faceReferenceImageId, 11)
  assert.equal(snapshot.wardrobe, '红色连帽衫，黑色长裤，白色运动鞋，红色发卡')
  assert.equal(snapshot.identityMode, 'multi-reference-visual-lock')
  assert.match(snapshot.prompt, /基础正面全身图/)
  assert.match(snapshot.prompt, /服装、鞋子、发型和配饰不得变化/)
})

test('derived prompt carries the lock without importing scene or acting context', () => {
  const snapshot = buildCharacterIdentityLockSnapshot({
    character: { name: '唐宁', appearance: '黑色长发', costume: '红色连帽衫、黑裤、白鞋' },
    baseImage: images[0],
    referenceSet: resolveCharacterReferenceSet(images),
  })
  const prompt = buildCharacterIdentityLockPrompt(snapshot, '严格90度左侧面')
  assert.match(prompt, /严格90度左侧面/)
  assert.match(prompt, /红色连帽衫、黑裤、白鞋/)
  assert.doesNotMatch(prompt, /场景动作|对白|会议室|公寓/)
})
