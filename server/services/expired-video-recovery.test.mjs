import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildExpiredVideoRecoveryPrompt,
  buildExpiredVideoRecoveryRequest,
  buildExpiredVideoRecoveryJobKey,
  classifyExpiredVideoRecoverySource,
  decideExpiredVideoRecovery,
  normalizeExpiredVideoRecoveryReview,
  strengthenExpiredVideoRecoveryPrompt,
  shouldRequireExpiredVideoRecoveryReview,
} from './expired-video-recovery.mjs'

test('adds strict no-person constraints when a recovery start frame is character-free', () => {
  const prompt = buildExpiredVideoRecoveryPrompt({
    startVisualPrompt: '夜晚的空站台，雨水沿着轨道反光。',
    endVisualPrompt: '镜头缓慢推进到远处站牌。',
    characterSnapshot: JSON.stringify({ characterFree: true, characters: [] }),
  })

  assert.match(prompt, /保持空景/)
  assert.match(prompt, /禁止新增任何人、脸、人体轮廓、倒影、影子/)
  assert.match(prompt, /Keep the scene empty/)
  assert.match(prompt, /Do not add people, faces, human silhouettes, reflections, or shadows/)
})

test('does not apply character-free restrictions to a recovery frame with characters', () => {
  const prompt = buildExpiredVideoRecoveryPrompt({
    startVisualPrompt: '少女站在站台边缘。',
    characterSnapshot: { characterFree: false, characters: [{ characterId: 7 }] },
  })

  assert.match(prompt, /不新增人物/)
  assert.doesNotMatch(prompt, /保持空景/)
  assert.doesNotMatch(prompt, /Keep the scene empty/)
})

test('only strengthens character-free recovery prompts and does not duplicate the constraint', () => {
  const original = '镜头停留在空站台。 视频从起始帧构图和人物状态自然发展，不切镜头，不新增人物。'
  const strengthened = strengthenExpiredVideoRecoveryPrompt({
    promptSnapshot: original,
    characterSnapshot: { characterFree: true },
  })

  assert.match(strengthened, /保持空景/)
  assert.equal(
    strengthenExpiredVideoRecoveryPrompt({
      promptSnapshot: strengthened,
      characterSnapshot: { characterFree: true },
    }),
    strengthened,
  )
  assert.equal(
    strengthenExpiredVideoRecoveryPrompt({
      promptSnapshot: original,
      characterSnapshot: { characterFree: false },
    }),
    original,
  )
})

test('builds a stable recovery job key for the same project and storyboard', () => {
  assert.equal(
    buildExpiredVideoRecoveryJobKey({
      projectId: 12,
      storyboardId: 168,
      retryNumber: 2,
    }),
    'recover-video-project-12-storyboard-168-retry-2',
  )
})

test('does not queue another recovery while one is active', () => {
  assert.deepEqual(
    decideExpiredVideoRecovery({
      projectId: 12,
      storyboardId: 168,
      existingJobs: [{ status: 'canceled' }, { status: 'queued' }],
    }),
    {
      action: 'skip',
      reason: 'recovery-job-active',
    },
  )
})

test('does not queue again after a successful recovery or a fresh confirmed video', () => {
  assert.deepEqual(
    decideExpiredVideoRecovery({
      projectId: 12,
      storyboardId: 168,
      existingJobs: [{ status: 'success' }],
    }),
    {
      action: 'skip',
      reason: 'recovery-job-succeeded',
    },
  )

  assert.deepEqual(
    decideExpiredVideoRecovery({
      projectId: 12,
      storyboardId: 168,
      hasFreshConfirmedVideo: true,
    }),
    {
      action: 'skip',
      reason: 'fresh-confirmed-video-exists',
    },
  )
})

test('increments retry number after a canceled recovery and stops at the retry limit', () => {
  assert.deepEqual(
    decideExpiredVideoRecovery({
      projectId: 12,
      storyboardId: 168,
      existingJobs: [{ status: 'canceled' }],
    }),
    {
      action: 'queue',
      retryNumber: 2,
      jobKey: 'recover-video-project-12-storyboard-168-retry-2',
    },
  )

  assert.deepEqual(
    decideExpiredVideoRecovery({
      projectId: 12,
      storyboardId: 168,
      existingJobs: [
        { status: 'canceled' },
        { status: 'failed' },
        { status: 'canceled' },
      ],
      maxRecoveryAttempts: 3,
    }),
    {
      action: 'skip',
      reason: 'recovery-attempt-limit',
    },
  )
})

test('keeps public source images eligible while public-only mode pauses local source images', () => {
  assert.deepEqual(
    classifyExpiredVideoRecoverySource({
      imageUrl: 'https://platform-outputs.agnes-ai.space/images/t2i/example.png',
      sourceMode: 'public-only',
    }),
    {
      action: 'queue',
      sourceKind: 'public',
    },
  )

  assert.deepEqual(
    classifyExpiredVideoRecoverySource({
      imageUrl: 'http://127.0.0.1:3001/storage/projects/12/frames/storyboards/168/v1/c159.png',
      sourceMode: 'public-only',
    }),
    {
      action: 'skip',
      reason: 'local-source-requires-public-upload',
      sourceKind: 'local',
    },
  )
})

test('does not treat non-http image sources as public provider inputs', () => {
  assert.deepEqual(
    classifyExpiredVideoRecoverySource({
      imageUrl: 'ftp://platform-outputs.agnes-ai.space/images/example.png',
      sourceMode: 'public-only',
    }),
    {
      action: 'skip',
      reason: 'unsupported-image-source-protocol',
      sourceKind: 'invalid',
    },
  )
})

test('keeps the stored start-frame key in a recovery request for object storage persistence', () => {
  assert.deepEqual(
    buildExpiredVideoRecoveryRequest({
      projectId: 12,
      storyboardId: 151,
      imageAssetId: 133,
      imageStorageKey: 'projects/12/frames/storyboards/151/v1/c133.png',
      imageUrl: 'https://platform-outputs.agnes-ai.space/images/t2i/example.png',
      versionNo: 4,
      motionMode: 'PAN',
      durationSeconds: 5,
      modelName: 'agnes-video-v2.0',
      promptSnapshot: 'keep character identity',
    }),
    {
      projectId: 12,
      storyboardId: 151,
      imageAssetId: 133,
      imageStorageKey: 'projects/12/frames/storyboards/151/v1/c133.png',
      imageUrl: 'https://platform-outputs.agnes-ai.space/images/t2i/example.png',
      versionNo: 4,
      motionMode: 'PAN',
      durationSeconds: 5,
      candidateCount: 1,
      modelName: 'agnes-video-v2.0',
      promptSnapshot: 'keep character identity',
      providerTasks: [],
      autoConfirm: false,
    },
  )
})

test('requires manual review for legacy recovery videos that were auto-confirmed', () => {
  assert.equal(
    shouldRequireExpiredVideoRecoveryReview({
      jobKey: 'recover-video-project-12-storyboard-151-retry-3',
      status: 'confirmed',
      request: { autoConfirm: true },
    }),
    true,
  )
  assert.equal(
    shouldRequireExpiredVideoRecoveryReview({
      jobKey: 'recover-video-project-12-storyboard-151-retry-3',
      status: 'candidate',
      request: { autoConfirm: false },
    }),
    false,
  )
  assert.equal(
    shouldRequireExpiredVideoRecoveryReview({
      jobKey: 'video_image-151-random',
      status: 'confirmed',
      request: { autoConfirm: true },
    }),
    false,
  )
})

test('requires all recovery review checks before an approved decision', () => {
  assert.throws(
    () =>
      normalizeExpiredVideoRecoveryReview({
        decision: 'approved',
        checklist: {
          visualReviewed: true,
          characterConsistencyReviewed: true,
          motionContinuityReviewed: false,
        },
      }),
    /动作连续性/,
  )

  assert.deepEqual(
    normalizeExpiredVideoRecoveryReview({
      decision: 'approved',
      checklist: {
        visualReviewed: true,
        characterConsistencyReviewed: true,
        motionContinuityReviewed: true,
      },
      note: '人物外观和动作收尾已复核。',
    }),
    {
      decision: 'approved',
      checklist: {
        visualReviewed: true,
        characterConsistencyReviewed: true,
        motionContinuityReviewed: true,
      },
      note: '人物外观和动作收尾已复核。',
    },
  )
})

test('requires an approved review to mark every expected character as matched', () => {
  assert.throws(
    () =>
      normalizeExpiredVideoRecoveryReview(
        {
          decision: 'approved',
          checklist: {
            visualReviewed: true,
            characterConsistencyReviewed: true,
            motionContinuityReviewed: true,
          },
          characterChecks: [
            { characterId: 31, decision: 'matched' },
          ],
        },
        {
          expectedCharacters: [{ characterId: 31, name: '林夏' }, { characterId: 32, name: '周衡' }],
        },
      ),
    /周衡/,
  )
})

test('keeps a per-character rework reason in the normalized review evidence', () => {
  assert.deepEqual(
    normalizeExpiredVideoRecoveryReview(
      {
        decision: 'rework',
        checklist: {
          visualReviewed: true,
          characterConsistencyReviewed: false,
          motionContinuityReviewed: true,
        },
        characterChecks: [
          { characterId: 31, decision: 'matched' },
          { characterId: 32, decision: 'rework', note: '服装颜色与定妆参考不一致。' },
        ],
      },
      {
        expectedCharacters: [
          { characterId: 31, name: '林夏' },
          { characterId: 32, name: '周衡' },
        ],
      },
    ),
    {
      decision: 'rework',
      checklist: {
        visualReviewed: true,
        characterConsistencyReviewed: false,
        motionContinuityReviewed: true,
        characterChecks: [
          { characterId: 31, decision: 'matched', note: null },
          { characterId: 32, decision: 'rework', note: '服装颜色与定妆参考不一致。' },
        ],
      },
      note: null,
    },
  )
})

test('accepts character checks nested in the checklist payload used by the video review page', () => {
  assert.deepEqual(
    normalizeExpiredVideoRecoveryReview(
      {
        decision: 'rework',
        checklist: {
          visualReviewed: true,
          characterConsistencyReviewed: true,
          motionContinuityReviewed: true,
          characterChecks: [
            {
              characterId: 31,
              decision: 'matched',
              note: '三张抽帧中的人物外貌和服装连续。',
            },
          ],
        },
        note: '横版素材需要进入竖屏终剪。',
      },
      {
        expectedCharacters: [{ characterId: 31, name: '林夏' }],
      },
    ),
    {
      decision: 'rework',
      checklist: {
        visualReviewed: true,
        characterConsistencyReviewed: true,
        motionContinuityReviewed: true,
        characterChecks: [
          {
            characterId: 31,
            decision: 'matched',
            note: '三张抽帧中的人物外貌和服装连续。',
          },
        ],
      },
      note: '横版素材需要进入竖屏终剪。',
    },
  )
})

test('keeps a rework decision auditable without pretending it is approved', () => {
  assert.deepEqual(
    normalizeExpiredVideoRecoveryReview({
      decision: 'rework',
      checklist: {
        visualReviewed: true,
        characterConsistencyReviewed: false,
        motionContinuityReviewed: false,
      },
      note: '人物服装与起始帧不一致，需要重新生成。',
    }),
    {
      decision: 'rework',
      checklist: {
        visualReviewed: true,
        characterConsistencyReviewed: false,
        motionContinuityReviewed: false,
      },
      note: '人物服装与起始帧不一致，需要重新生成。',
    },
  )
})
