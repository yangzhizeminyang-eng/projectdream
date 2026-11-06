import { PRODUCTION_RUN_STAGES } from './production-run.mjs'

function text(value) {
  return String(value ?? '').trim()
}

export function buildProductionStageCompletionTransition({
  run = {},
  stages = [],
  checkpoints = [],
  completedStageKey,
  outputSnapshot = null,
} = {}) {
  const currentStageKey = text(run.currentStage)
  const completedKey = text(completedStageKey)

  if (!completedKey || completedKey !== currentStageKey) {
    throw new Error('只能完成当前阶段')
  }
  if (text(run.currentCheckpoint)) {
    throw new Error('当前阶段存在待审批检查点，不能直接完成')
  }

  const stageIndex = PRODUCTION_RUN_STAGES.findIndex((stage) => stage.key === completedKey)
  if (stageIndex < 0) throw new Error(`未知生产阶段：${completedKey}`)

  const currentStage = stages.find((stage) => text(stage.stageKey) === completedKey)
  if (!currentStage) throw new Error(`生产阶段记录不存在：${completedKey}`)
  if (!['ready', 'running'].includes(text(currentStage.status))) {
    throw new Error(`当前阶段状态不可完成：${currentStage.status}`)
  }

  const nextStage = PRODUCTION_RUN_STAGES[stageIndex + 1] || null
  const stageUpdates = [
    {
      stageKey: completedKey,
      status: 'completed',
      outputSnapshot,
    },
  ]
  const checkpointUpdates = []

  if (!nextStage) {
    return {
      run: {
        status: 'completed',
        currentStage: completedKey,
        currentCheckpoint: null,
      },
      stageUpdates,
      checkpointUpdates,
    }
  }

  const nextStageRecord = stages.find((stage) => text(stage.stageKey) === nextStage.key)
  if (!nextStageRecord) throw new Error(`生产阶段记录不存在：${nextStage.key}`)

  const nextCheckpoint = nextStage.checkpointKey
    ? checkpoints.find((checkpoint) => text(checkpoint.checkpointKey) === nextStage.checkpointKey)
    : null
  if (nextStage.checkpointKey && !nextCheckpoint) {
    throw new Error(`生产检查点记录不存在：${nextStage.checkpointKey}`)
  }

  const nextStatus = nextCheckpoint ? 'waiting_approval' : 'ready'
  stageUpdates.push({
    stageKey: nextStage.key,
    status: nextStatus,
    outputSnapshot: null,
  })
  if (nextCheckpoint) {
    checkpointUpdates.push({
      checkpointKey: nextCheckpoint.checkpointKey,
      status: 'pending',
    })
  }

  return {
    run: {
      status: nextCheckpoint ? 'waiting_approval' : 'running',
      currentStage: nextStage.key,
      currentCheckpoint: nextCheckpoint?.checkpointKey || null,
    },
    stageUpdates,
    checkpointUpdates,
  }
}
