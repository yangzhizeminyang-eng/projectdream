import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildReferencedAssetPromptContext,
  buildStoryboardReferenceSnapshot,
  validateStoryboardReferenceSnapshot,
} from './storyboard-asset-references.mjs'

test('video asset context never replays prop or scene image-generation layout instructions', () => {
  const context = buildReferencedAssetPromptContext([
    {
      kind: 'prop',
      name: '蓝色档案盒',
      promptText: '纯白背景，完整展示，居中陈列，不要场景。',
      imageUrl: 'https://cdn.test/prop.png',
    },
    {
      kind: 'scene',
      name: '旧档案室',
      promptText: '空场全景，无人物，家具固定。',
      imageUrl: 'https://cdn.test/scene.png',
    },
  ])

  assert.match(context, /道具「蓝色档案盒」/u)
  assert.match(context, /镜头构图、场景与动作以本镜提示词为准/u)
  assert.doesNotMatch(context, /纯白背景|完整展示|空场全景|家具固定/u)
})

test('video request snapshot contains locked character turnaround and scene angle references', () => {
  const snapshot = buildStoryboardReferenceSnapshot({
    storyboard: {
      asset_reference_json: JSON.stringify({
        characterId: 7,
        characterVersionNo: 3,
        characterViewSetVersion: 2,
        characterViewKeys: ['front', 'side', 'back'],
        characterBaseImageId: 71,
        characterBaseVersionNo: 3,
        characterFaceImageId: 72,
        characterFaceVersionNo: 1,
        sceneAssetId: 22,
        scenePanoramaVersion: 4,
        sceneViewSetVersion: 2,
        sceneViewKey: 'front-right',
        sceneViewIndex: 3,
        performance: { emotion: '压抑的警觉', intensity: 84, lipSync: '逐字对应对白' },
      }),
    },
    referenceImages: ['https://cdn.test/character-front.png', 'https://cdn.test/scene-front-right.png'],
    referencedAssets: [{ kind: 'character', name: '唐宁', imageUrl: 'https://cdn.test/character-front.png' }],
  })

  const result = validateStoryboardReferenceSnapshot(snapshot)
  assert.equal(result.passed, true)
  assert.equal(snapshot.scene.viewKey, 'front-right')
  assert.deepEqual(snapshot.character.viewKeys, ['front', 'side', 'back'])
  assert.deepEqual(snapshot.performance, { emotion: '压抑的警觉', intensity: 84, lipSync: '逐字对应对白' })
})

test('video reference snapshot carries a confirmed scene panorama when no angle board exists', () => {
  const snapshot = buildStoryboardReferenceSnapshot({
    storyboard: {
      asset_reference_json: JSON.stringify({
        sceneAssetId: 22,
        scenePanoramaVersion: 4,
        scenePanoramaImageId: 221,
        sceneViewKey: null,
      }),
    },
    referenceImages: ['https://cdn.test/scene-panorama.png'],
    referencedAssets: [{ kind: 'scene', name: '值班室', imageUrl: 'https://cdn.test/scene-panorama.png', versionNo: 4 }],
  })

  const result = validateStoryboardReferenceSnapshot(snapshot)
  assert.equal(result.passed, true)
  assert.equal(snapshot.scene.panoramaImageId, 221)
  assert.equal(snapshot.scene.viewKey, null)
})

test('video request is blocked when the locked asset reference has no usable image', () => {
  const snapshot = buildStoryboardReferenceSnapshot({
    storyboard: {
      asset_reference_json: JSON.stringify({
        characterId: 7,
        characterVersionNo: 3,
        characterViewSetVersion: 2,
        characterViewKeys: ['front', 'side', 'back'],
        characterBaseImageId: 71,
        characterBaseVersionNo: 3,
        characterFaceImageId: 72,
        characterFaceVersionNo: 1,
        sceneAssetId: 22,
        scenePanoramaVersion: 4,
        sceneViewSetVersion: 2,
        sceneViewKey: 'front-right',
        sceneViewIndex: 3,
      }),
    },
  })

  const result = validateStoryboardReferenceSnapshot(snapshot)
  assert.equal(result.passed, false)
  assert.match(result.blockers.join('、'), /参考图/)
})

test('reference snapshot preserves the complete supplied asset image list', () => {
  const references = Array.from({ length: 18 }, (_, index) => `https://cdn.test/asset-${index + 1}.png`)
  const snapshot = buildStoryboardReferenceSnapshot({ referenceImages: references })
  assert.deepEqual(snapshot.referenceImages, references)
})

test('video reference validation blocks a character that has no confirmed face closeup', () => {
  const snapshot = buildStoryboardReferenceSnapshot({
    storyboard: {
      asset_reference_json: JSON.stringify({
        characterId: 7,
        characterVersionNo: 3,
        characterViewSetVersion: 2,
        characterViewKeys: ['front', 'side', 'back'],
        characterBaseImageId: 71,
        characterBaseVersionNo: 3,
        sceneAssetId: 22,
        scenePanoramaVersion: 4,
        sceneViewSetVersion: 2,
        sceneViewKey: 'front-right',
        sceneViewIndex: 3,
      }),
    },
    referenceImages: ['character.png', 'scene.png'],
  })
  const result = validateStoryboardReferenceSnapshot(snapshot)
  assert.equal(result.passed, false)
  assert.ok(result.blockers.some((item) => /脸部特写/.test(item)))
})

test('video reference validation allows an explicitly off-camera character without a face closeup', () => {
  const snapshot = buildStoryboardReferenceSnapshot({
    storyboard: {
      asset_reference_json: JSON.stringify({
        characterId: 7,
        characterVersionNo: 3,
        characterViewSetVersion: 2,
        characterViewKeys: ['front', 'side', 'back'],
        characterBaseImageId: 71,
        characterBaseVersionNo: 3,
        characterFaceRequired: false,
        sceneAssetId: 22,
        scenePanoramaVersion: 4,
        sceneViewSetVersion: 2,
        sceneViewKey: 'front-right',
        sceneViewIndex: 3,
      }),
    },
    referenceImages: ['character.png', 'scene.png'],
  })
  const result = validateStoryboardReferenceSnapshot(snapshot)
  assert.equal(result.passed, true)
  assert.equal(snapshot.character.faceRequired, false)
})

test('video snapshot preserves confirmed prop bindings', () => {
  const snapshot = buildStoryboardReferenceSnapshot({
    storyboard: {
      asset_reference_json: JSON.stringify({
        characterId: 7,
        characterVersionNo: 3,
        characterViewSetVersion: 2,
        characterViewKeys: ['front', 'side', 'back'],
        characterBaseImageId: 71,
        characterBaseVersionNo: 3,
        characterFaceImageId: 72,
        characterFaceVersionNo: 1,
        sceneAssetId: 22,
        scenePanoramaVersion: 4,
        sceneViewSetVersion: 2,
        sceneViewKey: 'front-right',
        sceneViewIndex: 3,
        propAssetRefs: [{ assetNodeId: 31, imageId: 41, name: '离职协议', versionNo: 2 }],
      }),
    },
    referenceImages: ['character.png', 'scene.png', 'agreement.png'],
  })
  const result = validateStoryboardReferenceSnapshot(snapshot)
  assert.equal(result.passed, true)
  assert.deepEqual(snapshot.props[0], { assetNodeId: 31, imageId: 41, name: '离职协议', versionNo: 2 })
})
