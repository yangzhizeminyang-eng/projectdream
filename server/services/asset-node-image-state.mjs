/**
 * Resolve the one visible version for each asset image angle.
 * The database keeps failed and superseded rows for audit, but the newest
 * vision-passed row is the current adopted version even for legacy rows that
 * were stored as `candidate`.
 */
export function resolveAssetImageVersionUpdates(rows = []) {
  const groups = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const viewSetType = String(row?.view_set_type ?? row?.viewSetType ?? 'single').trim() || 'single'
    const rawViewKey = row?.view_key ?? row?.viewKey
    const viewKey = rawViewKey == null || String(rawViewKey).trim() === '' ? null : String(rawViewKey).trim()
    const key = `${viewSetType}\u0000${viewKey || ''}`
    const group = groups.get(key) || []
    group.push(row)
    groups.set(key, group)
  }

  const updates = []
  for (const group of groups.values()) {
    const active = group
      .filter((row) => !['superseded', 'failed'].includes(String(row?.status || '').toLowerCase()))
      .filter((row) => String(row?.vision_status ?? row?.visionStatus ?? '').toLowerCase() !== 'failed')
      .sort((left, right) => Number(right?.id || 0) - Number(left?.id || 0))
    const adopted = active.find((row) => String(row?.vision_status ?? row?.visionStatus ?? '').toLowerCase() === 'passed')
    if (!adopted) continue

    updates.push({ id: Number(adopted.id), status: 'confirmed' })
    for (const row of active) {
      const status = String(row.status || '').toLowerCase()
      const visionStatus = String(row.vision_status ?? row.visionStatus ?? '').toLowerCase()
      const canReplace = status === 'confirmed' || visionStatus === 'passed'
      if (Number(row.id) !== Number(adopted.id) && canReplace && ['candidate', 'confirmed'].includes(status)) {
        updates.push({ id: Number(row.id), status: 'superseded' })
      }
    }
  }
  return updates.filter((update) => Number.isSafeInteger(update.id) && update.id > 0)
}
