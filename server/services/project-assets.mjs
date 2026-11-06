const PROJECT_ASSET_TYPES = new Set(['character', 'image', 'video', 'audio'])
const PROTECTED_ASSET_STATUSES = new Map([
  ['confirmed', 'confirmed'],
  ['finalized', 'finalized'],
  ['done', 'done'],
])

export function normalizeProjectAssetType(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return PROJECT_ASSET_TYPES.has(normalized) ? normalized : null
}

export function canArchiveProjectAsset({ assetType, status }) {
  const normalizedType = normalizeProjectAssetType(assetType)
  if (!normalizedType) {
    return { allowed: false, reason: 'unsupported_type' }
  }

  const normalizedStatus = String(status || '').trim().toLowerCase()
  if (normalizedStatus === 'archived') {
    return { allowed: false, reason: 'already_archived' }
  }

  if (PROTECTED_ASSET_STATUSES.has(normalizedStatus)) {
    return { allowed: false, reason: PROTECTED_ASSET_STATUSES.get(normalizedStatus) }
  }

  return { allowed: true }
}
