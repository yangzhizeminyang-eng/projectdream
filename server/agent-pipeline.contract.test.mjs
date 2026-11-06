import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const serverSource = await readFile(new URL('./index.mjs', import.meta.url), 'utf8')

test('agent pipeline persists execution events and exposes an owner-scoped start endpoint', () => {
  assert.match(serverSource, /CREATE TABLE IF NOT EXISTS agent_pipeline_runs/)
  assert.match(serverSource, /CREATE TABLE IF NOT EXISTS agent_pipeline_events/)
  assert.match(serverSource, /const agentPipelineStartMatch = pathname\.match/)
  assert.match(serverSource, /agent-pipeline\\\/start/)
  assert.match(serverSource, /agent-parser-agent|asset-parser-agent/)
  assert.match(serverSource, /storyboard-agent/)
})

test('agent pipeline registers the remaining production agents and advances by stage', () => {
  for (const agentKey of [
    'character-agent',
    'scene-agent',
    'voice-agent',
    'video-agent',
    'quality-agent',
    'delivery-agent',
  ]) {
    assert.match(serverSource, new RegExp(`key: '${agentKey}'`))
  }
  assert.match(serverSource, /getNextAgentPipelineStageForKeys/)
  assert.match(serverSource, /当前阶段已确认|阶段动作登记/)
})

test('character lock accepts the adopted complete asset board used by the current asset workflow', () => {
  assert.match(serverSource, /view_set_type = 'character-asset-pack'/)
  assert.match(serverSource, /assetBoards: Number\(rows\[0\]\?\.asset_boards/)
  assert.match(serverSource, /角色资产板或三视图尚未全部确认/)
})

test('checkpoint approval persists the next stage before continuing it asynchronously', () => {
  assert.match(serverSource, /void executePipelineStage\(/)
  assert.match(serverSource, /Agent 已启动，状态将在后台更新/)
})

test('agent pipeline scopes scenes by episode without treating scene_no as the episode number', () => {
  assert.match(serverSource, /episode_no INT UNSIGNED NOT NULL DEFAULT 1/)
  assert.match(serverSource, /ALTER TABLE script_scenes ADD COLUMN episode_no INT UNSIGNED NOT NULL DEFAULT 1/)
  assert.match(serverSource, /uk_scenes_project_episode_no \(project_id, episode_no, scene_no\)/)
  assert.match(serverSource, /spec\.episode_no \|\| spec\.episodeNo \|\| context\.episodeNo/)
  assert.match(serverSource, /sourceSceneIds: sceneRows\.map\(\(scene\) => Number\(scene\.id\)\)/)
  assert.match(serverSource, /s\.episode_no = \?/)
  assert.doesNotMatch(serverSource, /WHERE s\.project_id = \? AND s\.scene_no = \?\s+AND s\.content/)
})

test('storyboard stage cannot return approval without persisted storyboard IDs', () => {
  assert.match(serverSource, /resolveStoryboardStageResult\(\{ episodeNo: context\.episodeNo, sceneCount \}\)/)
  assert.match(serverSource, /storyboardIds\.push\(\.\.\.existingRows\.map\(/)
  assert.match(serverSource, /resolveStoryboardStageResult\(\{ episodeNo: context\.episodeNo, sceneCount, shotCount, storyboardIds \}\)/)
})

test('voice stage reports only dialogue speakers with an effective locked voice binding', () => {
  assert.match(serverSource, /characterName: row\.character_name, dialogueText: row\.dialogue_text/)
  assert.match(serverSource, /getDialogueSpeakerNames\(\s*shotRows\.map\(/)
  assert.match(serverSource, /getDialogueSpeakerNames,/)
  assert.match(serverSource, /isCharacterVoiceReady\(characterByName\.get\(name\)\)/)
})
