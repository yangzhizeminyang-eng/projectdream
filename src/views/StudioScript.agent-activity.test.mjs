import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { canReuseCurrentScriptAssets } from '../lib/script-parse-fallback.mjs'

const source = await readFile(new URL('./StudioScript.vue', import.meta.url), 'utf8')

test('script page persists agent activities around real domain actions', () => {
  assert.match(source, /runScriptAgentAction/)
  assert.match(source, /startScriptAgentActivity/)
  assert.match(source, /finishScriptAgentActivity/)
  assert.match(source, /generate-bible/)
  assert.match(source, /generate-season/)
  assert.match(source, /generate-script/)
  assert.match(source, /parse-assets/)
})

test('script parsing can reuse complete existing assets when character extraction fails', () => {
  assert.match(source, /canReuseCurrentScriptAssets/)
  assert.match(source, /listCharacters\(projectId\.value\)/)
  assert.match(source, /confirmProjectScriptParsed\(projectId\.value\)/)
})

test('existing character and scene nodes are reused only when every reference is present', () => {
  const characters = [{ id: 38 }, { id: 39 }]
  const scenes = [{ id: 51 }]
  const nodes = [
    { nodeType: 'character', refId: 38, groupKey: 'character:38:current' },
    { nodeType: 'character', refId: 39, groupKey: 'character:39:current' },
    { nodeType: 'scene', refId: 51, groupKey: 'scene:51:default' },
  ]

  assert.equal(canReuseCurrentScriptAssets({ characters, scenes, nodes }), true)
  assert.equal(canReuseCurrentScriptAssets({
    characters,
    scenes,
    nodes: nodes.filter((node) => node.refId !== 39),
  }), false)
  assert.equal(canReuseCurrentScriptAssets({
    characters,
    scenes,
    nodes: nodes.filter((node) => node.nodeType !== 'scene'),
  }), false)
})

test('right dock renders execution status and actionable next steps', () => {
  assert.match(source, /agent-activity-feed/)
  assert.match(source, /activity\.reaction\.headline/)
  assert.match(source, /activity\.reaction\.nextActions/)
  assert.match(source, /runAgentNextAction/)
  assert.match(source, /agentActivityError/)
})

test('right dock is framed as an execution trace rather than a chat-only panel', () => {
  assert.match(source, /实时编排 Agent/)
  assert.match(source, /执行轨迹/)
  assert.match(source, /不是普通聊天记录/)
  assert.match(source, /agent-activity-enter-active/)
})

test('running activity cards use the shared animated spinner and deduplicate repeated runs', () => {
  assert.match(source, /dedupeRunningActivities/)
  assert.match(source, /activity\.status === 'running'.*studio-spinner/)
  assert.match(source, /class="studio-spinner"/)
  assert.match(source, /@keyframes studio-spinner-spin/)
})
