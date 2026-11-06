import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'

import { createObjectStorageFromEnv } from '../server/services/object-storage.mjs'
import {
  auditRecoverySourceInput,
  buildRecoveryFailureTriageReport,
} from '../server/services/recovery-worker-failure-triage.mjs'

const REPORT_DIR = path.join(process.cwd(), '.codex-runtime', 'recovery-worker-failure-reports')

function readOption(name) {
  const prefix = `--${name}=`
  const option = process.argv.find((argument) => String(argument).startsWith(prefix))
  return option ? String(option).slice(prefix.length) : null
}

function parseProjectIds() {
  const raw = readOption('projects')
  if (!raw) throw new Error('--projects is required, for example --projects=12')
  const projectIds = [...new Set(
    raw
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  )]
  if (!projectIds.length) throw new Error('--projects must contain at least one positive project id')
  return projectIds.sort((left, right) => left - right)
}

function parseLimit() {
  const raw = readOption('limit')
  if (raw === null) return null
  const limit = Number(raw)
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('--limit must be a positive integer')
  }
  return limit
}

function safeJsonParse(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function sanitizeText(value) {
  return String(value || '')
    .replace(/sk-[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .slice(0, 1200)
}

async function probeSourceImage(storage, imageStorageKey) {
  const key = String(imageStorageKey || '').trim()
  if (!key) {
    return {
      readable: false,
      error: 'missing-image-storage-key',
    }
  }
  try {
    const object = await storage.headObject(key)
    if (!object || Number(object.size) <= 0 || !String(object.contentType || '').startsWith('image/')) {
      return {
        readable: false,
        error: 'object-metadata-invalid',
        contentType: object?.contentType || null,
        size: Number(object?.size || 0),
      }
    }
    const baseProbe = {
      readable: true,
      contentType: object.contentType,
      size: Number(object.size),
    }
    const signedUrl = storage.createSignedUrl({ key })
    return {
      ...baseProbe,
      ...auditRecoverySourceInput({
        imageStorageKey: key,
        sourceProbe: baseProbe,
        signedUrl,
      }),
    }
  } catch (error) {
    return {
      readable: false,
      error: sanitizeText(error),
    }
  }
}

async function writeReport(report) {
  await mkdir(REPORT_DIR, { recursive: true })
  const stamp = report.generatedAt.replace(/\D/g, '').slice(0, 17)
  const reportPath = path.join(
    REPORT_DIR,
    `recovery-worker-failures-${report.projectIds.join('-')}-${stamp}-${process.pid}.json`,
  )
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return reportPath
}

async function main() {
  const projectIds = parseProjectIds()
  const limit = parseLimit()
  const storage = createObjectStorageFromEnv(process.env)
  if (storage.provider !== 'cos') {
    throw new Error('failure triage requires OBJECT_STORAGE_PROVIDER=cos')
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
      `SELECT id, project_id, source_id, status, job_type, job_key,
              attempt_count, max_attempts, last_error_code, error_text, request_json
       FROM generation_jobs
       WHERE project_id IN (${projectIds.map(() => '?').join(', ')})
         AND status = 'failed'
         AND job_key LIKE 'recover-video-%'
       ORDER BY id ASC
       ${limit ? `LIMIT ${limit}` : ''}`,
      projectIds,
    )

    const items = []
    for (const row of rows) {
      const request = safeJsonParse(row.request_json)
      const imageStorageKey = String(request.imageStorageKey || '').trim() || null
      const sourceProbe = await probeSourceImage(storage, imageStorageKey)
      items.push({
        id: Number(row.id),
        projectId: Number(row.project_id),
        storyboardId: Number(row.source_id),
        status: row.status,
        jobType: row.job_type,
        jobKey: row.job_key,
        attemptCount: Number(row.attempt_count || 0),
        maxAttempts: Number(row.max_attempts || 0),
        lastErrorCode: row.last_error_code || null,
        errorText: sanitizeText(row.error_text),
        imageStorageKey,
        sourceProbe,
      })
    }

    const triage = buildRecoveryFailureTriageReport(items)
    const report = {
      mode: 'dry-run',
      generatedAt: new Date().toISOString(),
      projectIds,
      limit,
      noMutation: true,
      ...triage,
      note: '只读扫描失败恢复任务和 COS 起始图；未重新入队、未修改 generation_jobs、未启动 Worker、未调用模型。',
    }
    report.reportPath = await writeReport(report)
    console.log(JSON.stringify({
      mode: report.mode,
      projectIds,
      summary: report.summary,
      recommendedJobIds: report.recommendedJobIds,
      reportPath: report.reportPath,
    }, null, 2))
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(sanitizeText(error))
  process.exitCode = 1
})
