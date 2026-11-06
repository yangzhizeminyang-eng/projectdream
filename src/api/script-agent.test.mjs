import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./script-agent.ts', import.meta.url), 'utf8')

test('script agent API exposes persisted activity list and lifecycle writes', () => {
  assert.match(source, /listScriptAgentActivities/)
  assert.match(source, /startScriptAgentActivity/)
  assert.match(source, /finishScriptAgentActivity/)
  assert.match(source, /script-agent\/activities/)
  assert.match(source, /phase: 'start'/)
})

test('script agent activity carries stage, source, result and reaction types', () => {
  assert.match(source, /stageKey: ScriptAgentStage/)
  assert.match(source, /source: ScriptAgentSource/)
  assert.match(source, /result: Record<string, unknown>/)
  assert.match(source, /reaction: ScriptAgentReactionDTO/)
})
