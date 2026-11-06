import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

import { buildExportStorageKey } from './media-storage-keys.mjs'

function positiveInteger(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

function uniqueExportIds(exportIds = []) {
  return [...new Set(
    (Array.isArray(exportIds) ? exportIds : [])
      .map(positiveInteger)
      .filter(Boolean),
  )].sort((left, right) => left - right)
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function safeSourcePath(sourceRoot, exportId) {
  const root = path.resolve(String(sourceRoot || ''))
  const sourcePath = path.resolve(root, String(exportId), 'subtitles.srt')
  const relative = path.relative(root, sourcePath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('invalid subtitle source path')
  }
  return sourcePath
}

export async function buildLegacyExportSubtitlePlan({
  projectId,
  exportIds = [],
  sourceRoot,
  destination = null,
} = {}) {
  const normalizedProjectId = positiveInteger(projectId)
  if (!normalizedProjectId) throw new Error('project id must be positive')
  const normalizedRoot = path.resolve(String(sourceRoot || ''))
  if (!normalizedRoot || normalizedRoot === path.parse(normalizedRoot).root) {
    throw new Error('subtitle source root is required')
  }

  const plans = []
  for (const exportId of uniqueExportIds(exportIds)) {
    const key = buildExportStorageKey({
      projectId: normalizedProjectId,
      exportId,
      extension: '.srt',
    })
    const sourcePath = safeSourcePath(normalizedRoot, exportId)
    let sourceBytes = null
    try {
      await access(sourcePath)
      sourceBytes = await readFile(sourcePath)
    } catch {
      plans.push({
        exportId,
        key,
        sourcePath,
        action: 'unresolved',
        reason: 'source-missing',
      })
      continue
    }

    if (!sourceBytes.length) {
      plans.push({
        exportId,
        key,
        sourcePath,
        action: 'unresolved',
        reason: 'source-empty',
      })
      continue
    }

    const sourceSha256 = hashBytes(sourceBytes)
    const destinationObject = destination?.headObject
      ? await destination.headObject(key)
      : null
    const destinationMatches = Boolean(
      destinationObject
      && Number(destinationObject.size) === sourceBytes.length
      && String(destinationObject.checksum || destinationObject.etag || '').toLowerCase() === sourceSha256,
    )

    plans.push({
      exportId,
      key,
      sourcePath,
      action: destinationMatches ? 'skip' : 'copy',
      reason: destinationMatches ? 'destination-checksum-matched' : destinationObject ? 'destination-checksum-unverified' : 'destination-missing',
      sourceSizeBytes: sourceBytes.length,
      sourceSha256,
      destination: destinationObject,
    })
  }
  return plans
}

export async function replicateLegacyExportSubtitles({ plan = [], destination } = {}) {
  if (!Array.isArray(plan)) throw new TypeError('subtitle replication plan must be an array')
  if (!destination?.putObject || !destination?.getObject) {
    throw new TypeError('destination storage adapter must support putObject and getObject')
  }

  const results = []
  for (const item of plan) {
    if (item.action === 'unresolved') {
      results.push({ exportId: item.exportId, key: item.key, result: 'unresolved', reason: item.reason })
      continue
    }
    if (item.action === 'skip') {
      results.push({ exportId: item.exportId, key: item.key, result: 'skipped', reason: item.reason })
      continue
    }

    try {
      const bytes = await readFile(item.sourcePath)
      if (!bytes.length) throw new Error('source-empty')
      const expectedSha256 = hashBytes(bytes)
      await destination.putObject({
        key: item.key,
        bytes,
        contentType: 'application/x-subrip; charset=utf-8',
      })
      const copied = await destination.getObject(item.key)
      if (!copied?.bytes?.length) throw new Error('destination-readback-missing')
      const actualSha256 = hashBytes(copied.bytes)
      if (actualSha256 !== expectedSha256) throw new Error('destination-checksum-mismatched')
      results.push({
        exportId: item.exportId,
        key: item.key,
        result: 'copied-and-verified',
        size: bytes.length,
        sha256: expectedSha256,
      })
    } catch (error) {
      results.push({
        exportId: item.exportId,
        key: item.key,
        result: 'failed',
        reason: error instanceof Error ? error.message : 'replication-failed',
      })
    }
  }
  return results
}

export function summarizeLegacyExportSubtitleResults(results = []) {
  if (!Array.isArray(results)) throw new TypeError('subtitle replication results must be an array')
  return results.reduce((summary, item) => {
    const key = String(item?.result || 'unknown')
    summary[key] = (summary[key] || 0) + 1
    return summary
  }, {})
}

