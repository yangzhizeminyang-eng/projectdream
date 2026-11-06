const AUDIO_LIBRARY_ASSET_TYPES = new Set(['music', 'sfx'])
const AUTHORIZED_LICENSE_STATUSES = new Set(['authorized', 'owned', 'public-domain'])
const AUDIO_DATA_URL_PATTERN = /^data:(audio\/(?:mpeg|wav|ogg|mp4|x-m4a|webm));base64,([a-z0-9+/=\s]+)$/i
const AUDIO_EXTENSION_BY_MEDIA_TYPE = {
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/webm': '.webm',
}

export function buildAudioLibraryStorageKey({ projectId, token, extension }) {
  const normalizedProjectId = Number(projectId)
  const normalizedToken = String(token || '').trim()
  const normalizedExtension = String(extension || '').trim().toLowerCase()
  if (
    !Number.isSafeInteger(normalizedProjectId) ||
    normalizedProjectId <= 0 ||
    !/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(normalizedToken) ||
    !Object.values(AUDIO_EXTENSION_BY_MEDIA_TYPE).includes(normalizedExtension)
  ) {
    throw new Error('invalid audio library storage key')
  }
  return `projects/${normalizedProjectId}/audio-library/${normalizedToken}${normalizedExtension}`
}

function requiredText(value, label) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`${label}不能为空`)
  return normalized
}

export function normalizeAudioLibraryUpload(raw = {}) {
  const assetType = String(raw.assetType || '').trim()
  if (!AUDIO_LIBRARY_ASSET_TYPES.has(assetType)) {
    throw new Error('素材类型只允许 music 或 sfx')
  }

  const licenseStatus = String(raw.licenseStatus || '').trim()
  if (!AUTHORIZED_LICENSE_STATUSES.has(licenseStatus)) {
    throw new Error('授权状态只允许 authorized、owned 或 public-domain')
  }

  const dataUrl = requiredText(raw.dataUrl, '音频文件')
  const dataUrlMatch = dataUrl.match(AUDIO_DATA_URL_PATTERN)
  if (!dataUrlMatch) {
    throw new Error('音频文件必须是支持格式的 Base64 Data URL')
  }

  const licenseEvidence = requiredText(raw.licenseEvidence, '授权凭证')

  return {
    assetType,
    title: requiredText(raw.title, '素材名称'),
    sourceName: requiredText(raw.sourceName, '素材来源'),
    licenseStatus,
    licenseEvidence,
    note: String(raw.note || '').trim() || null,
    fileName: requiredText(raw.fileName, '文件名'),
    mediaType: dataUrlMatch[1].toLowerCase(),
    dataUrl,
  }
}

export function decodeAudioLibraryUpload(upload) {
  const dataUrlMatch = String(upload?.dataUrl || '').match(AUDIO_DATA_URL_PATTERN)
  if (!dataUrlMatch) {
    throw new Error('音频文件必须是支持格式的 Base64 Data URL')
  }

  const mediaType = dataUrlMatch[1].toLowerCase()
  const bytes = Buffer.from(dataUrlMatch[2].replace(/\s/g, ''), 'base64')
  if (!bytes.length) throw new Error('音频文件不能为空')

  return {
    bytes,
    extension: AUDIO_EXTENSION_BY_MEDIA_TYPE[mediaType],
    mediaType,
  }
}
