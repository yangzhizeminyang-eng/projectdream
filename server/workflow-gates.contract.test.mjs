import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const server = await readFile(new URL('./index.mjs', import.meta.url), 'utf8')
const router = await readFile(new URL('../src/router/index.ts', import.meta.url), 'utf8')
const projectStudio = await readFile(new URL('../src/views/ProjectStudio.vue', import.meta.url), 'utf8')
const scriptStudio = await readFile(new URL('../src/views/StudioScript.vue', import.meta.url), 'utf8')
const sideNav = await readFile(new URL('../src/components/SideNav.vue', import.meta.url), 'utf8')

test('workflow readiness is persisted and invalidated by a changed script fingerprint', () => {
  assert.match(server, /CREATE TABLE IF NOT EXISTS project_workflow_states/)
  assert.match(server, /persistParsedScriptFingerprint\(context\.projectId\)/)
  assert.match(server, /parse-complete/)
})

test('direct storyboard generation routes and pipeline agent enforce the project gate', () => {
  assert.match(server, /workflowGates\.storyboard\.allowed/)
  assert.match(server, /workflow-readiness/)
  assert.match(server, /async function executeStoryboardAgent\(context\)[\s\S]*?getProjectWorkflowReadiness/)
})

test('assets and storyboard deep links are checked by router and overview disables locked actions', () => {
  assert.match(router, /to\.name === 'asset-library' \|\| to\.name === 'asset-canvas'/)
  assert.match(router, /to\.name === 'episode-workbench' \|\| to\.name === 'storyboard-video-studio'/)
  assert.match(projectStudio, /getCreativeWorkflowGates/)
  assert.match(projectStudio, /:disabled="step\.disabled"/)
})

test('script save invalidates client readiness and sidebar readiness failures fail closed', () => {
  assert.match(scriptStudio, /scriptParseReady\.value = false\s+parseResult\.value = null/)
  assert.match(sideNav, /getCreativeWorkflowGates\(ctx\.projectId\)[\s\S]*?\.catch\(\(\) => \{[\s\S]*?gateCheckFailed: '1'/)
})
