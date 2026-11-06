// FastAPI-Only 迁移第六阶段：导出脚本默认上游由 Node API 切换为 FastAPI（默认 8000，环境变量可覆盖）。
import { spawn } from 'node:child_process'
import mysql from 'mysql2/promise'

import {
  EPISODE_ONE_VALIDATION_SCENES,
  validateEpisodeOneValidationScenes,
} from './episode-one-validation-scenes.mjs'

const PROJECT_ID = 12
const API_ORIGIN = process.env.PROJECTDREAM_API_ORIGIN || 'http://127.0.0.1:8000'
const API_BASE = `${API_ORIGIN}/api`
const POLL_INTERVAL_MS = 3000
const JOB_TIMEOUT_MS = 30 * 60 * 1000

const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
}

function fail(message) {
  throw new Error(message)
}

function parseSceneKeys(args = []) {
  const option = args.find((arg) => arg.startsWith('--scenes='))
  if (!option) return EPISODE_ONE_VALIDATION_SCENES.map((scene) => scene.key)

  const requested = option
    .split('=')
    .slice(1)
    .join('=')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const allowed = new Set(EPISODE_ONE_VALIDATION_SCENES.map((scene) => scene.key))
  const unknown = requested.filter((key) => !allowed.has(key))
  if (unknown.length) fail(`未知验证场景：${unknown.join(', ')}`)
  return [...new Set(requested)]
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
  if (!rows[0]?.token) fail('项目 12 没有可用登录会话')
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
    fail(`${options.method || 'GET'} ${pathname} failed: ${body?.message || response.status}`)
  }
  return body.data
}

function sceneDraft(currentDraft, storyboardIds) {
  const selected = new Set(storyboardIds.map(Number))
  const currentClips = Array.isArray(currentDraft?.videoClips)
    ? currentDraft.videoClips
    : []
  const videoClips = currentClips.map((clip, index) => ({
    ...clip,
    enabled: selected.has(Number(clip.storyboardId)),
    order: selected.has(Number(clip.storyboardId))
      ? storyboardIds.indexOf(Number(clip.storyboardId)) + 1
      : index + 1,
  }))
  const subtitleCues = (Array.isArray(currentDraft?.subtitleCues)
    ? currentDraft.subtitleCues
    : []
  ).filter((cue) => selected.has(Number(cue.storyboardId)))

  return {
    videoClips,
    audioMix: currentDraft?.audioMix,
    subtitleCues,
  }
}

async function runControlledExport(exportId) {
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
          EXPORT_WORKER_ONLY_EXPORT_ID: String(exportId),
          EXPORT_WORKER_CONCURRENCY: '1',
          EXPORT_WORKER_MAX_JOBS: '1',
        },
        stdio: 'inherit',
        windowsHide: true,
      },
    )
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`export worker for #${exportId} exited with code ${code}`))
    })
  })
}

async function waitForExport(token, exportId) {
  const deadline = Date.now() + JOB_TIMEOUT_MS
  while (Date.now() < deadline) {
    const record = await apiRequest(token, `/exports/${exportId}`)
    if (record.status === 'completed') return record
    if (record.status === 'failed' || record.status === 'canceled') {
      fail(`export #${exportId} ${record.status}`)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  fail(`export #${exportId} polling timed out`)
}

async function main() {
  const args = process.argv.slice(2)
  const validation = validateEpisodeOneValidationScenes()
  if (!validation.valid) fail(validation.errors.join('；'))

  const selectedKeys = parseSceneKeys(args)
  const selectedScenes = validation.scenes.filter((scene) => selectedKeys.includes(scene.key))
  if (!selectedScenes.length) fail('至少选择一个验证场景')

  if (args.includes('--dry-run')) {
    console.log(JSON.stringify({
      projectId: PROJECT_ID,
      scenes: selectedScenes.map((scene) => ({
        key: scene.key,
        title: scene.title,
        storyboardIds: scene.storyboardIds,
        durationSeconds: scene.durationSeconds,
        qualityFocus: scene.qualityFocus,
      })),
      willCallModel: false,
      willCreateExports: false,
    }, null, 2))
    return
  }

  const db = await dbConnection()
  const token = await getAuthToken(db)
  const [runningExports] = await db.execute(
    `SELECT id, status
     FROM export_records
     WHERE project_id = ? AND status IN ('queued', 'running')
     ORDER BY id DESC`,
    [PROJECT_ID],
  )
  if (runningExports.length) {
    fail(`项目 12 已有运行中的导出：${runningExports.map((row) => `#${row.id}`).join(', ')}`)
  }

  const current = await apiRequest(token, `/projects/${PROJECT_ID}/final-edit`)
  const originalDraft = current.draft
  const results = []

  try {
    for (const scene of selectedScenes) {
      const draft = sceneDraft(originalDraft, scene.storyboardIds)
      await apiRequest(token, `/projects/${PROJECT_ID}/final-edit-draft`, {
        method: 'PUT',
        body: JSON.stringify(draft),
      })

      const exportRecord = await apiRequest(token, `/projects/${PROJECT_ID}/exports`, {
        method: 'POST',
        body: JSON.stringify({
          format: 'mp4',
          resolution: '1080x1920',
          frameRate: 24,
          burnSubtitle: true,
          strictStoryboardAudio: true,
        }),
      })

      // 普通导出 Worker 会读取当前项目草稿，必须等渲染和质检完成后再恢复原时间线。
      await runControlledExport(Number(exportRecord.id))
      const completed = await waitForExport(token, Number(exportRecord.id))
      const qualityReport = await apiRequest(
        token,
        `/exports/${exportRecord.id}/quality-report`,
        { method: 'POST', body: JSON.stringify({}) },
      )
      await apiRequest(token, `/projects/${PROJECT_ID}/final-edit-draft`, {
        method: 'PUT',
        body: JSON.stringify(originalDraft),
      })
      results.push({
        key: scene.key,
        title: scene.title,
        exportId: Number(exportRecord.id),
        durationSeconds: completed.durationSeconds,
        qualityReportId: qualityReport?.id || null,
        playbackUrl: completed.playbackUrl || completed.videoUrl || null,
      })
      console.log(JSON.stringify(results.at(-1)))
    }
  } finally {
    await apiRequest(token, `/projects/${PROJECT_ID}/final-edit-draft`, {
      method: 'PUT',
      body: JSON.stringify(originalDraft),
    }).catch(() => {})
    await db.end()
  }

  console.log(JSON.stringify({
    projectId: PROJECT_ID,
    results,
    note: '验证样片只完成技术导出；必须人工完整播放并记录连续表演、声音、口型和情绪结论。',
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
