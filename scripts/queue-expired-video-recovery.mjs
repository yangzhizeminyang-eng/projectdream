import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'
import {
  buildExpiredVideoRecoveryPrompt,
  buildExpiredVideoRecoveryRequest,
  classifyExpiredVideoRecoverySource,
  decideExpiredVideoRecovery,
} from '../server/services/expired-video-recovery.mjs'
import { getVideoConfig } from '../server/services/video.mjs'

const TEMPORARY_VIDEO_PREFIX = 'https://maas-watermark-prod-new.cn-wlcb.ufileos.com%'
const DEFAULT_PROJECT_IDS = [12, 13]
const REPORT_DIR = path.join(process.cwd(), '.codex-runtime', 'migration-reports')
const RECOVERY_JOB_PREFIX = 'recover-video-%'

function parseProjectIds() {
  const option = process.argv.find((item) => item.startsWith('--projects='))
  const values = String(option?.split('=', 2)[1] || '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0)
  return [...new Set(values.length ? values : DEFAULT_PROJECT_IDS)]
}

function recoveryAttemptLimit() {
  const parsed = Number.parseInt(String(process.env.EXPIRED_VIDEO_RECOVERY_MAX_ATTEMPTS || ''), 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 3
}

function recoverySourceMode() {
  return process.argv.includes('--public-only') ? 'public-only' : 'all'
}

async function main() {
  const apply = process.argv.includes('--apply')
  const projectIds = parseProjectIds()
  const videoConfig = getVideoConfig()
  const maxRecoveryAttempts = recoveryAttemptLimit()
  const sourceMode = recoverySourceMode()
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
    const [expiredRows] = await db.execute(
      `SELECT va.id AS expired_asset_id, va.storyboard_id, va.motion_mode,
              va.duration_seconds AS asset_duration_seconds, s.*, sc.project_id
       FROM video_assets va
       INNER JOIN storyboards s ON s.id = va.storyboard_id
       INNER JOIN script_scenes sc ON sc.id = s.scene_id
       WHERE sc.project_id IN (${placeholders})
         AND va.status = 'confirmed'
         AND va.video_url LIKE ?
       ORDER BY sc.project_id ASC, sc.scene_no ASC, s.sort_order ASC, va.id ASC`,
      [...projectIds, TEMPORARY_VIDEO_PREFIX],
    )
    const report = {
      mode: apply ? 'apply' : 'dry-run',
      projectIds,
      maxRecoveryAttempts,
      sourceMode,
      queued: [],
      skipped: [],
    }

    for (const shot of expiredRows) {
      const [recoveryRows] = await db.execute(
        `SELECT id, status, job_key
         FROM generation_jobs
         WHERE project_id = ?
           AND job_type = 'video_image'
           AND source_id = ?
           AND job_key LIKE ?
         ORDER BY id ASC`,
        [shot.project_id, shot.storyboard_id, RECOVERY_JOB_PREFIX],
      )
      const [freshVideoRows] = await db.execute(
        `SELECT id FROM video_assets
         WHERE storyboard_id = ?
           AND status = 'confirmed'
           AND id <> ?
           AND (
             (storage_key IS NOT NULL AND storage_key <> '')
             OR video_url NOT LIKE ?
           )
         LIMIT 1`,
        [shot.storyboard_id, shot.expired_asset_id, TEMPORARY_VIDEO_PREFIX],
      )
      const recovery = decideExpiredVideoRecovery({
        projectId: Number(shot.project_id),
        storyboardId: Number(shot.storyboard_id),
        existingJobs: recoveryRows,
        hasFreshConfirmedVideo: Boolean(freshVideoRows[0]),
        maxRecoveryAttempts,
      })
      if (recovery.action !== 'queue') {
        report.skipped.push({
          storyboardId: Number(shot.storyboard_id),
          sourceAssetId: Number(shot.expired_asset_id),
          reason: recovery.reason,
        })
        continue
      }
      const [imageRows] = await db.execute(
        `SELECT ia.*
         FROM image_assets ia
         WHERE storyboard_id = ? AND status = 'confirmed'
         ORDER BY CASE frame_role WHEN 'start' THEN 0 WHEN 'primary' THEN 1 ELSE 2 END ASC,
           confirmed_at DESC, id DESC`,
        [shot.storyboard_id],
      )
      const startImage = imageRows.find((item) => item.frame_role !== 'end') || imageRows[0]
      const endImage = imageRows.find((item) => item.frame_role === 'end') || null
      if (!startImage) {
        report.skipped.push({ storyboardId: Number(shot.storyboard_id), reason: 'missing confirmed image' })
        continue
      }
      const source = classifyExpiredVideoRecoverySource({
        imageUrl: startImage.image_url,
        sourceMode,
      })
      if (source.action !== 'queue') {
        report.skipped.push({
          storyboardId: Number(shot.storyboard_id),
          sourceAssetId: Number(shot.expired_asset_id),
          imageAssetId: Number(startImage.id),
          sourceKind: source.sourceKind,
          reason: source.reason,
        })
        continue
      }
      const [versionRows] = await db.execute(
        `SELECT COALESCE(MAX(version_no), 0) AS maxVersion FROM video_assets WHERE storyboard_id = ?`,
        [shot.storyboard_id],
      )
      const request = buildExpiredVideoRecoveryRequest({
        projectId: Number(shot.project_id),
        storyboardId: Number(shot.storyboard_id),
        imageAssetId: Number(startImage.id),
        imageStorageKey: startImage.storage_key || null,
        imageUrl: startImage.image_url,
        versionNo: Number(versionRows[0]?.maxVersion || 0) + 1,
        motionMode: String(shot.motion_mode || 'PAN').trim() || 'PAN',
        durationSeconds: Math.max(1, Math.min(12, Number(shot.asset_duration_seconds) || 5)),
        modelName: videoConfig.defaultModel,
        promptSnapshot: buildExpiredVideoRecoveryPrompt({
          startVisualPrompt: shot.start_visual_prompt || shot.visual_prompt || shot.action_text,
          endVisualPrompt: endImage?.prompt_snapshot || shot.end_visual_prompt,
          characterSnapshot: startImage.character_snapshot,
        }),
      })
      const item = {
        projectId: Number(shot.project_id),
        storyboardId: Number(shot.storyboard_id),
        sourceAssetId: Number(shot.expired_asset_id),
        modelName: request.modelName,
        sourceKind: source.sourceKind,
        retryNumber: recovery.retryNumber,
        jobKey: recovery.jobKey,
      }
      if (!apply) {
        report.queued.push(item)
        continue
      }
      const [result] = await db.execute(
        `INSERT INTO generation_jobs
          (job_key, project_id, job_type, source_id, status, progress_percent, max_attempts, request_json)
         VALUES (?, ?, 'video_image', ?, 'queued', 0, ?, ?)`,
        [
          item.jobKey,
          item.projectId,
          request.storyboardId,
          maxRecoveryAttempts,
          JSON.stringify(request),
        ],
      )
      report.queued.push({ ...item, jobId: Number(result.insertId) })
    }

    if (apply) {
      await mkdir(REPORT_DIR, { recursive: true })
      report.reportPath = path.join(REPORT_DIR, `expired-video-recovery-projects-${projectIds.join('-')}.json`)
      await writeFile(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    }
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await db.end()
  }
}

await main()
