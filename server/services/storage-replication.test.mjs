import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  buildStorageReplicationPlan,
  replicateStorageObjects,
  selectProjectStorageKeys,
} from './storage-replication.mjs'

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function createMemoryStorage(initial = {}) {
  const objects = new Map(
    Object.entries(initial).map(([key, value]) => {
      const bytes = Buffer.from(value.bytes)
      return [key, {
        bytes,
        contentType: value.contentType || 'application/octet-stream',
      }]
    }),
  )
  const calls = []

  return {
    calls,
    async headObject(key) {
      const object = objects.get(key)
      if (!object) return null
      return {
        key,
        size: object.bytes.length,
        contentType: object.contentType,
        checksum: checksum(object.bytes),
      }
    },
    async getObject(key) {
      const object = objects.get(key)
      if (!object) return null
      return {
        key,
        size: object.bytes.length,
        contentType: object.contentType,
        bytes: Buffer.from(object.bytes),
        checksum: checksum(object.bytes),
      }
    },
    async putObject({ key, bytes, contentType }) {
      calls.push({ key, bytes: Buffer.from(bytes), contentType })
      objects.set(key, { bytes: Buffer.from(bytes), contentType })
      return this.headObject(key)
    },
  }
}

test('selects only valid project-scoped keys for requested projects', () => {
  assert.deepEqual(
    selectProjectStorageKeys([
      'projects/12/frames/a.png',
      'projects/13/videos/b.mp4',
      'exports/77/final.mp4',
      'projects/nope/frames/c.png',
      'projects/12/frames/a.png',
    ], [12]),
    ['projects/12/frames/a.png'],
  )
})

test('selects only explicitly requested object keys within the selected project', () => {
  assert.deepEqual(
    selectProjectStorageKeys(
      [
        'projects/12/exports/8/final.mp4',
        'projects/12/frames/storyboards/168/v1/c159.png',
        'projects/13/frames/storyboards/168/v1/c159.png',
      ],
      [12],
      ['projects/12/frames/storyboards/168/v1/c159.png'],
    ),
    ['projects/12/frames/storyboards/168/v1/c159.png'],
  )
})

test('plans copies only when destination content is missing or different', async () => {
  const source = createMemoryStorage({
    'projects/12/frames/one.png': { bytes: 'same', contentType: 'image/png' },
    'projects/12/frames/two.png': { bytes: 'new', contentType: 'image/png' },
  })
  const destination = createMemoryStorage({
    'projects/12/frames/one.png': { bytes: 'same', contentType: 'image/png' },
    'projects/12/frames/two.png': { bytes: 'old', contentType: 'image/png' },
  })

  const plan = await buildStorageReplicationPlan({
    keys: [
      'projects/12/frames/two.png',
      'projects/12/frames/one.png',
      'projects/12/frames/missing.png',
    ],
    source,
    destination,
  })

  assert.deepEqual(
    plan.map((item) => ({ key: item.key, action: item.action, reason: item.reason })),
    [
      { key: 'projects/12/frames/missing.png', action: 'unresolved', reason: 'source-missing' },
      { key: 'projects/12/frames/one.png', action: 'skip', reason: 'checksum-matched' },
      { key: 'projects/12/frames/two.png', action: 'copy', reason: 'checksum-mismatched' },
    ],
  )
})

test('copies, reads back, and verifies replicated object bytes without changing skipped objects', async () => {
  const source = createMemoryStorage({
    'projects/12/videos/a.mp4': { bytes: 'fresh-video', contentType: 'video/mp4' },
    'projects/12/videos/b.mp4': { bytes: 'unchanged-video', contentType: 'video/mp4' },
  })
  const destination = createMemoryStorage({
    'projects/12/videos/b.mp4': { bytes: 'unchanged-video', contentType: 'video/mp4' },
  })
  const plan = await buildStorageReplicationPlan({
    keys: ['projects/12/videos/a.mp4', 'projects/12/videos/b.mp4'],
    source,
    destination,
  })

  const result = await replicateStorageObjects({ plan, source, destination })

  assert.deepEqual(
    result.map((item) => ({ key: item.key, result: item.result })),
    [
      { key: 'projects/12/videos/a.mp4', result: 'copied-and-verified' },
      { key: 'projects/12/videos/b.mp4', result: 'skipped' },
    ],
  )
  assert.equal(destination.calls.length, 1)
  assert.equal(destination.calls[0].key, 'projects/12/videos/a.mp4')
  assert.deepEqual((await destination.getObject('projects/12/videos/a.mp4')).bytes, Buffer.from('fresh-video'))
})
