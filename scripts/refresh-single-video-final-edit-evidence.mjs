import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

import { buildCompletedSingleVideoFinalEditConfig } from '../server/services/single-video-final-edit.mjs'

const CONFIRMATION_TOKEN = 'REFRESH_SINGLE_VIDEO_FINAL_EDIT_EVIDENCE'

function readOption(name) {
  const prefix = `--${name}=`
  const value = process.argv.find((argument) => argument.startsWith(prefix))
  return value ? value.slice(prefix.length) : null
}

function positiveInteger(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`)
  }
  return parsed
}

function parseJsonObject(value, fallback = {}) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function sanitizeError(error) {
  return String(error?.message || error || 'unknown evidence refresh error')
    .replace(/sk-[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .slice(0, 1600)
}

async function main() {
  const exportId = positiveInteger(readOption('export-id'), 'export-id')
  const reportPath = path.resolve(String(readOption('report-path') || '').trim())
  if (!reportPath) throw new Error('--report-path is required')
  if (readOption('confirm') !== CONFIRMATION_TOKEN) {
    throw new Error(`刷新证据需要明确确认：--confirm=${CONFIRMATION_TOKEN}`)
  }

  const report = parseJsonObject(await readFile(reportPath, 'utf8'), {})
  const item = Array.isArray(report.items)
    ? report.items.find((candidate) => Number(candidate?.exportId) === exportId)
    : null
  if (!item || item.audit?.technicalProxyPassed !== true) {
    throw new Error('指定报告中没有该导出的技术机器通过证据')
  }

  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  })

  try {
    const [rows] = await db.execute(
      `SELECT * FROM export_records WHERE id = ? LIMIT 1`,
      [exportId],
    )
    const record = rows[0]
    if (!record || record.status !== 'completed') {
      throw new Error('目标导出不存在或不是 completed 状态')
    }
    const currentConfig = parseJsonObject(record.config_json, {})
    if (
      currentConfig.pipeline !== 'single-video-final-edit-v1' &&
      currentConfig.singleVideoFinalEdit?.sourceMode !== 'single-video-candidate'
    ) {
      throw new Error('目标导出不是单条视频候选终剪记录')
    }
    if (Number(currentConfig.singleVideoFinalEdit?.videoId) !== 197) {
      throw new Error('目标导出不是 video #197')
    }

    const singleVideoConfig = {
      ...currentConfig,
      pipeline: 'single-video-final-edit-v1',
    }
    const technicalQuality = {
      status: 'passed',
      inspectedMedia: item.media || {},
      blockingIssues: [],
    }
    const nextConfig = buildCompletedSingleVideoFinalEditConfig(singleVideoConfig, {
      technicalQuality,
    })
    await db.execute(
      `UPDATE export_records
       SET config_json = ?, updated_at = NOW()
       WHERE id = ? AND status = 'completed'`,
      [JSON.stringify(nextConfig), exportId],
    )
    await db.execute(
      `INSERT INTO final_quality_reports
         (project_id, export_id, automatic_passed, automatic_report_json)
       VALUES (?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE
         automatic_passed = 1,
         automatic_report_json = VALUES(automatic_report_json),
         updated_at = NOW()`,
      [record.project_id, exportId, JSON.stringify(technicalQuality)],
    )

    console.log(JSON.stringify({
      exportId,
      projectId: Number(record.project_id),
      videoId: 197,
      pipeline: nextConfig.pipeline,
      technicalStatus: technicalQuality.status,
      audioSampleRate: technicalQuality.inspectedMedia.audioSampleRate || 0,
      storageKey: record.storage_key || null,
      humanReviewPreserved: true,
      sourceMediaPreserved: true,
    }, null, 2))
  } finally {
    await db.end()
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((error) => {
    console.error(sanitizeError(error))
    process.exitCode = 1
  })
}
