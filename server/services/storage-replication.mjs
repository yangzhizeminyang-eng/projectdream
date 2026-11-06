import { createHash } from 'node:crypto'

import { normalizeObjectKey } from './object-storage.mjs'

function asUniqueSortedKeys(keys) {
  if (!Array.isArray(keys)) throw new TypeError('storage keys must be an array')
  return [...new Set(keys.map((key) => normalizeObjectKey(key)))].sort()
}

function normalizeProjectIds(projectIds) {
  if (!Array.isArray(projectIds) || projectIds.length === 0) return null
  const ids = [...new Set(projectIds.map((value) => Number(value)))]
  if (ids.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('project ids must be positive integers')
  }
  return new Set(ids)
}

function projectIdForKey(key) {
  const match = /^projects\/(\d+)\//.exec(key)
  const projectId = Number(match?.[1])
  return Number.isSafeInteger(projectId) && projectId > 0 ? projectId : null
}

function checksumForObject(object) {
  const checksum = String(object?.checksum || '').trim().toLowerCase()
  return /^[a-f0-9]{64}$/.test(checksum) ? checksum : null
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function summarize(plan, field = 'action') {
  return plan.reduce((result, item) => {
    const key = String(item?.[field] || 'unknown')
    result[key] = (result[key] || 0) + 1
    return result
  }, {})
}

export function selectProjectStorageKeys(keys, projectIds = null, includeKeys = null) {
  const requested = normalizeProjectIds(projectIds)
  const included = includeKeys === null ? null : new Set(asUniqueSortedKeys(includeKeys))
  return asUniqueSortedKeys(keys).filter((key) => {
    const projectId = projectIdForKey(key)
    return (
      projectId
      && (!requested || requested.has(projectId))
      && (!included || included.has(key))
    )
  })
}

export async function buildStorageReplicationPlan({ keys, source, destination }) {
  if (!source?.headObject || !destination?.headObject) {
    throw new TypeError('source and destination storage adapters must provide headObject')
  }

  const plan = []
  for (const key of asUniqueSortedKeys(keys)) {
    const sourceObject = await source.headObject(key)
    if (!sourceObject) {
      plan.push({ key, action: 'unresolved', reason: 'source-missing' })
      continue
    }

    const destinationObject = await destination.headObject(key)
    if (!destinationObject) {
      plan.push({
        key,
        action: 'copy',
        reason: 'destination-missing',
        source: sourceObject,
        destination: null,
      })
      continue
    }

    const sourceChecksum = checksumForObject(sourceObject)
    const destinationChecksum = checksumForObject(destinationObject)
    if (
      sourceChecksum
      && destinationChecksum
      && sourceChecksum === destinationChecksum
      && Number(sourceObject.size) === Number(destinationObject.size)
    ) {
      plan.push({
        key,
        action: 'skip',
        reason: 'checksum-matched',
        source: sourceObject,
        destination: destinationObject,
      })
      continue
    }

    plan.push({
      key,
      action: 'copy',
      reason: destinationChecksum ? 'checksum-mismatched' : 'destination-checksum-missing',
      source: sourceObject,
      destination: destinationObject,
    })
  }
  return plan
}

export async function replicateStorageObjects({ plan, source, destination }) {
  if (!Array.isArray(plan)) throw new TypeError('replication plan must be an array')
  if (!source?.getObject || !destination?.putObject || !destination?.getObject) {
    throw new TypeError('storage adapters must support source getObject and destination putObject/getObject')
  }

  const results = []
  for (const item of plan) {
    if (item.action !== 'copy') {
      results.push({ key: item.key, result: item.action === 'skip' ? 'skipped' : 'unresolved', reason: item.reason })
      continue
    }

    const sourceObject = await source.getObject(item.key)
    if (!sourceObject?.bytes?.length) {
      results.push({ key: item.key, result: 'failed', reason: 'source-missing-or-empty' })
      continue
    }

    const expectedChecksum = hashBytes(sourceObject.bytes)
    await destination.putObject({
      key: item.key,
      bytes: sourceObject.bytes,
      contentType: sourceObject.contentType,
    })
    const copiedObject = await destination.getObject(item.key)
    if (!copiedObject?.bytes?.length) {
      results.push({ key: item.key, result: 'failed', reason: 'destination-readback-missing' })
      continue
    }
    if (hashBytes(copiedObject.bytes) !== expectedChecksum) {
      results.push({ key: item.key, result: 'failed', reason: 'destination-checksum-mismatched' })
      continue
    }
    results.push({
      key: item.key,
      result: 'copied-and-verified',
      size: sourceObject.bytes.length,
      checksum: expectedChecksum,
    })
  }
  return results
}

export function summarizeStorageReplication(items, field = 'action') {
  if (!Array.isArray(items)) throw new TypeError('replication items must be an array')
  return summarize(items, field)
}
