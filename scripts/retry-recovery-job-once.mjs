import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'

import {
  auditRecoverySourceInput,
  classifyRecoveryWorkerFailure,
} from '../server/services/recovery-worker-failure-triage.mjs'
import {
  buildControlledRecoveryRetryRequest,
  CONTROLLED_RECOVERY_RETRY_CONFIRMATION,
  planControlledRecoveryRetry,
} from '../server/services/controlled-recovery-retry.mjs'
import { createObjectStorageFromEnv } from '../server/services/object-storage.mjs'

const REPORT_DIR = path.join(
  process.cwd(),
  '.codex-runtime',
  'recovery-worker-retry-reports',
)

function parseJobId() {
  const option = process.argv.find((item) => item.startsWith('--job-id='))
  const value = Number(option?.split('=', 2)[1])
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('usage: --job-id=<positive integer>')
  }
  return value
}

function parseConfirmation() {
  const option = process.argv.find((item) => item.startsWith('--confirm='))
  return String(option?.split('=', 2)[1] || '').trim()
}

function parseRequest(value) {
  try {
    const request = JSON.parse(String(value || '{}'))
    return request && typeof request === 'object' ? request : {}
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

async function writeReport(report) {
  await mkdir(REPORT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 17)
  const reportPath = path.join(
    REPORT_DIR,
    `controlled-recovery-retry-${report.originalJobId}-${stamp}-${process.pid}.json`,
  )
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return reportPath
}

async function loadJob(db, jobId) {
  const [rows] = await db.execute(
    `SELECT id, project_id, source_id, status, job_type, job_key,
            attempt_count, max_attempts, last_error_code, error_text, request_json
     FROM generation_jobs
     WHERE id = ?
     LIMIT 1`,
    [jobId],
  )
  return rows[0] || null
}

async function loadExistingRetries(db, jobId) {
  const [rows] = await db.execute(
    `SELECT id, status, job_key
     FROM generation_jobs
     WHERE job_key LIKE ?
     ORDER BY id ASC`,
    [`recover-video-controlled-retry-original-${jobId}-%`],
  )
  return rows
}

async function inspectRetry({ db, storage, jobId }) {
  const job = await loadJob(db, jobId)
  if (!job) throw new Error('source recovery job not found')

  const request = parseRequest(job.request_json)
  const imageStorageKey = String(request.imageStorageKey || '').trim()
  let sourceProbe = {
    readable: false,
    size: 0,
    contentType: null,
    reason: 'missing-image-storage-key',
  }
  let signedUrl = null

  if (imageStorageKey) {
    try {
      const object = await storage.headObject(imageStorageKey)
      sourceProbe = {
        readable: Boolean(
          object &&
            Number(object.size) > 0 &&
            String(object.contentType || '').startsWith('image/'),
        ),
        size: Number(object?.size || 0),
        contentType: object?.contentType || null,
        reason: null,
      }
      if (sourceProbe.readable) {
        signedUrl = storage.createSignedUrl({ key: imageStorageKey })
      }
    } catch (error) {
      sourceProbe.reason = String(error?.message || error).slice(0, 240)
    }
  }

  const inputAudit = auditRecoverySourceInput({
    imageStorageKey,
    sourceProbe,
    signedUrl,
  })
  sourceProbe.providerInputReady = inputAudit.providerInputReady

  const triage = classifyRecoveryWorkerFailure({
    status: job.status,
    attemptCount: job.attempt_count,
    maxAttempts: job.max_attempts,
    lastErrorCode: job.last_error_code,
    errorText: job.error_text,
    imageStorageKey,
    sourceProbe,
  })
  const existingRetries = await loadExistingRetries(db, jobId)

  return {
    job,
    request,
    imageStorageKey,
    sourceProbe,
    inputAudit,
    triage,
    existingRetries,
  }
}

async function applyRetry({ db, inspection, plan }) {
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    const currentJob = await loadJob(connection, inspection.job.id)
    if (
      !currentJob ||
      currentJob.status !== 'failed' ||
      currentJob.job_key !== inspection.job.job_key
    ) {
      await connection.rollback()
      return { applied: false, reason: 'source-job-changed-before-apply' }
    }

    const currentRetries = await loadExistingRetries(connection, inspection.job.id)
    if (
      currentRetries.some((retry) =>
        ['queued', 'running', 'success'].includes(
          String(retry.status || '').trim().toLowerCase(),
        ),
      )
    ) {
      await connection.rollback()
      return { applied: false, reason: 'controlled-retry-already-exists' }
    }

    const request = buildControlledRecoveryRetryRequest(inspection.request, {
      originalJobId: Number(inspection.job.id),
      originalJobKey: inspection.job.job_key,
    })
    const [result] = await connection.execute(
      `INSERT INTO generation_jobs
        (job_key, project_id, job_type, source_id, status, progress_percent,
         max_attempts, request_json, next_run_at)
       VALUES (?, ?, 'video_image', ?, 'queued', 0, 1, ?, UTC_TIMESTAMP())`,
      [
        plan.jobKey,
        plan.projectId,
        plan.storyboardId,
        JSON.stringify(request),
      ],
    )
    await connection.commit()
    return {
      applied: true,
      retryJobId: Number(result.insertId),
      retryJobKey: plan.jobKey,
    }
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

async function main() {
  const jobId = parseJobId()
  const apply = process.argv.includes('--apply')
  const confirmation = parseConfirmation()
  if (
    apply &&
    confirmation !== CONTROLLED_RECOVERY_RETRY_CONFIRMATION
  ) {
    throw new Error(
      `--apply requires --confirm=${CONTROLLED_RECOVERY_RETRY_CONFIRMATION}`,
    )
  }

  const storage = createObjectStorageFromEnv(process.env)
  if (storage.provider !== 'cos') {
    throw new Error('controlled recovery retry requires OBJECT_STORAGE_PROVIDER=cos')
  }
  const db = mysql.createPool(dbConfig())

  try {
    const inspection = await inspectRetry({
      db,
      storage,
      jobId,
    })
    const plan = planControlledRecoveryRetry({
      job: inspection.job,
      triage: inspection.triage,
      existingRetries: inspection.existingRetries,
      confirmed:
        !apply || confirmation === CONTROLLED_RECOVERY_RETRY_CONFIRMATION,
    })
    const report = {
      mode: apply ? 'apply' : 'dry-run',
      originalJobId: jobId,
      projectId: Number(inspection.job.project_id),
      storyboardId: Number(inspection.job.source_id),
      sourceJob: {
        status: inspection.job.status,
        jobKey: inspection.job.job_key,
        attemptCount: Number(inspection.job.attempt_count || 0),
        maxAttempts: Number(inspection.job.max_attempts || 0),
        lastErrorCode: inspection.job.last_error_code || null,
      },
      sourceImage: {
        storageKey: inspection.imageStorageKey || null,
        readable: inspection.sourceProbe.readable,
        size: inspection.sourceProbe.size,
        contentType: inspection.sourceProbe.contentType,
        reason: inspection.sourceProbe.reason,
      },
      providerInput: inspection.inputAudit,
      triage: inspection.triage,
      existingRetries: inspection.existingRetries.map((retry) => ({
        id: Number(retry.id),
        status: retry.status,
        jobKey: retry.job_key,
      })),
      plan,
      execution: {
        modelCalled: false,
        sourceJobMutated: false,
        retryJobId: null,
        retryJobKey: null,
      },
      note: apply
        ? '仅创建单条 queued 控制重试任务；尚未启动 Worker 或调用视频模型。'
        : '只读预检；未创建任务、未启动 Worker、未调用视频模型。',
    }

    if (apply && plan.action === 'queue') {
      const result = await applyRetry({ db, inspection, plan })
      report.execution = {
        ...report.execution,
        ...result,
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
