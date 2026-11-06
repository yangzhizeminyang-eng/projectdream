function positiveId(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

function hasPersistedInspection(value) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  return true
}

function classifyRow(row, projectIds) {
  const projectId = positiveId(row?.project_id)
  if (!projectIds.has(projectId)) return 'outside-project'
  if (!String(row?.storage_key || '').trim()) return 'missing-storage-key'
  if (hasPersistedInspection(row?.recovery_inspection_json)) return 'already-inspected'
  return null
}

export function summarizeRecoveryInspectionSelection({
  rows = [],
  projectIds = [],
  limit = null,
} = {}) {
  const allowedProjectIds = new Set(
    (Array.isArray(projectIds) ? projectIds : [])
      .map(positiveId)
      .filter(Boolean),
  )
  const selected = []
  const skippedByReason = {}

  for (const row of Array.isArray(rows) ? rows : []) {
    const reason = classifyRow(row, allowedProjectIds)
    if (reason) {
      skippedByReason[reason] = (skippedByReason[reason] || 0) + 1
      continue
    }
    selected.push(row)
  }

  const eligibleCount = selected.length
  const selectedRows = Number.isSafeInteger(limit) && limit > 0
    ? selected.slice(0, limit)
    : selected

  return {
    selectedCount: selectedRows.length,
    eligibleCount,
    selectedRows,
    selectedVideoAssetIds: selectedRows.map((row) =>
      positiveId(row?.video_asset_id ?? row?.id),
    ),
    skippedByReason,
    skippedCount: Object.values(skippedByReason)
      .reduce((total, count) => total + Number(count || 0), 0),
  }
}
