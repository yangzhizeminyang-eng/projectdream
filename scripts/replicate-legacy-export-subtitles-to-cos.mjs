import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  buildLegacyExportSubtitlePlan,
  replicateLegacyExportSubtitles,
  summarizeLegacyExportSubtitleResults,
} from '../server/services/legacy-export-subtitle-replication.mjs'
import {
  createObjectStorageFromEnv,
  inspectObjectStorageReadiness,
} from '../server/services/object-storage.mjs'

const REPORT_DIR = path.join(process.cwd(), '.codex-runtime', 'subtitle-replication-reports')

function readOption(name) {
  const prefix = `--${name}=`
  const value = process.argv.find((item) => item.startsWith(prefix))
  return value ? value.slice(prefix.length) : null
}

function parsePositiveIntegerList(name) {
  const raw = readOption(name)
  if (!raw) throw new Error(`--${name} is required`)
  const values = [...new Set(
    raw
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  )].sort((left, right) => left - right)
  if (!values.length) throw new Error(`--${name} must contain positive integers`)
  return values
}

function redactErrorMessage(error, env) {
  let message = error instanceof Error ? error.message : 'subtitle replication failed'
  for (const secret of [env.COS_SECRET_ID, env.COS_SECRET_KEY]) {
    const value = String(secret || '').trim()
    if (value) message = message.replaceAll(value, '[REDACTED]')
  }
  return message
}

async function writeReport(report) {
  await mkdir(REPORT_DIR, { recursive: true })
  const stamp = report.generatedAt.replace(/[^0-9]/g, '').slice(0, 17)
  const mode = report.mode === 'apply' ? 'apply' : 'dry-run'
  const exportLabel = report.exportIds.join('-')
  const reportPath = path.join(
    REPORT_DIR,
    `legacy-export-subtitles-${report.projectId}-${exportLabel}-${mode}-${stamp}-${process.pid}.json`,
  )
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return reportPath
}

async function main() {
  const apply = process.argv.includes('--apply')
  const projectId = Number(readOption('project'))
  const exportIds = parsePositiveIntegerList('exports')
  const limit = readOption('limit') === null ? null : Number(readOption('limit'))
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new Error('--project must be a positive integer')
  }
  if (limit !== null && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw new Error('--limit must be a positive integer')
  }
  if (apply && !limit) {
    throw new Error('--apply requires --limit to keep subtitle uploads intentionally batched')
  }

  const readiness = inspectObjectStorageReadiness(process.env)
  if (readiness.provider !== 'cos' || !readiness.ready) {
    throw new Error(
      readiness.provider === 'cos'
        ? `COS configuration is incomplete: ${readiness.missing.join(', ')}`
        : 'OBJECT_STORAGE_PROVIDER must be cos for subtitle replication',
    )
  }

  const destination = createObjectStorageFromEnv(process.env)
  const selectedExportIds = limit ? exportIds.slice(0, limit) : exportIds
  const sourceRoot = path.resolve(
    process.env.LEGACY_EXPORT_ROOT || path.join(process.cwd(), '.codex-runtime', 'exports'),
  )
  const plan = await buildLegacyExportSubtitlePlan({
    projectId,
    exportIds: selectedExportIds,
    sourceRoot,
    destination,
  })
  const results = apply
    ? await replicateLegacyExportSubtitles({ plan, destination })
    : []
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    generatedAt: new Date().toISOString(),
    projectId,
    exportIds: selectedExportIds,
    sourceRoot,
    planSummary: plan.reduce((summary, item) => {
      summary[item.action] = (summary[item.action] || 0) + 1
      return summary
    }, {}),
    plan,
    resultSummary: apply ? summarizeLegacyExportSubtitleResults(results) : null,
    results,
  }
  report.reportPath = await writeReport(report)
  console.log(JSON.stringify({
    mode: report.mode,
    projectId: report.projectId,
    exportIds: report.exportIds,
    planSummary: report.planSummary,
    resultSummary: report.resultSummary,
    reportPath: report.reportPath,
  }, null, 2))
}

main().catch((error) => {
  console.error(redactErrorMessage(error, process.env))
  process.exitCode = 1
})

