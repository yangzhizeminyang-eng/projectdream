import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import test from 'node:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { extractExactLastFrame, replaceVideoLastFrame } from './video-last-frame.mjs'

const execFileAsync = promisify(execFile)

function frameHash(output) {
  const lines = String(output || '').split(/\r?\n/u)
  const videoStreamIndex = lines
    .find((line) => /^#media_type \d+: video$/u.test(line))
    ?.match(/^#media_type (\d+): video$/u)?.[1]
  const line = lines.find((item) => (
    item && !item.startsWith('#') && item.split(',')[0].trim() === videoStreamIndex
  ))
  const hash = line?.split(',').at(-1)?.trim()
  assert.match(hash || '', /^[a-f\d]{32}$/iu)
  return hash.toLowerCase()
}

async function command(commandName, args) {
  const result = await execFileAsync(commandName, args, { maxBuffer: 16 * 1024 * 1024 })
  return { stdout: result.stdout, stderr: result.stderr }
}

test('real ffmpeg replaces the exact last frame and keeps the frame count', async (t) => {
  const ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg'
  const ffprobeBin = process.env.FFPROBE_BIN || 'ffprobe'
  try {
    await execFileAsync(ffmpegBin, ['-version'])
    await execFileAsync(ffprobeBin, ['-version'])
  } catch {
    t.skip('ffmpeg and ffprobe are required for media integration coverage')
    return
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'projectdream-last-frame-'))
  const videoPath = path.join(directory, 'input.mp4')
  const referenceFramePath = path.join(directory, 'reference.png')
  const outputPath = path.join(directory, 'output.mp4')
  try {
    await command(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=30:d=0.4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath,
    ])
    await command(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=magenta:s=64x64:r=30:d=0.1',
      '-frames:v', '1', referenceFramePath,
    ])
    const result = await replaceVideoLastFrame({
      videoPath,
      referenceFramePath,
      outputPath,
      ffmpegBin,
      ffprobeBin,
      run: command,
    })
    assert.equal(result.width, 64)
    assert.equal(result.height, 64)
    assert.equal(result.frameCount, 12)

    const referenceHash = frameHash((await command(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-i', referenceFramePath,
      '-vf', 'format=yuv420p', '-frames:v', '1', '-f', 'framemd5', '-',
    ])).stdout)
    const outputHash = frameHash((await command(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-i', result.outputPath,
      '-vf', `select=eq(n\\,${result.frameCount - 1}),format=yuv420p`, '-vsync', '0',
      '-frames:v', '1', '-f', 'framemd5', '-',
    ])).stdout)
    assert.equal(outputHash, referenceHash)

    const extractionPath = path.join(directory, 'extracted.png')
    const extracted = await extractExactLastFrame({
      videoPath: result.outputPath,
      outputPath: extractionPath,
      ffmpegBin,
      ffprobeBin,
      run: command,
    })
    assert.equal(extracted.frameCount, result.frameCount)
    assert.equal(extracted.lastIndex, result.frameCount - 1)
    const extractionStat = await stat(extractionPath)
    assert.ok(extractionStat.size > 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('last-frame replacement fails closed when the reference resolution differs', async () => {
  const run = async (commandName, args) => {
    if (args.includes('-show_entries')) {
      const isReference = args.includes('reference.png')
      return {
        stdout: JSON.stringify({
          streams: [isReference
            ? { width: 32, height: 32 }
            : { width: 64, height: 64, avg_frame_rate: '30/1', nb_frames: '10' }],
        }),
      }
    }
    throw new Error(`unexpected command ${commandName} ${args.join(' ')}`)
  }
  await assert.rejects(
    replaceVideoLastFrame({
      videoPath: 'video.mp4',
      referenceFramePath: 'reference.png',
      outputPath: 'output.mp4',
      run,
    }),
    /分辨率不一致/u,
  )
})

test('missing media executor is rejected before touching files', async () => {
  await assert.rejects(replaceVideoLastFrame({}), /缺少媒体命令执行器/u)
})
