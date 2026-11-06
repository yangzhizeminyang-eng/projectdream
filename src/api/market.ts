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

export type MarketPlatform = '红果' | '抖音' | '快手' | '视频号' | '其他'
export type ObservationConfidence = 'fact' | 'reported' | 'inference' | 'hypothesis'
export type ExperimentStatus =
  | 'draft'
  | 'running'
  | 'reviewing'
  | 'continued'
  | 'revised'
  | 'stopped'

export interface MarketObservationDTO {
  id: number
  projectId?: number | null
  platform: MarketPlatform | string
  observedAt: string
  workTitle: string
  creatorName?: string | null
  contentType?: string | null
  topic?: string | null
  visualStyle?: string | null
  protagonistIdentity?: string | null
  openingType?: string | null
  openingEventSeconds?: number | null
  firstReversalSeconds?: number | null
  endingHook?: string | null
  titlePattern?: string | null
  coverPattern?: string | null
  commentNotes?: string | null
  sourceNote?: string | null
  rightsStatus?: string | null
  confidence: ObservationConfidence
  tags: string[]
  createdAt: string
  updatedAt: string
}

export interface TopicOpportunityDTO {
  id: number
  projectId?: number | null
  platform: MarketPlatform | string
  audience: string
  topic: string
  title: string
  logline?: string | null
  hypothesis?: string | null
  differentiation?: string | null
  risk?: string | null
  recommendedFormat?: string | null
  score?: number | null
  status: 'draft' | 'testing' | 'selected' | 'rejected'
  sourceObservationCount: number
  createdAt: string
  updatedAt: string
}

export interface ContentExperimentDTO {
  id: number
  projectId?: number | null
  sourceOpportunityId?: number | null
  name: string
  platform: MarketPlatform | string
  audience: string
  topic: string
  promise: string
  hypothesis?: string | null
  budget?: number | null
  status: ExperimentStatus
  decision?: string | null
  notes?: string | null
  variantCount: number
  metricCount: number
  createdAt: string
  updatedAt: string
}

export interface ExperimentVariantDTO {
  id: number
  experimentId: number
  label: string
  openingType?: string | null
  coverVersion?: string | null
  titleVersion?: string | null
  visualStyle?: string | null
  episodePlan: string[]
  createdAt: string
  updatedAt: string
}

export interface ExperimentMetricDTO {
  id: number
  experimentId: number
  variantId?: number | null
  platform: string
  metricName: string
  metricValue: number
  metricUnit?: string | null
  periodStart?: string | null
  periodEnd?: string | null
  notes?: string | null
  createdAt: string
}

export interface MarketWorkspaceDTO {
  observations: MarketObservationDTO[]
  opportunities: TopicOpportunityDTO[]
  experiments: ContentExperimentDTO[]
  summary: {
    observationCount: number
    opportunityCount: number
    runningExperimentCount: number
    selectedOpportunityCount: number
  }
}

export interface MarketAnalysisRunDTO {
  id: number
  projectId?: number | null
  runType: string
  inputObservationIds: number[]
  provider?: string | null
  modelName?: string | null
  status: 'running' | 'completed' | 'failed' | string
  errorText?: string | null
  createdAt: string
}

export interface MarketAnalysisDTO {
  run: MarketAnalysisRunDTO
  analysis: {
    analysisSummary: string
    evidenceQuality: string
    patterns: Array<{
      name: string
      evidence: string
      confidence: string
    }>
    experimentPlan: Array<{
      topicTitle: string
      openingVariants: string[]
      visualStyle: string
      episodeCount: number
      reason: string
    }>
  }
  opportunities: TopicOpportunityDTO[]
}

export interface CreateExperimentFromOpportunityDTO {
  experiment: ContentExperimentDTO
  variants: ExperimentVariantDTO[]
  idempotencyKey: string
}

export interface MarketQualityBlockerDTO {
  code: string
  message: string
  count?: number
  [key: string]: unknown
}

export interface MarketQualityDimensionDTO {
  passed?: boolean
  score?: number
  observed?: Record<string, unknown>
  [key: string]: unknown
}

export interface MarketQualityAuditItemDTO {
  exportId: number
  projectId: number
  status: string
  storageKey?: string | null
  storageReadable: boolean
  auditable?: boolean
  proxyPassed?: boolean
  technicalProxyPassed?: boolean
  media?: Record<string, unknown> | null
  audio?: Record<string, unknown> | null
  subtitle?: Record<string, unknown> | null
  audit?: {
    proxyPassed?: boolean
    technicalProxyPassed?: boolean
    overallScore?: number
    tier?: string
    hardBlockers?: MarketQualityBlockerDTO[]
    technicalBlockers?: MarketQualityBlockerDTO[]
    humanBlockers?: MarketQualityBlockerDTO[]
    warnings?: MarketQualityBlockerDTO[]
    dimensions?: Record<string, MarketQualityDimensionDTO | undefined>
    publishCandidate?: {
      status?: string
      machinePassed?: boolean
      requiresHumanReview?: boolean
      manualChecks?: string[]
    }
    disclaimer?: string
  } | null
  qualityReport?: {
    id?: number
    automaticPassed?: boolean
    reviewDecision?: string | null
  } | null
  blockers?: MarketQualityBlockerDTO[]
  error?: string
}

export interface MarketQualityAuditDTO {
  benchmarkVersion: string
  generatedAt: string
  mode: 'read-only' | string
  projectId: number
  limit: number
  requiredSampleCount: number
  summary: {
    projectId: number
    requiredSampleCount: number
    totalSelectedCount: number
    auditableSampleCount: number
    proxyPassedCount: number
    technicalProxyPassedCount: number
    missingSampleCount: number
    proxyFailureCount: number
    technicalProxyFailureCount: number
    storage: {
      readableExportIds: number[]
      missingExportIds: number[]
      missingCount: number
    }
    blockerCounts: Record<string, number>
    blockers: MarketQualityBlockerDTO[]
    tenSampleReadiness: {
      status: string
      enoughSamples: boolean
      technicallyReady: boolean
      technicalMachineReady: boolean
      requiredSampleCount: number
      auditableSampleCount: number
      proxyPassedCount: number
      technicalProxyPassedCount: number
      missingSampleCount: number
    }
    disclaimer: string
  }
  items: MarketQualityAuditItemDTO[]
}

export function getMarketWorkspace(projectId?: number) {
  const query = projectId ? `?projectId=${encodeURIComponent(String(projectId))}` : ''
  return request<MarketWorkspaceDTO>(`/market/workspace${query}`)
}

export function getProjectMarketQualityAudit(projectId: number) {
  return request<MarketQualityAuditDTO>(`/projects/${projectId}/market-quality-audit`)
}

export function analyzeMarketSamples(payload?: {
  projectId?: number | null
  observationIds?: number[]
  platform?: string
}) {
  return request<MarketAnalysisDTO>('/market/analyze', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
}

export function listMarketAnalysisRuns(projectId?: number) {
  const query = projectId ? `?projectId=${encodeURIComponent(String(projectId))}` : ''
  return request<{ items: MarketAnalysisRunDTO[] }>(`/market/analysis-runs${query}`)
}

export function createExperimentFromOpportunity(opportunityId: number) {
  return request<CreateExperimentFromOpportunityDTO>(
    `/market/opportunities/${opportunityId}/create-experiment`,
    {
      method: 'POST',
    },
  )
}

export function createMarketObservation(
  payload: Omit<MarketObservationDTO, 'id' | 'createdAt' | 'updatedAt'>,
) {
  return request<MarketObservationDTO>('/market/observations', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function createTopicOpportunity(
  payload: Omit<TopicOpportunityDTO, 'id' | 'createdAt' | 'updatedAt' | 'sourceObservationCount'>,
) {
  return request<TopicOpportunityDTO>('/market/opportunities', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function createContentExperiment(
  payload: Omit<
    ContentExperimentDTO,
    'id' | 'createdAt' | 'updatedAt' | 'variantCount' | 'metricCount'
  >,
) {
  return request<ContentExperimentDTO>('/market/experiments', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function listExperimentVariants(experimentId: number) {
  return request<{ items: ExperimentVariantDTO[] }>(
    `/market/experiments/${experimentId}/variants`,
  )
}

export function createExperimentVariant(
  experimentId: number,
  payload: Omit<ExperimentVariantDTO, 'id' | 'experimentId' | 'createdAt' | 'updatedAt'>,
) {
  return request<ExperimentVariantDTO>(`/market/experiments/${experimentId}/variants`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function listExperimentMetrics(experimentId: number) {
  return request<{ items: ExperimentMetricDTO[] }>(
    `/market/experiments/${experimentId}/metrics`,
  )
}

export function createExperimentMetric(
  experimentId: number,
  payload: Omit<ExperimentMetricDTO, 'id' | 'experimentId' | 'createdAt'>,
) {
  return request<ExperimentMetricDTO>(`/market/experiments/${experimentId}/metrics`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
