import assert from 'node:assert/strict'
import test from 'node:test'
import {
  inspectVideoConfirmationEligibility,
  inspectGeneratedVideoResult,
  inspectStoryboardAssetReferenceGate,
  inspectStoryboardGenerationContext,
} from './quality-gate.mjs'

test('video confirmation blocks candidates with failed or incomplete technical inspection', () => {
  for (const technicalStatus of ['needs_attention', 'unchecked', 'unknown']) {
    const report = inspectVideoConfirmationEligibility({
      qualityReport: { technicalStatus },
    })

    assert.equal(report.passed, false)
    assert.ok(report.blockers.some((item) => item.code === 'video-technical-inspection-not-passed'))
  }
})

test('video confirmation permits technically passed candidates and legacy videos without a report', () => {
  assert.equal(inspectVideoConfirmationEligibility({
    qualityReport: { technicalStatus: 'passed', semanticStatus: 'pending_review' },
  }).passed, true)
  assert.equal(inspectVideoConfirmationEligibility({ qualityReport: null }).passed, true)
})

test('asset reference gate blocks video generation without locked character and scene references', () => {
  const report = inspectStoryboardAssetReferenceGate({
    storyboard: { id: 1, character_id: 9 },
  })

  assert.equal(report.passed, false)
  assert.ok(report.blockers.some((item) => item.code === 'character-version-reference-missing'))
  assert.ok(report.blockers.some((item) => item.code === 'scene-panorama-reference-missing'))
})

test('asset reference gate accepts a fully locked storyboard reference', () => {
  const report = inspectStoryboardAssetReferenceGate({
    storyboard: {
      asset_reference_json: JSON.stringify({
        characterId: 9,
        characterVersionNo: 2,
        characterViewSetVersion: 1,
        characterViewKeys: ['front', 'side', 'back'],
        characterBaseImageId: 71,
        characterBaseVersionNo: 1,
        characterFaceImageId: 72,
        characterFaceVersionNo: 1,
        sceneAssetId: 10,
        scenePanoramaVersion: 3,
        sceneViewSetVersion: 2,
        sceneViewKey: 'front-right',
      }),
    },
  })

  assert.equal(report.passed, true)
  assert.equal(report.reference.sceneViewKey, 'front-right')
})

test('asset reference gate accepts a complete character asset board without split image ids', () => {
  const report = inspectStoryboardAssetReferenceGate({
    storyboard: {
      asset_reference_json: JSON.stringify({
        characterId: 9,
        characterVersionNo: 3,
        characterAssetPackImageId: 91,
        characterAssetPackVersionNo: 3,
        characterViewSetVersion: 3,
        characterViewKeys: ['front', 'side', 'back'],
        sceneAssetId: 10,
        scenePanoramaVersion: 3,
        sceneViewSetVersion: 2,
        sceneViewKey: 'front-right',
      }),
    },
  })

  assert.equal(report.passed, true)
})

test('asset reference gate accepts a confirmed scene-only insert shot', () => {
  const report = inspectStoryboardAssetReferenceGate({
    requireCharacter: false,
    storyboard: {
      asset_reference_json: JSON.stringify({
        sceneAssetId: 10,
        scenePanoramaVersion: 3,
        sceneViewSetVersion: 2,
        sceneViewKey: 'front-right',
      }),
    },
  })

  assert.equal(report.passed, true)
})

test('asset reference gate accepts a confirmed scene panorama without requiring nine-angle generation', () => {
  const report = inspectStoryboardAssetReferenceGate({
    requireCharacter: false,
    storyboard: {
      asset_reference_json: JSON.stringify({
        sceneAssetId: 10,
        scenePanoramaVersion: 3,
        scenePanoramaImageId: 31,
      }),
    },
  })

  assert.equal(report.passed, true)
  assert.equal(report.reference.scenePanoramaImageId, 31)
})

test('asset reference gate does not require a face closeup for an explicitly off-camera character', () => {
  const report = inspectStoryboardAssetReferenceGate({
    storyboard: {
      asset_reference_json: JSON.stringify({
        characterId: 9,
        characterVersionNo: 2,
        characterViewSetVersion: 1,
        characterViewKeys: ['front', 'side', 'back'],
        characterBaseImageId: 71,
        characterBaseVersionNo: 1,
        characterFaceRequired: false,
        sceneAssetId: 10,
        scenePanoramaVersion: 3,
        sceneViewSetVersion: 2,
        sceneViewKey: 'front-right',
      }),
    },
  })

  assert.equal(report.passed, true)
  assert.equal(report.blockers.some((item) => item.code === 'character-face-closeup-reference-missing'), false)
})

test('asset reference gate rejects an incomplete character turnaround', () => {
  const report = inspectStoryboardAssetReferenceGate({
    storyboard: {
      asset_reference_json: JSON.stringify({
        characterId: 9,
        characterVersionNo: 2,
        characterViewSetVersion: 1,
        characterViewKeys: ['front', 'back'],
        sceneAssetId: 10,
        scenePanoramaVersion: 3,
        sceneViewSetVersion: 2,
        sceneViewKey: 'front-right',
      }),
    },
  })

  assert.equal(report.passed, false)
  assert.ok(report.blockers.some((item) => item.code === 'character-view-angle-reference-incomplete'))
})

test('quality gate blocks missing prompt, asset image and voice binding', () => {
  const report = inspectStoryboardGenerationContext({
    storyboard: { id: 12, dialogueText: '陈默：别过来。' },
    assets: [{ id: 1, label: '时间裂缝', status: 'confirmed' }],
  })

  assert.equal(report.passed, false)
  assert.ok(report.blockers.some((item) => item.code === 'visual-prompt-missing'))
  assert.ok(report.blockers.some((item) => item.code === 'asset-image-missing'))
  assert.ok(report.blockers.some((item) => item.code === 'voice-binding-missing'))
})

test('quality gate passes confirmed assets with locked voice context', () => {
  const report = inspectStoryboardGenerationContext({
    storyboard: {
      id: 12,
      visualPrompt: '中景，陈默站在时间裂缝前，镜头缓慢推进',
      shotType: '中景',
      cameraAngle: '平视',
    },
    assets: [{ id: 1, label: '时间裂缝', status: 'confirmed', imageUrl: 'https://cdn.test/scene.png' }],
    characterVoices: [{ characterName: '陈默', voiceProfileKey: 'male-calm' }],
  })

  assert.equal(report.passed, true)
  assert.equal(report.blockers.length, 0)
})

test('quality gate warns when a single shot stacks too many visible action events', () => {
  const report = inspectStoryboardGenerationContext({
    storyboard: {
      id: 12,
      visualPrompt: '夜班值班台镜头',
      actionText: '发卡滑出，标签打印，林知夏抬头，随后望向走廊。',
      dialogueText: '（无对白）',
    },
  })

  assert.ok(report.warnings.some((item) => item.code === 'shot-action-overloaded'))
  assert.equal(report.passed, true)
})

test('quality gate treats no-dialogue placeholders as silence', () => {
  for (const dialogueText of ['（无对白）', '无对白', '无台词', 'no dialogue']) {
    const report = inspectStoryboardGenerationContext({
      storyboard: {
        id: 12,
        visualPrompt: '客厅全景，角色保持静默',
        dialogueText,
      },
    })

    assert.equal(report.passed, true, dialogueText)
    assert.equal(report.blockers.some((item) => item.code === 'voice-binding-missing'), false, dialogueText)
  }
})

test('quality gate does not require or validate voice bindings for a no-dialogue shot', () => {
  const report = inspectStoryboardGenerationContext({
    storyboard: {
      id: 12,
      visualPrompt: '中景，沈岚看向亮起的手机；声音：排风扇低鸣。',
      dialogueText: '（无对白）',
    },
    characterVoices: [{ characterName: '沈岚' }],
  })

  assert.equal(report.passed, true)
  assert.equal(report.blockers.some((item) => item.code === 'voice-binding-missing'), false)
})

test('quality gate can run in draft mode without blocking on candidate assets', () => {
  const report = inspectStoryboardGenerationContext({
    storyboard: { id: 12, visualPrompt: '远景，空旷车站' },
    assets: [{ id: 1, label: '车站', status: 'candidate' }],
    requireConfirmedAssets: false,
  })

  assert.equal(report.passed, true)
  assert.ok(report.warnings.some((item) => item.code === 'asset-not-confirmed'))
})

test('quality gate accepts a reference audio binding without a preset voice', () => {
  const report = inspectStoryboardGenerationContext({
    storyboard: { id: 12, visualPrompt: '近景，角色压低声音说话', dialogueText: '我在这里。' },
    characterVoices: [{ characterName: '陈默', referenceAudioUrl: 'https://cdn.test/reference.wav' }],
  })

  assert.equal(report.passed, true)
})

test('video result quality gate blocks a completed task without a usable media URL', () => {
  const report = inspectGeneratedVideoResult({
    items: [{ id: 1, status: 'candidate', videoUrl: '' }],
    expectedCandidateCount: 1,
  })

  assert.equal(report.passed, false)
  assert.ok(report.blockers.some((item) => item.code === 'video-result-missing'))
})

test('video result quality gate records a candidate shortage as a warning', () => {
  const report = inspectGeneratedVideoResult({
    items: [{ id: 1, status: 'candidate', videoUrl: 'https://cdn.test/clip.mp4' }],
    expectedCandidateCount: 2,
  })

  assert.equal(report.passed, true)
  assert.ok(report.warnings.some((item) => item.code === 'video-candidate-count-short'))
})
