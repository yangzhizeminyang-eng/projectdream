import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { replaceVideoFirstFrame } from './video-first-frame.mjs'

function firstVideoFrameHash(output) {
  const lines = String(output || '').split(/\r?\n/u)
  const videoStreamIndex = lines.find((line) => /^#media_type \d+: video$/u.test(line))?.match(/^#media_type (\d+): video$/u)?.[1]
  const frame = lines.find((line) => !line.startsWith('#') && line && line.split(',')[0].trim() === videoStreamIndex)
  const hash = frame?.split(',').at(-1)?.trim()
  assert.match(hash || '', /^[a-f\d]{32}$/iu)
  return hash.toLowerCase()
}

test('continuity video replaces its first decoded frame and verifies matching pixels', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'projectdream-first-frame-'))
  const videoPath = path.join(directory, 'input.mp4')
  const referenceFramePath = path.join(directory, 'reference.jpg')
  const outputPath = path.join(directory, 'output.mp4')
  await writeFile(videoPath, 'original-video')
  await writeFile(referenceFramePath, 'confirmed-tail-frame')

  const commands = []
  const run = async (_command, args) => {
    commands.push(args)
    if (args.includes('-show_streams')) {
      return {
        stdout: JSON.stringify({
          streams: [{ codec_type: 'video', width: 720, height: 1280, r_frame_rate: '24/1', avg_frame_rate: '24/1' }],
        }),
      }
    }
    if (args.includes('-show_entries')) {
      return { stdout: JSON.stringify({ streams: [{ width: 720, height: 1280 }] }) }
    }
    if (args.includes('framemd5')) {
      const sourceIsImage = args.includes(referenceFramePath)
      return { stdout: `#framemd5\n#media_type 0: video\n0, 0, 0, 1, 1382400, ${sourceIsImage ? '0123456789abcdef0123456789abcdef' : '0123456789abcdef0123456789abcdef'}\n` }
    }
    if (args.includes('-filter_complex')) {
      const target = args.at(-1)
      await writeFile(target, 'replaced-video')
      return { stdout: '', stderr: '' }
    }
    throw new Error(`Unexpected ffmpeg call: ${args.join(' ')}`)
  }

  try {
    const result = await replaceVideoFirstFrame({
      videoPath,
      referenceFramePath,
      outputPath,
      run,
    })

    assert.equal(result.width, 720)
    assert.equal(result.height, 1280)
    assert.equal(await readFile(result.outputPath, 'utf8'), 'replaced-video')
    assert.ok(commands.some((args) => args.includes('-qp') && args.includes('0')))
    assert.ok(commands.some((args) => args.includes('framemd5')))
    assert.ok(commands.some((args) => args.includes('-map') && args.includes('1:a?')))
    assert.ok(commands.some((args) => args.includes('-c:a') && args.includes('copy')))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('continuity video is rejected when the decoded first-frame pixels differ', async () => {
  const commands = []
  const run = async (_command, args) => {
    commands.push(args)
    if (args.includes('-show_streams')) {
      return { stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 720, height: 1280, r_frame_rate: '24/1' }] }) }
    }
    if (args.includes('-show_entries')) return { stdout: JSON.stringify({ streams: [{ width: 720, height: 1280 }] }) }
    if (args.includes('framemd5')) {
      return { stdout: `#framemd5\n#media_type 0: video\n0, 0, 0, 1, 1382400, ${args.includes('reference.jpg') ? '0123456789abcdef0123456789abcdef' : 'fedcba9876543210fedcba9876543210'}\n` }
    }
    if (args.includes('-filter_complex')) return { stdout: '', stderr: '' }
    throw new Error(`Unexpected ffmpeg call: ${args.join(' ')}`)
  }

  await assert.rejects(
    replaceVideoFirstFrame({ videoPath: 'video.mp4', referenceFramePath: 'reference.jpg', outputPath: 'output.mp4', run }),
    /像素校验失败/,
  )
  assert.equal(commands.filter((args) => args.includes('framemd5')).length, 2)
})

test('continuity frame with a different resolution fails closed before transcoding', async () => {
  const commands = []
  const run = async (_command, args) => {
    commands.push(args)
    if (args.includes('-show_streams')) {
      return { stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 720, height: 1280, r_frame_rate: '24/1' }] }) }
    }
    return { stdout: JSON.stringify({ streams: [{ width: 1024, height: 1024 }] }) }
  }

  await assert.rejects(
    replaceVideoFirstFrame({ videoPath: 'video.mp4', referenceFramePath: 'reference.jpg', outputPath: 'output.mp4', run }),
    /分辨率不一致/,
  )
  assert.equal(commands.some((args) => args.includes('-filter_complex')), false)
})

test('real ffmpeg output preserves a full-range JPEG reference frame exactly', async (t) => {
  const execFileAsync = promisify(execFile)
  const ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg'
  const ffprobeBin = process.env.FFPROBE_BIN || 'ffprobe'
  try {
    await execFileAsync(ffmpegBin, ['-version'])
    await execFileAsync(ffprobeBin, ['-version'])
  } catch {
    t.skip('ffmpeg and ffprobe are required for media integration coverage')
    return
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), 'projectdream-first-frame-real-'))
  const videoPath = path.join(directory, 'input.mp4')
  const referenceFramePath = path.join(directory, 'reference.jpg')
  const outputPath = path.join(directory, 'output.mp4')
  const run = async (command, args) => {
    const result = await execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024 })
    return { stdout: result.stdout, stderr: result.stderr }
  }

  try {
    await run(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=1',
      '-frames:v', '1', referenceFramePath,
    ])
    await run(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=24:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=32000:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', videoPath,
    ])

    const result = await replaceVideoFirstFrame({
      videoPath,
      referenceFramePath,
      outputPath,
      referenceRange: 'full',
      ffmpegBin,
      ffprobeBin,
      run,
    })
    const referenceHash = firstVideoFrameHash((await run(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-i', referenceFramePath,
      '-vf', 'format=yuv420p', '-frames:v', '1', '-f', 'framemd5', '-',
    ])).stdout)
    const outputHash = firstVideoFrameHash((await run(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-i', result.outputPath,
      '-vf', 'format=yuv420p', '-frames:v', '1', '-f', 'framemd5', '-',
    ])).stdout)

    assert.equal(outputHash, referenceHash)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('real ffmpeg preserves a limited-range TIFF reference frame exactly', async (t) => {
  const execFileAsync = promisify(execFile)
  const ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg'
  const ffprobeBin = process.env.FFPROBE_BIN || 'ffprobe'
  try {
    await execFileAsync(ffmpegBin, ['-version'])
    await execFileAsync(ffprobeBin, ['-version'])
  } catch {
    t.skip('ffmpeg and ffprobe are required for media integration coverage')
    return
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'projectdream-first-frame-tiff-'))
  const videoPath = path.join(directory, 'input.mp4')
  const referenceFramePath = path.join(directory, 'reference.tiff')
  const outputPath = path.join(directory, 'output.mp4')
  const run = async (command, args) => {
    const result = await execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024 })
    return { stdout: result.stdout, stderr: result.stderr }
  }
  try {
    await run(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'testsrc2=s=64x64:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath,
    ])
    await run(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath,
      '-vf', 'select=eq(n\\,0)', '-vsync', '0', '-frames:v', '1',
      '-pix_fmt', 'yuv420p', '-compression_algo', 'deflate', referenceFramePath,
    ])
    const result = await replaceVideoFirstFrame({
      videoPath,
      referenceFramePath,
      outputPath,
      ffmpegBin,
      ffprobeBin,
      run,
    })
    const referenceHash = firstVideoFrameHash((await run(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-i', referenceFramePath,
      '-vf', 'format=yuv420p', '-frames:v', '1', '-f', 'framemd5', '-',
    ])).stdout)
    const outputHash = firstVideoFrameHash((await run(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-i', result.outputPath,
      '-vf', 'format=yuv420p', '-frames:v', '1', '-f', 'framemd5', '-',
    ])).stdout)
    assert.equal(outputHash, referenceHash)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('worker passes the continuity snapshot into generated-video persistence', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../index.mjs', import.meta.url), 'utf8')
  const persistStart = source.indexOf('async function persistGeneratedVideo')
  const persistEnd = source.indexOf('\nfunction exportResolution', persistStart)
  const persist = source.slice(persistStart, persistEnd)
  const callIndex = source.indexOf('await persistGeneratedVideo({', source.indexOf('async function processVideoGenerationJob'))
  const call = source.slice(callIndex, source.indexOf('\n        })', callIndex))

  assert.match(persist, /frameReferences\?\.continuityEnabled/)
  assert.match(source, /import\s*\{[^}]*\brename\b[^}]*\brm\b[^}]*\}\s*from\s*['"]node:fs\/promises['"]/u)
  assert.match(persist, /已启用镜头连续性，但缺少上一镜确认尾帧/)
  assert.match(persist, /objectStorage\.getObject\(referenceStorageKey\)/u)
  assert.match(persist, /replaceVideoFirstFrame\(/u)
  assert.match(persist, /startFrameStorageKey/u)
  assert.match(persist, /storedReference\.bytes/u)
  assert.match(persist, /continuityResult\.outputPath/u)
  assert.match(persist, /continuityEvidence\s*=\s*\{[^}]*frameHash:\s*continuityResult\.frameHash/su)
  assert.match(persist, /qualityReport\.continuity\s*=\s*continuityEvidence/u)
  assert.ok(persist.indexOf('replaceVideoFirstFrame(') < persist.indexOf('objectStorage.putObject({'))
  assert.match(call, /frameReferences: request\.frameReferences/)
})
