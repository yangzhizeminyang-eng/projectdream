/**
 * @file 漫剧一体化工作台——纯前端只读适配层
 * @description 组合现有真实 GET 接口，返回便于工作台展示的 ViewModel。
 *              阶段 1 不新增后端聚合接口；接口暂缺的能力返回“待接入”，不伪造完成状态。
 *              两级加载：跨时段只用轻量快照；选中镜头才拉该镜头的候选 / 声音详情。
 */
import {
  getProject,
  getStoryboard,
  listScenes,
  listStoryboards,
  listShotImages,
  listStoryboardVideos,
  listProjectAudio,
  getProjectProductionReadiness,
  getProjectFinalEdit,
  getSeasonStructure,
  getProjectCostLedger,
  type SceneDTO,
  type StoryboardDTO,
  type ImageAssetDTO,
  type VideoAssetDTO,
  type AudioAssetDTO,
  type CostLedgerDTO,
  type ProductionReadinessDTO,
  type FinalEditDTO,
} from './project'
import {
  listProductionRuns,
  getProductionRun,
  type ProductionRunDTO,
  type ProductionRunViewDTO,
  type ProductionStageDTO,
} from './production'
import { filterScenesForEpisode } from '@/lib/clip-rehearsal.mjs'

/* ------------------------------------------------------------------ */
/* 类型（对外 ViewModel）                                              */
/* ------------------------------------------------------------------ */

export interface StudioLoadOptions {
  projectId: number
  episodeNo?: number
  runId?: number
}

export interface EpisodeProductionCard {
  episodeNo: number
  title: string
  logline: string
  sceneCount: number
  shotCount: number
  generatedVideoCount: number
  confirmedVideoCount: number
  durationSeconds: number
  status: 'empty' | 'storyboard' | 'in-progress' | 'ready'
}

export async function loadEpisodeProductionCards(projectId: number): Promise<EpisodeProductionCard[]> {
  // 分集页的主数据来自剧本结构和场景列表。任何一侧暂时不可用时，
  // 都保留另一侧可展示的数据，避免模型服务错误覆盖整个页面。
  const [seasonResult, scenesResult] = await Promise.allSettled([
    getSeasonStructure(projectId),
    listScenes(projectId),
  ])
  const season = seasonResult.status === 'fulfilled' ? seasonResult.value : null
  const scenes = scenesResult.status === 'fulfilled' ? scenesResult.value : []
  const episodes = season?.episodes || []
  const sceneRows = scenes || []
  const shotsByScene = new Map<number, StoryboardDTO[]>()
  await Promise.all(
    sceneRows.map(async (scene) => {
      shotsByScene.set(scene.id, await listStoryboards(scene.id).catch(() => [] as StoryboardDTO[]))
    }),
  )

  const episodeRows = episodes.length
    ? episodes
    : [...new Map(sceneRows.map((scene) => [scene.episodeNo ?? 1, scene])).values()].map((scene) => ({
        episodeNo: scene.episodeNo ?? 1,
        // 场景标题不能冒充分集标题。没有 season structure 时只显示稳定的集序号，
        // 场景标题继续由分镜/场景区域单独展示，避免“时间裂缝”同时代表两层语义。
        title: `第 ${scene.episodeNo ?? 1} 集`,
        logline: scene.summary || scene.content || '',
        coreConflict: '',
      }))

  return episodeRows.map((episode) => {
    const episodeScenes = sceneRows.filter((scene) => (scene.episodeNo ?? 1) === episode.episodeNo)
    const shots = episodeScenes.flatMap((scene) => shotsByScene.get(scene.id) || [])
    const generatedVideoCount = shots.filter((shot) => Boolean(shot.videoUrl)).length
    const confirmedVideoCount = generatedVideoCount
    const durationSeconds = shots.reduce((sum, shot) => sum + Number(shot.durationSeconds || 0), 0)
    const status: EpisodeProductionCard['status'] =
      !shots.length ? 'empty' : confirmedVideoCount === shots.length ? 'ready' : generatedVideoCount ? 'in-progress' : 'storyboard'
    return {
      episodeNo: episode.episodeNo,
      title: episode.title || `第 ${episode.episodeNo} 集`,
      logline: episode.logline || episode.coreConflict || '',
      sceneCount: episodeScenes.length,
      shotCount: shots.length,
      generatedVideoCount,
      confirmedVideoCount,
      durationSeconds,
      status,
    }
  })
}

export interface ProductionContext {
  projectId: number
  projectName: string
  category?: string | null
  projectStatus: string
  targetDuration?: number | null
  aspectRatio?: string | null
  episodeNo?: number | null
  episodeTitle?: string | null
  run: ProductionRunDTO | null
  runId: number | null
  runStatus: string | null
  runCurrentStage: string | null
}

export type StageState =
  | 'not-started'
  | 'in-progress'
  | 'waiting-approval'
  | 'completed'
  | 'blocked'
  | 'rework'
  | 'unavailable'

export interface StageSummary {
  key: string
  sequenceNo: number
  label: string
  status: StageState
  blockedCount: number
  needsApproval: boolean
  current: boolean
}

export interface SceneSummary {
  id: number
  sceneNo: number
  title?: string | null
  mood?: string | null
  location?: string | null
  timeOfDay?: string | null
  estimatedDuration?: number | null
  sortOrder: number
  status: string
  shotCount: number
  audioStatus: string
  blocked: boolean
}

export interface ShotSummary {
  storyboardId: number
  sceneId: number
  sceneNo: number
  shotNo: string
  shotType?: string | null
  durationSeconds?: number | null
  imageUrl?: string | null
  endImageUrl?: string | null
  videoUrl?: string | null
  hasDialogue: boolean
  hasVoice: boolean
  mood?: string | null
  actingBeat?: string | null
  primaryAction?: string | null
  dialogueText?: string | null
  status: string
  blocked: boolean
}

export interface CandidateSummary {
  id: number
  versionNo: number
  url: string
  thumbnailUrl?: string | null
  status: string
  confirmed: boolean
  modelName?: string | null
  durationSeconds?: number | null
  title?: string | null
  trackType?: string | null
  voiceName?: string | null
  characterName?: string | null
  /** 口型同步绑定的对白音频 ID（视频候选） */
  audioAssetId?: number | null
  generationJobId?: number | null
  promptSnapshot?: string | null
  motionMode?: string | null
  qualityReport?: VideoAssetDTO['qualityReport']
  voiceProfileKey?: string | null
  characterVersionNo?: number | null
  createdAt?: string | null
  estimatedCost?: number | null
  costCurrency?: string | null
  costStatus?: string | null
}

export interface CandidateOverviewItem {
  key: string
  kind: 'video' | 'audio'
  storyboardId: number
  sceneId: number
  sceneNo: number
  shotNo: string
  primaryAction?: string | null
  dialogueText?: string | null
  candidate: CandidateSummary
}

export interface ContinuityContract {
  /** 上一镜头尾帧图 URL（继承状态） */
  prevEndFrame?: string | null
  /** 当前镜头首帧图 URL */
  currentStartFrame?: string | null
  /** 当前镜头尾帧图 URL */
  currentEndFrame?: string | null
  /** 是否已有上一镜尾帧（形成首尾链） */
  hasPrevEndFrame: boolean
  /** 允许出现的实体（来自分镜角色约束，真实数据） */
  allowedEntities: string[]
  /** 当前镜头唯一主动作 */
  primaryAction?: string | null
  /** 上一镜头主动作（用于人工核对“预告→揭示”） */
  prevPrimaryAction?: string | null
  /** 禁止/待接入说明 */
  suppliesNote: string
}

export interface VoiceLock {
  locked: boolean
  voiceName?: string | null
  modelName?: string | null
  profileKey?: string | null
  languageType?: string | null
  characterVersionNo?: number | null
  characterName?: string | null
  snapshot?: Record<string, unknown> | null
}

export interface QualityGate {
  label: string
  passed: boolean | null
  source: string
}

export type ShotWorkflowStatus = 'done' | 'current' | 'blocked' | 'waiting' | 'not-started'

export type ShotActionRoute = 'storyboard' | 'frame' | 'video' | 'audio' | 'edit' | 'none'

export interface ShotWorkflowStep {
  key: string
  label: string
  status: ShotWorkflowStatus
  description: string
  evidence: string
  route: ShotActionRoute
}

export interface ShotBlockingItem {
  key: string
  label: string
  detail: string
  severity: 'blocking' | 'warning'
  source: string
  route: ShotActionRoute
}

export interface ShotNextAction {
  key: string
  label: string
  description: string
  route: ShotActionRoute
  ready: boolean
}

export interface ShotWorkflow {
  workflowSteps: ShotWorkflowStep[]
  blockingItems: ShotBlockingItem[]
  nextAction: ShotNextAction
  nextActionKey: string
}

export interface ShotProductionDetail {
  storyboardId: number
  shotNo: string
  actionText?: string | null
  dialogueText?: string | null
  actingBeat?: string | null
  audioDirection?: string | null
  durationSeconds?: number | null
  imageCandidates: CandidateSummary[]
  videoCandidates: CandidateSummary[]
  currentImage?: CandidateSummary | null
  currentVideo?: CandidateSummary | null
  audioCandidates: CandidateSummary[]
  currentAudio?: CandidateSummary | null
  audioTrackType?: string | null
  /** 当前确认静帧快照中的角色生产基线版本（真实数据，来自 characterSnapshot） */
  roleVersion?: number | null
  continuity: ContinuityContract
  voice: VoiceLock
  quality: QualityGate[]
  workflowSteps: ShotWorkflowStep[]
  blockingItems: ShotBlockingItem[]
  nextAction: ShotNextAction
  nextActionKey: string
}

/* ------------------------------------------------------------------ */
/* 纯函数：当前 ProductionRun 选择                                     */
/* 不简单取最高 ID；按“进行中 > 等待确认 > 规划 > 最近完成 > 最近创建” */
/* 同一状态取 ID 最大。失败 / 取消的 run 不参与选择。                  */
/* ------------------------------------------------------------------ */

function runRank(status: string | undefined): number {
  switch (status) {
    case 'running':
      return 0
    case 'waiting_approval':
      return 1
    case 'planning':
      return 2
    case 'completed':
      return 3
    case 'paused':
      return 4
    case 'created':
      return 5
    default:
      return 99 // failed / canceled / unknown 最低
  }
}

/**
 * @description 从 run 列表中选择“当前生产运行”。
 * @param runs 该项目的 production runs
 * @param hintRunId query/URL 显式指定的 runId（最高优先级）
 * @param episodeNo 可选的单集过滤
 * @returns 选中 run；无可用时返回 null
 */
export function pickProductionRun(
  runs: ProductionRunDTO[],
  hintRunId?: number,
  episodeNo?: number,
): ProductionRunDTO | null {
  if (!runs || runs.length === 0) return null

  let candidates = runs.slice()
  if (typeof episodeNo === 'number' && episodeNo > 0) {
    const scoped = candidates.filter((r) => r.episodeNo === episodeNo)
    if (scoped.length > 0) candidates = scoped
  }

  if (typeof hintRunId === 'number' && hintRunId > 0) {
    const hinted = candidates.filter((r) => r.id === hintRunId)
    if (hinted.length > 0) return hinted[0] ?? null
  }

  const usable = candidates.filter((r) => runRank(r.status) < 99)
  if (usable.length === 0) return null
  let best: ProductionRunDTO | null = usable[0] as ProductionRunDTO
  for (const r of usable) {
    if (!best || r.id === best.id) continue
    const br = runRank(best.status)
    const rr = runRank(r.status)
    if (rr < br || (rr === br && r.id > best.id)) best = r
  }
  return best
}

/* ------------------------------------------------------------------ */
/* 纯函数：健康读取 → 结果                                             */
/* ------------------------------------------------------------------ */

export const STAGE_KEYS: Array<{ key: string; label: string }> = [
  { key: 'market-validation', label: '市场验证' },
  { key: 'episode-blueprint', label: '单集蓝图' },
  { key: 'emotion-design', label: '情绪与分镜' },
  { key: 'candidate-generation', label: '候选生成' },
  { key: 'candidate-selection', label: '候选筛选' },
  { key: 'continuous-edit', label: '连续剪辑' },
  { key: 'pilot-release', label: '小样发布' },
  { key: 'data-review', label: '数据复盘' },
  { key: 'scale-decision', label: '扩大生产' },
]

export interface StageGroupSummary {
  key: string
  label: string
  status: StageState
  blockedCount: number
  current: boolean
}

export const STAGE_GROUPS: Array<{ key: string; label: string; keys: string[] }> = [
  { key: 'script', label: '剧本生成', keys: ['market-validation', 'episode-blueprint', 'emotion-design'] },
  { key: 'assets', label: '资产管理', keys: ['candidate-generation'] },
  { key: 'storyboard-video', label: '分镜视频生成', keys: ['candidate-selection'] },
]

/** 将 run 的真实阶段状态映射到产品化的 10 阶段栏。 */
export function buildStageSummary(
  run: ProductionRunDTO | null,
  runStages: ProductionStageDTO[] | null,
): StageSummary[] {
  const realByKey = new Map<string, string>()
  for (const s of runStages || []) realByKey.set(s.stageKey, s.status)

  const stages = STAGE_KEYS.map((def, idx) => {
    const real = realByKey.get(def.key)
    return {
      key: def.key,
      sequenceNo: idx + 1,
      label: def.label,
      status: mapStageState(real, run),
      blockedCount:
        real === 'blocked' || real === 'rework' || real === 'rejected'
          ? 1
          : run?.status === 'failed'
            ? 1
            : 0,
      needsApproval: run?.status === 'waiting_approval',
      current: false,
    }
  })

  // “当前阶段”标记：自上而下第一个进行中 / 等待确认；都没有则保持未开始。
  const firstActive = stages.findIndex((s) => s.status === 'in-progress' || s.status === 'waiting-approval')
  const first = stages[firstActive]
  if (first) first.current = true
  return stages
}

/** 将内部 10 个真实阶段聚合为工作台使用的 4 个主阶段。 */
export function groupStageSummary(stages: StageSummary[]): StageGroupSummary[] {
  return STAGE_GROUPS.map((group) => {
    const children = stages.filter((stage) => group.keys.includes(stage.key))
    const has = (status: StageState) => children.some((stage) => stage.status === status)
    const status: StageState = has('blocked')
      ? 'blocked'
      : has('rework')
        ? 'rework'
        : has('in-progress')
          ? 'in-progress'
          : has('waiting-approval')
            ? 'waiting-approval'
            : children.length > 0 && children.every((stage) => stage.status === 'completed')
              ? 'completed'
              : 'not-started'

    return {
      key: group.key,
      label: group.label,
      status,
      blockedCount: children.reduce((total, stage) => total + stage.blockedCount, 0),
      current: children.some((stage) => stage.current),
    }
  })
}

function mapStageState(realStatus: string | undefined, run: ProductionRunDTO | null): StageState {
  if (!run) return 'not-started'
  if (!realStatus) return 'not-started'
  if (realStatus === 'completed') return 'completed'
  if (realStatus === 'running' || realStatus === 'processing') return 'in-progress'
  if (realStatus === 'blocked') return 'blocked'
  if (realStatus === 'rework' || realStatus === 'rejected') return 'rework'
  if (realStatus === 'waiting_approval' || realStatus === 'paused') return 'waiting-approval'
  return 'in-progress'
}

export function buildScenesSummary(scenes: SceneDTO[], shotsByScene: Map<number, StoryboardDTO[]>): SceneSummary[] {
  return scenes
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((s) => {
      const shots = shotsByScene.get(s.id) || []
      return {
        id: s.id,
        sceneNo: s.sceneNo,
        title: s.title ?? null,
        mood: s.mood ?? null,
        location: s.location ?? null,
        timeOfDay: s.timeOfDay ?? null,
        estimatedDuration: s.estimatedDuration ?? null,
        sortOrder: s.sortOrder,
        status: s.status,
        shotCount: shots.length,
        audioStatus: '待接入',
        blocked: shots.some((sh) => sh.status === 'blocked'),
      }
    })
}

export function buildShotsSummary(scene: SceneDTO, shots: StoryboardDTO[]): ShotSummary[] {
  return shots
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((sh) => ({
      storyboardId: sh.id,
      sceneId: scene.id,
      sceneNo: scene.sceneNo,
      shotNo: sh.shotNo,
      shotType: sh.shotType ?? null,
      durationSeconds: sh.durationSeconds ?? null,
      imageUrl: sh.imageUrl ?? undefined,
      endImageUrl: sh.endImageUrl ?? undefined,
      videoUrl: sh.videoUrl ?? undefined,
      hasDialogue: !!sh.dialogueText,
      hasVoice: !!sh.audioDirection || !!sh.dialogueText,
      mood: sh.actingBeat ?? null,
      actingBeat: sh.actingBeat ?? null,
      primaryAction: sh.actionText ?? null,
      dialogueText: sh.dialogueText ?? null,
      status: sh.status,
      blocked: sh.status === 'blocked',
    }))
}

function toCandidate(
  img: ImageAssetDTO | VideoAssetDTO | AudioAssetDTO,
  url: string,
  costLedger: CostLedgerDTO | null = null,
): CandidateSummary {
  const confirmed = (img as { status?: string }).status === 'confirmed'
  const audio = img as AudioAssetDTO
  const generationJobId =
    'generationJobId' in img && typeof img.generationJobId === 'number'
      ? img.generationJobId
      : null
  const audioAssetId =
    'audioAssetId' in img && typeof img.audioAssetId === 'number'
      ? img.audioAssetId
      : null
  const costEntry = costLedger?.items.find((item) =>
    generationJobId
      ? item.generationJobId === generationJobId
      : audioAssetId
        ? item.audioAssetId === audioAssetId
        : false,
  )
  return {
    id: img.id,
    versionNo: img.versionNo,
    url,
    thumbnailUrl: (img as ImageAssetDTO).thumbnailUrl ?? (img as VideoAssetDTO).thumbnailUrl ?? null,
    status: (img as { status?: string }).status ?? 'pending',
    confirmed,
    modelName: 'modelName' in img ? (img as VideoAssetDTO).modelName ?? null : (img as ImageAssetDTO).modelName ?? null,
    durationSeconds:
      'durationSeconds' in img
        ? (img as AudioAssetDTO | VideoAssetDTO).durationSeconds ?? null
        : null,
    title: 'title' in img ? audio.title ?? null : null,
    trackType: 'trackType' in img ? audio.trackType ?? null : null,
    voiceName: 'voiceName' in img ? audio.voiceName ?? null : null,
    characterName: 'characterName' in img ? audio.characterName ?? null : null,
    audioAssetId: 'audioAssetId' in img ? (img as VideoAssetDTO).audioAssetId ?? null : null,
    generationJobId,
    promptSnapshot: 'promptSnapshot' in img ? img.promptSnapshot ?? null : null,
    motionMode: 'motionMode' in img ? img.motionMode ?? null : null,
    qualityReport: 'qualityReport' in img ? (img as VideoAssetDTO).qualityReport ?? null : null,
    voiceProfileKey: 'voiceProfileKey' in img ? img.voiceProfileKey ?? null : null,
    characterVersionNo: 'characterVersionNo' in img ? img.characterVersionNo ?? null : null,
    createdAt: 'createdAt' in img ? img.createdAt ?? null : null,
    estimatedCost: costEntry?.estimatedCost ?? null,
    costCurrency: costEntry?.currency ?? null,
    costStatus: costEntry?.pricingStatus ?? null,
  }
}

const ALLOWED_NOT_NULL = (v: string | null | undefined): v is string => !!v && v.trim().length > 0

function deriveShotWorkflow(
  shot: StoryboardDTO,
  prevShot: StoryboardDTO | null,
  currentImage: CandidateSummary | null,
  currentVideo: CandidateSummary | null,
  currentAudio: CandidateSummary | null,
): ShotWorkflow {
  const hasAction = ALLOWED_NOT_NULL(shot.actionText)
  const hasFrame = !!currentImage || ALLOWED_NOT_NULL(shot.imageUrl)
  const hasVideo = !!currentVideo || ALLOWED_NOT_NULL(shot.videoUrl)
  const needsSound = ALLOWED_NOT_NULL(shot.dialogueText) || ALLOWED_NOT_NULL(shot.audioDirection)
  const hasSound = !!currentAudio
  const hasContinuity = ALLOWED_NOT_NULL(shot.imageUrl) && ALLOWED_NOT_NULL(shot.endImageUrl)
  const hasPreviousAnchor = !prevShot || ALLOWED_NOT_NULL(prevShot.endImageUrl)

  const steps: ShotWorkflowStep[] = [
    {
      key: 'define-action',
      label: '锁定主动作',
      status: hasAction ? 'done' : 'blocked',
      description: hasAction ? '本镜头只执行一个主动作。' : '先写清楚镜头里唯一要发生的动作。',
      evidence: hasAction ? shot.actionText!.trim() : '缺少 actionText',
      route: 'storyboard',
    },
    {
      key: 'confirm-frame',
      label: '确认静帧',
      status: hasFrame ? 'done' : 'current',
      description: hasFrame ? '已有视觉基准，可进入动作视频。' : '先生成并确认本镜头的静帧。',
      evidence: hasFrame ? '已有确认静帧或镜头主图' : '尚无确认静帧',
      route: 'frame',
    },
    {
      key: 'generate-video',
      label: '生成动作视频',
      status: hasVideo ? 'done' : hasFrame ? 'current' : 'not-started',
      description: hasVideo ? '已有视频候选或确认视频。' : '用静帧和唯一主动作生成无声视频。',
      evidence: hasVideo ? '已有视频候选或确认视频' : '尚无视频候选',
      route: 'video',
    },
    {
      key: 'prepare-sound',
      label: '准备声音',
      status: !needsSound || hasSound ? 'done' : hasVideo ? 'current' : 'not-started',
      description: !needsSound ? '本镜头没有对白或声音方向。' : hasSound ? '对白音频已绑定声线快照。' : '先生成并确认与本镜头情节对应的声音。',
      evidence: !needsSound ? '无对白 / 无声音方向' : hasSound ? '已有确认音频' : '缺少确认音频',
      route: 'audio',
    },
    {
      key: 'review-continuity',
      label: '复核首尾帧',
      status: hasContinuity && hasPreviousAnchor ? 'done' : hasFrame ? 'current' : 'not-started',
      description: hasContinuity && hasPreviousAnchor
        ? '当前镜头首尾帧和上一镜尾帧已具备连续性证据。'
        : '核对上一镜尾帧、当前首帧和当前尾帧，避免突然出现未预告实体。',
      evidence: hasContinuity
        ? hasPreviousAnchor
          ? '首帧 / 尾帧 / 上一镜锚点齐全'
          : '缺少上一镜结束帧'
        : '缺少当前首帧或结束帧',
      route: 'storyboard',
    },
    {
      key: 'open-edit',
      label: '进入剪辑',
      status: hasVideo && (!needsSound || hasSound) && hasContinuity && hasPreviousAnchor ? 'current' : 'waiting',
      description: '素材齐备后进入时间线，完成裁切、音频对齐和字幕。',
      evidence: '已有高级剪辑入口，当前工作台暂不修改时间线',
      route: 'edit',
    },
  ]

  const blockingItems: ShotBlockingItem[] = []
  if (!hasAction) {
    blockingItems.push({
      key: 'missing-action',
      label: '缺少唯一主动作',
      detail: '没有主动作时，视频模型可能自由添加与情节无关的动作。',
      severity: 'blocking',
      source: '分镜 actionText',
      route: 'storyboard',
    })
  }
  if (!hasFrame) {
    blockingItems.push({
      key: 'missing-frame',
      label: '缺少确认静帧',
      detail: '视频生成必须先锁定人物、场景和道具的视觉基准。',
      severity: 'blocking',
      source: '静帧资产',
      route: 'frame',
    })
  }
  if (!hasVideo) {
    blockingItems.push({
      key: 'missing-video',
      label: '缺少视频候选',
      detail: '当前镜头还没有可供人工筛选的动作视频。',
      severity: 'blocking',
      source: '视频候选',
      route: 'video',
    })
  }
  if (needsSound && !hasSound) {
    blockingItems.push({
      key: 'missing-sound',
      label: '缺少确认声音',
      detail: '对白镜头必须先锁定正确角色、语言和情绪，再进入口型同步或混音。',
      severity: 'blocking',
      source: '音频资产',
      route: 'audio',
    })
  }
  if (!hasContinuity || !hasPreviousAnchor) {
    blockingItems.push({
      key: 'incomplete-continuity',
      label: '首尾帧连续性未闭合',
      detail: '下一镜不能凭空出现新物体；请先确认上一镜尾帧到本镜首帧的衔接。',
      severity: 'warning',
      source: '连续性契约',
      route: 'storyboard',
    })
  }

  const priority = ['define-action', 'confirm-frame', 'generate-video', 'prepare-sound', 'review-continuity', 'open-edit']
  const nextStep = priority
    .map((key) => steps.find((step) => step.key === key))
    .find((step) => step && (step.status === 'blocked' || step.status === 'current')) || steps[steps.length - 1]
  const nextAction = nextStep
    ? {
        key: nextStep.key,
        label: nextStep.status === 'blocked' ? `先处理：${nextStep.label}` : nextStep.label,
        description: nextStep.description,
        route: nextStep.route,
        ready: nextStep.route !== 'none',
      }
    : {
        key: 'open-edit',
        label: '进入剪辑',
        description: '素材齐备后进入时间线。',
        route: 'edit' as const,
        ready: true,
      }

  return {
    workflowSteps: steps,
    blockingItems,
    nextAction,
    nextActionKey: nextAction.key,
  }
}

/**
 * @description 组合一个镜头的生产详情。前一镜头提供尾帧继承与“预告→揭示”对照。
 */
export function buildShotDetail(
  shot: StoryboardDTO,
  prevShot: StoryboardDTO | null,
  images: ImageAssetDTO[],
  videos: VideoAssetDTO[],
  audios: AudioAssetDTO[],
  costLedger: CostLedgerDTO | null = null,
): ShotProductionDetail {
  const imageCandidates = images.map((img) => toCandidate(img, img.imageUrl, costLedger))
  const videoCandidates = videos.map((v) => toCandidate(v, v.videoUrl, costLedger))
  const audioCandidates = audios.map((a) => toCandidate(a, a.audioUrl, costLedger))
  const currentImage = imageCandidates.find((c) => c.confirmed) || null
  const currentVideo = videoCandidates.find((c) => c.confirmed) || null
  const currentAudio = audioCandidates.find((c) => c.confirmed) || null

  // 当前确认静帧快照中的角色生产基线版本（仅当该角色在帧内出现时才有）
  const currentImageRaw = images.find((i) => i.status === 'confirmed')
  const roleVersion =
    currentImageRaw?.characterSnapshot?.characters?.[0]?.characterVersionNo ??
    currentImageRaw?.characterSnapshot?.version ??
    null

  const allowedEntities = [
    ...(shot.frameCharacterContext?.characters?.length
      ? shot.frameCharacterContext.characters.map((c) => c.name).filter(ALLOWED_NOT_NULL)
      : []),
    ...[shot.characterName].filter(ALLOWED_NOT_NULL),
  ]

  const voice: VoiceLock = {
    locked: !!currentAudio,
    voiceName: currentAudio ? (audios.find((a) => a.id === currentAudio.id)?.voiceName ?? null) : null,
    modelName: audios.find((a) => a.id === currentAudio?.id)?.modelName ?? null,
    profileKey: audios.find((a) => a.id === currentAudio?.id)?.voiceProfileKey ?? null,
    characterVersionNo: audios.find((a) => a.id === currentAudio?.id)?.characterVersionNo ?? null,
    characterName: audios.find((a) => a.id === currentAudio?.id)?.characterName ?? null,
    snapshot: audios.find((a) => a.id === currentAudio?.id)?.characterSnapshot ?? null,
  }

  const quality: QualityGate[] = [
    { label: '人物一致性', passed: allowedEntities.length > 0 ? null : null, source: '分镜角色约束' },
    { label: '首尾帧连续性', passed: !!shot.imageUrl && !!shot.endImageUrl, source: `上一镜尾帧${prevShot?.endImageUrl ? '已继承' : '未接入'}` },
    { label: '音画同步', passed: !!currentVideo?.audioAssetId, source: '口型对白同源绑定' },
    {
      label: '声音相关性',
      passed: voice.locked ? null : false,
      source: voice.locked ? `已锁定：${voice.voiceName ?? '未知声线'}` : '暂无确认对白',
    },
    { label: '英文串音', passed: null, source: '待接入' },
    { label: '单镜头主动作', passed: ALLOWED_NOT_NULL(shot.actionText) ? true : null, source: shot.actionText ? '已有主动作' : '待填' },
  ]

  const workflow = deriveShotWorkflow(shot, prevShot, currentImage, currentVideo, currentAudio)

  return {
    storyboardId: shot.id,
    shotNo: shot.shotNo,
    actionText: shot.actionText ?? null,
    dialogueText: shot.dialogueText ?? null,
    actingBeat: shot.actingBeat ?? null,
    audioDirection: shot.audioDirection ?? null,
    durationSeconds: shot.durationSeconds ?? null,
    imageCandidates,
    videoCandidates,
    currentImage,
    currentVideo,
    audioCandidates,
    currentAudio,
    audioTrackType: audios.find((a) => a.id === currentAudio?.id)?.trackType ?? null,
    roleVersion,
    continuity: {
      prevEndFrame: prevShot?.endImageUrl ?? undefined,
      currentStartFrame: shot.imageUrl ?? undefined,
      currentEndFrame: shot.endImageUrl ?? undefined,
      hasPrevEndFrame: !!prevShot?.endImageUrl,
      allowedEntities,
      primaryAction: shot.actionText ?? null,
      prevPrimaryAction: prevShot?.actionText ?? null,
      suppliesNote:
        prevShot && prevShot.actionText && shot.actionText && prevShot.actionText !== shot.actionText
          ? '上一镜动作与本镜不同，建议人工核对“预告 → 揭示”是否成立。'
          : '道具 / 禁止实体清单待接入持续性契约。',
    },
    voice,
    quality,
    ...workflow,
  }
}

export function buildCandidateOverview(
  scenes: SceneDTO[],
  shotsByScene: Map<number, StoryboardDTO[]>,
  videosByStoryboard: Map<number, VideoAssetDTO[]>,
  audioByStoryboard: Map<number, AudioAssetDTO[]>,
  costLedger: CostLedgerDTO | null = null,
): CandidateOverviewItem[] {
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]))
  const items: CandidateOverviewItem[] = []

  for (const [sceneId, shots] of shotsByScene) {
    const scene = sceneById.get(sceneId)
    if (!scene) continue
    for (const shot of shots) {
      const videoCandidates = videosByStoryboard.get(shot.id) || []
      const audioCandidates = audioByStoryboard.get(shot.id) || []
      for (const video of videoCandidates) {
        if (video.status === 'archived') continue
        const candidate = toCandidate(video, video.videoUrl, costLedger)
        items.push({
          key: `video:${video.id}`,
          kind: 'video',
          storyboardId: shot.id,
          sceneId,
          sceneNo: scene.sceneNo,
          shotNo: shot.shotNo,
          primaryAction: shot.actionText ?? null,
          dialogueText: shot.dialogueText ?? null,
          candidate,
        })
      }
      for (const audio of audioCandidates) {
        if (audio.status === 'archived') continue
        const candidate = toCandidate(audio, audio.audioUrl, costLedger)
        items.push({
          key: `audio:${audio.id}`,
          kind: 'audio',
          storyboardId: shot.id,
          sceneId,
          sceneNo: scene.sceneNo,
          shotNo: shot.shotNo,
          primaryAction: shot.actionText ?? null,
          dialogueText: shot.dialogueText ?? null,
          candidate,
        })
      }
    }
  }

  return items.sort((left, right) => {
    if (left.sceneNo !== right.sceneNo) return left.sceneNo - right.sceneNo
    const shotDelta = left.shotNo.localeCompare(right.shotNo, undefined, { numeric: true })
    if (shotDelta !== 0) return shotDelta
    if (left.kind !== right.kind) return left.kind === 'video' ? -1 : 1
    return left.candidate.versionNo - right.candidate.versionNo
  })
}

/* ------------------------------------------------------------------ */
/* 异步加载                                                            */
/* ------------------------------------------------------------------ */

export interface StudioSnapshot {
  context: ProductionContext
  run: ProductionRunViewDTO | null
  readiness: ProductionReadinessDTO | null
  finalEdit: FinalEditDTO | null
  stages: StageSummary[]
  scenes: SceneSummary[]
  scenesRaw: SceneDTO[]
  scenesRawMapById: Record<number, SceneDTO>
  shotSummariesByScene: Record<number, ShotSummary[]>
  audioByStoryboard: Map<number, AudioAssetDTO[]>
  costLedger: CostLedgerDTO | null
  candidateOverview: CandidateOverviewItem[]
}

/**
 * @description 加载工作台轻量快照（跨时段只这一份）。
 *              任何单一数据源失败都降级为 null，绝不抛错阻断整个工作台，也不伪造。
 */
export async function loadStudioSnapshot(options: StudioLoadOptions): Promise<StudioSnapshot> {
  const { projectId } = options
  const empty: StudioSnapshot = {
    context: {
      projectId,
      projectName: `项目 #${projectId}`,
      projectStatus: '',
      run: null,
      runId: null,
      runStatus: null,
      runCurrentStage: null,
      episodeNo: options.episodeNo ?? null,
      episodeTitle: null,
    },
    run: null,
    readiness: null,
    finalEdit: null,
    stages: [],
    scenes: [],
    scenesRaw: [],
    scenesRawMapById: {},
    shotSummariesByScene: {},
    audioByStoryboard: new Map(),
    costLedger: null,
    candidateOverview: [],
  }

  const [project, scenes, runs, readiness, finalEdit, costLedger] = await Promise.allSettled([
    getProject(projectId),
    listScenes(projectId),
    listProductionRuns(projectId),
    getProjectProductionReadiness(projectId),
    getProjectFinalEdit(projectId),
    getProjectCostLedger(projectId),
  ])

  const ctx: ProductionContext = {
    projectId,
    projectName: project.status === 'fulfilled' ? project.value.name || `项目 #${projectId}` : `项目 #${projectId}`,
    category: project.status === 'fulfilled' ? project.value.category ?? null : null,
    projectStatus: project.status === 'fulfilled' ? project.value.status : '',
    targetDuration: project.status === 'fulfilled' ? project.value.targetDuration ?? null : null,
    aspectRatio: project.status === 'fulfilled' ? project.value.aspectRatio ?? null : null,
    episodeNo: options.episodeNo ?? null,
    episodeTitle: null,
    run: null,
    runId: options.runId ?? null,
    runStatus: null,
    runCurrentStage: null,
  }

  // 单集标题（结构接口可选，失败则降级）
  if (options.episodeNo) {
    const season = await getSeasonStructure(projectId).catch(() => null)
    if (season?.episodes) {
      const ep = season.episodes.find((e) => e.episodeNo === options.episodeNo)
      if (ep?.title) ctx.episodeTitle = ep.title
    }
  }

  // 当前 ProductionRun 选择
  let runView: ProductionRunViewDTO | null = null
  if (runs.status === 'fulfilled' && runs.value?.items?.length) {
    const picked = pickProductionRun(runs.value.items, options.runId, options.episodeNo)
    if (picked) {
      ctx.run = picked
      ctx.runId = picked.id
      // 未显式传 episodeNo 时，当前运行本身就是最可靠的单集上下文。
      if (!ctx.episodeNo && picked.episodeNo) ctx.episodeNo = picked.episodeNo
      ctx.runStatus = picked.status
      ctx.runCurrentStage = picked.currentStage
      runView = await getProductionRun(picked.id).catch(() => null)
    }
  }

  // 从 Dashboard 直达工作台时补回单集标题，避免上下文显示“未选择单集”。
  if (ctx.episodeNo && !ctx.episodeTitle) {
    const season = await getSeasonStructure(projectId).catch(() => null)
    const ep = season?.episodes?.find((e) => e.episodeNo === ctx.episodeNo)
    if (ep?.title) ctx.episodeTitle = ep.title
  }

  const scenesRaw = filterScenesForEpisode(
    scenes.status === 'fulfilled' ? scenes.value || [] : [],
    options.episodeNo,
  )
  const shotsByScene = new Map<number, StoryboardDTO[]>()
  // 轻量拉取每个场景的镜头（快照阶段只到“镜头摘要”，不进详情）
  if (scenesRaw.length) {
    await Promise.all(
      scenesRaw.map(async (scene) => {
        const shots = await listStoryboards(scene.id).catch(() => [] as StoryboardDTO[])
        shotsByScene.set(scene.id, shots)
      }),
    )
  }

  // 声音：项目级音频按 storyboardId 分桶
  const audioByStoryboard = new Map<number, AudioAssetDTO[]>()
  if (project.status === 'fulfilled') {
    const allAudio = await listProjectAudio(projectId).catch(() => [] as AudioAssetDTO[])
    for (const a of allAudio) {
      if (typeof a.storyboardId === 'number') {
        const bucket = audioByStoryboard.get(a.storyboardId) || []
        bucket.push(a)
        audioByStoryboard.set(a.storyboardId, bucket)
      }
    }
  }

  const stages = buildStageSummary(ctx.run, runView?.stages || null)
  const sceneSummaries = buildScenesSummary(scenesRaw, shotsByScene)
  const scenesRawMapById: Record<number, SceneDTO> = {}
  const shotSummariesByScene: Record<number, ShotSummary[]> = {}
  for (const scene of scenesRaw) {
    scenesRawMapById[scene.id] = scene
    shotSummariesByScene[scene.id] = buildShotsSummary(scene, shotsByScene.get(scene.id) || [])
  }

  return {
    context: ctx,
    run: runView,
    readiness: readiness.status === 'fulfilled' ? readiness.value : null,
    finalEdit: finalEdit.status === 'fulfilled' ? finalEdit.value : null,
    stages,
    scenes: sceneSummaries,
    scenesRaw,
    scenesRawMapById,
    shotSummariesByScene,
    audioByStoryboard,
    costLedger: costLedger.status === 'fulfilled' ? costLedger.value : null,
    candidateOverview: [],
  }
}

export async function loadCandidateOverview(snapshot: StudioSnapshot): Promise<CandidateOverviewItem[]> {
  const shotsByScene = new Map<number, StoryboardDTO[]>()
  for (const scene of snapshot.scenesRaw) {
    const shots = (snapshot.shotSummariesByScene[scene.id] || []).map((shot) => ({
      id: shot.storyboardId,
      sceneId: shot.sceneId,
      shotNo: shot.shotNo,
      actionText: shot.primaryAction ?? null,
      dialogueText: shot.dialogueText ?? null,
      durationSeconds: shot.durationSeconds ?? null,
      imageUrl: shot.imageUrl ?? null,
      endImageUrl: shot.endImageUrl ?? null,
      videoUrl: shot.videoUrl ?? null,
      sortOrder: 0,
      status: shot.status,
      createdAt: '',
      updatedAt: '',
    }))
    shotsByScene.set(scene.id, shots)
  }

  const videosByStoryboard = new Map<number, VideoAssetDTO[]>()
  const shots = [...shotsByScene.values()].flat()
  await Promise.all(
    shots.map(async (shot) => {
      const videos = await listStoryboardVideos(shot.id).catch(() => [] as VideoAssetDTO[])
      videosByStoryboard.set(shot.id, videos)
    }),
  )

  return buildCandidateOverview(
    snapshot.scenesRaw,
    shotsByScene,
    videosByStoryboard,
    snapshot.audioByStoryboard,
    snapshot.costLedger,
  )
}

/** @description 拉取单个镜头的候选详情（图像 / 视频 / 音频）。 */
export async function loadShotDetail(
  shot: ShotSummary,
  prevShot: ShotSummary | null,
  audioByStoryboard: Map<number, AudioAssetDTO[]>,
  costLedger: CostLedgerDTO | null = null,
): Promise<ShotProductionDetail> {
  const [images, videos, full] = await Promise.all([
    listShotImages(shot.storyboardId).catch(() => [] as ImageAssetDTO[]),
    listStoryboardVideos(shot.storyboardId).catch(() => [] as VideoAssetDTO[]),
    getStoryboard(shot.storyboardId).catch(() => null),
  ])
  const audios = audioByStoryboard.get(shot.storyboardId) || []

  // 详情用完整分镜（含角色约束）；失败时回退到摘要携带的字段，绝不阻断。
  const sb: StoryboardDTO = full ?? {
    id: shot.storyboardId,
    sceneId: shot.sceneId,
    shotNo: shot.shotNo,
    shotType: shot.shotType ?? null,
    actionText: shot.primaryAction ?? null,
    dialogueText: shot.dialogueText ?? null,
    actingBeat: shot.actingBeat ?? null,
    durationSeconds: shot.durationSeconds ?? null,
    imageUrl: shot.imageUrl ?? null,
    endImageUrl: shot.endImageUrl ?? null,
    videoUrl: shot.videoUrl ?? null,
    sortOrder: 0,
    status: 'draft',
    createdAt: '',
    updatedAt: '',
  }

  const prevSb: StoryboardDTO | null = prevShot
    ? {
        id: prevShot.storyboardId,
        sceneId: prevShot.sceneId,
        shotNo: prevShot.shotNo,
        actionText: prevShot.primaryAction,
        dialogueText: prevShot.dialogueText,
        imageUrl: prevShot.imageUrl,
        endImageUrl: prevShot.endImageUrl,
        videoUrl: prevShot.videoUrl,
        durationSeconds: prevShot.durationSeconds,
        sortOrder: 0,
        status: 'draft',
        createdAt: '',
        updatedAt: '',
      }
    : null

  return buildShotDetail(sb, prevSb, images, videos, audios, costLedger)
}
