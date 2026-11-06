import assert from 'node:assert/strict'
import test from 'node:test'

import { drainQueuedAgentPipelines, recoverInterruptedAgentPipelines } from './pipeline-queue.mjs'

test('pipeline queue executes only runs it atomically claims', async () => {
  const statements = []
  const db = {
    async execute(sql, params = []) {
      statements.push({ sql, params })
      if (sql.startsWith('SELECT id FROM agent_pipeline_runs')) return [[{ id: 7 }, { id: 8 }]]
      if (sql.startsWith('UPDATE agent_pipeline_runs')) {
        return [{ affectedRows: params[0] === 7 ? 1 : 0 }]
      }
      if (sql.startsWith('SELECT * FROM agent_pipeline_runs')) {
        return [[{ id: 7, status: 'running', current_stage: 'asset-parse' }]]
      }
      throw new Error(`unexpected query: ${sql}`)
    },
  }
  const executed = []

  const result = await drainQueuedAgentPipelines({
    db,
    execute: async (run) => executed.push(run.id),
  })

  assert.deepEqual(result, { claimed: 1, failed: 0 })
  assert.deepEqual(executed, [7])
  assert.equal(statements[1].params[0], 7)
  assert.match(statements[1].sql, /WHERE id = \? AND status = 'queued'/)
})

test('pipeline queue records an execution exception as retryable failure', async () => {
  const updates = []
  const db = {
    async execute(sql, params = []) {
      if (sql.startsWith('SELECT id FROM agent_pipeline_runs')) return [[{ id: 4 }]]
      if (sql.startsWith('UPDATE agent_pipeline_runs')) {
        updates.push({ sql, params })
        return [{ affectedRows: 1 }]
      }
      if (sql.startsWith('SELECT * FROM agent_pipeline_runs')) return [[{ id: 4 }]]
      throw new Error(`unexpected query: ${sql}`)
    },
  }

  const result = await drainQueuedAgentPipelines({
    db,
    execute: async () => { throw new Error('stage interrupted') },
  })

  assert.deepEqual(result, { claimed: 1, failed: 1 })
  assert.match(updates.at(-1).sql, /status = 'retryable_failed'/)
  assert.equal(updates.at(-1).params[0], 'stage interrupted')
})

test('worker restart marks interrupted pipeline execution visibly retryable', async () => {
  const statements = []
  const db = {
    async execute(sql) {
      statements.push(sql)
      return [{ affectedRows: 1 }]
    },
  }

  await recoverInterruptedAgentPipelines(db)

  assert.equal(statements.length, 2)
  assert.match(statements[0], /UPDATE agent_pipeline_executions[\s\S]+retryable_failed/)
  assert.match(statements[1], /UPDATE agent_pipeline_runs[\s\S]+retryable_failed[\s\S]+status = 'running'/)
})
