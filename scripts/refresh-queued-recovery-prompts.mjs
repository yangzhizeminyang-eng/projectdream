import mysql from 'mysql2/promise'

import {
  strengthenExpiredVideoRecoveryPrompt,
} from '../server/services/expired-video-recovery.mjs'

const DEFAULT_PROJECT_IDS = [12, 13]
const RECOVERY_JOB_PREFIX = 'recover-video-%'

function parseProjectIds() {
  const option = process.argv.find((item) => item.startsWith('--projects='))
  const values = String(option?.split('=', 2)[1] || '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0)
  return [...new Set(values.length ? values : DEFAULT_PROJECT_IDS)]
}

function parseRequest(requestJson) {
  try {
    const request = JSON.parse(String(requestJson || ''))
    return request && typeof request === 'object' ? request : null
  } catch {
    return null
  }
}

async function main() {
  const apply = process.argv.includes('--apply')
  const projectIds = parseProjectIds()
  const db = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 3,
  })

  try {
    const placeholders = projectIds.map(() => '?').join(', ')
    const [jobs] = await db.execute(
      `SELECT gj.id, gj.job_key, gj.request_json, gj.source_id AS storyboard_id
       FROM generation_jobs gj
       INNER JOIN storyboards s ON s.id = gj.source_id
       INNER JOIN script_scenes sc ON sc.id = s.scene_id
       WHERE sc.project_id IN (${placeholders})
         AND gj.job_type = 'video_image'
         AND gj.status = 'queued'
         AND gj.job_key LIKE ?
       ORDER BY gj.id ASC`,
      [...projectIds, RECOVERY_JOB_PREFIX],
    )

    const report = {
      mode: apply ? 'apply' : 'dry-run',
      projectIds,
      updated: [],
      unchanged: [],
      skipped: [],
    }

    for (const job of jobs) {
      const request = parseRequest(job.request_json)
      const imageAssetId = Number(request?.imageAssetId)
      if (!request || !Number.isSafeInteger(imageAssetId) || imageAssetId <= 0) {
        report.skipped.push({ jobId: Number(job.id), reason: 'invalid-request-snapshot' })
        continue
      }

      const [imageRows] = await db.execute(
        `SELECT character_snapshot
         FROM image_assets
         WHERE id = ? AND storyboard_id = ?`,
        [imageAssetId, job.storyboard_id],
      )
      const startImage = imageRows[0]
      if (!startImage) {
        report.skipped.push({ jobId: Number(job.id), reason: 'start-image-not-found' })
        continue
      }

      const promptSnapshot = strengthenExpiredVideoRecoveryPrompt({
        promptSnapshot: request.promptSnapshot,
        characterSnapshot: startImage.character_snapshot,
      })
      const item = {
        jobId: Number(job.id),
        storyboardId: Number(job.storyboard_id),
        imageAssetId,
      }
      if (promptSnapshot === String(request.promptSnapshot || '').trim()) {
        report.unchanged.push(item)
        continue
      }

      if (apply) {
        request.promptSnapshot = promptSnapshot
        await db.execute(
          `UPDATE generation_jobs
           SET request_json = ?, updated_at = NOW()
           WHERE id = ? AND status = 'queued' AND job_key LIKE ?`,
          [JSON.stringify(request), job.id, RECOVERY_JOB_PREFIX],
        )
      }
      report.updated.push(item)
    }

    console.log(JSON.stringify(report, null, 2))
  } finally {
    await db.end()
  }
}

await main()
