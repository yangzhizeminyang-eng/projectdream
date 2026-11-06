// FastAPI-Only 迁移第六阶段：参照重制脚本默认上游由 Node API 切换为 FastAPI（默认 8000，环境变量可覆盖）。
import { spawn } from 'node:child_process'
import mysql from 'mysql2/promise'

import {
  REFERENCE_REMAKE_PLAN,
  REFERENCE_REMAKE_VERSION,
  referenceRemakeStoryboardIds,
} from './episode-one-reference-plan.mjs'
import {
  buildReferenceAudioSegments,
  cleanReferenceSubtitleText,
} from './episode-one-reference-audio.mjs'

const PROJECT_ID = 12
const API_ORIGIN = process.env.PROJECTDREAM_API_ORIGIN || 'http://127.0.0.1:8000'
const API_BASE = `${API_ORIGIN}/api`
const BASELINE_IMAGE_STORAGE_KEY = 'projects/12/frames/storyboards/267/v1/c1.jpg'
const POLL_INTERVAL_MS = 3000
const JOB_TIMEOUT_MS = 30 * 60 * 1000
const SCENE_ONE_NO = 1
const SCENE_TWO_NO = 2

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

function parseArgs(args = []) {
  const startShotArg = args.find((arg) => arg.startsWith('--start-shot='))
  const shotListArg = args.find((arg) => arg.startsWith('--shots='))
  return {
    dryRun: args.includes('--dry-run'),
    skipExport: args.includes('--skip-export'),
    exportOnly: args.includes('--export-only'),
    reuseImages: args.includes('--reuse-images'),
    reuseAudio: args.includes('--reuse-audio'),
    regenerateVideos: args.includes('--regenerate-videos'),
    forceRegenerate: !args.includes('--reuse-existing'),
    startShot: startShotArg ? startShotArg.split('=').slice(1).join('=').trim() : '',
    shotList: shotListArg
      ? shotListArg
          .split('=')
          .slice(1)
          .join('=')
          .split(',')
          .map((value) => normalizeShotNo(value))
          .filter(Boolean)
      : [],
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function dbConnection() {
  return mysql.createPool(dbConfig)
}

function normalizeShotNo(value) {
  return String(value || '').trim().padStart(2, '0')
}

function resolveProcessingPlan(plan, startShot) {
  if (!String(startShot || '').trim()) return plan
  const normalizedStartShot = normalizeShotNo(startShot)

  const startIndex = plan.findIndex((item) => normalizeShotNo(item.shotNo) === normalizedStartShot)
  if (startIndex < 0) fail(`续跑起点不存在：shot ${startShot}`)
  return plan.slice(startIndex)
}

function resolveShotList(plan, shotList = []) {
  if (!shotList.length) return plan
  const wanted = new Set(shotList.map((shotNo) => normalizeShotNo(shotNo)))
  const selected = plan.filter((item) => wanted.has(normalizeShotNo(item.shotNo)))
  if (selected.length !== wanted.size) {
    const found = new Set(selected.map((item) => normalizeShotNo(item.shotNo)))
    const missing = [...wanted].filter((shotNo) => !found.has(shotNo))
    fail(`指定镜头不存在：${missing.join(', ')}`)
  }
  return selected
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
    fail(`${options.method || 'GET'} ${pathname} failed: ${body?.message || `HTTP ${response.status}`}`)
  }
  return body.data
}

async function configureAgnesImageProvider(db, token) {
  const [settingsRows] = await db.execute(
    `SELECT setting_key, setting_value
     FROM model_settings
     WHERE setting_key IN ('VIDEO_API_KEY', 'FRAME_API_KEY')`,
  )
  const settings = new Map(
    settingsRows.map((row) => [row.setting_key, String(row.setting_value || '')]),
  )
  const agnesKey =
    settings.get('VIDEO_API_KEY') ||
    settings.get('FRAME_API_KEY') ||
    process.env.AGNES_API_KEY ||
    ''
  if (!agnesKey) fail('没有找到 Agnes API key，未启动参考片重制')

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

async function ensureStoryboardPlan(db) {
  const [sceneRows] = await db.execute(
    `SELECT id, scene_no AS sceneNo
     FROM script_scenes
     WHERE project_id = ? AND scene_no IN (?, ?)
     ORDER BY scene_no ASC`,
    [PROJECT_ID, SCENE_ONE_NO, SCENE_TWO_NO],
  )
  const sceneByNo = new Map(sceneRows.map((row) => [Number(row.sceneNo), Number(row.id)]))
  if (!sceneByNo.has(SCENE_ONE_NO) || !sceneByNo.has(SCENE_TWO_NO)) {
    fail('项目 12 缺少第一集需要的场景 1 或场景 2')
  }

  const connection = await db.getConnection()
  const resolved = []
  try {
    await connection.beginTransaction()

    for (const [index, item] of REFERENCE_REMAKE_PLAN.entries()) {
      let storyboardId = Number(item.storyboardId) || 0
      if (!storyboardId && item.storyboardKey) {
        const [existingRows] = await connection.execute(
          `SELECT s.id
           FROM storyboards s
           INNER JOIN script_scenes sc ON sc.id = s.scene_id
           WHERE sc.project_id = ? AND sc.scene_no = ? AND s.shot_no = ?
           ORDER BY s.id DESC
           LIMIT 1`,
          [PROJECT_ID, SCENE_TWO_NO, item.shotNo],
        )
        if (existingRows[0]?.id) {
          storyboardId = Number(existingRows[0].id)
        } else {
          const [insertResult] = await connection.execute(
            `INSERT INTO storyboards
               (scene_id, shot_no, shot_type, camera_angle, composition, duration_seconds,
                character_id, character_name, action_text, dialogue_text, visual_prompt,
                shot_purpose, acting_beat, audio_direction, speech_duration_policy, reaction_shot,
                start_visual_prompt, end_visual_prompt, sort_order, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preserve', ?, ?, ?, ?, 'pending')`,
            [
              sceneByNo.get(SCENE_TWO_NO),
              item.shotNo,
              item.shotType,
              item.cameraAngle,
              item.composition,
              item.durationSeconds,
              item.characterId || null,
              item.characterName || null,
              item.actionText,
              item.dialogueText,
              item.visualPrompt,
              item.shotPurpose,
              item.actingBeat,
              item.audioDirection,
              item.shotPurpose === 'reaction' || item.shotPurpose === 'insert' ? 1 : 0,
              item.startVisualPrompt,
              item.endVisualPrompt,
              index,
            ],
          )
          storyboardId = Number(insertResult.insertId)
        }
      }

      if (!storyboardId) fail(`镜头 ${item.shotNo} 没有可用 storyboardId`)

      const sceneNo = Number(item.sceneNo) || SCENE_TWO_NO
      const sceneId = sceneByNo.get(sceneNo)
      if (!sceneId) fail(`镜头 ${item.shotNo} 缺少 scene ${sceneNo}`)

      await connection.execute(
        `UPDATE storyboards
         SET scene_id = ?,
             shot_no = ?,
             shot_type = ?,
             camera_angle = ?,
             composition = ?,
             duration_seconds = ?,
             character_id = ?,
             character_name = ?,
             action_text = ?,
             dialogue_text = ?,
             visual_prompt = ?,
             shot_purpose = ?,
             acting_beat = ?,
             audio_direction = ?,
             speech_duration_policy = 'preserve',
             reaction_shot = ?,
             start_visual_prompt = ?,
             end_visual_prompt = ?,
             sort_order = ?,
             status = 'pending',
             updated_at = NOW()
         WHERE id = ?`,
        [
          sceneId,
          item.shotNo,
          item.shotType,
          item.cameraAngle,
          item.composition,
          item.durationSeconds,
          item.characterId || null,
          item.characterName || null,
          item.actionText,
          item.dialogueText,
          item.visualPrompt,
          item.shotPurpose,
          item.actingBeat,
          item.audioDirection,
          item.shotPurpose === 'reaction' || item.shotPurpose === 'insert' ? 1 : 0,
          item.startVisualPrompt,
          item.endVisualPrompt,
          sceneNo === SCENE_ONE_NO ? index : index - 5,
          storyboardId,
        ],
      )

      resolved.push({ ...item, storyboardId, sceneId })
    }

    const sceneOneDuration = resolved
      .filter((item) => Number(item.sceneNo) === SCENE_ONE_NO)
      .reduce((sum, item) => sum + Number(item.durationSeconds || 0), 0)
    const sceneTwoDuration = resolved
      .filter((item) => Number(item.sceneNo) === SCENE_TWO_NO)
      .reduce((sum, item) => sum + Number(item.durationSeconds || 0), 0)
    await connection.execute(
      `UPDATE script_scenes
       SET estimated_duration = ?, updated_at = NOW()
       WHERE id = ?`,
      [sceneOneDuration, sceneByNo.get(SCENE_ONE_NO)],
    )
    await connection.execute(
      `UPDATE script_scenes
       SET estimated_duration = ?, updated_at = NOW()
       WHERE id = ?`,
      [sceneTwoDuration, sceneByNo.get(SCENE_TWO_NO)],
    )

    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }

  return resolved
}

async function patchJobWithBaselineReference(db, jobId) {
  const [rows] = await db.execute(
    `SELECT request_json FROM generation_jobs WHERE id = ? LIMIT 1`,
    [jobId],
  )
  if (!rows[0]) fail(`generation_job #${jobId} 不存在`)
  let request = {}
  try {
    request = JSON.parse(String(rows[0].request_json || '{}'))
  } catch {
    request = {}
  }
  request.referenceImageStorageKeys = [
    ...new Set([
      ...(Array.isArray(request.referenceImageStorageKeys)
        ? request.referenceImageStorageKeys
        : []),
      BASELINE_IMAGE_STORAGE_KEY,
    ]),
  ]
  await db.execute(
    `UPDATE generation_jobs SET request_json = ?, updated_at = NOW() WHERE id = ?`,
    [JSON.stringify(request), jobId],
  )
}

async function archiveExistingEpisodeAudio(db, storyboards) {
  const storyboardIds = storyboards
    .map((item) => Number(item.storyboardId))
    .filter((id) => Number.isSafeInteger(id) && id > 0)
  if (!storyboardIds.length) return

  const placeholders = storyboardIds.map(() => '?').join(', ')
  await db.execute(
    `UPDATE audio_assets
     SET status = 'archived'
     WHERE project_id = ?
       AND storyboard_id IN (${placeholders})
       AND status = 'confirmed'`,
    [PROJECT_ID, ...storyboardIds],
  )
}

async function loadConfirmedAudioByStoryboard(db, storyboardIds) {
  const ids = storyboardIds
    .map((id) => Number(id))
    .filter((id) => Number.isSafeInteger(id) && id > 0)
  if (!ids.length) return new Map()

  const placeholders = ids.map(() => '?').join(', ')
  const [rows] = await db.execute(
    `SELECT id, storyboard_id AS storyboardId, duration_seconds AS durationSeconds,
            track_type AS trackType
     FROM audio_assets
     WHERE project_id = ?
       AND storyboard_id IN (${placeholders})
       AND status = 'confirmed'
     ORDER BY storyboard_id ASC, id DESC`,
    [PROJECT_ID, ...ids],
  )

  const audioByStoryboard = new Map()
  for (const row of rows) {
    const storyboardId = Number(row.storyboardId)
    if (!audioByStoryboard.has(storyboardId)) {
      audioByStoryboard.set(storyboardId, row)
    }
  }
  return audioByStoryboard
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

async function generateImage(token, db, storyboard, forceRegenerate) {
  const storyboardId = Number(storyboard.storyboardId)
  if (!forceRegenerate) {
    const [existingRows] = await db.execute(
      `SELECT id
       FROM image_assets
       WHERE storyboard_id = ? AND status = 'confirmed'
       ORDER BY confirmed_at DESC, id DESC
       LIMIT 1`,
      [storyboardId],
    )
    if (existingRows[0]) return { id: Number(existingRows[0].id), reused: true }
  }

  const job = await apiRequest(token, `/shots/${storyboardId}/images/generate`, {
    method: 'POST',
    body: JSON.stringify({
      modelName: 'agnes-image-2.1-flash',
      candidateCount: 1,
      frameRole: 'primary',
      prompt:
        Number(storyboard.characterId) > 0 || String(storyboard.characterName || '').trim()
          ? undefined
          : `${storyboard.visualPrompt} 画面绝对无人、无手、无身体、无脸、无人物轮廓，只允许广播设备、扬声器、旋钮、红灯、导线和环境。`,
      negativePrompt: [
        '换脸，男性主角，改变女性性别，发型变化，服装变化，体型变化，多余人物，额外手指，文字水印，黑边，字幕，血腥，肢体伤害',
        Number(storyboard.characterId) > 0 || String(storyboard.characterName || '').trim()
          ? ''
          : '人物，任何人，女性，男性，林夏，苏岚，脸，面部，身体，手，手臂，手套，人物轮廓，人影，背影，角色出镜',
      ]
        .filter(Boolean)
        .join('，'),
    }),
  })
  const hasVisualCharacter =
    Number(storyboard.characterId) > 0 || Boolean(String(storyboard.characterName || '').trim())
  if (hasVisualCharacter) {
    await patchJobWithBaselineReference(db, Number(job.id))
  }
  await runControlledWorker(Number(job.id))
  const completed = await waitForJob(token, Number(job.id))
  const image = completed.result?.items?.[0]
  if (!image?.id) fail(`generation_job #${job.id} 完成但没有返回图片资产`)
  await apiRequest(token, `/images/${image.id}/confirm`, { method: 'POST' })
  return { id: Number(image.id), reused: false, jobId: Number(job.id) }
}

async function generateVideo(token, db, storyboardId, durationSeconds, forceRegenerate) {
  if (!forceRegenerate) {
    const [existingRows] = await db.execute(
      `SELECT id
       FROM video_assets
       WHERE storyboard_id = ? AND status = 'confirmed'
       ORDER BY confirmed_at DESC, id DESC
       LIMIT 1`,
      [storyboardId],
    )
    if (existingRows[0]) return { id: Number(existingRows[0].id), reused: true }
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
  await runControlledWorker(Number(job.id))
  const completed = await waitForJob(token, Number(job.id))
  const video = completed.result?.items?.[0]
  if (!video?.id) fail(`generation_job #${job.id} 完成但没有返回视频资产`)
  return { id: Number(video.id), reused: false, jobId: Number(job.id) }
}

async function generateAudio(token, storyboard, segment) {
  const storyboardId = Number(storyboard.id || storyboard.storyboardId)
  const items = await apiRequest(token, `/projects/${PROJECT_ID}/audio/generate`, {
    method: 'POST',
    body: JSON.stringify({
      trackType: segment.trackType,
      sceneId: storyboard.sceneId,
      storyboardId,
      ...(segment.characterId ? { characterId: segment.characterId } : {}),
      voiceProfileKey: segment.voiceProfileKey,
      text: segment.text,
      durationSeconds: Math.max(2, Number(storyboard.durationSeconds) || 3),
      candidateCount: 1,
    }),
  })
  const audio = Array.isArray(items) ? items[0] : items?.items?.[0]
  if (!audio?.id) fail(`分镜 #${storyboard.id} 未返回音频资产`)
  await apiRequest(token, `/audio-assets/${audio.id}/confirm`, { method: 'POST' })
  return {
    id: Number(audio.id),
    durationSeconds: Number(audio.durationSeconds || 0),
    ...segment,
  }
}

async function generateLipSync(token, storyboardId, speakerAudioId) {
  if (!speakerAudioId) return null
  const db = await dbConnection()
  let rows
  try {
    ;[rows] = await db.execute(
      `SELECT character_id AS characterId
       FROM storyboards
       WHERE id = ? LIMIT 1`,
      [storyboardId],
    )
  } finally {
    await db.end()
  }
  if (Number(rows[0]?.characterId) !== 18) return null

  const job = await apiRequest(token, `/storyboards/${storyboardId}/lip-sync/generate`, {
    method: 'POST',
    body: JSON.stringify({ autoConfirm: true }),
  })
  await runControlledWorker(Number(job.id))
  const completed = await waitForJob(token, Number(job.id))
  const video = completed.result?.item || completed.result?.items?.[0]
  if (!video?.id) fail(`分镜 #${storyboardId} 口型同步任务完成但没有返回视频`)
  return { id: Number(video.id), audioAssetId: speakerAudioId, jobId: Number(job.id) }
}

async function saveEpisodeDraft(token, storyboards, audioByStoryboard) {
  const videoClips = storyboards.map((storyboard, index) => ({
    storyboardId: storyboard.id,
    enabled: true,
    order: index + 1,
  }))
  const subtitleCues = storyboards
    .map((storyboard) => {
      const text = cleanReferenceSubtitleText(storyboard.dialogueText)
      const audio = audioByStoryboard.get(Number(storyboard.id))
      return {
        cueId: `${REFERENCE_REMAKE_VERSION}-${storyboard.id}`,
        storyboardId: storyboard.id,
        enabled: Boolean(text),
        startOffsetSeconds: 0,
        durationSeconds: Math.min(
          Math.max(0.25, Number(storyboard.durationSeconds) || 2),
          Math.max(0.25, Number(audio?.durationSeconds || storyboard.durationSeconds || 2) + 0.25),
        ),
        text,
      }
    })
    .filter((cue) => cue.text)

  return apiRequest(token, `/projects/${PROJECT_ID}/final-edit-draft`, {
    method: 'PUT',
    body: JSON.stringify({
      videoClips,
      audioMix: {
        dialogue: { enabled: true, volume: 96 },
        narration: { enabled: true, volume: 92 },
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
      resolution: '1080x1920',
      frameRate: 24,
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
  const options = parseArgs(process.argv.slice(2))
  if (options.dryRun) {
    const dryProcessingPlan = resolveShotList(
      resolveProcessingPlan(REFERENCE_REMAKE_PLAN, options.startShot),
      options.shotList,
    )
    console.log(
      JSON.stringify(
        {
          projectId: PROJECT_ID,
          episode: 1,
          version: REFERENCE_REMAKE_VERSION,
          shotCount: REFERENCE_REMAKE_PLAN.length,
          referenceStoryboardIds: referenceRemakeStoryboardIds(),
          newStoryboardCount: REFERENCE_REMAKE_PLAN.filter((item) => item.storyboardKey).length,
          skipExport: options.skipExport,
          forceRegenerate: options.forceRegenerate,
          reuseImages: options.reuseImages,
          reuseAudio: options.reuseAudio,
          regenerateVideos: options.regenerateVideos,
          startShot: options.startShot || null,
          shotList: options.shotList.length ? options.shotList : null,
          processingShotCount: dryProcessingPlan.length,
          resolution: '1080x1920',
          frameRate: 24,
        },
        null,
        2,
      ),
    )
    return
  }

  const db = await dbConnection()
  try {
    const token = await getAuthToken(db)
    const imageConfig = await configureAgnesImageProvider(db, token)
    const resolvedPlan = await ensureStoryboardPlan(db)
    const storyboardIds = resolvedPlan.map((item) => Number(item.storyboardId))
    const processingPlan = resolveShotList(
      resolveProcessingPlan(resolvedPlan, options.startShot),
      options.shotList,
    )
    const processingKeys = new Set(processingPlan.map((item) => item.key))
    const skippedStoryboardIds = resolvedPlan
      .filter((item) => !processingKeys.has(item.key))
      .map((item) => Number(item.storyboardId))
    const results = []
    const audioByStoryboard = await loadConfirmedAudioByStoryboard(
      db,
      options.reuseAudio ? storyboardIds : skippedStoryboardIds,
    )

    if (!options.exportOnly) {
      const regenerateImages = options.forceRegenerate && !options.reuseImages
      const regenerateVideos = options.forceRegenerate || options.regenerateVideos
      if (options.forceRegenerate && !options.reuseAudio) {
        await archiveExistingEpisodeAudio(db, processingPlan)
      }
      for (const storyboard of processingPlan) {
        const image = await generateImage(token, db, storyboard, regenerateImages)
        const video = await generateVideo(
          token,
          db,
          Number(storyboard.storyboardId),
          Number(storyboard.durationSeconds),
          regenerateVideos,
        )
        const audioSegments = buildReferenceAudioSegments([storyboard]).map((segment) => ({
          ...segment,
          storyboardId: Number(storyboard.storyboardId),
        }))
        const audio = []
        for (const segment of audioSegments) {
          const existingAudio = options.reuseAudio
            ? audioByStoryboard.get(Number(storyboard.storyboardId))
            : null
          const generated = existingAudio &&
            existingAudio.trackType === segment.trackType
            ? {
                id: Number(existingAudio.id),
                durationSeconds: Number(existingAudio.durationSeconds || 0),
                ...segment,
              }
            : await generateAudio(token, storyboard, segment)
          audio.push(generated)
          audioByStoryboard.set(Number(storyboard.storyboardId), generated)
        }
        const speechAudio = audio.find((item) => item.trackType === 'dialogue')
        const lipSync = await generateLipSync(
          token,
          Number(storyboard.storyboardId),
          speechAudio?.id,
        )
        results.push({
          storyboardId: Number(storyboard.storyboardId),
          shotNo: storyboard.shotNo,
          image,
          video,
          audio,
          lipSync,
        })
        console.log(
          JSON.stringify({
            storyboardId: Number(storyboard.storyboardId),
            shotNo: storyboard.shotNo,
            imageId: image.id,
            videoId: video.id,
            audioIds: audio.map((item) => item.id),
            lipSyncVideoId: lipSync?.id || null,
          }),
        )
      }
    } else {
      const confirmedAudio = await loadConfirmedAudioByStoryboard(db, storyboardIds)
      for (const [storyboardId, audio] of confirmedAudio.entries()) {
        audioByStoryboard.set(storyboardId, audio)
      }
    }

    const orderedStoryboards = resolvedPlan.map((item) => ({
      ...item,
      id: Number(item.storyboardId),
      sceneId: Number(item.sceneId),
    }))
    await saveEpisodeDraft(token, orderedStoryboards, audioByStoryboard)
    const previewExport = options.skipExport ? null : await createPreviewExport(token)
    const qualityReport = previewExport
      ? await apiRequest(token, `/exports/${previewExport.id}/quality-report`, {
          method: 'POST',
          body: JSON.stringify({}),
        })
      : null

    console.log(
      JSON.stringify(
        {
          projectId: PROJECT_ID,
          episode: 1,
          version: REFERENCE_REMAKE_VERSION,
          shotCount: resolvedPlan.length,
          storyboardIds: resolvedPlan.map((item) => Number(item.storyboardId)),
          imageProvider: imageConfig,
          regeneratedCount: results.filter((item) => !item.image.reused && !item.video.reused).length,
          previewExportId: previewExport?.id || null,
          previewExportStatus: previewExport?.status || null,
          qualityReportId: qualityReport?.id || null,
          note:
            '参考片重制机器链路已完成；必须人工完整播放确认声音、口型、字幕、情绪递进和抖音安全区后，才能作为试点发布候选。',
        },
        null,
        2,
      ),
    )
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
