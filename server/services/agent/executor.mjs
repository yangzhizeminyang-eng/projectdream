const RESULT_STATUSES = new Set([
  'completed',
  'waiting_approval',
  'blocked',
  'retryable_failed',
  'failed',
  'canceled',
])

function normalizeResult(result = {}) {
  const status = String(result.status || 'completed').trim()
  if (!RESULT_STATUSES.has(status)) {
    throw new Error(`Agent 返回了无效状态：${status}`)
  }
  return {
    status,
    outputSnapshot: result.outputSnapshot && typeof result.outputSnapshot === 'object'
      ? result.outputSnapshot
      : {},
    blockers: Array.isArray(result.blockers) ? result.blockers : [],
    errorText: String(result.errorText || '').trim(),
    usage: result.usage && typeof result.usage === 'object' ? result.usage : null,
  }
}

function eventPayload(context, status, extra = {}) {
  return {
    projectId: context.projectId,
    episodeNo: context.episodeNo,
    pipelineId: context.pipelineId || null,
    pipelineRunId: context.pipelineRunId || null,
    stageKey: context.stageKey,
    agentKey: context.agentKey,
    attempt: Number(context.attempt || 1),
    idempotencyKey: context.idempotencyKey,
    status,
    ...extra,
  }
}

export function createAgentExecutor({ registry, store }) {
  if (!registry || typeof registry.get !== 'function') {
    throw new Error('Agent executor 需要 registry')
  }
  if (!store || typeof store.findByIdempotencyKey !== 'function') {
    throw new Error('Agent executor 需要持久化 store')
  }

  return {
    async execute(context = {}) {
      const idempotencyKey = String(context.idempotencyKey || '').trim()
      if (!idempotencyKey) throw new Error('Agent 执行必须提供幂等键')

      const existing = await store.findByIdempotencyKey(idempotencyKey)
      if (existing && ['completed', 'waiting_approval', 'blocked', 'failed', 'canceled'].includes(existing.status)) {
        return existing
      }
      if (existing && ['queued', 'running'].includes(existing.status)) {
        return existing
      }

      const execution = await store.createExecution({
        ...context,
        idempotencyKey,
        attempt: Number(context.attempt || 1),
        status: 'queued',
        outputSnapshot: {},
        blockers: [],
        errorText: '',
      })
      await store.appendEvent(eventPayload(context, 'queued', { executionId: execution.id }))

      const adapter = registry.get(context.agentKey)
      if (!adapter) {
        const blocked = {
          ...execution,
          status: 'blocked',
          blockers: [{ code: 'agent-not-registered', message: `Agent ${context.agentKey} 未注册，执行已阻塞` }],
        }
        await store.updateExecution(execution.id, blocked)
        await store.appendEvent(eventPayload(context, 'blocked', {
          executionId: execution.id,
          blockers: blocked.blockers,
        }))
        return blocked
      }

      await store.updateExecution(execution.id, { status: 'running', startedAt: new Date().toISOString() })
      await store.appendEvent(eventPayload(context, 'running', { executionId: execution.id }))

      try {
        const result = normalizeResult(await adapter.execute({
          ...context,
          executionId: execution.id,
          attempt: Number(context.attempt || 1),
        }))
        const completed = {
          ...execution,
          ...result,
          status: result.status,
          finishedAt: new Date().toISOString(),
        }
        await store.updateExecution(execution.id, completed)
        await store.appendEvent(eventPayload(context, result.status, {
          executionId: execution.id,
          outputSnapshot: result.outputSnapshot,
          blockers: result.blockers,
          errorText: result.errorText,
        }))
        return completed
      } catch (error) {
        const failed = {
          ...execution,
          status: 'retryable_failed',
          errorText: error instanceof Error ? error.message : 'Agent 执行失败',
          finishedAt: new Date().toISOString(),
        }
        await store.updateExecution(execution.id, failed)
        await store.appendEvent(eventPayload(context, 'retryable_failed', {
          executionId: execution.id,
          errorText: failed.errorText,
        }))
        return failed
      }
    },
  }
}

export async function executeAgentPipeline({ executor, baseContext = {}, stages = [] }) {
  const completedStages = []
  const previousOutputs = {}
  let blockedStage = null

  for (const stage of stages) {
    const context = {
      ...baseContext,
      stageKey: stage.stageKey,
      agentKey: stage.agentKey,
      idempotencyKey: `${baseContext.pipelineId || baseContext.projectId}:${stage.stageKey}`,
      previousOutputs: { ...previousOutputs },
    }
    const result = await executor.execute(context)
    if (result.status === 'completed') {
      completedStages.push({ stageKey: stage.stageKey, executionId: result.id, outputSnapshot: result.outputSnapshot || {} })
      previousOutputs[stage.stageKey] = result.outputSnapshot || {}
      continue
    }
    blockedStage = {
      stageKey: stage.stageKey,
      executionId: result.id,
      status: result.status,
      blockers: result.blockers || [],
      errorText: result.errorText || '',
      outputSnapshot: result.outputSnapshot || {},
    }
    if (result.outputSnapshot && Object.keys(result.outputSnapshot).length) {
      previousOutputs[stage.stageKey] = result.outputSnapshot
    }
    break
  }

  return {
    status: blockedStage ? blockedStage.status : 'completed',
    completedStages,
    blockedStage,
    outputs: previousOutputs,
  }
}
