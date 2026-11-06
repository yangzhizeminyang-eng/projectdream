/**
 * 把草稿需要的素材落到本机缓存，产出「URL → 本机绝对路径」映射给生成器用。
 *
 * 为什么必须先落地：剪映草稿引用的是**本机绝对路径**，COS 链接它读不了。
 *
 * 复用 `media-download.mjs` 的 downloadMediaToFile，因此：
 * - 已存在的文件直接跳过（重复导出同一集很快）
 * - 支持对象存储直取与本地文件回退
 * 这里只负责「命名、去重、并发、失败记账」，不重复实现下载。
 */

import path from 'node:path'
import { readFile } from 'node:fs/promises'

import { downloadMediaToFile } from './media-download.mjs'

export const JIANYING_MEDIA_DIR_NAME = 'jianying-draft-media'

/** 同一份素材被主轨和画中画共用时，只落一个文件。 */
export function resolveMediaTargetNames(requests = []) {
  const claimed = new Map()
  return requests.map((request) => {
    const base = String(request.fileName || 'media.bin')
    const extension = path.extname(base)
    const stem = extension ? base.slice(0, -extension.length) : base
    let candidate = base
    let index = 1
    while (claimed.has(candidate) && claimed.get(candidate) !== request.url) {
      index += 1
      candidate = `${stem} (${index})${extension}`
    }
    claimed.set(candidate, request.url)
    return { ...request, targetName: candidate }
  })
}

export function buildJianyingMediaCacheDir({ baseDir, projectId, episodeNo }) {
  const safeProject = String(projectId ?? 'unknown').replace(/[^\w.-]+/g, '_')
  const safeEpisode = String(episodeNo ?? 1).replace(/[^\w.-]+/g, '_')
  return path.join(baseDir, JIANYING_MEDIA_DIR_NAME, `project-${safeProject}`, `episode-${safeEpisode}`)
}

/**
 * @param {object} options
 * @param {Array<{url: string, kind: string, fileName: string, label?: string}>} options.requests
 * @param {string} options.cacheDir
 * @param {(args: object) => Promise<string>} [options.download] 注入点，默认走 downloadMediaToFile
 * @param {number} [options.concurrency]
 * @param {(progress: {done: number, total: number, label: string}) => void} [options.onProgress]
 * @param {(filePath: string) => Promise<boolean>} [options.fileExists]
 */
export async function materializeJianyingMedia({
  requests = [],
  cacheDir,
  download = downloadMediaToFile,
  concurrency = 3,
  onProgress = null,
  fileExists = null,
  timeoutMs = 300000,
  storage = null,
  storageKeyFor = null,
  resolveLocalPath = null,
} = {}) {
  if (!cacheDir) throw new Error('缺少素材缓存目录')

  // 和 downloadMediaToFile 的默认判断保持一致：存在且非空才算已落地。
  const pathHasContent =
    fileExists ||
    (async (filePath) => {
      try {
        return (await readFile(filePath)).length > 0
      } catch {
        return false
      }
    })

  // 同一份素材可能同时被主轨和画中画引用（URL 相同、建议文件名不同）。
  // 这里按 URL 先去重，只落一个文件、只下一次，避免白下载一遍。
  const byUrl = new Map()
  for (const request of requests) {
    const key = String(request?.url ?? '').trim()
    if (!key || byUrl.has(key)) continue
    byUrl.set(key, { ...request, url: key })
  }

  const planned = resolveMediaTargetNames([...byUrl.values()])
  const pathByUrl = new Map()
  const downloaded = []
  const reused = []
  const failed = []
  let done = 0

  const queue = [...planned]
  const worker = async () => {
    while (queue.length) {
      const request = queue.shift()
      const targetPath = path.join(cacheDir, request.targetName)
      try {
        // 先自己判一次，才能如实区分「这次真下了」和「复用了上次的」
        const preexisting = await pathHasContent(targetPath)
        await download({
          sourceUrl: request.url,
          targetPath,
          timeoutMs,
          storage,
          storageKey: typeof storageKeyFor === 'function' ? storageKeyFor(request.url) : null,
          resolveLocalPath,
          fileExists: pathHasContent,
        })
        pathByUrl.set(request.url, targetPath)
        if (preexisting) reused.push({ ...request, targetPath })
        else downloaded.push({ ...request, targetPath })
      } catch (error) {
        failed.push({
          ...request,
          reason: error instanceof Error ? error.message : 'download failed',
        })
      } finally {
        done += 1
        if (typeof onProgress === 'function') {
          onProgress({ done, total: planned.length, label: request.label || request.targetName })
        }
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, planned.length || 1)) }, () => worker())
  await Promise.all(workers)

  return {
    cacheDir,
    pathByUrl,
    planned,
    downloaded,
    reused,
    failed,
    total: planned.length,
  }
}
