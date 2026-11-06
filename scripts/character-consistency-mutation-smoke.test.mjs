import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertCrossUserDeniedResponse,
  assertStaleVideoGateResponse,
  buildOldFrameCharacterSnapshot,
} from './character-consistency-mutation-smoke.mjs'

test('cross-user access gate accepts only the resource-hiding denial response', () => {
  assert.doesNotThrow(() =>
    assertCrossUserDeniedResponse(
      {
        status: 404,
        body: {
          code: 4004,
          message: '角色不存在或无权访问',
        },
      },
      '越权读取角色',
    ),
  )

  assert.throws(
    () =>
      assertCrossUserDeniedResponse(
        {
          status: 403,
          body: { code: 4003, message: '权限不足' },
        },
        '越权读取角色',
      ),
    /HTTP 404/,
  )
})

test('stale video gate accepts only a 409 response that names the outdated version', () => {
  assert.doesNotThrow(() =>
    assertStaleVideoGateResponse({
      status: 409,
      body: {
        code: 4011,
        message: '角色“冒烟角色”使用了旧角色版本 v5，当前生产基线为 v6，请重新生成静帧',
      },
    }),
  )

  assert.throws(
    () => assertStaleVideoGateResponse({ status: 200, body: { code: 0 } }),
    /HTTP 409/,
  )
})

test('old frame snapshot freezes costume and active version for later stale detection', () => {
  const snapshot = buildOldFrameCharacterSnapshot({
    characterId: 7,
    versionNo: 3,
    name: '冒烟角色',
    appearance: '黑色短发',
    costume: '深灰制服',
    referenceImageUrl: 'https://example.com/reference.png',
  })

  assert.equal(snapshot.characters[0].characterVersionNo, 3)
  assert.equal(snapshot.characters[0].costume, '深灰制服')
  assert.equal(snapshot.characters[0].isPrimary, true)
})
