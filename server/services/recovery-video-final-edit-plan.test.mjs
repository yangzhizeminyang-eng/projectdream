import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRecoveryVideoFinalEditPlan } from './recovery-video-final-edit-plan.mjs'

test('builds a controlled vertical final edit plan for an approved recovery candidate', () => {
  const plan = buildRecoveryVideoFinalEditPlan({
    videoId: 194,
    storyboardId: 183,
    sceneId: 887,
    sceneNo: 2,
    shotNo: '03',
    durationSeconds: 5.1,
    finalEditReadiness: {
      status: 'ready-for-final-edit',
      canStartFinalEdit: true,
      message: '已通过自动技术检查和人工复核，可进入终剪。',
    },
  })

  assert.deepEqual(plan, {
    planId: 'recovery-final-edit-video-194',
    videoId: 194,
    storyboardId: 183,
    sceneId: 887,
    sceneNo: 2,
    shotNo: '03',
    durationSeconds: 5.1,
    status: 'ready',
    canStart: true,
    executionMode: 'manual-gate',
    target: {
      templateId: 'vertical-1080x1920-v1',
      aspectRatio: '9:16',
      width: 1080,
      height: 1920,
      frameRate: 24,
      videoCodec: 'h264',
      audioCodec: 'aac',
      container: 'mp4',
      burnSubtitle: true,
    },
    blockers: [],
  })
})

test('keeps a recovery final edit plan blocked until manual review is complete', () => {
  const plan = buildRecoveryVideoFinalEditPlan({
    videoId: 193,
    storyboardId: 180,
    sceneId: 886,
    finalEditReadiness: {
      status: 'waiting-manual-review',
      canStartFinalEdit: false,
      message: '先完成人工复核。',
    },
  })

  assert.equal(plan.status, 'blocked')
  assert.equal(plan.canStart, false)
  assert.equal(plan.executionMode, 'manual-gate')
  assert.deepEqual(plan.blockers, [{
    code: 'manual-review-incomplete',
    message: '先完成人工画面、人物一致性和动作连续性复核，再进入竖屏终剪。',
  }])
})

test('does not create an executable plan for technically blocked or already publish-ready candidates', () => {
  const technicalPlan = buildRecoveryVideoFinalEditPlan({
    videoId: 187,
    finalEditReadiness: {
      status: 'needs-technical-check',
      canStartFinalEdit: false,
      message: '先完成自动技术检查。',
    },
  })
  const publishReadyPlan = buildRecoveryVideoFinalEditPlan({
    videoId: 201,
    finalEditReadiness: {
      status: 'not-required',
      canStartFinalEdit: false,
      message: '无需终剪。',
    },
  })

  assert.equal(technicalPlan.blockers[0].code, 'technical-check-incomplete')
  assert.equal(publishReadyPlan.blockers[0].code, 'final-edit-not-required')
  assert.equal(technicalPlan.canStart, false)
  assert.equal(publishReadyPlan.canStart, false)
})

test('rejects a final edit plan without a positive video id', () => {
  assert.throws(
    () => buildRecoveryVideoFinalEditPlan({
      finalEditReadiness: {
        status: 'ready-for-final-edit',
        canStartFinalEdit: true,
      },
    }),
    /videoId must be a positive integer/,
  )
})
