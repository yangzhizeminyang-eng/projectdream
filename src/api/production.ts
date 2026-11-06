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

export type ProductionRunStatus =
  | 'created'
  | 'planning'
  | 'waiting_approval'
  | 'running'
  | 'paused'
  | 'failed'
  | 'completed'
  | 'canceled'
  | string

export interface ProductionRunDTO {
  id: number
  projectId: number
  projectName?: string | null
  episodeNo: number
  platform: string
  name: string
  status: ProductionRunStatus
  currentStage: string
  currentCheckpoint?: string | null
  pilotMode: string
  pilotSceneCount: number
  budget?: number | null
  candidatePolicy: {
    keyShotVideoCandidates: number
    normalShotVideoCandidates: number
    imageCandidates: number
    audioCandidates: number
    maxCandidateCostMultiplier: number
  }
  successMetrics: string[]
  inputSnapshot: Record<string, unknown>
  outputSnapshot?: Record<string, unknown> | null
  failureCode?: string | null
  failureText?: string | null
  createdAt: string
  updatedAt: string
}

export interface ProductionStageDTO {
  id: number
  stageKey: string
  sequenceNo: number
  agentKey: string
  status: string
  inputSnapshot?: Record<string, unknown> | null
  outputSnapshot?: Record<string, unknown> | null
  errorText?: string | null
  startedAt?: string | null
  finishedAt?: string | null
}

export interface ProductionCheckpointDTO {
  id: number
  checkpointKey: string
  stageKey: string
  status: string
  decisionNote?: string | null
  reviewedAt?: string | null
}

export interface EmotionBeatDTO {
  id: number
  beatKey: string
  phase: string
  label: string
  sequenceNo: number
  durationSeconds: number
  emotionStart: string
  emotionProcess: string
  emotionEnd: string
  actionStart: string
  actionProcess: string
  actionEnd: string
  dialoguePlan: string
  soundPlan: string
  continuity: string
  sceneNo?: number | null
  shotCount: number
  status: string
}

export interface EpisodeBlueprintDTO {
  id: number
  productionRunId: number
  projectId: number
  episodeNo: number
  versionNo: number
  status: string
  blueprint: Record<string, any>
  qualityReport?: {
    canApprove?: boolean
    blockers?: Array<{ code: string; message: string }>
    warnings?: Array<{ code: string; message: string }>
    summary?: Record<string, number | null>
  } | null
  emotionBeats?: EmotionBeatDTO[]
  approvedAt?: string | null
}

export interface ProductionRunViewDTO {
  run: ProductionRunDTO
  stages: ProductionStageDTO[]
  checkpoints: ProductionCheckpointDTO[]
  agentExecutions: Array<{
    id: number
    agentKey: string
    status: string
    modelName?: string | null
    output?: Record<string, unknown> | null
  }>
  blueprint?: EpisodeBlueprintDTO | null
}

export function listProductionRuns(projectId: number) {
  return request<{ items: ProductionRunDTO[] }>(`/projects/${projectId}/production-runs`)
}

export function createProductionRun(
  projectId: number,
  payload: {
    platform: '抖音'
    episodeNo: number
    budget?: number | null
    pilotSceneCount: 2
    pilotMode: 'two-scenes-golden-sample'
    candidatePolicy: ProductionRunDTO['candidatePolicy']
    successMetrics: string[]
    idempotencyKey?: string
  },
) {
  return request<ProductionRunViewDTO>(`/projects/${projectId}/production-runs`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getProductionRun(runId: number) {
  return request<ProductionRunViewDTO>(`/production-runs/${runId}`)
}

export function saveProductionBlueprint(runId: number, blueprint: Record<string, unknown>) {
  return request<{ blueprint: EpisodeBlueprintDTO | null; report: EpisodeBlueprintDTO['qualityReport'] }>(
    `/production-runs/${runId}/blueprint`,
    {
      method: 'PUT',
      body: JSON.stringify({ blueprint }),
    },
  )
}

export function decideProductionCheckpoint(
  runId: number,
  checkpointKey: string,
  decision: 'approve' | 'reject',
  note: string,
) {
  return request<ProductionRunViewDTO>(
    `/production-runs/${runId}/checkpoints/${encodeURIComponent(checkpointKey)}/decision`,
    {
      method: 'POST',
      body: JSON.stringify({ decision, note }),
    },
  )
}

export function completeProductionStage(
  runId: number,
  stageKey: string,
  outputSnapshot: Record<string, unknown> = {},
  note = '',
) {
  return request<ProductionRunViewDTO>(
    `/production-runs/${runId}/stages/${encodeURIComponent(stageKey)}/complete`,
    {
      method: 'POST',
      body: JSON.stringify({ outputSnapshot, note }),
    },
  )
}
