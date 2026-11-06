import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentRegistry } from './registry.mjs'

test('agent registry returns only explicitly registered adapters', () => {
  const registry = createAgentRegistry([
    {
      key: 'asset-parser-agent',
      label: '资产解析 Agent',
      async execute() {
        return { status: 'completed', outputSnapshot: { characters: 2 } }
      },
    },
  ])

  assert.equal(registry.get('asset-parser-agent').label, '资产解析 Agent')
  assert.equal(registry.get('storyboard-agent'), null)
  assert.deepEqual(registry.list().map((item) => item.key), ['asset-parser-agent'])
})

test('agent registry rejects duplicate keys and adapters without execute', () => {
  assert.throws(
    () => createAgentRegistry([{ key: 'asset-parser-agent', label: '缺少执行器' }]),
    /execute/,
  )

  const registry = createAgentRegistry()
  registry.register({
    key: 'storyboard-agent',
    label: '分镜 Agent',
    async execute() {
      return { status: 'completed' }
    },
  })
  assert.throws(
    () =>
      registry.register({
        key: 'storyboard-agent',
        label: '重复分镜 Agent',
        async execute() {
          return { status: 'completed' }
        },
      }),
    /已注册/,
  )
})
