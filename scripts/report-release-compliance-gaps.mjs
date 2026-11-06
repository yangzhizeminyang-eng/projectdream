import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'

import { buildExportStorageKey } from '../server/services/media-storage-keys.mjs'
import { createObjectStorageFromEnv } from '../server/services/object-storage.mjs'
import { parseSrtCues } from '../server/services/market-quality-benchmark.mjs'
import {
  buildReleaseComplianceGapSummary,
  buildReleaseCompliancePackage,
} from '../server/services/release-compliance.mjs'

const REPORT_DIR = path.join(process.cwd(), '.codex-runtime', 'release-compliance-reports')

function readOption(name) {
  const prefix = `--${name}=`
  const option = process.argv.find((argument) => argument.startsWith(prefix))
  return option ? option.slice(prefix.length) : null
}

function positiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${label} must be a positive integer`)
  }
  return parsed
}

function parseJsonObject(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value
  }
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : fallback
  } catch {
    return fallback
  }
}

function sanitizeError(error) {
  return String(error?.message || error || 'unknown compliance report error')
    .replace(/sk-[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .slice(0, 1600)
}

function normalizedPlatforms(savedCompliance) {
  return Array.isArray(savedCompliance.platforms) && savedCompliance.platforms.length
    ? savedCompliance.platforms.map((item) => String(item || '').trim()).filter(Boolean)
    : ['hongguo', 'douyin']
}

async function readSubtitle({ storage, projectId, exportId, config }) {
  const key = String(
    config.subtitleStorageKey ||
      buildExportStorageKey({ projectId, exportId, extension: '.srt' }),
  ).trim()
  const object = await storage.getObject(key)
  const text = object?.bytes ? object.bytes.toString('utf8') : ''
  const cues = parseSrtCues(text)
  return {
    key,
    readable: Boolean(object?.bytes?.length),
    cueCount: cues.length,
    cues,
  }
}

async function main() {
  const projectId = positiveInteger(readOption('project-id'), 'project-id')
  const exportId = positiveInteger(readOption('export-id'), 'export-id')
  const storage = createObjectStorageFromEnv(process.env)
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  })

  try {
    const [exportRows] = await db.execute(
      `SELECT id, project_id, status, video_url, storage_key, config_json
       FROM export_records
       WHERE id = ? AND project_id = ?
       LIMIT 1`,
      [exportId, projectId],
    )
    const exportRow = exportRows[0]
    if (!exportRow) throw new Error('找不到指定项目的导出记录')

    const config = parseJsonObject(exportRow.config_json, {})
    const savedCompliance = parseJsonObject(config.releaseCompliance, {})
    const subtitle = await readSubtitle({ storage, projectId, exportId, config })

    const [qualityRows] = await db.execute(
      `SELECT *
       FROM final_quality_reports
       WHERE export_id = ?
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
      [exportId],
    )
    const qualityRow = qualityRows[0] || null
    const [audioRows] = await db.execute(
      `SELECT id, track_type, title, source_name, license_status, license_evidence
       FROM audio_assets
       WHERE project_id = ?
         AND status = 'confirmed'
         AND track_type IN ('music', 'sfx')
       ORDER BY id ASC`,
      [projectId],
    )
    const technicalQuality = parseJsonObject(config.technicalQuality, {})
    const reviewChecklist = parseJsonObject(qualityRow?.review_checklist_json, {})
    const hasSpeech =
      Number(config.boundAudioCount || 0) > 0 || subtitle.cueCount > 0
    const compliance = buildReleaseCompliancePackage({
      projectId,
      exportId,
      exportRecord: {
        status: exportRow.status,
        videoUrl: exportRow.video_url || exportRow.storage_key || null,
        format: config.format,
        resolution: config.resolution,
        frameRate: config.frameRate,
        videoCodec: config.videoCodec,
        audioCodec: config.audioCodec,
        technicalQualityPassed:
          technicalQuality.status === 'passed' &&
          Array.isArray(technicalQuality.blockingIssues) &&
          technicalQuality.blockingIssues.length === 0,
      },
      subtitle: {
        hasSpeech,
        hasValidCues: subtitle.cueCount > 0,
        burnedIn: config.burnSubtitle !== false,
        cueCount: subtitle.cueCount,
      },
      audioAssets: audioRows.map((row) => ({
        id: Number(row.id),
        trackType: row.track_type,
        title: row.title,
        sourceName: row.source_name,
        licenseStatus: row.license_status,
        licenseEvidence: row.license_evidence,
      })),
      quality: qualityRow
        ? {
            automaticPassed: Boolean(qualityRow.automatic_passed),
            reviewDecision: qualityRow.review_decision || null,
            checklist: reviewChecklist,
          }
        : {},
      aiDisclosure: {
        isAiGenerated: savedCompliance.aiDisclosure?.isAiGenerated !== false,
        disclosureConfirmed:
          savedCompliance.aiDisclosure?.disclosureConfirmed === true,
        label: savedCompliance.aiDisclosure?.label || null,
        platformEvidence: savedCompliance.aiDisclosure?.platformEvidence || [],
      },
      platforms: normalizedPlatforms(savedCompliance),
    })
    const gapSummary = buildReleaseComplianceGapSummary(compliance)
    const report = {
      generatedAt: new Date().toISOString(),
      mode: 'read-only',
      projectId,
      exportId,
      disclaimer:
        '本报告只读取当前项目证据，不会写库、不会批准人工复核、不会提交红果或抖音。',
      sourceFacts: {
        exportStatus: exportRow.status,
        storageReadable: Boolean(exportRow.video_url || exportRow.storage_key),
        qualityReportId: qualityRow ? Number(qualityRow.id) : null,
        automaticQualityStatus: technicalQuality.status || null,
        subtitleStorageKey: subtitle.key,
        subtitleReadable: subtitle.readable,
        subtitleCueCount: subtitle.cueCount,
        confirmedLicensedMusicOrSfxCount: audioRows.length,
      },
      gapSummary,
      blockingIssues: compliance.blockingIssues,
      warnings: compliance.warnings,
    }
    await mkdir(REPORT_DIR, { recursive: true })
    const stamp = report.generatedAt.replace(/\D/g, '').slice(0, 17)
    const reportPath = path.join(
      REPORT_DIR,
      `release-compliance-project-${projectId}-export-${exportId}-${stamp}-${process.pid}.json`,
    )
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify({
      projectId,
      exportId,
      status: gapSummary.status,
      canPublish: gapSummary.canPublish,
      blockingIssueCodes: gapSummary.blockingIssueCodes,
      missingPlatforms: gapSummary.missingPlatforms,
      reportPath,
    }, null, 2))
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(sanitizeError(error))
  process.exitCode = 1
})
