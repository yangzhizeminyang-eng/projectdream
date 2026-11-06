import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildLegacyExportSubtitlePlan,
  replicateLegacyExportSubtitles,
  summarizeLegacyExportSubtitleResults,
} from './legacy-export-subtitle-replication.mjs'

function createMemoryStorage(initial = {}) {
  const objects = new Map(Object.entries(initial).map(([key, value]) => [
    key,
    { bytes: Buffer.from(value), contentType: 'application/x-subrip; charset=utf-8' },
  ]))

  return {
    async headObject(key) {
      const object = objects.get(key)
      if (!object) return null
      return { key, size: object.bytes.length }
    },
    async putObject({ key, bytes, contentType }) {
      objects.set(key, { bytes: Buffer.from(bytes), contentType })
      return { key, size: bytes.length, contentType }
    },
    async getObject(key) {
      const object = objects.get(key)
      return object
        ? { key, bytes: Buffer.from(object.bytes), size: object.bytes.length, contentType: object.contentType }
        : null
    },
  }
}

test('plans only existing safe subtitle files for requested exports', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'projectdream-subtitles-'))
  try {
    await mkdir(path.join(root, '20'), { recursive: true })
    await writeFile(path.join(root, '20', 'subtitles.srt'), '1\n00:00:00,000 --> 00:00:01,000\n你好\n', 'utf8')
    const plan = await buildLegacyExportSubtitlePlan({
      projectId: 12,
      exportIds: [20, 21, 20],
      sourceRoot: root,
    })

    assert.deepEqual(plan.map((item) => ({ exportId: item.exportId, action: item.action, key: item.key })), [
      { exportId: 20, action: 'copy', key: 'projects/12/exports/20/subtitles.srt' },
      { exportId: 21, action: 'unresolved', key: 'projects/12/exports/21/subtitles.srt' },
    ])
    assert.equal(plan[1].reason, 'source-missing')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('copies subtitles and verifies the destination bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'projectdream-subtitles-'))
  try {
    const content = '1\n00:00:00,000 --> 00:00:01,000\n你好\n'
    await mkdir(path.join(root, '20'), { recursive: true })
    await writeFile(path.join(root, '20', 'subtitles.srt'), content, 'utf8')
    const storage = createMemoryStorage()
    const plan = await buildLegacyExportSubtitlePlan({ projectId: 12, exportIds: [20], sourceRoot: root })
    const results = await replicateLegacyExportSubtitles({ plan, destination: storage })

    assert.deepEqual(results.map((item) => ({ exportId: item.exportId, result: item.result })), [
      { exportId: 20, result: 'copied-and-verified' },
    ])
    assert.deepEqual((await storage.getObject('projects/12/exports/20/subtitles.srt')).bytes, Buffer.from(content))
    assert.deepEqual(summarizeLegacyExportSubtitleResults(results), { 'copied-and-verified': 1 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
