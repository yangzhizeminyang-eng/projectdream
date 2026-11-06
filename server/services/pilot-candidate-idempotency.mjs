function text(value) {
  return String(value ?? '').trim()
}

function numberOrNull(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function parseSnapshot(value) {
  if (value && typeof value === 'object') return value
  try {
    return JSON.parse(String(value || ''))
  } catch {
    return null
  }
}

function matchesVoiceLockSnapshot(row, expectedSnapshot = {}) {
  const actual = parseSnapshot(row?.voice_lock_snapshot_json || row?.voiceLockSnapshotJson)
  if (!actual || actual.locked !== true) return false

  const fields = [
    'version',
    'characterName',
    'voiceProfileKey',
    'voiceName',
    'modelName',
    'languageType',
  ]
  return fields.every((field) => {
    const expected = expectedSnapshot?.[field]
    return expected == null || text(actual[field]) === text(expected)
  })
}

export function selectReusablePilotCandidates(rows = [], {
  candidateCount = 1,
  productionBatch = '',
  modelName = '',
  imageAssetId = null,
  characterId = null,
  requireVoiceLockSnapshot = false,
  voiceLockSnapshot = null,
} = {}) {
  const requiredCount = Math.max(1, Number(candidateCount) || 1)
  const expectedBatch = text(productionBatch)
  const expectedModel = text(modelName)
  const expectedImageAssetId = numberOrNull(imageAssetId)
  const expectedCharacterId = numberOrNull(characterId)

  const matchingRows = rows
    .filter((row) => text(row?.status).toLowerCase() === 'candidate')
    .filter((row) => !expectedBatch || text(row?.production_batch || row?.productionBatch) === expectedBatch)
    .filter((row) => !expectedModel || text(row?.model_name || row?.modelName) === expectedModel)
    .filter((row) => expectedImageAssetId === null || numberOrNull(row?.image_asset_id || row?.imageAssetId) === expectedImageAssetId)
    .filter((row) => expectedCharacterId === null || numberOrNull(row?.character_id || row?.characterId) === expectedCharacterId)
    .filter(
      (row) =>
        !requireVoiceLockSnapshot ||
        matchesVoiceLockSnapshot(row, voiceLockSnapshot || {}),
    )
    .sort((left, right) => {
      const versionDelta = Number(right?.version_no || right?.versionNo || 0)
        - Number(left?.version_no || left?.versionNo || 0)
      if (versionDelta !== 0) return versionDelta
      return Number(left?.id || 0) - Number(right?.id || 0)
    })

  return {
    items: matchingRows.slice(0, requiredCount),
    matchedCount: matchingRows.length,
    enough: matchingRows.length >= requiredCount,
  }
}
