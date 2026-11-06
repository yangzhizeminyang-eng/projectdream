const DEFAULT_MAX_BYTES = 128 * 1024 * 1024

export const DEFAULT_REMOTE_MEDIA_HOSTS = [
  'platform-outputs.agnes-ai.space',
  'maas-watermark-prod-new.cn-wlcb.ufileos.com',
  'aigc-files.bigmodel.cn',
]

const EXTENSION_BY_CONTENT_TYPE = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['audio/mpeg', '.mp3'],
  ['audio/ogg', '.ogg'],
  ['audio/mp4', '.m4a'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
])

const SUPPORTED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.wav',
  '.mp3',
  '.ogg',
  '.m4a',
  '.webm',
  '.mp4',
])

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '')
}

export function parseRemoteMediaAllowedHosts(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || '')
        .split(',')
        .map((item) => item.trim())
  const hosts = values.map(normalizeHost).filter((host) => /^[a-z0-9.-]+$/.test(host))
  return [...new Set(hosts.length ? hosts : DEFAULT_REMOTE_MEDIA_HOSTS)]
}

function parseExpiry(parsed) {
  for (const key of ['Expires', 'expires', 'expires_at', 'expiresAt', 'exp']) {
    const raw = parsed.searchParams.get(key)
    if (!raw) continue
    const seconds = Number(raw)
    if (Number.isFinite(seconds) && seconds > 0) return Math.floor(seconds)
  }
  return null
}

function extensionFromUrl(parsed) {
  const match = parsed.pathname.match(/(\.[a-z0-9]{2,5})$/i)
  return match ? match[1].toLowerCase() : null
}

export function inspectRemoteMediaSource({
  url,
  allowedHosts = DEFAULT_REMOTE_MEDIA_HOSTS,
  now = Math.floor(Date.now() / 1000),
} = {}) {
  const value = String(url || '').trim()
  if (!value) return { action: 'unresolved', reason: 'missing-remote-url' }

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return { action: 'unresolved', reason: 'unsupported-remote-url' }
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { action: 'unresolved', reason: 'unsupported-remote-url' }
  }

  const host = normalizeHost(parsed.hostname)
  const hosts = parseRemoteMediaAllowedHosts(allowedHosts)
  if (!hosts.includes(host)) {
    return { action: 'unresolved', reason: 'remote-host-not-allowed', host }
  }

  const extension = extensionFromUrl(parsed)
  if (!extension || !SUPPORTED_EXTENSIONS.has(extension)) {
    return { action: 'unresolved', reason: 'unsupported-remote-extension', host }
  }

  const expiresAt = parseExpiry(parsed)
  if (expiresAt !== null && (!Number.isFinite(Number(now)) || expiresAt <= Number(now))) {
    return {
      action: 'unresolved',
      reason: 'remote-url-expired',
      host,
      extension,
      expiresAt,
    }
  }

  return {
    action: 'download',
    url: value,
    host,
    extension,
    expiresAt,
  }
}

function mediaKindForExtension(extension) {
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(extension)) return 'image'
  if (['.mp4', '.webm'].includes(extension)) return 'video'
  return 'audio'
}

function hasPngSignature(bytes) {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )
}

function hasJpegSignature(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function hasWebpSignature(bytes) {
  return bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
}

function hasMp4Signature(bytes) {
  return bytes.length >= 12 &&
    bytes.toString('ascii', 4, 8) === 'ftyp'
}

function hasWebmSignature(bytes) {
  return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
}

function hasWavSignature(bytes) {
  return bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WAVE'
}

function hasOggSignature(bytes) {
  return bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'OggS'
}

function hasMp3Signature(bytes) {
  return bytes.length >= 3 && (
    bytes.toString('ascii', 0, 3) === 'ID3' ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  )
}

function hasMediaSignature(bytes, extension) {
  switch (extension) {
    case '.png':
      return hasPngSignature(bytes)
    case '.jpg':
    case '.jpeg':
      return hasJpegSignature(bytes)
    case '.webp':
      return hasWebpSignature(bytes)
    case '.mp4':
    case '.m4a':
      return hasMp4Signature(bytes)
    case '.webm':
      return hasWebmSignature(bytes)
    case '.wav':
      return hasWavSignature(bytes)
    case '.ogg':
      return hasOggSignature(bytes)
    case '.mp3':
      return hasMp3Signature(bytes)
    default:
      return false
  }
}

function normalizeBytes(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  return Buffer.from(value || [])
}

function normalizedContentType(value, extension) {
  const valueType = String(value || '').split(';', 1)[0].trim().toLowerCase()
  return valueType || EXTENSION_BY_CONTENT_TYPE.get(extension) || 'application/octet-stream'
}

export function validateRemoteMediaBytes({
  bytes: rawBytes,
  contentType,
  extension,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const bytes = normalizeBytes(rawBytes)
  const normalizedExtension = String(extension || '').trim().toLowerCase()
  const limit = Number(maxBytes)
  if (!SUPPORTED_EXTENSIONS.has(normalizedExtension)) {
    throw new Error('unsupported remote media extension')
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('remote media maximum size must be positive')
  }
  if (!bytes.length) throw new Error('remote media is empty')
  if (bytes.length > limit) throw new Error('remote media exceeds maximum size')
  if (!hasMediaSignature(bytes, normalizedExtension)) {
    throw new Error('invalid remote media signature')
  }

  const type = normalizedContentType(contentType, normalizedExtension)
  return {
    mediaKind: mediaKindForExtension(normalizedExtension),
    sizeBytes: bytes.length,
    contentType: type,
    extension: normalizedExtension,
  }
}

export async function downloadAndValidateRemoteMedia({
  url,
  allowedHosts = DEFAULT_REMOTE_MEDIA_HOSTS,
  now = Math.floor(Date.now() / 1000),
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = 180000,
  fetchImpl = fetch,
} = {}) {
  const source = inspectRemoteMediaSource({ url, allowedHosts, now })
  if (source.action !== 'download') {
    throw new Error(source.reason)
  }

  let response
  try {
    response = await fetchImpl(source.url, {
      signal: AbortSignal.timeout(Number(timeoutMs) > 0 ? Number(timeoutMs) : 180000),
    })
  } catch (error) {
    throw new Error(`remote media download failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  if (!response?.ok) {
    throw new Error(`remote media download failed with HTTP ${response?.status || 0}`)
  }

  const declaredSize = Number(response.headers?.get?.('content-length') || 0)
  if (declaredSize > Number(maxBytes)) {
    throw new Error('remote media exceeds maximum size')
  }
  const bytes = normalizeBytes(await response.arrayBuffer())
  const validation = validateRemoteMediaBytes({
    bytes,
    contentType: response.headers?.get?.('content-type'),
    extension: source.extension,
    maxBytes,
  })
  return { source, bytes, validation }
}

export function remoteMediaMaxBytes(value, fallback = DEFAULT_MAX_BYTES) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}
