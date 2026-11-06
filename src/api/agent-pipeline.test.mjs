import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./agent-pipeline.ts', import.meta.url), 'utf8')

test('agent pipeline API exposes start, list and checkpoint decision operations', () => {
  assert.match(source, /startAgentPipeline/)
  assert.match(source, /listAgentPipelines/)
  assert.match(source, /decideAgentPipelineStage/)
  assert.match(source, /agent-pipeline\/start/)
  assert.match(source, /stages\/\$\{encodeURIComponent\(stageKey\)\}\/decision/)
})

test('agent pipeline DTO keeps stage status, output snapshot and blockers visible', () => {
  assert.match(source, /status: AgentPipelineStatus/)
  assert.match(source, /outputSnapshot: Record<string, unknown>/)
  assert.match(source, /blockers: Array/)
  assert.match(source, /events: AgentPipelineEventDTO\[\]/)
})
