import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildStillVideoArgs,
  encodeStillFrameToVideo,
  encodeStillFrames,
  resolveStillVideoDuration,
  stillVideoFileName,
} from './jianying-still-video.mjs'

test('still video duration covers the longest shot and stays in range', () => {
  assert.equal(resolveStillVideoDuration([3, 4, 2.5]), 4)
  assert.equal(resolveStillVideoDuration([4.2]), 5)
  assert.equal(resolveStillVideoDuration([]), 2)
  assert.equal(resolveStillVideoDuration([0.5]), 2)
  assert.equal(resolveStillVideoDuration([99]), 30)
})

test('still video file name keeps the original stem', () => {
  assert.equal(stillVideoFileName('02_S1-02.png'), '02_S1-02.still.mp4')
  assert.equal(stillVideoFileName('no-extension'), 'no-extension.still.mp4')
})

test('ffmpeg args loop the image, clamp the length and normalise the canvas', () => {
  const args = buildStillVideoArgs({
    sourcePath: 'D:\\media\\02_S1-02.png',
    targetPath: 'D:\\media\\02_S1-02.still.mp4',
    durationSeconds: 4,
    width: 1280,
    height: 720,
  })
  assert.ok(args.includes('-loop'))
  assert.ok(args.includes('-t'))
  assert.equal(args[args.indexOf('-t') + 1], '4')
  const filter = args[args.indexOf('-vf') + 1]
  assert.match(filter, /scale=1280:720/)
  assert.match(filter, /pad=1280:720/)
  assert.match(filter, /format=yuv420p/)
  assert.equal(args.at(-1), 'D:\\media\\02_S1-02.still.mp4')
  // -y 放在最前，避免交互确认把导出卡住
  assert.equal(args[0], '-y')
})

test('encode reuses an existing still video instead of re-encoding', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'still-video-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const target = path.join(dir, 'a.still.mp4')
  await writeFile(target, 'already-encoded')

  let ran = 0
  const result = await encodeStillFrameToVideo({
    sourcePath: path.join(dir, 'a.png'),
    targetPath: target,
    durationSeconds: 3,
    width: 1280,
    height: 720,
    run: async () => {
      ran += 1
    },
  })
  assert.equal(result.reused, true)
  assert.equal(ran, 0)
})

test('encode runs ffmpeg when the target is missing and reports failures without throwing', async () => {
  const calls = []
  const ok = await encodeStillFrameToVideo({
    sourcePath: 'C:\\m\\a.png',
    targetPath: 'C:\\m\\a.still.mp4',
    durationSeconds: 3,
    width: 1080,
    height: 1920,
    run: async (bin, args) => {
      calls.push([bin, args])
    },
    fileExists: async () => false,
  })
  assert.equal(ok.reused, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'ffmpeg')

  const batch = await encodeStillFrames({
    items: [
      { url: 'u1', sourcePath: 'C:\\m\\1.png', targetPath: 'C:\\m\\1.still.mp4' },
      { url: 'u2', sourcePath: 'C:\\m\\2.png', targetPath: 'C:\\m\\2.still.mp4' },
    ],
    durationSeconds: 4,
    width: 1280,
    height: 720,
    concurrency: 1,
    fileExists: async () => false,
    run: async (bin, args) => {
      if (String(args.at(-1)).includes('2.still')) throw new Error('ffmpeg failed (1)')
    },
  })
  assert.equal(batch.pathByUrl.size, 1)
  assert.equal(batch.pathByUrl.get('u1'), 'C:\\m\\1.still.mp4')
  assert.deepEqual(batch.failed.map((item) => item.url), ['u2'])
  assert.match(batch.failed[0].reason, /ffmpeg failed/)
})

test('encode surfaces a failing runner instead of pretending success', async () => {
  await assert.rejects(
    () =>
      encodeStillFrameToVideo({
        sourcePath: 'a.png',
        targetPath: 'a.still.mp4',
        durationSeconds: 2,
        width: 100,
        height: 100,
        fileExists: async () => false,
        run: async () => {
          throw new Error('ffmpeg failed (1): boom')
        },
      }),
    /ffmpeg failed/,
  )
})
