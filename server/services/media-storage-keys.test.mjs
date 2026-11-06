import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCharacterReferenceStorageKey,
  buildExportStorageKey,
  buildGeneratedVideoEndFrameStorageKey,
  buildGeneratedVideoStorageKey,
  buildLipSyncVideoStorageKey,
  buildRecoveryVideoReviewFrameStorageKey,
  buildSubtitleCleanedVideoStorageKey,
} from './media-storage-keys.mjs'

test('builds stable storage keys for generated and lip-sync videos', () => {
  assert.equal(
    buildGeneratedVideoStorageKey({
      projectId: 12,
      storyboardId: 88,
      versionNo: 3,
      candidateNo: 2,
    }),
    'projects/12/videos/storyboards/88/v3/c2.mp4',
  )
  assert.equal(
    buildGeneratedVideoEndFrameStorageKey({
      projectId: 12,
      storyboardId: 88,
      versionNo: 3,
      candidateNo: 2,
    }),
    'projects/12/videos/storyboards/88/v3/c2-end.jpg',
  )
  assert.equal(
    buildSubtitleCleanedVideoStorageKey({
      projectId: 12,
      storyboardId: 88,
      sourceVideoId: 9,
    }),
    'projects/12/videos/storyboards/88/subtitle-cleaned/source-9.mp4',
  )
  assert.equal(
    buildLipSyncVideoStorageKey({
      projectId: 12,
      storyboardId: 88,
      versionNo: 4,
    }),
    'projects/12/videos/lip-sync/storyboards/88/v4/c1.mp4',
  )
})

test('builds stable storage keys for exported final media', () => {
  assert.equal(
    buildExportStorageKey({
      projectId: 12,
      exportId: 77,
    }),
    'projects/12/exports/77/final.mp4',
  )
  assert.equal(
    buildExportStorageKey({
      projectId: 12,
      exportId: 77,
      extension: '.srt',
    }),
    'projects/12/exports/77/subtitles.srt',
  )
})

test('builds an image storage key for a character reference', () => {
  assert.equal(
    buildCharacterReferenceStorageKey({
      projectId: 12,
      characterId: 31,
      extension: '.png',
    }),
    'projects/12/frames/characters/31/reference.png',
  )
})

test('builds a stable storage key for a recovery video review frame', () => {
  assert.equal(
    buildRecoveryVideoReviewFrameStorageKey({
      projectId: 12,
      storyboardId: 180,
      versionNo: 2,
      candidateNo: 1,
      sampleNo: 2,
    }),
    'projects/12/videos/storyboards/180/v2/review/c1-s2.jpg',
  )
})

test('rejects unsafe or incomplete video and export storage key inputs', () => {
  assert.throws(
    () =>
      buildGeneratedVideoStorageKey({
        projectId: 12,
        storyboardId: '../escape',
        versionNo: 1,
        candidateNo: 1,
      }),
    /invalid generated video storage key/i,
  )
  assert.throws(
    () =>
      buildExportStorageKey({
        projectId: 12,
        exportId: 0,
      }),
    /invalid export storage key/i,
  )
  assert.throws(
    () => buildGeneratedVideoEndFrameStorageKey({ projectId: 'NaN', storyboardId: 88, versionNo: 1, candidateNo: 1 }),
    /invalid generated video end frame storage key/i,
  )
  assert.throws(
    () => buildSubtitleCleanedVideoStorageKey({ projectId: 0, storyboardId: 88, sourceVideoId: 1 }),
    /invalid subtitle-cleaned video storage key/i,
  )
})
