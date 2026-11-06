import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  buildCinematicAudioFilter,
  buildCinematicVideoFilter,
} from './cinematic-edit-plan.mjs'

const execFileAsync = promisify(execFile)
const ffmpeg = String(process.env.FFMPEG_BIN || 'ffmpeg').trim() || 'ffmpeg'
const ffprobe = String(process.env.FFPROBE_BIN || 'ffprobe').trim() || 'ffprobe'

async function canRun(command) {
  try {
    await execFileAsync(command, ['-version'], { windowsHide: true })
    return true
  } catch {
    return false
  }
}

test('renders mixed transitions when an xfade follows concatenated clips with different frame rates', async (t) => {
  if (!(await canRun(ffmpeg)) || !(await canRun(ffprobe))) {
    t.skip('FFmpeg and FFprobe are required for rendered transition verification')
    return
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'projectdream-cinematic-'))
  try {
    const colors = ['red', 'blue', 'gold', 'green']
    const frameRates = [24, 30, 25, 24]
    const sources = []
    for (const [index, color] of colors.entries()) {
      const sourcePath = path.join(workDir, `source-${index + 1}.mp4`)
      await execFileAsync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `color=c=${color}:s=128x72:r=${frameRates[index]}:d=0.75`,
        '-f', 'lavfi', '-i', `sine=frequency=${440 + index * 110}:sample_rate=48000:duration=0.75`,
        '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '96k', sourcePath,
      ], { windowsHide: true })
      sources.push(sourcePath)
    }

    const clips = [
      { durationSeconds: 0.75, transition: { type: 'cut', durationSeconds: 0 } },
      { durationSeconds: 0.75, transition: { type: 'fade', durationSeconds: 0.12 } },
      { durationSeconds: 0.75, transition: { type: 'cut', durationSeconds: 0 } },
      { durationSeconds: 0.75, transition: { type: 'fade', durationSeconds: 0.12 } },
    ]
    const video = buildCinematicVideoFilter({ clips })
    const audio = buildCinematicAudioFilter({ clips })
    const outputPath = path.join(workDir, 'mixed-transition.mp4')
    await execFileAsync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      ...sources.flatMap((source) => ['-i', source]),
      '-filter_complex', `${video.filterComplex};${audio.filterComplex}`,
      '-map', video.outputLabel, '-map', audio.outputLabel,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', outputPath,
    ], { windowsHide: true })

    const outputStats = await stat(outputPath)
    assert.ok(outputStats.size > 0, 'FFmpeg should produce a non-empty output file')
    const { stdout } = await execFileAsync(ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', outputPath,
    ], { windowsHide: true })
    const probe = JSON.parse(stdout)
    const durationSeconds = Number(probe.format?.duration)
    assert.ok(durationSeconds > 2.7 && durationSeconds < 2.85, `unexpected output duration: ${durationSeconds}`)
    assert.ok(probe.streams?.some((stream) => stream.codec_type === 'video'))
    assert.ok(probe.streams?.some((stream) => stream.codec_type === 'audio'))
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
})
