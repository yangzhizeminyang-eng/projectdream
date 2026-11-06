import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_PIPELINE_STAGES,
  SCRIPTING_PIPELINE_STAGE_KEYS,
  getAgentPipelineStage,
  getNextAgentPipelineStage,
  getNextAgentPipelineStageForKeys,
} from './pipeline-stages.mjs'

test('pipeline includes the remaining production agents in order', () => {
  assert.deepEqual(
    AGENT_PIPELINE_STAGES.map((stage) => stage.key),
    ['asset-parse', 'character-lock', 'scene-lock', 'storyboard', 'voice', 'video', 'quality', 'delivery'],
  )
  assert.equal(getAgentPipelineStage('video').agentKey, 'video-agent')
  assert.equal(getNextAgentPipelineStage('quality').key, 'delivery')
})

test('unknown pipeline stages are rejected by lookup', () => {
  assert.equal(getAgentPipelineStage('unknown'), null)
  assert.equal(getNextAgentPipelineStage('unknown'), null)
})

test('scripting approvals stop after storyboard instead of entering production execution', () => {
  assert.equal(getNextAgentPipelineStageForKeys('asset-parse', SCRIPTING_PIPELINE_STAGE_KEYS)?.key, 'character-lock')
  assert.equal(getNextAgentPipelineStageForKeys('scene-lock', SCRIPTING_PIPELINE_STAGE_KEYS)?.key, 'storyboard')
  assert.equal(getNextAgentPipelineStageForKeys('storyboard', SCRIPTING_PIPELINE_STAGE_KEYS), null)
})
