/**
 * 剪映「明文草稿」兼容性探针
 *
 * 背景：剪映专业版 8.9 自己写出来的 draft_content.json 是加密的（base64 密文）。
 * 我们要回答的唯一问题是：**它还会不会读一份明文草稿？**
 *  - 会读 → 「导出到剪映」还有戏（我们生成明文草稿，剪映读入后自己加密保存）
 *  - 不读 → 这条路彻底关掉，改走 FCPXML / DaVinci
 *
 * 这个脚本只做三件事，全部可逆：
 *  1. --prepare  在 .genwork 下生成一份最小明文草稿（不碰剪映目录）
 *  2. --install  备份 root_meta_info.json，把草稿复制进剪映草稿目录并登记
 *  3. --uninstall 删掉测试草稿并还原 root_meta_info.json
 *
 * 注意：install / uninstall 会写入剪映草稿目录，务必先关闭剪映，避免它退出时覆盖索引。
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
const PROBE_NAME = '帧心帧意_明文探针'
const PROBE_DIR = path.join(DRAFT_ROOT, PROBE_NAME)
const WORK_DIR = path.join(process.cwd(), '.genwork', 'jianying-plaintext-probe')
const INDEX_PATH = path.join(DRAFT_ROOT, 'root_meta_info.json')
const PROBE_DRAFT_ID = 'PROJECTDREAM-PLAINTEXT-PROBE'

/** 剪映的时间单位是微秒 */
const SECOND = 1_000_000

function buildDraftContent({ videoPath, durationSeconds = 3 }) {
  const videoMaterialId = 'probe-video-material'
  const textMaterialId = 'probe-text-material'

  return {
    canvas_config: { height: 1920, ratio: 'original', width: 1080 },
    color_space: 0,
    config: { adjust_max_index: 1, attachment_info: [], combination_max_index: 1, export_range: null },
    cover: null,
    create_time: 0,
    duration: durationSeconds * SECOND,
    extra_info: null,
    fps: 30,
    free_render_index_mode_on: false,
    id: PROBE_DRAFT_ID,
    keyframe_graph_list: [],
    keyframes: { adjusts: [], audios: [], effects: [], filters: [], handwrites: [], stickers: [], texts: [], videos: [] },
    last_modified_platform: { app_id: 3704, app_source: 'lv', app_version: '8.9.0', device_id: 'projectdream-probe', os: 'windows' },
    materials: {
      audios: [],
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
        {
          add_type: 0,
          alignment: 1,
          background_alpha: 0.5,
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
          content: '帧心帧意明文探针：如果你能看到这行字，说明剪映能读明文草稿。',
          font_size: 8,
          font_source_platform: 0,
          force_apply_line_max_width: false,
          has_shadow: false,
          id: textMaterialId,
          initial_scale: 1,
          inner_padding: -1,
          italic_degree: 0,
          language: '',
          layer_weight: 1,
          letter_spacing: 0,
          line_feed: 1,
          line_max_width: 0.82,
          line_spacing: 0.02,
          multi_language_current: 'none',
          name: '',
          type: 'text',
          text_color: '#FFFFFF',
          text_size: 8,
          typewriter_duration: 0,
          underline: false,
        },
      ],
      transitions: [],
      videos: [
        {
          aigc_type: 'none',
          audio_fade: null,
          category_id: '',
          category_name: 'local',
          check_flag: 63487,
          crop_ratio: 'free',
          crop_scale: 1,
          duration: durationSeconds * SECOND,
          height: 1920,
          id: videoMaterialId,
          local_material_id: '',
          material_id: videoMaterialId,
          material_name: path.basename(videoPath),
          material_url: '',
          path: videoPath,
          type: 'video',
          width: 1080,
        },
      ],
      vocal_beats: [],
      vocal_separations: [],
    },
    mutable_config: null,
    name: PROBE_NAME,
    new_version: '110.0.0',
    platform: { app_id: 3704, app_source: 'lv', app_version: '8.9.0', device_id: 'projectdream-probe', os: 'windows' },
    relationships: [],
    render_index_track_mode_on: false,
    retouch_cover: null,
    source: 'default',
    static_cover_image_path: '',
    time_marks: null,
    tracks: [
      {
        attribute: 0,
        flag: 0,
        id: 'probe-video-track',
        is_default_name: true,
        name: '',
        segments: [
          {
            cartesian_points: [],
            clip: {
              alpha: 1,
              flip: { horizontal: false, vertical: false },
              rotation: 0,
              scale: { x: 1, y: 1 },
              transform: { x: 0, y: 0 },
            },
            common_keyframes: [],
            enable_adjust: true,
            enable_color_curves: true,
            enable_color_wheels: true,
            enable_smart_color_adjusted: true,
            extra_material_refs: [],
            group_id: '',
            hdr_settings: { intensity: 1, mode: 1, nits: 1000 },
            id: 'probe-video-segment',
            intensifies_audio_query: { audio_denoise_all_allow: false, audio_denoise_allow: false, audio_denoise_status: false },
            keyframe_refs: [],
            last_nonzero_volume: 1,
            material_id: videoMaterialId,
            render_index: 0,
            reverse: false,
            source_timerange: { duration: durationSeconds * SECOND, start: 0 },
            speed: 1,
            target_timerange: { duration: durationSeconds * SECOND, start: 0 },
            template_id: '',
            template_scene: 'default',
            track_attribute: 0,
            track_render_index: 0,
            uniform_scale: { on: true, value: 1 },
            visible: true,
            volume: 1,
          },
        ],
        type: 'video',
      },
      {
        attribute: 0,
        flag: 0,
        id: 'probe-text-track',
        is_default_name: true,
        name: '',
        segments: [
          {
            clip: {
              alpha: 1,
              flip: { horizontal: false, vertical: false },
              rotation: 0,
              scale: { x: 1, y: 1 },
              transform: { x: 0, y: -0.6 },
            },
            common_keyframes: [],
            enable_adjust: false,
            group_id: '',
            id: 'probe-text-segment',
            keyframe_refs: [],
            material_id: textMaterialId,
            render_index: 14000,
            source_timerange: null,
            target_timerange: { duration: durationSeconds * SECOND, start: 0 },
            track_attribute: 0,
            track_render_index: 0,
            visible: true,
          },
        ],
        type: 'text',
      },
    ],
    version: 360000,
  }
}

function buildDraftMetaInfo({ videoPath, durationSeconds = 3 }) {
  return {
    draft_cloud_last_action_download: false,
    draft_cloud_purchase_info: '',
    draft_cloud_template_id: '',
    draft_cloud_tutorial_info: '',
    draft_cover: 'draft_cover.jpg',
    draft_deeplink_url: '',
    draft_enter_editing_page_time: 0,
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
    draft_need_auto_save: false,
    draft_removable_storage_device: '',
    draft_root_path: DRAFT_ROOT.replace(/\\/g, '/'),
    draft_segment_extra_info: [],
    draft_timeline_materials_size_: 0,
    draft_type: 0,
    tm_draft_create: Date.now() * 1000,
    tm_draft_modified: Date.now() * 1000,
    tm_draft_removed: 0,
    tm_duration: durationSeconds * SECOND,
  }
}

async function findProbeVideo() {
  const candidates = [
    path.join(process.cwd(), '.genwork', 'jianying-probe-video', '01_probe.mp4'),
    path.join(process.cwd(), '.genwork', 'jianying-plaintext-probe', '01_probe.mp4'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function prepare() {
  const videoPath = await findProbeVideo()
  if (!videoPath) {
    console.error('没有找到探针用的本地视频，请先把一个真实镜头 mp4 放到：')
    console.error('  .genwork/jianying-probe-video/01_probe.mp4')
    process.exitCode = 1
    return
  }

  await rm(WORK_DIR, { recursive: true, force: true })
  await mkdir(WORK_DIR, { recursive: true })
  await writeFile(
    path.join(WORK_DIR, 'draft_content.json'),
    JSON.stringify(buildDraftContent({ videoPath }), null, 2),
    'utf8',
  )
  await writeFile(
    path.join(WORK_DIR, 'draft_meta_info.json'),
    JSON.stringify(buildDraftMetaInfo({ videoPath }), null, 2),
    'utf8',
  )
  await writeFile(
    path.join(WORK_DIR, 'draft_settings'),
    `[General]\ndraft_create_time=${Math.floor(Date.now() / 1000)}\ndraft_last_edit_time=${Math.floor(Date.now() / 1000)}\n`,
    'utf8',
  )
  console.log(`已生成明文探针草稿：${WORK_DIR}`)
  console.log(`引用视频：${videoPath}`)
  console.log('下一步（先关闭剪映）：')
  console.log(`  node scripts/probe-jianying-plaintext-draft.mjs --install`)
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
  const backupPath = `${INDEX_PATH}.projectdream-backup`
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

  console.log(`已安装探针草稿：${PROBE_DIR}`)
  console.log('现在打开剪映专业版，看草稿列表里有没有「帧心帧意_明文探针」。')
  console.log('测完点删除或运行：node scripts/probe-jianying-plaintext-draft.mjs --uninstall')
}

async function uninstall() {
  await rm(PROBE_DIR, { recursive: true, force: true })
  const backupPath = `${INDEX_PATH}.projectdream-backup`
  if (existsSync(backupPath)) {
    await copyFile(backupPath, INDEX_PATH)
    await rm(backupPath, { force: true })
    console.log('已还原 root_meta_info.json 并删除探针草稿。')
  } else if (existsSync(INDEX_PATH)) {
    const index = JSON.parse(await readFile(INDEX_PATH, 'utf8'))
    const next = {
      ...index,
      all_draft_store: (index.all_draft_store || []).filter((item) => item?.draft_id !== PROBE_DRAFT_ID),
      draft_ids: (index.draft_ids || []).filter((id) => id !== PROBE_DRAFT_ID),
    }
    await writeFile(INDEX_PATH, JSON.stringify(next, null, 2), 'utf8')
    console.log('已从索引移除探针条目并删除探针草稿（没有找到备份文件，只做了精确移除）。')
  } else {
    console.log('没有找到索引文件，只删除了探针草稿目录。')
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
