import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatRagRetrievedContext,
  getRagConfig,
  indexRagDocuments,
  queryRagDocuments,
} from './rag-client.mjs'

test('RAG config is disabled by default and never calls the network', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    throw new Error('network must not be called')
  }

  try {
    const config = getRagConfig({})
    assert.equal(config.enabled, false)
    const result = await queryRagDocuments({ projectId: 1, query: '林知夏' }, { env: {} })
    assert.equal(result.degraded, false)
    assert.equal(result.skipped, true)
    assert.deepEqual(result.items, [])
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('RAG query sends project isolation, token and timeout-safe request', async () => {
  const originalFetch = globalThis.fetch
  let request = null
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return new Response(JSON.stringify({ items: [{ text: '值班台', score: 0.9, metadata: { source: 'test' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    const result = await queryRagDocuments(
      { projectId: 7, episodeId: 2, query: '红色发卡', topK: 3 },
      {
        env: {
          RAG_ENABLED: 'true',
          RAG_SERVICE_URL: 'http://rag:8001/',
          RAG_INTERNAL_TOKEN: 'test-token',
          RAG_TIMEOUT_MS: '1200',
        },
      },
    )
    assert.equal(result.ok, true)
    assert.equal(result.items[0].text, '值班台')
    assert.equal(request.url, 'http://rag:8001/v1/query')
    assert.equal(request.options.headers['X-RAG-Internal-Token'], 'test-token')
    assert.match(request.options.headers['X-RAG-Request-Id'], /^[0-9a-f-]{36}$/u)
    assert.equal(typeof result.requestId, 'string')
    assert.equal(typeof result.latencyMs, 'number')
    assert.deepEqual(JSON.parse(request.options.body), {
      project_id: 7,
      episode_id: 2,
      query: '红色发卡',
      top_k: 3,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('RAG failures degrade to local memory without breaking the caller', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('upstream unavailable', { status: 503 })

  try {
    const result = await queryRagDocuments(
      { projectId: 1, query: '场景' },
      { env: { RAG_ENABLED: 'true', RAG_SERVICE_URL: 'http://rag:8001', RAG_INTERNAL_TOKEN: 'token' } },
    )
    assert.equal(result.ok, false)
    assert.equal(result.degraded, true)
    assert.deepEqual(result.items, [])
    assert.equal(result.status, 503)
    assert.match(result.requestId, /^[0-9a-f-]{36}$/u)
    assert.equal(typeof result.latencyMs, 'number')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('RAG indexing is opt-in and returns a structured degraded result', async () => {
  const originalFetch = globalThis.fetch
  let request = null
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return new Response(JSON.stringify({ indexed: 2, collection: 'test' }), { status: 200 })
  }

  try {
    const result = await indexRagDocuments(
      [{ text: '场景', metadata: { project_id: 1, episode_id: 1, asset_type: 'scene', asset_id: 'scene:1', asset_version: 1, source: 'test' } }],
      { replaceScopes: true, env: { RAG_ENABLED: 'true', RAG_INDEX_ENABLED: 'true', RAG_SERVICE_URL: 'http://rag:8001', RAG_INTERNAL_TOKEN: 'token' } },
    )
    assert.equal(result.ok, true)
    assert.equal(result.indexed, 2)
    assert.equal(request.url, 'http://rag:8001/v1/index/documents')
    assert.equal(JSON.parse(request.options.body).replace_scopes, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('RAG indexing does not resend an identical batch during one process lifetime', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response(JSON.stringify({ indexed: 1 }), { status: 200 })
  }
  const documents = [{
    text: '稳定空间锚点',
    metadata: { project_id: 91, episode_id: 1, asset_type: 'scene', asset_id: 'scene:1', asset_version: 1, source: 'dedupe-test' },
  }]

  try {
    const options = { env: { RAG_ENABLED: 'true', RAG_INDEX_ENABLED: 'true', RAG_SERVICE_URL: 'http://rag:8001', RAG_INTERNAL_TOKEN: 'token' } }
    await indexRagDocuments(documents, options)
    const second = await indexRagDocuments(documents, options)
    assert.equal(calls, 1)
    assert.equal(second.reason, 'already-indexed-in-process')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('RAG snapshot over the server limit is rejected instead of being silently truncated', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    throw new Error('must not call network')
  }
  const documents = Array.from({ length: 501 }, (_, index) => ({
    text: `memory-${index}`,
    metadata: { project_id: 1, episode_id: 1, asset_type: 'scene', asset_id: String(index), asset_version: 1, source: 'test' },
  }))

  try {
    const result = await indexRagDocuments(documents, {
      replaceScopes: true,
      env: { RAG_ENABLED: 'true', RAG_INDEX_ENABLED: 'true', RAG_SERVICE_URL: 'http://rag:8001', RAG_INTERNAL_TOKEN: 'token' },
    })
    assert.equal(result.errorCode, 'RAG_BATCH_TOO_LARGE')
    assert.equal(result.degraded, true)
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('RAG context is compact and carries only retrieved text', () => {
  assert.equal(
    formatRagRetrievedContext([
      { text: '林知夏在值班台前', score: 0.8, metadata: { source: 'scene' } },
      { text: '红色发卡位于窗口', score: 0.7, metadata: { source: 'prop' } },
    ]),
    '[scene] 林知夏在值班台前\n[prop] 红色发卡位于窗口',
  )
})
