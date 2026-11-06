import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./EpisodeWorkbench.vue', import.meta.url), 'utf8')

test('episode workbench starts the real Agent Pipeline instead of calling storyboard generation directly', () => {
  assert.match(source, /startAgentPipeline/)
  assert.match(source, /decideAgentPipelineStage/)
  assert.doesNotMatch(source, /Promise\.all\(targetScenes\.map\(\(scene\) => generateStoryboards/)
})

test('episode workbench exposes an explicit asset checkpoint before storyboard creation', () => {
  assert.match(source, /资产解析完成，等待人工确认/)
  assert.match(source, /确认\$\{pipelineStageLabel\(pipelineRun\.run\.currentStage\)\}并继续/)
  assert.match(source, /pipelineRun\.run\.currentStage === 'asset-parse'/)
  assert.match(source, /<dialog[^>]*episode-workbench__checkpoint/)
  assert.match(source, /dialog\.showModal\(\)/)
  assert.match(source, /dismissedCheckpointKey\.value = approvedCheckpointKey/)
  assert.doesNotMatch(source, /<section v-if="pipelineRun && pipelineRun\.run\.status === 'waiting_approval'"/)
})

test('episode workbench carries the active pipeline run into the guarded storyboard navigation', () => {
  assert.match(source, /function openStudio\(episodeNo: number, runId = pipelineRun\.value\?\.run\.id\)/)
  assert.match(source, /pipelineRunId: String\(runId\)/)
  assert.match(source, /openStudioWhenStoryboardExists\(episodeNo, run\.run\.id\)/)
})

test('storyboard approval opens studio before the generic waiting checkpoint', () => {
  const generateEpisodeStart = source.indexOf('async function generateEpisode(')
  const generateEpisodeEnd = source.indexOf('\n}\n\nasync function approvePipelineStage', generateEpisodeStart)
  assert.ok(generateEpisodeStart >= 0)
  assert.ok(generateEpisodeEnd > generateEpisodeStart)
  const generateEpisodeSource = source.slice(generateEpisodeStart, generateEpisodeEnd)
  const storyboardBranch = generateEpisodeSource.indexOf("run.run.status === 'waiting_approval' && run.run.currentStage === 'storyboard'")
  const genericWaitingBranch = generateEpisodeSource.indexOf("} else if (run.run.status === 'waiting_approval')")
  assert.ok(storyboardBranch >= 0)
  assert.ok(genericWaitingBranch >= 0)
  assert.ok(storyboardBranch < genericWaitingBranch)
})

test('workbench verifies persisted episode shot count before opening storyboard studio', () => {
  assert.match(source, /async function openStudioWhenStoryboardExists\(/)
  assert.match(source, /loadEpisodeProductionCards\(projectId\.value\)/)
  assert.match(source, /if \(!episode\?\.shotCount\)/)
  assert.match(source, /await openStudioWhenStoryboardExists\(episodeNo, run\.run\.id\)/)
  assert.match(source, /数据库中没有已保存的分镜/)
})

test('every active work state uses the dedicated CSS spinner', () => {
  assert.match(source, /<div v-if="loading"[\s\S]*?<span class="episode-spinner"/)
  assert.match(source, /v-if="generatingEpisode === episode\.episodeNo \|\| pipelineActive"[\s\S]*?class="episode-spinner"/)
  assert.match(source, /<span v-if="pipelineBusy" class="episode-spinner"/)
  assert.match(source, /@keyframes episode-spinner-spin/)
  assert.match(source, /animation: episode-spinner-spin/)
  assert.doesNotMatch(source, /progress_activity/)
})

test('workbench refreshes an asynchronously advanced pipeline instead of leaving the page in a stale state', () => {
  assert.match(source, /const pipelineActive = computed/)
  assert.match(source, /async function refreshPipelineRun/)
  assert.match(source, /window\.setInterval\(\(\) => void refreshPipelineRun\(\), 1200\)/)
  assert.match(source, /onUnmounted/)
})

test('workbench ignores stale checkpoints when a newer pipeline run is already complete', () => {
  assert.match(source, /function selectLatestActivePipeline\(items: AgentPipelineViewDTO\[\]\)/)
  assert.match(source, /sort\(\(left, right\) => right\.run\.id - left\.run\.id\)/)
  assert.match(source, /pipelineRun\.value = selectLatestActivePipeline\(pipelines\.items\)/)
})

test('episode cards expose production flow, progress evidence, and a next action', () => {
  assert.match(source, /aria-label="制作阶段"/)
  assert.match(source, /:aria-current="!allEpisodesReady \? 'step' : undefined"/)
  assert.match(source, /function episodeProgressPercent\(episode: EpisodeProductionCard\)/)
  assert.match(source, /本集完成度 \$\{episodeProgressPercent\(episode\)\}%/)
  assert.match(source, /下一步：\{\{ episodeNextAction\[episode\.status\] \}\}/)
  assert.match(source, /episode-card__progress-track/)
})

test('episode storyboard actions stay compact and wrap only when the card is narrow', () => {
  assert.match(source, /\.episode-card__actions \{ display: flex; flex-wrap: wrap;/)
  assert.doesNotMatch(source, /\.episode-card__actions \.episode-card__primary \{ grid-column: 1 \/ -1; \}/)
  assert.match(source, /\.episode-card__actions \.episode-card__primary \{ grid-column: auto; \}/)
})

test('episode workbench replaces storyboard actions with an episode render after all videos are confirmed', () => {
  assert.match(source, /:class="\{ 'is-current': allEpisodesReady \}"[\s\S]*?04<\/span>成片与导出/)
  assert.match(source, /createProjectExport\(projectId\.value,\s*\{[\s\S]*episodeNo: episode\.episodeNo/)
  assert.match(source, /status === 'ready'[\s\S]*?生成成片/)
  assert.match(source, /v-else-if="episodeExport\(episode\.episodeNo\)\?\.status === 'completed'"/)
  assert.match(source, /play_circle[\s\S]*?预览/)
  assert.match(source, /download[\s\S]*?导出/)
  assert.match(source, /<video[\s\S]*:src="episodeExportUrl\(episodeExport\(episode\.episodeNo\)!\)"/)
  assert.doesNotMatch(source, /进入成片/)
  assert.match(source, /episode-delivery-row/)
})

test('episode workbench preserves keyboard focus and reduced-motion states', () => {
  assert.match(source, /button:focus-visible\s*\{\s*outline: 2px solid/)
  assert.match(source, /episode-card__progress-track span \{[\s\S]*transition:/)
  assert.match(source, /prefers-reduced-motion: reduce[\s\S]*episode-card__progress-track span \{ transition: none; \}/)
})
