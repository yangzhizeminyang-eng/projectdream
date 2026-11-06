import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAiRequestPayload,
  describeAiRequestError,
  parseJsonPayload,
  resolveAiRequestTimeoutMs,
} from './provider.mjs'

test('structured parser accepts JSON surrounded by model commentary', () => {
  assert.deepEqual(
    parseJsonPayload('Here is the payload:\n{"title":"demo","characters":[]}\nDone.'),
    { title: 'demo', characters: [] },
  )
})

test('structured parser accepts an array content part', () => {
  assert.deepEqual(parseJsonPayload('[{"scene_no":1,"location":"公寓客厅"}]'), [
    { scene_no: 1, location: '公寓客厅' },
  ])
})

test('structured parser skips malformed JSON examples before the payload', () => {
  assert.deepEqual(
    parseJsonPayload('格式示例：{not-json}\n实际结果：{"scenes":[{"location":"深夜公寓客厅"}]}'),
    { scenes: [{ location: '深夜公寓客厅' }] },
  )
})

test('structured requests can disable deep reasoning and cap output tokens', () => {
  const payload = buildAiRequestPayload(
    {
      model: 'deepseek-v4-flash',
      systemPrompt: 'system',
      userPrompt: 'user',
      maxTokens: 2048,
      thinking: { type: 'disabled' },
      responseFormat: { type: 'json_object' },
    },
    { defaultModel: 'fallback' },
  )

  assert.equal(payload.max_tokens, 2048)
  assert.deepEqual(payload.thinking, { type: 'disabled' })
  assert.deepEqual(payload.response_format, { type: 'json_object' })
})

test('story bible requests use the long task timeout', () => {
  assert.equal(
    resolveAiRequestTimeoutMs(
      {
        timeoutMs: 60_000,
        longTaskTimeoutMs: 180_000,
      },
      'story-bible',
    ),
    180_000,
  )
})

test('scene extraction opts into the configured long task timeout', () => {
  assert.equal(
    resolveAiRequestTimeoutMs(
      {
        timeoutMs: 60_000,
        longTaskTimeoutMs: 240_000,
      },
      'scene-extraction',
      true,
    ),
    240_000,
  )
})

test('character extraction uses the long task timeout for full-script parsing', () => {
  assert.equal(
    resolveAiRequestTimeoutMs(
      {
        timeoutMs: 60_000,
        longTaskTimeoutMs: 240_000,
      },
      'characters',
    ),
    240_000,
  )
})

test('timeout errors explain that the model took too long and can be retried', () => {
  const message = describeAiRequestError(
    new DOMException('The operation was aborted', 'TimeoutError'),
    'story-bible',
  )

  assert.match(message, /超时/)
  assert.match(message, /重试/)
})

test('upstream authentication and quota failures are actionable', () => {
  assert.match(
    describeAiRequestError(new Error('HTTP 401'), 'story-bible', 401),
    /接口密钥/,
  )
  assert.match(
    describeAiRequestError(new Error('Insufficient account balance'), 'story-bible', 402),
    /余额|额度/,
  )
})
