import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_REMOTE_MEDIA_HOSTS,
  downloadAndValidateRemoteMedia,
  inspectRemoteMediaSource,
  parseRemoteMediaAllowedHosts,
  validateRemoteMediaBytes,
} from './remote-media-recovery.mjs'

const NOW = 1_800_000_000

test('allows only exact configured hosts and non-expired media URLs', () => {
  const result = inspectRemoteMediaSource({
    url: `https://platform-outputs.agnes-ai.space/images/task.png?Expires=${NOW + 300}`,
    now: NOW,
  })

  assert.equal(result.action, 'download')
  assert.equal(result.host, 'platform-outputs.agnes-ai.space')
  assert.equal(result.extension, '.png')
  assert.equal(result.expiresAt, NOW + 300)
})

test('rejects expired, unsupported, and non-whitelisted remote URLs', () => {
  assert.equal(
    inspectRemoteMediaSource({
      url: `https://maas-watermark-prod-new.cn-wlcb.ufileos.com/video.mp4?Expires=${NOW - 1}`,
      now: NOW,
    }).reason,
    'remote-url-expired',
  )
  assert.equal(
    inspectRemoteMediaSource({
      url: 'https://provider.example/video.mp4',
      now: NOW,
    }).reason,
    'remote-host-not-allowed',
  )
  assert.equal(
    inspectRemoteMediaSource({
      url: 'https://platform-outputs.agnes-ai.space/images/task.gif',
      now: NOW,
    }).reason,
    'unsupported-remote-extension',
  )
})

test('normalizes an explicit host allowlist without accepting wildcard hosts', () => {
  assert.deepEqual(
    parseRemoteMediaAllowedHosts(' Platform-Outputs.Agnes-AI.Space, files.example.com '),
    ['platform-outputs.agnes-ai.space', 'files.example.com'],
  )
  assert.deepEqual(parseRemoteMediaAllowedHosts(''), DEFAULT_REMOTE_MEDIA_HOSTS)
  assert.equal(
    inspectRemoteMediaSource({
      url: `https://sub.platform-outputs.agnes-ai.space/task.png?Expires=${NOW + 300}`,
      now: NOW,
    }).reason,
    'remote-host-not-allowed',
  )
})

test('validates media bytes using size and container signatures', () => {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ])
  assert.deepEqual(
    validateRemoteMediaBytes({
      bytes: png,
      contentType: 'image/png',
      extension: '.png',
      maxBytes: 1024,
    }),
    {
      mediaKind: 'image',
      sizeBytes: png.length,
      contentType: 'image/png',
      extension: '.png',
    },
  )

  assert.throws(
    () =>
      validateRemoteMediaBytes({
        bytes: Buffer.from('not an mp4'),
        contentType: 'video/mp4',
        extension: '.mp4',
        maxBytes: 1024,
      }),
    /invalid remote media signature/,
  )
  assert.throws(
    () =>
      validateRemoteMediaBytes({
        bytes: Buffer.alloc(5),
        contentType: 'image/png',
        extension: '.png',
        maxBytes: 4,
      }),
    /remote media exceeds maximum size/,
  )
})

test('downloads an allowed remote image and rejects a mismatched response', async () => {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ])
  const response = await downloadAndValidateRemoteMedia({
    url: `https://platform-outputs.agnes-ai.space/images/task.png?Expires=${NOW + 300}`,
    now: NOW,
    maxBytes: 1024,
    fetchImpl: async () => new Response(png, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(png.length),
      },
    }),
  })
  assert.equal(response.bytes.equals(png), true)
  assert.equal(response.validation.mediaKind, 'image')

  await assert.rejects(
    () =>
      downloadAndValidateRemoteMedia({
        url: `https://platform-outputs.agnes-ai.space/images/task.png?Expires=${NOW + 300}`,
        now: NOW,
        maxBytes: 1024,
        fetchImpl: async () => new Response(Buffer.from('html'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      }),
    /invalid remote media signature/,
  )
})
