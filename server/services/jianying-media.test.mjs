import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  buildJianyingMediaCacheDir,
  materializeJianyingMedia,
  resolveMediaTargetNames,
} from './jianying-media.mjs'

const requests = [
  { url: 'https://cdn.example.com/a/v11.mp4', kind: 'video', fileName: '01_S1-01.mp4', label: 'Scene 1 / 01' },
  { url: 'https://cdn.example.com/a/v13.mp4', kind: 'video', fileName: '02_S1-06.mp4', label: 'Scene 1 / 06' },
  // 同一个素材被主轨和画中画共用，只应落一个文件
  { url: 'https://cdn.example.com/a/v11.mp4', kind: 'overlay', fileName: 'PIP_01_S1-01.mp4', label: '画中画' },
  { url: 'https://cdn.example.com/b/dialogue.mp3', kind: 'audio', fileName: '对白_01.mp3', label: '赵衡' },
  { url: 'https://cdn.example.com/c/dialogue.mp3', kind: 'audio', fileName: '旁白_01.mp3', label: '旁白' },
]

test('materialize downloads each distinct url once and maps it to a local path', async () => {
  const calls = []
  const result = await materializeJianyingMedia({
    requests,
    cacheDir: '/cache/ep1',
    download: async ({ sourceUrl, targetPath }) => {
      calls.push({ sourceUrl, targetPath })
      return targetPath
    },
  })

  assert.equal(result.total, 4, 'total 是真实下载数：同一 URL 复用只算一次')
  assert.equal(calls.length, 4, '同一 URL 只下载一次')
  assert.equal(result.pathByUrl.size, 4)
  assert.equal(result.failed.length, 0)
  assert.equal(
    result.pathByUrl.get('https://cdn.example.com/a/v11.mp4'),
    path.join('/cache/ep1', '01_S1-01.mp4'),
  )
})

test('materialize keeps only the surviving media so the draft never points at a missing file', async () => {
  const result = await materializeJianyingMedia({
    requests,
    cacheDir: '/cache/ep1',
    download: async ({ sourceUrl, targetPath }) => {
      if (sourceUrl.includes('v13')) throw new Error('media download failed with HTTP 404')
      return targetPath
    },
  })

  assert.equal(result.pathByUrl.size, 3)
  assert.deepEqual(result.failed.map((item) => item.kind), ['video'])
  assert.match(result.failed[0].reason, /404/)
  assert.equal(result.pathByUrl.has('https://cdn.example.com/a/v13.mp4'), false)
})

test('materialize reports progress for every planned item even when some fail', async () => {
  const seen = []
  await materializeJianyingMedia({
    requests,
    cacheDir: '/cache/ep1',
    download: async ({ sourceUrl, targetPath }) => {
      if (sourceUrl.includes('dialogue')) throw new Error('boom')
      return targetPath
    },
    concurrency: 1,
    onProgress: (progress) => seen.push(progress),
  })
  assert.equal(seen.length, 4, '去重后只有 4 个真实下载')
  assert.deepEqual(seen.map((item) => item.done), [1, 2, 3, 4])
  assert.equal(seen.at(-1).total, 4)
})

test('materialize disambiguates same-named files from different urls', () => {
  const planned = resolveMediaTargetNames([
    { url: 'https://a/1.mp4', fileName: 'clip.mp4' },
    { url: 'https://b/2.mp4', fileName: 'clip.mp4' },
    { url: 'https://c/3.mp4', fileName: 'clip.mp4' },
    { url: 'https://a/1.mp4', fileName: 'clip.mp4' },
  ])
  assert.deepEqual(
    planned.map((item) => item.targetName),
    ['clip.mp4', 'clip (2).mp4', 'clip (3).mp4', 'clip.mp4'],
  )
})

test('materialize rejects a missing cache dir and copes with an empty request list', async () => {
  await assert.rejects(() => materializeJianyingMedia({ requests }), /素材缓存目录/)
  const empty = await materializeJianyingMedia({ requests: [], cacheDir: '/cache/ep1' })
  assert.equal(empty.total, 0)
  assert.equal(empty.pathByUrl.size, 0)
})

test('cache dir is stable per project and episode', () => {
  const dir = buildJianyingMediaCacheDir({ baseDir: '/base', projectId: 12, episodeNo: 1 })
  assert.equal(dir, path.join('/base', 'jianying-draft-media', 'project-12', 'episode-1'))
  assert.equal(
    buildJianyingMediaCacheDir({ baseDir: '/base', projectId: '12/../evil', episodeNo: 1 }),
    path.join('/base', 'jianying-draft-media', 'project-12_.._evil', 'episode-1'),
  )
})
