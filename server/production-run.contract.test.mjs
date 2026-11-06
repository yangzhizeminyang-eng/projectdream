import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const serverSource = await readFile(new URL('./index.mjs', import.meta.url), 'utf8')

test('production run schema persists stages, checkpoints, agent executions, and blueprints', () => {
  assert.match(serverSource, /CREATE TABLE IF NOT EXISTS production_runs/)
  assert.match(serverSource, /CREATE TABLE IF NOT EXISTS production_stage_runs/)
  assert.match(serverSource, /CREATE TABLE IF NOT EXISTS production_checkpoints/)
  assert.match(serverSource, /CREATE TABLE IF NOT EXISTS production_agent_executions/)
  assert.match(serverSource, /CREATE TABLE IF NOT EXISTS episode_blueprints/)
  assert.match(serverSource, /CREATE TABLE IF NOT EXISTS production_emotion_beats/)
})

test('production run creation reads the current story bible and season structure', () => {
  assert.match(serverSource, /const productionRunsMatch = pathname\.match/)
  assert.match(serverSource, /loadProductionStorySources\(projectId\)/)
  assert.match(serverSource, /loadProductionScriptSource\(projectId, input\.episodeNo\)/)
  assert.match(serverSource, /sourceScript:/)
  assert.match(serverSource, /buildEpisodeBlueprint\(/)
  assert.match(serverSource, /evaluateEpisodeBlueprint\(blueprint\)/)
  assert.match(serverSource, /buildProductionRunSeed\(/)
  assert.match(serverSource, /persistProductionBlueprint\(/)
})

test('production run creation persists the authenticated project owner', () => {
  assert.match(serverSource, /production_runs[\s\S]+project_id, user_id, episode_no/)
  assert.match(serverSource, /projectId, user\.id, input\.episodeNo, input\.platform/)
})

test('production run exposes owner-scoped blueprint editing and checkpoint decisions', () => {
  assert.match(serverSource, /const productionRunDetailMatch = pathname\.match/)
  assert.match(serverSource, /const productionBlueprintMatch = pathname\.match/)
  assert.match(serverSource, /const productionCheckpointMatch = pathname\.match/)
  assert.match(serverSource, /当前检查点不可审批，请先完成前置阶段/)
  assert.match(serverSource, /单集蓝图尚未通过质量门禁，不能审批进入生成/)
  assert.match(serverSource, /checkpoint-rejected/)
})

test('production run exposes a guarded completion endpoint for non-checkpoint stages', () => {
  assert.match(serverSource, /productionStageCompletionMatch/)
  assert.match(serverSource, /buildProductionStageCompletionTransition/)
  assert.match(serverSource, /当前阶段不可完成/)
  assert.match(serverSource, /stages.*complete/)
})
