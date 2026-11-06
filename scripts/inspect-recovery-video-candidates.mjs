import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import mysql from 'mysql2/promise'

import { createObjectStorageFromEnv } from '../server/services/object-storage.mjs'
import { buildRecoveryVideoReviewFrameStorageKey } from '../server/services/media-storage-keys.mjs'
import { buildRecoveryVideoInspectionReport } from '../server/services/recovery-video-inspection.mjs'
import { summarizeRecoveryInspectionSelection } from '../server/services/recovery-video-inspection-selection.mjs'

const OUTPUT_DIR = path.join(process.cwd(), '.codex-runtime', 'recovery-inspection-backfill')
const REPORT_DIR = path.join(process.cwd(), '.codex-runtime', 'recovery-inspection-reports')
const FFMPEG_BIN = String(process.env.FFMPEG_BIN || 'ffmpeg').trim() || 'ffmpeg'
const FFPROBE_BIN = String(process.env.FFPROBE_BIN || 'ffprobe').trim() || 'ffprobe'

function readOption(name) {
  const prefix = `--${name}=`
  const option = process.argv.find((argument) => argument.startsWith(prefix))
  return option ? option.slice(prefix.length) : null
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

function parseCharacterFree(value) {
  try {
    return JSON.parse(String(value || '{}')).characterFree === true
  } catch {
    return false
  }
}

function parseCharacterSnapshot(value) {
  try {
    const snapshot = JSON.parse(String(value || '{}'))
    return snapshot && typeof snapshot === 'object' ? snapshot : null
  } catch {
    return null
  }
}

function runExternalCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(`${command} exited with ${code}: ${stderr.slice(-800)}`))
      }
    })
  })
}

async function inspectRenderedMedia(filePath) {
  const { stdout } = await runExternalCommand(FFPROBE_BIN, [
    '-v', 'error',
    '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,width,height,r_frame_rate',
    '-of', 'json',
    filePath,
  ])
  const payload = JSON.parse(stdout || '{}')
  const streams = Array.isArray(payload.streams) ? payload.streams : []
  const video = streams.find((stream) => stream.codec_type === 'video') || {}
  const audio = streams.find((stream) => stream.codec_type === 'audio') || {}
  const [frameRateNumerator, frameRateDenominator] = String(video.r_frame_rate || '')
    .split('/')
    .map((value) => Number(value))
  return {
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    frameRate:
      Number.isFinite(frameRateNumerator) &&
      Number.isFinite(frameRateDenominator) &&
      frameRateDenominator > 0
        ? frameRateNumerator / frameRateDenominator
        : 0,
    durationSeconds: Number(payload.format?.duration) || 0,
    videoCodec: String(video.codec_name || '').trim().toLowerCase(),
    audioCodec: String(audio.codec_name || '').trim().toLowerCase(),
    formatName: String(payload.format?.format_name || '').trim().toLowerCase(),
  }
}

function sampleSeconds(durationSeconds) {
  const duration = Math.max(0.1, Number(durationSeconds) || 0.1)
  const lastFrameSecond = Math.max(0, duration - 0.05)
  return [0.1, 0.5, 0.9].map((ratio) => Math.min(lastFrameSecond, Math.max(0, duration * ratio)))
}

function candidateNoFromStorageKey(storageKey, fallback) {
  const match = String(storageKey || '').match(/\/c(\d+)\.mp4$/i)
  const candidateNo = Number(match?.[1])
  return Number.isSafeInteger(candidateNo) && candidateNo > 0 ? candidateNo : Number(fallback)
}

function sanitizeError(error) {
  return String(error?.message || error || 'unknown inspection failure')
    .replace(/sk-[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .slice(0, 1200)
}

async function writeReport(report) {
  await mkdir(REPORT_DIR, { recursive: true })
  const stamp = report.generatedAt.replace(/\D/g, '').slice(0, 17)
  const reportPath = path.join(
    REPORT_DIR,
    `recovery-video-inspection-${report.projectIds.join('-')}-${report.mode}-${stamp}-${process.pid}.json`,
  )
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return reportPath
}

async function inspectCandidate({ row, storage, apply }) {
  const candidateNo = candidateNoFromStorageKey(row.storage_key, row.video_asset_id)
  const base = `project-${row.project_id}-video-${row.video_asset_id}`
  const videoPath = path.join(OUTPUT_DIR, `${base}.mp4`)
  const media = {}
  const plannedSampleFrames = []

  try {
    const object = await storage.getObject(row.storage_key)
    if (!object) throw new Error('COS 中找不到恢复候选视频对象')
    await writeFile(videoPath, object.bytes)
    const inspectedMedia = await inspectRenderedMedia(videoPath)
    Object.assign(media, inspectedMedia)
    const seconds = sampleSeconds(inspectedMedia.durationSeconds)
    for (const [index, second] of seconds.entries()) {
      const storageKey = buildRecoveryVideoReviewFrameStorageKey({
        projectId: Number(row.project_id),
        storyboardId: Number(row.storyboard_id),
        versionNo: Number(row.version_no),
        candidateNo,
        sampleNo: index + 1,
      })
      plannedSampleFrames.push({ second: Number(second.toFixed(3)), storageKey })
    }

    if (!apply) {
      return {
        videoAssetId: Number(row.video_asset_id),
        storyboardId: Number(row.storyboard_id),
        storageKey: row.storage_key,
        status: 'planned',
        media,
        sampleFrames: plannedSampleFrames,
      }
    }

    const sampleFrames = []
    for (const [index, sample] of plannedSampleFrames.entries()) {
      const framePath = path.join(OUTPUT_DIR, `${base}-sample-${index + 1}.jpg`)
      await runExternalCommand(FFMPEG_BIN, [
        '-y',
        '-ss',
        sample.second.toFixed(3),
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        framePath,
      ])
      await storage.putObject({
        key: sample.storageKey,
        bytes: await readFile(framePath),
        contentType: 'image/jpeg',
      })
      sampleFrames.push(sample)
    }

    const inspection = buildRecoveryVideoInspectionReport({
      media,
      expectedDurationSeconds: row.duration_seconds,
      characterFree: parseCharacterFree(row.character_snapshot),
      characterSnapshot: parseCharacterSnapshot(row.character_snapshot),
      sampleFrames,
    })
    return {
      videoAssetId: Number(row.video_asset_id),
      storyboardId: Number(row.storyboard_id),
      storageKey: row.storage_key,
      status: inspection.status,
      inspection,
    }
  } catch (error) {
    const inspection = buildRecoveryVideoInspectionReport({
      media,
      expectedDurationSeconds: row.duration_seconds,
      characterFree: parseCharacterFree(row.character_snapshot),
      characterSnapshot: parseCharacterSnapshot(row.character_snapshot),
      sampleFrames: plannedSampleFrames,
      inspectionError: sanitizeError(error),
    })
    return {
      videoAssetId: Number(row.video_asset_id),
      storyboardId: Number(row.storyboard_id),
      storageKey: row.storage_key,
      status: inspection.status,
      inspection,
    }
  }
}

async function main() {
  const apply = process.argv.includes('--apply')
  const projectIds = parseProjectIds()
  const limit = parseLimit()
  const storage = createObjectStorageFromEnv(process.env)
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
    await mkdir(OUTPUT_DIR, { recursive: true })
    const [candidateRows] = await db.execute(
      `SELECT va.id AS video_asset_id,
              va.storyboard_id,
              va.version_no,
              va.storage_key,
              va.duration_seconds,
              va.recovery_inspection_json,
              ia.character_snapshot,
              sc.project_id
       FROM video_assets va
       INNER JOIN generation_jobs gj ON gj.id = va.generation_job_id
       INNER JOIN image_assets ia ON ia.id = va.image_asset_id
       INNER JOIN storyboards s ON s.id = va.storyboard_id
       INNER JOIN script_scenes sc ON sc.id = s.scene_id
       WHERE gj.job_key LIKE 'recover-video-%'
       AND sc.project_id IN (${projectIds.map(() => '?').join(', ')})
       ORDER BY va.id ASC`,
      projectIds,
    )
    const selection = summarizeRecoveryInspectionSelection({
      rows: candidateRows,
      projectIds,
      limit,
    })
    const rows = selection.selectedRows

    const report = {
      mode: apply ? 'apply' : 'dry-run',
      generatedAt: new Date().toISOString(),
      projectIds,
      limit,
      selectedCount: rows.length,
      availableCandidateCount: candidateRows.length,
      eligibleCount: selection.eligibleCount,
      skippedCount: selection.skippedCount,
      skippedByReason: selection.skippedByReason,
      items: [],
      updated: [],
    }
    for (const row of rows) {
      const item = await inspectCandidate({ row, storage, apply })
      report.items.push(item)
      if (!apply || !item.inspection) continue
      const [result] = await db.execute(
        `UPDATE video_assets
         SET recovery_inspection_json = ?
         WHERE id = ? AND recovery_inspection_json IS NULL`,
        [JSON.stringify(item.inspection), item.videoAssetId],
      )
      report.updated.push({
        videoAssetId: item.videoAssetId,
        affectedRows: Number(result.affectedRows || 0),
        inspectionStatus: item.inspection.status,
      })
    }
    report.reportPath = await writeReport(report)
    console.log(JSON.stringify({
      mode: report.mode,
      projectIds,
      selectedCount: report.selectedCount,
      availableCandidateCount: report.availableCandidateCount,
      eligibleCount: report.eligibleCount,
      skippedCount: report.skippedCount,
      skippedByReason: report.skippedByReason,
      updated: report.updated,
      reportPath: report.reportPath,
    }, null, 2))
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(sanitizeError(error))
  process.exitCode = 1
})
