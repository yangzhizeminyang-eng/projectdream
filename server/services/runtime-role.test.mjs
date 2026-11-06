import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveAppRuntimeRole } from './runtime-role.mjs'

test('defaults to an API process that does not execute background jobs', () => {
  assert.deepEqual(resolveAppRuntimeRole({}), {
    role: 'api',
    runsHttpApi: true,
    runsBackgroundJobs: false,
    runsMigrations: true,
    requiresCaptchaSecret: false,
    queuePollIntervalMs: 15_000,
  })
})

test('enables queue execution only for an explicit worker process', () => {
  assert.deepEqual(
    resolveAppRuntimeRole({
      APP_RUNTIME_ROLE: 'worker',
      BACKGROUND_QUEUE_POLL_INTERVAL_MS: '30000',
    }),
    {
      role: 'worker',
      runsHttpApi: false,
      runsBackgroundJobs: true,
      runsMigrations: false,
      requiresCaptchaSecret: false,
      queuePollIntervalMs: 30_000,
    },
  )
})

test('rejects an unsafe unknown runtime role instead of running API and queues together', () => {
  assert.throws(
    () => resolveAppRuntimeRole({ APP_RUNTIME_ROLE: 'everything' }),
    /APP_RUNTIME_ROLE must be api or worker/i,
  )
})

test('requires a CAPTCHA secret for production API processes but not workers', () => {
  assert.equal(
    resolveAppRuntimeRole({ NODE_ENV: 'production' }).requiresCaptchaSecret,
    true,
  )
  assert.equal(
    resolveAppRuntimeRole({ NODE_ENV: 'production', APP_RUNTIME_ROLE: 'worker' })
      .requiresCaptchaSecret,
    false,
  )
  assert.equal(
    resolveAppRuntimeRole({ NODE_ENV: 'development' }).requiresCaptchaSecret,
    false,
  )
})
