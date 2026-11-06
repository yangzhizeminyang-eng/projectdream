import { rm } from 'node:fs/promises'

function parseRate(value) {
  const [numerator, denominator] = String(value || '').split('/').map(Number)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0
  return numerator / denominator
}

function firstVideoFrameHash(output) {
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
  if (!/^[a-f\d]{32}$/iu.test(hash || '')) throw new Error('无法读取视频首帧像素校验值')
  return hash.toLowerCase()
}

export async function replaceVideoFirstFrame({
  videoPath,
  referenceFramePath,
  outputPath,
  referenceRange = 'limited',
  ffmpegBin = 'ffmpeg',
  ffprobeBin = 'ffprobe',
  run,
} = {}) {
  if (typeof run !== 'function') throw new TypeError('缺少媒体命令执行器')
  const range = referenceRange === 'full' ? 'full' : 'limited'
  const colorRange = range === 'full' ? 'pc' : 'tv'
  const videoProbe = await run(ffprobeBin, [
    '-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', videoPath,
  ])
  const frameProbe = await run(ffprobeBin, [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', referenceFramePath,
  ])
  const video = JSON.parse(videoProbe.stdout || '{}').streams?.[0] || {}
  const frame = JSON.parse(frameProbe.stdout || '{}').streams?.[0] || {}
  const width = Number(video.width)
  const height = Number(video.height)
  const fps = parseRate(video.avg_frame_rate || video.r_frame_rate)
  if (!width || !height || !fps || !frame.width || !frame.height) {
    throw new Error('无法读取视频或连续帧的尺寸和帧率')
  }
  if (Number(frame.width) !== width || Number(frame.height) !== height) {
    throw new Error(`上一镜尾帧与本镜视频分辨率不一致（${frame.width}x${frame.height} / ${width}x${height}），无法保证首帧一致`)
  }
  if (width % 2 || height % 2) throw new Error('视频分辨率为奇数，无法无损生成兼容的 yuv420p 首帧')

  const temporaryOutput = `${outputPath}.first-frame.tmp.mp4`
  try {
    await run(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-loop', '1', '-framerate', String(fps), '-i', referenceFramePath,
      '-i', videoPath,
      '-filter_complex', `[0:v]trim=end_frame=1,setpts=PTS-STARTPTS,format=yuv420p,setparams=range=${range}[first];[1:v]trim=start_frame=1,setpts=PTS-STARTPTS,format=yuv420p[rest];[first][rest]concat=n=2:v=1:a=0[outv]`,
      '-map', '[outv]', '-map', '1:a?', '-c:v', 'libx264', '-qp', '0', '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p', '-color_range', colorRange, '-c:a', 'copy', '-movflags', '+faststart', temporaryOutput,
    ])
    const referenceHashOutput = await run(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-i', referenceFramePath,
      '-vf', 'format=yuv420p', '-frames:v', '1', '-f', 'framemd5', '-',
    ])
    const videoHashOutput = await run(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-i', temporaryOutput,
      '-vf', 'format=yuv420p', '-frames:v', '1', '-f', 'framemd5', '-',
    ])
    const referenceHash = firstVideoFrameHash(referenceHashOutput.stdout)
    const videoHash = firstVideoFrameHash(videoHashOutput.stdout)
    if (videoHash !== referenceHash) throw new Error('本镜视频首帧像素校验失败，未保存生成结果')
    return { width, height, fps, frameHash: videoHash, outputPath: temporaryOutput }
  } catch (error) {
    await rm(temporaryOutput, { force: true }).catch(() => {})
    throw error
  }
}
