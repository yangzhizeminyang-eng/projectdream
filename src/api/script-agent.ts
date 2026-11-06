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

export type ScriptAgentStage = 'bible' | 'season' | 'script'
export type ScriptAgentSource = 'button' | 'chat' | 'system'
export type ScriptAgentStatus = 'running' | 'completed' | 'blocked' | 'failed'
export type ScriptAgentActivityPhase = 'start' | 'complete' | 'fail' | 'blocked'

export interface ScriptAgentNextActionDTO {
  key: string
  label: string
  actionKey?: string | null
  reason?: string
}

export interface ScriptAgentReactionDTO {
  agentKey: string
  tone: 'working' | 'success' | 'warning' | 'danger' | string
  headline: string
  message: string
  facts: string[]
  nextActions: ScriptAgentNextActionDTO[]
}

export interface ScriptAgentActivityDTO {
  id: number
  projectId: number
  userId: number
  stageKey: ScriptAgentStage
  actionKey: string
  agentKey: string
  source: ScriptAgentSource
  status: ScriptAgentStatus
  title: string
  summary: string
  context: Record<string, unknown>
  result: Record<string, unknown>
  reaction: ScriptAgentReactionDTO
  errorText: string
  idempotencyKey?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export function listScriptAgentActivities(projectId: number, limit = 40) {
  return request<{ items: ScriptAgentActivityDTO[] }>(
    `/projects/${projectId}/script-agent/activities?limit=${encodeURIComponent(String(limit))}`,
  ).then((result) => result.items)
}

export function startScriptAgentActivity(
  projectId: number,
  payload: {
    actionKey: string
    stageKey?: ScriptAgentStage
    source?: ScriptAgentSource
    summary?: string
    context?: Record<string, unknown>
    idempotencyKey?: string
  },
) {
  return request<{ item: ScriptAgentActivityDTO; reaction: ScriptAgentReactionDTO }>(
    `/projects/${projectId}/script-agent/activities`,
    {
      method: 'POST',
      body: JSON.stringify({ ...payload, phase: 'start' }),
    },
  )
}

export function finishScriptAgentActivity(
  projectId: number,
  activityId: number,
  payload: {
    phase: Exclude<ScriptAgentActivityPhase, 'start'>
    summary?: string
    context?: Record<string, unknown>
    result?: Record<string, unknown>
    errorText?: string
  },
) {
  return request<{ item: ScriptAgentActivityDTO; reaction: ScriptAgentReactionDTO }>(
    `/projects/${projectId}/script-agent/activities`,
    {
      method: 'POST',
      body: JSON.stringify({ ...payload, activityId }),
    },
  )
}
