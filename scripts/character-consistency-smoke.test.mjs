import assert from 'node:assert/strict'
import test from 'node:test'

import {
  summarizeCharacterConsistencyResponse,
  assertSmokeResponse,
  isMainModule,
} from './character-consistency-smoke.mjs'

test('smoke response assertion accepts a successful API envelope', () => {
  const response = assertSmokeResponse(
    { status: 200, body: { code: 0, data: { items: [] } } },
    '项目列表',
  )

  assert.deepEqual(response.data, { items: [] })
})

test('smoke response assertion reports HTTP and API failures', () => {
  assert.throws(
    () => assertSmokeResponse({ status: 401, body: { code: 4010, message: 'Unauthorized' } }, '未登录'),
    /未登录.*HTTP 401/,
  )
})

test('consistency summary exposes report and asset counts for audit output', () => {
  const summary = summarizeCharacterConsistencyResponse(
    7,
    {
      report: {
        ready: false,
        summary: {
          totalCharacters: 2,
          readyCharacters: 1,
          blockedCharacters: 1,
          regressionSamples: 3,
          staleSamples: 1,
        },
        blockers: [{ code: 'COSTUME_UNLOCKED' }],
        warnings: [{ code: 'PERSONALITY_MISSING' }],
      },
      characters: [{ id: 11 }, { id: 12 }],
      versions: [{ characterId: 11 }, { characterId: 12 }],
      samples: [{ id: 91 }, { id: 92 }, { id: 93 }],
    },
  )

  assert.deepEqual(summary, {
    projectId: 7,
    ready: false,
    totalCharacters: 2,
    readyCharacters: 1,
    blockedCharacters: 1,
    versionCount: 2,
    regressionSampleCount: 3,
    blockerCount: 1,
    warningCount: 1,
  })
})

test('main module detection supports Windows script paths', { skip: process.platform !== 'win32' }, () => {
  assert.equal(
    isMainModule(
      'file:///D:/projectdream/dreamweaver-studio/projectdream/scripts/character-consistency-smoke.mjs',
      'D:\\projectdream\\dreamweaver-studio\\projectdream\\scripts\\character-consistency-smoke.mjs',
    ),
    true,
  )
})
