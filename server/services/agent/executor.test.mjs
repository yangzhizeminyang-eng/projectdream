import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentExecutor, executeAgentPipeline } from './executor.mjs'
import { createAgentRegistry } from './registry.mjs'

function createMemoryStore() {
  const executions = []
  const events = []
  return {
    executions,
    events,
    async findByIdempotencyKey(key) {
      return executions.find((item) => item.idempotencyKey === key) || null
    },
    async createExecution(input) {
      const item = { id: executions.length + 1, ...input }
      executions.push(item)
      return item
    },
    async updateExecution(id, patch) {
      const item = executions.find((entry) => entry.id === id)
      Object.assign(item, patch)
      return item
    },
    async appendEvent(event) {
      events.push(event)
      return event
    },
  }
}

test('executor is idempotent and records queued, running, completed events', async () => {
  let calls = 0
  const registry = createAgentRegistry([
    {
      key: 'asset-parser-agent',
      label: '资产解析 Agent',
      async execute(context) {
        calls += 1
        return { status: 'completed', outputSnapshot: { source: context.stageKey } }
      },
    },
  ])
  const store = createMemoryStore()
  const executor = createAgentExecutor({ registry, store })
  const context = {
    projectId: 45,
    episodeNo: 1,
    stageKey: 'asset-parse',
    agentKey: 'asset-parser-agent',
    idempotencyKey: 'pipeline-45-1:asset-parse',
    inputSnapshot: { scriptVersion: 2 },
  }

  const first = await executor.execute(context)
  const second = await executor.execute(context)

  assert.equal(calls, 1)
  assert.equal(first.status, 'completed')
  assert.equal(second.id, first.id)
  assert.deepEqual(store.events.map((item) => item.status), ['queued', 'running', 'completed'])
})

test('pipeline passes previous agent output forward and stops on blocked stage', async () => {
  const received = []
  const registry = createAgentRegistry([
    {
      key: 'asset-parser-agent',
      label: '资产解析 Agent',
      async execute() {
        return { status: 'completed', outputSnapshot: { assetVersion: 3 } }
      },
    },
    {
      key: 'storyboard-agent',
      label: '分镜 Agent',
      async execute(context) {
        received.push(context.previousOutputs)
        return {
          status: 'blocked',
          blockers: [{ code: 'asset-approval-required', message: '需要确认资产版本' }],
        }
      },
    },
  ])
  const store = createMemoryStore()
  const executor = createAgentExecutor({ registry, store })
  const result = await executeAgentPipeline({
    executor,
    baseContext: {
      projectId: 45,
      episodeNo: 1,
      pipelineId: 'pipeline-45-1',
      inputSnapshot: { scriptVersion: 2 },
    },
    stages: [
      { stageKey: 'asset-parse', agentKey: 'asset-parser-agent' },
      { stageKey: 'storyboard', agentKey: 'storyboard-agent' },
    ],
  })

  assert.equal(result.status, 'blocked')
  assert.equal(result.completedStages.length, 1)
  assert.equal(result.blockedStage.stageKey, 'storyboard')
  assert.deepEqual(received, [{ 'asset-parse': { assetVersion: 3 } }])
  assert.equal(store.executions.length, 2)
})

test('executor turns unknown agents into a durable blocked result', async () => {
  const store = createMemoryStore()
  const executor = createAgentExecutor({
    registry: createAgentRegistry(),
    store,
  })

  const result = await executor.execute({
    projectId: 45,
    episodeNo: 1,
    stageKey: 'storyboard',
    agentKey: 'unknown-agent',
    idempotencyKey: 'unknown-1',
    inputSnapshot: {},
  })

  assert.equal(result.status, 'blocked')
  assert.match(result.blockers[0].message, /未注册/)
  assert.deepEqual(store.events.map((item) => item.status), ['queued', 'blocked'])
})
