<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  confirmVideo,
  generateStoryboardLipSync,
  generateStoryboardVideos,
  getGenerationJob,
  getModelSettings,
  getStoryboard,
  listProjectAudio,
  listShotImages,
  listStoryboardVideos,
  saveRecoveryVideoReview,
  type AudioAssetDTO,
  type ImageAssetDTO,
  type StoryboardDTO,
  type VideoAssetDTO,
} from '@/api/project'
import { setWorkspaceContext } from '@/lib/context'
import { claimReworkItem, completeReworkItem } from '@/lib/rework-queue'
import { formatShotDuration } from '@/lib/episode-clips.mjs'

type PageState =
  | 'missing-project'
  | 'missing-scene'
  | 'missing-shot'
  | 'loading'
  | 'missing-image'
  | 'error'
  | 'ready'

type RecoveryReviewDecision = 'approved' | 'rework'
type RecoveryCharacterReviewDecision = 'matched' | 'rework'
type RecoveryCharacterCheckDraft = {
  decision: RecoveryCharacterReviewDecision | ''
  note: string
}

const route = useRoute()
const router = useRouter()

const projectId = computed(() => Number(route.query.projectId) || 0)
const sceneId = computed(() => Number(route.query.sceneId) || 0)
const storyboardId = computed(() => Number(route.query.storyboardId) || 0)
const reworkCandidateId = computed(() => Number(route.query.reworkCandidateId) || 0)

const pageState = ref<PageState>('loading')
const storyboard = ref<StoryboardDTO | null>(null)
const confirmedImage = ref<ImageAssetDTO | null>(null)
const confirmedStartFrame = ref<ImageAssetDTO | null>(null)
const confirmedEndFrame = ref<ImageAssetDTO | null>(null)
const videos = ref<VideoAssetDTO[]>([])
const dialogueAudios = ref<AudioAssetDTO[]>([])
const selectedVideoId = ref<number | null>(null)

const motionMode = ref('PAN')
const motionPrompt = ref('')
const durationSeconds = ref(5)
const modelName = ref('agnes-video-2.5-flash')
const lipSyncProvider = ref('')
const isFixedDurationModel = computed(() => /^cogvideox(?:-|$)/i.test(modelName.value.trim()))

const loadingVideos = ref(false)
const generating = ref(false)
const generationProgress = ref(0)
const lipSyncing = ref(false)
const lipSyncProgress = ref(0)
const confirmingVideoId = ref<number | null>(null)
const savingRecoveryReviewId = ref<number | null>(null)
const errorMsg = ref('')
const infoMsg = ref('')
const reworkContext = ref<{ candidateId: number } | null>(null)
const recoveryReviewDecision = ref<RecoveryReviewDecision>('approved')
const recoveryReviewChecklist = ref({
  visualReviewed: false,
  characterConsistencyReviewed: false,
  motionContinuityReviewed: false,
})
const recoveryCharacterChecks = ref<Record<number, RecoveryCharacterCheckDraft>>({})
const recoveryReviewNote = ref('')
let lipSyncTimer: ReturnType<typeof setTimeout> | null = null
let videoGenerationTimer: ReturnType<typeof setTimeout> | null = null

const selectedVideo = computed<VideoAssetDTO | null>(
  () => videos.value.find((item) => item.id === selectedVideoId.value) || null,
)

const selectedRecoveryVideo = computed<VideoAssetDTO | null>(() =>
  selectedVideo.value?.isRecoveryVideo ? selectedVideo.value : null,
)

const confirmedVideo = computed<VideoAssetDTO | null>(
  () => videos.value.find((item) => item.status === 'confirmed') || null,
)

const motionBaseVideo = computed<VideoAssetDTO | null>(
  () =>
    videos.value.find(
      (item) =>
        (item.status === 'confirmed' || item.status === 'archived') &&
        item.sourceType !== 'lip_sync' &&
        !!item.videoUrl,
    ) || null,
)

const canLipSyncMotionVideo = computed(() => lipSyncProvider.value.toLowerCase() === 'dashscope')

const confirmedDialogueAudios = computed(() =>
  dialogueAudios.value
    .filter(
      (item) =>
        item.status === 'confirmed' &&
        item.trackType === 'dialogue' &&
        Number(item.storyboardId || 0) === Number(storyboardId.value),
    )
    .sort((a, b) => Number(b.id) - Number(a.id)),
)

const confirmedDialogueAudio = computed<AudioAssetDTO | null>(() => {
  // 口型同步优先使用“当前分镜角色”对应的已确认对白音频。
  // 如果找不到精确角色匹配，才退回该分镜最新的一条对白音频。
  const currentCharacterId = Number(storyboard.value?.characterId || 0)
  const matched = confirmedDialogueAudios.value.find(
    (item) => currentCharacterId && Number(item.characterId || 0) === currentCharacterId,
  )
  return matched || confirmedDialogueAudios.value[0] || null
})

const lipSyncSpeakerName = computed(() =>
  String(storyboard.value?.characterName || '').trim() || '未绑定说话角色',
)

const audioSpeakerName = computed(() =>
  String(confirmedDialogueAudio.value?.characterName || '').trim() || '未确认对白音频',
)

const audioRoleMismatch = computed(() => {
  const shotCharacterId = Number(storyboard.value?.characterId || 0)
  const audioCharacterId = Number(confirmedDialogueAudio.value?.characterId || 0)
  return Boolean(shotCharacterId && audioCharacterId && shotCharacterId !== audioCharacterId)
})

const dialogueTurns = computed(() => {
  const text = String(storyboard.value?.dialogueText || '').trim()
  if (!text) return []
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const turns = lines
    .map((line, index) => {
      const match = line.match(/^【?([^：:]{1,30})】?[：:]\s*(.+)$/)
      if (!match) return null
      return { index: index + 1, speaker: String(match[1] || '').trim(), text: String(match[2] || '').trim() }
    })
    .filter((item): item is { index: number; speaker: string; text: string } => Boolean(item))
  if (turns.length) return turns
  return storyboard.value?.characterName
    ? [{ index: 1, speaker: storyboard.value.characterName, text }]
    : []
})

const hasMultiSpeakerDialogue = computed(() => {
  const speakers = new Set(dialogueTurns.value.map((item) => item.speaker).filter(Boolean))
  return speakers.size > 1
})

const lipSyncBlockedReason = computed(() => {
  // 口型同步前置条件比较严格：
  // 必须有说话角色、有已确认对白、角色不能错配，多人对白还要先拆成单人分镜。
  if (!storyboard.value?.characterId) return '当前分镜还没有绑定说话角色，请先回分镜编辑页选择说话人。'
  if (!confirmedDialogueAudio.value) return '当前分镜还没有已确认对白音频，请先到音频页生成并确认对白。'
  if (audioRoleMismatch.value) {
    return `当前分镜说话人是“${lipSyncSpeakerName.value}”，但已确认音频属于“${audioSpeakerName.value}”，请先统一角色绑定。`
  }
  if (hasMultiSpeakerDialogue.value) {
    return '当前对白里识别到多个说话人，请先回分镜编辑页点击“AI 拆分多人对白”，再逐条生成音频和口型。'
  }
  if (motionBaseVideo.value && !canLipSyncMotionVideo.value) {
    return '当前口型服务不支持给动作视频加口型，请在 AI 设置里把口型服务切换为 DashScope。'
  }
  return ''
})

const canGenerateLipSync = computed(() => Boolean(confirmedImage.value && !lipSyncing.value && !lipSyncBlockedReason.value))

const lipSyncHelperText = computed(() => {
  if (!motionBaseVideo.value) {
    return '想要人物有动作：先生成普通动作视频，并确认其中一条为最终版本，再给它加口型。'
  }
  if (!canLipSyncMotionVideo.value) {
    return '已确认动作视频，但当前口型服务不支持视频底片。请在 AI 设置里把口型服务切换为 DashScope。'
  }
  return '将使用当前已确认动作视频作为底片，只替换对白口型，保留原视频里的动作。'
})

const keyframeHelperText = computed(() => {
  if (confirmedStartFrame.value && confirmedEndFrame.value) {
    return '本次普通视频会从已确认起始帧出发，并用结束帧提示词约束动作终点。'
  }
  if (confirmedStartFrame.value) {
    return '本次普通视频会优先使用起始帧作为底图；建议再补一张结束帧，让动作收尾更稳定。'
  }
  return '当前使用普通静帧作为底图；如果动作容易跑偏，先到画面结果页生成起始帧和结束帧。'
})

function normalizeFrameRole(value?: string | null): 'primary' | 'start' | 'end' {
  if (value === 'start' || value === 'end') return value
  return 'primary'
}

watch(isFixedDurationModel, (fixed) => {
  if (fixed) durationSeconds.value = 5
})

function buildQuery(nextStoryboardId = storyboardId.value) {
  return {
    projectId: String(projectId.value),
    sceneId: String(sceneId.value),
    storyboardId: String(nextStoryboardId),
  }
}

function backToStoryboardEditor(): void {
  router.push({
    path: '/workspace/storyboard/editor',
    query: buildQuery(),
  })
}

function goToFrameModule(): void {
  router.push({
    path: '/workspace/episodes/studio',
    query: buildQuery(),
  })
}

function goToAudioModule(): void {
  router.push({
    path: '/workspace/audio',
    query: buildQuery(),
  })
}

function syncSelectedVideo(): void {
  const confirmed = videos.value.find((item) => item.status === 'confirmed')
  if (confirmed) {
    selectedVideoId.value = confirmed.id
    return
  }
  const firstVideo = videos.value[0]
  if (firstVideo) {
    selectedVideoId.value = firstVideo.id
    return
  }
  selectedVideoId.value = null
}

function loadRecoveryReviewDraft(video: VideoAssetDTO | null): void {
  const review = video?.recoveryReview
  recoveryReviewDecision.value = review?.decision === 'rework' ? 'rework' : 'approved'
  recoveryReviewChecklist.value = {
    visualReviewed: review?.checklist?.visualReviewed === true,
    characterConsistencyReviewed: review?.checklist?.characterConsistencyReviewed === true,
    motionContinuityReviewed: review?.checklist?.motionContinuityReviewed === true,
  }
  const savedCharacterChecks = new Map(
    (review?.checklist?.characterChecks || []).map((item) => [item.characterId, item]),
  )
  recoveryCharacterChecks.value = Object.fromEntries(
    (video?.recoveryInspection?.characterChecklist || []).map((character) => {
      const saved = savedCharacterChecks.get(character.characterId)
      return [
        character.characterId,
        {
          decision: saved?.decision || '',
          note: saved?.note || '',
        },
      ]
    }),
  )
  recoveryReviewNote.value = review?.note || ''
}

function hasMatchedCharacterReviews(video: VideoAssetDTO): boolean {
  const expectedCharacters = video.recoveryInspection?.characterChecklist || []
  const savedChecks = video.recoveryReview?.checklist?.characterChecks || []
  return expectedCharacters.every((character) =>
    savedChecks.some(
      (item) => item.characterId === character.characterId && item.decision === 'matched',
    ),
  )
}

const recoveryCharacterCheckError = computed(() => {
  const video = selectedRecoveryVideo.value
  if (!video) return ''
  for (const character of video.recoveryInspection?.characterChecklist || []) {
    const check = recoveryCharacterChecks.value[character.characterId]
    if (!check?.decision) return `请为角色“${character.name}”选择通过或返工`
    if (check.decision === 'rework' && !check.note.trim()) {
      return `角色“${character.name}”标记返工时必须填写原因`
    }
  }
  return ''
})

function isRecoveryReviewApproved(video: VideoAssetDTO): boolean {
  const review = video.recoveryReview
  const inspection = video.recoveryInspection
  return Boolean(
    video.isRecoveryVideo &&
      inspection?.status === 'ready' &&
      inspection.sampleFrames.length >= 3 &&
      review?.decision === 'approved' &&
      review.checklist.visualReviewed &&
      review.checklist.characterConsistencyReviewed &&
      review.checklist.motionContinuityReviewed &&
      hasMatchedCharacterReviews(video),
  )
}

function isConfirmBlocked(video: VideoAssetDTO): boolean {
  return video.isRecoveryVideo === true && !isRecoveryReviewApproved(video)
}

function recoveryReviewStatusLabel(video: VideoAssetDTO): string {
  if (!video.isRecoveryVideo) return statusLabel(video.status)
  if (isRecoveryReviewApproved(video)) return '复核已批准'
  if (video.recoveryReview?.decision === 'rework') return '复核返工'
  return '恢复待复核'
}

function releaseReadinessLabel(video: VideoAssetDTO): string {
  const readiness = video.recoveryInspection?.releaseReadiness
  if (readiness?.status === 'release-format-ready') return '发布规格就绪'
  if (readiness?.status === 'needs-vertical-final-edit') return '需竖屏终剪'
  return '不可直发平台'
}

function releaseReadinessClass(video: VideoAssetDTO): string {
  const status = video.recoveryInspection?.releaseReadiness?.status
  if (status === 'release-format-ready') return 'release-ready'
  if (status === 'needs-vertical-final-edit') return 'needs-final-edit'
  return 'not-ready'
}

async function refreshVideos(): Promise<void> {
  loadingVideos.value = true
  try {
    const items = await listStoryboardVideos(storyboardId.value)
    videos.value = items
    syncSelectedVideo()
  } finally {
    loadingVideos.value = false
  }
}

async function loadPage(): Promise<void> {
  // 视频生成必须建立在“已确认静帧”之上。
  // 页面会优先找 start 帧，其次找 primary 帧；end 帧只作为动作终点约束。
  if (!projectId.value) {
    pageState.value = 'missing-project'
    return
  }
  if (!sceneId.value) {
    pageState.value = 'missing-scene'
    return
  }
  if (!storyboardId.value) {
    pageState.value = 'missing-shot'
    return
  }

  pageState.value = 'loading'
  errorMsg.value = ''
  infoMsg.value = ''

  try {
    if (reworkCandidateId.value) {
      const claimed = claimReworkItem(projectId.value, reworkCandidateId.value, 'video')
      if (claimed) {
        reworkContext.value = { candidateId: claimed.candidateId }
      }
    }
    const shot = await getStoryboard(storyboardId.value)
    if (shot.sceneId !== sceneId.value) {
      throw new Error('当前分镜与场景上下文不一致，请检查页面参数')
    }

    storyboard.value = shot
    motionPrompt.value = shot.actionText || ''
    setWorkspaceContext({
      projectId: projectId.value,
      sceneId: shot.sceneId,
      storyboardId: shot.id,
    })

    const images = await listShotImages(storyboardId.value)
    confirmedStartFrame.value =
      images.find((item) => item.status === 'confirmed' && normalizeFrameRole(item.frameRole) === 'start') || null
    confirmedEndFrame.value =
      images.find((item) => item.status === 'confirmed' && normalizeFrameRole(item.frameRole) === 'end') || null
    const confirmed =
      confirmedStartFrame.value ||
      images.find((item) => item.status === 'confirmed' && normalizeFrameRole(item.frameRole) === 'primary') ||
      null
    confirmedImage.value = confirmed

    if (!confirmed) {
      videos.value = []
      dialogueAudios.value = []
      selectedVideoId.value = null
      pageState.value = 'missing-image'
      return
    }

    const [audioItems] = await Promise.all([listProjectAudio(projectId.value), refreshVideos()])
    dialogueAudios.value = audioItems
    pageState.value = 'ready'
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '视频模块加载失败'
    pageState.value = 'error'
  }
}

async function loadModelDefaults(): Promise<void> {
  try {
    const settings = await getModelSettings()
    modelName.value = settings.effective.video.defaultModel || modelName.value
    lipSyncProvider.value = settings.effective.video.lipSyncProvider || ''
  } catch {
    // 设置中心不可用时保留页面内置默认值。
  }
}

async function onGenerate(): Promise<void> {
  // 普通视频生成：把已确认静帧 + 动作提示词提交给后端，创建图生视频任务。
  if (!storyboardId.value || !confirmedImage.value || generating.value) return

  generating.value = true
  generationProgress.value = 0
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const job = await generateStoryboardVideos(storyboardId.value, {
      prompt: motionPrompt.value.trim() || undefined,
      motionMode: motionMode.value,
      durationSeconds: durationSeconds.value,
      modelName: modelName.value,
      candidateCount: 1,
    })
    infoMsg.value = '视频任务已进入后台队列，可以离开此页面'
    void pollVideoGenerationJob(job.id)
  } catch (error) {
    generating.value = false
    errorMsg.value = error instanceof Error ? error.message : '视频生成失败'
  }
}

async function pollVideoGenerationJob(jobId: number): Promise<void> {
  // 视频任务通常耗时更久，所以轮询间隔比静帧更长。
  // 成功后刷新候选视频列表，用户再手动确认主版本。
  try {
    const job = await getGenerationJob(jobId)
    generationProgress.value = job.progressPercent
    if (job.status === 'success') {
      generating.value = false
      generationProgress.value = 100
      await refreshVideos()
      if (reworkContext.value) {
        completeReworkItem(projectId.value, reworkContext.value.candidateId, 'video')
        reworkContext.value = null
      }
      pageState.value = 'ready'
      errorMsg.value = ''
      infoMsg.value = '候选视频已生成并保存到本地'
      return
    }
    if (job.status === 'failed' || job.status === 'canceled') {
      generating.value = false
      infoMsg.value = ''
      errorMsg.value = job.errorText || '视频生成失败'
      return
    }
    videoGenerationTimer = setTimeout(() => void pollVideoGenerationJob(jobId), 5000)
  } catch (error) {
    generating.value = false
    infoMsg.value = ''
    errorMsg.value = error instanceof Error ? error.message : '视频任务状态查询失败'
  }
}

async function pollLipSyncJob(jobId: number): Promise<void> {
  // 口型同步也是 generation job，只是 job_type 不同。
  // 成功后会刷新视频列表，并通常自动确认成当前主版本。
  try {
    const job = await getGenerationJob(jobId)
    lipSyncProgress.value = job.progressPercent
    if (job.status === 'success') {
      lipSyncing.value = false
      lipSyncProgress.value = 100
      await refreshVideos()
      errorMsg.value = ''
      infoMsg.value = '对白口型视频已生成并设为当前主版本'
      return
    }
    if (job.status === 'failed' || job.status === 'canceled') {
      lipSyncing.value = false
      infoMsg.value = ''
      errorMsg.value = job.errorText || '对白口型同步失败'
      return
    }
    lipSyncTimer = setTimeout(() => void pollLipSyncJob(jobId), 5000)
  } catch (error) {
    lipSyncing.value = false
    infoMsg.value = ''
    errorMsg.value = error instanceof Error ? error.message : '口型任务状态查询失败'
  }
}

async function onGenerateLipSync(): Promise<void> {
  // 口型同步：用确认过的对白音频驱动角色嘴型。
  // 如果已有确认动作视频，DashScope 分支会尽量在动作视频基础上加口型。
  if (!storyboardId.value || !confirmedImage.value || lipSyncing.value) return
  if (lipSyncBlockedReason.value) {
    errorMsg.value = lipSyncBlockedReason.value
    infoMsg.value = ''
    return
  }
  lipSyncing.value = true
  lipSyncProgress.value = 0
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const job = await generateStoryboardLipSync(storyboardId.value, { autoConfirm: true })
    infoMsg.value = '对白口型任务已进入后台队列，可以离开此页'
    void pollLipSyncJob(job.id)
  } catch (error) {
    lipSyncing.value = false
    errorMsg.value = error instanceof Error ? error.message : '对白口型任务提交失败'
  }
}

async function onConfirm(videoId: number): Promise<void> {
  // 确认视频时，后端会把同分镜其他视频归档，并把 storyboards.video_url 指向这个主版本。
  if (confirmingVideoId.value) return
  const video = videos.value.find((item) => item.id === videoId)
  if (video && isConfirmBlocked(video)) {
    errorMsg.value = '恢复视频需要先完成自动抽帧证据检查，并保存批准三项人工复核。'
    infoMsg.value = ''
    return
  }

  confirmingVideoId.value = videoId
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const confirmed = await confirmVideo(videoId)
    await refreshVideos()
    selectedVideoId.value = confirmed.id
    infoMsg.value = '最终视频已确认'
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '确认最终视频失败'
  } finally {
    confirmingVideoId.value = null
  }
}

async function onSaveRecoveryReview(): Promise<void> {
  const video = selectedRecoveryVideo.value
  if (!video || savingRecoveryReviewId.value) return
  if (recoveryCharacterCheckError.value) {
    errorMsg.value = recoveryCharacterCheckError.value
    infoMsg.value = ''
    return
  }

  const characterChecks = []
  for (const character of video.recoveryInspection?.characterChecklist || []) {
    const check = recoveryCharacterChecks.value[character.characterId]
    if (!check || (check.decision !== 'matched' && check.decision !== 'rework')) {
      errorMsg.value = `请为角色“${character.name}”选择通过或返工`
      infoMsg.value = ''
      return
    }
    characterChecks.push({
      characterId: character.characterId,
      decision: check.decision,
      note: check.note.trim() || undefined,
    })
  }

  savingRecoveryReviewId.value = video.id
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const updated = await saveRecoveryVideoReview(video.id, {
      decision: recoveryReviewDecision.value,
      checklist: {
        ...recoveryReviewChecklist.value,
        characterChecks,
      },
      note: recoveryReviewNote.value.trim() || undefined,
    })
    await refreshVideos()
    selectedVideoId.value = updated.id
    infoMsg.value =
      updated.recoveryReview?.decision === 'approved'
        ? '恢复视频复核已批准；抽帧证据齐全后可以确认主版本。'
        : '恢复视频已标记返工，原因已保存。'
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '保存恢复视频复核失败'
  } finally {
    savingRecoveryReviewId.value = null
  }
}

function statusLabel(status: string): string {
  if (status === 'confirmed') return '已确认'
  if (status === 'archived') return '已归档'
  return '候选'
}

watch(selectedRecoveryVideo, (video) => {
  if (video) loadRecoveryReviewDraft(video)
})

watch(
  () => [route.query.projectId, route.query.sceneId, route.query.storyboardId],
  () => {
    void loadPage()
  },
)

onMounted(() => {
  void loadModelDefaults()
  void loadPage()
})

onBeforeUnmount(() => {
  if (lipSyncTimer) clearTimeout(lipSyncTimer)
  if (videoGenerationTimer) clearTimeout(videoGenerationTimer)
})
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true">
    <section
      v-if="pageState === 'missing-project'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card">
        <h2 class="state-title">缺少项目上下文</h2>
        <p class="state-desc">视频生成依赖具体项目，请从项目工作区进入当前分镜。</p>
        <button class="primary-btn" type="button" @click="router.push('/dashboard')">返回项目台</button>
      </div>
    </section>

    <section
      v-else-if="pageState === 'missing-scene'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card">
        <h2 class="state-title">缺少场景上下文</h2>
        <p class="state-desc">视频生成必须知道当前分镜属于哪个场景。</p>
        <button class="primary-btn" type="button" @click="backToStoryboardEditor">返回分镜编辑</button>
      </div>
    </section>

    <section
      v-else-if="pageState === 'missing-shot'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card">
        <h2 class="state-title">缺少分镜上下文</h2>
        <p class="state-desc">请先选中一个具体分镜，再进入视频生成页。</p>
        <button class="primary-btn" type="button" @click="backToStoryboardEditor">返回分镜编辑</button>
      </div>
    </section>

    <div
      v-else-if="pageState === 'loading'"
      class="flex h-full items-center justify-center bg-[#111210] text-sm text-[#c7b39a]"
    >
      正在加载视频模块...
    </div>

    <section
      v-else-if="pageState === 'error'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card border-red-500/40">
        <h2 class="state-title text-red-300">视频模块加载失败</h2>
        <p class="state-desc">{{ errorMsg || '请稍后重试。' }}</p>
        <div class="flex flex-wrap gap-3">
          <button class="ghost-btn" type="button" @click="loadPage">重新加载</button>
          <button class="primary-btn" type="button" @click="backToStoryboardEditor">返回分镜编辑</button>
        </div>
      </div>
    </section>

    <section
      v-else-if="pageState === 'missing-image'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card">
        <h2 class="state-title">当前分镜还没有已确认静帧</h2>
        <p class="state-desc">请先在静帧模块确认一张最终静帧，再生成视频。</p>
        <div class="flex flex-wrap gap-3">
          <button class="primary-btn" type="button" @click="goToFrameModule">前往静帧模块</button>
          <button class="ghost-btn" type="button" @click="backToStoryboardEditor">返回分镜编辑</button>
        </div>
      </div>
    </section>

    <div v-else class="video-page">
      <div class="page-top">
        <div>
          <p class="eyebrow">
            场景 {{ sceneId }} / 分镜 {{ storyboard?.shotNo || storyboardId }}
          </p>
          <h1 class="page-title">视频生成</h1>
          <p class="page-subtitle">确认起始帧和结束帧 -> 生成 1 条动作视频 -> 确认动作版本 -> 加对白口型</p>
        </div>
        <div class="top-actions">
          <button class="ghost-btn" type="button" @click="goToFrameModule">回到静帧模块</button>
          <button class="ghost-btn" type="button" @click="backToStoryboardEditor">返回分镜编辑</button>
        </div>
      </div>

      <div v-if="errorMsg" class="message error">{{ errorMsg }}</div>
      <div v-if="infoMsg" class="message success">{{ infoMsg }}</div>
      <div v-if="reworkContext" class="message rework">
        正在处理返工候选 #{{ reworkContext.candidateId }}。生成新候选成功后，会把该项标记为已完成。
      </div>

      <div class="main-grid">
        <section class="panel preview-panel">
          <div class="panel-head">
            <h2>当前预览</h2>
            <span v-if="selectedVideo?.status === 'confirmed'" class="status-badge confirmed">
              已确认主版本
            </span>
          </div>

          <div v-if="selectedVideo" class="video-stage">
            <video :src="selectedVideo.videoUrl" controls playsinline class="video-player"></video>
          </div>
          <div v-else class="empty-stage">还没有候选视频，先生成一批看看。</div>

          <section v-if="selectedRecoveryVideo" class="recovery-review">
            <div class="recovery-review-head">
              <div>
                <h3>恢复视频人工复核</h3>
                <p>技术参数与三张抽帧证据齐全后，才能完成三项人工复核。</p>
              </div>
              <span
                class="status-badge"
                :class="{
                  confirmed: isRecoveryReviewApproved(selectedRecoveryVideo),
                  rework: selectedRecoveryVideo.recoveryReview?.decision === 'rework',
                }"
              >
                {{ recoveryReviewStatusLabel(selectedRecoveryVideo) }}
              </span>
            </div>

            <div
              v-if="selectedRecoveryVideo.recoveryInspection"
              class="recovery-evidence"
              :class="{ failed: selectedRecoveryVideo.recoveryInspection.status === 'failed' }"
            >
              <div class="recovery-evidence-head">
                <span>自动检查证据</span>
                <strong>
                  {{
                    selectedRecoveryVideo.recoveryInspection.status === 'ready'
                      ? '已就绪'
                      : '未通过'
                  }}
                </strong>
              </div>
              <p class="recovery-spec">
                {{
                  `${selectedRecoveryVideo.recoveryInspection.media.width || '-'} x ${
                    selectedRecoveryVideo.recoveryInspection.media.height || '-'
                  } / ${selectedRecoveryVideo.recoveryInspection.media.frameRate || '-'}fps / ${
                    selectedRecoveryVideo.recoveryInspection.media.durationSeconds || '-'
                  }s`
                }}
              </p>
              <p class="recovery-spec">
                {{
                  `${selectedRecoveryVideo.recoveryInspection.media.videoCodec || '-'} + ${
                    selectedRecoveryVideo.recoveryInspection.media.audioCodec || '无音频'
                  } / ${selectedRecoveryVideo.recoveryInspection.media.formatName || '-'}`
                }}
              </p>
              <div
                v-if="selectedRecoveryVideo.recoveryInspection.sampleFrames.length"
                class="recovery-sample-grid"
              >
                <figure
                  v-for="sample in selectedRecoveryVideo.recoveryInspection.sampleFrames"
                  :key="sample.storageKey"
                  class="recovery-sample"
                >
                  <img :src="sample.imageUrl" :alt="`恢复抽帧 ${sample.second} 秒`" />
                  <figcaption>{{ sample.second.toFixed(1) }}s</figcaption>
                </figure>
              </div>
              <div
                v-if="selectedRecoveryVideo.recoveryInspection.characterChecklist.length"
                class="recovery-character-checklist"
              >
                <span class="recovery-character-label">角色核对</span>
                <div
                  v-for="character in selectedRecoveryVideo.recoveryInspection.characterChecklist"
                  :key="character.characterId"
                  class="recovery-character-row"
                >
                  <img
                    v-if="character.referenceImageUrl"
                    :src="character.referenceImageUrl"
                    :alt="`${character.name} 定妆参考`"
                  />
                  <div>
                    <strong>
                      {{ character.name }}{{ character.isPrimary ? ' · 主体' : '' }}
                      {{
                        character.versionNo
                          ? `· v${character.versionNo}`
                          : '· 历史快照未记录版本'
                      }}
                    </strong>
                    <p>固定外貌：{{ character.appearance || '历史快照未记录' }}</p>
                    <p :class="{ 'recovery-character-missing': !character.costume }">
                      固定服装：{{ character.costume || '历史快照未独立记录' }}
                    </p>
                  </div>
                </div>
              </div>
              <ul
                v-if="selectedRecoveryVideo.recoveryInspection.blockingIssues.length"
                class="recovery-evidence-list error"
              >
                <li
                  v-for="issue in selectedRecoveryVideo.recoveryInspection.blockingIssues"
                  :key="issue.code"
                >
                  {{ issue.message }}
                </li>
              </ul>
              <ul
                v-if="selectedRecoveryVideo.recoveryInspection.warnings.length"
                class="recovery-evidence-list warning"
              >
                <li
                  v-for="warning in selectedRecoveryVideo.recoveryInspection.warnings"
                  :key="warning.code"
                >
                  {{ warning.message }}
                </li>
              </ul>
              <div
                v-if="selectedRecoveryVideo.recoveryInspection.releaseReadiness"
                class="release-readiness"
                :class="releaseReadinessClass(selectedRecoveryVideo)"
              >
                <strong>{{ releaseReadinessLabel(selectedRecoveryVideo) }}</strong>
                <p>{{ selectedRecoveryVideo.recoveryInspection.releaseReadiness.message }}</p>
                <ul
                  v-if="selectedRecoveryVideo.recoveryInspection.releaseReadiness.blockingIssues.length"
                  class="recovery-evidence-list"
                >
                  <li
                    v-for="issue in selectedRecoveryVideo.recoveryInspection.releaseReadiness.blockingIssues"
                    :key="issue.code"
                  >
                    {{ issue.message }}
                  </li>
                </ul>
              </div>
              <ul class="recovery-evidence-list">
                <li
                  v-for="focus in selectedRecoveryVideo.recoveryInspection.manualFocus"
                  :key="focus"
                >
                  {{ focus }}
                </li>
              </ul>
            </div>
            <p v-else class="recovery-evidence missing">
              自动检查证据尚未生成，不能确认主版本。
            </p>

            <div class="review-checklist">
              <label class="review-check">
                <input v-model="recoveryReviewChecklist.visualReviewed" type="checkbox" />
                <span>画面构图、主体与明显瑕疵已复核</span>
              </label>
              <label class="review-check">
                <input v-model="recoveryReviewChecklist.characterConsistencyReviewed" type="checkbox" />
                <span>人物外貌、服装与已确认静帧一致</span>
              </label>
              <label class="review-check">
                <input v-model="recoveryReviewChecklist.motionContinuityReviewed" type="checkbox" />
                <span>动作起止、镜头运动与场景连续性已复核</span>
              </label>
            </div>

            <div
              v-if="selectedRecoveryVideo.recoveryInspection?.characterChecklist.length"
              class="review-character-decisions"
            >
              <span class="review-section-label">逐角色结论</span>
              <div
                v-for="character in selectedRecoveryVideo.recoveryInspection.characterChecklist"
                :key="`review-${character.characterId}`"
                class="review-character-decision"
              >
                <div class="review-character-decision-head">
                  <strong>
                    {{ character.name }}{{ character.isPrimary ? ' · 主体' : '' }}
                  </strong>
                  <label>
                    <span>结论</span>
                    <select
                      v-model="recoveryCharacterChecks[character.characterId]!.decision"
                      class="field-input"
                      :aria-label="`${character.name} 的角色一致性结论`"
                    >
                      <option value="">未复核</option>
                      <option value="matched">通过</option>
                      <option value="rework">返工</option>
                    </select>
                  </label>
                </div>
                <label class="review-character-note">
                  <span>角色备注</span>
                  <input
                    v-model="recoveryCharacterChecks[character.characterId]!.note"
                    class="field-input"
                    :aria-label="`${character.name} 的角色复核备注`"
                    :placeholder="
                      recoveryCharacterChecks[character.characterId]!.decision === 'rework'
                        ? '返工时必须说明外貌、服装、主体或动作问题'
                        : '可记录核对依据'
                    "
                  />
                </label>
              </div>
            </div>

            <div class="review-actions">
              <label class="review-decision">
                <span>复核结论</span>
                <select v-model="recoveryReviewDecision" class="field-input">
                  <option value="approved">批准</option>
                  <option value="rework">返工</option>
                </select>
              </label>
              <label class="review-note">
                <span>复核备注</span>
                <textarea
                  v-model="recoveryReviewNote"
                  rows="2"
                  class="field-input resize-y"
                  placeholder="记录异常、返工原因或人工判断依据"
                ></textarea>
              </label>
            </div>

            <button
              class="primary-btn compact"
              type="button"
              :disabled="
                savingRecoveryReviewId === selectedRecoveryVideo.id ||
                Boolean(recoveryCharacterCheckError)
              "
              :title="recoveryCharacterCheckError || undefined"
              @click="onSaveRecoveryReview"
            >
              {{
                savingRecoveryReviewId === selectedRecoveryVideo.id
                  ? '保存复核中...'
                  : '保存人工复核'
              }}
            </button>
          </section>

          <div class="meta-grid">
            <div class="meta-card">
              <span class="meta-label">视频底图</span>
              <img
                v-if="confirmedImage"
                :src="confirmedImage.thumbnailUrl || confirmedImage.imageUrl"
                alt="confirmed frame"
                class="frame-thumb"
              />
            </div>
            <div class="meta-card">
              <span class="meta-label">当前分镜</span>
              <p class="meta-value">镜头 {{ storyboard?.shotNo || '-' }}</p>
              <p class="meta-sub">{{ storyboard?.shotType || '未填写景别' }}</p>
            </div>
            <div class="meta-card">
              <span class="meta-label">结束帧</span>
              <p class="meta-value">{{ confirmedEndFrame ? '已确认' : '未确认' }}</p>
              <p class="meta-sub">{{ confirmedEndFrame ? '作为动作终点约束' : '可先去画面结果页补齐' }}</p>
            </div>
            <div class="meta-card">
              <span class="meta-label">口型底片</span>
              <p class="meta-value">
                {{ motionBaseVideo ? `V${motionBaseVideo.versionNo}` : '未确认' }}
              </p>
              <p class="meta-sub">
                {{ motionBaseVideo ? '使用动作视频' : '将退回静帧口型' }}
              </p>
            </div>
          </div>
        </section>

        <section class="panel control-panel">
          <div class="panel-head">
            <h2>生成参数</h2>
            <span class="status-badge">{{ modelName }}</span>
          </div>

          <label class="field">
            <span>运动模式</span>
            <select v-model="motionMode" class="field-input">
              <option value="PAN">平移</option>
              <option value="ZOOM">推拉变焦</option>
              <option value="DOLLY">轨道推进</option>
            </select>
          </label>

          <label class="field">
            <span>视频动作提示词</span>
            <textarea
              v-model="motionPrompt"
              rows="5"
              class="field-input resize-y"
              placeholder="描述人物动作、环境变化，以及需要排除的错误效果"
            ></textarea>
          </label>

          <label class="field">
            <span>时长（秒）</span>
            <input
              v-model.number="durationSeconds"
              type="number"
              min="1"
              class="field-input"
              :disabled="isFixedDurationModel"
            />
          </label>

          <label class="field">
            <span>模型名</span>
            <input v-model="modelName" type="text" class="field-input" />
          </label>

          <div class="lip-sync-check" :class="{ blocked: lipSyncBlockedReason }">
            <div class="check-head">
              <div>
                <span class="check-kicker">口型检查</span>
                <strong>{{ lipSyncBlockedReason ? '需要先修正' : '可以生成口型' }}</strong>
              </div>
              <span class="status-badge" :class="{ confirmed: !lipSyncBlockedReason }">
                {{ lipSyncProvider || '未读取服务商' }}
              </span>
            </div>

            <div class="check-grid">
              <div>
                <span>当前分镜说话人</span>
                <b>{{ lipSyncSpeakerName }}</b>
              </div>
              <div>
                <span>已确认对白音频</span>
                <b>{{ audioSpeakerName }}</b>
              </div>
            </div>

            <p v-if="lipSyncBlockedReason" class="check-warning">{{ lipSyncBlockedReason }}</p>
            <p v-else class="check-copy">口型只会驱动当前分镜绑定的说话人，其他同框角色作为反应人物。</p>

            <div v-if="dialogueTurns.length" class="dialogue-order">
              <span>对白顺序按文本从上到下执行</span>
              <ol>
                <li v-for="turn in dialogueTurns.slice(0, 4)" :key="`${turn.index}-${turn.speaker}`">
                  <b>{{ turn.speaker }}</b>
                  <em>{{ turn.text }}</em>
                </li>
              </ol>
            </div>

            <div class="check-actions">
              <button class="ghost-btn compact" type="button" @click="backToStoryboardEditor">回分镜编辑</button>
              <button class="ghost-btn compact" type="button" @click="goToAudioModule">去音频页</button>
            </div>
          </div>

          <button class="primary-btn w-full" type="button" :disabled="generating" @click="onGenerate">
            {{ generating ? `后台生成中 ${generationProgress}%` : '开始生成视频' }}
          </button>

          <button
            class="ghost-btn mt-3 w-full"
            type="button"
            :disabled="!canGenerateLipSync"
            @click="onGenerateLipSync"
          >
            {{
              lipSyncing
                ? `口型同步 ${lipSyncProgress}%`
                : motionBaseVideo
                  ? '给动作视频加对白口型'
                  : '生成静帧对白口型'
            }}
          </button>

          <p class="helper-text">每次只为当前分镜生成 1 条候选视频，并绑定当前已确认的普通静帧或起始帧。</p>
          <p class="helper-text keyframe-note">{{ keyframeHelperText }}</p>
          <p class="helper-text lip-sync-note">{{ lipSyncHelperText }}</p>
        </section>
      </div>

      <section class="panel result-panel">
        <div class="panel-head">
          <h2>候选视频列表</h2>
          <span class="status-badge">{{ loadingVideos ? '刷新中' : `${videos.length} 条记录` }}</span>
        </div>

        <div v-if="!videos.length" class="empty-stage small">当前分镜还没有候选视频。</div>

        <div v-else class="result-list">
          <article
            v-for="item in videos"
            :key="item.id"
            class="result-card"
            :class="{
              active: item.id === selectedVideoId,
              confirmed: item.status === 'confirmed',
              recovery: item.isRecoveryVideo,
            }"
            @click="selectedVideoId = item.id"
          >
            <div class="result-thumb-wrap">
              <img
                :src="item.thumbnailUrl || confirmedImage?.imageUrl"
                alt="video thumbnail"
                class="result-thumb"
              />
              <span class="result-play">播放</span>
            </div>

            <div class="result-body">
              <div class="result-title-row">
                <strong>V{{ item.versionNo }}</strong>
                <span
                  class="status-badge"
                  :class="{
                    confirmed: item.status === 'confirmed' || isRecoveryReviewApproved(item),
                    rework: item.recoveryReview?.decision === 'rework',
                  }"
                >
                  {{ recoveryReviewStatusLabel(item) }}
                </span>
              </div>
              <p class="result-meta">{{ item.motionMode || '未设置运动模式' }}</p>
              <p class="result-meta">{{ formatShotDuration(item.durationSeconds) }} / {{ item.modelName || '-' }}</p>
              <p v-if="item.isRecoveryVideo" class="recovery-meta">
                {{
                  isRecoveryReviewApproved(item)
                    ? '抽帧证据与人工复核已留痕'
                    : '确认主版本前必须完成抽帧证据与人工复核'
                }}
              </p>
              <button
                class="confirm-btn"
                type="button"
                :disabled="
                  item.status === 'confirmed' ||
                  confirmingVideoId === item.id ||
                  isConfirmBlocked(item)
                "
                :title="
                  isConfirmBlocked(item)
                    ? '请先在当前预览区完成并保存三项人工复核'
                    : undefined
                "
                @click.stop="onConfirm(item.id)"
              >
                {{
                  item.status === 'confirmed'
                    ? '当前主版本'
                    : confirmingVideoId === item.id
                      ? '确认中...'
                      : isConfirmBlocked(item)
                        ? '待人工复核'
                      : '确认最终版本'
                }}
              </button>
            </div>
          </article>
        </div>
      </section>
    </div>
  </WorkspaceLayout>
</template>

<style scoped>
.video-page {
  min-height: 100vh;
  background:
    radial-gradient(circle at top right, rgba(217, 119, 6, 0.12), transparent 28%),
    linear-gradient(180deg, #111210 0%, #0a0b0a 100%);
  color: #f4ede5;
  padding: 24px;
}

.page-top {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 20px;
}

.eyebrow {
  color: #f0b56f;
  font-size: 11px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.page-title {
  font-size: 32px;
  font-weight: 800;
  margin: 0;
}

.page-subtitle {
  margin-top: 8px;
  color: #c7b39a;
  font-size: 14px;
}

.top-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.main-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(320px, 0.9fr);
  gap: 20px;
  margin-bottom: 20px;
}

.panel {
  background: rgba(20, 21, 19, 0.94);
  border: 1px solid #8d6f4a;
  padding: 18px;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
}

.panel-head h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}

.video-stage,
.empty-stage {
  border: 1px solid #5a4938;
  background: #090909;
  min-height: 300px;
}

.video-player {
  width: 100%;
  height: 100%;
  min-height: 300px;
  background: #000;
}

.empty-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #b79f84;
  font-size: 14px;
  text-align: center;
  padding: 24px;
}

.empty-stage.small {
  min-height: 120px;
}

.recovery-review {
  margin-top: 16px;
  border: 1px solid rgba(234, 179, 8, 0.5);
  background: rgba(113, 63, 18, 0.14);
  padding: 14px;
}

.recovery-review-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.recovery-review h3 {
  margin: 0;
  color: #fde68a;
  font-size: 15px;
  font-weight: 700;
}

.recovery-review-head p {
  margin: 5px 0 0;
  color: #d6c6ad;
  font-size: 12px;
  line-height: 1.6;
}

.recovery-evidence {
  margin-top: 14px;
  border: 1px solid rgba(34, 197, 94, 0.35);
  background: rgba(20, 83, 45, 0.14);
  padding: 12px;
}

.recovery-evidence.failed,
.recovery-evidence.missing {
  border-color: rgba(239, 68, 68, 0.45);
  background: rgba(127, 29, 29, 0.14);
}

.recovery-evidence.missing {
  margin: 14px 0 0;
  color: #fecaca;
  font-size: 12px;
  line-height: 1.6;
}

.recovery-evidence-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: #dcfce7;
  font-size: 12px;
}

.recovery-evidence.failed .recovery-evidence-head {
  color: #fecaca;
}

.recovery-evidence-head strong {
  font-size: 12px;
}

.recovery-spec {
  margin: 7px 0 0;
  color: #d6c6ad;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.recovery-sample-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 10px;
}

.recovery-sample {
  min-width: 0;
  margin: 0;
  border: 1px solid #5a4938;
  background: #161715;
}

.recovery-sample img {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  background: #0b0c0b;
}

.recovery-sample figcaption {
  padding: 5px 7px;
  color: #c9ab83;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.recovery-character-checklist {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}

.recovery-character-label {
  color: #e9c790;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.recovery-character-row {
  display: grid;
  grid-template-columns: 46px minmax(0, 1fr);
  gap: 9px;
  align-items: start;
  border-top: 1px solid rgba(201, 171, 131, 0.18);
  padding-top: 8px;
}

.recovery-character-row img {
  display: block;
  width: 46px;
  height: 58px;
  object-fit: cover;
  background: #0b0c0b;
}

.recovery-character-row strong {
  display: block;
  color: #f4ede5;
  font-size: 12px;
  line-height: 1.5;
}

.recovery-character-row p {
  margin: 2px 0 0;
  color: #d6c6ad;
  font-size: 12px;
  line-height: 1.45;
}

.recovery-character-row .recovery-character-missing {
  color: #fde68a;
}

.recovery-evidence-list {
  display: grid;
  gap: 4px;
  margin: 10px 0 0;
  padding-left: 18px;
  color: #d6c6ad;
  font-size: 12px;
  line-height: 1.55;
}

.recovery-evidence-list.error {
  color: #fecaca;
}

.recovery-evidence-list.warning {
  color: #fde68a;
}

.release-readiness {
  display: grid;
  gap: 5px;
  margin-top: 10px;
  border: 1px solid rgba(216, 180, 254, 0.35);
  background: rgba(88, 28, 135, 0.16);
  padding: 10px;
  color: #f3e8ff;
}

.release-readiness.release-ready {
  border-color: rgba(52, 211, 153, 0.35);
  background: rgba(6, 78, 59, 0.16);
  color: #d1fae5;
}

.release-readiness.not-ready {
  border-color: rgba(148, 163, 184, 0.35);
  background: rgba(51, 65, 85, 0.16);
  color: #e2e8f0;
}

.release-readiness strong {
  font-size: 12px;
}

.release-readiness p {
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
}

.review-checklist {
  display: grid;
  gap: 8px;
  margin-top: 14px;
}

.review-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: #f4ede5;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
}

.review-check input {
  width: 16px;
  height: 16px;
  margin: 2px 0 0;
  accent-color: #d97706;
}

.review-character-decisions {
  display: grid;
  gap: 8px;
  margin-top: 14px;
}

.review-section-label {
  color: #e9c790;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.review-character-decision {
  border-top: 1px solid rgba(201, 171, 131, 0.28);
  padding-top: 10px;
}

.review-character-decision-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 144px;
  gap: 12px;
  align-items: end;
}

.review-character-decision-head strong {
  color: #f4ede5;
  font-size: 13px;
  line-height: 1.45;
}

.review-character-decision label > span,
.review-character-note > span {
  display: block;
  margin-bottom: 5px;
  color: #c9ab83;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.review-character-note {
  display: block;
  margin-top: 8px;
}

.review-actions {
  display: grid;
  grid-template-columns: minmax(150px, 0.36fr) minmax(0, 1fr);
  gap: 10px;
  margin: 14px 0 12px;
}

.review-decision,
.review-note {
  display: block;
}

.review-decision > span,
.review-note > span {
  display: block;
  margin-bottom: 6px;
  color: #e9c790;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.meta-card {
  border: 1px solid #5a4938;
  background: #161715;
  padding: 12px;
}

.meta-label {
  display: block;
  color: #c9ab83;
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.meta-value {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}

.meta-sub {
  margin-top: 6px;
  color: #b79f84;
  font-size: 13px;
}

.frame-thumb {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border: 1px solid #5a4938;
}

.field {
  display: block;
  margin-bottom: 14px;
}

.field span {
  display: block;
  margin-bottom: 6px;
  color: #c9ab83;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.field-input {
  width: 100%;
  background: #0f100f;
  border: 1px solid #5a4938;
  color: #f4ede5;
  padding: 10px 12px;
  outline: none;
}

.field-input:focus {
  border-color: #f0b56f;
}

.helper-text {
  margin-top: 12px;
  color: #b79f84;
  font-size: 13px;
  line-height: 1.6;
}

.lip-sync-check {
  margin: 16px 0;
  border: 1px solid rgba(74, 222, 128, 0.36);
  background: rgba(20, 83, 45, 0.13);
  padding: 14px;
}

.lip-sync-check.blocked {
  border-color: rgba(248, 113, 113, 0.44);
  background: rgba(127, 29, 29, 0.14);
}

.check-head,
.check-actions {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: center;
}

.check-kicker {
  display: block;
  color: #c9ab83;
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  margin-bottom: 4px;
}

.check-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 12px;
}

.check-grid > div {
  border: 1px solid #5a4938;
  background: rgba(15, 16, 15, 0.76);
  padding: 10px;
}

.check-grid span,
.dialogue-order > span {
  display: block;
  color: #c9ab83;
  font-size: 11px;
  margin-bottom: 6px;
}

.check-grid b,
.dialogue-order b {
  color: #f4ede5;
}

.check-warning,
.check-copy {
  margin: 12px 0 0;
  color: #fecaca;
  font-size: 13px;
  line-height: 1.6;
}

.check-copy {
  color: #bbf7d0;
}

.dialogue-order {
  margin-top: 12px;
  border-top: 1px solid rgba(141, 111, 74, 0.55);
  padding-top: 12px;
}

.dialogue-order ol {
  margin: 0;
  padding-left: 20px;
}

.dialogue-order li {
  margin-top: 6px;
  color: #f4ede5;
}

.dialogue-order em {
  display: block;
  color: #b79f84;
  font-style: normal;
  margin-top: 2px;
  word-break: break-word;
}

.check-actions {
  margin-top: 12px;
  justify-content: flex-start;
}

.compact {
  padding: 7px 10px;
  font-size: 12px;
}

.result-panel {
  margin-top: 4px;
}

.result-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
}

.result-card {
  border: 1px solid #5a4938;
  background: #151614;
  cursor: pointer;
  transition:
    transform 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

.result-card:hover,
.result-card.active {
  border-color: #f0b56f;
  transform: translateY(-2px);
}

.result-card.confirmed {
  box-shadow: 0 0 0 1px rgba(240, 181, 111, 0.4);
}

.result-card.recovery {
  border-color: rgba(234, 179, 8, 0.5);
}

.result-thumb-wrap {
  position: relative;
}

.result-thumb {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  display: block;
}

.result-play {
  position: absolute;
  right: 10px;
  top: 10px;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  padding: 4px 8px;
  font-size: 11px;
  text-transform: uppercase;
}

.result-body {
  padding: 12px;
}

.result-title-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: center;
  margin-bottom: 8px;
}

.result-meta {
  margin: 4px 0;
  color: #b79f84;
  font-size: 13px;
}

.recovery-meta {
  margin: 8px 0 0;
  color: #fde68a;
  font-size: 12px;
  line-height: 1.5;
}

.primary-btn,
.ghost-btn,
.confirm-btn {
  border: 1px solid #8d6f4a;
  padding: 10px 14px;
  font-size: 13px;
  font-weight: 700;
  transition: 0.2s ease;
}

.primary-btn {
  background: #d97706;
  color: #111210;
}

.primary-btn:hover {
  filter: brightness(1.08);
}

.ghost-btn {
  background: transparent;
  color: #f4ede5;
}

.ghost-btn:hover,
.confirm-btn:hover {
  border-color: #f0b56f;
  color: #f0b56f;
}

.confirm-btn {
  width: 100%;
  margin-top: 12px;
  background: #10110f;
  color: #f4ede5;
}

.primary-btn:disabled,
.ghost-btn:disabled,
.confirm-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  border: 1px solid #5a4938;
  background: #171816;
  color: #c9ab83;
  font-size: 11px;
  padding: 4px 8px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.status-badge.confirmed {
  border-color: #f0b56f;
  color: #f0b56f;
}

.status-badge.rework {
  border-color: rgba(248, 113, 113, 0.65);
  color: #fecaca;
}

.message {
  margin-bottom: 14px;
  padding: 12px 14px;
  border: 1px solid;
  font-size: 13px;
}

.message.error {
  border-color: rgba(248, 113, 113, 0.5);
  background: rgba(127, 29, 29, 0.15);
  color: #fecaca;
}

.message.success {
  border-color: rgba(74, 222, 128, 0.4);
  background: rgba(20, 83, 45, 0.18);
  color: #bbf7d0;
}

.message.rework {
  border-color: rgba(255, 183, 125, 0.42);
  background: rgba(255, 183, 125, 0.1);
  color: #ffd9b0;
}

.state-card {
  width: min(560px, 100%);
  border: 1px solid #8d6f4a;
  background: rgba(20, 21, 19, 0.96);
  padding: 28px;
}

.state-title {
  margin: 0 0 10px;
  font-size: 24px;
  font-weight: 800;
  color: #f4ede5;
}

.state-desc {
  margin: 0 0 18px;
  color: #c7b39a;
  line-height: 1.7;
}

@media (max-width: 960px) {
  .video-page {
    padding: 16px;
  }

  .page-top,
  .panel-head {
    flex-direction: column;
    align-items: flex-start;
  }

  .main-grid {
    grid-template-columns: 1fr;
  }

  .meta-grid {
    grid-template-columns: 1fr;
  }

  .check-grid {
    grid-template-columns: 1fr;
  }

  .recovery-review-head {
    flex-direction: column;
  }

  .review-actions {
    grid-template-columns: 1fr;
  }

  .review-character-decision-head {
    grid-template-columns: 1fr;
    align-items: stretch;
  }

  .recovery-sample-grid {
    grid-template-columns: 1fr;
  }
}
</style>
