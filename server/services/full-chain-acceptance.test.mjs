import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildFullChainAcceptancePlan,
  evaluateFullChainAcceptance,
} from './full-chain-acceptance.mjs'

function makeShot(overrides = {}) {
  return {
    storyboardId: 101,
    shotNo: '01',
    characterId: 7,
    characterReference: { confirmed: true, real: true, versionNo: 3 },
    sceneReference: { confirmed: true, real: true, viewKey: 'front', viewSetVersion: 2 },
    image: { confirmed: true, real: true, visionPassed: true, id: 201 },
    video: { confirmed: true, real: true, playable: true, id: 301 },
    dialogue: { required: true, measurable: true, audioAssetId: 401 },
    lipSync: { required: true, confirmed: true, audioAssetId: 401, videoAssetId: 302 },
    ...overrides,
  }
}

test('builds an ordered full-chain plan with hard per-shot gates', () => {
  const plan = buildFullChainAcceptancePlan({
    projectId: 50,
    aspectRatio: '9:16',
    shots: [makeShot()],
  })

  assert.deepEqual(plan.stages, [
    'story-lock',
    'asset-lock',
    'frame-selection',
    'video-selection',
    'audio-binding',
    'lip-sync',
    'final-export',
  ])
  assert.equal(plan.shots[0].storyboardId, 101)
  assert.equal(plan.shots[0].requiredEvidence.length > 0, true)
})

test('blocks a shot when a real scene view or lip-sync audio binding is missing', () => {
  const result = evaluateFullChainAcceptance({
    plan: buildFullChainAcceptancePlan({ shots: [makeShot({
      sceneReference: { confirmed: true, real: false, viewKey: 'front' },
      lipSync: { required: true, confirmed: true, audioAssetId: 999, videoAssetId: 302 },
      dialogue: { required: true, measurable: true, audioAssetId: 401 },
    })] }),
    evidence: {
      storyLocked: true,
      export: { technicalPassed: true },
    },
  })

  assert.equal(result.passed, false)
  assert.deepEqual(result.blockers.map((item) => item.code), [
    'scene-reference-not-real',
    'lip-sync-audio-mismatch',
  ])
})

test('does not require lip-sync for a silent or off-camera shot', () => {
  const result = evaluateFullChainAcceptance({
    plan: buildFullChainAcceptancePlan({
      shots: [makeShot({
        characterId: null,
        dialogue: { required: false },
        lipSync: { required: false },
      })],
    }),
    evidence: {
      storyLocked: true,
      export: { technicalPassed: true },
    },
  })

  assert.equal(result.passed, true)
  assert.equal(result.blockers.length, 0)
})

test('never treats mock media as real production evidence', () => {
  const result = evaluateFullChainAcceptance({
    plan: buildFullChainAcceptancePlan({ shots: [makeShot({
      image: { confirmed: true, real: false, visionPassed: true, id: 201 },
      video: { confirmed: true, real: false, playable: true, id: 301 },
    })] }),
    evidence: { storyLocked: true, export: { technicalPassed: true } },
  })

  assert.equal(result.passed, false)
  assert.deepEqual(result.blockers.map((item) => item.code), [
    'image-not-real',
    'video-not-real',
  ])
})
