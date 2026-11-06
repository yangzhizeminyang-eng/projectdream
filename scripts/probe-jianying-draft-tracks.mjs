/**
 * 剪映「四轨明文草稿」探针（Step 1）
 *
 * 上游结论（已实证）：剪映专业版 8.9 能读我们手写的明文 draft_content.json，
 * 打开后自己升级 schema 并加密保存。上一个探针只验证了「视频轨 + 文本轨」，
 * 这个探针把剩下三样一起验掉，避免凭猜写两天的生成器：
 *
 *   ① 视频轨：两段真实镜头，第 2 段带裁切入点
 *   ② 画中画：V2 上层视频轨 + clip.scale/transform
 *   ③ 音轨：一条真实对白 mp3（能听到声音才算过）
 *   ④ 字幕轨：两条绝对时间字幕
 *   ⑤ 转场：两段 V1 之间的「叠化」
 *
 * 用法（务必先关闭剪映，否则它退出时会覆盖索引）：
 *   node scripts/probe-jianying-draft-tracks.mjs --prepare
 *   node scripts/probe-jianying-draft-tracks.mjs --install
 *   node scripts/probe-jianying-draft-tracks.mjs --uninstall
 */

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DRAFT_ROOT = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'JianyingPro',
  'User Data',
  'Projects',
  'com.lveditor.draft',
)
const PROBE_NAME = '帧心帧意_四轨探针'
const PROBE_DRAFT_ID = 'PROJECTDREAM-TRACKS-PROBE'
const PROBE_DIR = path.join(DRAFT_ROOT, PROBE_NAME)
const WORK_DIR = path.join(process.cwd(), '.genwork', 'jianying-tracks-probe')
const MEDIA_DIR = path.join(process.cwd(), '.genwork', 'jianying-probe-full')
const INDEX_PATH = path.join(DRAFT_ROOT, 'root_meta_info.json')

const SECOND = 1_000_000

function requiredMedia() {
  return {
    clip1: path.join(MEDIA_DIR, '01_clip.mp4'),
    clip2: path.join(MEDIA_DIR, '02_clip.mp4'),
    dialogue: path.join(MEDIA_DIR, '03_dialogue.mp3'),
  }
}

function platform() {
  return {
    app_id: 3704,
    app_source: 'lv',
    app_version: '8.9.0',
    device_id: 'projectdream-tracks-probe',
    os: 'windows',
  }
}

function textMaterial({ id, content }) {
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
    font_size: 7,
    font_source_platform: 0,
    force_apply_line_max_width: false,
    has_shadow: false,
    id,
    initial_scale: 1,
    inner_padding: -1,
    italic_degree: 0,
    language: '',
    layer_weight: 1,
    letter_spacing: 0,
    line_feed: 1,
    line_max_width: 0.86,
    line_spacing: 0.02,
    multi_language_current: 'none',
    name: '',
    type: 'text',
    text_color: '#FFFFFF',
    text_size: 7,
    typewriter_duration: 0,
    underline: false,
  }
}

function videoSegment({ id, materialId, start, duration, sourceStart = 0, extraMaterialRefs = [], clipPatch = {} }) {
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
    enable_color_curves: true,
    enable_color_wheels: true,
    enable_smart_color_adjusted: true,
    extra_material_refs: extraMaterialRefs,
    group_id: '',
    hdr_settings: { intensity: 1, mode: 1, nits: 1000 },
    id,
    intensifies_audio_query: { audio_denoise_all_allow: false, audio_denoise_allow: false, audio_denoise_status: false },
    keyframe_refs: [],
    last_nonzero_volume: 1,
    material_id: materialId,
    render_index: 0,
    reverse: false,
    source_timerange: { duration: duration * SECOND, start: sourceStart * SECOND },
    speed: 1,
    target_timerange: { duration: duration * SECOND, start: start * SECOND },
    template_id: '',
    template_scene: 'default',
    track_attribute: 0,
    track_render_index: 0,
    uniform_scale: { on: true, value: 1 },
    visible: true,
    volume: 1,
  }
}

function textSegment({ id, materialId, start, duration, transformY = -0.62 }) {
  return {
    clip: {
      alpha: 1,
      flip: { horizontal: false, vertical: false },
      rotation: 0,
      scale: { x: 1, y: 1 },
      transform: { x: 0, y: transformY },
    },
    common_keyframes: [],
    enable_adjust: false,
    group_id: '',
    id,
    keyframe_refs: [],
    material_id: materialId,
    render_index: 14000,
    source_timerange: null,
    target_timerange: { duration: duration * SECOND, start: start * SECOND },
    track_attribute: 0,
    track_render_index: 0,
    visible: true,
  }
}

function audioSegment({ id, materialId, start, duration, sourceStart = 0, volume = 1 }) {
  return {
    clip: null,
    common_keyframes: [],
    enable_adjust: false,
    group_id: '',
    id,
    keyframe_refs: [],
    last_nonzero_volume: volume,
    material_id: materialId,
    render_index: 0,
    reverse: false,
    source_timerange: { duration: duration * SECOND, start: sourceStart * SECOND },
    speed: 1,
    target_timerange: { duration: duration * SECOND, start: start * SECOND },
    track_attribute: 0,
    track_render_index: 0,
    visible: true,
    volume,
  }
}

function buildDraftContent() {
  const media = requiredMedia()
  const TOTAL = 6

  const videoMaterial = (id, filePath, duration, width, height) => ({
    aigc_type: 'none',
    audio_fade: null,
    category_id: '',
    category_name: 'local',
    check_flag: 63487,
    crop_ratio: 'free',
    crop_scale: 1,
    duration: duration * SECOND,
    height,
    id,
    local_material_id: '',
    material_id: id,
    material_name: path.basename(filePath),
    material_url: '',
    path: filePath,
    type: 'video',
    width,
  })

  const audioMaterial = {
    app_id: 0,
    category_id: '',
    category_name: 'local',
    check_flag: 1,
    duration: 3 * SECOND,
    id: 'probe-audio-material',
    local_material_id: '',
    music_id: '',
    name: path.basename(media.dialogue),
    path: media.dialogue,
    source_platform: 0,
    type: 'music',
    wave_points: [],
  }

  return {
    canvas_config: { height: 1920, ratio: 'original', width: 1080 },
    color_space: 0,
    config: { adjust_max_index: 1, attachment_info: [], combination_max_index: 1, export_range: null },
    cover: null,
    create_time: 0,
    duration: TOTAL * SECOND,
    extra_info: null,
    fps: 30,
    free_render_index_mode_on: false,
    id: PROBE_DRAFT_ID,
    keyframe_graph_list: [],
    keyframes: { adjusts: [], audios: [], effects: [], filters: [], handwrites: [], stickers: [], texts: [], videos: [] },
    last_modified_platform: platform(),
    materials: {
      audios: [audioMaterial],
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
      images: [],
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
      texts: [
        textMaterial({ id: 'probe-text-1', content: '① 视频轨 ② 画中画轨' }),
        textMaterial({ id: 'probe-text-2', content: '③ 对白音轨 ④ 字幕轨' }),
      ],
      transitions: [
        {
          category_id: 'transition',
          category_name: '转场',
          duration: 500_000,
          effect_id: 'probe-transition-fade',
          id: 'probe-transition',
          is_overlap: false,
          name: '叠化',
          platform: 'all',
          resource_id: 'probe-transition-fade',
          type: 'transition',
        },
      ],
      videos: [
        videoMaterial('probe-video-1', media.clip1, 4, 1080, 1920),
        videoMaterial('probe-video-2', media.clip2, 4, 1080, 1920),
      ],
      vocal_beats: [],
      vocal_separations: [],
    },
    mutable_config: null,
    name: PROBE_NAME,
    new_version: '110.0.0',
    platform: platform(),
    relationships: [],
    render_index_track_mode_on: false,
    retouch_cover: null,
    source: 'default',
    static_cover_image_path: '',
    time_marks: null,
    tracks: [
      // ① 视频主轨：两段，第 2 段裁切入点 0.5s，衔接处引用叠化
      {
        attribute: 0,
        flag: 0,
        id: 'probe-track-video',
        is_default_name: true,
        name: '',
        segments: [
          videoSegment({
            id: 'probe-video-seg-1',
            materialId: 'probe-video-1',
            start: 0,
            duration: 3,
            extraMaterialRefs: ['probe-transition'],
          }),
          videoSegment({
            id: 'probe-video-seg-2',
            materialId: 'probe-video-2',
            start: 3,
            duration: 3,
            sourceStart: 0.5,
          }),
        ],
        type: 'video',
      },
      // ② 画中画：上层视频轨，缩小到 34% 放在右下角
      {
        attribute: 0,
        flag: 0,
        id: 'probe-track-overlay',
        is_default_name: true,
        name: '画中画',
        segments: [
          videoSegment({
            id: 'probe-overlay-seg-1',
            materialId: 'probe-video-2',
            start: 1,
            duration: 3,
            sourceStart: 1,
            clipPatch: {
              scale: { x: 0.34, y: 0.34 },
              transform: { x: 0.6, y: 0.6 },
            },
          }),
        ],
        type: 'video',
      },
      // ③ 对白音轨：真实 TTS 音频，1.5s 起播 2s
      {
        attribute: 0,
        flag: 0,
        id: 'probe-track-audio',
        is_default_name: true,
        name: '对白',
        segments: [
          audioSegment({
            id: 'probe-audio-seg-1',
            materialId: 'probe-audio-material',
            start: 1.5,
            duration: 2,
            volume: 1,
          }),
        ],
        type: 'audio',
      },
      // ④ 字幕轨：两条绝对时间字幕（不是绑在片段上的）
      {
        attribute: 0,
        flag: 0,
        id: 'probe-track-text',
        is_default_name: true,
        name: '',
        segments: [
          textSegment({ id: 'probe-text-seg-1', materialId: 'probe-text-1', start: 0.2, duration: 2.6, transformY: -0.58 }),
          textSegment({ id: 'probe-text-seg-2', materialId: 'probe-text-2', start: 3.2, duration: 2.4, transformY: 0.58 }),
        ],
        type: 'text',
      },
    ],
    version: 360000,
  }
}

function buildDraftMetaInfo() {
  return {
    draft_cloud_last_action_download: false,
    draft_cloud_purchase_info: '',
    draft_cloud_template_id: '',
    draft_cloud_tutorial_info: '',
    draft_cover: '',
    draft_deeplink_url: '',
    draft_fold_path: PROBE_DIR.replace(/\\/g, '/'),
    draft_id: PROBE_DRAFT_ID,
    draft_is_ai_packaging_used: false,
    draft_is_ai_shorts: false,
    draft_is_ai_translate: false,
    draft_is_article_video_draft: false,
    draft_is_from_deeplink: false,
    draft_is_invisible: false,
    draft_materials: [
      { type: 0, value: [] },
      { type: 1, value: [] },
      { type: 2, value: [] },
      { type: 3, value: [] },
      { type: 4, value: [] },
      { type: 5, value: [] },
      { type: 6, value: [] },
      { type: 7, value: [] },
      { type: 8, value: [] },
    ],
    draft_materials_copied_info: [],
    draft_name: PROBE_NAME,
    draft_removable_storage_device: '',
    draft_root_path: DRAFT_ROOT.replace(/\\/g, '/'),
    draft_segment_extra_info: [],
    draft_timeline_materials_size_: 0,
    draft_type: 0,
    tm_draft_create: Date.now() * 1000,
    tm_draft_modified: Date.now() * 1000,
    tm_draft_removed: 0,
    tm_duration: 6 * SECOND,
  }
}

async function prepare() {
  const media = requiredMedia()
  const missing = Object.entries(media).filter(([, file]) => !existsSync(file))
  if (missing.length) {
    console.error('缺少探针素材：')
    for (const [key, file] of missing) console.error(`  ${key}: ${file}`)
    process.exitCode = 1
    return
  }

  await rm(WORK_DIR, { recursive: true, force: true })
  await mkdir(WORK_DIR, { recursive: true })
  await writeFile(path.join(WORK_DIR, 'draft_content.json'), JSON.stringify(buildDraftContent(), null, 2), 'utf8')
  await writeFile(path.join(WORK_DIR, 'draft_meta_info.json'), JSON.stringify(buildDraftMetaInfo(), null, 2), 'utf8')
  await writeFile(
    path.join(WORK_DIR, 'draft_settings'),
    `[General]\ndraft_create_time=${Math.floor(Date.now() / 1000)}\ndraft_last_edit_time=${Math.floor(Date.now() / 1000)}\n`,
    'utf8',
  )

  const content = JSON.parse(await readFile(path.join(WORK_DIR, 'draft_content.json'), 'utf8'))
  console.log(`已生成四轨探针草稿：${WORK_DIR}`)
  console.log(`  时长 ${content.duration / SECOND}s｜轨道 ${content.tracks.map((t) => t.type).join(' + ')}`)
  console.log(`  视频素材 ${content.materials.videos.length}｜音频素材 ${content.materials.audios.length}｜字幕素材 ${content.materials.texts.length}｜转场 ${content.materials.transitions.length}`)
  console.log('下一步（先关闭剪映）：node scripts/probe-jianying-draft-tracks.mjs --install')
}

function registerInIndex(index, entry) {
  const next = { ...index }
  if (!Array.isArray(next.all_draft_store)) next.all_draft_store = []
  if (!Array.isArray(next.draft_ids)) next.draft_ids = []
  next.all_draft_store = next.all_draft_store.filter((item) => item?.draft_id !== PROBE_DRAFT_ID)
  next.draft_ids = next.draft_ids.filter((id) => id !== PROBE_DRAFT_ID)
  next.all_draft_store.push(entry)
  next.draft_ids.push(PROBE_DRAFT_ID)
  return next
}

async function install() {
  if (!existsSync(WORK_DIR)) {
    console.error('还没生成探针草稿，请先运行 --prepare')
    process.exitCode = 1
    return
  }
  if (!existsSync(DRAFT_ROOT)) {
    console.error(`找不到剪映草稿目录：${DRAFT_ROOT}`)
    process.exitCode = 1
    return
  }

  const rawIndex = await readFile(INDEX_PATH, 'utf8')
  const backupPath = `${INDEX_PATH}.tracks-probe-backup`
  if (!existsSync(backupPath)) {
    await writeFile(backupPath, rawIndex, 'utf8')
    console.log(`已备份索引：${backupPath}`)
  }

  const index = JSON.parse(rawIndex)
  const meta = JSON.parse(await readFile(path.join(WORK_DIR, 'draft_meta_info.json'), 'utf8'))
  const nextIndex = registerInIndex(index, {
    draft_cover: '',
    draft_fold_path: PROBE_DIR.replace(/\\/g, '/'),
    draft_id: PROBE_DRAFT_ID,
    draft_name: PROBE_NAME,
    draft_root_path: DRAFT_ROOT.replace(/\\/g, '/'),
    tm_draft_create: meta.tm_draft_create,
    tm_draft_modified: meta.tm_draft_modified,
    tm_duration: meta.tm_duration,
  })

  await rm(PROBE_DIR, { recursive: true, force: true })
  await mkdir(PROBE_DIR, { recursive: true })
  for (const file of ['draft_content.json', 'draft_meta_info.json', 'draft_settings']) {
    await copyFile(path.join(WORK_DIR, file), path.join(PROBE_DIR, file))
  }
  await writeFile(INDEX_PATH, JSON.stringify(nextIndex, null, 2), 'utf8')

  console.log(`已安装四轨探针：${PROBE_DIR}`)
  console.log('打开剪映，双击「帧心帧意_四轨探针」，确认四轨和转场。')
  console.log('测完执行：node scripts/probe-jianying-draft-tracks.mjs --uninstall')
}

async function uninstall() {
  await rm(PROBE_DIR, { recursive: true, force: true })
  const backupPath = `${INDEX_PATH}.tracks-probe-backup`
  if (existsSync(backupPath)) {
    await copyFile(backupPath, INDEX_PATH)
    await rm(backupPath, { force: true })
    console.log('已还原 root_meta_info.json 并删除四轨探针。')
    return
  }
  if (existsSync(INDEX_PATH)) {
    const index = JSON.parse(await readFile(INDEX_PATH, 'utf8'))
    const next = {
      ...index,
      all_draft_store: (index.all_draft_store || []).filter((item) => item?.draft_id !== PROBE_DRAFT_ID),
      draft_ids: (index.draft_ids || []).filter((id) => id !== PROBE_DRAFT_ID),
    }
    await writeFile(INDEX_PATH, JSON.stringify(next, null, 2), 'utf8')
    console.log('已从索引精确移除四轨探针并删除目录。')
  } else {
    console.log('没有找到索引文件，只删除了探针目录。')
  }
}

const command = process.argv[2] || '--prepare'
if (command === '--prepare') await prepare()
else if (command === '--install') await install()
else if (command === '--uninstall') await uninstall()
else {
  console.error('用法：--prepare | --install | --uninstall')
  process.exitCode = 1
}
