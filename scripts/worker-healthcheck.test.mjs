import test from 'node:test'
import assert from 'node:assert/strict'
import { runWorkerHealthCheck } from './worker-healthcheck.mjs'

function createFs({ cmdline = 'node\u0000server/index.mjs\u0000', failPidRead = false } = {}) {
  return {
    readdirSync: () => ['1', '23', 'self', 'net'],
    readFileSync(path) {
      if (failPidRead && path === '/proc/23/cmdline') throw new Error('process exited')
      if (path === '/proc/23/cmdline') return cmdline
      throw new Error(`unexpected path: ${path}`)
    },
  }
}

test('worker readiness requires the worker role and its application process', async () => {
  const mysql = { createConnection: async () => { throw new Error('must not connect') } }

  await assert.rejects(
    runWorkerHealthCheck({ env: { APP_RUNTIME_ROLE: 'api' }, fs: createFs(), mysql }),
    /APP_RUNTIME_ROLE must be worker/,
  )
  await assert.rejects(
    runWorkerHealthCheck({
      env: { APP_RUNTIME_ROLE: 'worker' },
      fs: createFs({ cmdline: 'node\u0000server/index.mjs\u0000', failPidRead: true }),
      mysql,
    }),
    /worker process is not running/,
  )
})

test('worker readiness requires a queue database connection and query', async () => {
  const calls = []
  const mysqlClient = {
    async createConnection(options) {
      calls.push(['connect', options.host, options.database])
      return {
        async query(sql) { calls.push(['query', sql]) },
        async end() { calls.push(['end']) },
      }
    },
  }
  const env = {
    APP_RUNTIME_ROLE: 'worker', DB_HOST: 'mysql', DB_PORT: '3306',
    DB_USER: 'worker', DB_PASSWORD: 'secret', DB_NAME: 'projectdream',
  }

  await assert.doesNotReject(runWorkerHealthCheck({ env, fs: createFs(), mysqlClient }))
  assert.deepEqual(calls.map(([kind]) => kind), ['connect', 'query', 'query', 'query', 'end'])
  assert.deepEqual(
    calls.filter(([kind]) => kind === 'query').map(([, sql]) => sql),
    [
      'SELECT 1 FROM generation_jobs LIMIT 0',
      'SELECT 1 FROM export_records LIMIT 0',
      'SELECT 1 FROM agent_pipeline_runs LIMIT 0',
    ],
  )
})

test('worker readiness always closes the database connection after a failed query', async () => {
  let closed = false
  const mysqlClient = {
    async createConnection() {
      return {
        async query() { throw new Error('table unavailable') },
        async end() { closed = true },
      }
    },
  }

  await assert.rejects(
    runWorkerHealthCheck({ env: { APP_RUNTIME_ROLE: 'worker' }, fs: createFs(), mysqlClient }),
    /database readiness check failed/,
  )
  assert.equal(closed, true)
})
