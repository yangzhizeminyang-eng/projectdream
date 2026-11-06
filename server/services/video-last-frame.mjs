import { rm } from 'node:fs/promises'

function parseRate(value) {
  const [numerator, denominator] = String(value || '').split('/').map(Number)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0
  return numerator / denominator
}

function parseFrameHash(output) {
  const lines = String(output || '').split(/\r?\n/u)
  const videoStreamIndex = lines
    .find((line) => /^#media_type \d+: video$/u.test(line))
    ?.match(/^#media_type (\d+): video$/u)?.[1]
  const line = lines.find((item) => (
    item
    && !item.startsWith('#')
    && item.split(',')[0].trim() === videoStreamIndex
  ))
  const hash = line?.split(',').at(-1)?.trim()
  if (!/^[a-f\d]{32}$/iu.test(hash || '')) throw new Error('无法读取视频末帧像素校验值')
  return hash.toLowerCase()
}

async function probeStream(run, ffprobeBin, filePath) {
  const result = await run(ffprobeBin, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,duration',
    '-of', 'json', filePath,
  ])
  return JSON.parse(result.stdout || '{}').streams?.[0] || {}
}

async function resolveFrameCount(run, ffprobeBin, filePath, stream) {
  const declared = Number(stream.nb_frames)
  if (Number.isInteger(declared) && declared > 0) return declared
  const counted = await run(ffprobeBin, [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=nb_read_frames', '-of', 'json', filePath,
  ])
  const read = Number(JSON.parse(counted.stdout || '{}').streams?.[0]?.nb_read_frames)
  if (Number.isInteger(read) && read > 0) return read
  const duration = Number(stream.duration)
  const fps = parseRate(stream.avg_frame_rate || stream.r_frame_rate)
  if (Number.isFinite(duration) && duration > 0 && fps > 0) {
    return Math.max(1, Math.round(duration * fps))
  }
  throw new Error('无法确定视频总帧数，拒绝执行末帧替换')
}

export async function replaceVideoLastFrame({
  videoPath,
  referenceFramePath,
  outputPath,
  ffmpegBin = 'ffmpeg',
  ffprobeBin = 'ffprobe',
  run,
} = {}) {
  if (typeof run !== 'function') throw new TypeError('缺少媒体命令执行器')
  const video = await probeStream(run, ffprobeBin, videoPath)
  const frame = await probeStream(run, ffprobeBin, referenceFramePath)
  const width = Number(video.width)
  const height = Number(video.height)
  const fps = parseRate(video.avg_frame_rate || video.r_frame_rate)
  if (!width || !height || !fps || !frame.width || !frame.height) {
    throw new Error('无法读取视频或连续帧的尺寸和帧率')
  }
  if (Number(frame.width) !== width || Number(frame.height) !== height) {
    throw new Error(`连续帧与视频分辨率不一致（${frame.width}x${frame.height} / ${width}x${height}），无法保证末帧一致`)
  }
  if (width % 2 || height % 2) throw new Error('视频分辨率为奇数，无法无损生成兼容的 yuv420p 末帧')
  const frameCount = await resolveFrameCount(run, ffprobeBin, videoPath, video)
  const lastIndex = Math.max(0, frameCount - 1)

  const temporaryOutput = `${outputPath}.last-frame.tmp.mp4`
  try {
    await run(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', videoPath,
      '-loop', '1', '-framerate', String(fps), '-i', referenceFramePath,
      '-filter_complex', `[0:v]trim=end_frame=${lastIndex},setpts=PTS-STARTPTS,format=yuv420p[body];[1:v]trim=end_frame=1,setpts=PTS-STARTPTS,format=yuv420p[edge];[body][edge]concat=n=2:v=1:a=0[outv]`,
      '-map', '[outv]', '-map', '0:a?', '-c:v', 'libx264', '-qp', '0', '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', temporaryOutput,
    ])
    const referenceHashOutput = await run(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-i', referenceFramePath,
      '-vf', 'format=yuv420p', '-frames:v', '1', '-f', 'framemd5', '-',
    ])
    const videoHashOutput = await run(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-i', temporaryOutput,
      '-vf', `select=eq(n\\,${lastIndex}),format=yuv420p`, '-vsync', '0',
      '-frames:v', '1', '-f', 'framemd5', '-',
    ])
    const referenceHash = parseFrameHash(referenceHashOutput.stdout)
    const videoHash = parseFrameHash(videoHashOutput.stdout)
    if (videoHash !== referenceHash) throw new Error('本镜视频末帧像素校验失败，未保存生成结果')
    await rm(outputPath, { force: true })
    return { width, height, fps, frameCount, frameHash: videoHash, outputPath: temporaryOutput }
  } catch (error) {
    await rm(temporaryOutput, { force: true }).catch(() => {})
    throw error
  }
}

export async function extractExactLastFrame({
  videoPath,
  outputPath,
  ffmpegBin = 'ffmpeg',
  ffprobeBin = 'ffprobe',
  run,
} = {}) {
  if (typeof run !== 'function') throw new TypeError('缺少媒体命令执行器')
  const video = await probeStream(run, ffprobeBin, videoPath)
  const frameCount = await resolveFrameCount(run, ffprobeBin, videoPath, video)
  const lastIndex = Math.max(0, frameCount - 1)
  await run(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath,
    '-vf', `select=eq(n\\,${lastIndex})`, '-vsync', '0', '-frames:v', '1',
    // TIFF with yuv420p is lossless in the source colour space. PNG/JPEG
    // round-trip through RGB and change decoded pixel hashes.
    '-pix_fmt', 'yuv420p', '-compression_algo', 'deflate', outputPath,
  ])
  return { frameCount, lastIndex }
}
