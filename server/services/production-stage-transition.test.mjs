import assert from 'node:assert/strict'
import test from 'node:test'

import { PRODUCTION_RUN_STAGES } from './production-run.mjs'
import {
  buildProductionStageCompletionTransition,
} from './production-stage-transition.mjs'

test('completing emotion design unlocks candidate generation without asking for a fake checkpoint', () => {
  const transition = buildProductionStageCompletionTransition({
    run: {
      status: 'running',
      currentStage: 'emotion-design',
      currentCheckpoint: null,
    },
    stages: [
      { stageKey: 'emotion-design', status: 'ready' },
      { stageKey: 'candidate-generation', status: 'blocked' },
    ],
    checkpoints: [
      { checkpointKey: 'candidate-selection', stageKey: 'candidate-selection', status: 'blocked' },
    ],
    completedStageKey: 'emotion-design',
    outputSnapshot: { planVersion: 'emotion-design-v1' },
  })

  assert.equal(transition.run.status, 'running')
  assert.equal(transition.run.currentStage, 'candidate-generation')
  assert.equal(transition.run.currentCheckpoint, null)
  assert.equal(transition.stageUpdates[0].stageKey, 'emotion-design')
  assert.equal(transition.stageUpdates[0].status, 'completed')
  assert.equal(transition.stageUpdates[1].stageKey, 'candidate-generation')
  assert.equal(transition.stageUpdates[1].status, 'ready')
  assert.deepEqual(transition.stageUpdates[0].outputSnapshot, { planVersion: 'emotion-design-v1' })
})

test('completing candidate generation moves the run to the candidate selection checkpoint', () => {
  const transition = buildProductionStageCompletionTransition({
    run: {
      status: 'running',
      currentStage: 'candidate-generation',
      currentCheckpoint: null,
    },
    stages: [
      { stageKey: 'candidate-generation', status: 'running' },
      { stageKey: 'candidate-selection', status: 'blocked' },
    ],
    checkpoints: [
      { checkpointKey: 'candidate-selection', stageKey: 'candidate-selection', status: 'blocked' },
    ],
    completedStageKey: 'candidate-generation',
    outputSnapshot: { candidateCount: 30 },
  })

  assert.equal(transition.run.status, 'waiting_approval')
  assert.equal(transition.run.currentStage, 'candidate-selection')
  assert.equal(transition.run.currentCheckpoint, 'candidate-selection')
  assert.equal(transition.stageUpdates[1].status, 'waiting_approval')
  assert.deepEqual(transition.checkpointUpdates, [
    { checkpointKey: 'candidate-selection', status: 'pending' },
  ])
})

test('rejects completing a stage while an approval checkpoint is active', () => {
  assert.throws(
    () =>
      buildProductionStageCompletionTransition({
        run: {
          status: 'waiting_approval',
          currentStage: 'episode-blueprint',
          currentCheckpoint: 'blueprint',
        },
        stages: [{ stageKey: 'episode-blueprint', status: 'waiting_approval' }],
        checkpoints: [{ checkpointKey: 'blueprint', stageKey: 'episode-blueprint', status: 'pending' }],
        completedStageKey: 'episode-blueprint',
      }),
    /当前阶段存在待审批检查点/,
  )
})

test('does not allow completion of an unknown or non-current stage', () => {
  assert.throws(
    () =>
      buildProductionStageCompletionTransition({
        run: { status: 'running', currentStage: 'emotion-design', currentCheckpoint: null },
        stages: [{ stageKey: 'emotion-design', status: 'ready' }],
        checkpoints: [],
        completedStageKey: 'market-validation',
      }),
    /只能完成当前阶段/,
  )

  assert.equal(PRODUCTION_RUN_STAGES.some((stage) => stage.key === 'candidate-generation'), true)
})
