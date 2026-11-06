import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  createLocalObjectStorage,
  createObjectStorageFromEnv,
  inspectObjectStorageReadiness,
} from '../server/services/object-storage.mjs'
import {
  buildStorageReplicationPlan,
  replicateStorageObjects,
  selectProjectStorageKeys,
  summarizeStorageReplication,
} from '../server/services/storage-replication.mjs'

const REPORT_DIR = path.join(process.cwd(), '.codex-runtime', 'replication-reports')

function readOption(name) {
  const prefix = `--${name}=`
  const value = process.argv.find((item) => item.startsWith(prefix))
  return value ? value.slice(prefix.length) : null
}

function parseProjectIds() {
  const raw = readOption('projects')
  if (!raw) throw new Error('--projects is required, for example --projects=12')
  const ids = [...new Set(
    raw
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  )]
  if (!ids.length) throw new Error('--projects must contain at least one positive project id')
  return ids.sort((left, right) => left - right)
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

function parseObjectKeys() {
  const raw = readOption('keys')
  if (raw === null) return null
  const keys = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (!keys.length) throw new Error('--keys must contain at least one object key')
  return keys
}

function redactErrorMessage(error, env) {
  let message = error instanceof Error ? error.message : 'local-to-COS replication failed'
  for (const secret of [env.COS_SECRET_ID, env.COS_SECRET_KEY]) {
    const value = String(secret || '').trim()
    if (value) message = message.replaceAll(value, '[REDACTED]')
  }
  return message
}

async function writeReport(report) {
  await mkdir(REPORT_DIR, { recursive: true })
  const time = report.generatedAt.replace(/[^0-9]/g, '').slice(0, 17)
  const projectLabel = report.projectIds.join('-')
  const mode = report.mode === 'apply' ? 'apply' : 'dry-run'
  const reportPath = path.join(
    REPORT_DIR,
    `local-to-cos-${projectLabel}-${mode}-${time}-${process.pid}.json`,
  )
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return reportPath
}

async function main() {
  const apply = process.argv.includes('--apply')
  const projectIds = parseProjectIds()
  const limit = parseLimit()
  const requestedKeys = parseObjectKeys()
  if (apply && !limit) {
    throw new Error('--apply requires --limit to keep COS uploads intentionally batched')
  }

  const readiness = inspectObjectStorageReadiness(process.env)
  if (readiness.provider !== 'cos' || !readiness.ready) {
    throw new Error(
      readiness.provider === 'cos'
        ? `COS configuration is incomplete: ${readiness.missing.join(', ')}`
        : 'OBJECT_STORAGE_PROVIDER must be cos for local-to-COS replication',
    )
  }

  const localRoot = path.resolve(
    process.env.LOCAL_OBJECT_STORAGE_ROOT
      || path.join(process.cwd(), '.codex-runtime', 'object-storage'),
  )
  const source = createLocalObjectStorage({
    root: localRoot,
    publicBaseUrl: 'http://127.0.0.1:8000/storage',
    signingSecret: 'replication-source-not-used-for-serving',
  })
  const destination = createObjectStorageFromEnv(process.env)
  const allKeys = await source.listObjectKeys()
  const projectKeys = selectProjectStorageKeys(allKeys, projectIds, requestedKeys)
  const selectedKeys = limit ? projectKeys.slice(0, limit) : projectKeys
  const plan = await buildStorageReplicationPlan({
    keys: selectedKeys,
    source,
    destination,
  })
  const results = apply
    ? await replicateStorageObjects({ plan, source, destination })
    : []

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    generatedAt: new Date().toISOString(),
    projectIds,
    requestedKeys,
    localRoot,
    localObjectCount: allKeys.length,
    projectObjectCount: projectKeys.length,
    selectedObjectCount: selectedKeys.length,
    limit,
    planSummary: summarizeStorageReplication(plan),
    plan,
    resultSummary: apply ? summarizeStorageReplication(results, 'result') : null,
    results,
  }
  report.reportPath = await writeReport(report)
  console.log(JSON.stringify({
    mode: report.mode,
    projectIds: report.projectIds,
    selectedObjectCount: report.selectedObjectCount,
    planSummary: report.planSummary,
    resultSummary: report.resultSummary,
    reportPath: report.reportPath,
  }, null, 2))
}

main().catch((error) => {
  console.error(redactErrorMessage(error, process.env))
  process.exitCode = 1
})
