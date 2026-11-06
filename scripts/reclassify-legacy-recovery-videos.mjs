import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'
import { shouldRequireExpiredVideoRecoveryReview } from '../server/services/expired-video-recovery.mjs'

const REPORT_DIR = path.join(process.cwd(), '.codex-runtime', 'migration-reports')
const RECOVERY_JOB_PREFIX = 'recover-video-%'

function parseProjectIds() {
  const option = process.argv.find((item) => item.startsWith('--projects='))
  const values = String(option?.split('=', 2)[1] || '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0)
  return [...new Set(values)]
}

function parseRequest(value) {
  try {
    const request = JSON.parse(String(value || '{}'))
    return request && typeof request === 'object' ? request : {}
  } catch {
    return {}
  }
}

function reportFileName(projectIds, apply) {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 17)
  return `reclassify-recovery-videos-${projectIds.join('-') || 'all'}-${apply ? 'apply' : 'dry-run'}-${stamp}.json`
}

async function main() {
  const projectIds = parseProjectIds()
  const apply = process.argv.includes('--apply')
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
    const projectClause = projectIds.length
      ? `AND sc.project_id IN (${projectIds.map(() => '?').join(', ')})`
      : ''
    const [rows] = await db.execute(
      `SELECT va.id AS video_asset_id,
              va.storyboard_id,
              va.status AS video_status,
              va.video_url,
              gj.id AS generation_job_id,
              gj.job_key,
              gj.request_json,
              sc.project_id
       FROM video_assets va
       INNER JOIN generation_jobs gj ON gj.id = va.generation_job_id
       INNER JOIN storyboards s ON s.id = va.storyboard_id
       INNER JOIN script_scenes sc ON sc.id = s.scene_id
       WHERE gj.job_type = 'video_image'
         AND gj.job_key LIKE ?
         ${projectClause}
       ORDER BY sc.project_id ASC, va.storyboard_id ASC, va.id ASC`,
      [RECOVERY_JOB_PREFIX, ...projectIds],
    )

    const report = {
      mode: apply ? 'apply' : 'dry-run',
      projectIds: projectIds.length ? projectIds : 'all',
      candidates: [],
      skipped: [],
      changed: [],
    }

    for (const row of rows) {
      const request = parseRequest(row.request_json)
      const item = {
        projectId: Number(row.project_id),
        videoAssetId: Number(row.video_asset_id),
        storyboardId: Number(row.storyboard_id),
        generationJobId: Number(row.generation_job_id),
        jobKey: row.job_key,
        status: row.video_status,
      }
      if (
        !shouldRequireExpiredVideoRecoveryReview({
          jobKey: row.job_key,
          status: row.video_status,
          request,
        })
      ) {
        report.skipped.push(item)
        continue
      }

      report.candidates.push(item)
      if (!apply) continue

      const conn = await db.getConnection()
      try {
        await conn.beginTransaction()
        const [videoUpdate] = await conn.execute(
          `UPDATE video_assets
           SET status = 'candidate', confirmed_at = NULL
           WHERE id = ? AND status = 'confirmed'`,
          [row.video_asset_id],
        )
        const [storyboardUpdate] = await conn.execute(
          `UPDATE storyboards
           SET video_url = NULL, updated_at = NOW()
           WHERE id = ? AND video_url = ?`,
          [row.storyboard_id, row.video_url],
        )
        await conn.commit()
        report.changed.push({
          ...item,
          videoRowsChanged: Number(videoUpdate.affectedRows || 0),
          storyboardRowsChanged: Number(storyboardUpdate.affectedRows || 0),
        })
      } catch (error) {
        await conn.rollback()
        throw error
      } finally {
        conn.release()
      }
    }

    if (apply) {
      await mkdir(REPORT_DIR, { recursive: true })
      report.reportPath = path.join(REPORT_DIR, reportFileName(projectIds, apply))
      await writeFile(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    }
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await db.end()
  }
}

await main()
