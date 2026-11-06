import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import mysql from 'mysql2/promise'

import {
  buildControlledRecoveryWorkerEnv,
  buildRecoveryQueueSnapshot,
  evaluateControlledRecoveryBoundary,
  isQueuedRecoveryVideoJob,
  parseControlledRecoveryWorkerArgs,
} from '../server/services/controlled-recovery-worker.mjs'
import { createObjectStorageFromEnv } from '../server/services/object-storage.mjs'
import { getVideoConfig, isMockVideoProvider } from '../server/services/video.mjs'

const REPORT_DIR = path.join(process.cwd(), '.codex-runtime', 'recovery-worker-validation-reports')

function safeJsonParse(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function sanitizeError(error) {
  let message = String(error?.message || error || 'controlled recovery worker failed')
  for (const key of [
    'COS_SECRET_ID',
    'COS_SECRET_KEY',
    'VIDEO_API_KEY',
    'AGNES_API_KEY',
    'BIGMODEL_API_KEY',
    'ZHIPU_API_KEY',
    'VIDEO_IMAGE_UPLOAD_API_KEY',
  ]) {
    const secret = String(process.env[key] || '').trim()
    if (secret) message = message.replaceAll(secret, '[REDACTED]')
  }
  return message.replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]').slice(0, 1200)
}

function runWorker(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(process.cwd(), 'scripts', 'run-worker.mjs')],
      { cwd: process.cwd(), env, stdio: 'inherit', windowsHide: true },
    )
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}

async function writeReport(report) {
  await mkdir(REPORT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 17)
  const reportPath = path.join(
    REPORT_DIR,
    `recovery-worker-${report.jobId}-${stamp}-${process.pid}.json`,
  )
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return reportPath
}

async function main() {
  const { jobId, dryRun } = parseControlledRecoveryWorkerArgs(process.argv.slice(2))
  const storage = createObjectStorageFromEnv(process.env)
  const videoConfig = getVideoConfig()
  if (storage.provider !== 'cos') {
    throw new Error('controlled recovery worker requires OBJECT_STORAGE_PROVIDER=cos')
  }
  if (isMockVideoProvider(videoConfig) || !videoConfig.apiKey) {
    throw new Error('controlled recovery worker requires a configured non-mock video provider')
  }
  if (videoConfig.fallbackToMock) {
    throw new Error('controlled recovery worker requires VIDEO_FALLBACK_TO_MOCK=false')
  }

  const db = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 2,
  })

  try {
    const [rows] = await db.execute(
      `SELECT id, project_id, source_id, status, job_type, job_key, attempt_count, max_attempts, request_json
       FROM generation_jobs
       WHERE id = ?
       LIMIT 1`,
      [jobId],
    )
    const job = rows[0]
    if (!isQueuedRecoveryVideoJob(job)) {
      throw new Error('target job must be a queued recover-video video_image task')
    }
    const [queueRowsBefore] = await db.execute(
      `SELECT id, status, job_key
       FROM generation_jobs
       WHERE project_id = ? AND job_key LIKE 'recover-video-%'
       ORDER BY id ASC`,
      [job.project_id],
    )
    const queueSnapshotBefore = buildRecoveryQueueSnapshot(queueRowsBefore, jobId)
    let queueBoundary = evaluateControlledRecoveryBoundary(
      queueRowsBefore,
      queueRowsBefore,
      jobId,
    )

    const request = safeJsonParse(job.request_json)
    const imageStorageKey = String(request.imageStorageKey || '').trim()
    if (!imageStorageKey) {
      throw new Error('target recovery job has no imageStorageKey')
    }
    const sourceImage = await storage.headObject(imageStorageKey)
    if (!sourceImage || sourceImage.size <= 0 || !String(sourceImage.contentType).startsWith('image/')) {
      throw new Error('target recovery source image is not readable from COS')
    }
    const signedSourceUrl = storage.createSignedUrl({ key: imageStorageKey })

    const startedAt = new Date().toISOString()
    if (dryRun) {
      const report = {
        jobId,
        projectId: Number(job.project_id),
        storyboardId: Number(job.source_id),
        mode: 'dry-run',
        startedAt,
        finishedAt: new Date().toISOString(),
        controls: {
          workerConcurrency: 1,
          workerMaxJobs: 1,
          workerOnlyJobId: jobId,
          modelExecution: false,
        },
        sourceImage: {
          readable: true,
          contentType: sourceImage.contentType,
          size: sourceImage.size,
          signedUrlGenerated: Boolean(signedSourceUrl),
        },
        provider: {
          name: videoConfig.provider,
          model: videoConfig.defaultModel,
          fallbackToMock: videoConfig.fallbackToMock,
        },
        job: {
          status: job.status,
          attemptCount: Number(job.attempt_count || 0),
          maxAttempts: Number(job.max_attempts || 0),
          jobType: job.job_type,
          jobKey: job.job_key,
        },
        queueSnapshot: queueSnapshotBefore,
        queueSnapshotBefore,
        queueSnapshotAfter: queueSnapshotBefore,
        queueBoundary,
        worker: null,
        note: '预检完成；未启动 Worker、未调用模型、未修改任务状态。',
      }
      report.reportPath = await writeReport(report)
      console.log(JSON.stringify(report, null, 2))
      return
    }

    const workerResult = await runWorker(buildControlledRecoveryWorkerEnv(process.env, jobId))
    const [finalRows] = await db.execute(
      `SELECT id, status, progress_percent, attempt_count, max_attempts, last_error_code
       FROM generation_jobs
       WHERE id = ?
       LIMIT 1`,
      [jobId],
    )
    const [assetRows] = await db.execute(
      `SELECT id, status, storage_key, recovery_inspection_json
       FROM video_assets
       WHERE generation_job_id = ?
       ORDER BY id ASC`,
      [jobId],
    )
    const [queueRowsAfter] = await db.execute(
      `SELECT id, status, job_key
       FROM generation_jobs
       WHERE project_id = ? AND job_key LIKE 'recover-video-%'
       ORDER BY id ASC`,
      [job.project_id],
    )
    const queueSnapshotAfter = buildRecoveryQueueSnapshot(queueRowsAfter, jobId)
    queueBoundary = evaluateControlledRecoveryBoundary(
      queueRowsBefore,
      queueRowsAfter,
      jobId,
    )
    const finalJob = finalRows[0] || {}
    const report = {
      jobId,
      projectId: Number(job.project_id),
      storyboardId: Number(job.source_id),
      startedAt,
      finishedAt: new Date().toISOString(),
      controls: {
        workerConcurrency: 1,
        workerMaxJobs: 1,
        workerOnlyJobId: jobId,
      },
      sourceImage: {
        readable: true,
        contentType: sourceImage.contentType,
        size: sourceImage.size,
      },
      provider: {
        name: videoConfig.provider,
        model: videoConfig.defaultModel,
        fallbackToMock: videoConfig.fallbackToMock,
      },
      worker: workerResult,
      job: {
        status: finalJob.status || null,
        progressPercent: Number(finalJob.progress_percent || 0),
        attemptCount: Number(finalJob.attempt_count || 0),
        maxAttempts: Number(finalJob.max_attempts || 0),
        lastErrorCode: finalJob.last_error_code || null,
      },
      queueSnapshot: queueSnapshotAfter,
      queueSnapshotBefore,
      queueSnapshotAfter,
      queueBoundary,
      videoAssets: assetRows.map((asset) => ({
        id: Number(asset.id),
        status: asset.status,
        stored: Boolean(asset.storage_key),
        inspected: Boolean(asset.recovery_inspection_json),
      })),
    }
    report.reportPath = await writeReport(report)
    console.log(JSON.stringify(report, null, 2))
    if (workerResult.code !== 0) process.exitCode = workerResult.code || 1
    if (!queueBoundary.boundarySafe && !process.exitCode) process.exitCode = 2
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(sanitizeError(error))
  process.exitCode = 1
})
