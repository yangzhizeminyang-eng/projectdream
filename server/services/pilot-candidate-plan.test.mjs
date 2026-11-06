import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPilotCandidatePlan,
  normalizePilotCandidateInput,
  validatePilotCandidatePlan,
} from './pilot-candidate-plan.mjs'

test('builds a candidate-only plan for the two golden-sample scenes', () => {
  const plan = buildPilotCandidatePlan({
    candidatePolicy: {
      keyShotVideoCandidates: 3,
      normalShotVideoCandidates: 2,
      imageCandidates: 3,
      audioCandidates: 2,
    },
  })

  assert.equal(plan.sceneKeys.length, 2)
  assert.equal(plan.shots.length, 15)
  assert.equal(plan.shots.every((shot) => shot.autoConfirm === false), true)
  assert.equal(plan.shots.every((shot) => shot.requiresHumanSelection === true), true)
  assert.equal(plan.shots.some((shot) => shot.dialogueText.includes('六。别怕，小夏。')), true)
  assert.equal(plan.shots.some((shot) => shot.dialogueText.includes('苏岚（广播）：四。')), true)
  assert.equal(plan.shots.some((shot) => shot.dialogueText.includes('苏岚（广播）：五')), false)
  assert.equal(plan.shots.find((shot) => shot.shotNo === '13')?.audioCharacterId, 20)
})

test('applies higher video candidate count to key shots and keeps silent shots audio-free', () => {
  const plan = buildPilotCandidatePlan({
    sceneKeys: ['scene-two-memory-hit'],
    candidatePolicy: {
      keyShotVideoCandidates: 3,
      normalShotVideoCandidates: 1,
      imageCandidates: 2,
      audioCandidates: 2,
    },
  })

  const keyShot = plan.shots.find((shot) => shot.shotNo === '20')
  const silentShot = plan.shots.find((shot) => shot.shotNo === '15')
  assert.equal(keyShot.videoCandidateCount, 3)
  assert.equal(keyShot.audioCandidateCount, 2)
  assert.equal(silentShot.videoCandidateCount, 1)
  assert.equal(silentShot.audioCandidateCount, 0)
})

test('rejects a plan that tries to auto-confirm or includes forbidden broadcast five', () => {
  const plan = buildPilotCandidatePlan({
    sceneKeys: ['scene-two-memory-hit'],
  })
  plan.shots[0].autoConfirm = true
  plan.shots[0].dialogueText = '苏岚（广播）：五。'

  const report = validatePilotCandidatePlan(plan)
  assert.equal(report.valid, false)
  assert.equal(report.errors.some((error) => error.includes('autoConfirm')), true)
  assert.equal(report.errors.some((error) => error.includes('五')), true)
})

test('normalizes a controlled pilot input without allowing an empty scene set', () => {
  assert.deepEqual(
    normalizePilotCandidateInput({
      runId: 2,
      projectId: 12,
      sceneKeys: ['scene-one-broadcast-awakening'],
      apply: true,
    }),
    {
      runId: 2,
      projectId: 12,
      sceneKeys: ['scene-one-broadcast-awakening'],
      apply: true,
      confirmation: 'RUN_PILOT_CANDIDATES',
    },
  )

  assert.throws(
    () => normalizePilotCandidateInput({ runId: 2, projectId: 12, sceneKeys: [] }),
    /至少选择一个验证场景/,
  )
})
