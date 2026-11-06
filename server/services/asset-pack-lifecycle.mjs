function isActive(row) {
  return !['failed', 'superseded'].includes(String(row?.status || '').toLowerCase())
}

/**
 * Older workers persisted a complete character board as `single`.
 * Only an explicit board marker may promote it; an ordinary full-body image
 * must remain a normal base image.
 */
export function isCharacterAssetPackRow(row = {}) {
  const viewSetType = String(row?.view_set_type ?? row?.viewSetType ?? '').trim()
  if (viewSetType === 'character-asset-pack') return true
  if (viewSetType !== 'single') return false
  const label = String(row?.view_label ?? row?.viewLabel ?? '').trim()
  const prompt = String(row?.prompt_snapshot ?? row?.promptSnapshot ?? '').trim()
  return label === '角色资产板'
    || /完整角色资产板|角色资产板|character\s+asset\s+board/i.test(`${label}\n${prompt}`)
}

export function planAssetPackAdoption(candidateRows = [], existingRows = []) {
  const candidates = (Array.isArray(candidateRows) ? candidateRows : [])
    .filter((row) => isActive(row)
      && String(row?.view_set_type ?? row?.viewSetType ?? '') === 'character-asset-pack')
    .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))
  const candidate = candidates[0]
  const passed = String(candidate?.vision_status ?? candidate?.visionStatus ?? '').toLowerCase() === 'passed'
  if (!candidate || !passed) {
    return {
      ready: false,
      blockers: [candidate ? '角色资产板整体视觉检查未通过' : '角色资产板缺失'],
      adoptIds: [],
      replaceIds: [],
    }
  }

  const adoptId = Number(candidate.id)
  if (!Number.isSafeInteger(adoptId) || adoptId <= 0) {
    return { ready: false, blockers: ['角色资产板记录无效'], adoptIds: [], replaceIds: [] }
  }
  const replaceIds = (Array.isArray(existingRows) ? existingRows : [])
    .filter((row) => isActive(row)
      && ['confirmed', 'candidate'].includes(String(row?.status || '').toLowerCase())
      && Number(row.id) !== adoptId)
    .map((row) => Number(row.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0)

  return {
    ready: true,
    blockers: [],
    adoptIds: [adoptId],
    replaceIds,
  }
}

export function planSingleAssetAdoption(candidate, existingRows = []) {
  if (!candidate || !isActive(candidate)
    || String(candidate.vision_status ?? candidate.visionStatus ?? '').toLowerCase() !== 'passed') {
    return { ready: false, adoptId: null, replaceIds: [] }
  }
  const adoptId = Number(candidate.id)
  if (!Number.isSafeInteger(adoptId) || adoptId <= 0) {
    return { ready: false, adoptId: null, replaceIds: [] }
  }
  return {
    ready: true,
    adoptId,
    replaceIds: (Array.isArray(existingRows) ? existingRows : [])
      .filter((row) => isActive(row)
        && Number(row.id) !== adoptId
        && ['confirmed', 'candidate'].includes(String(row?.status || '').toLowerCase()))
      .map((row) => Number(row.id))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  }
}
