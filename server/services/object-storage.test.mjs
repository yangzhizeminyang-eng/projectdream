import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createCosObjectStorage,
  createLocalObjectStorage,
  createObjectStorageFromEnv,
  inspectObjectStorageReadiness,
  normalizeObjectKey,
  verifySignedUrl,
} from './object-storage.mjs'

async function withTempRoot(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'projectdream-object-storage-'))
  try {
    return await callback(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('normalizes safe object keys and rejects traversal or absolute paths', () => {
  assert.equal(normalizeObjectKey('projects/12/cover.png'), 'projects/12/cover.png')
  assert.equal(normalizeObjectKey('projects/12/cover.png?'), 'projects/12/cover.png?')

  for (const key of [
    '',
    '   ',
    '../secret.txt',
    'projects/../secret.txt',
    '..%2Fsecret.txt',
    '%2e%2e/secret.txt',
    '/absolute.txt',
    '\\absolute.txt',
    'C:\\absolute.txt',
    'projects\\12\\cover.png',
    'projects/\u0000/cover.png',
  ]) {
    assert.throws(() => normalizeObjectKey(key), /invalid object key/i, key)
  }
})

test('stores, reads, heads, and deletes local objects with content metadata', async () => {
  await withTempRoot(async (root) => {
    const storage = createLocalObjectStorage({
      root,
      publicBaseUrl: 'http://127.0.0.1:3001/storage',
      signingSecret: 'test-secret',
    })

    const created = await storage.putObject({
      key: 'projects/12/cover.png',
      bytes: Buffer.from('png-bytes'),
      contentType: 'image/png',
    })

    assert.equal(created.key, 'projects/12/cover.png')
    assert.equal(created.size, 9)
    assert.equal(created.contentType, 'image/png')
    assert.match(created.etag, /^[a-f0-9]{64}$/)

    const head = await storage.headObject('projects/12/cover.png')
    assert.equal(head.size, 9)
    assert.equal(head.contentType, 'image/png')
    assert.equal(head.etag, created.etag)

    const object = await storage.getObject('projects/12/cover.png')
    assert.equal(object.contentType, 'image/png')
    assert.deepEqual(object.bytes, Buffer.from('png-bytes'))

    assert.equal(await storage.deleteObject('projects/12/cover.png'), true)
    assert.equal(await storage.headObject('projects/12/cover.png'), null)
    assert.equal(await storage.deleteObject('projects/12/cover.png'), false)
  })
})

test('creates stable public URLs and verifies expiring signed URLs', async () => {
  await withTempRoot(async (root) => {
    const storage = createLocalObjectStorage({
      root,
      publicBaseUrl: 'http://127.0.0.1:3001/storage/',
      signingSecret: 'test-secret',
      signedUrlTtlSeconds: 900,
    })
    const now = 1_800_000_000

    assert.equal(
      storage.publicUrl('projects/12/cover image.png'),
      'http://127.0.0.1:3001/storage/projects/12/cover%20image.png',
    )

    const signedUrl = storage.createSignedUrl({
      key: 'projects/12/cover image.png',
      now,
    })
    const parsed = new URL(signedUrl)
    const signature = parsed.searchParams.get('signature')
    const expires = Number(parsed.searchParams.get('expires'))

    assert.equal(parsed.pathname, '/storage/projects/12/cover%20image.png')
    assert.equal(expires, now + 900)
    assert.match(signature, /^[a-f0-9]{64}$/)
    assert.equal(
      verifySignedUrl({
        key: 'projects/12/cover image.png',
        expires,
        signature,
        signingSecret: 'test-secret',
        now,
      }),
      true,
    )
    assert.equal(
      verifySignedUrl({
        key: 'projects/12/cover image.png',
        expires,
        signature,
        signingSecret: 'wrong-secret',
        now,
      }),
      false,
    )
    assert.equal(
      verifySignedUrl({
        key: 'projects/12/cover image.png',
        expires,
        signature,
        signingSecret: 'test-secret',
        now: expires + 1,
      }),
      false,
    )
  })
})

test('creates a COS storage adapter from explicit production configuration', () => {
  const storage = createObjectStorageFromEnv(
    {
      OBJECT_STORAGE_PROVIDER: 'cos',
      COS_SECRET_ID: 'secret-id',
      COS_SECRET_KEY: 'secret-key',
      COS_BUCKET: 'projectdream-1250000000',
      COS_REGION: 'ap-guangzhou',
    },
    {
      createCosClient: () => ({
        getObjectUrl: () => 'https://projectdream-1250000000.cos.ap-guangzhou.myqcloud.com/test',
      }),
    },
  )

  assert.equal(storage.provider, 'cos')
})

test('requires COS credentials from environment before creating an injected client', () => {
  assert.throws(
    () => createObjectStorageFromEnv(
      {
        OBJECT_STORAGE_PROVIDER: 'cos',
        COS_BUCKET: 'projectdream-1250000000',
        COS_REGION: 'ap-guangzhou',
      },
      {
        createCosClient: () => ({
          getObjectUrl: () => 'https://example.test/signed',
        }),
      },
    ),
    /COS_SECRET_ID is required/i,
  )
})

test('reports only missing COS configuration fields without exposing secrets', () => {
  const readiness = inspectObjectStorageReadiness({
    OBJECT_STORAGE_PROVIDER: 'cos',
    COS_SECRET_ID: 'secret-id',
    COS_BUCKET: 'projectdream-1250000000',
  })

  assert.deepEqual(readiness, {
    provider: 'cos',
    ready: false,
    missing: ['COS_SECRET_KEY', 'COS_REGION'],
  })
})

test('maps COS object operations and returns a provider-readable signed URL', async () => {
  const calls = []
  const client = {
    putObject(options, callback) {
      calls.push(['putObject', options])
      callback(null, {
        ETag: '"cos-etag"',
        headers: {
          etag: '"cos-etag"',
          'content-length': '9',
          'content-type': 'image/png',
          'x-cos-meta-created-at': '2026-09-16T00:00:00.000Z',
          'x-cos-meta-updated-at': '2026-09-16T00:00:00.000Z',
        },
      })
    },
    headObject(options, callback) {
      calls.push(['headObject', options])
      callback(null, {
        headers: {
          etag: '"cos-etag"',
          'content-length': '9',
          'content-type': 'image/png',
          'x-cos-meta-created-at': '2026-09-16T00:00:00.000Z',
          'x-cos-meta-updated-at': '2026-09-16T00:00:00.000Z',
        },
      })
    },
    getObject(options, callback) {
      calls.push(['getObject', options])
      callback(null, {
        Body: Buffer.from('png-bytes'),
        headers: {
          etag: '"cos-etag"',
          'content-length': '9',
          'content-type': 'image/png',
          'x-cos-meta-created-at': '2026-09-16T00:00:00.000Z',
          'x-cos-meta-updated-at': '2026-09-16T00:00:00.000Z',
        },
      })
    },
    deleteObject(options, callback) {
      calls.push(['deleteObject', options])
      callback(null, {})
    },
    getObjectUrl(options) {
      calls.push(['getObjectUrl', options])
      return 'https://projectdream-1250000000.cos.ap-guangzhou.myqcloud.com/projects/12/cover.png?q-signature=test'
    },
  }
  const storage = createCosObjectStorage({
    client,
    bucket: 'projectdream-1250000000',
    region: 'ap-guangzhou',
    publicBaseUrl: 'https://projectdream-1250000000.cos.ap-guangzhou.myqcloud.com',
    signedUrlTtlSeconds: 900,
  })

  const created = await storage.putObject({
    key: 'projects/12/cover.png',
    bytes: Buffer.from('png-bytes'),
    contentType: 'image/png',
  })
  const head = await storage.headObject('projects/12/cover.png')
  const object = await storage.getObject('projects/12/cover.png')
  const signedUrl = storage.createSignedUrl({
    key: 'projects/12/cover.png',
    now: 1_800_000_000,
  })

  assert.equal(created.etag, 'cos-etag')
  assert.equal(head.size, 9)
  assert.deepEqual(object.bytes, Buffer.from('png-bytes'))
  assert.equal(
    signedUrl,
    'https://projectdream-1250000000.cos.ap-guangzhou.myqcloud.com/projects/12/cover.png?q-signature=test',
  )
  assert.equal(await storage.deleteObject('projects/12/cover.png'), true)
  assert.deepEqual(
    calls.map(([name]) => name),
    [
      'headObject',
      'putObject',
      'headObject',
      'getObject',
      'getObjectUrl',
      'headObject',
      'deleteObject',
    ],
  )
  assert.deepEqual(calls[1][1].Key, 'projects/12/cover.png')
  assert.equal(calls[4][1].Expires, 900)
})

test('rejects unsupported provider configuration instead of pretending cloud storage exists', () => {
  assert.throws(
    () => createObjectStorageFromEnv({
      OBJECT_STORAGE_PROVIDER: 's3',
      OBJECT_STORAGE_ROOT: '.codex-runtime/test-storage',
      OBJECT_STORAGE_SIGNING_SECRET: 'test-secret',
    }),
    /unsupported object storage provider/i,
  )
})

test('cleans only expired objects under a prefix', async () => {
  await withTempRoot(async (root) => {
    const storage = createLocalObjectStorage({
      root,
      publicBaseUrl: 'http://127.0.0.1:3001/storage',
      signingSecret: 'test-secret',
    })
    await storage.putObject({
      key: 'projects/12/old.mp4',
      bytes: Buffer.from('old'),
      contentType: 'video/mp4',
    })
    await storage.putObject({
      key: 'projects/12/new.mp4',
      bytes: Buffer.from('new'),
      contentType: 'video/mp4',
    })
    await storage.putObject({
      key: 'projects/13/old.mp4',
      bytes: Buffer.from('other'),
      contentType: 'video/mp4',
    })

    const oldDate = new Date('2020-01-01T00:00:00.000Z')
    await utimes(path.join(root, 'projects/12/old.mp4'), oldDate, oldDate)

    assert.deepEqual(
      await storage.listExpiredObjects({
        prefix: 'projects/12',
        before: new Date('2021-01-01T00:00:00.000Z'),
      }),
      ['projects/12/old.mp4'],
    )
    assert.deepEqual(
      await storage.deleteExpiredObjects({
        prefix: 'projects/12',
        before: new Date('2021-01-01T00:00:00.000Z'),
      }),
      ['projects/12/old.mp4'],
    )
    assert.equal(await storage.headObject('projects/12/old.mp4'), null)
    assert.notEqual(await storage.headObject('projects/12/new.mp4'), null)
    assert.notEqual(await storage.headObject('projects/13/old.mp4'), null)
  })
})

test('lists only object keys under a safe local storage prefix', async () => {
  await withTempRoot(async (root) => {
    const storage = createLocalObjectStorage({
      root,
      publicBaseUrl: 'http://127.0.0.1:3001/storage',
      signingSecret: 'test-secret',
    })
    await storage.putObject({
      key: 'projects/12/frames/one.png',
      bytes: Buffer.from('one'),
      contentType: 'image/png',
    })
    await storage.putObject({
      key: 'projects/12/videos/two.mp4',
      bytes: Buffer.from('two'),
      contentType: 'video/mp4',
    })
    await storage.putObject({
      key: 'projects/13/frames/three.png',
      bytes: Buffer.from('three'),
      contentType: 'image/png',
    })

    assert.deepEqual(
      await storage.listObjectKeys({ prefix: 'projects/12' }),
      ['projects/12/frames/one.png', 'projects/12/videos/two.mp4'],
    )
    await assert.rejects(
      storage.listObjectKeys({ prefix: 'projects/../secrets' }),
      /invalid object key/i,
    )
  })
})

test('a new adapter instance can recover objects written by a previous instance', async () => {
  await withTempRoot(async (root) => {
    const first = createLocalObjectStorage({
      root,
      publicBaseUrl: 'http://127.0.0.1:3001/storage',
      signingSecret: 'test-secret',
    })
    await first.putObject({
      key: 'exports/77/final.mp4',
      bytes: Buffer.from('persistent-media'),
      contentType: 'video/mp4',
    })

    const second = createLocalObjectStorage({
      root,
      publicBaseUrl: 'http://127.0.0.1:3001/storage',
      signingSecret: 'test-secret',
    })
    const object = await second.getObject('exports/77/final.mp4')

    assert.deepEqual(object.bytes, Buffer.from('persistent-media'))
    assert.equal(object.contentType, 'video/mp4')
    assert.equal(
      await readFile(path.join(root, 'exports/77/final.mp4'), 'utf8'),
      'persistent-media',
    )
  })
})
