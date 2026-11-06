import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCharacterHeadLocalizationPayload,
  buildVisionRequestPayload,
  enforceVisionViewConsistency,
  locateCharacterHeadBounds,
  parseCharacterHeadLocalization,
  parseVisionResult,
} from './vision.mjs'

test('head localization uses a single base image and explicitly includes the complete head and chin', () => {
  const payload = buildCharacterHeadLocalizationPayload({
    model: 'doubao-seed-2-1-pro-260915',
    imageUrl: 'data:image/png;base64,abc',
    imageWidth: 1600,
    imageHeight: 900,
  })
  const content = payload.input[0].content
  assert.equal(content.filter((part) => part.type === 'input_image').length, 1)
  assert.match(content[0].text, /头发顶部.*下巴/)
  assert.match(content[0].text, /双耳.*下巴最低点/)
  assert.match(content[0].text, /0到1000的整数网格坐标/)
  assert.match(content[0].text, /1600 × 900/)
})

test('head localization parser accepts a complete confident normalized bounding box', () => {
  const result = parseCharacterHeadLocalization({
    output_text: '{"person_count":1,"complete":true,"confidence":0.92,"person_box":{"left":0.2,"top":0.03,"right":0.8,"bottom":0.96},"head_box":{"left":0.35,"top":0.08,"right":0.65,"bottom":0.24},"reason":"头顶至下巴完整"}',
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.headBox, { left: 0.35, top: 0.08, right: 0.65, bottom: 0.24 })
  assert.deepEqual(result.personBox, { left: 0.2, top: 0.03, right: 0.8, bottom: 0.96 })
})

test('head localization parser normalizes percentage coordinates returned by a vision model', () => {
  const result = parseCharacterHeadLocalization({
    output_text: '{"person_count":1,"complete":true,"confidence":0.98,"person_box":{"left":0.2,"top":3,"right":0.8,"bottom":96},"head_box":{"left":0.464,"top":7,"right":0.535,"bottom":20}}',
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.headBox, { left: 0.464, top: 0.07, right: 0.535, bottom: 0.2 })
})

test('head localization parser maps explicit pixel coordinates using the source image dimensions', () => {
  const result = parseCharacterHeadLocalization({
    output_text: '{"person_count":1,"complete":true,"confidence":0.98,"coordinate_space":"pixels","person_box":{"left":524,"top":15,"right":1523,"bottom":1457},"head_box":{"left":1220,"top":20,"right":1400,"bottom":225}}',
  }, { imageWidth: 2624, imageHeight: 1472 })
  assert.equal(result.ok, true)
  assert.ok(Math.abs(result.headBox.top - 20 / 1472) < 0.00001)
  assert.ok(Math.abs(result.headBox.bottom - 225 / 1472) < 0.00001)
})

test('head localization parser maps the vision API 0-to-1000 image grid onto the full source image', () => {
  const result = parseCharacterHeadLocalization({
    output_text: '{"person_count":1,"complete":true,"confidence":0.98,"coordinate_space":"pixels","person_box":{"left":419,"top":11,"right":577,"bottom":990},"head_box":{"left":466,"top":11,"right":534,"bottom":151}}',
  }, { imageWidth: 2624, imageHeight: 1472 })
  assert.equal(result.ok, true)
  assert.ok(Math.abs(result.headBox.left - 0.466) < 0.00001)
  assert.ok(Math.abs(result.headBox.top - 0.011) < 0.00001)
  assert.ok(Math.abs(result.personBox.bottom - 0.99) < 0.00001)
})

test('head localization parser rejects incomplete, low-confidence, malformed and out-of-range detections', () => {
  const incomplete = parseCharacterHeadLocalization({
    output_text: '{"person_count":1,"complete":false,"confidence":0.98,"person_box":{"left":0.2,"top":0.03,"right":0.8,"bottom":0.96},"head_box":{"left":0.3,"top":0.1,"right":0.7,"bottom":0.3}}',
  })
  assert.equal(incomplete.ok, false)
  const uncertain = parseCharacterHeadLocalization({
    output_text: '{"person_count":1,"complete":true,"confidence":0.3,"person_box":{"left":0.2,"top":0.03,"right":0.8,"bottom":0.96},"head_box":{"left":0.3,"top":0.1,"right":0.7,"bottom":0.3}}',
  })
  assert.equal(uncertain.ok, false)
  const invalid = parseCharacterHeadLocalization({
    output_text: '{"person_count":1,"complete":true,"confidence":0.99,"person_box":{"left":0.2,"top":0.03,"right":0.8,"bottom":0.96},"head_box":{"left":-0.1,"top":0.1,"right":0.7,"bottom":0.3}}',
  })
  assert.equal(invalid.ok, false)
  assert.equal(parseCharacterHeadLocalization({ output_text: 'not json' }).ok, false)
})

test('head localization expands a coarse box with semantic chin and hair anchors', () => {
  const result = parseCharacterHeadLocalization({
    output_text: JSON.stringify({
      person_count: 1,
      complete: true,
      confidence: 0.98,
      person_box: { left: 0.2, top: 0.03, right: 0.8, bottom: 0.96 },
      head_box: { left: 0.36, top: 0.08, right: 0.64, bottom: 0.2 },
      head_landmarks: {
        hair_top: { x: 0.5, y: 0.07 },
        left_ear: { x: 0.35, y: 0.15 },
        right_ear: { x: 0.65, y: 0.15 },
        chin_bottom: { x: 0.5, y: 0.24 },
      },
    }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.headBox.left, 0.35)
  assert.equal(result.headBox.right, 0.65)
  assert.equal(result.headBox.top, 0.07)
  assert.equal(result.headBox.bottom, 0.24)
  assert.equal(result.headLandmarks.chinBottom.y, 0.24)
})

test('head localization rejects semantic anchors outside the person frame', () => {
  const result = parseCharacterHeadLocalization({
    output_text: JSON.stringify({
      person_count: 1,
      complete: true,
      confidence: 0.98,
      person_box: { left: 0.2, top: 0.03, right: 0.8, bottom: 0.96 },
      head_box: { left: 0.36, top: 0.08, right: 0.64, bottom: 0.2 },
      head_landmarks: {
        hair_top: { x: 0.5, y: 0.07 },
        left_ear: { x: 0.35, y: 0.15 },
        right_ear: { x: 0.65, y: 0.15 },
        chin_bottom: { x: 0.5, y: 0.99 },
      },
    }),
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /关键点|下巴|人物框/u)
})

test('head localization rejects a face-only box that is too short for the full head', () => {
  const result = parseCharacterHeadLocalization({
    output_text: '{"person_count":1,"complete":true,"confidence":0.98,"person_box":{"left":0.2,"top":0.01,"right":0.8,"bottom":0.99},"head_box":{"left":0.464,"top":0.1,"right":0.535,"bottom":0.15}}',
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /比例矛盾/)
})

test('head localization retries one transient upstream connection failure', async () => {
  const envKeys = ['AI_PROVIDER', 'VISION_API_KEY', 'VISION_BASE_URL', 'VISION_MODEL']
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  const originalFetch = globalThis.fetch
  let calls = 0
  process.env.AI_PROVIDER = 'ark'
  process.env.VISION_API_KEY = 'test-key'
  process.env.VISION_BASE_URL = 'https://vision.test/responses'
  process.env.VISION_MODEL = 'vision-test-model'
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) throw new Error('fetch failed')
    return new Response(JSON.stringify({
      output_text: '{"person_count":1,"complete":true,"confidence":0.98,"coordinate_space":"grid_1000","person_box":{"left":200,"top":10,"right":800,"bottom":990},"head_box":{"left":400,"top":50,"right":600,"bottom":200},"head_landmarks":{"hair_top":{"x":500,"y":50},"left_ear":{"x":400,"y":120},"right_ear":{"x":600,"y":120},"chin_bottom":{"x":500,"y":200}}}',
    }), { status: 200 })
  }
  try {
    const result = await locateCharacterHeadBounds({
      imageBytes: Buffer.from('source'),
      imageWidth: 1000,
      imageHeight: 1000,
    })
    assert.equal(result.ok, true)
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = originalFetch
    for (const key of envKeys) {
      if (previousEnv[key] == null) delete process.env[key]
      else process.env[key] = previousEnv[key]
    }
  }
})

test('real head localization rejects a response without semantic head landmarks', async () => {
  const envKeys = ['AI_PROVIDER', 'VISION_API_KEY', 'VISION_BASE_URL', 'VISION_MODEL', 'VISION_RETRY_DELAY_MS']
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  const originalFetch = globalThis.fetch
  process.env.AI_PROVIDER = 'ark'
  process.env.VISION_API_KEY = 'test-key'
  process.env.VISION_BASE_URL = 'https://vision.test/responses'
  process.env.VISION_MODEL = 'vision-test-model'
  process.env.VISION_RETRY_DELAY_MS = '0'
  globalThis.fetch = async () => new Response(JSON.stringify({
    output_text: '{"person_count":1,"complete":true,"confidence":0.98,"coordinate_space":"grid_1000","person_box":{"left":200,"top":10,"right":800,"bottom":990},"head_box":{"left":400,"top":50,"right":600,"bottom":200}}',
  }), { status: 200 })
  try {
    const result = await locateCharacterHeadBounds({
      imageBytes: Buffer.from('source'),
      imageWidth: 1000,
      imageHeight: 1000,
    })
    assert.equal(result.ok, false)
    assert.match(result.reason, /关键点/u)
  } finally {
    globalThis.fetch = originalFetch
    for (const key of envKeys) {
      if (previousEnv[key] == null) delete process.env[key]
      else process.env[key] = previousEnv[key]
    }
  }
})

test('vision requests use Ark Responses image content', () => {
  const payload = buildVisionRequestPayload({
    model: 'doubao-seed-2-1-pro-260915',
    imageUrl: 'https://cdn.test/front.png',
    viewKey: 'front',
  })
  assert.equal(payload.model, 'doubao-seed-2-1-pro-260915')
  assert.equal(payload.input[0].content[1].type, 'input_image')
  assert.equal(payload.input[0].content[1].image_url, 'https://cdn.test/front.png')
  assert.equal(payload.max_output_tokens, 256)
})

test('base image inspection sends only the selected candidate, not other group images', () => {
  const payload = buildVisionRequestPayload({
    model: 'doubao-seed-2-1-pro-260915',
    imageUrl: 'https://cdn.test/current-candidate.png',
    viewKey: 'front',
  })
  const content = payload.input[0].content
  assert.equal(content.filter((part) => part.type === 'input_image').length, 1)
  assert.equal(content.find((part) => part.type === 'input_image').image_url, 'https://cdn.test/current-candidate.png')
  assert.match(content[0].text, /从头到鞋完整全身/)
})

test('vision result parser rejects malformed output instead of passing it', () => {
  assert.equal(parseVisionResult({ output_text: 'not json' }).passed, false)
  assert.equal(
    parseVisionResult({ output_text: '{"passed":true,"reason":"back view is correct"}' }).passed,
    true,
  )
})

test('vision result parser reads Responses output content', () => {
  assert.equal(
    parseVisionResult({
      output: [{ content: [{ text: '{"passed":true,"reason":"白底正面全身"}' }] }],
    }).passed,
    true,
  )
})

test('vision result parser reads Responses nested output text and code fences', () => {
  assert.equal(
    parseVisionResult({
      output: [{ content: [{ type: 'output_text', value: '```json\n{"passed":true,"reason":"环境全景通过"}\n```' }] }],
    }).passed,
    true,
  )
})

test('vision payload can use a durable data URL when the public object URL is private', () => {
  const payload = buildVisionRequestPayload({
    model: 'doubao-seed-2-1-pro-260915',
    imageUrl: 'data:image/png;base64,abc',
    viewKey: 'side',
  })
  assert.match(payload.input[0].content[1].image_url, /^data:image\/png;base64,/)
})

test('vision payload preserves a no-face character constraint', () => {
  const payload = buildVisionRequestPayload({
    model: 'doubao-seed-2-1-pro-260915',
    imageUrl: 'https://cdn.test/body-reference.png',
    viewKey: 'front',
    noFace: true,
  })
  assert.match(payload.input[0].content[0].text, /不直接露脸/)
})

test('character asset board inspection requires identity consistency across the five regions', () => {
  const payload = buildVisionRequestPayload({
    model: 'doubao-seed-2-1-pro-260915',
    imageUrl: 'https://cdn.test/character-board.png',
    assetPack: true,
    nodeType: 'character',
  })
  const instruction = payload.input[0].content[0].text
  assert.match(instruction, /脸部特写是五官、脸型.*身份主参考/u)
  assert.match(instruction, /正面全身图是体态.*服装/u)
  assert.match(instruction, /三视图必须逐一同时回看这两个基准/u)
  assert.match(instruction, /identity_similarity_score/u)
  assert.match(instruction, /face_closeup_consistent/u)
})

test('character asset board vision requests reserve enough output for all five region checks', () => {
  const boardPayload = buildVisionRequestPayload({
    model: 'doubao-seed-2-1-pro-260915',
    imageUrl: 'https://cdn.test/character-board.png',
    assetPack: true,
    nodeType: 'character',
  })
  const singlePayload = buildVisionRequestPayload({
    model: 'doubao-seed-2-1-pro-260915',
    imageUrl: 'https://cdn.test/character.png',
    viewKey: 'front',
  })
  assert.equal(boardPayload.max_output_tokens, 768)
  assert.equal(singlePayload.max_output_tokens, 256)
})

test('asset board vision result fails when the model omits region-level identity checks', () => {
  const result = parseVisionResult({
    output_text: '{"passed":true,"reason":"排版完整"}',
  }, { assetPack: true })
  assert.equal(result.passed, false)
  assert.match(result.reason, /一致性结论缺失/u)
})

test('asset board vision result rejects a deformed side-view face', () => {
  const result = parseVisionResult({
    output_text: JSON.stringify({
      passed: true,
      reason: '五区存在',
      face_closeup_consistent: true,
      base_full_body_consistent: true,
      turnaround_consistent: false,
      region_checks: { side: { consistent: false, reason: '侧脸鼻梁和下颌明显变形' } },
    }),
  }, { assetPack: true })
  assert.equal(result.passed, false)
  assert.match(result.reason, /变形|一致性/u)
})

test('asset board vision result passes only with complete five-region consistency evidence', () => {
  const regionChecks = Object.fromEntries(
    ['face', 'base', 'front', 'side', 'back'].map((key) => [key, { consistent: true, reason: '同一角色身份与服装' }]),
  )
  const result = parseVisionResult({
    output_text: JSON.stringify({
      passed: true,
      reason: '五区排版与身份一致性通过',
      layout_complete: true,
      face_closeup_consistent: true,
      base_full_body_consistent: true,
      turnaround_consistent: true,
      region_checks: regionChecks,
      identity_similarity_score: 0.94,
      wardrobe_consistency_score: 0.98,
    }),
  }, { assetPack: true })
  assert.equal(result.passed, true)
  assert.deepEqual(result.assetPackConsistency.missingChecks, [])
  assert.deepEqual(result.assetPackConsistency.inconsistentRegions, [])
})

test('prop inspection uses complete-object rules instead of character full-body rules', () => {
  const payload = buildVisionRequestPayload({
    model: 'doubao-seed-2-1-pro-260915',
    imageUrl: 'https://cdn.test/intercom.png',
    nodeType: 'prop',
  })
  const instruction = payload.input[0].content[0].text
  assert.match(instruction, /单件道具/)
  assert.match(instruction, /完整边缘可见/)
  assert.doesNotMatch(instruction, /从头到鞋完整全身/)
  assert.doesNotMatch(instruction, /单人/)
})

test('back-view checks keep the requested angle when the character is normally no-face', () => {
  const payload = buildVisionRequestPayload({
    model: 'doubao-seed-2-1-pro-260915',
    imageUrl: 'https://cdn.test/body-reference.png',
    viewKey: 'back',
    noFace: true,
  })
  assert.match(payload.input[0].content[0].text, /背面/)
  assert.doesNotMatch(payload.input[0].content[0].text, /剧情明确要求不直接露脸/)
})

test('scene cell vision checks use the mother image as a comparison reference', () => {
  const payload = buildVisionRequestPayload({
    model: 'doubao-seed-2-1-pro-260915',
    imageUrl: 'https://cdn.test/front-right.png',
    referenceImageUrl: 'https://cdn.test/mother.png',
    viewKey: 'front-right',
    scene: true,
  })
  assert.match(payload.input[0].content[0].text, /九宫格单格/)
  assert.match(payload.input[0].content[0].text, /不要因为只显示单一机位而判失败/)
  assert.equal(payload.input[0].content[1].image_url, 'https://cdn.test/front-right.png')
  assert.equal(payload.input[0].content[3].image_url, 'https://cdn.test/mother.png')
  assert.match(payload.input[0].content[0].text, /允许因摄影机角度变化出现透视变化、自然遮挡和画面比例变化/)
})

test('character consistency vision compares a candidate with all identity references', () => {
  const payload = buildVisionRequestPayload({
    model: 'doubao-seed-2-1-pro-260915',
    imageUrl: 'https://cdn.test/side-candidate.png',
    referenceImageUrls: [
      'https://cdn.test/base.png',
      'https://cdn.test/face.png',
      'https://cdn.test/front.png',
    ],
    viewKey: 'side',
    nodeType: 'character',
    identityLock: true,
  })
  const images = payload.input[0].content.filter((part) => part.type === 'input_image')
  assert.equal(images.length, 4)
  assert.match(payload.input[0].content[0].text, /身份一致性|服装一致性/)
})

test('vision cannot pass a back view when the model reason contradicts the requested angle', () => {
  const result = enforceVisionViewConsistency({
    viewKey: 'back',
    result: { passed: true, reason: '为单人正面形象，从头到鞋完整呈现全身' },
  })
  assert.equal(result.passed, false)
  assert.match(result.reason, /视角判定自相矛盾/)

  const valid = enforceVisionViewConsistency({
    viewKey: 'back',
    result: { passed: true, reason: '背面全身，未见脸部' },
  })
  assert.equal(valid.passed, true)
})
