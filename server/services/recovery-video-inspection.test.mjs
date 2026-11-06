import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRecoveryVideoInspectionReport,
  resolveRecoveryReleaseReadiness,
  isRecoveryVideoInspectionReady,
  resolveRecoveryCharacterChecklist,
  resolveRecoveryManualFocus,
} from './recovery-video-inspection.mjs'

test('marks a sampled recovery video ready while flagging a landscape source for vertical final edit', () => {
  const report = buildRecoveryVideoInspectionReport({
    media: {
      width: 1920,
      height: 1088,
      frameRate: 30,
      durationSeconds: 5.1,
      videoCodec: 'h264',
      audioCodec: 'aac',
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    },
    expectedDurationSeconds: 5,
    characterFree: true,
    sampleFrames: [
      { second: 0.5, storageKey: 'projects/12/videos/storyboards/180/v2/review/c1-s1.jpg' },
      { second: 2.5, storageKey: 'projects/12/videos/storyboards/180/v2/review/c1-s2.jpg' },
      { second: 4.5, storageKey: 'projects/12/videos/storyboards/180/v2/review/c1-s3.jpg' },
    ],
  })

  assert.equal(report.status, 'ready')
  assert.equal(isRecoveryVideoInspectionReady(report), true)
  assert.ok(report.warnings.some((item) => item.code === 'requires-vertical-final-edit'))
  assert.ok(report.manualFocus.some((item) => /空景/.test(item)))
  assert.deepEqual(resolveRecoveryReleaseReadiness(report), {
    status: 'needs-vertical-final-edit',
    canPublishDirectly: false,
    message: '候选视频仍需进入 1080x1920 / 24fps 竖屏终剪，不能直接发布到平台。',
    blockingIssues: [{
      code: 'invalid-vertical-resolution',
      message: '成片规格为 1920x1088，必须是 1080x1920 的竖屏视频。',
    }, {
      code: 'invalid-frame-rate',
      message: '成片帧率为 30fps，必须是 24fps。',
    }],
  })
})

test('marks only the formal vertical export profile as directly publishable', () => {
  const report = buildRecoveryVideoInspectionReport({
    media: {
      width: 1080,
      height: 1920,
      frameRate: 24,
      durationSeconds: 5,
      videoCodec: 'h264',
      audioCodec: 'aac',
      formatName: 'mp4',
    },
    sampleFrames: [
      { second: 0.5, storageKey: 'projects/12/videos/storyboards/180/v2/review/c1-s1.jpg' },
      { second: 2.5, storageKey: 'projects/12/videos/storyboards/180/v2/review/c1-s2.jpg' },
      { second: 4.5, storageKey: 'projects/12/videos/storyboards/180/v2/review/c1-s3.jpg' },
    ],
  })

  assert.deepEqual(resolveRecoveryReleaseReadiness(report), {
    status: 'release-format-ready',
    canPublishDirectly: true,
    message: '候选视频符合 1080x1920 / 24fps / H.264 + AAC / MP4 发布技术规格。',
    blockingIssues: [],
  })
})

test('does not mark a recovery video ready without valid media metadata and three samples', () => {
  const report = buildRecoveryVideoInspectionReport({
    media: { width: 0, height: 0, videoCodec: '', formatName: '' },
    sampleFrames: [{ second: 0.5, storageKey: 'projects/12/videos/storyboards/180/v2/review/c1-s1.jpg' }],
  })

  assert.equal(report.status, 'failed')
  assert.equal(isRecoveryVideoInspectionReady(report), false)
  assert.ok(report.blockingIssues.some((item) => item.code === 'recovery-video-metadata-missing'))
  assert.ok(report.blockingIssues.some((item) => item.code === 'recovery-review-samples-incomplete'))
})

test('does not accept repeated storage keys as three independent recovery review samples', () => {
  const sample = {
    second: 0.5,
    storageKey: 'projects/12/videos/storyboards/180/v2/review/c1-s1.jpg',
  }
  const report = buildRecoveryVideoInspectionReport({
    media: {
      width: 1080,
      height: 1920,
      durationSeconds: 5,
      videoCodec: 'h264',
      formatName: 'mp4',
    },
    sampleFrames: [sample, sample, sample],
  })

  assert.equal(report.status, 'failed')
  assert.equal(isRecoveryVideoInspectionReady(report), false)
  assert.ok(report.blockingIssues.some((item) => item.code === 'recovery-review-samples-incomplete'))
})

test('does not trust a ready label when the persisted inspection evidence is incomplete', () => {
  assert.equal(
    isRecoveryVideoInspectionReady({
      status: 'ready',
      media: {},
      sampleFrames: [
        { second: 0.5, storageKey: 'projects/12/videos/storyboards/180/v2/review/c1-s1.jpg' },
        { second: 2.5, storageKey: 'projects/12/videos/storyboards/180/v2/review/c1-s2.jpg' },
        { second: 4.5, storageKey: 'projects/12/videos/storyboards/180/v2/review/c1-s3.jpg' },
      ],
    }),
    false,
  )
})

test('adds a versioned per-character review checklist from the recovery source snapshot', () => {
  const report = buildRecoveryVideoInspectionReport({
    media: {
      width: 1080,
      height: 1920,
      durationSeconds: 5,
      videoCodec: 'h264',
      formatName: 'mp4',
    },
    characterSnapshot: {
      characterFree: false,
      characters: [{
        characterId: 31,
        characterVersionNo: 4,
        name: '苏岚',
        appearance: '短黑发，左耳银色助听器',
        costume: '深灰风衣，红色录音笔',
        referenceImageStorageKey: 'projects/12/frames/characters/31/reference.jpg',
        isPrimary: true,
      }],
    },
    sampleFrames: [
      { second: 0.5, storageKey: 'projects/12/videos/storyboards/180/v2/review/c1-s1.jpg' },
      { second: 2.5, storageKey: 'projects/12/videos/storyboards/180/v2/review/c1-s2.jpg' },
      { second: 4.5, storageKey: 'projects/12/videos/storyboards/180/v2/review/c1-s3.jpg' },
    ],
  })

  assert.deepEqual(report.characterChecklist, [{
    characterId: 31,
    versionNo: 4,
    name: '苏岚',
    appearance: '短黑发，左耳银色助听器',
    costume: '深灰风衣，红色录音笔',
    referenceImageStorageKey: 'projects/12/frames/characters/31/reference.jpg',
    referenceImageUrl: null,
    isPrimary: true,
  }])
})

test('falls back to the source snapshot when a historical inspection has no character checklist', () => {
  const checklist = resolveRecoveryCharacterChecklist(
    { status: 'failed', characterChecklist: [] },
    {
      characters: [{
        characterId: 31,
        characterVersionNo: 4,
        name: '苏岚',
        appearance: '短黑发，左耳银色助听器',
        costume: '深灰风衣，红色录音笔',
        referenceImageStorageKey: 'projects/12/frames/characters/31/reference.jpg',
        isPrimary: true,
      }],
    },
  )

  assert.equal(checklist.length, 1)
  assert.equal(checklist[0].name, '苏岚')
  assert.equal(checklist[0].versionNo, 4)
})

test('adds the per-character manual focus to a historical inspection report', () => {
  const focus = resolveRecoveryManualFocus(
    {
      manualFocus: ['对照起始帧检查人物脸部、服装、发型和主体数量是否保持一致。'],
    },
    {
      characters: [{ characterId: 31, name: '苏岚' }],
    },
  )

  assert.ok(focus.some((item) => /逐人按角色版本/.test(item)))
  assert.equal(
    focus.filter((item) => /对照起始帧检查人物脸部/.test(item)).length,
    1,
  )
})
