// FastAPI-Only 迁移第六阶段：临时视频迁移的本地媒体基地址由 Node API 端口切换为 FastAPI（API_PORT，默认 8000）。
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'

const TEMPORARY_VIDEO_HOST = 'maas-watermark-prod-new.cn-wlcb.ufileos.com'
const GENERATED_VIDEO_DIR = path.join(process.cwd(), '.codex-runtime', 'generated-videos')
const MIGRATION_REPORT_DIR = path.join(process.cwd(), '.codex-runtime', 'migration-reports')
const DEFAULT_PROJECT_IDS = [12, 13]

function parseProjectIds() {
  const option = process.argv.find((item) => item.startsWith('--projects='))
  const values = String(option?.split('=', 2)[1] || '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0)
  return [...new Set(values.length ? values : DEFAULT_PROJECT_IDS)]
}

function isTemporaryProviderUrl(value) {
  try {
    return new URL(String(value || '')).hostname === TEMPORARY_VIDEO_HOST
  } catch {
    return false
  }
}

function isExpiredProviderUrl(value) {
  try {
    const expiresAt = Number(new URL(String(value || '')).searchParams.get('Expires')) * 1000
    return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now()
  } catch {
    return false
  }
}

function localVideoUrl(fileName) {
  const baseUrl = String(
    process.env.MIGRATION_VIDEO_PUBLIC_BASE_URL ||
      `http://127.0.0.1:${Number(process.env.API_PORT) || 8000}/generated/video`,
  ).replace(/\/$/, '')
  return `${baseUrl}/${fileName}`
}

async function writeMigrationReport(report) {
  await mkdir(MIGRATION_REPORT_DIR, { recursive: true })
  const projectLabel = report.projectIds.join('-')
  const reportPath = path.join(MIGRATION_REPORT_DIR, `temporary-videos-projects-${projectLabel}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return reportPath
}

async function isPlayableMp4(filePath) {
  try {
    const fileStat = await stat(filePath)
    if (fileStat.size < 1024) return false
    const head = await readFile(filePath, { encoding: null })
    return head.subarray(0, 32).includes(Buffer.from('ftyp'))
  } catch {
    return false
  }
}

async function downloadVideo(sourceUrl, outputPath) {
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(180000) })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  const contentType = String(response.headers.get('content-type') || '').toLowerCase()
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length < 1024 || !bytes.subarray(0, 32).includes(Buffer.from('ftyp'))) {
    throw new Error(contentType.includes('json') ? 'provider link expired' : 'invalid MP4 response')
  }
  await writeFile(outputPath, bytes)
}

async function replaceAssetUrl(db, asset, videoUrl) {
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [result] = await conn.execute(
      `UPDATE video_assets SET video_url = ? WHERE id = ? AND video_url = ?`,
      [videoUrl, asset.id, asset.video_url],
    )
    if (Number(result.affectedRows || 0) !== 1) {
      throw new Error('asset changed during migration')
    }
    await conn.execute(
      `UPDATE storyboards SET video_url = ?, updated_at = NOW()
       WHERE id = ? AND video_url = ?`,
      [videoUrl, asset.storyboard_id, asset.video_url],
    )
    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

async function confirmLocalReplacement(db, item) {
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    await conn.execute(
      `UPDATE video_assets
       SET status = CASE WHEN status = 'confirmed' THEN 'archived' ELSE status END,
           confirmed_at = NULL
       WHERE storyboard_id = ? AND id <> ?`,
      [item.storyboard_id, item.local_id],
    )
    await conn.execute(
      `UPDATE video_assets SET status = 'confirmed', confirmed_at = NOW() WHERE id = ?`,
      [item.local_id],
    )
    await conn.execute(
      `UPDATE storyboards SET video_url = ?, updated_at = NOW() WHERE id = ?`,
      [item.local_url, item.storyboard_id],
    )
    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
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
    const [assets] = await db.execute(
      `SELECT va.id, va.storyboard_id, va.version_no, va.video_url, va.status,
              s.shot_no, sc.scene_no, sc.project_id
       FROM video_assets va
       INNER JOIN storyboards s ON s.id = va.storyboard_id
       INNER JOIN script_scenes sc ON sc.id = s.scene_id
       WHERE sc.project_id IN (${placeholders})
         AND va.status = 'confirmed'
       ORDER BY sc.project_id ASC, sc.scene_no ASC, s.sort_order ASC, va.id ASC`,
      projectIds,
    )
    const temporaryAssets = assets.filter((item) => isTemporaryProviderUrl(item.video_url))
    const report = {
      mode: apply ? 'apply' : 'dry-run',
      projectIds,
      confirmedTemporaryAssets: temporaryAssets.length,
      downloaded: [],
      reusedLocalFiles: [],
      switchedToExistingLocal: [],
      unresolved: [],
    }

    if (!apply) {
      console.log(JSON.stringify(report, null, 2))
      return
    }

    await mkdir(GENERATED_VIDEO_DIR, { recursive: true })
    for (const asset of temporaryAssets) {
      const fileName = `legacy-video-${asset.id}-storyboard-${asset.storyboard_id}-v${asset.version_no}.mp4`
      const outputPath = path.join(GENERATED_VIDEO_DIR, fileName)
      const videoUrl = localVideoUrl(fileName)
      try {
        const reused = await isPlayableMp4(outputPath)
        if (!reused) {
          if (isExpiredProviderUrl(asset.video_url)) throw new Error('provider link expired')
          await downloadVideo(asset.video_url, outputPath)
        }
        await replaceAssetUrl(db, asset, videoUrl)
        const summary = {
          assetId: Number(asset.id),
          storyboardId: Number(asset.storyboard_id),
          projectId: Number(asset.project_id),
          videoUrl,
        }
        if (reused) report.reusedLocalFiles.push(summary)
        else report.downloaded.push(summary)
      } catch (error) {
        report.unresolved.push({
          assetId: Number(asset.id),
          storyboardId: Number(asset.storyboard_id),
          projectId: Number(asset.project_id),
          reason: error instanceof Error ? error.message : 'migration failed',
        })
      }
    }

    const [fallbackRows] = await db.execute(
      `SELECT old.id AS old_id, old.storyboard_id,
              local.id AS local_id, local.video_url AS local_url,
              sc.project_id, local.version_no
       FROM video_assets old
       INNER JOIN storyboards s ON s.id = old.storyboard_id
       INNER JOIN script_scenes sc ON sc.id = s.scene_id
       INNER JOIN video_assets local
         ON local.storyboard_id = old.storyboard_id
        AND local.video_url LIKE ?
       WHERE sc.project_id IN (${placeholders})
         AND old.status = 'confirmed'
         AND old.video_url LIKE ?
       ORDER BY old.storyboard_id ASC, local.version_no DESC, local.id DESC`,
      [`${localVideoUrl('')}%`, ...projectIds, `https://${TEMPORARY_VIDEO_HOST}%`],
    )
    const selectedFallbacks = new Map()
    for (const item of fallbackRows) {
      if (!selectedFallbacks.has(Number(item.storyboard_id))) {
        selectedFallbacks.set(Number(item.storyboard_id), item)
      }
    }
    for (const item of selectedFallbacks.values()) {
      const localPath = path.join(GENERATED_VIDEO_DIR, path.basename(new URL(item.local_url).pathname))
      if (!(await isPlayableMp4(localPath))) continue
      await confirmLocalReplacement(db, item)
      report.switchedToExistingLocal.push({
        storyboardId: Number(item.storyboard_id),
        projectId: Number(item.project_id),
        videoAssetId: Number(item.local_id),
        videoUrl: item.local_url,
      })
    }

    const [remaining] = await db.execute(
      `SELECT va.id, va.storyboard_id, sc.project_id
       FROM video_assets va
       INNER JOIN storyboards s ON s.id = va.storyboard_id
       INNER JOIN script_scenes sc ON sc.id = s.scene_id
       WHERE sc.project_id IN (${placeholders})
         AND va.status = 'confirmed'
         AND va.video_url LIKE ?
       ORDER BY sc.project_id ASC, va.storyboard_id ASC`,
      [...projectIds, `https://${TEMPORARY_VIDEO_HOST}%`],
    )
    report.unresolved = remaining.map((item) => {
      const previous = report.unresolved.find((entry) => entry.assetId === Number(item.id))
      return previous || {
        assetId: Number(item.id),
        storyboardId: Number(item.storyboard_id),
        projectId: Number(item.project_id),
        reason: 'no downloadable or local replacement',
      }
    })
    report.reportPath = await writeMigrationReport(report)
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await db.end()
  }
}

await main()
