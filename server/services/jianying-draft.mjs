/**
 * 剪映草稿生成器：把成片草稿转成剪映专业版能直接打开的「明文草稿」。
 *
 * 真机验证过的事实（剪映专业版 8.9.0.13361，见 PROJECT_PROGRESS.md 的 P34.2/P34.3）：
 * 1. 剪映**会读**手写的明文 draft_content.json，打开后自己升级 schema 并保存成它的格式。
 * 2. 剪映**会补全**最小结构：每个视频段它自动挂 6–7 个 extra_material_refs（speed /
 *    canvas_color / sound_channel_mapping 等），音频段 4 个。所以这里只写最小结构，
 *    不要把辅助素材写死，否则会和它的归一化打架。
 * 3. `clip.transform` 的 **Y 轴向上为正**（数学坐标系），不是屏幕坐标系。
 *    实测写 `y: 0.6` 得到的是「右上角」而不是「右下角」。见 OVERLAY_ANCHORS。
 * 4. 转场需要剪映内置特效的 effect_id/resource_id（服务端下发的一长串哈希），
 *    本地没有清单、写占位值只会得到硬切。所以这里**不写转场**，如实计入
 *    `unsupportedTransitions`，由调用方提示用户。
 *
 * 时间单位：剪映草稿全部用**微秒**。
 */

import { randomUUID } from 'node:crypto'

import { canvasFromRatioLabel, describeRatio, normalizeCanvasSize } from './media-probe.mjs'

export const JIANYING_CANVAS_PRESETS = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '4:3': { width: 1440, height: 1080 },
  '1:1': { width: 1080, height: 1080 },
  '3:4': { width: 1080, height: 1440 },
}

export const JIANYING_AUDIO_TRACKS = [
  { key: 'dialogue', label: '对白' },
  { key: 'narration', label: '旁白' },
  { key: 'music', label: '音乐' },
  { key: 'sfx', label: '音效' },
]

/**
 * 草稿格式版本号（`draft_content.new_version` / `draft_meta_info.draft_new_version`）。
 *
 * 这个值必须匹配**用户实际运行的那个剪映**，写高了会弹
 * 「检测到草稿版本较新，是否升级至专业版最新版本」——那个升级按钮对破解版用户
 * 有实质风险，属于危险诱导。
 *
 * 实测记录（同一台机器上并存两个剪映，值取错就会弹窗）：
 * - 小泽实际使用的是 `D:\剪映\剪映会员版6.0.1\6.0.1.11779`（破解版，较旧），
 *   它能正常打开声明 `110.0.0` 的草稿——两个探针都验过。
 * - `%LOCALAPPDATA%\JianyingPro\Apps\11.5.0.14471` 是**官方新版**，它会把草稿
 *   就地升级成 `164.0.0`。一旦草稿被它升过级，再用破解版打开就会弹升级提示。
 *
 * 教训：**别拿"我启动的那个进程"的值当"用户实际用的那个进程"的值。**
 * 我先前把常量改成 164.0.0（取自官方 11.5 的重写结果），反而把这个弹窗做实了。
 */
export const JIANYING_DRAFT_FORMAT_VERSION = '110.0.0'

/** 画中画锚点 → 剪映 clip.transform；Y 轴向上为正（真机实测）。 */
export const OVERLAY_ANCHORS = {
  center: { x: 0, y: 0 },
  'top-left': { x: -0.6, y: 0.6 },
  'top-right': { x: 0.6, y: 0.6 },
  'bottom-left': { x: -0.6, y: -0.6 },
  'bottom-right': { x: 0.6, y: -0.6 },
}

const SECOND = 1_000_000
const DEFAULT_TEXT_SIZE = 7

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value, min, max, fallback = min) {
  return Math.max(min, Math.min(max, finiteNumber(value, fallback)))
}

function toMicros(seconds) {
  return Math.round(Math.max(0, finiteNumber(seconds, 0)) * SECOND)
}

function safeText(value, fallback = '') {
  const text = String(value ?? '').trim()
  return text || fallback
}

function sanitizeDraftName(value, fallback = '帧心帧意成片') {
  const text = String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, 40).trim() || fallback
}

/** 本机素材文件名：中文可以保留，只清掉路径分隔符与控制字符。 */
export function sanitizeMediaFileName(value, fallback = 'media.bin') {
  const raw = String(value ?? '')
  const base = raw.split(/[\\/]/).pop() || ''
  const cleaned = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.slice(0, 80) || fallback
}

function extensionFromUrl(sourceUrl, fallback) {
  const value = String(sourceUrl ?? '')
  const match = value.split(/[?#]/)[0].match(/\.([A-Za-z0-9]{2,5})$/)
  return match ? `.${match[1].toLowerCase()}` : fallback
}

export function resolveJianyingCanvas(aspectRatio) {
  const key = String(aspectRatio ?? '').trim()
  const preset = JIANYING_CANVAS_PRESETS[key]
  if (preset) return { ratio: key, width: preset.width, height: preset.height }
  return { ratio: '9:16', width: 1080, height: 1920 }
}

/**
 * 决定草稿画布。优先级：**真实素材尺寸 > 项目声明比例 > 兜底**。
 *
 * 为什么不让声明比例优先：项目 12 声明 `2.39:1`，但素材实际是 16:9
 * （mp4 1280×720、PNG 1312×736）。按声明走会把横屏素材塞进竖屏画布，
 * 成片出来是压扁或大黑边。`source` 会如实告诉界面这个画布是哪来的。
 */
export function resolveJianyingCanvasFor({ aspectRatio = null, mediaDimensions = null } = {}) {
  const size = normalizeCanvasSize(mediaDimensions)
  if (size) {
    return { ratio: describeRatio(size), width: size.width, height: size.height, source: 'media' }
  }
  const key = String(aspectRatio ?? '').trim()
  const declared = canvasFromRatioLabel(key, { presets: JIANYING_CANVAS_PRESETS })
  if (declared) {
    return { ...declared, source: 'declared' }
  }
  return {
    ratio: '9:16',
    width: 1080,
    height: 1920,
    source: 'fallback',
    declaredRatio: key || null,
  }
}

/** 时间线只按「启用片段 + 草稿顺序」排布，与编辑器播放头逻辑一致。 */
export function buildJianyingTimeline(clips = []) {
  const starts = new Map()
  const ordered = []
  let cursor = 0
  for (const clip of Array.isArray(clips) ? clips : []) {
    if (clip?.enabled === false) continue
    const storyboardId = Math.trunc(finiteNumber(clip?.storyboardId, 0))
    const durationSeconds = Math.max(0, finiteNumber(clip?.durationSeconds, 0))
    starts.set(storyboardId, cursor)
    ordered.push({ clip, storyboardId, startSeconds: cursor, durationSeconds })
    cursor += durationSeconds
  }
  return { ordered, starts, totalDurationSeconds: cursor }
}

function textMaterial(id, content, textSize = DEFAULT_TEXT_SIZE) {
  // 只写必要字段：剪映自己会补 font_source_platform / layer_weight 等。
  return {
    add_type: 0,
    alignment: 1,
    background_alpha: 0.4,
    background_color: '#000000',
    background_height: 0.14,
    background_horizontal_offset: 0,
    background_round_radius: 0,
    background_style: 0,
    background_vertical_offset: 0,
    background_width: 0.14,
    base_content: '',
    bold_width: 0,
    border_alpha: 1,
    border_color: '#000000',
    border_width: 0.08,
    content,
    font_size: textSize,
    force_apply_line_max_width: false,
    has_shadow: false,
    id,
    initial_scale: 1,
    inner_padding: -1,
    italic_degree: 0,
    language: '',
    letter_spacing: 0,
    line_feed: 1,
    line_max_width: 0.86,
    line_spacing: 0.02,
    multi_language_current: 'none',
    name: '',
    type: 'text',
    text_color: '#FFFFFF',
    text_size: textSize,
    typewriter_duration: 0,
    underline: false,
  }
}

function videoMaterial(id, filePath, durationSeconds, canvas) {
  return {
    aigc_type: 'none',
    category_name: 'local',
    check_flag: 63487,
    crop_ratio: 'free',
    crop_scale: 1,
    duration: toMicros(durationSeconds),
    height: canvas.height,
    id,
    material_id: id,
    material_name: String(filePath).split(/[\\/]/).pop(),
    material_url: '',
    path: filePath,
    type: 'video',
    width: canvas.width,
  }
}

/**
 * 静帧素材。项目里大量镜头只有图片没有视频（项目 12 是 23/24），
 * 剪映把这类素材放在 materials.images 里并用 type: 'photo' 区分。
 *
 * 注意：真机实测**用户那套剪映 6.0.1 打不开这种写法**——它认识 `materials.images`
 * 和 `type: "photo"` 这两个键，但实际打开时会把静帧段全部丢掉（时间线只剩真 mp4）。
 * 所以默认走 `imageAsVideo`（静帧先编码成短 mp4），这条 photo 路径保留给
 * 确认支持图片素材的剪映版本使用。
 */
function photoMaterial(id, filePath, durationSeconds, canvas) {
  return {
    aigc_type: 'none',
    category_name: 'local',
    duration: toMicros(durationSeconds),
    height: canvas.height,
    id,
    material_id: id,
    material_name: String(filePath).split(/[\\/]/).pop(),
    material_url: '',
    path: filePath,
    type: 'photo',
    width: canvas.width,
  }
}

function audioMaterial(id, filePath, durationSeconds) {
  // 真机验证：剪映把本地音频认成 type: "music"，只保留 name/path/duration，
  // 并自己补 resource_id 与它拼错的 similiar_music_info。
  return {
    category_name: 'local',
    duration: toMicros(durationSeconds),
    id,
    name: String(filePath).split(/[\\/]/).pop(),
    path: filePath,
    type: 'music',
  }
}

function videoSegment({ id, materialId, startSeconds, durationSeconds, sourceStartSeconds = 0, clipPatch = {}, renderIndex = 0 }) {
  return {
    cartesian_points: [],
    clip: {
      alpha: 1,
      flip: { horizontal: false, vertical: false },
      rotation: 0,
      scale: { x: 1, y: 1 },
      transform: { x: 0, y: 0 },
      ...clipPatch,
    },
    common_keyframes: [],
    enable_adjust: true,
    extra_material_refs: [],
    group_id: '',
    id,
    keyframe_refs: [],
    last_nonzero_volume: 1,
    material_id: materialId,
    render_index: renderIndex,
    reverse: false,
    source_timerange: { duration: toMicros(durationSeconds), start: toMicros(sourceStartSeconds) },
    speed: 1,
    target_timerange: { duration: toMicros(durationSeconds), start: toMicros(startSeconds) },
    track_render_index: renderIndex,
    uniform_scale: { on: true, value: 1 },
    visible: true,
    volume: 1,
  }
}

function audioSegment({ id, materialId, startSeconds, durationSeconds, sourceStartSeconds = 0, volume = 1 }) {
  return {
    clip: null,
    common_keyframes: [],
    extra_material_refs: [],
    group_id: '',
    id,
    keyframe_refs: [],
    last_nonzero_volume: volume,
    material_id: materialId,
    render_index: 0,
    reverse: false,
    source_timerange: { duration: toMicros(durationSeconds), start: toMicros(sourceStartSeconds) },
    speed: 1,
    target_timerange: { duration: toMicros(durationSeconds), start: toMicros(startSeconds) },
    track_render_index: 0,
    visible: true,
    volume,
  }
}

function textSegment({ id, materialId, startSeconds, durationSeconds, transformY }) {
  return {
    clip: {
      alpha: 1,
      flip: { horizontal: false, vertical: false },
      rotation: 0,
      scale: { x: 1, y: 1 },
      transform: { x: 0, y: transformY },
    },
    common_keyframes: [],
    extra_material_refs: [],
    group_id: '',
    id,
    keyframe_refs: [],
    material_id: materialId,
    render_index: 14000,
    source_timerange: null,
    target_timerange: { duration: toMicros(durationSeconds), start: toMicros(startSeconds) },
    track_render_index: 0,
    visible: true,
  }
}

function platform() {
  return {
    app_id: 3704,
    app_source: 'lv',
    app_version: '8.9.0',
    device_id: 'projectdream-draft-export',
    os: 'windows',
  }
}

/**
 * @param {object} options
 * @param {string} options.projectName
 * @param {number} [options.episodeNo]
 * @param {string} [options.aspectRatio]
 * @param {Array} options.clips            成片镜头（按 order 排好，带 enabled/durationSeconds/trimStartSeconds）
 * @param {Array} [options.overlayClips]   画中画（storyboardId/startSeconds/durationSeconds/position/scale/opacity）
 * @param {object} [options.audioTracks]   对白/旁白/音乐/音效
 * @param {Array} [options.subtitleCues]   字幕
 * @param {(sourceUrl: string|null, kind: string, meta: {label: string, fileName: string, storyboardId: number|null}) => string|null} options.mediaPathFor
 *        把媒体 URL 映射成本机绝对路径；返回 null 表示这条素材没落地，会被跳过并记入 missingMedia。
 * @param {() => string} [options.idFactory]
 */
export function buildJianyingDraft({
  projectName = '未命名项目',
  episodeNo = 1,
  aspectRatio = null,
  mediaDimensions = null,
  /**
   * 静帧是否按视频素材写入（true）还是按剪映图片素材写入（false）。
   * 默认 true：用户那套剪映 6.0.1 会丢弃图片素材，实测只有视频素材能渲染。
   */
  imageAsVideo = true,
  clips = [],
  overlayClips = [],
  audioTracks = {},
  subtitleCues = [],
  mediaPathFor,
  textSize = DEFAULT_TEXT_SIZE,
  idFactory = randomUUID,
} = {}) {
  if (typeof mediaPathFor !== 'function') {
    throw new Error('buildJianyingDraft 需要 mediaPathFor 来解析本机素材路径')
  }

  const canvas = resolveJianyingCanvasFor({ aspectRatio, mediaDimensions })
  const timeline = buildJianyingTimeline(clips)
  const draftName = sanitizeDraftName(
    `${projectName} E${String(Math.max(1, Math.trunc(finiteNumber(episodeNo, 1)))).padStart(2, '0')}`,
  )

  const missingMedia = []
  const unsupportedTransitions = []
  const videos = []
  const images = []
  const audios = []
  const texts = []
  const tracks = []
  /** 有多少个静帧是按视频素材写入的（不是 photo 素材） */
  let stillsAsVideo = 0

  // ① 主视频轨：按草稿顺序铺开，source_timerange 承载裁切入点
  const mainSegments = []
  timeline.ordered.forEach((entry, index) => {
    const clip = entry.clip
    const sourceUrl = clip?.videoUrl || clip?.imageUrl || null
    const kind = clip?.videoUrl ? 'video' : clip?.imageUrl ? 'image' : 'video'
    const label = `Scene ${clip?.sceneNo ?? '?'} / ${clip?.shotNo || clip?.storyboardId}`
    const path = mediaPathFor(sourceUrl, kind, {
      label,
      fileName: sanitizeMediaFileName(
        `${String(index + 1).padStart(2, '0')}_S${clip?.sceneNo ?? 0}-${clip?.shotNo || entry.storyboardId}${extensionFromUrl(sourceUrl, kind === 'image' ? '.png' : '.mp4')}`,
      ),
      storyboardId: entry.storyboardId,
    })
    if (!path) {
      missingMedia.push({ kind, url: sourceUrl, label })
      return
    }
    if (clip?.transition && clip.transition.type && clip.transition.type !== 'cut') {
      unsupportedTransitions.push({
        storyboardId: entry.storyboardId,
        type: clip.transition.type,
        durationSeconds: clip.transition.durationSeconds,
      })
    }
    const materialId = idFactory()
    const sourceDuration = Math.max(
      0.25,
      finiteNumber(clip?.sourceDurationSeconds, 0) || finiteNumber(clip?.durationSeconds, 0) || 4,
    )
    const trimStart = clamp(clip?.trimStartSeconds, 0, Math.max(0, sourceDuration - 0.25), 0)
    if (kind === 'image') {
      // 静帧：素材时长必须容得下「入点 + 展示时长」，否则剪映会截断
      const displayDuration = Math.max(0.25, finiteNumber(clip?.durationSeconds, 3))
      if (imageAsVideo) {
        videos.push(videoMaterial(materialId, path, trimStart + displayDuration, canvas))
        stillsAsVideo += 1
      } else {
        images.push(photoMaterial(materialId, path, trimStart + displayDuration, canvas))
      }
    } else {
      videos.push(videoMaterial(materialId, path, sourceDuration, canvas))
    }
    mainSegments.push(
      videoSegment({
        id: idFactory(),
        materialId,
        startSeconds: entry.startSeconds,
        durationSeconds: entry.durationSeconds,
        sourceStartSeconds: trimStart,
        renderIndex: index,
      }),
    )
  })
  if (mainSegments.length) {
    tracks.push({
      attribute: 0,
      flag: 0,
      id: idFactory(),
      is_default_name: true,
      name: '',
      segments: mainSegments,
      type: 'video',
    })
  }

  // ② 画中画轨：放在主轨之后，剪映里后出现的视频轨渲染在上层
  const overlaySegments = []
  for (const [overlayIndex, overlay] of (Array.isArray(overlayClips) ? overlayClips : []).entries()) {
    if (overlay?.enabled === false) continue
    const source = timeline.ordered.find((entry) => entry.storyboardId === Math.trunc(finiteNumber(overlay?.storyboardId, 0)))
    if (!source) continue
    const sourceUrl = source.clip?.videoUrl || source.clip?.imageUrl || null
    const kind = source.clip?.videoUrl ? 'video' : source.clip?.imageUrl ? 'image' : 'video'
    const label = `画中画 storyboard ${overlay.storyboardId}`
    const path = mediaPathFor(sourceUrl, kind, {
      label,
      fileName: sanitizeMediaFileName(
        `PIP_${String(overlayIndex + 1).padStart(2, '0')}_S${source.clip?.sceneNo ?? 0}-${source.clip?.shotNo || overlay.storyboardId}${extensionFromUrl(sourceUrl, kind === 'image' ? '.png' : '.mp4')}`,
      ),
      storyboardId: source.storyboardId,
    })
    if (!path) {
      missingMedia.push({ kind: 'overlay', url: sourceUrl, label })
      continue
    }
    const anchor = OVERLAY_ANCHORS[overlay?.position] || OVERLAY_ANCHORS['bottom-right']
    const scale = clamp(overlay?.scale, 0.05, 1, 0.36)
    const materialId = idFactory()
    const overlayDuration = Math.max(0.25, finiteNumber(overlay?.durationSeconds, 0.25))
    const overlayTrimStart = Math.max(0, finiteNumber(overlay?.trimStartSeconds, 0))
    if (kind === 'image') {
      if (imageAsVideo) {
        videos.push(videoMaterial(materialId, path, overlayTrimStart + overlayDuration, canvas))
        stillsAsVideo += 1
      } else {
        images.push(photoMaterial(materialId, path, overlayTrimStart + overlayDuration, canvas))
      }
    } else {
      videos.push(
        videoMaterial(
          materialId,
          path,
          Math.max(0.25, finiteNumber(source.clip?.sourceDurationSeconds, 0) || source.durationSeconds || 4),
          canvas,
        ),
      )
    }
    overlaySegments.push(
      videoSegment({
        id: idFactory(),
        materialId,
        startSeconds: Math.max(0, finiteNumber(overlay?.startSeconds, 0)),
        durationSeconds: overlayDuration,
        sourceStartSeconds: overlayTrimStart,
        clipPatch: {
          alpha: clamp(finiteNumber(overlay?.opacity, 100) / 100, 0, 1, 1),
          scale: { x: scale, y: scale },
          transform: { x: anchor.x, y: anchor.y },
        },
        renderIndex: 0,
      }),
    )
  }
  if (overlaySegments.length) {
    tracks.push({
      attribute: 0,
      flag: 0,
      id: idFactory(),
      is_default_name: true,
      name: '画中画',
      segments: overlaySegments,
      type: 'video',
    })
  }

  // ③ 音轨：每个轨道一条，绝对起点 = 镜头起点 + 偏移；全局音乐/音效按自身偏移落 0 起
  for (const track of JIANYING_AUDIO_TRACKS) {
    const items = (Array.isArray(audioTracks?.[track.key]) ? audioTracks[track.key] : []).filter(
      (item) => item?.enabled !== false,
    )
    const segments = []
    for (const [itemIndex, item] of items.entries()) {
      const storyboardId = Math.trunc(finiteNumber(item?.storyboardId, 0))
      const anchorStart = storyboardId > 0 ? timeline.starts.get(storyboardId) : 0
      if (storyboardId > 0 && anchorStart === undefined) continue
      const sourceUrl = item?.audioUrl || null
      const label = item?.title || `${track.label}音频`
      const path = mediaPathFor(sourceUrl, 'audio', {
        label,
        fileName: sanitizeMediaFileName(
          `${track.label}_${String(itemIndex + 1).padStart(2, '0')}_${sanitizeMediaFileName(sourceUrl, `audio${extensionFromUrl(sourceUrl, '.mp3')}`)}`,
        ),
        storyboardId: storyboardId || null,
      })
      if (!path) {
        missingMedia.push({ kind: 'audio', url: sourceUrl, label })
        continue
      }
      const durationSeconds = Math.max(0.2, finiteNumber(item?.durationSeconds, 0.2))
      const materialId = idFactory()
      audios.push(audioMaterial(materialId, path, durationSeconds))
      segments.push(
        audioSegment({
          id: idFactory(),
          materialId,
          startSeconds: Math.max(0, (anchorStart ?? 0) + finiteNumber(item?.startOffsetSeconds, 0)),
          durationSeconds,
          volume: clamp(finiteNumber(item?.volume, 100) / 100, 0, 1, 1),
        }),
      )
    }
    if (segments.length) {
      tracks.push({
        attribute: 0,
        flag: 0,
        id: idFactory(),
        is_default_name: true,
        name: track.label,
        segments,
        type: 'audio',
      })
    }
  }

  // ④ 字幕轨：绝对时间，沿用编辑器的镜头起点 + 偏移
  const textSegments = []
  for (const cue of Array.isArray(subtitleCues) ? subtitleCues : []) {
    if (cue?.enabled === false) continue
    const content = String(cue?.text ?? '').trim()
    if (!content) continue
    const storyboardId = Math.trunc(finiteNumber(cue?.storyboardId, 0))
    const anchorStart = timeline.starts.get(storyboardId)
    if (anchorStart === undefined) continue
    const materialId = idFactory()
    texts.push(textMaterial(materialId, content, textSize))
    textSegments.push(
      textSegment({
        id: idFactory(),
        materialId,
        startSeconds: Math.max(0, anchorStart + finiteNumber(cue?.startOffsetSeconds, 0)),
        durationSeconds: Math.max(0.2, finiteNumber(cue?.durationSeconds, 1)),
        transformY: -0.62,
      }),
    )
  }
  if (textSegments.length) {
    tracks.push({
      attribute: 0,
      flag: 0,
      id: idFactory(),
      is_default_name: true,
      name: '',
      segments: textSegments,
      type: 'text',
    })
  }

  const totalDurationSeconds = Math.max(
    timeline.totalDurationSeconds,
    ...overlaySegments.map((segment) => (segment.target_timerange.start + segment.target_timerange.duration) / SECOND),
    ...textSegments.map((segment) => (segment.target_timerange.start + segment.target_timerange.duration) / SECOND),
    0,
  )

  const draftContent = {
    canvas_config: { height: canvas.height, ratio: '', width: canvas.width },
    color_space: 0,
    config: { adjust_max_index: 1, combination_max_index: 1 },
    create_time: 0,
    duration: toMicros(totalDurationSeconds),
    fps: 30,
    free_render_index_mode_on: false,
    id: idFactory(),
    keyframe_graph_list: [],
    keyframes: { adjusts: [], audios: [], effects: [], filters: [], handwrites: [], stickers: [], texts: [], videos: [] },
    last_modified_platform: platform(),
    materials: {
      audios,
      canvases: [],
      chromas: [],
      color_curves: [],
      digital_humans: [],
      drafts: [],
      effects: [],
      flowers: [],
      green_screens: [],
      handwrites: [],
      hsl: [],
      images,
      log_color_wheels: [],
      loudnesses: [],
      manual_deformations: [],
      masks: [],
      material_animations: [],
      placeholders: [],
      plugin_effects: [],
      primary_color_wheels: [],
      smart_crops: [],
      sound_channel_mappings: [],
      speeds: [],
      stickers: [],
      tail_leaders: [],
      text_templates: [],
      texts,
      transitions: [],
      videos,
      vocal_beats: [],
      vocal_separations: [],
    },
    name: draftName,
    new_version: JIANYING_DRAFT_FORMAT_VERSION,
    platform: platform(),
    relationships: [],
    render_index_track_mode_on: false,
    source: 'default',
    static_cover_image_path: '',
    tracks,
    version: 360000,
  }

  return {
    name: draftName,
    canvas,
    totalDurationSeconds: Number(totalDurationSeconds.toFixed(3)),
    draftContent,
    draftMetaInfo: {
      draft_cover: '',
      draft_name: draftName,
      draft_type: 0,
      // 剪映自己归一化时会在 meta 里写这个字段；缺了它同样可能触发"草稿版本较新"的升级提示
      draft_new_version: JIANYING_DRAFT_FORMAT_VERSION,
      draft_materials: Array.from({ length: 9 }, () => ({ type: 0, value: [] })),
      draft_materials_copied_info: [],
      draft_segment_extra_info: [],
      draft_removable_storage_device: '',
      tm_duration: toMicros(totalDurationSeconds),
    },
    draftSettings: `[General]\ndraft_create_time=${Math.floor(Date.now() / 1000)}\ndraft_last_edit_time=${Math.floor(Date.now() / 1000)}\n`,
    stats: {
      videoSegments: mainSegments.length,
      overlaySegments: overlaySegments.length,
      audioSegments: audios.length,
      textSegments: textSegments.length,
      videoMaterials: videos.length,
      imageMaterials: images.length,
      stillsAsVideo,
      totalDurationSeconds: Number(totalDurationSeconds.toFixed(3)),
      missingMedia,
      unsupportedTransitions,
    },
  }
}

/**
 * 第一遍「空跑」：只收集这份草稿需要哪些本机素材，不产出可用草稿。
 *
 * 这样调用方不用把「哪些镜头进时间线、哪些音频挂在哪个镜头上」的选择逻辑抄一遍：
 * 同一套逻辑既决定时间线，也决定要下哪些媒体。按 URL 去重，先到的命名优先。
 *
 * @returns {{ requests: Array<{url: string, kind: string, fileName: string, label: string, storyboardId: number|null}>, stats: object }}
 */
export function collectJianyingMediaRequests(options = {}) {
  const requests = new Map()
  const result = buildJianyingDraft({
    ...options,
    mediaPathFor: (url, kind, meta) => {
      const key = String(url ?? '')
      if (key && !requests.has(key)) {
        requests.set(key, {
          url: key,
          kind,
          fileName: meta?.fileName || sanitizeMediaFileName(key, 'media.bin'),
          label: meta?.label || '',
          storyboardId: meta?.storyboardId ?? null,
        })
      }
      return null
    },
  })

  return { requests: [...requests.values()], stats: result.stats }
}
