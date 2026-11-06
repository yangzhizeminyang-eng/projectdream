/**
 * 「导出到剪映」的编排层：成片草稿数据 → 素材落地 → 生成明文草稿 → 装进剪映草稿库。
 *
 * 分三步，任何一步失败都留下可诊断的信息，不产生半成品草稿：
 *  1. 空跑一遍生成器，收集这份草稿到底需要哪些本机素材（复用同一套时间线选择逻辑）
 *  2. 落地素材，得到 URL → 本机绝对路径映射
 *  3. 用真实路径再生成一次草稿并安装
 *
 * 素材下载失败不会让整个导出失败：缺的那条会被跳过并记在 `missingMedia` 里，
 * 由界面如实告诉用户「哪几个镜头没进草稿」，而不是写一个打不开的坏路径。
 */

import path from 'node:path'

import { buildJianyingDraft, collectJianyingMediaRequests } from './jianying-draft.mjs'
import { installJianyingDraft } from './jianying-draft-installer.mjs'
import { buildJianyingMediaCacheDir, materializeJianyingMedia } from './jianying-media.mjs'
import { probeMediaDimensions } from './media-probe.mjs'
import {
  encodeStillFrames,
  resolveStillVideoDuration,
  stillVideoFileName,
} from './jianying-still-video.mjs'

export function buildJianyingDraftName({ projectName, episodeNo, suffix = '' }) {
  const episode = String(Math.max(1, Math.trunc(Number(episodeNo) || 1))).padStart(2, '0')
  const base = `帧心帧意_${String(projectName || '未命名项目').trim() || '未命名项目'} E${episode}`
  return `${base}${suffix}`.slice(0, 60)
}

/**
 * 从已落地的素材里探出真实画布尺寸。
 *
 * 项目声明里的 aspectRatio 可能和素材不一致（项目 12 声明 2.39:1、素材实际 16:9），
 * 所以导出前先量一遍真实像素，量不到就交给上层按声明/兜底处理。
 * 静帧也能给出正确比例，所以不区分视频还是图片，按主轨顺序取第一个能量到的。
 */
export async function probeJianyingCanvasFromMedia({
  cacheDir,
  planned = [],
  probe = probeMediaDimensions,
} = {}) {
  if (!cacheDir) return null
  for (const item of planned) {
    const targetName = item?.targetName || item?.fileName
    if (!targetName) continue
    const size = await probe(path.join(cacheDir, targetName))
    if (size?.width > 0 && size?.height > 0) {
      return { ...size, from: item.kind || null, fileName: targetName }
    }
  }
  return null
}

/**
 * @param {object} options
 * @param {string} options.cacheBaseDir 素材缓存根目录（本机）
 * @param {string} [options.draftRoot] 剪映草稿根目录；不传则只生成不安装
 * @param {boolean} [options.install] 是否真的写进剪映草稿库
 */
export async function exportJianyingDraft({
  projectId,
  projectName = '未命名项目',
  episodeNo = 1,
  aspectRatio = null,
  clips = [],
  overlayClips = [],
  audioTracks = {},
  subtitleCues = [],
  cacheBaseDir,
  draftRoot = null,
  install = false,
  draftName = null,
  download,
  onProgress = null,
  storage = null,
  storageKeyFor = null,
  resolveLocalPath = null,
  concurrency = 3,
  /** 静帧转视频的 ffmpeg 执行器注入点（单测用） */
  encodeRun = null,
  stillConcurrency = 2,
  timeoutMs = 300000,
  nowMs = Date.now(),
  draftId = undefined,
} = {}) {
  if (!cacheBaseDir) throw new Error('缺少素材缓存目录')

  const draftInput = { projectName, episodeNo, aspectRatio, clips, overlayClips, audioTracks, subtitleCues }
  const collected = collectJianyingMediaRequests(draftInput)

  const cacheDir = buildJianyingMediaCacheDir({ baseDir: cacheBaseDir, projectId, episodeNo })
  const media = await materializeJianyingMedia({
    requests: collected.requests,
    cacheDir,
    ...(download ? { download } : {}),
    concurrency,
    onProgress,
    timeoutMs,
    storage,
    storageKeyFor,
    resolveLocalPath,
  })

  // 画布跟着真实素材走，而不是跟着项目声明走（两者可能不一致）
  const probedCanvas = await probeJianyingCanvasFromMedia({
    cacheDir,
    planned: media.planned.filter((item) => media.pathByUrl.has(item.url)),
  })

  // 静帧先编码成短 mp4：实测用户那套剪映 6.0.1 会丢弃图片素材段，
  // 只有视频素材能渲染。编码时长取草稿里最长的镜头，避免被截断。
  const stillItems = media.planned
    .filter((item) => item.kind === 'image' && media.pathByUrl.has(item.url))
    .map((item) => ({
      url: item.url,
      label: item.label,
      sourcePath: media.pathByUrl.get(item.url),
      targetPath: path.join(cacheDir, stillVideoFileName(item.targetName)),
    }))
  const stillEncode = stillItems.length
    ? await encodeStillFrames({
        items: stillItems,
        durationSeconds: resolveStillVideoDuration([
          ...(Array.isArray(clips) ? clips.filter((clip) => clip?.enabled !== false).map((clip) => clip.durationSeconds) : []),
          ...(Array.isArray(overlayClips) ? overlayClips.map((overlay) => overlay.durationSeconds) : []),
        ]),
        width: probedCanvas?.width || 1080,
        height: probedCanvas?.height || 1920,
        ...(encodeRun ? { run: encodeRun } : {}),
        concurrency: stillConcurrency,
      })
    : { pathByUrl: new Map(), failed: [], total: 0 }

  // 静帧用编码后的 mp4 路径；编码失败的静帧必须**剔除**而不是回落到原图，
  // 因为 imageAsVideo 模式下剪映会把这条素材当视频读，指向 .png 就是坏路径。
  const stillUrls = new Set(stillItems.map((item) => item.url))
  const resolvedPathFor = (url) => {
    if (!url) return null
    if (stillEncode.pathByUrl.has(url)) return stillEncode.pathByUrl.get(url)
    if (stillUrls.has(url)) return null
    return media.pathByUrl.get(url) ?? null
  }

  const draft = buildJianyingDraft({
    ...draftInput,
    mediaDimensions: probedCanvas,
    imageAsVideo: true,
    mediaPathFor: resolvedPathFor,
  })

  const desiredName = draftName || buildJianyingDraftName({ projectName, episodeNo })
  const result = {
    draftName: desiredName,
    canvas: draft.canvas,
    canvasSource: draft.canvas.source,
    declaredAspectRatio: aspectRatio || null,
    canvasProbedFrom: probedCanvas?.fileName || null,
    totalDurationSeconds: draft.totalDurationSeconds,
    stats: draft.stats,
    stills: {
      total: stillEncode.total,
      encoded: stillEncode.pathByUrl.size,
      failed: stillEncode.failed.map((item) => ({ label: item.label, reason: item.reason })),
    },
    mediaCacheDir: cacheDir,
    media: {
      total: media.total,
      materialized: media.downloaded.length,
      reused: media.reused.length,
      failed: media.failed.map((item) => ({ kind: item.kind, label: item.label, reason: item.reason })),
    },
    installed: false,
    draftDir: null,
    indexEntryCount: null,
    createdBackup: false,
    replacedExisting: false,
    draftContent: draft.draftContent,
    draftMetaInfo: draft.draftMetaInfo,
    draftSettings: draft.draftSettings,
  }

  if (!install) return result

  if (!draftRoot) throw new Error('安装到剪映草稿库需要 draftRoot')

  const installedDraft = await installJianyingDraft({
    draftRoot,
    desiredName,
    draftContent: draft.draftContent,
    draftMetaInfo: draft.draftMetaInfo,
    draftSettings: draft.draftSettings,
    marker: { projectId, episodeNo, projectName, draftName: desiredName, trackCount: draft.draftContent.tracks.length },
    ...(draftId ? { draftId } : {}),
    nowMs,
  })

  return {
    ...result,
    installed: true,
    draftDir: installedDraft.draftDir,
    folderName: installedDraft.folderName,
    draftName: installedDraft.draftName,
    indexEntryCount: installedDraft.indexEntryCount,
    createdBackup: installedDraft.createdBackup,
    replacedExisting: installedDraft.replacedExisting,
  }
}
