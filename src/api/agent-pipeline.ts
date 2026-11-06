import { getAuthToken } from './auth'

const API_BASE_URL = `${import.meta.env.VITE_API_BASE_URL || '/api'}`.replace(/\/$/, '')

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}),
      ...(init?.headers || {}),
    },
  })
  const payload = (await response.json().catch(() => null)) as
    | { code?: number; message?: string; data?: T }
    | null
  if (!response.ok || !payload || payload.code !== 0) {
    if (response.status === 401 || payload?.code === 4010) {
      throw new Error('登录状态已过期，请重新登录')
    }
    throw new Error(payload?.message || `请求失败（${response.status}）`)
  }
  return payload.data as T
}

export type AgentPipelineStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'paused'
  | 'retryable_failed'
  | 'failed'
  | 'blocked'
  | string

export interface AgentPipelineExecutionDTO {
  id: number
  pipelineRunId: number
  stageKey: string
  agentKey: string
  status: AgentPipelineStatus
  attempt: number
  idempotencyKey: string
  inputSnapshot: Record<string, unknown>
  outputSnapshot: Record<string, unknown>
  blockers: Array<{ code?: string; message?: string }>
  errorText: string
  startedAt?: string | null
  finishedAt?: string | null
}

export interface AgentPipelineEventDTO {
  id: number
  pipelineRunId: number
  executionId?: number | null
  stageKey: string
  agentKey: string
  attempt: number
  status: string
  payload: Record<string, unknown>
  createdAt?: string | null
}

export interface AgentPipelineRunDTO {
  id: number
  projectId: number
  userId: number
  episodeNo: number
  status: AgentPipelineStatus
  currentStage: string
  inputSnapshot: Record<string, unknown>
  outputSnapshot?: Record<string, unknown> | null
  errorText: string
  idempotencyKey: string
  createdAt?: string | null
  updatedAt?: string | null
}

export interface AgentPipelineStageDTO {
  key: string
  agentKey: string
  label: string
}

export interface AgentPipelineViewDTO {
  run: AgentPipelineRunDTO
  executions: AgentPipelineExecutionDTO[]
  events: AgentPipelineEventDTO[]
  stages?: AgentPipelineStageDTO[]
}

export function startAgentPipeline(
  projectId: number,
  payload: { episodeNo: number; regenerate?: boolean; idempotencyKey: string },
) {
  return request<AgentPipelineViewDTO>(`/projects/${projectId}/agent-pipeline/start`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function listAgentPipelines(projectId: number) {
  return request<{ items: AgentPipelineViewDTO[] }>(`/projects/${projectId}/agent-pipeline`)
}

export function decideAgentPipelineStage(
  runId: number,
  stageKey: string,
  decision: 'approve' | 'reject',
  note = '',
) {
  return request<AgentPipelineViewDTO>(
    `/agent-pipelines/${runId}/stages/${encodeURIComponent(stageKey)}/decision`,
    {
      method: 'POST',
      body: JSON.stringify({ decision, note }),
    },
  )
}

export function registerAgentPipelineStageAction(
  runId: number,
  payload: {
    stageKey: string
    idempotencyKey: string
    status?: AgentPipelineStatus
    inputSnapshot?: Record<string, unknown>
    outputSnapshot?: Record<string, unknown>
    blockers?: Array<{ code?: string; message?: string }>
    errorText?: string
  },
) {
  return request<AgentPipelineViewDTO>(`/agent-pipelines/${runId}/stage-actions`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
