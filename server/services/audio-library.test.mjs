import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAudioLibraryStorageKey,
  decodeAudioLibraryUpload,
  normalizeAudioLibraryUpload,
} from './audio-library.mjs'

test('rejects an authorized music upload without license evidence', () => {
  assert.throws(
    () =>
      normalizeAudioLibraryUpload({
        assetType: 'music',
        title: '雨夜悬念',
        sourceName: '已授权音乐库',
        licenseStatus: 'authorized',
        fileName: 'rain.mp3',
        dataUrl: 'data:audio/mpeg;base64,SUQz',
      }),
    /授权凭证/,
  )
})

test('decodes a validated audio data URL into a safe file payload', () => {
  const upload = normalizeAudioLibraryUpload({
    assetType: 'music',
    title: '雨夜悬念',
    sourceName: '已授权音乐库',
    licenseStatus: 'authorized',
    licenseEvidence: 'license-2026-09.pdf',
    fileName: 'rain.mp3',
    dataUrl: 'data:audio/mpeg;base64,SUQz',
  })

  const decoded = decodeAudioLibraryUpload(upload)

  assert.equal(decoded.extension, '.mp3')
  assert.equal(decoded.bytes.toString('utf8'), 'ID3')
})

test('builds a stable project-scoped storage key for an audio library asset', () => {
  assert.equal(
    buildAudioLibraryStorageKey({
      projectId: 12,
      token: 'asset-abc-123',
      extension: '.mp3',
    }),
    'projects/12/audio-library/asset-abc-123.mp3',
  )
  assert.throws(
    () =>
      buildAudioLibraryStorageKey({
        projectId: 12,
        token: '../escape',
        extension: '.mp3',
      }),
    /invalid audio library storage key/i,
  )
})
