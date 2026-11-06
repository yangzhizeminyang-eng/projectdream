import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  buildMediaMigrationPlan,
  resolveLegacyMediaSource,
  summarizeMediaMigrationPlans,
} from './media-migration.mjs'

const roots = {
  frame: path.join('D:', 'runtime', 'generated-frames'),
  audio: path.join('D:', 'runtime', 'generated-audio'),
  audioLibrary: path.join('D:', 'runtime', 'audio-library'),
  video: path.join('D:', 'runtime', 'generated-videos'),
  export: path.join('D:', 'runtime', 'exports'),
}

test('resolves supported legacy generated URLs to safe local files', () => {
  assert.deepEqual(
    resolveLegacyMediaSource({
      url: 'http://127.0.0.1:3001/generated/frame/shot-12-v2-c1.png',
      roots,
    }),
    {
      sourceKind: 'local',
      sourcePath: path.join(roots.frame, 'shot-12-v2-c1.png'),
      extension: '.png',
    },
  )

  assert.deepEqual(
    resolveLegacyMediaSource({
      url: 'http://localhost:3001/generated/export/77',
      roots,
    }),
    {
      sourceKind: 'local',
      sourcePath: path.join(roots.export, 'export-77.mp4'),
      extension: '.mp4',
    },
  )

  assert.deepEqual(
    resolveLegacyMediaSource({
      url: 'http://localhost:3001/generated/export/77/subtitles.srt',
      roots,
    }),
    {
      sourceKind: 'local',
      sourcePath: path.join(roots.export, '77', 'subtitles.srt'),
      extension: '.srt',
    },
  )
})

test('rejects remote, mock, and traversal-like legacy URLs without producing a local path', () => {
  assert.equal(
    resolveLegacyMediaSource({
      url: 'https://provider.example/video.mp4',
      roots,
    }).reason,
    'remote-source-not-local',
  )
  assert.equal(
    resolveLegacyMediaSource({
      url: 'http://127.0.0.1:3001/mock/image/1/1/1.svg',
      roots,
    }).reason,
    'unsupported-media-url',
  )
  assert.equal(
    resolveLegacyMediaSource({
      url: 'http://127.0.0.1:3001/generated/frame/%2e%2e%2fsecret.png',
      roots,
    }).reason,
    'unsupported-media-url',
  )
})

test('builds deterministic plans and skips records that already have a storage key', () => {
  const plans = buildMediaMigrationPlan({
    roots,
    records: [
      {
        type: 'image_asset',
        id: 21,
        projectId: 12,
        storyboardId: 44,
        versionNo: 3,
        url: 'http://127.0.0.1:3001/generated/frame/shot-44-v3-c1.png',
      },
      {
        type: 'video_asset',
        id: 22,
        projectId: 12,
        storyboardId: 44,
        versionNo: 4,
        url: 'http://127.0.0.1:3001/generated/video/storyboard-44-v4-c1.mp4',
        storageKey: 'projects/12/videos/storyboards/44/v4/c1.mp4',
      },
      {
        type: 'audio_asset',
        id: 23,
        projectId: 12,
        trackType: 'dialogue',
        versionNo: 2,
        url: 'http://127.0.0.1:3001/generated/audio/audio-12-dialogue-v2-c1.wav',
      },
      {
        type: 'export_record',
        id: 24,
        projectId: 12,
        url: 'http://127.0.0.1:3001/generated/export/24',
      },
    ],
  })

  assert.equal(plans[0].action, 'migrate')
  assert.equal(plans[0].storageKey, 'projects/12/frames/storyboards/44/v3/c21.png')
  assert.equal(plans[1].action, 'skip')
  assert.equal(plans[1].reason, 'already-has-storage-key')
  assert.equal(plans[2].storageKey, 'projects/12/generated-audio/dialogue/v2/c23.wav')
  assert.equal(plans[3].storageKey, 'projects/12/exports/24/final.mp4')
})

test('uses an existing linked character image key for a legacy character reference', () => {
  const [plan] = buildMediaMigrationPlan({
    roots,
    records: [
      {
        type: 'character_reference',
        id: 9,
        projectId: 12,
        characterId: 31,
        versionNo: 2,
        url: 'http://127.0.0.1:3001/generated/frame/character-31-v2-c1.png',
        preferredStorageKey: 'projects/12/frames/characters/31/v2/c1.png',
      },
    ],
  })

  assert.equal(plan.action, 'link')
  assert.equal(plan.storageKey, 'projects/12/frames/characters/31/v2/c1.png')
  assert.equal(plan.sourcePath, path.join(roots.frame, 'character-31-v2-c1.png'))
})

test('marks remote or unsupported records as unresolved without inventing a key', () => {
  const plans = buildMediaMigrationPlan({
    roots,
    remote: { now: 1_800_000_000 },
    records: [
      {
        type: 'video_asset',
        id: 71,
        projectId: 12,
        storyboardId: 44,
        versionNo: 1,
        url: 'https://provider.example/expired.mp4',
      },
      {
        type: 'image_asset',
        id: 72,
        projectId: 12,
        storyboardId: 44,
        versionNo: 1,
        url: 'http://127.0.0.1:3001/mock/image/44/1/1.svg',
      },
    ],
  })

  assert.equal(plans[0].action, 'unresolved')
  assert.equal(plans[0].reason, 'remote-host-not-allowed')
  assert.equal(plans[0].storageKey, null)
  assert.equal(plans[1].action, 'unresolved')
  assert.equal(plans[1].reason, 'unsupported-media-url')
})

test('plans a non-expired allowlisted remote asset for download', () => {
  const [plan] = buildMediaMigrationPlan({
    roots,
    remote: { now: 1_800_000_000 },
    records: [
      {
        type: 'image_asset',
        id: 73,
        projectId: 12,
        storyboardId: 44,
        versionNo: 1,
        url: 'https://platform-outputs.agnes-ai.space/images/task.png?Expires=1800000300',
      },
    ],
  })

  assert.equal(plan.action, 'remote-download')
  assert.equal(plan.storageKey, 'projects/12/frames/storyboards/44/v1/c73.png')
  assert.equal(plan.extension, '.png')
  assert.equal(plan.remoteHost, 'platform-outputs.agnes-ai.space')
})

test('keeps an expired allowlisted remote asset unresolved', () => {
  const [plan] = buildMediaMigrationPlan({
    roots,
    remote: { now: 1_800_000_000 },
    records: [
      {
        type: 'video_asset',
        id: 74,
        projectId: 12,
        storyboardId: 44,
        versionNo: 1,
        url: 'https://maas-watermark-prod-new.cn-wlcb.ufileos.com/video.mp4?Expires=1799999999',
      },
    ],
  })

  assert.equal(plan.action, 'unresolved')
  assert.equal(plan.reason, 'remote-url-expired')
})

test('summarizes remote download plans separately from local migrations', () => {
  assert.deepEqual(
    summarizeMediaMigrationPlans([
      { action: 'migrate' },
      { action: 'remote-download' },
      { action: 'skip' },
      { action: 'unresolved' },
    ]),
    {
      total: 4,
      migrate: 1,
      remoteDownload: 1,
      link: 0,
      skip: 1,
      unresolved: 1,
    },
  )
})
