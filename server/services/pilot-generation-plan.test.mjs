import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPilotCandidatePlan } from './pilot-candidate-plan.mjs'
import {
  buildPilotGenerationPlan,
  validatePilotGenerationPlan,
} from './pilot-generation-plan.mjs'

test('builds a candidate-only generation order with image selection before video', () => {
  const candidatePlan = buildPilotCandidatePlan({
    sceneKeys: ['scene-two-memory-hit'],
    candidatePolicy: {
      keyShotVideoCandidates: 3,
      normalShotVideoCandidates: 2,
      imageCandidates: 3,
      audioCandidates: 2,
    },
  })
  const plan = buildPilotGenerationPlan({ candidatePlan })

  assert.deepEqual(plan.stages, ['images', 'selection', 'videos', 'audio', 'selection'])
  assert.equal(plan.jobs.length, 10)
  assert.equal(plan.jobs.every((job) => job.image.autoConfirm === false), true)
  assert.equal(plan.jobs.every((job) => job.video.autoConfirm === false), true)
  assert.equal(plan.jobs.every((job) => job.video.modelName === 'agnes-video-2.5-flash'), true)
  assert.equal(plan.jobs.find((job) => job.shotKey === 's2-10')?.audio, null)
  assert.equal(validatePilotGenerationPlan(plan).valid, true)
})

test('rejects a generation plan that bypasses candidate review', () => {
  const plan = buildPilotGenerationPlan({
    candidatePlan: buildPilotCandidatePlan({
      sceneKeys: ['scene-one-broadcast-awakening'],
    }),
  })
  plan.jobs[0].video.autoConfirm = true

  const report = validatePilotGenerationPlan(plan)
  assert.equal(report.valid, false)
  assert.match(report.errors.join('\n'), /不能自动确认/)
})
