import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSceneNineGridCropFilter,
  buildSceneNineGridAnglePrompt,
  buildSceneNineGridViewDescriptors,
  buildSceneNineGridQualityRepairPrompt,
  getSceneNineGridAngles,
  sceneNineGridQualityAttempts,
  validateSceneNineGridViewConfirmation,
} from './scene-nine-grid.mjs'

function testSpatialAnchors() {
  const viewBindings = Object.fromEntries(getSceneNineGridAngles().map((angle) => [
    angle.key,
    ['A1', 'A2'],
  ]))
  return {
    anchors: [
      { id: 'A1', category: 'architecture', label: '东侧落地窗', description: '落地窗', relative_position: '东侧', evidence: '剧本证据', origin: 'script' },
      { id: 'A2', category: 'fixed_furniture', label: '窗前木桌', description: '木桌', relative_position: '窗前', evidence: '剧本证据', origin: 'script' },
      { id: 'M1', category: 'material', label: '木桌表面', description: '旧木纹', relative_position: '窗前', evidence: '剧本证据', origin: 'inference', narrative_reason: '体现使用痕迹' },
      { id: 'L1', category: 'light', label: '屏幕光', description: '局部冷白光', relative_position: '桌上', evidence: '剧本证据', origin: 'script', narrative_reason: '突出深夜孤独感' },
    ],
    view_bindings: viewBindings,
  }
}

test('scene nine-grid quality retries stay bounded and default to five attempts', () => {
  assert.equal(sceneNineGridQualityAttempts(undefined), 5)
  assert.equal(sceneNineGridQualityAttempts(2), 2)
  assert.equal(sceneNineGridQualityAttempts(99), 5)
})

test('scene nine-grid repair prompt keeps the same angle and panorama constraints', () => {
  const prompt = buildSceneNineGridQualityRepairPrompt({
    angle: 'center',
    previousReason: '视角中出现白板',
    attempt: 2,
  })
  assert.match(prompt, /正中\s+视角/)
  assert.match(prompt, /白板/)
  assert.match(prompt, /同一张已确认全景基准图/)
  assert.match(prompt, /完整、真实摄影质感/)
})

test('scene nine-grid angle prompt describes an independent complete view from one panorama', () => {
  const prompt = buildSceneNineGridAnglePrompt({
    spatialAnchors: testSpatialAnchors(),
    angle: 'back-right',
    panorama: 'https://cdn.test/apartment-panorama.png',
  })

  assert.match(prompt, /右后/)
  assert.match(prompt, /固定全景原点/u)
  assert.match(prompt, /yaw.*pitch.*FOV/u)
  assert.match(prompt, /A1.*A2/u)
  assert.match(prompt, /不补写房间、家具、材质、灯光或剧情描述/u)
  assert.match(prompt, /同一张已确认的场景全景基准图/)
  assert.match(prompt, /https:\/\/cdn\.test\/apartment-panorama\.png/)
  assert.doesNotMatch(prompt, /深夜公寓客厅，沙发靠北墙/u)
  assert.match(prompt, /参考图引导生成，不是确定性三维采样/u)
})

test('each scene angle prompt exposes numeric camera parameters without respecifying the room', () => {
  const left = buildSceneNineGridAnglePrompt({
    angle: 'front-left',
    panorama: 'https://cdn.test/room.png',
    spatialAnchors: testSpatialAnchors(),
  })
  const back = buildSceneNineGridAnglePrompt({
    angle: 'back-right',
    panorama: 'https://cdn.test/room.png',
    spatialAnchors: testSpatialAnchors(),
  })

  assert.match(left, /yaw=-45/u)
  assert.match(back, /yaw=215/u)
  assert.match(left, /pitch=-?\d+/u)
  assert.match(left, /FOV=\d+/u)
  assert.doesNotMatch(left, /长桌居中/u)
})

test('the nine scene prompts encode visibly different camera positions, headings, and framing', () => {
  const prompts = getSceneNineGridAngles().map((angle) => buildSceneNineGridAnglePrompt({
    angle,
    panorama: 'https://cdn.test/room.png',
    spatialAnchors: testSpatialAnchors(),
  }))
  const cameraInstructions = prompts.map((prompt) => prompt.match(/相机参数（唯一变化）：([^\n]+)/)?.[1])

  assert.equal(new Set(cameraInstructions).size, 9)
  assert.ok(cameraInstructions.every((instruction) => instruction && /yaw=.*pitch=.*FOV=/.test(instruction)))
  assert.ok(prompts.every((prompt) => /参考图引导生成/.test(prompt)))
  assert.ok(prompts.every((prompt) => !prompt.includes('会议室，玻璃墙在左')))
})

test('scene generation skipped-vision state is explicit and still allows user adoption', () => {
  const result = validateSceneNineGridViewConfirmation({
    viewKey: 'center',
    sourceImageId: 88,
    imageStatus: 'candidate',
    visionStatus: 'skipped',
    imageUrl: 'https://cdn.test/center.png',
    modelName: 'real-image-provider',
  })

  assert.deepEqual(result, {
    ready: true,
    code: null,
    message: '视觉检查未运行；请按全景基准人工确认此角度',
    visionSkipped: true,
  })
})

test('scene nine-grid exposes nine independently addressable cells with crop evidence', () => {
  const items = buildSceneNineGridViewDescriptors({
    sourceImageId: 88,
    sourceImageUrl: 'https://cdn.test/mother.png',
    viewSetVersion: 4,
    status: 'candidate',
  })

  assert.equal(items.length, 9)
  assert.deepEqual(items.map((item) => item.viewKey), [
    'front-left',
    'front',
    'front-right',
    'left',
    'center',
    'right',
    'back-left',
    'back',
    'back-right',
  ])
  assert.deepEqual(items[0].crop, { x: 0, y: 0, width: 1 / 3, height: 1 / 3 })
  assert.deepEqual(items[4].crop, { x: 1 / 3, y: 1 / 3, width: 1 / 3, height: 1 / 3 })
  assert.deepEqual(items[8].crop, { x: 2 / 3, y: 2 / 3, width: 1 / 3, height: 1 / 3 })
  assert.equal(items.every((item) => item.sourceImageId === 88), true)
  assert.equal(items.every((item) => item.sourceImageUrl === 'https://cdn.test/mother.png'), true)
})

test('scene nine-grid crop filters map each view to its exact cell', () => {
  assert.equal(buildSceneNineGridCropFilter('front-left'), 'crop=iw/3:ih/3:0*iw/3:0*ih/3')
  assert.equal(buildSceneNineGridCropFilter('center'), 'crop=iw/3:ih/3:1*iw/3:1*ih/3')
  assert.equal(buildSceneNineGridCropFilter('back-right'), 'crop=iw/3:ih/3:2*iw/3:2*ih/3')
  assert.throws(() => buildSceneNineGridCropFilter('unknown'), /unknown scene nine-grid view/)
})

test('scene nine-grid confirmation rejects the mother image and requires a passed real crop', () => {
  const mother = validateSceneNineGridViewConfirmation({
    viewKey: null,
    crop: null,
    imageStatus: 'candidate',
    visionStatus: 'passed',
    imageUrl: 'https://cdn.test/mother.png',
    modelName: 'real-image-provider',
  })
  assert.equal(mother.ready, false)
  assert.equal(mother.code, 'scene-view-angle-required')

  const crop = validateSceneNineGridViewConfirmation({
    viewKey: 'front-right',
    crop: { x: 2 / 3, y: 0, width: 1 / 3, height: 1 / 3 },
    sourceImageId: 88,
    imageStatus: 'candidate',
    visionStatus: 'passed',
    imageUrl: 'https://cdn.test/front-right.png',
    modelName: 'real-image-provider',
  })
  assert.deepEqual(crop, { ready: true, code: null, message: '' })
})

test('scene nine-grid confirmation rejects an unchecked or mock crop', () => {
  const result = validateSceneNineGridViewConfirmation({
    viewKey: 'center',
    crop: { x: 1 / 3, y: 1 / 3, width: 1 / 3, height: 1 / 3 },
    sourceImageId: 88,
    imageStatus: 'candidate',
    visionStatus: 'failed',
    imageUrl: 'http://example.test/mock-assets/grid.png',
    modelName: 'mock-grid-v1',
  })
  assert.equal(result.ready, false)
  assert.equal(result.code, 'scene-view-vision-pending')
})

test('scene nine-grid confirmation rejects superseded retries without replacing the active image', () => {
  const result = validateSceneNineGridViewConfirmation({
    viewKey: 'center',
    sourceImageId: 88,
    imageStatus: 'superseded',
    visionStatus: 'passed',
    imageUrl: 'https://cdn.test/old-center.png',
    modelName: 'real-image-provider',
  })
  assert.equal(result.ready, false)
  assert.equal(result.code, 'scene-view-superseded')
})

test('scene nine-grid confirmation accepts a real standalone angle without crop metadata', () => {
  const result = validateSceneNineGridViewConfirmation({
    viewKey: 'left',
    crop: null,
    sourceImageId: 88,
    imageStatus: 'candidate',
    visionStatus: 'passed',
    imageUrl: 'https://cdn.test/left.png',
    modelName: 'real-image-provider',
  })
  assert.deepEqual(result, { ready: true, code: null, message: '' })
})
