import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'

import {
  buildControlledRecoveryReworkRequest,
  planControlledRecoveryRework,
  CONTROLLED_RECOVERY_REWORK_CONFIRMATION,
} from '../server/services/controlled-recovery-rework.mjs'
import { createObjectStorageFromEnv } from '../server/services/object-storage.mjs'

const REPORT_DIR = path.join(process.cwd(), '.codex-runtime', 'recovery-worker-rework-reports')

function parseVideoId() {
  const option = process.argv.find((item) => item.startsWith('--video-id='))
  const value = Number(option?.split('=', 2)[1])
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('usage: --video-id=<positive integer>')
  }
  return value
}

function parseConfirmation() {
  const option = process.argv.find((item) => item.startsWith('--confirm='))
  return String(option?.split('=', 2)[1] || '').trim()
}

function parseRequest(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function dbConfig() {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 2,
  }
}

async function loadSource(db, videoId) {
  const [rows] = await db.execute(
    `SELECT sc.project_id, va.id, va.storyboard_id, va.image_asset_id,
            va.version_no, va.status, va.recovery_review_decision,
            va.recovery_review_note,
            gj.id AS source_job_id, gj.status AS source_job_status,
            gj.job_type AS source_job_type, gj.job_key AS source_job_key,
            gj.request_json AS source_request_json
     FROM video_assets va
     INNER JOIN generation_jobs gj ON gj.id = va.generation_job_id
     INNER JOIN storyboards sb ON sb.id = va.storyboard_id
     INNER JOIN script_scenes sc ON sc.id = sb.scene_id
     WHERE va.id = ?
     LIMIT 1`,
    [videoId],
  )
  const video = rows[0]
  if (!video) throw new Error('recovery video not found')

  const [existingJobs] = await db.execute(
    `SELECT id, status, job_key
     FROM generation_jobs
     WHERE job_key LIKE ?
     ORDER BY id ASC`,
    [`recover-video-controlled-rework-video-${videoId}-%`],
  )
  const [versionRows] = await db.execute(
    `SELECT COALESCE(MAX(version_no), 0) AS max_version
     FROM video_assets
     WHERE storyboard_id = ?`,
    [video.storyboard_id],
  )

  return {
    video,
    sourceJob: {
      id: Number(video.source_job_id),
      status: video.source_job_status,
      job_type: video.source_job_type,
      job_key: video.source_job_key,
      request_json: video.source_request_json,
    },
    existingJobs,
    nextVersionNo: Number(versionRows[0]?.max_version || 0) + 1,
  }
}

async function writeReport(report) {
  await mkdir(REPORT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 17)
  const reportPath = path.join(
    REPORT_DIR,
    `controlled-recovery-rework-${report.sourceVideoId}-${stamp}-${process.pid}.json`,
  )
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return reportPath
}

function buildPrompt(sourceRequest, reviewNote) {
  const base = String(sourceRequest.promptSnapshot || '').trim()
  const requirement =
    '重新生成单条候选：严格保持起始帧中的人物脸部、发型、服装、工牌、手套、体型和场景光线一致；只优化表情、呼吸和轻微观察动作，不新增人物，不切镜头，不改变主体数量。'
  const reason = String(reviewNote || '').trim()
  return [base, requirement, reason ? `返工记录：${reason}` : ''].filter(Boolean).join(' ')
}

async function applyRework({ db, source, plan, storage }) {
  const sourceRequest = parseRequest(source.sourceJob.request_json)
  const imageStorageKey = String(sourceRequest.imageStorageKey || '').trim()
  const request = buildControlledRecoveryReworkRequest({
    sourceRequest: {
      ...sourceRequest,
      projectId: Number(source.video.project_id),
      storyboardId: Number(source.video.storyboard_id),
      imageAssetId: Number(source.video.image_asset_id),
      imageStorageKey,
      promptSnapshot: buildPrompt(sourceRequest, source.video.recovery_review_note),
    },
    sourceVideoId: source.video.id,
    sourceJobId: source.sourceJob.id,
    sourceJobKey: source.sourceJob.job_key,
    reviewNote: source.video.recovery_review_note,
    versionNo: source.nextVersionNo,
  })
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    const current = await loadSource(connection, source.video.id)
    const currentPlan = planControlledRecoveryRework({
      video: current.video,
      sourceJob: current.sourceJob,
      existingJobs: current.existingJobs,
      sourceImageReadable: true,
      confirmed: true,
    })
    if (currentPlan.action !== 'queue' || currentPlan.jobKey !== plan.jobKey) {
      await connection.rollback()
      return { applied: false, reason: 'source-changed-before-apply' }
    }
    const [result] = await connection.execute(
      `INSERT INTO generation_jobs
        (job_key, project_id, job_type, source_id, status, progress_percent,
         max_attempts, request_json, next_run_at)
       VALUES (?, ?, 'video_image', ?, 'queued', 0, 1, ?, UTC_TIMESTAMP())`,
      [
        plan.jobKey,
        source.video.project_id,
        source.video.storyboard_id,
        JSON.stringify(request),
      ],
    )
    await connection.commit()
    return {
      applied: true,
      jobId: Number(result.insertId),
      jobKey: plan.jobKey,
      imageStorageKey,
      nextVersionNo: source.nextVersionNo,
      storageProvider: storage.provider,
    }
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

async function main() {
  const sourceVideoId = parseVideoId()
  const apply = process.argv.includes('--apply')
  const confirmation = parseConfirmation()
  if (apply && confirmation !== CONTROLLED_RECOVERY_REWORK_CONFIRMATION) {
    throw new Error(
      `--apply requires --confirm=${CONTROLLED_RECOVERY_REWORK_CONFIRMATION}`,
    )
  }

  const db = mysql.createPool(dbConfig())
  const storage = createObjectStorageFromEnv(process.env)
  if (storage.provider !== 'cos') {
    throw new Error('controlled recovery rework requires OBJECT_STORAGE_PROVIDER=cos')
  }

  try {
    const source = await loadSource(db, sourceVideoId)
    const sourceRequest = parseRequest(source.sourceJob.request_json)
    const imageStorageKey = String(sourceRequest.imageStorageKey || '').trim()
    let sourceImageReadable = false
    let sourceImage = null
    if (imageStorageKey) {
      try {
        sourceImage = await storage.headObject(imageStorageKey)
        sourceImageReadable = Boolean(
          sourceImage &&
            Number(sourceImage.size) > 0 &&
            String(sourceImage.contentType || '').startsWith('image/'),
        )
      } catch {
        sourceImageReadable = false
      }
    }

    const plan = planControlledRecoveryRework({
      video: source.video,
      sourceJob: source.sourceJob,
      existingJobs: source.existingJobs,
      sourceImageReadable,
      confirmed: true,
    })
    const report = {
      mode: apply ? 'apply' : 'dry-run',
      sourceVideoId,
      projectId: Number(source.video.project_id),
      storyboardId: Number(source.video.storyboard_id),
      sourceJob: {
        id: source.sourceJob.id,
        status: source.sourceJob.status,
        jobKey: source.sourceJob.job_key,
      },
      sourceCandidate: {
        status: source.video.status,
        reviewDecision: source.video.recovery_review_decision,
        reviewNote: source.video.recovery_review_note || null,
        currentVersionNo: Number(source.video.version_no || 0),
        nextVersionNo: source.nextVersionNo,
      },
      sourceImage: {
        storageKey: imageStorageKey || null,
        readable: sourceImageReadable,
        size: Number(sourceImage?.size || 0),
        contentType: sourceImage?.contentType || null,
      },
      existingJobs: source.existingJobs.map((job) => ({
        id: Number(job.id),
        status: job.status,
        jobKey: job.job_key,
      })),
      plan,
      execution: {
        modelCalled: false,
        jobId: null,
        jobKey: null,
      },
      note: apply
        ? '只创建一条 queued 返工候选任务；尚未启动 Worker 或调用模型。'
        : '只读预检；未创建任务、未启动 Worker、未调用模型。',
    }

    if (apply && plan.action === 'queue') {
      report.execution = {
        ...report.execution,
        ...(await applyRework({ db, source, plan, storage })),
      }
    }
    report.reportPath = await writeReport(report)
    console.log(JSON.stringify(report, null, 2))
    if (apply && report.execution.applied !== true) process.exitCode = 2
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(String(error?.message || error))
  process.exitCode = 1
})
