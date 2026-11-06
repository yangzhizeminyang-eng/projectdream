import { createHmac } from 'node:crypto'

import { normalizeObjectKey } from './object-storage.mjs'

const DEFAULT_BASE_PATH = '/storage'
const DEFAULT_TTL_SECONDS = 900

function resolvePositiveInteger(value, fallback) {
  const resolved = Number(value ?? fallback)
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error('playback URL expiry must be a positive integer')
  }
  return resolved
}

function encodeObjectKey(key) {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

export function createSignedPlaybackProxyUrl({
  key: rawKey,
  signingSecret,
  basePath = DEFAULT_BASE_PATH,
  expiresInSeconds = DEFAULT_TTL_SECONDS,
  now = Math.floor(Date.now() / 1000),
} = {}) {
  const key = normalizeObjectKey(rawKey)
  const secret = String(signingSecret || '').trim()
  if (!secret) throw new Error('playback URL signing secret is required')

  const currentTime = resolvePositiveInteger(now)
  const ttl = resolvePositiveInteger(expiresInSeconds)
  const expires = currentTime + ttl
  const signature = createHmac('sha256', secret)
    .update(`${key}\n${expires}`)
    .digest('hex')
  const normalizedBasePath = `/${String(basePath || DEFAULT_BASE_PATH).trim().replace(/^\/+|\/+$/g, '')}`

  return `${normalizedBasePath}/${encodeObjectKey(key)}?expires=${expires}&signature=${signature}`
}
