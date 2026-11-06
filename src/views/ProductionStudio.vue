<script setup lang="ts">
/**
 * 漫剧一体化工作台（主入口 /workspace/studio）
 * 纯只读聚合：组合现有真实 GET 接口展示单集连续生产状态。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryValue } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import { getWorkspaceContext, setWorkspaceContext } from '@/lib/context'
import {
  loadStudioSnapshot,
  loadCandidateOverview,
  loadShotDetail,
  groupStageSummary,
  type StudioSnapshot,
  type ShotSummary,
  type ShotProductionDetail,
  type ShotActionRoute,
  type CandidateOverviewItem,
  type CandidateSummary,
  loadEpisodeProductionCards,
  type EpisodeProductionCard,
} from '@/api/production-studio'
import {
  archiveProjectAsset,
  confirmProjectAudio,
  confirmVideo,
  getProjectDeliveryPackage,
  downloadProjectDeliveryArchive,
  listCharacters,
  listScenes,
  generateStoryboards,
  listProjectVoiceCast,
  getProjectAssets,
  updateStoryboard,
  generateStoryboardVideos,
  generateShotImages,
  getGenerationJob,
  getStoryboard,
  listShotImages,
  listProjectAudio,
  removeVideoSubtitles,
  type AudioAssetDTO,
} from '@/api/project'
import { getProject } from '@/api/project'
import type { CharacterDTO, CharacterVoiceCastDTO, ProjectAssetItemDTO } from '@/api/project'
import { buildClipRehearsalReport } from '@/lib/clip-rehearsal.mjs'
import { buildUnifiedStoryboardPrompt, parseUnifiedStoryboardPrompt } from '@/lib/storyboard-prompt.mjs'
import { formatAggregateDuration, formatShotDuration } from '@/lib/episode-clips.mjs'

import ProductionContextBar from '@/components/production/ProductionContextBar.vue'
import ProductionStageRail from '@/components/production/ProductionStageRail.vue'
import EpisodeHeader from '@/components/production/EpisodeHeader.vue'
import SceneStrip from '@/components/production/SceneStrip.vue'
import StoryboardGrid from '@/components/production/StoryboardGrid.vue'
import ShotProductionCard from '@/components/production/ShotProductionCard.vue'
import ProductionInspector from '@/components/production/ProductionInspector.vue'
import ProductionLightTimeline from '@/components/production/ProductionLightTimeline.vue'
import CandidateOverview from '@/components/production/CandidateOverview.vue'
import {
  enqueueReworkItems,
  readReworkQueue,
  startNextReworkItem,
  type ReworkQueueItem,
} from '@/lib/rework-queue'

const route = useRoute()
const router = useRouter()

const snapshot = ref<StudioSnapshot | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

const selectedSceneId = ref<number | null>(null)
const selectedShotId = ref<number | null>(null)
const detail = ref<ShotProductionDetail | null>(null)
const detailLoading = ref(false)
const inspectorOpen = ref(false)
const timelineOpen = ref(false)
const stageRailCollapsed = ref(false)
const pendingCandidateKey = ref<string | null>(null)
const candidateFeedback = ref<{
  assetKey: string
  tone: 'success' | 'warning' | 'error'
  message: string
} | null>(null)
const candidateOverviewOpen = ref(false)
const candidateOverviewLoading = ref(false)
const candidateOverviewItems = ref<CandidateOverviewItem[]>([])
const reworkQueue = ref<ReworkQueueItem[]>([])
const reworkQueueMessage = ref('')
const episodeCards = ref<EpisodeProductionCard[]>([])
const episodeCardsLoading = ref(false)
const episodeCardsError = ref('')
const productionCharacters = ref<CharacterDTO[]>([])
const voiceCast = ref<CharacterVoiceCastDTO[]>([])
const projectAssets = ref<ProjectAssetItemDTO[]>([])
const assetPromptEditor = ref<ProjectAssetItemDTO | CharacterDTO | null>(null)
const assetPromptText = ref('')
const assetPromptSaving = ref(false)
const assetPromptMessage = ref('')
const activeToolTab = ref<'assets' | 'tools'>('assets')
const continuityOpen = ref(false)
const storyboardDraft = ref<{
  actionText: string
  visualPrompt: string
  dialogueText: string
  shotType: string
  cameraAngle: string
  composition: string
  startVisualPrompt: string
  endVisualPrompt: string
}>({
  actionText: '',
  visualPrompt: '',
  dialogueText: '',
  shotType: '',
  cameraAngle: '',
  composition: '',
  startVisualPrompt: '',
  endVisualPrompt: '',
})
const unifiedStoryboardPrompt = computed({
  get: () => buildUnifiedStoryboardPrompt(storyboardDraft.value),
  set: (value: string) => Object.assign(storyboardDraft.value, parseUnifiedStoryboardPrompt(value)),
})
const storyboardSaving = ref(false)
const storyboardSaveMessage = ref('')
const videoGenerating = ref(false)
const videoGenerateMessage = ref('')
const clipRehearsalBusy = ref(false)
const clipRehearsalMessage = ref('')
const clipRehearsalReport = ref<ReturnType<typeof buildClipRehearsalReport> | null>(null)
const clipVideoSubmitting = ref(false)
const previewZoomed = ref(false)
const subtitleErased = ref(false)
const subtitleCleanupBusy = ref(false)
const subtitleCleanupMessage = ref('')
const subtitleCleanedVideoUrl = ref('')
const exportBusy = ref(false)
const exportMessage = ref('')
const groupedStages = computed(() => (snapshot.value ? groupStageSummary(snapshot.value.stages) : []))
const reworkSummary = computed(() => ({
  queued: reworkQueue.value.filter((item) => item.status === 'queued').length,
  inProgress: reworkQueue.value.filter((item) => item.status === 'in-progress').length,
  completed: reworkQueue.value.filter((item) => item.status === 'completed').length,
}))

function qnum(v: LocationQueryValue | LocationQueryValue[] | undefined): number | undefined {
  if (v == null) return undefined
  const n = Number(Array.isArray(v) ? v[0] : v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

async function load() {
  loading.value = true
  error.value = null
  const projectId = qnum(route.query.projectId) ?? getWorkspaceContext()?.projectId ?? 0
  if (!projectId) {
    error.value = '缺少项目上下文，请从项目总览进入工作台。'
    loading.value = false
    return
  }
  const episodeNo = qnum(route.query.episodeNo)
  const runId = qnum(route.query.productionRunId) ?? qnum(route.query.runId)
  setWorkspaceContext({
    projectId,
    episodeNo,
    productionRunId: runId,
  })
  // 项目总览只需要项目级快照。单集镜头数据、模型状态和候选信息
  // 在真正进入某一集后再加载，避免用户刚进入工作台就被无关接口阻塞。
  if (!episodeNo && route.query.view === 'overview') {
    try {
      const project = await getProject(projectId)
      snapshot.value = {
      context: {
          projectId,
          projectName: project.name,
          projectStatus: project.status,
          run: null,
          episodeNo: null,
          runId: null,
          runStatus: null,
          runCurrentStage: null,
        },
        run: null,
        scenes: [],
        scenesRaw: [],
        scenesRawMapById: {},
        shotSummariesByScene: {},
        audioByStoryboard: new Map(),
        finalEdit: null,
        readiness: null,
        stages: [],
        costLedger: null,
        candidateOverview: [],
      } as StudioSnapshot
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '项目加载失败'
    } finally {
      loading.value = false
      episodeCardsLoading.value = false
    }
    return
  }
  try {
    episodeCardsLoading.value = true
    const snap = await loadStudioSnapshot({ projectId, episodeNo, runId })
    snapshot.value = snap
    const [characterRows, castRows, assetRows] = await Promise.all([
      listCharacters(projectId).catch(() => [] as CharacterDTO[]),
      listProjectVoiceCast(projectId).catch(() => [] as CharacterVoiceCastDTO[]),
      getProjectAssets(projectId).catch(() => ({ items: [] as ProjectAssetItemDTO[] })),
    ])
    productionCharacters.value = characterRows
    voiceCast.value = castRows
    projectAssets.value = assetRows.items
    if (!episodeNo) {
      episodeCards.value = await loadEpisodeProductionCards(projectId)
    }
    reworkQueue.value = readReworkQueue(projectId)
    // 选择优先级：URL 指定镜头 > URL 指定场景 > 当前数据中的第一个场景。
    const qScene = qnum(route.query.sceneId)
    const qShot = qnum(route.query.storyboardId)
    const firstScene = snap.scenes.length ? snap.scenes[0] : null
    const shotScene = qShot
      ? snap.scenes.find((scene) => snap.shotSummariesByScene[scene.id]?.some((shot) => shot.storyboardId === qShot))
      : null
    const sceneId = shotScene?.id || (qScene && snap.scenesRawMapById[qScene] ? qScene : firstScene?.id ?? null)
    selectedSceneId.value = sceneId
    applySceneSelection(sceneId, qShot)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '工作台加载失败'
    episodeCardsError.value = error.value
  } finally {
    loading.value = false
    episodeCardsLoading.value = false
  }
}

const selectedShotSummary = computed(() => {
  if (!selectedShotId.value || !snapshot.value) return null
  return currentShots().find((shot) => shot.storyboardId === selectedShotId.value) || null
})

const selectedShotVoice = computed(() => {
  const characterId = detail.value?.voice?.characterName
  return voiceCast.value.find((item) => item.character.name === characterId) || null
})

async function hydrateStoryboardDraft(storyboardId: number): Promise<void> {
  const shot = await getStoryboard(storyboardId)
  storyboardDraft.value = {
    actionText: shot.actionText || '',
    visualPrompt: shot.visualPrompt || '',
    dialogueText: shot.dialogueText || '',
    shotType: shot.shotType || '',
    cameraAngle: shot.cameraAngle || '',
    composition: shot.composition || '',
    startVisualPrompt: shot.startVisualPrompt || '',
    endVisualPrompt: shot.endVisualPrompt || '',
  }
  storyboardSaveMessage.value = ''
}

async function saveStoryboardDraft(): Promise<void> {
  if (!selectedShotId.value || storyboardSaving.value) return
  storyboardSaving.value = true
  try {
    await updateStoryboard(selectedShotId.value, storyboardDraft.value)
    storyboardSaveMessage.value = '分镜脚本已保存'
    await loadDetailFor(selectedShotId.value)
  } catch (cause) {
    storyboardSaveMessage.value = cause instanceof Error ? cause.message : '分镜保存失败'
  } finally {
    storyboardSaving.value = false
  }
}

function insertMention(label: string): void {
  storyboardDraft.value.visualPrompt = `${storyboardDraft.value.visualPrompt}${storyboardDraft.value.visualPrompt ? ' ' : ''}@${label} `
}

function selectContinuityShot(shot: ShotSummary): void {
  const prompt = storyboardDraft.value.visualPrompt.trim()
  const tokens = [`@片段衔接[镜头${shot.shotNo}]`, '@首尾帧参考']
  const missing = tokens.filter((token) => !prompt.includes(token))
  storyboardDraft.value.visualPrompt = [prompt, ...missing].filter(Boolean).join(' ')
  continuityOpen.value = false
}

async function generateSelectedVideo(): Promise<void> {
  if (!selectedShotId.value || videoGenerating.value) return
  if (!clipRehearsalReport.value?.ready) {
    videoGenerateMessage.value = '先运行片段预演，补齐并检查当前片段的关键帧与场景引用。'
    return
  }
  videoGenerating.value = true
  videoGenerateMessage.value = '正在提交 Agnes 单镜头任务…'
  try {
    await saveStoryboardDraft()
    const job = await generateStoryboardVideos(selectedShotId.value, {
      prompt: buildUnifiedStoryboardPrompt(storyboardDraft.value),
      durationSeconds: selectedShotSummary.value?.durationSeconds || undefined,
      candidateCount: 1,
    })
    videoGenerateMessage.value = `Agnes 任务 #${job.id} 已提交；只生成当前镜头的一个候选。`
    await loadDetailFor(selectedShotId.value)
  } catch (cause) {
    videoGenerateMessage.value = cause instanceof Error ? cause.message : '视频生成失败'
  } finally {
    videoGenerating.value = false
  }
}

function latestUsableFrame(images: Awaited<ReturnType<typeof listShotImages>>, role: string) {
  return images
    .filter((image) => image.frameRole === role && image.status !== 'failed' && image.status !== 'superseded')
    .sort((left, right) => right.versionNo - left.versionNo)[0] || null
}

async function waitForGenerationCompletion(jobId: number, label: string) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const job = await getGenerationJob(jobId)
    if (job.status === 'success') return job
    if (job.status === 'failed' || job.status === 'canceled') {
      throw new Error(job.errorText || `${label}失败（任务 #${jobId}）`)
    }
    clipRehearsalMessage.value = `${label}进行中 ${job.progressPercent}%（任务 #${jobId}）`
    await new Promise((resolve) => window.setTimeout(resolve, 2000))
  }
  throw new Error(`${label}仍在后台运行，任务 #${jobId}；刷新后可查看结果`)
}

async function rehearseCurrentClip(): Promise<void> {
  const sceneId = selectedSceneId.value
  const shots = currentShots()
  if (!sceneId || !shots.length || clipRehearsalBusy.value) return
  clipRehearsalBusy.value = true
  clipRehearsalReport.value = null
  clipRehearsalMessage.value = '正在核对分镜并补齐缺失关键帧…'
  try {
    const prepared = []
    let missingFrameCount = 0
    for (const shot of shots) {
      const [images, storyboard] = await Promise.all([
        listShotImages(shot.storyboardId),
        getStoryboard(shot.storyboardId),
      ])
      const startFrame = latestUsableFrame(images, 'start')
        || latestUsableFrame(images, 'primary')
        || (shot.imageUrl ? { imageUrl: shot.imageUrl } : null)
      const endFrame = latestUsableFrame(images, 'end')
        || (shot.endImageUrl ? { imageUrl: shot.endImageUrl } : null)
      prepared.push({ shot, storyboard, images, startFrame, endFrame })
      missingFrameCount += Number(!startFrame) + Number(!endFrame)
    }
    if (missingFrameCount && !window.confirm(
      `当前片段 ${shots.length} 个镜头缺少 ${missingFrameCount} 张首尾关键帧。将逐张生成缺失静帧，不会提交任何视频任务。继续？`,
    )) {
      clipRehearsalMessage.value = '已取消，未生成关键帧或视频。'
      return
    }

    let completedFrameCount = 0
    for (const item of prepared) {
      for (const role of ['start', 'end'] as const) {
        const existing = role === 'start' ? item.startFrame : item.endFrame
        if (existing) continue
        clipRehearsalMessage.value = `正在生成镜头 ${item.shot.shotNo} 的${role === 'start' ? '起始' : '结束'}关键帧（${completedFrameCount + 1}/${missingFrameCount}）`
        const job = await generateShotImages(item.shot.storyboardId, {
          frameRole: role,
          candidateCount: 1,
        })
        await waitForGenerationCompletion(job.id, '关键帧生成')
        completedFrameCount += 1
      }
    }

    const reportShots = await Promise.all(prepared.map(async (item) => {
      const images = await listShotImages(item.shot.storyboardId)
      const startFrame = latestUsableFrame(images, 'start')
        || latestUsableFrame(images, 'primary')
        || (item.shot.imageUrl ? { imageUrl: item.shot.imageUrl } : null)
      const endFrame = latestUsableFrame(images, 'end')
        || (item.shot.endImageUrl ? { imageUrl: item.shot.endImageUrl } : null)
      return {
        ...item.shot,
        visualPrompt: item.storyboard.visualPrompt || item.shot.primaryAction,
        assetReference: item.storyboard.assetReference,
        imageUrl: startFrame?.imageUrl || '',
        endImageUrl: endFrame?.imageUrl || '',
      }
    }))
    clipRehearsalReport.value = buildClipRehearsalReport({ sceneId, shots: reportShots })
    const report = clipRehearsalReport.value
    clipRehearsalMessage.value = report.ready
      ? `预演完成：${report.readyShotCount}/${report.shotCount} 镜关键帧与场景引用齐全；视频任务数 0。请逐镜查看后再决定生成范围。`
      : `预演完成：${report.readyShotCount}/${report.shotCount} 镜可用，${report.blockedShotCount} 镜有阻塞；没有提交视频任务。`
  } catch (cause) {
    clipRehearsalMessage.value = cause instanceof Error ? cause.message : '片段预演失败'
    clipRehearsalReport.value = null
  } finally {
    clipRehearsalBusy.value = false
  }
}

async function generateCurrentClipVideos(): Promise<void> {
  const report = clipRehearsalReport.value
  if (!report?.ready || clipVideoSubmitting.value || videoGenerating.value) return
  const shots = currentShots()
  const totalSeconds = shots.reduce((sum, shot) => sum + Number(shot.durationSeconds || 0), 0)
  if (!window.confirm(
    `将按当前模型配置，为当前片段的 ${shots.length} 个镜头各提交 1 个视频任务，合计约 ${totalSeconds} 秒。继续吗？`,
  )) return

  clipVideoSubmitting.value = true
  let submitted = 0
  try {
    for (const shot of shots) {
      const storyboard = await getStoryboard(shot.storyboardId)
      const job = await generateStoryboardVideos(shot.storyboardId, {
        prompt: buildUnifiedStoryboardPrompt({
          visualPrompt: storyboard.visualPrompt || '',
          actionText: storyboard.actionText || '',
          dialogueText: storyboard.dialogueText || '',
          startVisualPrompt: storyboard.startVisualPrompt || '',
          endVisualPrompt: storyboard.endVisualPrompt || '',
        }) || shot.primaryAction || '',
        durationSeconds: shot.durationSeconds || undefined,
        candidateCount: 1,
      })
      submitted += 1
      clipRehearsalMessage.value = `整段任务已提交 ${submitted}/${shots.length} 镜；视频仅在本次明确操作后生成。最近任务 #${job.id}`
    }
  } catch (cause) {
    clipRehearsalMessage.value = `已提交 ${submitted}/${shots.length} 镜；后续提交中断：${cause instanceof Error ? cause.message : '未知错误'}`
  } finally {
    clipVideoSubmitting.value = false
  }
}

async function exportCurrentEpisode(): Promise<void> {
  const projectId = snapshot.value?.context.projectId
  const episodeNo = snapshot.value?.context.episodeNo
  if (!projectId || !episodeNo || exportBusy.value) return
  exportBusy.value = true
  exportMessage.value = '正在整理本集素材…'
  try {
    const packageInfo = await getProjectDeliveryPackage(projectId, episodeNo)
    if (!packageInfo.clips.length) throw new Error('本集还没有可导出的镜头')
    const result = await downloadProjectDeliveryArchive(projectId, episodeNo, { includeMedia: true })
    const url = URL.createObjectURL(result.blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = result.fileName
    anchor.click()
    URL.revokeObjectURL(url)
    exportMessage.value = '本集已导出到本地'
  } catch (cause) {
    exportMessage.value = cause instanceof Error ? cause.message : '导出失败'
  } finally {
    exportBusy.value = false
  }
}

async function toggleCandidateOverview(): Promise<void> {
  candidateOverviewOpen.value = !candidateOverviewOpen.value
  if (
    !candidateOverviewOpen.value ||
    candidateOverviewItems.value.length ||
    candidateOverviewLoading.value ||
    !snapshot.value
  ) {
    return
  }

  candidateOverviewLoading.value = true
  reworkQueueMessage.value = ''
  try {
    candidateOverviewItems.value = await loadCandidateOverview(snapshot.value)
  } catch (cause) {
    reworkQueueMessage.value = cause instanceof Error ? cause.message : '候选总览加载失败，请稍后重试。'
  } finally {
    candidateOverviewLoading.value = false
  }
}

function selectedOverviewItems(items: CandidateOverviewItem[]): CandidateOverviewItem[] {
  return items.filter((item) => item.candidate.status === 'candidate' && !item.candidate.confirmed)
}

async function archiveOverviewCandidates(items: CandidateOverviewItem[]): Promise<void> {
  const candidates = selectedOverviewItems(items)
  if (!candidates.length) return
  if (!window.confirm(`确定归档 ${candidates.length} 个候选吗？历史媒体不会删除。`)) return

  pendingCandidateKey.value = 'overview-batch'
  try {
    for (const item of candidates) {
      await archiveProjectAsset(item.kind, item.candidate.id)
    }
    candidateOverviewItems.value = candidateOverviewItems.value.filter(
      (item) => !candidates.some((candidate) => candidate.key === item.key),
    )
    reworkQueueMessage.value = `已归档 ${candidates.length} 个候选，原始媒体仍保留在历史记录中。`
  } catch (cause) {
    reworkQueueMessage.value = cause instanceof Error ? cause.message : '批量归档失败，请检查网络后重试。'
  } finally {
    pendingCandidateKey.value = null
  }
}

function addOverviewRework(items: CandidateOverviewItem[]): void {
  const projectId = snapshot.value?.context.projectId
  if (!projectId) return
  const candidates = selectedOverviewItems(items)
  if (!candidates.length) return

  reworkQueue.value = enqueueReworkItems(
    projectId,
    candidates.map((item) => ({
      key: item.key,
      kind: item.kind,
      projectId,
      sceneId: item.sceneId,
      storyboardId: item.storyboardId,
      sceneNo: item.sceneNo,
      shotNo: item.shotNo,
      candidateId: item.candidate.id,
      versionNo: item.candidate.versionNo,
    })),
  )
  reworkQueueMessage.value = `已加入 ${candidates.length} 项返工队列；原候选保留，不会自动覆盖主版本。`
}

function openOverviewItem(item: CandidateOverviewItem): void {
  candidateOverviewOpen.value = false
  selectedSceneId.value = item.sceneId
  syncWorkspaceContext(item.storyboardId)
  applySceneSelection(item.sceneId, item.storyboardId)
}

function startReworkQueue(): void {
  const projectId = snapshot.value?.context.projectId
  if (!projectId) return
  const item = startNextReworkItem(projectId)
  if (!item) {
    reworkQueueMessage.value = '返工队列为空。'
    return
  }
  reworkQueue.value = readReworkQueue(projectId)
  router.push({
    path: item.kind === 'video' ? '/workspace/episodes/studio' : '/workspace/audio',
    query: {
      projectId: String(projectId),
      sceneId: String(item.sceneId),
      storyboardId: String(item.storyboardId),
      reworkCandidateId: String(item.candidateId),
    },
  })
}

function syncWorkspaceContext(storyboardId?: number | null) {
  const projectId = snapshot.value?.context.projectId
  if (!projectId) return
  setWorkspaceContext({
    projectId,
    episodeNo: snapshot.value?.context.episodeNo ?? undefined,
    productionRunId: snapshot.value?.context.runId ?? undefined,
    sceneId: selectedSceneId.value ?? undefined,
    storyboardId: storyboardId ?? undefined,
  })
}

/** 切换场景：保留项目上下文，重置到该场景第一个镜头。 */
function selectScene(sceneId: number) {
  selectedSceneId.value = sceneId
  syncWorkspaceContext()
  applySceneSelection(sceneId, null)
}

function applySceneSelection(sceneId: number | null, preferredShotId: number | undefined | null = null) {
  if (sceneId == null) return
  const shots = snapshot.value?.shotSummariesByScene[sceneId] || []
  const preferred = preferredShotId ? shots.find((shot) => shot.storyboardId === preferredShotId) : null
  const firstBlocked = shots.find((shot) => shot.blocked)
  const first = preferred || firstBlocked || shots[0] || null
  selectShotInner(first?.storyboardId ?? null)
}

async function selectShot(storyboardId: number) {
  selectedShotId.value = storyboardId
  continuityOpen.value = false
  subtitleCleanedVideoUrl.value = ''
  subtitleCleanupMessage.value = ''
  subtitleErased.value = false
  syncWorkspaceContext(storyboardId)
  await hydrateStoryboardDraft(storyboardId)
  await loadDetailFor(storyboardId)
}

function selectShotInner(storyboardId: number | null) {
  selectedShotId.value = storyboardId
  continuityOpen.value = false
  subtitleCleanedVideoUrl.value = ''
  subtitleCleanupMessage.value = ''
  subtitleErased.value = false
  syncWorkspaceContext(storyboardId)
  if (storyboardId == null) {
    detail.value = null
    return
  }
  void hydrateStoryboardDraft(storyboardId)
  void loadDetailFor(storyboardId)
}

function currentShots(): ShotSummary[] {
  const s = snapshot.value
  if (!s || selectedSceneId.value == null) return []
  return s.shotSummariesByScene[selectedSceneId.value] || []
}

const continuityCandidates = computed(() => {
  const shots = currentShots()
  const index = shots.findIndex((shot) => shot.storyboardId === selectedShotId.value)
  return index > 0 ? shots.slice(0, index).reverse() : []
})

const selectedShot = computed<ShotSummary | null>(() => {
  const shots = currentShots()
  return shots.find((sh) => sh.storyboardId === selectedShotId.value) ?? null
})

function prevShotOf(selected: ShotSummary): ShotSummary | null {
  const shots = currentShots()
  const idx = shots.findIndex((sh) => sh.storyboardId === selected.storyboardId)
  if (idx <= 0) return null
  return shots[idx - 1] ?? null
}

async function loadDetailFor(storyboardId: number) {
  const shot = currentShots().find((sh) => sh.storyboardId === storyboardId)
  if (!shot || !snapshot.value) {
    detail.value = null
    return false
  }
  detailLoading.value = true
  try {
    const prev = prevShotOf(shot)
    const d = await loadShotDetail(shot, prev, snapshot.value.audioByStoryboard, snapshot.value.costLedger)
    if (selectedShotId.value !== storyboardId) return false // 已切换镜头，丢弃过期结果
    detail.value = d
    return true
  } catch {
    detail.value = null
    return false
  } finally {
    detailLoading.value = false
  }
}

const previewVideoUrl = computed(() => subtitleCleanedVideoUrl.value || detail.value?.currentVideo?.url || '')

async function removeSubtitles(): Promise<void> {
  const videoId = detail.value?.currentVideo?.id
  if (!videoId || subtitleCleanupBusy.value) return
  subtitleCleanupBusy.value = true
  subtitleCleanupMessage.value = '正在生成无字幕派生视频…'
  try {
    const job = await removeVideoSubtitles(videoId)
    let current = job
    for (let attempt = 0; attempt < 180 && ['queued', 'running'].includes(current.status); attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1000))
      current = await getGenerationJob(job.id)
    }
    if (current.status !== 'success' || !current.result?.item?.videoUrl) {
      throw new Error(current.errorText || '字幕清理失败，请保留原视频并重试')
    }
    subtitleCleanedVideoUrl.value = current.result.item.videoUrl
    subtitleErased.value = true
    subtitleCleanupMessage.value = '无字幕版本已生成，原视频未被覆盖'
  } catch (cause) {
    subtitleCleanupMessage.value = cause instanceof Error ? cause.message : '字幕清理失败'
  } finally {
    subtitleCleanupBusy.value = false
  }
}

async function refreshAudioCandidates(projectId: number): Promise<void> {
  const items = await listProjectAudio(projectId)
  const audioByStoryboard = new Map<number, AudioAssetDTO[]>()
  for (const item of items) {
    if (typeof item.storyboardId !== 'number') continue
    const bucket = audioByStoryboard.get(item.storyboardId) || []
    bucket.push(item)
    audioByStoryboard.set(item.storyboardId, bucket)
  }
  if (snapshot.value?.context.projectId === projectId) {
    snapshot.value = { ...snapshot.value, audioByStoryboard }
  }
}

function mergeConfirmedAudio(confirmed: AudioAssetDTO): void {
  if (!snapshot.value || typeof confirmed.storyboardId !== 'number') return
  const existing = snapshot.value.audioByStoryboard.get(confirmed.storyboardId) || []
  const sameTrackScope = (item: AudioAssetDTO) =>
    item.trackType === confirmed.trackType &&
    (item.sceneId ?? null) === (confirmed.sceneId ?? null) &&
    (item.storyboardId ?? null) === (confirmed.storyboardId ?? null) &&
    (item.characterId ?? null) === (confirmed.characterId ?? null)
  let included = false
  const nextItems = existing.map((item) => {
    if (item.id === confirmed.id) {
      included = true
      return { ...item, ...confirmed }
    }
    if (sameTrackScope(item) && item.status === 'confirmed') {
      return { ...item, status: 'candidate', confirmedAt: null }
    }
    return item
  })
  if (!included) nextItems.push(confirmed)

  const audioByStoryboard = new Map(snapshot.value.audioByStoryboard)
  audioByStoryboard.set(confirmed.storyboardId, nextItems)
  snapshot.value = { ...snapshot.value, audioByStoryboard }
}

async function confirmCandidate(payload: { kind: 'video' | 'audio'; candidate: CandidateSummary }): Promise<void> {
  const projectId = snapshot.value?.context.projectId
  const storyboardId = selectedShotId.value
  if (!projectId || !storyboardId || pendingCandidateKey.value) return

  const { kind, candidate } = payload
  const assetKey = `${kind}:${candidate.id}`
  if (candidate.confirmed || !candidate.url) return

  pendingCandidateKey.value = assetKey
  candidateFeedback.value = null
  let audioRefreshWarning = ''
  try {
    if (kind === 'video') {
      await confirmVideo(candidate.id)
    } else {
      const confirmed = await confirmProjectAudio(candidate.id)
      try {
        await refreshAudioCandidates(projectId)
      } catch {
        mergeConfirmedAudio(confirmed)
        audioRefreshWarning = '音频已确认；项目音频清单刷新失败，当前主版本按服务端确认回执更新。'
      }
    }

    const refreshed = await loadDetailFor(storyboardId)
    candidateFeedback.value = {
      assetKey,
      tone: refreshed && !audioRefreshWarning ? 'success' : 'warning',
      message: audioRefreshWarning || (refreshed
        ? `v${candidate.versionNo} 已设为${kind === 'video' ? '视频' : '音频'}主版本。`
        : '服务端已确认，但镜头详情刷新失败；重新选择此镜头即可读取最新状态。'),
    }
  } catch (cause) {
    candidateFeedback.value = {
      assetKey,
      tone: 'error',
      message: cause instanceof Error ? cause.message : '确认失败，请检查网络后重试。',
    }
  } finally {
    pendingCandidateKey.value = null
  }
}

async function archiveCandidates(payload: {
  kind: 'video' | 'audio'
  candidates: CandidateSummary[]
}): Promise<void> {
  const storyboardId = selectedShotId.value
  if (!storyboardId || pendingCandidateKey.value || payload.candidates.length === 0) return

  const candidates = payload.candidates.filter((candidate) => !candidate.confirmed && candidate.status !== 'archived')
  if (candidates.length === 0) return

  pendingCandidateKey.value = 'batch'
  candidateFeedback.value = null
  try {
    for (const candidate of candidates) {
      await archiveProjectAsset(payload.kind, candidate.id)
    }
    const refreshed = await loadDetailFor(storyboardId)
    candidateFeedback.value = {
      assetKey: 'batch',
      tone: refreshed ? 'success' : 'warning',
      message: refreshed
        ? `已归档 ${candidates.length} 个${payload.kind === 'video' ? '视频' : '音频'}候选，历史记录仍保留。`
        : '候选已归档，但镜头详情刷新失败；重新选择此镜头即可读取最新状态。',
    }
  } catch (cause) {
    candidateFeedback.value = {
      assetKey: 'batch',
      tone: 'error',
      message: cause instanceof Error ? cause.message : '批量归档失败，请检查网络后重试。',
    }
    await loadDetailFor(storyboardId)
  } finally {
    pendingCandidateKey.value = null
  }
}

function focusCandidate(assetKey: string): void {
  if (candidateFeedback.value?.assetKey !== assetKey) candidateFeedback.value = null
}

const sceneLabel = computed(() => {
  if (selectedSceneId.value == null || !snapshot.value) return null
  const s = snapshot.value.scenes.find((sc) => sc.id === selectedSceneId.value)
  return s ? `片段 ${String(s.sceneNo).padStart(2, '0')}` : null
})

const currentClip = computed(() => {
  if (selectedSceneId.value == null || !snapshot.value) return null
  return snapshot.value.scenes.find((scene) => scene.id === selectedSceneId.value) || null
})

const currentClipDuration = computed(() =>
  currentShots().reduce((total, shot) => total + Number(shot.durationSeconds || 0), 0),
)

const shotLabel = computed(() => {
  const shot = selectedShot.value
  if (!shot) return null
  return `片段 ${String(shot.sceneNo).padStart(2, '0')} / 镜头 ${String(shot.shotNo).padStart(2, '0')}`
})

const prevShotLabel = computed(() => {
  const shot = selectedShot.value
  if (!shot) return null
  const prev = prevShotOf(shot)
  if (!prev) return null
  return `片段 ${String(prev.sceneNo).padStart(2, '0')} / 镜头 ${String(prev.shotNo).padStart(2, '0')}`
})

const completionPercent = computed<number | null>(() => {
  const fe = snapshot.value?.finalEdit
  const total = fe?.summary?.totalStoryboardCount
  const confirmed = fe?.summary?.confirmedVideoCount
  if (total == null || !total || confirmed == null) return null
  return Math.round((confirmed / total) * 100)
})

const currentNextAction = computed(() => detail.value?.nextAction ?? null)

const launchModules = [
  {
    key: 'script',
    index: '01',
    label: '剧本生成',
    description: '上传或输入故事想法，生成故事设定、分集大纲和可编辑剧本。',
    icon: 'edit_document',
    path: '/workspace/studio/idea',
  },
  {
    key: 'assets',
    index: '02',
    label: '资产管理',
    description: '同步角色与场景，进入无限画布整理提示词和一致性资产。',
    icon: 'account_tree',
    path: '/workspace/assets',
  },
  {
    key: 'storyboard',
    index: '03',
    label: '分镜视频生成',
    description: '按集拆分分镜，绑定资产与声音，逐镜头生成视频候选。',
    icon: 'movie',
    // 分镜视频生成使用一体化工作台，旧的 /workspace/storyboard 是单场景维护页，
    // 需要 sceneId，不能作为项目级入口。
    path: '/workspace/episodes',
  },
]

const isOverview = computed(() => route.query.view === 'overview' || !qnum(route.query.episodeNo))

const isEmptyStudio = computed(() => {
  const value = snapshot.value
  return Boolean(value && !value.context.episodeNo && !value.scenes.length)
})

function openStudioOverview(): void {
  const projectId = snapshot.value?.context.projectId
  if (!projectId) return
  router.replace({
    path: '/workspace/studio',
    query: { projectId: String(projectId), view: 'overview' },
  })
}

function closeStudioOverview(): void {
  const projectId = snapshot.value?.context.projectId
  if (!projectId) return
  router.replace({
    path: '/workspace/studio',
    query: { projectId: String(projectId) },
  })
}

function openEpisode(episodeNo: number): void {
  const projectId = snapshot.value?.context.projectId
  if (!projectId) return
  router.push({
    path: '/workspace/studio',
    query: { projectId: String(projectId), episodeNo: String(episodeNo) },
  })
}

async function generateEpisodeStoryboards(episodeNo: number): Promise<void> {
  const projectId = snapshot.value?.context.projectId
  if (!projectId) return
  const targetScenes = (await listScenes(projectId)).filter((scene) => (scene.episodeNo ?? 1) === episodeNo)
  if (!targetScenes.length) {
    openEpisode(episodeNo)
    return
  }
  episodeCardsLoading.value = true
  episodeCardsError.value = ''
  try {
    await Promise.all(targetScenes.map((scene) => generateStoryboards(scene.id)))
    showToast(`第 ${episodeNo} 集分镜脚本已生成`)
    openEpisode(episodeNo)
  } catch (cause) {
    episodeCardsError.value = cause instanceof Error ? cause.message : '分镜脚本生成失败'
  } finally {
    episodeCardsLoading.value = false
  }
}

function showToast(message: string): void {
  episodeCardsError.value = message
  window.setTimeout(() => {
    if (episodeCardsError.value === message) episodeCardsError.value = ''
  }, 3200)
}

function openAssetPromptEditor(asset: ProjectAssetItemDTO | CharacterDTO): void {
  assetPromptEditor.value = asset
  assetPromptText.value = '请根据当前剧本和镜头语境，保持该资产的外观、材质、色彩和空间关系一致。'
  assetPromptMessage.value = ''
}

function closeAssetPromptEditor(): void {
  if (assetPromptSaving.value) return
  assetPromptEditor.value = null
  assetPromptText.value = ''
  assetPromptMessage.value = ''
}

async function saveAssetPromptEditor(): Promise<void> {
  if (!assetPromptEditor.value || assetPromptSaving.value) return
  assetPromptSaving.value = true
  assetPromptMessage.value = '正在保存提示词…'
  await new Promise((resolve) => window.setTimeout(resolve, 320))
  assetPromptSaving.value = false
  assetPromptMessage.value = '提示词已保存，下一次生成会使用最新内容'
}

async function openLaunchModule(path: string): Promise<void> {
  const projectId = snapshot.value?.context.projectId
  if (!projectId) return
  if (path === '/workspace/studio/idea') {
    try {
      const project = await getProject(projectId)
      const nextPath = project.narrativeVision?.trim()
        ? '/workspace/studio/script'
        : '/workspace/studio/idea'
      router.push({ path: nextPath, query: { projectId: String(projectId) } })
    } catch {
      router.push({ path, query: { projectId: String(projectId) } })
    }
    return
  }
  router.push({
    path,
    query: {
      projectId: String(projectId),
      ...(path === '/workspace/studio' ? { view: 'overview' } : {}),
    },
  })
}

async function startCreation(): Promise<void> {
  const projectId = snapshot.value?.context.projectId
  if (!projectId) return
  await openLaunchModule('/workspace/studio/idea')
}

function focusNext() {
  const shot = selectedShot.value
  if (currentNextAction.value?.route && currentNextAction.value.route !== 'none') {
    handleShotAction(currentNextAction.value.route)
    return
  }
  if (shot) return
  const sceneId = selectedSceneId.value
  if (sceneId != null) applySceneSelection(sceneId)
}

function handleStageOpen(stageKey: string) {
  const projectId = snapshot.value?.context.projectId
  if (!projectId) return
  const query = {
    projectId: String(projectId),
    ...(selectedSceneId.value ? { sceneId: String(selectedSceneId.value) } : {}),
    ...(selectedShotId.value ? { storyboardId: String(selectedShotId.value) } : {}),
  }
  const pathByStage: Record<string, string> = {
    script: '/workspace/studio/script',
    assets: '/workspace/assets',
    'storyboard-video': '/workspace/episodes',
  }
  const path = pathByStage[stageKey]
  if (path) router.push({ path, query })
}

function handleStageRailToggle() {
  stageRailCollapsed.value = !stageRailCollapsed.value
}

function openEdit() {
  const p = snapshot.value?.context?.projectId
  router.push({
    path: '/workspace/edit',
    query: p
      ? {
          projectId: String(p),
          ...(selectedSceneId.value ? { sceneId: String(selectedSceneId.value) } : {}),
          ...(selectedShotId.value ? { storyboardId: String(selectedShotId.value) } : {}),
        }
      : {},
  })
}

function handleShotAction(action: ShotActionRoute) {
  const projectId = snapshot.value?.context.projectId
  const sceneId = selectedSceneId.value
  const storyboardId = selectedShotId.value
  if (!projectId || !action || action === 'none') return

  if (action === 'edit') {
    openEdit()
    return
  }

  const query = {
    projectId: String(projectId),
    ...(sceneId ? { sceneId: String(sceneId) } : {}),
    ...(storyboardId ? { storyboardId: String(storyboardId) } : {}),
  }
  const pathByAction: Record<Exclude<ShotActionRoute, 'edit' | 'none'>, string> = {
    storyboard: '/workspace/episodes',
    frame: '/workspace/episodes/studio',
    video: '/workspace/episodes/studio',
    audio: '/workspace/audio',
  }
  router.push({ path: pathByAction[action], query })
}

function goDashboard() {
  router.push('/dashboard')
}

watch(
  () => route.fullPath,
  () => {
    if (route.query.projectId) {
      selectedSceneId.value = null
      void load()
    }
  },
)

onMounted(() => {
  void load()
})
</script>

<template>
  <WorkspaceLayout :show-side="false" :show-inspector="false" self-managed-scroll no-padding>
    <div class="studio relative flex h-full min-h-0 flex-col">
      <ProductionContextBar
        v-if="snapshot"
        :context="snapshot.context"
        :scene-label="sceneLabel"
        :shot-label="shotLabel"
        :readiness="snapshot.readiness"
        :scene-id="selectedSceneId"
        :storyboard-id="selectedShotId"
      />
      <div v-if="snapshot && !isEmptyStudio" class="studio-overview-bar">
        <button type="button" class="studio-overview-link" @click="openStudioOverview">
          <span class="material-symbols-outlined">dashboard</span>
          创作总览
        </button>
        <span>返回四阶段工作台入口</span>
      </div>

      <!-- 小屏横向阶段条 -->
      <div v-if="snapshot" class="stage-strip-md flex gap-1 overflow-x-auto border-b border-outline-variant px-3 py-2 no-scrollbar lg:hidden">
        <span v-for="(s, i) in groupedStages" :key="s.key" class="stage-chip" :class="{ 'stage-chip--current': s.current }">
          {{ String(i + 1).padStart(2, '0') }} {{ s.label }}
          <b v-if="s.blockedCount" class="stage-chip-count">{{ s.blockedCount }}</b>
        </span>
      </div>

      <div class="studio-body flex min-h-0 flex-1">
        <div class="hidden lg:block">
          <ProductionStageRail
            v-if="snapshot"
            :stages="snapshot.stages"
            @open-stage="handleStageOpen"
            @toggle="handleStageRailToggle"
          />
        </div>

        <main class="studio-main flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-y-contain">
          <template v-if="loading">
            <div class="p-6 text-on-surface-variant">正在加载工作台上下文…</div>
          </template>

          <div v-else-if="error" class="p-6 text-danger-red">
            {{ error }}
            <button class="ml-3 border border-primary px-3 py-1 text-primary" type="button" @click="goDashboard()">返回项目总览</button>
          </div>

          <template v-else-if="snapshot && isOverview">
            <section class="studio-launch">
              <button v-if="!isEmptyStudio" type="button" class="studio-overview-close" @click="closeStudioOverview">
                <span class="material-symbols-outlined">arrow_back</span>
                返回当前生产
              </button>
              <div class="studio-launch-head">
                <div>
                  <p class="studio-launch-kicker">PROJECTDREAM / CREATION DESK</p>
                  <h1>从故事想法，到可生成的漫剧。</h1>
                  <p>沿着剧本、资产、分镜视频三步推进。每一步都保留可编辑结果，准备好后再进入下一阶段。</p>
                </div>
                <button type="button" class="studio-launch-primary" @click="startCreation">
                  <span class="material-symbols-outlined">play_arrow</span>
                  启动创作
                </button>
              </div>
              <div class="studio-launch-grid studio-launch-grid--three">
                <button
                  v-for="module in launchModules"
                  :key="module.key"
                  type="button"
                  class="studio-launch-card"
                  @click="openLaunchModule(module.path)"
                >
                  <span class="studio-launch-card-index">{{ module.index }}</span>
                  <span class="material-symbols-outlined studio-launch-card-icon">{{ module.icon }}</span>
                  <strong>{{ module.label }}</strong>
                  <span>{{ module.description }}</span>
                  <span class="studio-launch-card-arrow material-symbols-outlined">arrow_forward</span>
                </button>
              </div>
              <section v-if="false && (episodeCards.length || episodeCardsLoading)" class="episode-production-board">
                <div class="episode-production-board__head">
                  <div>
                    <p class="studio-launch-kicker">EPISODE WORKBENCH</p>
                    <h2>按集推进分镜与视频</h2>
                    <p>剧本集数已同步到这里。先进入一集，检查分镜脚本、资产和声音，再开始生成。</p>
                  </div>
                  <span class="episode-production-board__count">{{ episodeCards.length }} 集</span>
                </div>
                <div v-if="episodeCardsLoading" class="episode-production-skeleton" aria-live="polite">
                  正在同步剧本集数与分镜进度…
                </div>
                <div v-else-if="episodeCardsError" class="episode-production-error">
                  {{ episodeCardsError }}
                </div>
                <div v-else class="episode-production-grid">
                  <article v-for="episode in episodeCards" :key="episode.episodeNo" class="episode-production-card">
                    <div class="episode-production-card__index">{{ String(episode.episodeNo).padStart(2, '0') }}</div>
                    <div class="episode-production-card__body">
                      <div class="episode-production-card__top">
                        <div>
                          <span class="episode-production-card__eyebrow">EPISODE {{ String(episode.episodeNo).padStart(2, '0') }}</span>
                          <h3>{{ episode.title }}</h3>
                        </div>
                        <span class="episode-production-status" :class="`is-${episode.status}`">
                          {{ episode.status === 'ready' ? '已完成' : episode.status === 'in-progress' ? '制作中' : episode.status === 'storyboard' ? '待生成' : '待拆解' }}
                        </span>
                      </div>
                      <p>{{ episode.logline || '这集还没有可展示的剧情摘要。' }}</p>
                      <div class="episode-production-card__meta">
                        <span>{{ episode.sceneCount }} 场</span>
                        <span>{{ episode.shotCount }} 镜</span>
                        <span>{{ episode.generatedVideoCount }}/{{ episode.shotCount || 0 }} 视频</span>
                      </div>
                      <div class="episode-production-card__actions">
                        <button type="button" class="studio-launch-secondary" @click="openEpisode(episode.episodeNo)">
                          <span class="material-symbols-outlined">movie</span>
                          进入分镜工作台
                        </button>
                        <button type="button" class="episode-production-card__link" @click="generateEpisodeStoryboards(episode.episodeNo)">
                          <span class="material-symbols-outlined">auto_awesome</span>
                          {{ episode.shotCount ? '检查分镜脚本' : '生成分镜脚本' }}
                        </button>
                      </div>
                    </div>
                  </article>
                </div>
              </section>
              <div class="studio-launch-footer">
                <span><span class="material-symbols-outlined">verified</span>生成结果始终可以回看和微调，视频完成后可导入剪映等专业软件剪辑。</span>
              </div>
            </section>
          </template>

          <template v-else-if="snapshot">
            <EpisodeHeader
              :context="snapshot.context"
              :readiness="snapshot.readiness"
              :final-edit="snapshot.finalEdit"
              :completion-percent="completionPercent"
              :selected-shot-label="shotLabel"
              :next-action-label="currentNextAction?.label"
              :next-action-description="currentNextAction?.description"
              @next="focusNext"
            />
            <section class="episode-craft-shell">
              <aside class="episode-craft-assets">
                <div class="episode-craft-panel-head">
                  <div>
                    <span class="episode-craft-kicker">PROJECT ASSETS</span>
                    <h2>项目资产</h2>
                  </div>
                  <span class="episode-craft-count">{{ productionCharacters.length + projectAssets.length }}</span>
                </div>
                <div class="episode-craft-tabs">
                  <button type="button" :class="{ 'is-active': activeToolTab === 'assets' }" @click="activeToolTab = 'assets'">
                    <span class="material-symbols-outlined">inventory_2</span>
                    资产
                  </button>
                  <button type="button" :class="{ 'is-active': activeToolTab === 'tools' }" @click="activeToolTab = 'tools'">
                    <span class="material-symbols-outlined">construction</span>
                    工具
                  </button>
                </div>
                <div v-if="activeToolTab === 'assets'" class="episode-craft-asset-list">
                  <button
                    v-for="character in productionCharacters"
                    :key="`character-${character.id}`"
                    type="button"
                    class="episode-craft-asset"
                    @click="openAssetPromptEditor(character)"
                  >
                    <span class="episode-craft-asset__thumb">
                      <img v-if="character.referenceImageUrl" :src="character.referenceImageUrl" :alt="character.name" />
                      <span v-else>{{ character.name.slice(0, 1) }}</span>
                    </span>
                    <span class="episode-craft-asset__copy">
                      <strong>{{ character.name }}</strong>
                      <small>{{ character.roleTag || '角色' }}</small>
                    </span>
                    <span class="material-symbols-outlined">edit_note</span>
                  </button>
                  <div class="episode-craft-divider">场景与素材</div>
                  <button
                    v-for="asset in projectAssets.slice(0, 12)"
                    :key="`${asset.assetType}-${asset.id}`"
                    type="button"
                    class="episode-craft-asset episode-craft-asset--compact"
                    @click="openAssetPromptEditor(asset)"
                  >
                    <span class="episode-craft-asset__thumb episode-craft-asset__thumb--asset">
                      <img v-if="asset.previewUrl || asset.videoUrl || asset.audioUrl" :src="asset.previewUrl || asset.videoUrl || asset.audioUrl || ''" :alt="asset.name" />
                      <span v-else class="material-symbols-outlined">landscape</span>
                    </span>
                    <span class="episode-craft-asset__copy">
                      <strong>{{ asset.name }}</strong>
                      <small>{{ asset.assetType === 'video' ? '视频' : asset.assetType === 'image' ? '场景' : asset.assetType }}</small>
                    </span>
                    <span class="material-symbols-outlined">edit_note</span>
                  </button>
                  <p v-if="!productionCharacters.length && !projectAssets.length" class="episode-craft-empty">
                    还没有可调用的资产，请先完成资产解析。
                  </p>
                </div>
                <div v-else class="episode-craft-tool-list">
                  <button type="button" @click="continuityOpen = true">
                    <span class="material-symbols-outlined">link</span>
                    片段衔接
                    <small>先选择来源镜头，再继承确认尾帧</small>
                  </button>
                  <button type="button" @click="storyboardDraft.visualPrompt = `${storyboardDraft.visualPrompt} @首尾帧参考 `">
                    <span class="material-symbols-outlined">compare_arrows</span>
                    首尾帧参考
                    <small>把动作收尾写成下一镜头的起点</small>
                  </button>
                  <button type="button" @click="storyboardDraft.visualPrompt = `${storyboardDraft.visualPrompt} @环境音 `">
                    <span class="material-symbols-outlined">graphic_eq</span>
                    环境音提示
                    <small>补充空间声音与情绪节拍</small>
                  </button>
                  <div v-if="continuityOpen" class="episode-craft-continuity-picker" role="dialog" aria-label="选择片段衔接来源">
                    <div class="episode-craft-continuity-picker__head">
                      <strong>选择衔接来源</strong>
                      <button type="button" aria-label="关闭片段选择" @click="continuityOpen = false">
                        <span class="material-symbols-outlined">close</span>
                      </button>
                    </div>
                    <button
                      v-for="shot in continuityCandidates"
                      :key="`episode-craft-continuity-${shot.storyboardId}`"
                      type="button"
                      class="episode-craft-continuity-picker__option"
                      @click="selectContinuityShot(shot)"
                    >
                      <span class="material-symbols-outlined">movie</span>
                      <span><strong>镜头 {{ shot.shotNo }}</strong><small>{{ shot.primaryAction || '读取该镜头确认尾帧' }}</small></span>
                      <span class="material-symbols-outlined">add</span>
                    </button>
                    <p v-if="!continuityCandidates.length" class="episode-craft-continuity-picker__empty">当前镜头前没有可衔接的片段</p>
                  </div>
                </div>
              </aside>

              <section class="episode-craft-script">
                <div class="episode-craft-panel-head">
                  <div>
                    <span class="episode-craft-kicker">SHOT SCRIPT</span>
                    <h2>分镜脚本</h2>
                  </div>
                  <div class="episode-craft-panel-actions">
                    <span v-if="storyboardSaveMessage" class="episode-craft-save-state">{{ storyboardSaveMessage }}</span>
                    <button type="button" class="episode-craft-icon-button" title="保存分镜脚本" @click="saveStoryboardDraft">
                      <span class="material-symbols-outlined">save</span>
                    </button>
                  </div>
                </div>
                <div class="episode-craft-shot-strip">
                  <button
                    v-for="shot in currentShots()"
                    :key="shot.storyboardId"
                    type="button"
                    class="episode-craft-shot-chip"
                    :class="{ 'is-active': selectedShotId === shot.storyboardId }"
                    @click="selectShot(shot.storyboardId)"
                  >
                    <span>{{ shot.shotNo }}</span>
                    <small>{{ formatShotDuration(shot.durationSeconds) }}</small>
                  </button>
                  <span v-if="!currentShots().length" class="episode-craft-empty">当前片段还没有分镜。</span>
                </div>
                <div v-if="selectedShotId" class="episode-craft-form">
                  <div class="episode-craft-form-row episode-craft-form-row--three">
                    <label><span>景别</span><input v-model="storyboardDraft.shotType" placeholder="中景" /></label>
                    <label><span>机位</span><input v-model="storyboardDraft.cameraAngle" placeholder="平视" /></label>
                    <label><span>构图</span><input v-model="storyboardDraft.composition" placeholder="主体居中" /></label>
                  </div>
                  <label class="episode-craft-field">
                    <span>完整画面提示词 <em>输入 @ 调用已确认资产</em></span>
                    <textarea v-model="unifiedStoryboardPrompt" rows="13" placeholder="画面与资产：@角色 @场景 @道具，描述构图、光线、动作与运镜。&#10;&#10;动作与表演：写清动作过程、情绪变化和节奏。&#10;&#10;对白与声音：角色、语气、停顿、台词、音色与口型同步。&#10;&#10;起始帧衔接：动作开始状态。&#10;&#10;结束帧衔接：动作收束状态。"></textarea>
                  </label>
                  <div class="episode-craft-script-actions">
                    <button type="button" class="episode-craft-secondary" @click="saveStoryboardDraft">
                      <span class="material-symbols-outlined">check</span>
                      保存检查结果
                    </button>
                    <button type="button" class="episode-craft-primary" :disabled="videoGenerating" title="单镜头只提交当前分镜" @click="generateSelectedVideo">
                      <span class="material-symbols-outlined">{{ videoGenerating ? 'progress_activity' : 'movie_creation' }}</span>
                      {{ videoGenerating ? '正在提交' : '生成单镜视频' }}
                    </button>
                  </div>
                  <p v-if="videoGenerateMessage" class="episode-craft-feedback">{{ videoGenerateMessage }}</p>
                </div>
                <div v-else class="episode-craft-empty episode-craft-empty--large">
                  <span class="material-symbols-outlined">movie_edit</span>
                  <strong>选择一个镜头开始检查</strong>
                  <span>这里会显示 AI 拆解出的景别、机位、动作、对白和生成提示词。</span>
                </div>
              </section>

              <aside class="episode-craft-preview">
                <div class="episode-craft-panel-head">
                  <div>
                    <span class="episode-craft-kicker">PREVIEW</span>
                    <h2>视频预览</h2>
                  </div>
                  <button type="button" class="episode-craft-icon-button" title="放大预览" @click="previewZoomed = !previewZoomed">
                    <span class="material-symbols-outlined">{{ previewZoomed ? 'close_fullscreen' : 'fullscreen' }}</span>
                  </button>
                </div>
                <div class="episode-craft-player" :class="{ 'is-zoomed': previewZoomed }">
                  <video
                    v-if="previewVideoUrl"
                    :src="previewVideoUrl"
                    controls
                    playsinline
                  ></video>
                  <div v-else class="episode-craft-player__empty">
                    <span class="material-symbols-outlined">movie</span>
                    <strong>等待视频生成</strong>
                    <span>生成后的镜头会在这里预览。</span>
                  </div>
                  <div v-if="previewVideoUrl" class="episode-craft-player__tools">
                    <button type="button" :class="{ 'is-active': subtitleErased }" :disabled="subtitleCleanupBusy" @click="removeSubtitles">
                      <span class="material-symbols-outlined">subtitles_off</span>
                      {{ subtitleCleanupBusy ? '处理中' : subtitleErased ? '已生成无字幕版' : '生成无字幕版' }}
                    </button>
                    <button type="button" @click="previewZoomed = true">
                      <span class="material-symbols-outlined">zoom_in</span>
                      放大查看
                    </button>
                  </div>
                  <p v-if="subtitleCleanupMessage" class="episode-craft-player__message" role="status">{{ subtitleCleanupMessage }}</p>
                </div>
                <div class="episode-craft-checks">
                  <div><span>人物与场景</span><strong :class="{ 'is-ready': Boolean(detail?.voice?.characterName) }">{{ detail?.voice?.characterName ? '已绑定' : '待检查' }}</strong></div>
                  <div><span>角色音色</span><strong :class="{ 'is-ready': Boolean(detail?.voice?.locked) }">{{ detail?.voice?.locked ? '已锁定' : '待绑定' }}</strong></div>
                  <div><span>连续性</span><strong :class="{ 'is-ready': Boolean(detail?.continuity?.hasPrevEndFrame) }">{{ detail?.continuity?.hasPrevEndFrame ? '已接续' : '可选' }}</strong></div>
                </div>
              </aside>
            </section>

            <section class="episode-timeline">
              <div class="episode-timeline__head">
                <div>
                  <span class="episode-craft-kicker">EPISODE TIMELINE</span>
                  <h2>本集剧情片段</h2>
                </div>
                <div class="episode-timeline__actions">
                  <span>{{ currentShots().length }} 个镜头</span>
                  <button type="button" class="episode-craft-secondary" :disabled="exportBusy" @click="exportCurrentEpisode">
                    <span class="material-symbols-outlined">download</span>
                    {{ exportBusy ? '正在导出' : '导出本集到本地' }}
                  </button>
                </div>
              </div>
              <div class="episode-timeline__track" role="list" aria-label="本集镜头时间线">
                <button
                  v-for="shot in currentShots()"
                  :key="shot.storyboardId"
                  type="button"
                  class="episode-timeline__item"
                  :class="{ 'is-active': selectedShotId === shot.storyboardId }"
                  @click="selectShot(shot.storyboardId)"
                >
                  <span class="episode-timeline__item-thumb">
                    <img v-if="shot.videoUrl || shot.imageUrl" :src="shot.videoUrl || shot.imageUrl || ''" :alt="`${shot.shotNo} 画面缩略图`" loading="lazy" />
                    <span v-else class="material-symbols-outlined">movie</span>
                    <span v-if="shot.videoUrl" class="episode-timeline__item-play material-symbols-outlined">play_arrow</span>
                    <span class="episode-timeline__item-duration">{{ formatShotDuration(shot.durationSeconds) }}</span>
                  </span>
                  <span class="episode-timeline__item-copy">
                    <strong>{{ shot.shotNo }}</strong>
                    <small>{{ shot.primaryAction || shot.dialogueText || '待补充镜头内容' }}</small>
                  </span>
                </button>
                <p v-if="!currentShots().length" class="episode-craft-empty">生成分镜脚本后，这里会按镜头排列本集剧情片段。</p>
              </div>
              <p v-if="exportMessage" class="episode-craft-feedback">{{ exportMessage }}</p>
            </section>

            <Transition name="asset-prompt">
              <div v-if="assetPromptEditor" class="asset-prompt-backdrop" @click.self="closeAssetPromptEditor">
                <section class="asset-prompt-dialog" role="dialog" aria-modal="true" aria-labelledby="asset-prompt-title">
                  <header class="asset-prompt-dialog__head">
                    <div>
                      <span class="episode-craft-kicker">ASSET PROMPT</span>
                      <h2 id="asset-prompt-title">{{ assetPromptEditor.name }}</h2>
                    </div>
                    <button type="button" class="episode-craft-icon-button" aria-label="关闭提示词编辑" @click="closeAssetPromptEditor">
                      <span class="material-symbols-outlined">close</span>
                    </button>
                  </header>
                  <img
                    v-if="'previewUrl' in assetPromptEditor && assetPromptEditor.previewUrl"
                    class="asset-prompt-dialog__image"
                    :src="assetPromptEditor.previewUrl"
                    :alt="assetPromptEditor.name"
                  />
                  <img
                    v-else-if="'referenceImageUrl' in assetPromptEditor && assetPromptEditor.referenceImageUrl"
                    class="asset-prompt-dialog__image"
                    :src="assetPromptEditor.referenceImageUrl"
                    :alt="assetPromptEditor.name"
                  />
                  <label class="episode-craft-field">
                    <span>资产提示词</span>
                    <textarea v-model="assetPromptText" rows="7" placeholder="描述该角色或场景在当前镜头中的外观与状态"></textarea>
                  </label>
                  <p class="asset-prompt-dialog__message" aria-live="polite">{{ assetPromptMessage }}</p>
                  <footer>
                    <button type="button" class="episode-craft-secondary" @click="closeAssetPromptEditor">取消</button>
                    <button type="button" class="episode-craft-primary" :disabled="assetPromptSaving || !assetPromptText.trim()" @click="saveAssetPromptEditor">
                      <span class="material-symbols-outlined">{{ assetPromptSaving ? 'progress_activity' : 'save' }}</span>
                      {{ assetPromptSaving ? '保存中…' : '保存并用于本镜' }}
                    </button>
                  </footer>
                </section>
              </div>
            </Transition>

            <div class="studio-view-tools" aria-label="工作区工具">
              <div class="studio-view-summary">
                <span class="studio-view-summary-label">当前镜头</span>
                <strong>{{ shotLabel || '未选择镜头' }}</strong>
                <span v-if="detail?.continuity.primaryAction" class="studio-view-summary-action">
                  {{ detail.continuity.primaryAction }}
                </span>
              </div>
              <div class="studio-view-actions">
                <button
                  type="button"
                  class="studio-tool-button"
                  :aria-pressed="candidateOverviewOpen"
                  :aria-expanded="candidateOverviewOpen"
                  @click="toggleCandidateOverview"
                >
                  <span class="material-symbols-outlined text-sm">view_comfy_alt</span>
                  候选总览
                  <span v-if="candidateOverviewItems.length" class="studio-tool-count">
                    {{ candidateOverviewItems.length }}
                  </span>
                </button>
                <button
                  type="button"
                  class="studio-tool-button"
                  :aria-pressed="inspectorOpen"
                  :aria-expanded="inspectorOpen"
                  @click="inspectorOpen = !inspectorOpen"
                >
                  <span class="material-symbols-outlined text-sm">fact_check</span>
                  {{ inspectorOpen ? '收起检查' : '查看检查' }}
                </button>
                <button
                  type="button"
                  class="studio-tool-button"
                  :aria-pressed="timelineOpen"
                  :aria-expanded="timelineOpen"
                  @click="timelineOpen = !timelineOpen"
                >
                  <span class="material-symbols-outlined text-sm">timeline</span>
                  {{ timelineOpen ? '收起时间线' : '预览时间线' }}
                </button>
              </div>
            </div>
            <section class="clip-rehearsal" aria-label="片段预演">
              <div class="clip-rehearsal__head">
                <div>
                  <span class="episode-craft-kicker">CLIP REHEARSAL</span>
                  <h2>片段预演</h2>
                  <p>预演只检查连续性，不创建视频任务。需要补关键帧时会先询问，再逐镜生成静帧。</p>
                </div>
                <div class="clip-rehearsal__actions">
                  <button
                    type="button"
                    class="episode-craft-secondary"
                    :disabled="clipRehearsalBusy || !currentShots().length"
                    @click="rehearseCurrentClip"
                  >
                    <span class="material-symbols-outlined">{{ clipRehearsalBusy ? 'progress_activity' : 'fact_check' }}</span>
                    {{ clipRehearsalBusy ? '正在预演' : '检查片段连续性' }}
                  </button>
                  <button
                    v-if="clipRehearsalReport?.ready"
                    type="button"
                    class="episode-craft-primary"
                    :disabled="clipVideoSubmitting"
                    title="整段按镜头分别提交视频任务"
                    @click="generateCurrentClipVideos"
                  >
                    <span class="material-symbols-outlined">{{ clipVideoSubmitting ? 'progress_activity' : 'movie_creation' }}</span>
                    {{ clipVideoSubmitting ? '正在提交' : '按镜头生成整段视频' }}
                  </button>
                </div>
              </div>
              <p v-if="clipRehearsalMessage" class="clip-rehearsal__message" role="status">{{ clipRehearsalMessage }}</p>
              <div v-if="clipRehearsalReport" class="clip-rehearsal__results">
                <article
                  v-for="item in clipRehearsalReport.shots"
                  :key="`rehearsal-${item.storyboardId}`"
                  class="clip-rehearsal__shot"
                  :class="{ 'is-ready': item.ready, 'is-blocked': !item.ready }"
                >
                  <div class="clip-rehearsal__shot-title">
                    <strong>镜头 {{ item.shotNo }}</strong>
                    <span>{{ item.ready ? '关键帧齐全' : '需补齐' }}</span>
                  </div>
                  <div class="clip-rehearsal__frames">
                    <figure>
                      <img v-if="item.startUrl" :src="item.startUrl" :alt="`镜头 ${item.shotNo} 起始关键帧`" />
                      <span v-else class="material-symbols-outlined">image</span>
                      <figcaption>起始</figcaption>
                    </figure>
                    <figure>
                      <img v-if="item.endUrl" :src="item.endUrl" :alt="`镜头 ${item.shotNo} 结束关键帧`" />
                      <span v-else class="material-symbols-outlined">image</span>
                      <figcaption>结束</figcaption>
                    </figure>
                  </div>
                  <ul v-if="item.blockers.length" class="clip-rehearsal__blockers">
                    <li v-for="blocker in item.blockers" :key="blocker">{{ blocker }}</li>
                  </ul>
                </article>
              </div>
              <div v-if="clipRehearsalReport?.transitions.length" class="clip-rehearsal__transitions">
                <span
                  v-for="(transition, index) in clipRehearsalReport.transitions"
                  :key="`transition-${index}`"
                  :class="{ 'is-ready': transition.status === 'ready-for-review', 'is-blocked': transition.status === 'blocked' }"
                >
                  镜头 {{ index + 1 }} 尾帧
                  <span class="material-symbols-outlined">trending_flat</span>
                  镜头 {{ index + 2 }} 首帧
                  <strong>{{ transition.status === 'ready-for-review' ? '待人工核对' : '缺少关键帧' }}</strong>
                </span>
              </div>
            </section>
            <SceneStrip :scenes="snapshot.scenes" :selected-scene-id="selectedSceneId" @select="selectScene" />
            <section v-if="currentClip" class="clip-context" aria-label="当前片段">
              <div class="clip-context__identity">
                <span class="material-symbols-outlined" aria-hidden="true">movie_filter</span>
                <div>
                  <h2>片段 {{ String(currentClip.sceneNo).padStart(2, '0') }} · {{ currentClip.title || currentClip.location || '未命名片段' }}</h2>
                  <p>本片段场景设定在 <strong>{{ currentClip.location || currentClip.title || '待完善场景' }}</strong><span v-if="currentClip.timeOfDay"> · {{ currentClip.timeOfDay }}</span></p>
                </div>
              </div>
              <div class="clip-context__facts">
                <span><span class="material-symbols-outlined" aria-hidden="true">lock</span>片段内镜头共用此场景资产</span>
                <span>{{ currentShots().length }} 镜</span>
                <span>{{ formatAggregateDuration(currentClipDuration) }}</span>
              </div>
            </section>
            <StoryboardGrid
              :shots="currentShots()"
              :selected-shot-id="selectedShotId"
              @select="selectShot"
            />

            <Transition name="candidate-overview">
              <div v-if="candidateOverviewOpen" class="candidate-overview-wrap">
                <CandidateOverview
                  :items="candidateOverviewItems"
                  :pending="candidateOverviewLoading"
                  @open="openOverviewItem"
                  @archive="archiveOverviewCandidates"
                  @rework="addOverviewRework"
                />
                <div v-if="reworkQueue.length" class="rework-queue-strip" role="status">
                  <div class="rework-queue-copy">
                    <span class="rework-queue-kicker">REWORK QUEUE</span>
                    <strong>{{ reworkSummary.queued }} 项待处理</strong>
                    <span>
                      {{ reworkSummary.inProgress }} 项处理中 · {{ reworkSummary.completed }} 项已完成
                    </span>
                  </div>
                  <button
                    type="button"
                    class="rework-queue-action"
                    :disabled="reworkSummary.queued === 0"
                    @click="startReworkQueue"
                  >
                    <span class="material-symbols-outlined text-sm">play_arrow</span>
                    处理下一项
                  </button>
                </div>
                <p v-if="reworkQueueMessage" class="rework-queue-message" aria-live="polite">
                  {{ reworkQueueMessage }}
                </p>
              </div>
            </Transition>

            <div class="px-4 pb-4">
              <ShotProductionCard
                v-if="detail"
                :detail="detail"
                :shot="selectedShot!"
                :prev-shot-label="prevShotLabel"
                :pending-candidate-key="pendingCandidateKey"
                :candidate-feedback="candidateFeedback"
                :key="detail.storyboardId"
                @action="handleShotAction"
                @candidate-focus="focusCandidate"
                @confirm-candidate="confirmCandidate"
                @archive-candidates="archiveCandidates"
              />
              <div v-else-if="!detailLoading" class="production-empty">
                选择左侧故事板中的一个镜头，查看完整生产卡。
              </div>
            </div>
          </template>
        </main>

        <aside
          v-if="snapshot"
          class="inspector-drawer"
          :class="{ 'is-open': inspectorOpen }"
          :aria-hidden="!inspectorOpen"
          :inert="!inspectorOpen"
          aria-label="当前镜头检查"
        >
          <div class="inspector-drawer-head">
            <div class="inspector-drawer-title">
              <span>镜头检查</span>
              <strong>{{ shotLabel || '未选择镜头' }}</strong>
            </div>
            <button type="button" aria-label="关闭检查面板" @click="inspectorOpen = false">
              <span class="material-symbols-outlined">close</span>
            </button>
          </div>
          <ProductionInspector :detail="detail" :shot-label="shotLabel" />
        </aside>
      </div>

      <div
        v-if="snapshot"
        class="timeline-dock"
        :class="{
          'is-open': timelineOpen,
          'timeline-dock--stage-collapsed': stageRailCollapsed,
        }"
        :aria-hidden="!timelineOpen"
        :inert="!timelineOpen"
      >
        <ProductionLightTimeline
          :final-edit="snapshot.finalEdit"
          :project-id="snapshot.context.projectId"
          @open-edit="openEdit"
        />
      </div>
    </div>
  </WorkspaceLayout>
</template>

<style scoped>
.studio {
  background: #0f120f;
}

.studio-launch {
  min-height: 100%;
  padding: clamp(2rem, 6vw, 5.5rem) clamp(1rem, 5vw, 5rem);
  background:
    linear-gradient(115deg, rgba(255, 183, 125, 0.08), transparent 38%),
    #0f120f;
}
.studio-overview-bar {
  display: flex;
  min-height: 2.7rem;
  align-items: center;
  gap: 0.7rem;
  border-bottom: 1px solid rgba(255, 183, 125, 0.12);
  background: #111311;
  padding: 0.35rem 1rem;
  color: #8d897f;
  font-size: 0.68rem;
}
.studio-overview-link {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  border: 1px solid rgba(255, 183, 125, 0.3);
  padding: 0.38rem 0.58rem;
  color: #e9d8c4;
  font-weight: 700;
  transition: border-color 180ms ease, background-color 180ms ease, color 180ms ease;
}
.studio-overview-link:hover {
  border-color: #ffb77d;
  background: rgba(255, 183, 125, 0.1);
  color: #ffb77d;
}
.studio-overview-link .material-symbols-outlined {
  font-size: 0.95rem;
}
.studio-overview-close {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  margin-bottom: 1.25rem;
  border: 1px solid rgba(255, 183, 125, 0.3);
  padding: 0.45rem 0.65rem;
  color: #c8b6a3;
  font-size: 0.72rem;
  transition: border-color 180ms ease, color 180ms ease, background-color 180ms ease;
}
.studio-overview-close:hover {
  border-color: #ffb77d;
  background: rgba(255, 183, 125, 0.08);
  color: #ffb77d;
}
.studio-overview-close .material-symbols-outlined {
  font-size: 0.95rem;
}
.studio-launch-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 2rem;
  max-width: 72rem;
  margin: 0 auto 3rem;
}
.studio-launch-kicker {
  color: #ffb77d;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.65rem;
  font-weight: 800;
  letter-spacing: 0.2em;
}
.studio-launch-head h1 {
  max-width: 42rem;
  margin-top: 0.9rem;
  color: #f3ede5;
  font-size: clamp(1.9rem, 4vw, 3.6rem);
  line-height: 1.08;
}
.studio-launch-head p:last-child {
  max-width: 42rem;
  margin-top: 1rem;
  color: #a7a097;
  font-size: 0.88rem;
  line-height: 1.8;
}
.studio-launch-primary,
.studio-launch-secondary {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  flex: 0 0 auto;
  min-height: 2.75rem;
  border: 1px solid #ffb77d;
  padding: 0 1rem;
  color: #22170e;
  background: #ffb77d;
  font-size: 0.78rem;
  font-weight: 800;
  transition: transform 180ms ease, filter 180ms ease;
}
.studio-launch-primary:hover,
.studio-launch-secondary:hover {
  filter: brightness(1.08);
  transform: translateY(-2px);
}
.studio-launch-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  max-width: 72rem;
  margin: 0 auto;
  border-top: 1px solid rgba(255, 183, 125, 0.3);
  border-left: 1px solid rgba(255, 183, 125, 0.16);
}
.studio-launch-card {
  position: relative;
  display: flex;
  min-height: 19rem;
  flex-direction: column;
  align-items: flex-start;
  border-right: 1px solid rgba(255, 183, 125, 0.16);
  border-bottom: 1px solid rgba(255, 183, 125, 0.16);
  padding: 1.35rem;
  color: #ddd4c9;
  text-align: left;
  background: rgba(21, 25, 21, 0.72);
  transition: background-color 220ms ease, transform 220ms cubic-bezier(0.22, 1, 0.36, 1), color 220ms ease;
}
.studio-launch-card:hover {
  z-index: 1;
  color: #fff3e6;
  background: rgba(255, 183, 125, 0.1);
  transform: translateY(-0.35rem);
}
.studio-launch-card-index {
  color: #ffb77d;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.65rem;
}
.studio-launch-card-icon {
  margin-top: 3.5rem;
  color: #ffb77d;
  font-size: 2rem;
}
.studio-launch-card strong {
  margin-top: 1rem;
  font-size: 1.05rem;
}
.studio-launch-card span:not(.studio-launch-card-index):not(.studio-launch-card-arrow) {
  margin-top: 0.7rem;
  color: #948d84;
  font-size: 0.72rem;
  line-height: 1.7;
}
.studio-launch-card-arrow {
  position: absolute;
  right: 1.35rem;
  bottom: 1.35rem;
  color: #ffb77d;
  transition: transform 180ms ease;
}
.studio-launch-card:hover .studio-launch-card-arrow {
  transform: translateX(0.25rem);
}
.studio-launch-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  max-width: 72rem;
  margin: 1rem auto 0;
  color: #807a72;
  font-size: 0.68rem;
}
.studio-launch-footer > span {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}
.studio-launch-footer > span .material-symbols-outlined {
  color: #83b68c;
  font-size: 1rem;
}
.studio-launch-secondary {
  min-height: 2.2rem;
  border-color: rgba(255, 183, 125, 0.35);
  color: #d5b28e;
  background: transparent;
}

.studio-view-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid rgba(255, 183, 125, 0.14);
  background: #121512;
  padding: 0.85rem 1.35rem;
}

.studio-view-summary {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 0.75rem;
}

.studio-view-summary-label {
  color: #8d857c;
  font-size: 0.6rem;
  font-weight: 800;
  letter-spacing: 0.12em;
}

.studio-view-summary strong {
  color: #f1ece4;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.78rem;
}

.studio-view-summary-action {
  min-width: 0;
  overflow: hidden;
  color: #a6a49d;
  font-size: 0.72rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.studio-view-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 0.45rem;
}

.studio-tool-button {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-height: 2rem;
  border: 1px solid rgba(164, 132, 84, 0.32);
  padding: 0 0.6rem;
  color: #b8b1a8;
  font-size: 0.68rem;
  font-weight: 700;
  transition: border-color 160ms ease, color 160ms ease, background-color 160ms ease;
}

.studio-tool-button:focus-visible {
  outline: 2px solid #ffb77d;
  outline-offset: 2px;
}

.studio-tool-button:hover,
.studio-tool-button[aria-pressed='true'] {
  border-color: rgba(255, 183, 125, 0.65);
  background: rgba(255, 183, 125, 0.09);
  color: #ffd9b0;
}

.studio-tool-count {
  display: inline-flex;
  min-width: 1.15rem;
  height: 1.15rem;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 183, 125, 0.28);
  background: rgba(255, 183, 125, 0.1);
  color: #ffcf9f;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.55rem;
  font-variant-numeric: tabular-nums;
}

.candidate-overview-wrap {
  margin: 0 1rem 1rem;
  border: 1px solid rgba(255, 183, 125, 0.16);
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.14);
}

.candidate-overview-enter-active,
.candidate-overview-leave-active {
  overflow: hidden;
  transition: opacity 220ms ease, transform 260ms cubic-bezier(0.22, 1, 0.36, 1);
}

.candidate-overview-enter-from,
.candidate-overview-leave-to {
  opacity: 0;
  transform: translateY(-0.55rem);
}

.rework-queue-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-top: 1px solid rgba(255, 183, 125, 0.14);
  background: #141714;
  padding: 0.72rem 0.9rem;
}

.rework-queue-copy {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 0.65rem;
}

.rework-queue-kicker {
  color: #d4a97f;
  font-size: 0.54rem;
  font-weight: 800;
  letter-spacing: 0.14em;
}

.rework-queue-copy strong {
  color: #f0e6db;
  font-size: 0.7rem;
}

.rework-queue-copy > span:last-child {
  overflow: hidden;
  color: #8f877e;
  font-size: 0.61rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rework-queue-action {
  display: inline-flex;
  flex: 0 0 auto;
  min-height: 2rem;
  align-items: center;
  gap: 0.32rem;
  border: 1px solid rgba(255, 183, 125, 0.42);
  padding: 0 0.65rem;
  color: #ffd9b0;
  font-size: 0.63rem;
  font-weight: 800;
  transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease, opacity 160ms ease;
}

.rework-queue-action:hover:not(:disabled) {
  border-color: rgba(255, 183, 125, 0.72);
  background: rgba(255, 183, 125, 0.1);
}

.rework-queue-action:disabled {
  cursor: not-allowed;
  opacity: 0.44;
}

.rework-queue-action:focus-visible {
  outline: 2px solid #ffb77d;
  outline-offset: 2px;
}

.rework-queue-message {
  margin: 0;
  border-top: 1px solid rgba(255, 183, 125, 0.08);
  background: #111411;
  padding: 0.58rem 0.9rem 0.68rem;
  color: #c4ad98;
  font-size: 0.63rem;
}

.inspector-drawer {
  position: relative;
  display: flex;
  width: 0;
  min-width: 0;
  flex: 0 0 0;
  flex-direction: column;
  border-left: 1px solid rgba(164, 132, 84, 0.4);
  background: #0d100d;
  box-shadow: -12px 0 28px rgba(0, 0, 0, 0.18);
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  transform: translateX(1.2rem);
  transition:
    flex-basis 220ms cubic-bezier(0.22, 1, 0.36, 1),
    width 220ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 160ms ease,
    transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
.inspector-drawer.is-open {
  width: min(21rem, 28vw);
  flex-basis: min(21rem, 28vw);
  opacity: 1;
  pointer-events: auto;
  transform: translateX(0);
}
.studio-body {
  position: relative;
}
.studio-body:has(.inspector-drawer) .studio-main {
  min-width: 0;
}

.timeline-dock {
  display: flex;
  min-height: 0;
  height: 0;
  margin-left: 13rem;
  flex: 0 0 auto;
  overflow: hidden;
  border-top: 1px solid transparent;
  opacity: 0;
  transform: translateY(0.75rem);
  pointer-events: none;
  transition:
    height 300ms cubic-bezier(0.22, 1, 0.36, 1),
    margin-left 260ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 180ms ease,
    transform 260ms cubic-bezier(0.22, 1, 0.36, 1);
}
.timeline-dock.is-open {
  height: clamp(15rem, 34vh, 20.5rem);
  flex-basis: clamp(15rem, 34vh, 20.5rem);
  border-top-color: rgba(255, 183, 125, 0.2);
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}
.timeline-dock--stage-collapsed {
  margin-left: 3.25rem;
}
.timeline-dock > .timeline {
  width: 100%;
  min-height: 0;
  flex: 1;
}

.inspector-drawer-head {
  display: flex;
  min-height: 4.15rem;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid rgba(255, 183, 125, 0.16);
  padding: 0.7rem 0.95rem 0.75rem 1.1rem;
  color: #f1ece4;
}
.inspector-drawer-title {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.22rem;
}
.inspector-drawer-title span {
  color: #ffb77d;
  font-size: 0.56rem;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.inspector-drawer-title strong {
  overflow: hidden;
  color: #f1ece4;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inspector-drawer-head button {
  display: inline-flex;
  width: 1.8rem;
  height: 1.8rem;
  align-items: center;
  justify-content: center;
  color: #a6a49d;
  transition: background-color 160ms ease, color 160ms ease;
}
.inspector-drawer-head button:hover {
  background: rgba(255, 183, 125, 0.1);
  color: #ffd9b0;
}
.inspector-drawer-head button:focus-visible {
  outline: 2px solid #ffb77d;
  outline-offset: 2px;
}

.inspector-drawer > .inspector {
  width: 100%;
  min-height: 0;
  flex: 1;
  border-left: 0;
}
.stage-strip-md {
  scrollbar-width: none;
}
.stage-chip {
  flex: 0 0 auto;
  border: 1px solid #2c2c28;
  padding: 0.2rem 0.55rem;
  color: #8d857c;
  font-size: 0.64rem;
  white-space: nowrap;
}
.stage-chip--current {
  border-color: #ffb77d;
  color: #ffd9b0;
  background: rgba(255, 183, 125, 0.08);
}
.stage-chip-count {
  display: inline-flex;
  min-width: 1rem;
  height: 1rem;
  align-items: center;
  justify-content: center;
  margin-left: 0.25rem;
  background: rgba(202, 84, 74, 0.2);
  color: #ff9d94;
  font-size: 0.58rem;
  font-weight: 800;
}
.stage-chip:hover {
  border-color: rgba(255, 183, 125, 0.5);
}
.inspector-toggle {
  position: absolute;
  top: 5rem;
  right: 0;
  z-index: 20;
  display: inline-flex;
  height: 2.2rem;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 183, 125, 0.4);
  background: #161817;
  padding: 0 0.5rem;
  color: #ffd9b0;
}
.production-empty {
  border: 1px dashed #2c2c28;
  padding: 1.2rem;
  color: #837c73;
  font-size: 0.78rem;
}

.episode-production-board {
  margin-top: 3rem;
  border-top: 1px solid rgba(255, 183, 125, 0.18);
  padding-top: 1.5rem;
}
.episode-production-board__head,
.episode-timeline__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
}
.episode-production-board__head h2,
.episode-timeline__head h2 {
  margin-top: 0.3rem;
  color: #f1ece4;
  font-family: 'Noto Serif SC', serif;
  font-size: 1.15rem;
  font-weight: 650;
}
.episode-production-board__head p {
  max-width: 38rem;
  margin-top: 0.45rem;
  color: #958b80;
  font-size: 0.76rem;
  line-height: 1.65;
}
.episode-production-board__count {
  border: 1px solid rgba(255, 183, 125, 0.28);
  padding: 0.35rem 0.55rem;
  color: #ffd9b0;
  font-size: 0.7rem;
  font-weight: 700;
}
.episode-production-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
  margin-top: 1.2rem;
}
.episode-production-card {
  display: flex;
  min-height: 12rem;
  border: 1px solid rgba(255, 183, 125, 0.16);
  background: rgba(18, 21, 18, 0.82);
  transition: border-color 180ms ease, background-color 180ms ease, transform 180ms ease;
}
.episode-production-card:hover {
  border-color: rgba(255, 183, 125, 0.48);
  background: rgba(26, 28, 24, 0.96);
  transform: translateY(-2px);
}
.episode-production-card__index {
  display: grid;
  flex: 0 0 3.3rem;
  place-items: center;
  border-right: 1px solid rgba(255, 183, 125, 0.13);
  color: #ffb77d;
  font-family: ui-monospace, monospace;
  font-size: 0.85rem;
  font-weight: 800;
}
.episode-production-card__body {
  min-width: 0;
  flex: 1;
  padding: 1rem;
}
.episode-production-card__top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.7rem;
}
.episode-production-card__eyebrow,
.episode-craft-kicker {
  color: #a48d7b;
  font-size: 0.54rem;
  font-weight: 800;
  letter-spacing: 0.16em;
}
.episode-production-card h3 {
  margin-top: 0.3rem;
  overflow: hidden;
  color: #f1ece4;
  font-size: 0.92rem;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.episode-production-card p {
  display: -webkit-box;
  overflow: hidden;
  margin-top: 0.55rem;
  color: #9b9389;
  font-size: 0.7rem;
  line-height: 1.55;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.episode-production-status {
  flex: 0 0 auto;
  padding: 0.2rem 0.42rem;
  color: #bdb4a9;
  font-size: 0.6rem;
  font-weight: 700;
}
.episode-production-status.is-ready { color: #a8d3ad; background: rgba(116, 165, 122, 0.12); }
.episode-production-status.is-in-progress { color: #ffd39d; background: rgba(255, 183, 125, 0.12); }
.episode-production-status.is-storyboard { color: #c6b3e6; background: rgba(150, 119, 196, 0.12); }
.episode-production-card__meta {
  display: flex;
  gap: 0.8rem;
  margin-top: 0.8rem;
  color: #777168;
  font-size: 0.65rem;
}
.episode-production-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-top: 0.95rem;
}
.episode-production-card__link,
.episode-craft-secondary,
.episode-craft-primary,
.studio-launch-secondary {
  display: inline-flex;
  min-height: 2.15rem;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  border: 1px solid rgba(255, 183, 125, 0.24);
  padding: 0 0.65rem;
  color: #c9b9a8;
  font-size: 0.67rem;
  font-weight: 700;
  transition: border-color 160ms ease, background-color 160ms ease, color 160ms ease;
}
.episode-production-card__link:hover,
.episode-craft-secondary:hover,
.studio-launch-secondary:hover {
  border-color: rgba(255, 183, 125, 0.6);
  background: rgba(255, 183, 125, 0.08);
  color: #ffd9b0;
}
.episode-production-card__link .material-symbols-outlined,
.episode-craft-secondary .material-symbols-outlined,
.episode-craft-primary .material-symbols-outlined,
.studio-launch-secondary .material-symbols-outlined {
  font-size: 0.95rem;
}
.episode-production-skeleton,
.episode-production-error {
  margin-top: 1rem;
  border: 1px dashed rgba(255, 183, 125, 0.2);
  padding: 1rem;
  color: #938a80;
  font-size: 0.75rem;
}
.episode-production-error { color: #f1a092; }

.clip-context {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin: 0 1rem 0.75rem;
  border: 1px solid rgba(145, 191, 163, 0.28);
  background: #111512;
  padding: 0.8rem 1rem;
}
.clip-context__identity,
.clip-context__facts,
.clip-context__facts > span {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.6rem;
}
.clip-context__identity > .material-symbols-outlined {
  color: #a8d3ad;
  font-size: 1.3rem;
}
.clip-context__identity h2 {
  overflow-wrap: anywhere;
  color: #e8e5dc;
  font-size: 0.82rem;
  font-weight: 700;
}
.clip-context__identity p {
  margin-top: 0.2rem;
  color: #9ca69d;
  font-size: 0.68rem;
  line-height: 1.5;
}
.clip-context__identity p strong { color: #c8d4c9; font-weight: 650; }
.clip-context__facts {
  flex: 0 0 auto;
  color: #b4bdb4;
  font-size: 0.64rem;
}
.clip-context__facts > span:first-child {
  border-right: 1px solid #384239;
  padding-right: 0.75rem;
  color: #a8d3ad;
}
.clip-context__facts .material-symbols-outlined { font-size: 0.9rem; }

.episode-craft-shell {
  display: grid;
  grid-template-columns: minmax(12rem, 0.8fr) minmax(22rem, 1.7fr) minmax(16rem, 1fr);
  gap: 1px;
  margin: 0 1rem 1rem;
  border: 1px solid rgba(255, 183, 125, 0.18);
  background: rgba(255, 183, 125, 0.13);
}
.clip-rehearsal {
  margin: 0 1rem 1rem;
  border: 1px solid rgba(145, 191, 163, 0.22);
  background: #111512;
  padding: 1rem;
}
.clip-rehearsal__head,
.clip-rehearsal__actions,
.clip-rehearsal__shot-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.clip-rehearsal__head { align-items: flex-start; }
.clip-rehearsal__head h2 { margin-top: 0.25rem; color: #f1ece4; font-size: 0.95rem; font-weight: 700; }
.clip-rehearsal__head p { margin-top: 0.3rem; color: #8e958e; font-size: 0.68rem; line-height: 1.5; }
.clip-rehearsal__actions { flex-wrap: wrap; justify-content: flex-end; }
.clip-rehearsal__message { margin-top: 0.7rem; color: #c7bcae; font-size: 0.68rem; line-height: 1.5; }
.clip-rehearsal__results { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0.55rem; margin-top: 0.75rem; }
.clip-rehearsal__shot { min-width: 0; border: 1px solid #373c36; background: #0d100e; padding: 0.55rem; }
.clip-rehearsal__shot.is-ready { border-color: rgba(145, 191, 163, 0.4); }
.clip-rehearsal__shot.is-blocked { border-color: rgba(219, 139, 124, 0.45); }
.clip-rehearsal__shot-title { color: #d9d1c6; font-size: 0.66rem; }
.clip-rehearsal__shot-title span { color: #95b89e; }
.clip-rehearsal__shot.is-blocked .clip-rehearsal__shot-title span { color: #e0a093; }
.clip-rehearsal__frames { display: grid; grid-template-columns: 1fr 1fr; gap: 0.35rem; margin-top: 0.5rem; }
.clip-rehearsal__frames figure { position: relative; display: grid; min-width: 0; aspect-ratio: 16 / 9; place-items: center; overflow: hidden; background: #1b201c; color: #697168; }
.clip-rehearsal__frames img { width: 100%; height: 100%; object-fit: cover; }
.clip-rehearsal__frames figcaption { position: absolute; right: 0.2rem; bottom: 0.15rem; background: rgba(5, 7, 5, 0.78); padding: 0.1rem 0.2rem; color: #f0eee7; font-size: 0.54rem; }
.clip-rehearsal__blockers { margin: 0.45rem 0 0; padding-left: 1rem; color: #dfa095; font-size: 0.59rem; line-height: 1.5; }
.clip-rehearsal__transitions { display: flex; gap: 0.45rem; overflow-x: auto; margin-top: 0.65rem; padding-bottom: 0.1rem; }
.clip-rehearsal__transitions > span { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 0.25rem; border: 1px solid #373c36; padding: 0.28rem 0.4rem; color: #b7b0a5; font-size: 0.58rem; }
.clip-rehearsal__transitions .material-symbols-outlined { font-size: 0.8rem; }
.clip-rehearsal__transitions strong { color: #d7bd8b; }
.clip-rehearsal__transitions .is-blocked strong { color: #e0a093; }
.clip-rehearsal__transitions .is-ready strong { color: #95b89e; }
.episode-craft-assets,
.episode-craft-script,
.episode-craft-preview {
  min-width: 0;
  background: #111411;
}
.episode-craft-assets,
.episode-craft-preview {
  padding: 0.95rem;
}
.episode-craft-script {
  padding: 0.95rem 1rem 1rem;
}
.episode-craft-panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.6rem;
}
.episode-craft-panel-head h2 {
  margin-top: 0.3rem;
  color: #f1ece4;
  font-size: 0.98rem;
  font-weight: 700;
}
.episode-craft-count {
  color: #ffb77d;
  font-family: ui-monospace, monospace;
  font-size: 0.7rem;
}
.episode-craft-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.25rem;
  margin-top: 1rem;
  border-bottom: 1px solid rgba(255, 183, 125, 0.14);
}
.episode-craft-tabs button {
  display: inline-flex;
  min-height: 2rem;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  border-bottom: 2px solid transparent;
  color: #81786e;
  font-size: 0.68rem;
  transition: color 160ms ease, border-color 160ms ease;
}
.episode-craft-tabs button.is-active {
  border-color: #ffb77d;
  color: #ffd9b0;
}
.episode-craft-tabs .material-symbols-outlined { font-size: 0.9rem; }
.episode-craft-asset-list,
.episode-craft-tool-list {
  max-height: 31rem;
  overflow-y: auto;
  padding-top: 0.45rem;
}
.episode-craft-asset {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.5rem;
  padding: 0.42rem 0.2rem;
  text-align: left;
  transition: background-color 150ms ease;
}
.episode-craft-asset:hover {
  background: rgba(255, 183, 125, 0.06);
}
.episode-craft-asset__thumb {
  display: grid;
  flex: 0 0 2.15rem;
  width: 2.15rem;
  height: 2.15rem;
  place-items: center;
  overflow: hidden;
  border: 1px solid rgba(255, 183, 125, 0.3);
  background: #1d201c;
  color: #ffb77d;
  font-size: 0.72rem;
  font-weight: 800;
}
.episode-craft-asset__thumb img { width: 100%; height: 100%; object-fit: cover; }
.episode-craft-asset__thumb--asset { color: #8daba0; }
.episode-craft-asset__copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 0.12rem;
}
.episode-craft-asset__copy strong {
  overflow: hidden;
  color: #e5ddd2;
  font-size: 0.7rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.episode-craft-asset__copy small { color: #81786e; font-size: 0.6rem; }
.episode-craft-asset > .material-symbols-outlined { color: #8a7562; font-size: 0.86rem; }
.episode-craft-divider {
  margin: 0.55rem 0 0.25rem;
  border-top: 1px solid rgba(255, 183, 125, 0.13);
  padding-top: 0.6rem;
  color: #8d857c;
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.12em;
}
.episode-craft-tool-list button {
  display: grid;
  grid-template-columns: 1.6rem 1fr;
  width: 100%;
  gap: 0.2rem 0.35rem;
  padding: 0.7rem 0.35rem;
  text-align: left;
  transition: background-color 160ms ease;
}
.episode-craft-tool-list button:hover { background: rgba(255, 183, 125, 0.06); }
.episode-craft-tool-list .material-symbols-outlined { grid-row: span 2; color: #ffb77d; font-size: 1rem; }
.episode-craft-tool-list button { color: #e5ddd2; font-size: 0.72rem; }
.episode-craft-tool-list small { color: #81786e; font-size: 0.62rem; line-height: 1.45; }
.episode-craft-continuity-picker {
  display: flex;
  flex-direction: column;
  gap: 0.28rem;
  margin-top: 0.25rem;
  border: 1px solid rgba(255, 183, 125, 0.2);
  background: #0c0f0c;
  padding: 0.42rem;
}
.episode-craft-continuity-picker__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.1rem 0.12rem 0.28rem;
  color: #ffcfaa;
  font-size: 0.66rem;
}
.episode-craft-continuity-picker__head button {
  display: grid;
  width: 1.4rem;
  height: 1.4rem;
  place-items: center;
  border: 1px solid rgba(255, 183, 125, 0.18);
  color: #b9aa9b;
}
.episode-craft-continuity-picker__head button:hover { border-color: #ffb77d; color: #ffb77d; }
.episode-craft-continuity-picker__head .material-symbols-outlined { font-size: 0.85rem; }
.episode-craft-continuity-picker__option {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.42rem;
  width: 100%;
  border: 1px solid rgba(255, 183, 125, 0.12);
  padding: 0.42rem;
  text-align: left;
  color: #d8cfc3;
}
.episode-craft-continuity-picker__option:hover { border-color: rgba(255, 183, 125, 0.55); background: rgba(255, 183, 125, 0.07); }
.episode-craft-continuity-picker__option > .material-symbols-outlined { color: #ffb77d; font-size: 0.95rem; }
.episode-craft-continuity-picker__option > span:nth-child(2) { display: flex; min-width: 0; flex-direction: column; gap: 0.15rem; }
.episode-craft-continuity-picker__option strong { color: #f1e4d4; font-size: 0.65rem; }
.episode-craft-continuity-picker__option small { overflow: hidden; color: #81786e; font-size: 0.59rem; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.episode-craft-continuity-picker__option > .material-symbols-outlined:last-child { color: #9fc6a5; }
.episode-craft-continuity-picker__empty { margin: 0.25rem; color: #81786e; font-size: 0.62rem; line-height: 1.45; }

.episode-craft-panel-actions {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.episode-craft-save-state,
.episode-craft-feedback {
  color: #9fc6a5;
  font-size: 0.65rem;
}
.episode-craft-icon-button {
  display: inline-grid;
  width: 1.9rem;
  height: 1.9rem;
  place-items: center;
  border: 1px solid rgba(255, 183, 125, 0.22);
  color: #b9aa9b;
  transition: border-color 160ms ease, color 160ms ease, background-color 160ms ease;
}
.episode-craft-icon-button:hover { border-color: #ffb77d; background: rgba(255, 183, 125, 0.08); color: #ffb77d; }
.episode-craft-icon-button .material-symbols-outlined { font-size: 0.95rem; }
.episode-craft-shot-strip {
  display: flex;
  gap: 0.3rem;
  margin: 0.95rem 0;
  overflow-x: auto;
  padding-bottom: 0.2rem;
}
.episode-craft-shot-chip {
  display: inline-flex;
  min-width: 3.8rem;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 0.1rem;
  border: 1px solid rgba(255, 183, 125, 0.18);
  padding: 0.42rem 0.5rem;
  text-align: left;
  color: #9d9387;
  transition: border-color 160ms ease, background-color 160ms ease, color 160ms ease;
}
.episode-craft-shot-chip.is-active { border-color: #ffb77d; background: rgba(255, 183, 125, 0.1); color: #ffd9b0; }
.episode-craft-shot-chip span { font-family: ui-monospace, monospace; font-size: 0.72rem; font-weight: 800; }
.episode-craft-shot-chip small { font-size: 0.58rem; }
.episode-craft-form { display: flex; flex-direction: column; gap: 0.72rem; }
.episode-craft-form-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.55rem; }
.episode-craft-form-row--three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.episode-craft-field,
.episode-craft-form-row label { display: flex; flex-direction: column; gap: 0.35rem; }
.episode-craft-field > span,
.episode-craft-form-row label > span { color: #a48d7b; font-size: 0.62rem; font-weight: 700; letter-spacing: 0.08em; }
.episode-craft-field em { color: #ffb77d; font-size: 0.58rem; font-style: normal; font-weight: 500; letter-spacing: 0; }
.episode-craft-field textarea,
.episode-craft-form-row input {
  width: 100%;
  border: 1px solid rgba(255, 183, 125, 0.2);
  background: #0c0f0c;
  padding: 0.5rem 0.55rem;
  color: #e8dfd4;
  font-size: 0.72rem;
  line-height: 1.55;
  outline: none;
  transition: border-color 160ms ease, background-color 160ms ease;
}
.episode-craft-field textarea { resize: vertical; min-height: 3rem; }
.episode-craft-field textarea:focus,
.episode-craft-form-row input:focus { border-color: rgba(255, 183, 125, 0.7); background: #101410; }
.episode-craft-script-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; padding-top: 0.2rem; }
.episode-craft-primary {
  border-color: #ffb77d;
  background: #d97706;
  color: #1c120b;
}
.episode-craft-primary:hover { background: #f59e0b; color: #211408; }
.episode-craft-primary:disabled,
.episode-craft-secondary:disabled { cursor: not-allowed; opacity: 0.45; }
.episode-craft-empty {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 1rem 0.3rem;
  color: #777168;
  font-size: 0.68rem;
  line-height: 1.5;
}
.episode-craft-empty--large {
  min-height: 22rem;
  align-items: center;
  flex-direction: column;
  justify-content: center;
  text-align: center;
}
.episode-craft-empty--large .material-symbols-outlined { color: #80684f; font-size: 2rem; }
.episode-craft-empty--large strong { color: #c1b5a7; font-size: 0.8rem; }
.episode-craft-empty--large span:last-child { max-width: 16rem; }
.episode-craft-player {
  position: relative;
  display: flex;
  min-height: 15rem;
  align-items: center;
  justify-content: center;
  margin-top: 1rem;
  overflow: hidden;
  border: 1px solid rgba(255, 183, 125, 0.16);
  background: #080908;
  transition: transform 220ms ease, box-shadow 220ms ease;
}
.episode-craft-player.is-zoomed {
  position: fixed;
  inset: 8vh 8vw;
  z-index: 80;
  min-height: 0;
  box-shadow: 0 24px 80px rgba(0,0,0,0.62);
}
.episode-craft-player video { max-height: 100%; width: 100%; object-fit: contain; }
.episode-craft-player__empty { display: flex; align-items: center; flex-direction: column; gap: 0.45rem; color: #776f65; font-size: 0.68rem; text-align: center; }
.episode-craft-player__empty .material-symbols-outlined { color: #80684f; font-size: 2rem; }
.episode-craft-player__empty strong { color: #c2b6a8; font-size: 0.8rem; }
.episode-craft-player__tools {
  position: absolute;
  right: 0.5rem;
  top: 0.5rem;
  display: flex;
  gap: 0.25rem;
}
.episode-craft-player__tools button {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(6, 8, 6, 0.78);
  padding: 0.35rem 0.45rem;
  color: #d9d1c6;
  font-size: 0.6rem;
  backdrop-filter: blur(8px);
}
.episode-craft-player__tools button:hover,
.episode-craft-player__tools button.is-active { border-color: #ffb77d; color: #ffd9b0; }
.episode-craft-player__tools .material-symbols-outlined { font-size: 0.85rem; }
.episode-craft-checks { display: flex; flex-direction: column; gap: 0.45rem; margin-top: 0.9rem; }
.episode-craft-checks div { display: flex; justify-content: space-between; gap: 0.5rem; color: #91877c; font-size: 0.66rem; }
.episode-craft-checks strong { color: #d39b76; font-weight: 700; }
.episode-craft-checks strong.is-ready { color: #9fc6a5; }
.episode-timeline {
  margin: 0 1rem 1rem;
  border: 1px solid rgba(255, 183, 125, 0.18);
  background: #111411;
  padding: 1rem;
}
.episode-timeline__actions { display: flex; align-items: center; gap: 0.6rem; color: #81786e; font-size: 0.65rem; }
.episode-timeline__track { display: flex; gap: 0.55rem; margin-top: 1rem; overflow-x: auto; padding-bottom: 0.2rem; }
.episode-timeline__item {
  display: flex;
  min-width: 11rem;
  flex: 0 0 11rem;
  flex-direction: column;
  gap: 0.48rem;
  border: 1px solid rgba(255, 183, 125, 0.16);
  background: #0d100d;
  padding: 0.42rem;
  text-align: left;
  transition: border-color 180ms ease, background-color 180ms ease, transform 180ms ease;
}
.episode-timeline__item:hover,
.episode-timeline__item.is-active { border-color: #ffb77d; background: rgba(255, 183, 125, 0.08); transform: translateY(-2px); }
.episode-timeline__item-thumb {
  position: relative;
  display: flex;
  height: 5.25rem;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: #080a08;
  color: #80684f;
}
.episode-timeline__item-thumb img { width: 100%; height: 100%; object-fit: cover; }
.episode-timeline__item-play {
  position: absolute;
  top: 0.38rem;
  left: 0.38rem;
  display: grid;
  width: 1.3rem;
  height: 1.3rem;
  place-items: center;
  border-radius: 999px;
  background: rgba(10, 12, 10, 0.8);
  color: #ffb77d;
  font-size: 0.8rem;
}
.episode-timeline__item-duration {
  position: absolute;
  right: 0.35rem;
  bottom: 0.3rem;
  padding: 0.12rem 0.28rem;
  background: rgba(10, 12, 10, 0.82);
  color: #f1e4d4;
  font-family: ui-monospace, monospace;
  font-size: 0.58rem;
}
.episode-timeline__item-copy { display: flex; flex-direction: column; gap: 0.18rem; }
.episode-timeline__item-copy strong { color: #ffb77d; font-family: ui-monospace, monospace; font-size: 0.62rem; font-weight: 800; }
.episode-timeline__item-copy small { display: -webkit-box; overflow: hidden; color: #ddd3c6; font-size: 0.64rem; line-height: 1.35; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.episode-timeline__item-copy small { color: #81786e; font-size: 0.6rem; }

.asset-prompt-backdrop {
  position: fixed;
  z-index: 40;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(3, 5, 4, 0.72);
  backdrop-filter: blur(5px);
}
.asset-prompt-dialog {
  display: flex;
  width: min(32rem, calc(100vw - 2rem));
  max-height: min(44rem, calc(100vh - 2rem));
  flex-direction: column;
  gap: 0.85rem;
  overflow: auto;
  border: 1px solid rgba(255, 183, 125, 0.3);
  background: #121512;
  padding: 1rem;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
}
.asset-prompt-dialog__head,
.asset-prompt-dialog footer { display: flex; align-items: center; justify-content: space-between; gap: 0.7rem; }
.asset-prompt-dialog__head h2 { margin-top: 0.2rem; color: #f1e4d4; font-size: 1.1rem; }
.asset-prompt-dialog__image { width: 100%; max-height: 12rem; object-fit: cover; border: 1px solid rgba(255, 183, 125, 0.18); }
.asset-prompt-dialog__message { min-height: 1rem; color: #9fc6a5; font-size: 0.68rem; }
.asset-prompt-enter-active,
.asset-prompt-leave-active { transition: opacity 180ms ease; }
.asset-prompt-enter-from,
.asset-prompt-leave-to { opacity: 0; }

@media (max-width: 767px) {
  .clip-context {
    align-items: flex-start;
    flex-direction: column;
    margin-inline: 0.6rem;
  }
  .clip-context__facts { width: 100%; flex-wrap: wrap; }
  .clip-rehearsal { margin-inline: 0.6rem; }
  .clip-rehearsal__head { flex-direction: column; }
  .clip-rehearsal__actions { width: 100%; justify-content: stretch; }
  .clip-rehearsal__actions button { flex: 1; }
  .studio-launch {
    padding: 1.5rem 0.8rem 3rem;
  }
  .studio-launch-head {
    align-items: flex-start;
    flex-direction: column;
    margin-bottom: 2rem;
  }
  .studio-launch-primary {
    width: 100%;
    justify-content: center;
  }
  .studio-launch-grid {
    grid-template-columns: 1fr 1fr;
  }
  .studio-launch-card {
    min-height: 16rem;
    padding: 1rem;
  }
  .studio-launch-card-icon {
    margin-top: 2.25rem;
  }
  .studio-launch-footer {
    align-items: flex-start;
    flex-direction: column;
  }

  .studio-view-tools {
    padding: 0.75rem 0.8rem;
    align-items: flex-start;
    flex-direction: column;
  }

  .studio-view-actions {
    width: 100%;
  }

  .episode-production-grid {
    grid-template-columns: 1fr;
  }
  .episode-production-board__head,
  .episode-timeline__head {
    align-items: flex-start;
    flex-direction: column;
  }
  .episode-craft-shell {
    grid-template-columns: 1fr;
    margin-inline: 0.6rem;
  }
  .episode-craft-assets {
    max-height: 18rem;
    overflow: hidden;
  }
  .episode-craft-asset-list,
  .episode-craft-tool-list {
    max-height: 10rem;
  }
  .episode-craft-form-row,
  .episode-craft-form-row--three {
    grid-template-columns: 1fr;
  }
  .episode-craft-player.is-zoomed {
    inset: 10vh 0.6rem;
  }
  .episode-timeline {
    margin-inline: 0.6rem;
  }

  .studio-tool-button {
    flex: 1;
    justify-content: center;
  }

  .candidate-overview-wrap {
    margin-inline: 0.55rem;
  }

  .rework-queue-strip {
    align-items: flex-start;
    flex-direction: column;
  }

  .rework-queue-copy {
    align-items: flex-start;
    flex-direction: column;
    gap: 0.22rem;
  }

  .rework-queue-copy > span:last-child {
    white-space: normal;
  }

  .rework-queue-action {
    width: 100%;
    justify-content: center;
  }

  .inspector-drawer {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    border-left: 0;
    z-index: 25;
  }

  .inspector-drawer.is-open {
    width: 100%;
    flex-basis: 100%;
  }

  .timeline-dock.is-open {
    height: 17.5rem;
    flex-basis: 17.5rem;
    max-height: 44vh;
  }

  .timeline-dock,
  .timeline-dock--stage-collapsed {
    margin-left: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .studio-launch-card,
  .studio-launch-primary,
  .studio-launch-secondary {
    transition: none;
  }
  .inspector-drawer,
  .timeline-dock,
  .candidate-overview-enter-active,
  .candidate-overview-leave-active,
  .rework-queue-action {
    transition: none;
  }
}
</style>
