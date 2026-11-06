import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { INDEX_FILE, uninstallJianyingDraft } from './jianying-draft-installer.mjs'
import { buildJianyingDraftName, exportJianyingDraft } from './jianying-export.mjs'

const FOREIGN_DRAFT = '9月28日'

const clips = [
  {
    storyboardId: 11,
    sceneNo: 1,
    shotNo: '01',
    enabled: true,
    durationSeconds: 3,
    sourceDurationSeconds: 5,
    trimStartSeconds: 0.5,
    videoUrl: 'https://cdn.example.com/v11.mp4',
  },
  {
    storyboardId: 13,
    sceneNo: 2,
    shotNo: '06',
    enabled: true,
    durationSeconds: 2.5,
    sourceDurationSeconds: 4,
    transition: { type: 'fade', durationSeconds: 0.4 },
    videoUrl: 'https://cdn.example.com/v13.mp4',
  },
]

const overlayClips = [
  {
    clipId: 'pip-1',
    storyboardId: 13,
    startSeconds: 1,
    durationSeconds: 2,
    enabled: true,
    position: 'bottom-right',
    scale: 0.34,
    opacity: 100,
  },
]

const audioTracks = {
  dialogue: [
    {
      id: 501,
      storyboardId: 13,
      title: '赵衡：别签',
      enabled: true,
      startOffsetSeconds: 0.4,
      durationSeconds: 1.8,
      audioUrl: 'https://cdn.example.com/a501.mp3',
    },
  ],
}

const subtitleCues = [
  { storyboardId: 11, startOffsetSeconds: 0.2, durationSeconds: 2, text: '别签字。', enabled: true },
]

async function makeEnv() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'jy-export-'))
  const draftRoot = path.join(base, 'com.lveditor.draft')
  const cacheBaseDir = path.join(base, 'runtime')
  await mkdir(path.join(draftRoot, FOREIGN_DRAFT), { recursive: true })
  await writeFile(path.join(draftRoot, FOREIGN_DRAFT, 'draft_content.json'), 'ENCRYPTED', 'utf8')
  await writeFile(
    path.join(draftRoot, INDEX_FILE),
    JSON.stringify(
      {
        all_draft_store: [
          { draft_fold_path: path.join(draftRoot, FOREIGN_DRAFT).replace(/\\/g, '/'), draft_id: 'foreign', draft_name: FOREIGN_DRAFT },
        ],
        draft_ids: ['foreign'],
        root_path: draftRoot.replace(/\\/g, '/'),
      },
      null,
      2,
    ),
    'utf8',
  )
  return { base, draftRoot, cacheBaseDir }
}

/** 造一个带真实尺寸的 PNG 头，让画布探测有东西可量 */
function pngHeader(width, height) {
  const buffer = Buffer.alloc(64)
  buffer.writeUInt32BE(0x89504e47, 0)
  buffer.writeUInt32BE(0x0d0a1a0a, 4)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'latin1')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

function fakeDownload(rate = {}, pixel = { width: 1312, height: 736 }) {
  const calls = []
  const download = async ({ sourceUrl, targetPath }) => {
    calls.push(sourceUrl)
    if (rate.fail?.some((fragment) => sourceUrl.includes(fragment))) {
      throw new Error('media download failed with HTTP 404')
    }
    await mkdir(path.dirname(targetPath), { recursive: true })
    await writeFile(
      targetPath,
      Buffer.concat([pngHeader(pixel.width, pixel.height), Buffer.from(`bytes-for:${sourceUrl}`)]),
    )
    return targetPath
  }
  return { download, calls }
}

const commonInput = {
  projectId: 12,
  projectName: '零点回声',
  episodeNo: 1,
  aspectRatio: '9:16',
  clips,
  overlayClips,
  audioTracks,
  subtitleCues,
}

/** 静帧镜头：真机实测剪映 6.0.1 会丢弃图片素材，必须编码成短 mp4 才渲染 */
const stillClip = {
  storyboardId: 21,
  sceneNo: 3,
  shotNo: '01',
  enabled: true,
  durationSeconds: 3,
  sourceDurationSeconds: 3,
  imageUrl: 'https://cdn.example.com/frames/still-21.png',
}

/** 假的 ffmpeg：把目标文件写出来，模拟编码成功 */
function fakeStillEncoder({ fail = false } = {}) {
  const encoded = []
  const run = async (bin, args) => {
    if (fail) throw new Error('ffmpeg failed (1): boom')
    const targetPath = args.at(-1)
    encoded.push(targetPath)
    await mkdir(path.dirname(targetPath), { recursive: true })
    await writeFile(targetPath, Buffer.from('fake-mp4-bytes'))
  }
  return { run, encoded }
}

test('export encodes still frames to video so the user capcut renders them', async (t) => {
  const env = await makeEnv()
  t.after(() => rm(env.base, { recursive: true, force: true }))
  const { download } = fakeDownload()
  const { run, encoded } = fakeStillEncoder()

  const result = await exportJianyingDraft({
    ...commonInput,
    clips: [...clips, stillClip],
    cacheBaseDir: env.cacheBaseDir,
    draftRoot: env.draftRoot,
    install: true,
    download,
    encodeRun: run,
  })

  // 静帧确实被编码，而且草稿里没有任何图片素材
  assert.equal(result.stills.total, 1)
  assert.equal(result.stills.encoded, 1)
  assert.equal(encoded.length, 1)
  assert.match(encoded[0], /03_S3-01\.still\.mp4$/)
  assert.equal(result.stats.imageMaterials, 0)
  assert.equal(result.stats.stillsAsVideo, 1)

  // 主轨上这一段指向编码后的 mp4，且素材类型是 video
  const videoTrack = result.draftContent.tracks.find((track) => track.type === 'video')
  assert.equal(videoTrack.segments.length, 3)
  const stillSegment = videoTrack.segments.at(-1)
  const material = result.draftContent.materials.videos.find((m) => m.id === stillSegment.material_id)
  assert.equal(material.type, 'video')
  assert.match(material.path, /03_S3-01\.still\.mp4$/)
  // 素材时长要容得下展示时长
  assert.ok(material.duration >= 3 * 1_000_000)
})

test('export drops a still whose encoding failed instead of pointing at a broken path', async (t) => {
  const env = await makeEnv()
  t.after(() => rm(env.base, { recursive: true, force: true }))
  const { download } = fakeDownload()
  const { run } = fakeStillEncoder({ fail: true })

  const result = await exportJianyingDraft({
    ...commonInput,
    clips: [...clips, stillClip],
    cacheBaseDir: env.cacheBaseDir,
    draftRoot: env.draftRoot,
    install: true,
    download,
    encodeRun: run,
  })

  assert.equal(result.stills.encoded, 0)
  assert.equal(result.stills.failed.length, 1)
  assert.match(result.stills.failed[0].reason, /ffmpeg failed/)
  // 编码失败的静帧不写进草稿，也不留下指向 .png 的假视频素材
  const videoTrack = result.draftContent.tracks.find((track) => track.type === 'video')
  assert.equal(videoTrack.segments.length, 2)
  assert.ok(result.draftContent.materials.videos.every((m) => !m.path.endsWith('.still.mp4')))
  assert.ok(result.stats.missingMedia.some((item) => item.kind === 'image'))
})

test('export produces a draft from a dry run plus one materialization pass', async (t) => {
  const env = await makeEnv()
  t.after(() => rm(env.base, { recursive: true, force: true }))
  const { download, calls } = fakeDownload()

  const result = await exportJianyingDraft({ ...commonInput, cacheBaseDir: env.cacheBaseDir, download })

  // v11 被主轨引用、v13 被主轨和画中画共用 → 3 个不同 URL
  assert.deepEqual(calls.sort(), [
    'https://cdn.example.com/a501.mp3',
    'https://cdn.example.com/v11.mp4',
    'https://cdn.example.com/v13.mp4',
  ])
  assert.equal(result.installed, false)
  assert.equal(result.draftName, '帧心帧意_零点回声 E01')
  assert.equal(result.stats.videoSegments, 2)
  assert.equal(result.stats.overlaySegments, 1)
  assert.equal(result.stats.audioSegments, 1)
  assert.equal(result.stats.textSegments, 1)
  assert.equal(result.totalDurationSeconds, 5.5)
  assert.deepEqual(result.stats.missingMedia, [])
  // 转场如实上报，不伪造
  assert.deepEqual(result.stats.unsupportedTransitions, [
    { storyboardId: 13, type: 'fade', durationSeconds: 0.4 },
  ])
  // 画中画锚点用真机修正后的 Y 轴
  const overlayTrack = result.draftContent.tracks.filter((track) => track.type === 'video')[1]
  assert.deepEqual(overlayTrack.segments[0].clip.transform, { x: 0.6, y: -0.6 })
  // 素材路径都指向本机缓存
  for (const material of result.draftContent.materials.videos) {
    assert.ok(material.path.startsWith(env.cacheBaseDir), material.path)
  }
})

test('export keeps going when one shot fails to download and reports it', async (t) => {
  const env = await makeEnv()
  t.after(() => rm(env.base, { recursive: true, force: true }))
  const { download } = fakeDownload({ fail: ['v13'] })

  const result = await exportJianyingDraft({ ...commonInput, cacheBaseDir: env.cacheBaseDir, download })

  assert.equal(result.media.failed.length, 1)
  assert.equal(result.media.failed[0].kind, 'video')
  const missingKinds = result.stats.missingMedia.map((item) => item.kind).sort()
  assert.deepEqual(missingKinds, ['overlay', 'video'])
  // 缺素材的镜头不写进草稿，避免剪映打开是坏路径
  const videoTrack = result.draftContent.tracks.find((track) => track.type === 'video')
  assert.deepEqual(videoTrack.segments.map((segment) => segment.target_timerange.start), [0])
  for (const material of result.draftContent.materials.videos) {
    assert.equal(material.path.includes('v13'), false)
  }
})

test('export installs into the capcut draft library without touching other drafts', async (t) => {
  const env = await makeEnv()
  t.after(() => rm(env.base, { recursive: true, force: true }))
  const { download } = fakeDownload()

  const result = await exportJianyingDraft({
    ...commonInput,
    cacheBaseDir: env.cacheBaseDir,
    draftRoot: env.draftRoot,
    install: true,
    download,
    nowMs: 1_760_000_000_000,
  })

  assert.equal(result.installed, true)
  assert.equal(result.createdBackup, true)
  assert.equal(result.replacedExisting, false)

  // 草稿是真明文，且时间线单位是微秒
  const installed = JSON.parse(await readFile(path.join(result.draftDir, 'draft_content.json'), 'utf8'))
  assert.equal(installed.duration, 5_500_000)
  assert.deepEqual(
    installed.tracks.map((track) => track.type),
    ['video', 'video', 'audio', 'text'],
  )

  const index = JSON.parse(await readFile(path.join(env.draftRoot, INDEX_FILE), 'utf8'))
  assert.equal(index.all_draft_store.length, 2)
  assert.equal(index.all_draft_store[0].draft_name, FOREIGN_DRAFT, '别人的草稿条目原样保留')
  assert.equal(index.all_draft_store[1].draft_name, result.draftName)

  // 别人的草稿文件没被动过
  assert.equal(await readFile(path.join(env.draftRoot, FOREIGN_DRAFT, 'draft_content.json'), 'utf8'), 'ENCRYPTED')

  // 卸载能把环境还原
  const cleanup = await uninstallJianyingDraft({ draftRoot: env.draftRoot, folderName: result.folderName })
  assert.equal(cleanup.restoredIndex, true)
  assert.deepEqual((await readdir(env.draftRoot)).sort(), [FOREIGN_DRAFT, INDEX_FILE].sort())
})

test('export re-exports over its own previous draft instead of piling up folders', async (t) => {
  const env = await makeEnv()
  t.after(() => rm(env.base, { recursive: true, force: true }))
  const { download } = fakeDownload()

  const first = await exportJianyingDraft({ ...commonInput, cacheBaseDir: env.cacheBaseDir, draftRoot: env.draftRoot, install: true, download })
  const second = await exportJianyingDraft({
    ...commonInput,
    cacheBaseDir: env.cacheBaseDir,
    draftRoot: env.draftRoot,
    install: true,
    download,
    nowMs: 1_760_000_500_000,
  })

  assert.equal(second.folderName, first.folderName)
  assert.equal(second.replacedExisting, true)
  assert.equal(second.createdBackup, false, '原始索引备份只创建一次')

  const folders = (await readdir(env.draftRoot)).filter((name) => name.startsWith('帧心帧意_'))
  assert.deepEqual(folders, [first.folderName])
  const index = JSON.parse(await readFile(path.join(env.draftRoot, INDEX_FILE), 'utf8'))
  assert.equal(index.all_draft_store.length, 2, '索引里我们只占一条')
})

test('export refuses to install without a draft root and requires a cache dir', async (t) => {
  const env = await makeEnv()
  t.after(() => rm(env.base, { recursive: true, force: true }))
  const { download } = fakeDownload()

  await assert.rejects(
    () => exportJianyingDraft({ ...commonInput, cacheBaseDir: env.cacheBaseDir, install: true, download }),
    /draftRoot/,
  )
  await assert.rejects(() => exportJianyingDraft({ ...commonInput, download }), /素材缓存目录/)
})

test('export reuses already materialized media on a second export', async (t) => {
  const env = await makeEnv()
  t.after(() => rm(env.base, { recursive: true, force: true }))
  const { download, calls } = fakeDownload()

  await exportJianyingDraft({ ...commonInput, cacheBaseDir: env.cacheBaseDir, download })
  const secondCalls = []
  const countingDownload = async (args) => {
    // 真实 downloadMediaToFile 会在文件已存在时直接返回，这里模拟同样的短路
    try {
      const existing = await readFile(args.targetPath)
      if (existing.length) return args.targetPath
    } catch {
      // 不存在才真的下
    }
    secondCalls.push(args.sourceUrl)
    return download(args)
  }

  const result = await exportJianyingDraft({ ...commonInput, cacheBaseDir: env.cacheBaseDir, download: countingDownload })
  assert.deepEqual(secondCalls, [], '第二次导出不该重复下载')
  assert.equal(result.media.reused, 3)
  assert.equal(calls.length, 3)
})

test('export derives the canvas from real pixels, not from the declared ratio', async (t) => {
  // 项目 12 真实情况：声明 2.39:1，素材实际 16:9（1312x736 / 1280x720）。
  // 早先按声明走会静默回落成 9:16 竖屏，把横屏素材塞进竖屏画布。
  const env = await makeEnv()
  t.after(() => rm(env.base, { recursive: true, force: true }))
  const { download } = fakeDownload({}, { width: 1312, height: 736 })

  const result = await exportJianyingDraft({
    ...commonInput,
    aspectRatio: '2.39:1',
    cacheBaseDir: env.cacheBaseDir,
    draftRoot: env.draftRoot,
    install: true,
    download,
  })

  assert.equal(result.canvasSource, 'media')
  assert.equal(result.canvas.width, 1312)
  assert.equal(result.canvas.height, 736)
  assert.equal(result.canvas.ratio, '16:9')
  assert.equal(result.declaredAspectRatio, '2.39:1')
  assert.equal(result.draftContent.canvas_config.width, 1312)
  assert.equal(result.canvasProbedFrom, '01_S1-01.mp4')
})

test('export falls back to the declared ratio and says so when nothing can be probed', async (t) => {
  const env = await makeEnv()
  t.after(() => rm(env.base, { recursive: true, force: true }))
  // 写入的不是可识别的媒体头，探测必然失败
  const download = async ({ targetPath }) => {
    await mkdir(path.dirname(targetPath), { recursive: true })
    await writeFile(targetPath, Buffer.from('no recognizable header'))
    return targetPath
  }

  const declared = await exportJianyingDraft({
    ...commonInput,
    aspectRatio: '16:9',
    cacheBaseDir: env.cacheBaseDir,
    draftRoot: env.draftRoot,
    install: true,
    download,
  })
  assert.equal(declared.canvasSource, 'declared')
  assert.equal(declared.canvas.width, 1920)
  assert.equal(declared.canvas.height, 1080)
  assert.equal(declared.canvasProbedFrom, null)

  const unknown = await exportJianyingDraft({
    ...commonInput,
    aspectRatio: '自适应',
    cacheBaseDir: env.cacheBaseDir,
    draftRoot: env.draftRoot,
    install: true,
    download,
  })
  assert.equal(unknown.canvasSource, 'fallback')
  assert.equal(unknown.canvas.declaredRatio, '自适应', '认不出来的比例要留痕，不能静默兜底')
  assert.equal(unknown.canvas.ratio, '9:16')
})

test('draft name is stable and readable', () => {
  assert.equal(buildJianyingDraftName({ projectName: '零点回声', episodeNo: 1 }), '帧心帧意_零点回声 E01')
  assert.equal(buildJianyingDraftName({ projectName: '零点回声', episodeNo: 12 }), '帧心帧意_零点回声 E12')
  assert.equal(buildJianyingDraftName({ projectName: '  ', episodeNo: 0 }), '帧心帧意_未命名项目 E01')
})
