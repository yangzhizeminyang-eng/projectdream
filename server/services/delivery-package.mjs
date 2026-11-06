/**
 * 交付包（A 档）：把成片草稿整理成「可以直接拖进剪映/Kdenlive/DaVinci」的素材集合。
 *
 * 设计边界：
 * - 只读草稿，不复制、不覆盖、不删除任何原始素材和历史候选。
 * - 素材按时间线顺序编号（01_、02_…），文件管理器里按名称排序就是成片顺序。
 * - 字幕导出标准 SRT；音频按轨道分目录、带轨道前缀。
 * - 这里的输出是「交接材料」，不是最终成片；精细剪辑在外部 NLE 里做。
 */

export const DELIVERY_AUDIO_TRACKS = [
  { key: 'dialogue', label: '对白', prefix: 'DLG' },
  { key: 'narration', label: '旁白', prefix: 'NAR' },
  { key: 'music', label: '音乐', prefix: 'MUS' },
  { key: 'sfx', label: '音效', prefix: 'SFX' },
]

/** 各比例对应的画布像素，用于告知外部 NLE 该建多大的序列。 */
export const DELIVERY_CANVAS_PRESETS = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '4:3': { width: 1440, height: 1080 },
  '1:1': { width: 1080, height: 1080 },
  '3:4': { width: 1080, height: 1440 },
}

function pad2(value) {
  return String(Math.max(0, Math.trunc(Number(value) || 0))).padStart(2, '0')
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

import { canvasFromRatioLabel } from './media-probe.mjs'

function round3(value) {
  return Number(finiteNumber(value, 0).toFixed(3))
}

/**
 * 文件名清洗：去掉 Windows/macOS 都不接受的字符，避免导出的包在解压时炸掉。
 * 注意不要动中文、韩文、日文和空格。
 */
export function sanitizeDeliveryName(value, fallback = 'clip') {
  const text = String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, 48).trim() || fallback
}

export function deliveryClipIdentity(clip) {
  const clipId = String(clip?.clipId || '').trim()
  if (clipId) return clipId
  const storyboardId = Math.trunc(finiteNumber(clip?.storyboardId, 0))
  return storyboardId > 0 ? `storyboard-${storyboardId}` : ''
}

export function resolveDeliveryCanvas(aspectRatio) {
  // 预置比例优先；`2.39:1` 这类没进预置表的也要实算，不能静默回落成 9:16。
  const resolved = canvasFromRatioLabel(aspectRatio, { presets: DELIVERY_CANVAS_PRESETS })
  if (resolved) return resolved
  return { ratio: '9:16', width: 1080, height: 1920, declaredRatio: String(aspectRatio ?? '').trim() || null }
}

function videoExtension(url) {
  const match = String(url ?? '').match(/\.(mp4|mov|webm|mkv|m4v)(?:\?|#|$)/i)
  return match ? `.${match[1].toLowerCase()}` : '.mp4'
}

/** 静帧素材的后缀。项目里静帧通常是 PNG，但也要认 jpg/webp。 */
function imageExtension(url) {
  const match = String(url ?? '').match(/\.(png|jpe?g|webp|bmp|gif)(?:\?|#|$)/i)
  return match ? `.${match[1].toLowerCase()}` : '.png'
}

function audioExtension(url) {
  const match = String(url ?? '').match(/\.(mp3|wav|m4a|aac|flac|ogg)(?:\?|#|$)/i)
  return match ? `.${match[1].toLowerCase()}` : '.mp3'
}

/**
 * 时间线只按「启用的片段 + 草稿顺序」排布，和编辑器里的播放头逻辑保持一致。
 */
export function buildDeliveryTimeline(clips = []) {
  const ordered = []
  const startsByClipId = new Map()
  let cursor = 0

  for (const clip of Array.isArray(clips) ? clips : []) {
    if (clip?.enabled === false) continue
    const clipId = deliveryClipIdentity(clip)
    const durationSeconds = Math.max(0, finiteNumber(clip?.durationSeconds, 0))
    const startSeconds = round3(cursor)
    const endSeconds = round3(cursor + durationSeconds)
    startsByClipId.set(clipId, startSeconds)
    ordered.push({ clip, clipId, startSeconds, endSeconds, durationSeconds: round3(durationSeconds) })
    cursor += durationSeconds
  }

  return {
    ordered,
    startsByClipId,
    totalDurationSeconds: round3(cursor),
  }
}

/** SRT 时间码：HH:MM:SS,mmm */
export function formatSrtTimestamp(seconds) {
  const total = Math.max(0, finiteNumber(seconds, 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = Math.floor(total % 60)
  const millis = Math.round((total - Math.floor(total)) * 1000)
  const safeMillis = millis === 1000 ? 999 : millis
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)},${String(safeMillis).padStart(3, '0')}`
}

export function buildDeliverySrt(cues = []) {
  const blocks = []
  for (const [index, cue] of (Array.isArray(cues) ? cues : []).entries()) {
    const text = String(cue?.text ?? '').trim()
    if (!text) continue
    const startSeconds = Math.max(0, finiteNumber(cue?.startSeconds, 0))
    const endSeconds = Math.max(startSeconds + 0.2, finiteNumber(cue?.endSeconds, startSeconds + 1))
    blocks.push(
      `${index + 1}\n${formatSrtTimestamp(startSeconds)} --> ${formatSrtTimestamp(endSeconds)}\n${text}`,
    )
  }
  return blocks.length ? `${blocks.join('\n\n')}\n` : ''
}

function csvCell(value) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function csvRow(cells) {
  return cells.map(csvCell).join(',')
}

export function buildDeliveryCsv(manifest) {
  const lines = [
    csvRow([
      '类型',
      '序号',
      '文件名',
      '场景',
      '镜头',
      '时间线起点(秒)',
      '时间线终点(秒)',
      '时长(秒)',
      '源入点(秒)',
      '源出点(秒)',
      '说明',
    ]),
  ]

  for (const clip of manifest.clips) {
    lines.push(
      csvRow([
        clip.sourceKind === 'image' ? '静帧' : '视频',
        clip.index,
        clip.fileName,
        clip.sceneNo == null ? '' : `S${pad2(clip.sceneNo)}`,
        clip.shotNo || '',
        clip.startSeconds,
        clip.endSeconds,
        clip.durationSeconds,
        clip.trimStartSeconds,
        clip.trimEndSeconds,
        clip.sceneTitle || '',
      ]),
    )
  }

  for (const track of manifest.audioTracks) {
    for (const item of track.items) {
      lines.push(
        csvRow([
          `音频-${track.label}`,
          item.index,
          item.fileName,
          '',
          '',
          item.startSeconds,
          item.endSeconds,
          item.durationSeconds,
          '',
          '',
          item.title || '',
        ]),
      )
    }
  }

  for (const cue of manifest.subtitles) {
    lines.push(
      csvRow([
        '字幕',
        cue.index,
        'subtitles.srt',
        '',
        '',
        cue.startSeconds,
        cue.endSeconds,
        round3(cue.endSeconds - cue.startSeconds),
        '',
        '',
        cue.text,
      ]),
    )
  }

  return `\uFEFF${lines.join('\r\n')}\r\n`
}

export function buildDeliveryReadme(manifest) {
  const { canvas, totals } = manifest
  const lines = [
    `# ${manifest.projectName}｜第 ${manifest.episodeNo} 集 交付包`,
    '',
    `- 生成时间：${manifest.generatedAt}`,
    `- 画布比例：${canvas.ratio}（${canvas.width}×${canvas.height}）`,
    `- 成片时长：${manifest.totalDurationSeconds}s（启用 ${totals.clipCount} 个镜头 / 共 ${totals.totalClipCount} 个）`,
    `- 字幕：${totals.subtitleCount} 条｜音频：${totals.audioCount} 条`,
    '',
    '## 目录结构',
    '',
    '```',
    'materials/      按时间线顺序命名的镜头视频（01_ 开头，按文件名排序即成片顺序）',
    'audio/<轨道>/   分离音轨（对白 / 旁白 / 音乐 / 音效）',
    'subtitles.srt   字幕，可直接导入文本轨',
    '剪辑说明.csv     每个素材的时间线起点终点、源入点出点',
    'README.md       本文件',
    '```',
    '',
    '## 在剪映里怎么用（约 30 秒）',
    '',
    `1. 打开剪映专业版 → 新建草稿 → 画布比例设为 **${canvas.ratio}**。`,
    '2. 素材区「导入」→ 选中 `materials/` 里全部文件 → 一次性拖到主轨（顺序已按文件名排好）。',
    '3. 音频：把 `audio/` 下各轨文件导入，分别拖到对应音轨。',
    '4. 字幕：文本 → 智能字幕 → 导入字幕 → 选择 `subtitles.srt`。',
    '5. 转场、特效、画中画、调色、声音设计都在这里做。',
    '',
    '## 边界说明',
    '',
    '- 镜头顺序、启用状态、裁切入点、字幕时序都来自项目里的成片草稿，导出不会修改它们。',
    '- 原始素材和历史候选没有被覆盖或删除，这里只是引用副本。',
    '- 需要裁切的镜头：用 `剪辑说明.csv` 里的「源入点/源出点」在 NLE 里精确定位。',
  ]

  if (manifest.unmatchedAudioCount > 0) {
    lines.push(
      '',
      `> 注意：还有 ${manifest.unmatchedAudioCount} 条对白/旁白没有对应的已确认画面，未包含在本交付包里。`,
    )
  }
  if (manifest.orphanAudioCount > 0) {
    lines.push(
      '',
      `> 注意：有 ${manifest.orphanAudioCount} 条音频挂在没进时间线的镜头上（镜头被停用或不在成片顺序里），已从交付包剔除，避免声音跑到成片开头。`,
    )
  }
  if (manifest.orphanSubtitleCount > 0) {
    lines.push(
      '',
      `> 注意：有 ${manifest.orphanSubtitleCount} 条字幕对应的镜头不在时间线上，已从交付包剔除；请先在编辑器里确认这些镜头。`,
    )
  }
  if (manifest.overlayClipCount > 0) {
    lines.push(
      '',
      `> 注意：画中画轨道有 ${manifest.overlayClipCount} 个片段，本项目导出合成尚未接入，交付包里没有包含；请在本集素材上手动叠加。`,
    )
  }

  return `${lines.join('\n')}\n`
}

/**
 * 生成交付清单。输入全部来自成片草稿，函数本身不碰数据库和文件系统。
 */
export function buildDeliveryManifest({
  projectId = 0,
  projectName = '未命名项目',
  episodeNo = 1,
  aspectRatio = null,
  generatedAt = new Date().toISOString(),
  videoClips = [],
  audioTracks = {},
  subtitleCues = [],
  unmatchedAudioCount = 0,
  overlayClipCount = 0,
} = {}) {
  const timeline = buildDeliveryTimeline(videoClips)
  const canvas = resolveDeliveryCanvas(aspectRatio)
  const episodeTag = `E${pad2(episodeNo)}`

  const clips = timeline.ordered.map((entry, index) => {
    const clip = entry.clip
    const sceneNo = Math.trunc(finiteNumber(clip?.sceneNo, 0)) || null
    const shotNo = sanitizeDeliveryName(clip?.shotNo, '')
    const sceneTitle = sanitizeDeliveryName(clip?.sceneTitle, '')
    const shotTag = shotNo || `SHOT${Math.trunc(finiteNumber(clip?.storyboardId, 0))}`
    const parts = [
      pad2(index + 1),
      `${episodeTag}-S${pad2(sceneNo ?? 0)}${shotTag ? `-${shotTag}` : ''}`,
      sceneTitle,
    ].filter(Boolean)

    // 真实镜头里静帧和视频混着出现（项目 12 有 23/24 是静帧 PNG）。
    // 后缀必须跟着**实际素材**走，不能一律按 videoUrl 推断成 .mp4，
    // 否则交付包里会出现「后缀是 mp4、内容其实是 PNG」的文件。
    const sourceUrl = clip?.videoUrl || clip?.imageUrl || null
    const sourceKind = clip?.videoUrl ? 'video' : clip?.imageUrl ? 'image' : 'unknown'
    const extension = sourceKind === 'image' ? imageExtension(clip?.imageUrl) : videoExtension(clip?.videoUrl)

    return {
      index: index + 1,
      fileName: `${sanitizeDeliveryName(parts.join('_'))}${extension}`,
      archivePath: `materials/${sanitizeDeliveryName(parts.join('_'))}${extension}`,
      clipId: entry.clipId,
      storyboardId: Math.trunc(finiteNumber(clip?.storyboardId, 0)),
      sceneNo,
      sceneTitle: clip?.sceneTitle || '',
      shotNo: clip?.shotNo || '',
      startSeconds: entry.startSeconds,
      endSeconds: entry.endSeconds,
      durationSeconds: entry.durationSeconds,
      trimStartSeconds: round3(clip?.trimStartSeconds),
      trimEndSeconds: round3(clip?.trimEndSeconds ?? clip?.sourceDurationSeconds ?? clip?.durationSeconds),
      sourceDurationSeconds: round3(clip?.sourceDurationSeconds),
      sourceKind,
      sourceUrl,
    }
  })

  const orphanAudioCount = { value: 0 }
  const normalizedAudioTracks = DELIVERY_AUDIO_TRACKS.map((track) => {
    const items = (Array.isArray(audioTracks?.[track.key]) ? audioTracks[track.key] : [])
      .filter((item) => item?.enabled !== false)
      .map((item, index) => {
        const storyboardId = Math.trunc(finiteNumber(item?.storyboardId, 0))
        const clipId = storyboardId > 0 ? `storyboard-${storyboardId}` : ''
        // 挂在「没进时间线」的镜头上时不能落到 0 秒，否则声音会跑到成片开头。
        const anchored = storyboardId > 0 ? timeline.startsByClipId.get(clipId) : 0
        if (storyboardId > 0 && anchored === undefined) {
          orphanAudioCount.value += 1
          return null
        }
        const anchorStart = anchored ?? 0
        const startSeconds = round3(Math.max(0, anchorStart + finiteNumber(item?.startOffsetSeconds, 0)))
        const durationSeconds = round3(Math.max(0, finiteNumber(item?.durationSeconds, 0)))
        const title = sanitizeDeliveryName(item?.title, `${track.label}${index + 1}`)
        const fileName = `${pad2(index + 1)}_${episodeTag}_${track.prefix}_${title}${audioExtension(item?.audioUrl)}`
        return {
          index: index + 1,
          audioId: Math.trunc(finiteNumber(item?.id, 0)),
          storyboardId,
          title: item?.title || '',
          startSeconds,
          endSeconds: round3(startSeconds + durationSeconds),
          durationSeconds,
          fileName,
          archivePath: `audio/${track.label}/${fileName}`,
          sourceUrl: item?.audioUrl || null,
        }
      })
      .filter(Boolean)
      .map((item, index) => ({ ...item, index: index + 1 }))
    return { key: track.key, label: track.label, prefix: track.prefix, items }
  })

  let orphanSubtitleCount = 0
  const subtitles = (Array.isArray(subtitleCues) ? subtitleCues : [])
    .filter((cue) => cue?.enabled !== false && String(cue?.text ?? '').trim())
    .map((cue) => {
      const storyboardId = Math.trunc(finiteNumber(cue?.storyboardId, 0))
      const anchorStart = timeline.startsByClipId.get(`storyboard-${storyboardId}`)
      // 镜头没进时间线时，字幕同样不能落到 0 秒，直接留在项目里等对应镜头确认。
      if (anchorStart === undefined) {
        orphanSubtitleCount += 1
        return null
      }
      const startSeconds = round3(Math.max(0, anchorStart + finiteNumber(cue?.startOffsetSeconds, 0)))
      const durationSeconds = Math.max(0.2, finiteNumber(cue?.durationSeconds, 1))
      return {
        storyboardId,
        startSeconds,
        endSeconds: round3(startSeconds + durationSeconds),
        text: String(cue.text ?? '').trim(),
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.startSeconds - b.startSeconds)
    .map((cue, index) => ({ ...cue, index: index + 1 }))

  const manifest = {
    projectId,
    projectName: String(projectName || '未命名项目'),
    episodeNo: Math.max(1, Math.trunc(finiteNumber(episodeNo, 1))),
    generatedAt,
    canvas,
    totalDurationSeconds: timeline.totalDurationSeconds,
    clips,
    audioTracks: normalizedAudioTracks,
    subtitles,
    unmatchedAudioCount: Math.max(0, Math.trunc(finiteNumber(unmatchedAudioCount, 0))),
    overlayClipCount: Math.max(0, Math.trunc(finiteNumber(overlayClipCount, 0))),
    orphanAudioCount: orphanAudioCount.value,
    orphanSubtitleCount,
    totals: {
      clipCount: clips.length,
      totalClipCount: (Array.isArray(videoClips) ? videoClips : []).length,
      videoClipCount: clips.filter((clip) => clip.sourceKind === 'video').length,
      imageClipCount: clips.filter((clip) => clip.sourceKind === 'image').length,
      audioCount: normalizedAudioTracks.reduce((sum, track) => sum + track.items.length, 0),
      subtitleCount: subtitles.length,
    },
    files: {
      srt: 'subtitles.srt',
      csv: '剪辑说明.csv',
      readme: 'README.md',
    },
  }

  manifest.srt = buildDeliverySrt(subtitles)
  manifest.csv = buildDeliveryCsv(manifest)
  manifest.readme = buildDeliveryReadme(manifest)
  return manifest
}
