import { createHash, randomUUID } from 'node:crypto'

/**
 * Node -> FastAPI RAG sidecar client.
 *
 * RAG is deliberately a memory enhancement, not a production hard dependency:
 * confirmed asset references and the SQL snapshot remain authoritative.
 */

function text(value) {
  return String(value ?? '').trim()
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback
  const normalized = text(value).toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function normalizeUrl(value) {
  return text(value).replace(/\/+$/, '')
}

const indexedBatchKeys = new Set()

export function getRagConfig(env = process.env) {
  const enabled = parseBoolean(env.RAG_ENABLED, false)
  return {
    enabled,
    indexEnabled: enabled && parseBoolean(env.RAG_INDEX_ENABLED, false),
    serviceUrl: normalizeUrl(env.RAG_SERVICE_URL || 'http://rag:8001'),
    internalToken: text(env.RAG_INTERNAL_TOKEN || env.INTERNAL_TOKEN),
    timeoutMs: positiveInt(env.RAG_TIMEOUT_MS, 15_000),
    topK: Math.min(20, positiveInt(env.RAG_TOP_K, 5)),
  }
}

function resultError(error, extra = {}) {
  return {
    ok: false,
    degraded: true,
    items: [],
    indexed: 0,
    errorCode: text(error?.code) || 'RAG_UNAVAILABLE',
    error: text(error?.message || error) || 'RAG sidecar unavailable',
    ...extra,
  }
}

async function requestJson(pathname, body, config) {
  if (!config.serviceUrl) return resultError(new Error('RAG_SERVICE_URL is not configured'))
  if (!config.internalToken) return resultError(new Error('RAG_INTERNAL_TOKEN is not configured'))

  const requestId = randomUUID()
  const startedAt = Date.now()
  let response
  try {
    response = await fetch(`${config.serviceUrl}${pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-RAG-Internal-Token': config.internalToken,
        'X-RAG-Request-Id': requestId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (error) {
    return resultError(error, {
      errorCode: error?.name === 'TimeoutError' ? 'RAG_TIMEOUT' : 'RAG_NETWORK_ERROR',
      requestId,
      latencyMs: Date.now() - startedAt,
    })
  }

  const rawText = await response.text()
  let payload = {}
  try {
    payload = rawText ? JSON.parse(rawText) : {}
  } catch {
    payload = {}
  }
  if (!response.ok) {
    return resultError(new Error(text(payload.detail || payload.error || rawText) || `HTTP ${response.status}`), {
      status: response.status,
      errorCode: 'RAG_HTTP_ERROR',
      requestId,
      latencyMs: Date.now() - startedAt,
    })
  }
  return {
    ok: true,
    degraded: false,
    requestId,
    latencyMs: Date.now() - startedAt,
    ...payload,
  }
}

export async function queryRagDocuments(
  { projectId, episodeId = null, query, topK } = {},
  { env = process.env } = {},
) {
  const config = getRagConfig(env)
  if (!config.enabled) return { ok: true, skipped: true, degraded: false, items: [] }
  const normalizedProjectId = positiveInt(projectId, 0)
  const normalizedQuery = text(query)
  if (!normalizedProjectId || !normalizedQuery) {
    return resultError(new Error('projectId and query are required'), { errorCode: 'RAG_INVALID_REQUEST' })
  }
  const response = await requestJson('/v1/query', {
    project_id: normalizedProjectId,
    episode_id: positiveInt(episodeId, 0) || null,
    query: normalizedQuery,
    top_k: Math.min(20, positiveInt(topK, config.topK)),
  }, config)
  return {
    ...response,
    items: Array.isArray(response.items) ? response.items : [],
  }
}

export async function indexRagDocuments(documents = [], { env = process.env, replaceScopes = false } = {}) {
  const config = getRagConfig(env)
  if (!config.enabled || !config.indexEnabled) {
    return { ok: true, skipped: true, degraded: false, indexed: 0 }
  }
  if (!Array.isArray(documents) || !documents.length) {
    return { ok: true, skipped: true, degraded: false, indexed: 0 }
  }
  if (documents.length > 500) {
    return resultError(new Error('RAG document snapshot exceeds the 500-document limit'), {
      errorCode: 'RAG_BATCH_TOO_LARGE',
      documentCount: documents.length,
    })
  }
  const batch = documents
  const batchKey = createHash('sha256')
    .update(JSON.stringify({ documents: batch, replaceScopes: Boolean(replaceScopes) }))
    .digest('hex')
  if (indexedBatchKeys.has(batchKey)) {
    return { ok: true, skipped: true, degraded: false, indexed: 0, reason: 'already-indexed-in-process' }
  }
  const response = await requestJson('/v1/index/documents', {
    documents: batch,
    replace_scopes: Boolean(replaceScopes),
  }, config)
  if (response.ok) indexedBatchKeys.add(batchKey)
  return {
    ...response,
    indexed: Number(response.indexed || 0),
    updated: Number(response.updated || 0),
    removed: Number(response.removed || 0),
  }
}

export function formatRagRetrievedContext(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const kind = text(item?.metadata?.asset_type || item?.metadata?.source || 'memory')
      const content = text(item?.text)
      return content ? `[${kind}] ${content}` : ''
    })
    .filter(Boolean)
    .join('\n')
}
