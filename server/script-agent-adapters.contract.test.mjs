import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./index.mjs', import.meta.url), 'utf8')

test('剧本三阶段必须注册到统一 Agent Registry', () => {
  for (const key of ['story-agent', 'season-agent', 'script-agent']) {
    assert.match(source, new RegExp(`key: '${key}'`), `${key} 必须注册`)
  }
})

test('剧本生成入口必须通过统一 Agent 执行器，而不是只写活动记录', () => {
  assert.match(source, /createAgentExecutor/)
  assert.match(source, /agentRegistry/)
  assert.match(source, /story-agent|season-agent|script-agent/)
  assert.match(source, /executePipelineStage/)
})

test('剧本 Agent 执行结果必须保留结构化输出和人工确认状态', () => {
  assert.match(source, /waiting_approval/)
  assert.match(source, /outputSnapshot/)
  assert.match(source, /script-agent-approval-required|story-agent-approval-required/)
})
