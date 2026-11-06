// FastAPI-Only 迁移第六阶段：核心生产脚本默认上游由 Node API 切换为 FastAPI（默认 8000，环境变量可覆盖）。
import { spawn } from 'node:child_process'
import mysql from 'mysql2/promise'
import {
  CORE_STORYBOARD_IDS,
  firstAudioAsset,
  parseEpisodeProductionOptions,
  resolveEpisodeAudioTrack,
  shouldReuseEpisodeAudio,
} from './episode-production-options.mjs'

const PROJECT_ID = 12
const API_ORIGIN = process.env.PROJECTDREAM_API_ORIGIN || 'http://127.0.0.1:8000'
const API_BASE = `${API_ORIGIN}/api`
const BASELINE_IMAGE_ASSET_ID = 325
const BASELINE_IMAGE_STORAGE_KEY = 'projects/12/frames/storyboards/267/v1/c1.jpg'
const POLL_INTERVAL_MS = 3000
const JOB_TIMEOUT_MS = 15 * 60 * 1000

const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 2,
}

function fail(message) {
  throw new Error(message)
}

function parseJson(value, fallback = null) {
  if (value && typeof value === 'object') return value
  try {
    return JSON.parse(String(value || ''))
  } catch {
    return fallback
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeSpeakerText(text, speakerName) {
  const source = String(text || '').trim()
  if (!source) return ''
  const name = String(speakerName || '').trim()
  if (!name) return source
  const labeled = new RegExp(`(?:苏岚|林夏|周衡)\\s*(?:（[^）]*）)?\\s*[：:]`, 'g')
  const matches = [...source.matchAll(labeled)]
  if (!matches.length) return source
  const parts = []
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const label = match[0]
    const labelName = label.includes(name) ? name : ''
    if (!labelName) continue
    const start = Number(match.index) + label.length
    const end = matches[index + 1]?.index ?? source.length
    parts.push(source.slice(start, end).trim())
  }
  return parts.join(' ').trim() || source
}

function cleanSubtitleText(text) {
  return String(text || '')
    .replace(/林夏\s*[：:]/g, '')
    .replace(/苏岚\s*（[^）]*）\s*[：:]/g, '')
    .replace(/苏岚\s*[：:]/g, '')
    .replace(/[“”"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function dbConnection() {
  return mysql.createConnection(dbConfig)
}

async function getAuthToken(db) {
  const [rows] = await db.execute(
    `SELECT token
     FROM sessions
     WHERE user_id = (SELECT user_id FROM projects WHERE id = ? LIMIT 1)
       AND revoked_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [PROJECT_ID],
  )
  if (!rows[0]?.token) fail('项目 12 没有可用登录会话，请先在本地页面登录')
  return rows[0].token
}

async function apiRequest(token, pathname, options = {}) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.code) {
    const message = body?.message || `HTTP ${response.status}`
    fail(`${options.method || 'GET'} ${pathname} failed: ${message}`)
  }
  return body.data
}

async function configureAgnesImageProvider(db, token) {
  const [settingsRows] = await db.execute(
    `SELECT setting_key, setting_value
     FROM model_settings
     WHERE setting_key IN ('VIDEO_API_KEY', 'FRAME_API_KEY')`,
  )
  const settings = new Map(settingsRows.map((row) => [row.setting_key, String(row.setting_value || '')]))
  const agnesKey = settings.get('VIDEO_API_KEY') || settings.get('FRAME_API_KEY') || process.env.AGNES_API_KEY || ''
  if (!agnesKey) fail('没有找到 Agnes API key，未启动图片任务')

  await apiRequest(token, '/model-settings', {
    method: 'PUT',
    body: JSON.stringify({
      settings: [
        { key: 'FRAME_PROVIDER', value: 'agnes' },
        { key: 'FRAME_BASE_URL', value: 'https://apihub.agnes-ai.com/v1' },
        { key: 'FRAME_API_KEY', value: agnesKey },
        { key: 'FRAME_MODEL', value: 'agnes-image-2.1-flash' },
        { key: 'FRAME_FALLBACK_MODELS', value: 'agnes-image-2.0-flash' },
        { key: 'FRAME_IMAGE_SIZE', value: '1K' },
        { key: 'FRAME_IMAGE_RATIO', value: '16:9' },
        { key: 'FRAME_FALLBACK_TO_MOCK', value: 'false' },
      ],
    }),
  })
  return { provider: 'agnes', model: 'agnes-image-2.1-flash' }
}

async function updateOpeningShot(token) {
  await apiRequest(token, '/storyboards/267', {
    method: 'PUT',
    body: JSON.stringify({
      shotType: '全景',
      cameraAngle: '低机位',
      composition: '对称构图',
      durationSeconds: 4,
      characterId: 18,
      characterName: '林夏',
      actionText: '林夏蹲在配电箱前确认残余电压接近零，抬头扫过空站台，远处旧广播机突然亮起红灯。',
      dialogueText: '林夏：广播端口理论离线，残余电压接近零。',
      visualPrompt:
        '写实电影感 AI 漫剧，16:9，废弃地铁站站台与设备区，凌晨，冷蓝检修灯切过尘雾，远处老式广播机亮起唯一红色指示灯；林夏保持角色 v7 的同一张脸、低束发、深色城市检修工装、头灯、工牌、绝缘手套和工具包；全景，低机位，对称构图，先是理性检修，再让红灯成为画面唯一异常，电影感高反差，不新增人物，不换脸，不改变服装。',
      shotPurpose: 'hook',
      actingBeat: '先低头确认读数，再抬眼扫过空站台，红灯亮起时停住半拍，情绪从职业冷静转为压抑警觉。',
      audioDirection: '对白语速克制，关键词“理论离线”和“接近零”轻微重读；环境保留滴水和远处空站回声。',
      speechDurationPolicy: 'preserve',
      startVisualPrompt:
        '林夏蹲在配电箱前，头灯照亮测试笔和发白指节，广播机仍处于黑暗，冷蓝站灯压低饱和度。',
      endVisualPrompt:
        '林夏抬头看向远处，旧广播机红灯突然亮起，红光落入她的眼底，表情停住但不夸张。',
      status: 'pending',
    }),
  })
}

async function patchJobWithBaselineReference(db, jobId) {
  const [rows] = await db.execute(
    `SELECT request_json
     FROM generation_jobs
     WHERE id = ?
     LIMIT 1`,
    [jobId],
  )
  if (!rows[0]) fail(`generation_job #${jobId} 不存在`)
  const request = parseJson(rows[0].request_json, {})
  const keys = Array.isArray(request.referenceImageStorageKeys)
    ? request.referenceImageStorageKeys
    : []
  request.referenceImageStorageKeys = [...new Set([...keys, BASELINE_IMAGE_STORAGE_KEY])]
  await db.execute(
    `UPDATE generation_jobs
     SET request_json = ?, updated_at = NOW()
     WHERE id = ?`,
    [JSON.stringify(request), jobId],
  )
}

async function runControlledWorker(jobId) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--env-file=.env.local', '--env-file-if-exists=.env.production', 'scripts/run-worker.mjs'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          APP_RUNTIME_ROLE: 'worker',
          GENERATION_WORKER_CONCURRENCY: '1',
          GENERATION_WORKER_MAX_JOBS: '1',
          GENERATION_WORKER_ONLY_JOB_ID: String(jobId),
          EXPORT_WORKER_ONLY_EXPORT_ID: '',
        },
        stdio: 'ignore',
        windowsHide: true,
      },
    )
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`worker for job #${jobId} exited with code ${code}`))
    })
  })
}

async function waitForJob(token, jobId) {
  const deadline = Date.now() + JOB_TIMEOUT_MS
  while (Date.now() < deadline) {
    const job = await apiRequest(token, `/generation-jobs/${jobId}`)
    if (job.status === 'success') return job
    if (job.status === 'failed' || job.status === 'canceled') {
      fail(`generation_job #${jobId} ${job.status}: ${job.errorText || job.lastErrorCode || 'unknown error'}`)
    }
    await sleep(POLL_INTERVAL_MS)
  }
  fail(`generation_job #${jobId} polling timed out`)
}

async function generateImage(token, db, storyboardId) {
  const [existingRows] = await db.execute(
    `SELECT *
     FROM image_assets
     WHERE storyboard_id = ?
       AND status = 'confirmed'
       AND model_name LIKE 'agnes-%'
       AND id > ?
     ORDER BY id DESC
     LIMIT 1`,
    [storyboardId, BASELINE_IMAGE_ASSET_ID],
  )
  if (existingRows[0]) {
    return { id: Number(existingRows[0].id), reused: true }
  }

  const job = await apiRequest(token, `/shots/${storyboardId}/images/generate`, {
    method: 'POST',
    body: JSON.stringify({
      modelName: 'agnes-image-2.1-flash',
      candidateCount: 1,
      frameRole: 'primary',
      negativePrompt:
        '换脸，男性主角，改变女性性别，发型变化，服装变化，体型变化，多余人物，额外手指，文字水印，黑边，字幕，血腥，肢体伤害',
    }),
  })
  await patchJobWithBaselineReference(db, Number(job.id))
  const completed = await (async () => {
    await runControlledWorker(Number(job.id))
    return waitForJob(token, Number(job.id))
  })()
  const image = completed.result?.items?.[0]
  if (!image?.id) fail(`generation_job #${job.id} 完成但没有返回图片资产`)
  await apiRequest(token, `/images/${image.id}/confirm`, { method: 'POST' })
  return { id: Number(image.id), reused: false, jobId: Number(job.id) }
}

async function generateVideo(token, db, storyboardId, durationSeconds) {
  const [existingRows] = await db.execute(
    `SELECT *
     FROM video_assets
     WHERE storyboard_id = ?
       AND status IN ('confirmed', 'archived')
       AND COALESCE(source_type, 'generated_video') <> 'lip_sync'
       AND model_name = 'agnes-video-v2.0'
     ORDER BY id DESC
     LIMIT 1`,
    [storyboardId],
  )
  if (existingRows[0]) {
    return { id: Number(existingRows[0].id), reused: true }
  }

  const job = await apiRequest(token, `/storyboards/${storyboardId}/videos/generate`, {
    method: 'POST',
    body: JSON.stringify({
      modelName: 'agnes-video-v2.0',
      motionMode: 'PAN',
      durationSeconds: Math.max(5, Math.min(8, Number(durationSeconds) || 5)),
      candidateCount: 1,
      autoConfirm: true,
    }),
  })
  const completed = await (async () => {
    await runControlledWorker(Number(job.id))
    return waitForJob(token, Number(job.id))
  })()
  const video = completed.result?.items?.[0]
  if (!video?.id) fail(`generation_job #${job.id} 完成但没有返回视频资产`)
  return { id: Number(video.id), reused: false, jobId: Number(job.id) }
}

async function generateAudio(token, db, storyboard, characterId, text, track = {}) {
  const trackType = track.trackType || 'dialogue'
  const sourceCharacterId = trackType === 'narration' ? null : Number(characterId) || null
  const [existingRows] = await db.execute(
    `SELECT id
     FROM audio_assets
     WHERE project_id = ?
       AND storyboard_id = ?
       AND (character_id <=> ?)
       AND track_type = ?
       AND status = 'confirmed'
     ORDER BY id DESC
     LIMIT 1`,
    [PROJECT_ID, storyboard.id, sourceCharacterId, trackType],
  )
  if (shouldReuseEpisodeAudio(existingRows[0], text)) {
    return { id: Number(existingRows[0].id), reused: true }
  }

  const items = await apiRequest(token, `/projects/${PROJECT_ID}/audio/generate`, {
    method: 'POST',
    body: JSON.stringify({
      trackType,
      sceneId: storyboard.sceneId,
      storyboardId: storyboard.id,
      ...(sourceCharacterId ? { characterId: sourceCharacterId } : {}),
      ...(track.voiceProfileKey ? { voiceProfileKey: track.voiceProfileKey } : {}),
      text,
      durationSeconds: Math.max(2, Number(storyboard.durationSeconds) || 3),
      candidateCount: 1,
    }),
  })
  const audio = firstAudioAsset(items)
  if (!audio?.id) fail(`分镜 #${storyboard.id} 未返回对白音频`)
  await apiRequest(token, `/audio-assets/${audio.id}/confirm`, { method: 'POST' })
  return { id: Number(audio.id), reused: false }
}

function getAudioSegments(storyboard) {
  const text = String(storyboard.dialogueText || '')
  const segments = []
  if (text.includes('苏岚')) {
    const suLan = text.match(/苏岚[^：:]*[：:]\s*([^。！？\n]+[。！？]?)/)?.[1]?.trim()
    if (suLan) segments.push({ characterId: 20, text: suLan })
  }
  if (text.includes('林夏')) {
    const linXia = text.match(/林夏\s*[：:]\s*([^。！？\n]+(?:[。！？][^。！？\n]*)?)/)?.[1]?.trim()
    if (linXia) segments.push({ characterId: 18, text: linXia })
  }
  if (!segments.length && storyboard.characterId && !text.includes('（无对白）')) {
    segments.push({
      characterId: Number(storyboard.characterId),
      text: normalizeSpeakerText(text, storyboard.characterName),
    })
  }
  return segments.filter((item) => item.text)
}

async function generateLipSync(token, storyboard, speakerAudioId) {
  if (Number(storyboard.characterId) !== 18 || !speakerAudioId) return null
  const existing = await apiRequest(
    token,
    `/storyboards/${storyboard.id}/videos`,
  )
  const existingLipSync = (existing?.items || []).find(
    (item) =>
      item.sourceType === 'lip_sync' &&
      item.status === 'confirmed' &&
      Number(item.audioAssetId) === Number(speakerAudioId),
  )
  if (existingLipSync) {
    return { id: Number(existingLipSync.id), reused: true }
  }

  const job = await apiRequest(token, `/storyboards/${storyboard.id}/lip-sync/generate`, {
    method: 'POST',
    body: JSON.stringify({ autoConfirm: true }),
  })
  await runControlledWorker(Number(job.id))
  const completed = await waitForJob(token, Number(job.id))
  const video = completed.result?.item || completed.result?.items?.[0]
  if (!video?.id) fail(`分镜 #${storyboard.id} 口型同步任务完成但没有返回视频`)
  return { id: Number(video.id), jobId: Number(job.id) }
}

function buildSubtitleText(storyboard) {
  const text = cleanSubtitleText(storyboard.dialogueText)
  if (!text || text === '（无对白）') return ''
  return text
}

async function saveEpisodeDraft(token, storyboards) {
  const videoClips = storyboards.map((storyboard, index) => ({
    storyboardId: storyboard.id,
    enabled: true,
    order: index + 1,
  }))
  const subtitleCues = storyboards
    .map((storyboard) => ({
      cueId: `episode-1-${storyboard.id}`,
      storyboardId: storyboard.id,
      enabled: Boolean(buildSubtitleText(storyboard)),
      startOffsetSeconds: 0,
      durationSeconds: Math.max(2, Number(storyboard.durationSeconds) || 3),
      text: buildSubtitleText(storyboard),
    }))
    .filter((cue) => cue.text)

  return apiRequest(token, `/projects/${PROJECT_ID}/final-edit-draft`, {
    method: 'PUT',
    body: JSON.stringify({
      videoClips,
      audioMix: {
        dialogue: { enabled: true, volume: 96 },
        narration: { enabled: false, volume: 0 },
        music: { enabled: false, volume: 0 },
        sfx: { enabled: false, volume: 0 },
      },
      subtitleCues,
    }),
  })
}

async function createPreviewExport(token) {
  const record = await apiRequest(token, `/projects/${PROJECT_ID}/exports`, {
    method: 'POST',
    body: JSON.stringify({
      format: 'mp4',
      resolution: '1920x1080',
      frameRate: 30,
      burnSubtitle: true,
    }),
  })
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--env-file=.env.local', '--env-file-if-exists=.env.production', 'scripts/run-worker.mjs'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          APP_RUNTIME_ROLE: 'worker',
          GENERATION_WORKER_ONLY_JOB_ID: '',
          EXPORT_WORKER_ONLY_EXPORT_ID: String(record.id),
          EXPORT_WORKER_CONCURRENCY: '1',
          EXPORT_WORKER_MAX_JOBS: '1',
        },
        stdio: 'ignore',
        windowsHide: true,
      },
    )
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`export worker for #${record.id} exited with code ${code}`))
    })
  })

  const deadline = Date.now() + JOB_TIMEOUT_MS
  while (Date.now() < deadline) {
    const exportRecord = await apiRequest(token, `/exports/${record.id}`)
    if (exportRecord.status === 'completed') return exportRecord
    if (exportRecord.status === 'failed' || exportRecord.status === 'canceled') {
      fail(`export #${record.id} ${exportRecord.status}`)
    }
    await sleep(POLL_INTERVAL_MS)
  }
  fail(`export #${record.id} polling timed out`)
}

async function main() {
  const options = parseEpisodeProductionOptions(process.argv.slice(2))
  if (options.dryRun) {
    console.log(JSON.stringify({
      projectId: PROJECT_ID,
      episode: 1,
      storyboardIds: options.storyboardIds,
      skipExport: options.skipExport,
      dryRun: true,
    }, null, 2))
    return
  }

  const db = await dbConnection()
  try {
    const token = await getAuthToken(db)
    const imageConfig = await configureAgnesImageProvider(db, token)
    if (options.storyboardIds.includes(267)) {
      await updateOpeningShot(token)
    }

    const placeholders = options.storyboardIds.map(() => '?').join(', ')
    const orderExpression = options.storyboardIds.join(',')
    const [storyboardRows] = await db.execute(
      `SELECT id, scene_id AS sceneId, shot_no AS shotNo, duration_seconds AS durationSeconds,
              character_id AS characterId, character_name AS characterName, dialogue_text AS dialogueText
       FROM storyboards
       WHERE id IN (${placeholders})
       ORDER BY FIELD(id, ${orderExpression})`,
      options.storyboardIds,
    )
    if (storyboardRows.length !== options.storyboardIds.length) {
      fail(`第一集核心镜头缺失：期望 ${options.storyboardIds.length} 条，实际 ${storyboardRows.length} 条`)
    }

    const results = []
    if (!options.exportOnly) {
      for (const storyboard of storyboardRows) {
        const image = await generateImage(token, db, Number(storyboard.id))
        const video = await generateVideo(
          token,
          db,
          Number(storyboard.id),
          Number(storyboard.durationSeconds),
        )
        const audio = []
        for (const segment of getAudioSegments(storyboard)) {
          const audioTrack = resolveEpisodeAudioTrack(segment)
          audio.push({
            ...segment,
            ...audioTrack,
            ...(await generateAudio(
              token,
              db,
              storyboard,
              audioTrack.characterId,
              segment.text,
              audioTrack,
            )),
          })
        }
        const lipSyncAudio = audio.find((item) => Number(item.characterId) === Number(storyboard.characterId))
        const lipSync = await generateLipSync(token, storyboard, lipSyncAudio?.id)
        results.push({
          storyboardId: Number(storyboard.id),
          shotNo: storyboard.shotNo,
          image,
          video,
          audio,
          lipSync,
        })
        console.log(JSON.stringify({
          storyboardId: Number(storyboard.id),
          shotNo: storyboard.shotNo,
          imageId: image.id,
          videoId: video.id,
          audioIds: audio.map((item) => item.id),
          lipSyncVideoId: lipSync?.id || null,
        }))
      }
    }

    await saveEpisodeDraft(token, storyboardRows)
    const previewExport = options.skipExport ? null : await createPreviewExport(token)
    const qualityReport = previewExport
      ? await apiRequest(token, `/exports/${previewExport.id}/quality-report`, {
          method: 'POST',
          body: JSON.stringify({}),
        })
      : null

    console.log(JSON.stringify({
      projectId: PROJECT_ID,
      episode: 1,
      storyboardIds: options.storyboardIds,
      imageProvider: imageConfig,
      baselineImageAssetId: BASELINE_IMAGE_ASSET_ID,
      previewExportId: previewExport?.id || null,
      previewExportStatus: previewExport?.status || null,
      qualityReportId: qualityReport?.id || null,
      note: '机器生产闭环已完成；人工完整播放、音质、字幕可读性、人物一致性和平台合规仍需人工确认。',
    }, null, 2))
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
