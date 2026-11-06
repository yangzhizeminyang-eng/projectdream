/**
 * 把静帧编码成短 mp4，让剪映草稿里只出现 `type: "video"` 素材。
 *
 * 为什么不用剪映原生的图片素材：用户实际使用的剪映是破解版 6.0.1（比官方 11.5 旧）。
 * 它虽然认识 `materials.images` 和 `type: "photo"`（我在它的 videoeditor.dll 字符串表里
 * 确认过这两个键都存在），但**实际打开时把 23 个静帧段全部丢掉了**——时间线上只剩那一个
 * 真 mp4，字幕正常。也就是说这一版的静帧解析路径另有要求，且没有文档可依。
 *
 * 与其继续猜它的静态图格式，不如走**已被真机证明能跑通**的路：
 * 视频素材在它那里渲染正常（探针和这次导出的 mp4 都正常）。
 * 静帧编码成等长视频后视觉完全一致，代价很低（实测一张 1280×720、3 秒的图 0.3 秒、78 KB）。
 *
 * 产物按目标文件名缓存，重复导出不会重编码。
 */

import path from 'node:path'
import { spawn } from 'node:child_process'

export const STILL_VIDEO_FPS = 30

/** 默认 ffmpeg 执行器。单测会注入自己的 runner，不真的跑 ffmpeg。 */
export function defaultFfmpegRunner(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        resolve({ code })
        return
      }
      reject(new Error(`${command} failed (${code}): ${stderr.trim().slice(-400)}`))
    })
  })
}

/** 编码时长：取草稿里最长的镜头时长，向上取整到秒并夹在 2–30 秒之间。 */
export function resolveStillVideoDuration(durations = []) {
  const longest = durations.reduce((max, value) => {
    const number = Number(value)
    return Number.isFinite(number) && number > max ? number : max
  }, 0)
  if (!(longest > 0)) return 2
  return Math.min(30, Math.max(2, Math.ceil(longest)))
}

export function stillVideoFileName(sourceName) {
  const base = String(sourceName ?? 'still')
  const extension = path.extname(base)
  const stem = extension ? base.slice(0, -extension.length) : base
  return `${stem}.still.mp4`
}

/**
 * ffmpeg 参数：单张图 → 定长视频。
 * `-loop 1` 让静止图持续输出，`-t` 截断到目标时长；缩放并补边到画布尺寸，
 * 避免剪映再按比例二次缩放。
 */
export function buildStillVideoArgs({ sourcePath, targetPath, durationSeconds, width, height, fps = STILL_VIDEO_FPS }) {
  const scale = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`
  return [
    '-y',
    '-loglevel',
    'error',
    '-loop',
    '1',
    '-i',
    sourcePath,
    '-t',
    String(durationSeconds),
    '-r',
    String(fps),
    '-vf',
    scale,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    targetPath,
  ]
}

/**
 * @param {object} options
 * @param {(command: string, args: string[]) => Promise<unknown>} options.run 注入点，默认由调用方传 ffmpeg 执行器
 */
export async function encodeStillFrameToVideo({
  sourcePath,
  targetPath,
  durationSeconds,
  width,
  height,
  fps = STILL_VIDEO_FPS,
  run = defaultFfmpegRunner,
  ffmpegBin = 'ffmpeg',
  fileExists = null,
} = {}) {
  const hasContent =
    fileExists ||
    (async (filePath) => {
      try {
        const { stat } = await import('node:fs/promises')
        const info = await stat(filePath)
        return info.isFile() && info.size > 0
      } catch {
        return false
      }
    })

  if (await hasContent(targetPath)) return { targetPath, reused: true }
  if (typeof run !== 'function') throw new Error('缺少 ffmpeg 执行器')

  await run(
    ffmpegBin,
    buildStillVideoArgs({ sourcePath, targetPath, durationSeconds, width, height, fps }),
  )
  return { targetPath, reused: false }
}

/**
 * 批量把静帧编码成视频。单张失败不影响整体：失败项留在 `failed` 里，
 * 由调用方从草稿中剔除并如实上报。
 */
export async function encodeStillFrames({
  items = [],
  durationSeconds,
  width,
  height,
  concurrency = 2,
  run = defaultFfmpegRunner,
  ffmpegBin = 'ffmpeg',
  fileExists = null,
  onProgress = null,
} = {}) {
  const results = new Map()
  const failed = []
  let done = 0
  const queue = [...items]

  const worker = async () => {
    while (queue.length) {
      const item = queue.shift()
      try {
        const { targetPath } = await encodeStillFrameToVideo({
          sourcePath: item.sourcePath,
          targetPath: item.targetPath,
          durationSeconds: item.durationSeconds || durationSeconds,
          width,
          height,
          run,
          ffmpegBin,
          fileExists,
        })
        results.set(item.url, targetPath)
      } catch (error) {
        failed.push({
          url: item.url,
          label: item.label || '',
          reason: error instanceof Error ? error.message : 'still encode failed',
        })
      } finally {
        done += 1
        if (typeof onProgress === 'function') onProgress({ done, total: items.length })
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, () => worker())
  await Promise.all(workers)

  return { pathByUrl: results, failed, total: items.length }
}
