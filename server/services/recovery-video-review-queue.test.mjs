import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRecoveryVideoReviewQueue } from './recovery-video-review-queue.mjs'

test('prioritizes pending recovery reviews before rework and approved records', () => {
  const result = buildRecoveryVideoReviewQueue([
    {
      id: 104,
      storyboardId: 154,
      sceneId: 886,
      sceneNo: 1,
      shotNo: '04',
      versionNo: 4,
      status: 'candidate',
      inspectionStatus: 'ready',
      reviewDecision: 'approved',
      reviewChecklist: {
        visualReviewed: true,
        characterConsistencyReviewed: true,
        motionContinuityReviewed: true,
      },
      createdAt: '2026-09-16T10:00:00.000Z',
      reviewedAt: '2026-09-16T12:00:00.000Z',
    },
    {
      id: 103,
      storyboardId: 153,
      sceneId: 886,
      sceneNo: 1,
      shotNo: '03',
      versionNo: 4,
      status: 'candidate',
      reviewDecision: 'rework',
      reviewChecklist: {},
      createdAt: '2026-09-16T09:00:00.000Z',
      reviewedAt: '2026-09-16T11:00:00.000Z',
    },
    {
      id: 102,
      storyboardId: 152,
      sceneId: 886,
      sceneNo: 1,
      shotNo: '02',
      versionNo: 4,
      status: 'candidate',
      reviewDecision: null,
      reviewChecklist: {},
      createdAt: '2026-09-16T08:00:00.000Z',
    },
    {
      id: 101,
      storyboardId: 151,
      sceneId: 886,
      sceneNo: 1,
      shotNo: '01',
      versionNo: 4,
      status: 'candidate',
      reviewDecision: 'approved',
      reviewChecklist: {
        visualReviewed: true,
        characterConsistencyReviewed: false,
        motionContinuityReviewed: true,
      },
      createdAt: '2026-09-16T07:00:00.000Z',
    },
  ])

  assert.deepEqual(result.summary, {
    total: 4,
    pendingCount: 2,
    reworkCount: 1,
    approvedCount: 1,
    finalEditRequiredCount: 0,
    publishFormatReadyCount: 0,
    readyForFinalEditCount: 0,
    waitingManualReviewBeforeFinalEditCount: 0,
    finalEditBlockedCount: 4,
  })
  assert.deepEqual(
    result.items.map((item) => [item.id, item.reviewStatus, item.requiresReview]),
    [
      [101, 'pending', true],
      [102, 'pending', true],
      [103, 'rework', true],
      [104, 'approved', false],
    ],
  )
})

test('keeps an approved recovery review pending until every expected character is matched', () => {
  const result = buildRecoveryVideoReviewQueue([
    {
      id: 105,
      reviewDecision: 'approved',
      expectedCharacterIds: [21, 22],
      reviewChecklist: {
        visualReviewed: true,
        characterConsistencyReviewed: true,
        motionContinuityReviewed: true,
        characterChecks: [{ characterId: 21, decision: 'matched' }],
      },
      createdAt: '2026-09-16T13:00:00.000Z',
    },
    {
      id: 106,
      inspectionStatus: 'ready',
      reviewDecision: 'approved',
      expectedCharacterIds: [21, 22],
      reviewChecklist: {
        visualReviewed: true,
        characterConsistencyReviewed: true,
        motionContinuityReviewed: true,
        characterChecks: [
          { characterId: 21, decision: 'matched' },
          { characterId: 22, decision: 'matched' },
        ],
      },
      createdAt: '2026-09-16T14:00:00.000Z',
    },
  ])

  assert.deepEqual(
    result.items.map((item) => [item.id, item.reviewStatus, item.requiresReview]),
    [
      [105, 'pending', true],
      [106, 'approved', false],
    ],
  )
})

test('summarizes matched, rework, and pending checks for expected recovery characters', () => {
  const result = buildRecoveryVideoReviewQueue([
    {
      id: 107,
      reviewDecision: 'rework',
      expectedCharacterIds: [21, 22],
      reviewChecklist: {
        characterChecks: [
          { characterId: 21, decision: 'matched' },
          { characterId: 22, decision: 'rework' },
          { characterId: 99, decision: 'rework' },
        ],
      },
      createdAt: '2026-09-16T15:00:00.000Z',
    },
    {
      id: 108,
      reviewDecision: null,
      expectedCharacterIds: [21, 22],
      reviewChecklist: {
        characterChecks: [{ characterId: 21, decision: 'matched' }],
      },
      createdAt: '2026-09-16T16:00:00.000Z',
    },
  ])

  assert.deepEqual(
    result.items.map((item) => [item.id, item.characterReviewSummary]),
    [
      [108, { expectedCount: 2, matchedCount: 1, reworkCount: 0, pendingCount: 1 }],
      [107, { expectedCount: 2, matchedCount: 1, reworkCount: 1, pendingCount: 0 }],
    ],
  )
})

test('prioritizes technically ready recovery videos ahead of pending and blocked inspection work', () => {
  const result = buildRecoveryVideoReviewQueue([
    {
      id: 109,
      inspectionStatus: 'failed',
      inspectionBlockingCode: 'recovery-review-samples-incomplete',
      inspectionBlockingReason: 'COS 源视频不存在，无法抽帧检查',
      reviewDecision: null,
      reviewChecklist: {},
      createdAt: '2026-09-16T17:00:00.000Z',
    },
    {
      id: 110,
      inspectionStatus: 'ready',
      releaseReadiness: { status: 'needs-vertical-final-edit', canPublishDirectly: false },
      reviewDecision: null,
      reviewChecklist: {},
      createdAt: '2026-09-16T18:00:00.000Z',
    },
    {
      id: 111,
      inspectionStatus: null,
      reviewDecision: null,
      reviewChecklist: {},
      createdAt: '2026-09-16T16:00:00.000Z',
    },
  ])

  assert.deepEqual(
    result.items.map((item) => [
      item.id,
      item.inspectionReadiness,
      item.releaseReadiness.status,
      item.canPublishDirectly,
      item.inspectionBlockingReason || null,
      item.inspectionGuidance || null,
    ]),
    [
      [110, 'ready', 'needs-vertical-final-edit', false, null, null],
      [111, 'pending-inspection', 'needs-technical-check', false, null, '等待技术检查完成后再进行人工复核。'],
      [
        109,
        'blocked',
        'needs-technical-check',
        false,
        'COS 源视频不存在，无法抽帧检查',
        '查看候选详情，检查视频对象和抽帧；证据无法补齐时重新生成候选视频。',
      ],
    ],
  )
})

test('summarizes recovery candidates that still need vertical final edit before publishing', () => {
  const result = buildRecoveryVideoReviewQueue([
    {
      id: 114,
      inspectionStatus: 'ready',
      releaseReadiness: { status: 'needs-vertical-final-edit', canPublishDirectly: false },
      reviewDecision: null,
      reviewChecklist: {},
    },
    {
      id: 115,
      inspectionStatus: 'ready',
      releaseReadiness: { status: 'release-format-ready', canPublishDirectly: true },
      reviewDecision: null,
      reviewChecklist: {},
    },
  ])

  assert.equal(result.summary.finalEditRequiredCount, 1)
  assert.equal(result.summary.publishFormatReadyCount, 1)
})

test('exposes structured rework reasons and a regeneration action without opening final edit', () => {
  const result = buildRecoveryVideoReviewQueue([
    {
      id: 119,
      storyboardId: 184,
      sceneId: 888,
      inspectionStatus: 'ready',
      releaseReadiness: { status: 'needs-vertical-final-edit', canPublishDirectly: false },
      reviewDecision: 'rework',
      reviewNote: '动作中人物手部变形，需要重新生成候选。',
      expectedCharacterIds: [21],
      reviewChecklist: {
        visualReviewed: true,
        characterConsistencyReviewed: true,
        motionContinuityReviewed: true,
        characterChecks: [
          {
            characterId: 21,
            decision: 'rework',
            note: '发型和外套颜色与定妆参考不一致。',
          },
        ],
      },
    },
  ])

  const [item] = result.items
  assert.equal(item.finalEditReadiness.status, 'blocked-by-rework')
  assert.deepEqual(item.reworkReasons, [
    { scope: 'video', characterId: null, message: '动作中人物手部变形，需要重新生成候选。' },
    { scope: 'character', characterId: 21, message: '发型和外套颜色与定妆参考不一致。' },
  ])
  assert.deepEqual(item.nextAction, {
    code: 'regenerate-recovery-candidate',
    label: '重新生成候选',
    message: '当前候选已被人工标记返工；请回到视频生成页重新生成一条候选，完成后再重新复核。',
  })
})

test('separates vertical final edit candidates from items still waiting for manual review', () => {
  const result = buildRecoveryVideoReviewQueue([
    {
      id: 116,
      inspectionStatus: 'ready',
      releaseReadiness: { status: 'needs-vertical-final-edit', canPublishDirectly: false },
      reviewDecision: 'approved',
      expectedCharacterIds: [21],
      reviewChecklist: {
        visualReviewed: true,
        characterConsistencyReviewed: true,
        motionContinuityReviewed: true,
        characterChecks: [{ characterId: 21, decision: 'matched' }],
      },
      createdAt: '2026-09-16T21:00:00.000Z',
    },
    {
      id: 117,
      inspectionStatus: 'ready',
      releaseReadiness: { status: 'needs-vertical-final-edit', canPublishDirectly: false },
      reviewDecision: null,
      expectedCharacterIds: [21],
      reviewChecklist: { characterChecks: [] },
      createdAt: '2026-09-16T22:00:00.000Z',
    },
    {
      id: 118,
      inspectionStatus: 'failed',
      releaseReadiness: { status: 'needs-technical-check', canPublishDirectly: false },
      reviewDecision: null,
      reviewChecklist: {},
      createdAt: '2026-09-16T23:00:00.000Z',
    },
  ])

  assert.equal(result.summary.readyForFinalEditCount, 1)
  assert.equal(result.summary.waitingManualReviewBeforeFinalEditCount, 1)
  assert.equal(result.summary.finalEditBlockedCount, 1)
  assert.deepEqual(
    result.items.map((item) => [
      item.id,
      item.finalEditReadiness.status,
      item.finalEditReadiness.canStartFinalEdit,
    ]),
    [
      [117, 'waiting-manual-review', false],
      [118, 'needs-technical-check', false],
      [116, 'ready-for-final-edit', true],
    ],
  )
})

test('does not expose a technically blocked recovery video as manually reviewable or effectively approved', () => {
  const result = buildRecoveryVideoReviewQueue([
    {
      id: 112,
      inspectionStatus: 'failed',
      inspectionBlockingCode: 'recovery-video-metadata-missing',
      reviewDecision: 'approved',
      expectedCharacterIds: [21],
      reviewChecklist: {
        visualReviewed: true,
        characterConsistencyReviewed: true,
        motionContinuityReviewed: true,
        characterChecks: [{ characterId: 21, decision: 'matched' }],
      },
      createdAt: '2026-09-16T19:00:00.000Z',
    },
    {
      id: 113,
      inspectionStatus: 'ready',
      reviewDecision: 'approved',
      expectedCharacterIds: [21],
      reviewChecklist: {
        visualReviewed: true,
        characterConsistencyReviewed: true,
        motionContinuityReviewed: true,
        characterChecks: [{ characterId: 21, decision: 'matched' }],
      },
      createdAt: '2026-09-16T20:00:00.000Z',
    },
  ])

  assert.deepEqual(
    result.items.map((item) => [
      item.id,
      item.reviewStatus,
      item.canStartManualReview,
      item.requiresReview,
    ]),
    [
      [112, 'pending', false, true],
      [113, 'approved', true, false],
    ],
  )
})

test('rejects a non-array recovery review queue input', () => {
  assert.throws(() => buildRecoveryVideoReviewQueue({}), /must be an array/)
})
