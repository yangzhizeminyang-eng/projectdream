import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const studio = await readFile(new URL('./StoryboardVideoStudio.vue', import.meta.url), 'utf8')
const legacyVideo = await readFile(new URL('./VideoGenerate.vue', import.meta.url), 'utf8')
const workbench = await readFile(new URL('./EpisodeWorkbench.vue', import.meta.url), 'utf8')
const finalEdit = await readFile(new URL('./FinalEdit.vue', import.meta.url), 'utf8')
const exportView = await readFile(new URL('./Export.vue', import.meta.url), 'utf8')
const api = await readFile(new URL('../../api-service/app/main.py', import.meta.url), 'utf8')

test('active storyboard studio shows one current result and keeps recovery review out of candidate switching', () => {
  assert.match(studio, /const previewVideo = computed\(\(\) => pendingVideo\.value \|\| detail\.value\?\.currentVideo/)
  assert.match(studio, /pendingVideo/)
  assert.match(studio, /采用此视频/)
  assert.doesNotMatch(studio, /候选待复核/)
  assert.match(legacyVideo, /saveRecoveryVideoReview/)
  assert.match(legacyVideo, /确认最终版本/)
})

test('episode workbench queues a real per-episode render and exposes preview and download after completion', () => {
  assert.match(workbench, /createProjectExport\(projectId\.value,[\s\S]*episodeNo: episode\.episodeNo/)
  assert.match(workbench, /正在后台生成成片/)
  assert.match(workbench, /episodeExportUrl\(episodeExport\(episode\.episodeNo\)!\)/)
  assert.match(workbench, /play_circle[\s\S]*预览/)
  assert.match(workbench, /download[\s\S]*导出/)
  assert.doesNotMatch(workbench, /进入成片/)
  assert.doesNotMatch(finalEdit, /进入成片编辑模块/)
  assert.match(finalEdit, /getProjectFinalEdit\(projectId\.value, selectedEpisodeNo\.value\)/)
  assert.match(exportView, /getProjectExportPackage\(projectId\.value, episodeNo\.value\)/)
  assert.match(exportView, /episodeNo: episodeNo\.value/)
})

test('episode export stores its scope and requires every shot in that episode to have a confirmed video', () => {
  const exportHandlerStart = api.indexOf('async def create_project_export_route(')
  const exportHandlerEnd = api.indexOf('\n    @app.get("/api/projects/{project_id}/script-agent/activities")', exportHandlerStart)
  assert.ok(exportHandlerStart >= 0)
  assert.ok(exportHandlerEnd > exportHandlerStart)
  const handler = api.slice(exportHandlerStart, exportHandlerEnd)
  assert.match(handler, /episode_no = _parse_id_value\(body\.get\("episodeNo"\)\) or None/)
  assert.match(handler, /"episodeNo": episode_no/)
  assert.match(handler, /export_package\["missingShots"\] > 0/)
  assert.match(handler, /final_edit\["draft"\] = \{/)
})

test('episode workbench keeps the action group responsive and the Agent checkpoint readable', () => {
  assert.match(workbench, /grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 28rem\), 1fr\)\)/)
  assert.match(workbench, /\.episode-card__actions \{ display: flex; flex-wrap: wrap;/)
  assert.match(workbench, /\.episode-workbench__checkpoint-body \{ display: grid; grid-template-columns: 2\.8rem minmax\(0, 1fr\);/)
  assert.match(workbench, /\.episode-card\.is-delivery \.episode-card__meta,[\s\S]*display: none/)
  assert.match(workbench, /\.episode-delivery-row \{ display: grid; grid-template-columns: 5\.4rem minmax\(0, 1fr\)/)
})
