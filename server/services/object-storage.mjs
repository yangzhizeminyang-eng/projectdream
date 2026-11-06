import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import COS from 'cos-nodejs-sdk-v5'

const DEFAULT_PUBLIC_BASE_URL = 'http://127.0.0.1:3001/storage'
const DEFAULT_SIGNING_SECRET = 'projectdream-local-signing-secret'
const DEFAULT_SIGNED_URL_TTL_SECONDS = 900
const MAX_OBJECT_KEY_DECODE_ROUNDS = 3
const METADATA_SUFFIX = '.meta.json'

function invalidObjectKey() {
  return new Error('invalid object key')
}

function decodeObjectKey(value) {
  let decoded = value
  for (let index = 0; index < MAX_OBJECT_KEY_DECODE_ROUNDS; index += 1) {
    let next
    try {
      next = decodeURIComponent(decoded)
    } catch {
      throw invalidObjectKey()
    }
    if (next === decoded) return decoded
    decoded = next
  }
  return decoded
}

export function normalizeObjectKey(value) {
  if (typeof value !== 'string') throw invalidObjectKey()
  const original = value.trim()
  if (!original) throw invalidObjectKey()

  const key = decodeObjectKey(original)
  if (
    !key ||
    key.startsWith('/') ||
    key.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(key) ||
    key.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(key)
  ) {
    throw invalidObjectKey()
  }

  const segments = key.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw invalidObjectKey()
  }
  return key
}

function normalizeObjectPrefix(value) {
  if (value === undefined || value === null || value === '') return ''
  const prefix = String(value).trim()
  if (!prefix) return ''
  return normalizeObjectKey(prefix)
}

function normalizeBytes(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes
  if (bytes instanceof Uint8Array) return Buffer.from(bytes)
  if (typeof bytes === 'string') return Buffer.from(bytes)
  throw new TypeError('object bytes must be a Buffer, Uint8Array, or string')
}

function normalizeContentType(value) {
  const contentType = String(value || '').trim()
  return contentType || 'application/octet-stream'
}

function inferContentType(key) {
  const extension = path.posix.extname(key).toLowerCase()
  const types = {
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.ogg': 'audio/ogg',
    '.png': 'image/png',
    '.srt': 'application/x-subrip',
    '.wav': 'audio/wav',
    '.webm': 'video/webm',
    '.webp': 'image/webp',
  }
  return types[extension] || 'application/octet-stream'
}

function normalizeEtag(value) {
  return String(value || '').trim().replace(/^"+|"+$/g, '')
}

function normalizePublicBaseUrl(value) {
  const baseUrl = String(value || DEFAULT_PUBLIC_BASE_URL).trim().replace(/\/+$/, '')
  if (!baseUrl) return DEFAULT_PUBLIC_BASE_URL
  try {
    const parsed = new URL(baseUrl)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol')
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    throw new Error('invalid object storage public base URL')
  }
}

function encodeObjectKeyForUrl(key) {
  return key.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}

function resolveExpiry(value, fallback) {
  const expiry = Number(value ?? fallback)
  if (!Number.isFinite(expiry) || expiry <= 0) {
    throw new Error('signed URL expiry must be a positive number')
  }
  return Math.floor(expiry)
}

function signatureFor({ key, expires, signingSecret }) {
  return createHmac('sha256', signingSecret)
    .update(`${key}\n${expires}`)
    .digest('hex')
}

function metadataPath(filePath) {
  return `${filePath}${METADATA_SUFFIX}`
}

function metadataFor({ key, bytes, contentType, etag, createdAt, updatedAt }) {
  return {
    key,
    size: bytes.length,
    contentType,
    etag,
    createdAt,
    updatedAt,
  }
}

async function readMetadata(filePath) {
  try {
    const value = JSON.parse(await readFile(metadataPath(filePath), 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

async function readFileInfo(filePath, key) {
  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch {
    return null
  }
  if (!fileStat.isFile()) return null

  const metadata = await readMetadata(filePath)
  let etag = String(metadata?.etag || '')
  if (!/^[a-f0-9]{64}$/.test(etag) || Number(metadata?.size) !== fileStat.size) {
    etag = createHash('sha256').update(await readFile(filePath)).digest('hex')
  }
  return {
    key,
    size: fileStat.size,
    contentType: normalizeContentType(metadata?.contentType || inferContentType(key)),
    etag,
    checksum: etag,
    createdAt: metadata?.createdAt || fileStat.birthtime.toISOString(),
    updatedAt: metadata?.updatedAt || fileStat.mtime.toISOString(),
    lastModifiedMs: fileStat.mtimeMs,
  }
}

async function walkFiles(directory, root, result) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await walkFiles(entryPath, root, result)
      continue
    }
    if (!entry.isFile() || entry.name.endsWith(METADATA_SUFFIX)) continue
    const key = path.relative(root, entryPath).split(path.sep).join('/')
    result.push({ key, path: entryPath })
  }
}

function readHeader(headers, name) {
  const target = String(name || '').toLowerCase()
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === target) return value
  }
  return undefined
}

function isMissingObjectError(error) {
  const status = Number(error?.statusCode || error?.status || 0)
  const code = String(error?.code || '').trim().toLowerCase()
  return status === 404 || ['nosuchkey', 'nosuchobject', 'notfound'].includes(code)
}

function cosRequest(client, method, options) {
  return new Promise((resolve, reject) => {
    client[method](options, (error, result) => {
      if (error) reject(error)
      else resolve(result || {})
    })
  })
}

function createCosClient(options) {
  return new COS({
    SecretId: options.secretId,
    SecretKey: options.secretKey,
    ...(options.domain ? { Domain: options.domain } : {}),
    ...(options.protocol ? { Protocol: options.protocol } : {}),
  })
}

function normalizeCosOptions(options = {}) {
  const bucket = String(options.bucket || '').trim()
  const region = String(options.region || '').trim()
  const secretId = String(options.secretId || '').trim()
  const secretKey = String(options.secretKey || '').trim()
  if (!bucket) throw new Error('COS_BUCKET is required')
  if (!region) throw new Error('COS_REGION is required')
  if (!options.client && !secretId) throw new Error('COS_SECRET_ID is required')
  if (!options.client && !secretKey) throw new Error('COS_SECRET_KEY is required')

  const publicBaseUrl = normalizePublicBaseUrl(
    options.publicBaseUrl || `https://${bucket}.cos.${region}.myqcloud.com`,
  )
  return {
    bucket,
    region,
    secretId,
    secretKey,
    domain: String(options.domain || '').trim(),
    protocol: String(options.protocol || 'https:').trim(),
    publicBaseUrl,
    signedUrlTtlSeconds: resolveExpiry(
      options.signedUrlTtlSeconds,
      DEFAULT_SIGNED_URL_TTL_SECONDS,
    ),
  }
}

function cosObjectInfo(key, payload = {}) {
  const headers = payload.headers || payload.Headers || {}
  const contentType = normalizeContentType(
    readHeader(headers, 'content-type') || inferContentType(key),
  )
  const size = Number(readHeader(headers, 'content-length') || payload.ContentLength || 0)
  const etag = normalizeEtag(payload.ETag || readHeader(headers, 'etag'))
  const checksum = normalizeEtag(readHeader(headers, 'x-cos-meta-sha256'))
  const updatedAt = String(readHeader(headers, 'x-cos-meta-updated-at') || '').trim()
  const createdAt = String(readHeader(headers, 'x-cos-meta-created-at') || '').trim()
  return {
    key,
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    contentType,
    etag,
    checksum: /^[a-f0-9]{64}$/i.test(checksum) ? checksum.toLowerCase() : null,
    createdAt: createdAt || null,
    updatedAt: updatedAt || null,
    lastModifiedMs: Date.parse(readHeader(headers, 'last-modified') || '') || null,
  }
}

function isConfiguredEnvironmentValue(value) {
  const normalized = String(value || '').trim()
  return Boolean(normalized) && !normalized.includes('请替换')
}

export function inspectObjectStorageReadiness(env = process.env) {
  const provider = String(env.OBJECT_STORAGE_PROVIDER || 'local').trim().toLowerCase()
  if (provider !== 'cos') {
    return {
      provider,
      ready: provider === 'local',
      missing: [],
    }
  }

  const requiredFields = ['COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_BUCKET', 'COS_REGION']
  const missing = requiredFields.filter((field) => !isConfiguredEnvironmentValue(env[field]))
  return {
    provider,
    ready: missing.length === 0,
    missing,
  }
}

export function verifySignedUrl({
  key,
  expires,
  signature,
  signingSecret,
  now = Math.floor(Date.now() / 1000),
}) {
  let normalizedKey
  try {
    normalizedKey = normalizeObjectKey(key)
  } catch {
    return false
  }
  const expiry = Number(expires)
  const suppliedSignature = String(signature || '').trim().toLowerCase()
  if (!Number.isSafeInteger(expiry) || expiry <= Number(now) || !/^[a-f0-9]{64}$/.test(suppliedSignature)) {
    return false
  }
  const expectedSignature = signatureFor({
    key: normalizedKey,
    expires: expiry,
    signingSecret: String(signingSecret || DEFAULT_SIGNING_SECRET),
  })
  return timingSafeEqual(
    Buffer.from(expectedSignature, 'hex'),
    Buffer.from(suppliedSignature, 'hex'),
  )
}

export function createLocalObjectStorage(options = {}) {
  const root = path.resolve(String(options.root || path.join(process.cwd(), '.codex-runtime', 'object-storage')))
  const publicBaseUrl = normalizePublicBaseUrl(options.publicBaseUrl)
  const signingSecret = String(options.signingSecret || DEFAULT_SIGNING_SECRET)
  const signedUrlTtlSeconds = resolveExpiry(
    options.signedUrlTtlSeconds,
    DEFAULT_SIGNED_URL_TTL_SECONDS,
  )

  function resolveObjectPath(value) {
    const key = normalizeObjectKey(value)
    const objectPath = path.resolve(root, ...key.split('/'))
    const relative = path.relative(root, objectPath)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw invalidObjectKey()
    return { key, objectPath }
  }

  async function putObject({ key: rawKey, bytes: rawBytes, contentType }) {
    const { key, objectPath } = resolveObjectPath(rawKey)
    const bytes = normalizeBytes(rawBytes)
    const normalizedContentType = normalizeContentType(contentType)
    const existing = await readMetadata(objectPath)
    const now = new Date().toISOString()
    const etag = createHash('sha256').update(bytes).digest('hex')
    const metadata = metadataFor({
      key,
      bytes,
      contentType: normalizedContentType,
      etag,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    })
    await mkdir(path.dirname(objectPath), { recursive: true })
    const temporaryPath = `${objectPath}.${randomUUID()}.tmp`
    const temporaryMetadataPath = `${metadataPath(objectPath)}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, bytes)
      await rename(temporaryPath, objectPath)
      await writeFile(temporaryMetadataPath, JSON.stringify(metadata), 'utf8')
      await rename(temporaryMetadataPath, metadataPath(objectPath))
    } finally {
      await rm(temporaryPath, { force: true })
      await rm(temporaryMetadataPath, { force: true })
    }
    return {
      key,
      size: metadata.size,
      contentType: metadata.contentType,
      etag: metadata.etag,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      url: publicUrl(key),
    }
  }

  async function getObject(rawKey) {
    const { key, objectPath } = resolveObjectPath(rawKey)
    const info = await readFileInfo(objectPath, key)
    if (!info) return null
    return {
      ...info,
      bytes: await readFile(objectPath),
    }
  }

  async function headObject(rawKey) {
    const { key, objectPath } = resolveObjectPath(rawKey)
    return readFileInfo(objectPath, key)
  }

  async function deleteObject(rawKey) {
    const { objectPath } = resolveObjectPath(rawKey)
    const existing = await stat(objectPath).catch(() => null)
    await rm(objectPath, { force: true })
    await rm(metadataPath(objectPath), { force: true })
    return Boolean(existing?.isFile?.())
  }

  function publicUrl(rawKey) {
    const key = normalizeObjectKey(rawKey)
    return `${publicBaseUrl}/${encodeObjectKeyForUrl(key)}`
  }

  function createSignedUrl({ key: rawKey, expiresInSeconds, now = Math.floor(Date.now() / 1000) }) {
    const key = normalizeObjectKey(rawKey)
    const nowSeconds = resolveExpiry(now, Math.floor(Date.now() / 1000))
    const expires = nowSeconds + resolveExpiry(expiresInSeconds, signedUrlTtlSeconds)
    const signature = signatureFor({ key, expires, signingSecret })
    const url = new URL(publicUrl(key))
    url.searchParams.set('expires', String(expires))
    url.searchParams.set('signature', signature)
    return url.toString()
  }

  async function listExpiredObjects({ prefix = '', before }) {
    const normalizedPrefix = normalizeObjectPrefix(prefix)
    const beforeDate = before instanceof Date ? before : new Date(before)
    const beforeMs = beforeDate.getTime()
    if (!Number.isFinite(beforeMs)) throw new Error('invalid expiration cutoff')
    const files = []
    await walkFiles(root, root, files)
    const expired = []
    for (const file of files) {
      if (normalizedPrefix && !(file.key === normalizedPrefix || file.key.startsWith(`${normalizedPrefix}/`))) continue
      const info = await readFileInfo(file.path, file.key)
      if (info && info.lastModifiedMs < beforeMs) expired.push(file.key)
    }
    return expired.sort()
  }

  async function deleteExpiredObjects(options = {}) {
    const expired = await listExpiredObjects(options)
    for (const key of expired) await deleteObject(key)
    return expired
  }

  async function listObjectKeys({ prefix = '' } = {}) {
    const normalizedPrefix = normalizeObjectPrefix(prefix)
    const files = []
    await walkFiles(root, root, files)
    return files
      .map((file) => file.key)
      .filter((key) => (
        !normalizedPrefix
        || key === normalizedPrefix
        || key.startsWith(`${normalizedPrefix}/`)
      ))
      .sort()
  }

  return {
    provider: 'local',
    root,
    publicBaseUrl,
    resolveLocalPath(rawKey) {
      return resolveObjectPath(rawKey).objectPath
    },
    putObject,
    getObject,
    headObject,
    deleteObject,
    publicUrl,
    createSignedUrl,
    listObjectKeys,
    listExpiredObjects,
    deleteExpiredObjects,
  }
}

export function createCosObjectStorage(options = {}) {
  const config = normalizeCosOptions(options)
  const client = options.client || createCosClient(config)

  function objectRequestOptions(rawKey) {
    return {
      Bucket: config.bucket,
      Region: config.region,
      Key: normalizeObjectKey(rawKey),
    }
  }

  async function headObject(rawKey) {
    const request = objectRequestOptions(rawKey)
    try {
      const response = await cosRequest(client, 'headObject', request)
      return cosObjectInfo(request.Key, response)
    } catch (error) {
      if (isMissingObjectError(error)) return null
      throw error
    }
  }

  async function putObject({ key: rawKey, bytes: rawBytes, contentType }) {
    const request = objectRequestOptions(rawKey)
    const bytes = normalizeBytes(rawBytes)
    const normalizedContentType = normalizeContentType(contentType)
    const now = new Date().toISOString()
    const previous = await headObject(request.Key)
    const etag = createHash('sha256').update(bytes).digest('hex')
    const response = await cosRequest(client, 'putObject', {
      ...request,
      Body: bytes,
      ContentLength: bytes.length,
      Headers: {
        'Content-Type': normalizedContentType,
        'x-cos-meta-created-at': previous?.createdAt || now,
        'x-cos-meta-updated-at': now,
        'x-cos-meta-sha256': etag,
      },
    })
    const info = cosObjectInfo(request.Key, response)
    return {
      key: request.Key,
      size: bytes.length,
      contentType: normalizedContentType,
      etag: info.etag || etag,
      createdAt: previous?.createdAt || info.createdAt || now,
      updatedAt: info.updatedAt || now,
      url: publicUrl(request.Key),
    }
  }

  async function getObject(rawKey) {
    const request = objectRequestOptions(rawKey)
    try {
      const response = await cosRequest(client, 'getObject', request)
      const info = cosObjectInfo(request.Key, response)
      const bytes = normalizeBytes(response.Body || Buffer.alloc(0))
      return {
        ...info,
        size: info.size || bytes.length,
        checksum: info.checksum || createHash('sha256').update(bytes).digest('hex'),
        bytes,
      }
    } catch (error) {
      if (isMissingObjectError(error)) return null
      throw error
    }
  }

  async function deleteObject(rawKey) {
    const request = objectRequestOptions(rawKey)
    const existing = await headObject(request.Key)
    if (!existing) return false
    await cosRequest(client, 'deleteObject', request)
    return true
  }

  function publicUrl(rawKey) {
    const key = normalizeObjectKey(rawKey)
    return `${config.publicBaseUrl}/${encodeObjectKeyForUrl(key)}`
  }

  function createSignedUrl({ key: rawKey, expiresInSeconds }) {
    const key = normalizeObjectKey(rawKey)
    const expires = resolveExpiry(expiresInSeconds, config.signedUrlTtlSeconds)
    const url = client.getObjectUrl({
      Bucket: config.bucket,
      Region: config.region,
      Key: key,
      Expires: expires,
    })
    if (typeof url !== 'string' || !url.trim()) {
      throw new Error('COS signed URL generation failed')
    }
    return url
  }

  async function listExpiredObjects({ prefix = '', before }) {
    const normalizedPrefix = normalizeObjectPrefix(prefix)
    const beforeDate = before instanceof Date ? before : new Date(before)
    const beforeMs = beforeDate.getTime()
    if (!Number.isFinite(beforeMs)) throw new Error('invalid expiration cutoff')

    const expired = []
    let marker = ''
    while (true) {
      const response = await cosRequest(client, 'getBucket', {
        Bucket: config.bucket,
        Region: config.region,
        Prefix: normalizedPrefix || undefined,
        Marker: marker || undefined,
      })
      const contents = Array.isArray(response.Contents) ? response.Contents : []
      for (const item of contents) {
        const key = String(item?.Key || '').trim()
        const updatedAt = Date.parse(item?.LastModified || '')
        if (key && Number.isFinite(updatedAt) && updatedAt < beforeMs) {
          expired.push(normalizeObjectKey(key))
        }
      }
      const nextMarker = String(response.NextMarker || '').trim()
      if (!response.IsTruncated || !nextMarker || nextMarker === marker) break
      marker = nextMarker
    }
    return expired.sort()
  }

  async function deleteExpiredObjects(options = {}) {
    const expired = await listExpiredObjects(options)
    for (const key of expired) await deleteObject(key)
    return expired
  }

  async function listObjectKeys({ prefix = '' } = {}) {
    const normalizedPrefix = normalizeObjectPrefix(prefix)
    const keys = []
    let marker = ''
    while (true) {
      const response = await cosRequest(client, 'getBucket', {
        Bucket: config.bucket,
        Region: config.region,
        Prefix: normalizedPrefix || undefined,
        Marker: marker || undefined,
      })
      const contents = Array.isArray(response.Contents) ? response.Contents : []
      for (const item of contents) {
        const key = String(item?.Key || '').trim()
        if (key) keys.push(normalizeObjectKey(key))
      }
      const nextMarker = String(response.NextMarker || '').trim()
      if (!response.IsTruncated || !nextMarker || nextMarker === marker) break
      marker = nextMarker
    }
    return [...new Set(keys)].sort()
  }

  return {
    provider: 'cos',
    bucket: config.bucket,
    region: config.region,
    publicBaseUrl: config.publicBaseUrl,
    putObject,
    getObject,
    headObject,
    deleteObject,
    publicUrl,
    createSignedUrl,
    listObjectKeys,
    listExpiredObjects,
    deleteExpiredObjects,
  }
}

export function createObjectStorageFromEnv(env = process.env, options = {}) {
  const provider = String(env.OBJECT_STORAGE_PROVIDER || 'local').trim().toLowerCase()
  if (provider === 'cos') {
    const readiness = inspectObjectStorageReadiness(env)
    if (!readiness.ready) {
      throw new Error(`${readiness.missing[0]} is required`)
    }
    const createClient = options.createCosClient || createCosClient
    return createCosObjectStorage({
      client: options.client || createClient({
        secretId: env.COS_SECRET_ID,
        secretKey: env.COS_SECRET_KEY,
        domain: env.COS_DOMAIN,
        protocol: env.COS_PROTOCOL,
      }),
      secretId: env.COS_SECRET_ID,
      secretKey: env.COS_SECRET_KEY,
      bucket: env.COS_BUCKET,
      region: env.COS_REGION,
      domain: env.COS_DOMAIN,
      protocol: env.COS_PROTOCOL,
      publicBaseUrl: env.OBJECT_STORAGE_PUBLIC_BASE_URL,
      signedUrlTtlSeconds: env.OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS,
    })
  }
  if (provider !== 'local') {
    throw new Error(`unsupported object storage provider: ${provider}`)
  }
  return createLocalObjectStorage({
    root: env.OBJECT_STORAGE_ROOT || path.join(process.cwd(), '.codex-runtime', 'object-storage'),
    publicBaseUrl: env.OBJECT_STORAGE_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL,
    signingSecret: env.OBJECT_STORAGE_SIGNING_SECRET || DEFAULT_SIGNING_SECRET,
    signedUrlTtlSeconds: env.OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS || DEFAULT_SIGNED_URL_TTL_SECONDS,
  })
}
