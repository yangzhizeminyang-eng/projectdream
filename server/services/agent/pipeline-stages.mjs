export const AGENT_PIPELINE_STAGES = [
  { key: 'asset-parse', agentKey: 'asset-parser-agent', label: '资产解析' },
  { key: 'character-lock', agentKey: 'character-agent', label: '角色锁定' },
  { key: 'scene-lock', agentKey: 'scene-agent', label: '场景锁定' },
  { key: 'storyboard', agentKey: 'storyboard-agent', label: '分镜脚本' },
  { key: 'voice', agentKey: 'voice-agent', label: '音色绑定' },
  { key: 'video', agentKey: 'video-agent', label: '视频生成' },
  { key: 'quality', agentKey: 'quality-agent', label: '成片质检' },
  { key: 'delivery', agentKey: 'delivery-agent', label: '本地导出' },
]

export const SCRIPTING_PIPELINE_STAGE_KEYS = ['asset-parse', 'character-lock', 'scene-lock', 'storyboard']

export function getAgentPipelineStage(key) {
  return AGENT_PIPELINE_STAGES.find((stage) => stage.key === String(key || '').trim()) || null
}

export function getNextAgentPipelineStage(key) {
  const index = AGENT_PIPELINE_STAGES.findIndex((stage) => stage.key === String(key || '').trim())
  return index >= 0 ? AGENT_PIPELINE_STAGES[index + 1] || null : null
}

export function getNextAgentPipelineStageForKeys(key, stageKeys = AGENT_PIPELINE_STAGES.map((stage) => stage.key)) {
  const keys = Array.isArray(stageKeys) ? stageKeys : []
  const index = keys.indexOf(String(key || '').trim())
  return index >= 0 ? getAgentPipelineStage(keys[index + 1]) : null
}

export function isAgentPipelineStage(key) {
  return Boolean(getAgentPipelineStage(key))
}
