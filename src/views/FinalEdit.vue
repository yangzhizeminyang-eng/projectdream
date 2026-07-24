<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  getProject,
  getProjectFinalEdit,
  updateProjectFinalEditDraft,
  type FinalEditAudioClipDTO,
  type FinalEditAudioMixTrackDTO,
  type FinalEditDraftDTO,
  type FinalEditDTO,
  type FinalEditVideoClipDTO,
  type ProjectDTO,
} from '@/api/project'
import { getWorkspaceContext, setWorkspaceContext } from '@/lib/context'

type PageState = 'missing-project' | 'loading' | 'missing-video' | 'error' | 'ready'
type AudioTrackKey = 'dialogue' | 'narration' | 'music' | 'sfx'

const route = useRoute()
const router = useRouter()

const audioTrackMeta: Array<{ key: AudioTrackKey; label: string; tone: string }> = [
  { key: 'dialogue', label: '对白轨', tone: 'border-sky-400/30 bg-sky-400/10 text-sky-100' },
  { key: 'narration', label: '旁白轨', tone: 'border-amber-400/30 bg-amber-400/10 text-amber-100' },
  { key: 'music', label: '音乐轨', tone: 'border-primary/30 bg-primary/10 text-primary' },
  { key: 'sfx', label: '音效轨', tone: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100' },
]

const projectId = computed(() => {
  const fromQuery = Number(route.query.projectId) || 0
  if (fromQuery > 0) return fromQuery
  return getWorkspaceContext()?.projectId || 0
})

const pageState = ref<PageState>('loading')
const project = ref<ProjectDTO | null>(null)
const finalEdit = ref<FinalEditDTO | null>(null)
const editableVideoClips = ref<FinalEditVideoClipDTO[]>([])
const audioMixState = ref<FinalEditDraftDTO['audioMix']>(createEmptyAudioMix())
const selectedStoryboardId = ref<number | null>(null)
const lastSavedSignature = ref('')
const errorMsg = ref('')
const infoMsg = ref('')
const isSaving = ref(false)
const isPlaying = ref(false)
const volume = ref(80)
const videoRef = ref<HTMLVideoElement | null>(null)

const audioCounts = computed(() => ({
  dialogue: finalEdit.value?.audioTracks.dialogue.length || 0,
  narration: finalEdit.value?.audioTracks.narration.length || 0,
  music: finalEdit.value?.audioTracks.music.length || 0,
  sfx: finalEdit.value?.audioTracks.sfx.length || 0,
}))

const selectedVideo = computed<FinalEditVideoClipDTO | null>(
  () => editableVideoClips.value.find((item) => item.storyboardId === selectedStoryboardId.value) || null,
)

const totalTimelineDurationSeconds = computed(() =>
  editableVideoClips.value.reduce((sum, item) => sum + (Number(item.durationSeconds) || 0), 0),
)

const localValidation = computed(() => {
  const enabledVideoItems = editableVideoClips.value.filter((item) => item.enabled !== false)
  const enabledVideoDurationSeconds = enabledVideoItems.reduce(
    (sum, item) => sum + (Number(item.durationSeconds) || 0),
    0,
  )
  const availableAudioTrackCount = audioTrackMeta.filter(
    (track) => (finalEdit.value?.audioTracks[track.key].length || 0) > 0,
  ).length
  const enabledAudioTrackCount = audioTrackMeta.filter(
    (track) =>
      (finalEdit.value?.audioTracks[track.key].length || 0) > 0 && audioMixState.value[track.key].enabled,
  ).length

  const blockingIssues: Array<{ code: string; message: string }> = []
  const warningIssues: Array<{ code: string; message: string }> = []
  const totalStoryboardCount = finalEdit.value?.validation.totalStoryboardCount || 0
  const missingStoryboardSceneCount = finalEdit.value?.validation.missingStoryboardSceneCount || 0
  const missingVideoCount = Math.max(totalStoryboardCount - editableVideoClips.value.length, 0)

  if (missingStoryboardSceneCount > 0) {
    blockingIssues.push({
      code: 'missing-storyboards',
      message: `还有 ${missingStoryboardSceneCount} 个场景尚未生成分镜，请先完成场景拆镜。`,
    })
  } else if (totalStoryboardCount === 0) {
    blockingIssues.push({
      code: 'missing-storyboards',
      message: '当前项目还没有分镜，请先完成场景拆镜。',
    })
  } else if (missingVideoCount > 0) {
    blockingIssues.push({
      code: 'missing-confirmed-videos',
      message: `还有 ${missingVideoCount} 个分镜未确认最终视频，请全部完成后再导出。`,
    })
  }
  if (editableVideoClips.value.length > 0 && enabledVideoItems.length === 0) {
    blockingIssues.push({
      code: 'all-video-disabled',
      message: '当前所有视频片段都被禁用了，导出前至少保留一个启用片段。',
    })
  }

  if (availableAudioTrackCount === 0) {
    warningIssues.push({
      code: 'missing-audio',
      message: '当前还没有已确认音频，成片可以先预览视频，但导出前建议补齐音频主版本。',
    })
  } else if (enabledAudioTrackCount === 0) {
    warningIssues.push({
      code: 'all-audio-disabled',
      message: '当前所有音频轨都被关闭了，如需带音频导出，请至少开启一个轨道。',
    })
  }

  return {
    canExport: blockingIssues.length === 0,
    enabledVideoCount: enabledVideoItems.length,
    enabledVideoDurationSeconds,
    availableAudioTrackCount,
    enabledAudioTrackCount,
    blockingIssues,
    warningIssues,
  }
})

const hasAudio = computed(() => (finalEdit.value?.summary.confirmedAudioCount || 0) > 0)
const isDirty = computed(() => buildDraftSignature() !== lastSavedSignature.value)

const audioGroups = computed(() =>
  audioTrackMeta.map((track) => ({
    ...track,
    items: finalEdit.value?.audioTracks[track.key] || [],
    enabled: audioMixState.value[track.key].enabled,
    volume: audioMixState.value[track.key].volume,
  })),
)

function createEmptyAudioMix(): FinalEditDraftDTO['audioMix'] {
  return {
    dialogue: { enabled: false, volume: 100 },
    narration: { enabled: false, volume: 100 },
    music: { enabled: false, volume: 100 },
    sfx: { enabled: false, volume: 100 },
  }
}

function cloneAudioMix(source?: FinalEditDraftDTO['audioMix'] | null): FinalEditDraftDTO['audioMix'] {
  const fallback = createEmptyAudioMix()
  return {
    dialogue: cloneAudioMixTrack(source?.dialogue, fallback.dialogue),
    narration: cloneAudioMixTrack(source?.narration, fallback.narration),
    music: cloneAudioMixTrack(source?.music, fallback.music),
    sfx: cloneAudioMixTrack(source?.sfx, fallback.sfx),
  }
}

function cloneAudioMixTrack(
  track?: FinalEditAudioMixTrackDTO | null,
  fallback: FinalEditAudioMixTrackDTO = { enabled: false, volume: 100 },
): FinalEditAudioMixTrackDTO {
  return {
    enabled: track?.enabled !== false,
    volume: normalizeVolume(track?.volume, fallback.volume),
  }
}

function normalizeVolume(value?: number | null, fallback = 100): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(100, Math.round(n)))
}

function buildDraftPayload(): Pick<FinalEditDraftDTO, 'videoClips' | 'audioMix'> {
  return {
    videoClips: editableVideoClips.value.map((item, index) => ({
      storyboardId: item.storyboardId,
      enabled: item.enabled !== false,
      order: index + 1,
    })),
    audioMix: cloneAudioMix(audioMixState.value),
  }
}

function buildDraftSignature(): string {
  return JSON.stringify(buildDraftPayload())
}

function syncSelectedVideo(preferredStoryboardId?: number | null): void {
  if (
    preferredStoryboardId &&
    editableVideoClips.value.some((item) => item.storyboardId === preferredStoryboardId)
  ) {
    selectedStoryboardId.value = preferredStoryboardId
    return
  }

  selectedStoryboardId.value = editableVideoClips.value[0]?.storyboardId || null
}

function syncEditableState(data: FinalEditDTO, preferredStoryboardId?: number | null): void {
  finalEdit.value = data
  editableVideoClips.value = [...data.videoTrack.items]
    .sort((a, b) => a.order - b.order)
    .map((item, index) => ({
      ...item,
      enabled: item.enabled !== false,
      order: index + 1,
    }))
  audioMixState.value = cloneAudioMix(data.draft?.audioMix || data.audioMix)
  syncSelectedVideo(preferredStoryboardId)
  lastSavedSignature.value = buildDraftSignature()
}

function formatDuration(seconds?: number | null): string {
  const total = Number(seconds) || 0
  if (total <= 0) return '0s'

  const mins = Math.floor(total / 60)
  const rest = total % 60
  if (mins <= 0) return `${rest}s`
  if (rest === 0) return `${mins}m`
  return `${mins}m ${rest}s`
}

function formatDateTime(value?: string | null): string {
  if (!value) return '时间未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function resolveShotLabel(item: FinalEditVideoClipDTO): string {
  return item.shotNo || `SHOT ${item.storyboardId}`
}

function clipWidthStyle(durationSeconds?: number | null): Record<string, string> {
  const total = totalTimelineDurationSeconds.value || 1
  const duration = Math.max(Number(durationSeconds) || 4, 2)
  const width = Math.max((duration / total) * 100, 16)
  return { width: `${width}%`, minWidth: '220px' }
}

function audioClipWidthStyle(item: FinalEditAudioClipDTO): Record<string, string> {
  const total = totalTimelineDurationSeconds.value || 24
  const duration = Math.max(Number(item.durationSeconds) || 4, 2)
  const width = Math.max((duration / total) * 100, 10)
  return { width: `${Math.min(width, 100)}%`, minWidth: '100px' }
}

function goDashboard(): void {
  router.push('/dashboard')
}

function goWorkspace(): void {
  if (!projectId.value) {
    router.push('/dashboard')
    return
  }

  router.push({
    path: '/workspace/scenes',
    query: { projectId: String(projectId.value) },
  })
}

function goAudio(): void {
  if (!projectId.value) return
  router.push({ path: '/workspace/audio', query: { projectId: String(projectId.value) } })
}

async function goExport(): Promise<void> {
  if (!projectId.value) return
  if (!localValidation.value.canExport) {
    errorMsg.value = localValidation.value.blockingIssues[0]?.message || '当前成片草稿不可导出'
    return
  }

  if (isDirty.value) {
    const saved = await handleSaveDraft(true)
    if (!saved) return
  }

  router.push({ path: '/workspace/export', query: { projectId: String(projectId.value) } })
}

function goTaskCenter(): void {
  if (!projectId.value) return
  router.push({ path: '/workspace/ai-tasks', query: { projectId: String(projectId.value) } })
}

function togglePlay(): void {
  const video = videoRef.value
  if (!video) return

  if (video.paused) {
    void video.play()
    isPlaying.value = true
    return
  }

  video.pause()
  isPlaying.value = false
}

function onVolumeChange(): void {
  const video = videoRef.value
  if (!video) return
  video.volume = Math.max(0, Math.min(1, volume.value / 100))
}

function selectVideo(storyboardId: number): void {
  selectedStoryboardId.value = storyboardId
}

function moveClip(storyboardId: number, direction: -1 | 1): void {
  const index = editableVideoClips.value.findIndex((item) => item.storyboardId === storyboardId)
  if (index < 0) return

  const targetIndex = index + direction
  if (targetIndex < 0 || targetIndex >= editableVideoClips.value.length) return

  const nextItems = [...editableVideoClips.value]
  const [current] = nextItems.splice(index, 1)
  if (!current) return
  nextItems.splice(targetIndex, 0, current)
  editableVideoClips.value = nextItems.map((item, itemIndex) => ({
    ...item,
    order: itemIndex + 1,
  }))
}

function toggleClipEnabled(storyboardId: number): void {
  editableVideoClips.value = editableVideoClips.value.map((item) =>
    item.storyboardId === storyboardId ? { ...item, enabled: item.enabled === false } : item,
  )
}

function updateTrackEnabled(trackKey: AudioTrackKey, enabled: boolean): void {
  audioMixState.value = {
    ...audioMixState.value,
    [trackKey]: {
      ...audioMixState.value[trackKey],
      enabled,
    },
  }
}

function updateTrackVolume(trackKey: AudioTrackKey, volumeValue: number): void {
  audioMixState.value = {
    ...audioMixState.value,
    [trackKey]: {
      ...audioMixState.value[trackKey],
      volume: normalizeVolume(volumeValue),
    },
  }
}

function resetDraft(): void {
  if (!finalEdit.value) return
  syncEditableState(finalEdit.value, selectedStoryboardId.value)
  infoMsg.value = '已恢复到最近一次保存的成片草稿。'
  errorMsg.value = ''
}

async function handleSaveDraft(silentSuccess = false): Promise<boolean> {
  if (!projectId.value || !finalEdit.value) return false
  if (isSaving.value) return false

  isSaving.value = true
  errorMsg.value = ''

  try {
    const payload = await updateProjectFinalEditDraft(projectId.value, buildDraftPayload())
    syncEditableState(payload, selectedStoryboardId.value)
    pageState.value = payload.summary.hasVideo ? 'ready' : 'missing-video'
    if (!silentSuccess) {
      infoMsg.value = '成片编辑草稿已保存。'
    }
    return true
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '成片编辑草稿保存失败'
    return false
  } finally {
    isSaving.value = false
  }
}

async function loadPage(): Promise<void> {
  if (!projectId.value) {
    pageState.value = 'missing-project'
    project.value = null
    finalEdit.value = null
    editableVideoClips.value = []
    audioMixState.value = createEmptyAudioMix()
    selectedStoryboardId.value = null
    return
  }

  pageState.value = 'loading'
  errorMsg.value = ''
  infoMsg.value = ''

  try {
    setWorkspaceContext({ projectId: projectId.value })
    const [projectData, finalEditData] = await Promise.all([
      getProject(projectId.value),
      getProjectFinalEdit(projectId.value),
    ])

    project.value = projectData
    syncEditableState(finalEditData, selectedStoryboardId.value)

    if (!finalEditData.summary.hasVideo) {
      pageState.value = 'missing-video'
      return
    }

    pageState.value = 'ready'
    if (!finalEditData.summary.hasAudio) {
      infoMsg.value = '当前还没有已确认音频，建议在导出前先去音频模块确认主版本。'
    }
    onVolumeChange()
  } catch (error) {
    project.value = null
    finalEdit.value = null
    editableVideoClips.value = []
    audioMixState.value = createEmptyAudioMix()
    selectedStoryboardId.value = null
    errorMsg.value = error instanceof Error ? error.message : '成片编辑模块加载失败'
    pageState.value = 'error'
  }
}

watch(
  () => route.query.projectId,
  () => {
    void loadPage()
  },
)

watch(selectedStoryboardId, () => {
  isPlaying.value = false
})

onMounted(() => {
  void loadPage()
})
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true">
    <section
      v-if="pageState === 'missing-project'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div
        class="max-w-2xl rounded-[24px] border border-outline-variant bg-surface-container-low p-8 text-center"
      >
        <h2 class="text-2xl font-semibold text-on-surface">缺少项目上下文</h2>
        <p class="mt-3 text-sm leading-6 text-on-surface-variant">
          成片编辑是项目级页面，请先从具体项目的工作区进入。
        </p>
        <button
          class="burning-orange-btn mt-6 px-5 py-2 text-sm font-semibold"
          type="button"
          @click="goDashboard"
        >
          返回项目页
        </button>
      </div>
    </section>

    <div
      v-else-if="pageState === 'loading'"
      class="flex h-full items-center justify-center bg-[#111210] text-sm text-[#c7b39a]"
    >
      正在加载成片编辑模块...
    </div>

    <section
      v-else-if="pageState === 'error'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="max-w-2xl rounded-[24px] border border-red-500/30 bg-red-500/5 p-8 text-center">
        <h2 class="text-2xl font-semibold text-red-300">成片编辑模块加载失败</h2>
        <p class="mt-3 text-sm leading-6 text-on-surface-variant">
          {{ errorMsg || '请稍后重试。' }}
        </p>
        <div class="mt-6 flex flex-wrap justify-center gap-3">
          <button
            class="rounded-[14px] border border-outline-variant px-4 py-2 text-sm text-on-surface-variant"
            type="button"
            @click="loadPage"
          >
            重新加载
          </button>
          <button
            class="burning-orange-btn px-5 py-2 text-sm font-semibold"
            type="button"
            @click="goWorkspace"
          >
            返回工作区
          </button>
        </div>
      </div>
    </section>

    <section
      v-else-if="pageState === 'missing-video'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div
        class="max-w-2xl rounded-[24px] border border-outline-variant bg-surface-container-low p-8 text-center"
      >
        <h2 class="text-2xl font-semibold text-on-surface">当前项目还没有已确认视频</h2>
        <p class="mt-3 text-sm leading-6 text-on-surface-variant">
          请先在视频模块确认至少一个主视频，再进入成片编辑模块。
        </p>
        <div class="mt-6 flex flex-wrap justify-center gap-3">
          <button
            class="rounded-[14px] border border-outline-variant px-4 py-2 text-sm text-on-surface-variant"
            type="button"
            @click="goWorkspace"
          >
            返回工作区
          </button>
          <button
            class="burning-orange-btn px-5 py-2 text-sm font-semibold"
            type="button"
            @click="goTaskCenter"
          >
            去任务中心查看
          </button>
        </div>
      </div>
    </section>

    <div v-else class="flex h-full bg-background">
      <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header class="border-b border-outline-variant bg-surface-container-low px-6 py-5">
          <div class="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <p class="text-[11px] uppercase tracking-[0.22em] text-primary">
                {{ project?.name || `Project ${projectId}` }}
              </p>
              <h1 class="mt-2 text-3xl font-semibold text-on-surface">成片编辑</h1>
              <p class="mt-2 max-w-3xl text-sm leading-6 text-on-surface-variant">
                二期开始支持项目级编辑草稿：你可以调整片段顺序、开关片段、控制音频轨道开关与音量，并把当前状态保存给导出模块使用。
              </p>
            </div>

            <div class="flex flex-wrap gap-3">
              <button
                class="rounded-[14px] border border-outline-variant px-4 py-2 text-sm text-on-surface-variant"
                type="button"
                @click="goTaskCenter"
              >
                任务中心
              </button>
              <button
                class="rounded-[14px] border border-outline-variant px-4 py-2 text-sm text-on-surface-variant"
                type="button"
                @click="goAudio"
              >
                音频模块
              </button>
              <button
                class="rounded-[14px] border border-outline-variant px-4 py-2 text-sm text-on-surface-variant"
                type="button"
                :disabled="!isDirty || isSaving"
                @click="resetDraft"
              >
                恢复已保存草稿
              </button>
              <button
                class="burning-orange-btn px-5 py-2 text-sm font-semibold"
                type="button"
                :disabled="isSaving"
                @click="handleSaveDraft()"
              >
                {{ isSaving ? '保存中...' : isDirty ? '保存成片草稿' : '草稿已保存' }}
              </button>
            </div>
          </div>
        </header>

        <div class="border-b border-outline-variant bg-background px-6 py-4">
          <div v-if="errorMsg" class="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {{ errorMsg }}
          </div>
          <div
            v-if="infoMsg"
            class="mt-3 rounded-2xl border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary"
          >
            {{ infoMsg }}
          </div>

          <div class="mt-4 grid gap-4 xl:grid-cols-5">
            <article class="rounded-[20px] border border-outline-variant bg-surface-container-low px-5 py-4">
              <p class="text-[11px] uppercase tracking-[0.18em] text-primary">已确认视频</p>
              <p class="mt-3 text-3xl font-semibold text-on-surface">
                {{ finalEdit?.summary.confirmedVideoCount || 0 }}
              </p>
            </article>
            <article class="rounded-[20px] border border-outline-variant bg-surface-container-low px-5 py-4">
              <p class="text-[11px] uppercase tracking-[0.18em] text-primary">启用片段</p>
              <p class="mt-3 text-3xl font-semibold text-on-surface">
                {{ localValidation.enabledVideoCount }}
              </p>
            </article>
            <article class="rounded-[20px] border border-outline-variant bg-surface-container-low px-5 py-4">
              <p class="text-[11px] uppercase tracking-[0.18em] text-primary">启用时长</p>
              <p class="mt-3 text-3xl font-semibold text-on-surface">
                {{ formatDuration(localValidation.enabledVideoDurationSeconds) }}
              </p>
            </article>
            <article class="rounded-[20px] border border-outline-variant bg-surface-container-low px-5 py-4">
              <p class="text-[11px] uppercase tracking-[0.18em] text-primary">已确认音频</p>
              <p class="mt-3 text-3xl font-semibold text-on-surface">
                {{ finalEdit?.summary.confirmedAudioCount || 0 }}
              </p>
            </article>
            <article class="rounded-[20px] border border-outline-variant bg-surface-container-low px-5 py-4">
              <p class="text-[11px] uppercase tracking-[0.18em] text-primary">启用音频轨</p>
              <p class="mt-3 text-3xl font-semibold text-on-surface">
                {{ localValidation.enabledAudioTrackCount }}
              </p>
            </article>
          </div>
        </div>

        <div class="flex min-h-0 flex-1 flex-col xl:flex-row">
          <main class="custom-scrollbar min-w-0 flex-1 overflow-y-auto p-6">
            <section class="rounded-[26px] border border-outline-variant bg-surface-container-low px-6 py-6">
              <div class="relative overflow-hidden rounded-[22px] border border-outline-variant bg-black">
                <video
                  v-if="selectedVideo?.sourceType !== 'static'"
                  ref="videoRef"
                  class="aspect-video w-full bg-black object-contain"
                  :src="selectedVideo?.videoUrl || undefined"
                  :poster="selectedVideo?.thumbnailUrl || undefined"
                  controls
                  @play="isPlaying = true"
                  @pause="isPlaying = false"
                  @ended="isPlaying = false"
                  @volumechange="volume = Math.round(($event.target as HTMLVideoElement).volume * 100)"
                ></video>
                <img
                  v-else
                  class="aspect-video w-full bg-black object-contain"
                  :src="selectedVideo?.imageUrl || selectedVideo?.thumbnailUrl || undefined"
                  :alt="selectedVideo ? resolveShotLabel(selectedVideo) : 'static frame'"
                />

                <div
                  class="pointer-events-none absolute left-4 top-4 rounded-full border border-primary/30 bg-black/55 px-3 py-1 text-xs text-primary"
                >
                  {{
                    selectedVideo
                      ? `Scene ${String(selectedVideo.sceneNo).padStart(2, '0')} / ${resolveShotLabel(selectedVideo)}`
                      : '暂无选中片段'
                  }}
                </div>
                <div
                  v-if="selectedVideo && selectedVideo.enabled === false"
                  class="pointer-events-none absolute right-4 top-4 rounded-full border border-red-400/30 bg-red-500/20 px-3 py-1 text-xs text-red-200"
                >
                  当前片段已禁用
                </div>
              </div>

              <div class="mt-5 flex flex-wrap items-center justify-between gap-4">
                <div class="flex items-center gap-4">
                  <button
                    class="material-symbols-outlined text-3xl text-primary"
                    type="button"
                    @click="togglePlay"
                  >
                    {{ isPlaying ? 'pause_circle' : 'play_circle' }}
                  </button>

                  <div class="text-sm text-on-surface-variant">
                    <p class="font-medium text-on-surface">
                      {{ selectedVideo?.sceneTitle || '请先选择一个视频片段' }}
                    </p>
                    <p>
                      {{
                        selectedVideo
                          ? `${resolveShotLabel(selectedVideo)} / ${formatDuration(selectedVideo.durationSeconds)}`
                          : '暂无可播放片段'
                      }}
                    </p>
                  </div>
                </div>

                <label class="flex items-center gap-3 text-sm text-on-surface-variant">
                  <span>预览音量</span>
                  <input
                    v-model.number="volume"
                    type="range"
                    min="0"
                    max="100"
                    class="w-32 accent-[var(--color-primary)]"
                    @input="onVolumeChange"
                  />
                  <span>{{ volume }}%</span>
                </label>
              </div>
            </section>

            <section class="mt-6 rounded-[26px] border border-outline-variant bg-surface-container-low px-6 py-5">
              <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p class="text-[11px] uppercase tracking-[0.22em] text-primary">Timeline</p>
                  <h2 class="mt-2 text-xl font-semibold text-on-surface">视频时间线草稿</h2>
                </div>
                <p class="text-sm text-on-surface-variant">
                  共 {{ editableVideoClips.length }} 个片段 / 启用 {{ localValidation.enabledVideoCount }} 个
                </p>
              </div>

              <div class="rounded-2xl border border-outline-variant bg-background px-3 py-3">
                <div class="flex gap-3 overflow-x-auto pb-2">
                  <article
                    v-for="(clip, index) in editableVideoClips"
                    :key="clip.storyboardId"
                    class="flex flex-col rounded-2xl border p-3 transition-all"
                    :class="
                      selectedStoryboardId === clip.storyboardId
                        ? 'border-primary bg-primary/10'
                        : clip.enabled === false
                          ? 'border-red-500/20 bg-red-500/5'
                          : 'border-outline-variant bg-surface-container-low'
                    "
                    :style="clipWidthStyle(clip.durationSeconds)"
                  >
                    <button type="button" class="text-left" @click="selectVideo(clip.storyboardId)">
                      <img
                        v-if="clip.thumbnailUrl"
                        :src="clip.thumbnailUrl"
                        :alt="resolveShotLabel(clip)"
                        class="mb-3 h-24 w-full rounded-xl object-cover"
                      />
                      <div class="space-y-1">
                        <p class="truncate text-sm font-semibold text-on-surface">
                          Scene {{ String(clip.sceneNo).padStart(2, '0') }} / {{ resolveShotLabel(clip) }}
                        </p>
                        <p class="text-xs text-on-surface-variant">
                          {{ clip.shotType || '未标注镜头类型' }} / {{ formatDuration(clip.durationSeconds) }}
                        </p>
                      </div>
                    </button>

                    <div class="mt-3 flex items-center justify-between text-xs">
                      <span
                        class="rounded-full px-2 py-1"
                        :class="
                          clip.enabled === false
                            ? 'bg-red-500/15 text-red-200'
                            : 'bg-emerald-500/15 text-emerald-200'
                        "
                      >
                        {{ clip.enabled === false ? '已禁用' : '已启用' }}
                      </span>
                      <span class="text-on-surface-variant">顺位 {{ index + 1 }}</span>
                    </div>

                    <div class="mt-3 grid grid-cols-3 gap-2">
                      <button
                        class="rounded-xl border border-outline-variant px-2 py-2 text-xs text-on-surface-variant disabled:opacity-35"
                        type="button"
                        :disabled="index === 0"
                        @click="moveClip(clip.storyboardId, -1)"
                      >
                        上移
                      </button>
                      <button
                        class="rounded-xl border border-outline-variant px-2 py-2 text-xs text-on-surface-variant disabled:opacity-35"
                        type="button"
                        :disabled="index === editableVideoClips.length - 1"
                        @click="moveClip(clip.storyboardId, 1)"
                      >
                        下移
                      </button>
                      <button
                        class="rounded-xl border px-2 py-2 text-xs"
                        :class="
                          clip.enabled === false
                            ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
                            : 'border-red-400/30 bg-red-500/10 text-red-200'
                        "
                        type="button"
                        @click="toggleClipEnabled(clip.storyboardId)"
                      >
                        {{ clip.enabled === false ? '启用' : '禁用' }}
                      </button>
                    </div>
                  </article>
                </div>
              </div>
            </section>

            <section class="mt-6 rounded-[26px] border border-outline-variant bg-surface-container-low px-6 py-5">
              <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p class="text-[11px] uppercase tracking-[0.22em] text-primary">Audio Mix</p>
                  <h2 class="mt-2 text-xl font-semibold text-on-surface">音频轨控制</h2>
                </div>
                <p class="text-sm text-on-surface-variant">
                  可用音频轨 {{ localValidation.availableAudioTrackCount }} / 已启用 {{ localValidation.enabledAudioTrackCount }}
                </p>
              </div>

              <div class="space-y-4">
                <div
                  v-for="group in audioGroups"
                  :key="group.key"
                  class="rounded-2xl border border-outline-variant bg-background px-4 py-4"
                >
                  <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div class="flex items-center gap-3">
                      <span class="rounded-full border px-3 py-1 text-xs" :class="group.tone">
                        {{ group.label }}
                      </span>
                      <span class="text-sm text-on-surface-variant">
                        {{ group.items.length ? `${group.items.length} 条已确认音频` : '当前还没有已确认音频' }}
                      </span>
                    </div>

                    <div class="flex flex-wrap items-center gap-4 text-sm">
                      <label class="flex items-center gap-2 text-on-surface-variant">
                        <input
                          :checked="group.enabled"
                          :disabled="group.items.length === 0"
                          type="checkbox"
                          class="h-4 w-4 accent-[var(--color-primary)]"
                          @change="updateTrackEnabled(group.key, ($event.target as HTMLInputElement).checked)"
                        />
                        <span>{{ group.enabled ? '轨道开启' : '轨道关闭' }}</span>
                      </label>

                      <label class="flex items-center gap-3 text-on-surface-variant">
                        <span>音量</span>
                        <input
                          :value="group.volume"
                          :disabled="group.items.length === 0"
                          type="range"
                          min="0"
                          max="100"
                          class="w-32 accent-[var(--color-primary)]"
                          @input="updateTrackVolume(group.key, Number(($event.target as HTMLInputElement).value))"
                        />
                        <span>{{ group.volume }}%</span>
                      </label>
                    </div>
                  </div>

                  <div v-if="group.items.length" class="mt-4 flex gap-2 overflow-x-auto pb-1">
                    <div
                      v-for="item in group.items"
                      :key="item.id"
                      class="rounded-2xl border px-3 py-3"
                      :class="group.tone"
                      :style="audioClipWidthStyle(item)"
                    >
                      <p class="truncate text-sm font-semibold">{{ item.title }}</p>
                      <p class="mt-1 text-xs opacity-80">
                        {{ item.sceneId ? `Scene ${String(item.sceneId).padStart(2, '0')}` : '项目级音轨' }}
                        / {{ formatDuration(item.durationSeconds) }}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </main>

          <aside
            class="w-full border-t border-outline-variant bg-surface-container-low xl:w-[360px] xl:flex-shrink-0 xl:border-l xl:border-t-0"
          >
            <div class="custom-scrollbar h-full overflow-y-auto p-5">
              <div class="rounded-[24px] border border-outline-variant bg-background px-5 py-5">
                <p class="text-[11px] uppercase tracking-[0.22em] text-primary">Inspector</p>
                <h2 class="mt-2 text-2xl font-semibold text-on-surface">
                  {{
                    selectedVideo
                      ? `${resolveShotLabel(selectedVideo)} / Scene ${String(selectedVideo.sceneNo).padStart(2, '0')}`
                      : '未选中片段'
                  }}
                </h2>

                <div class="mt-5 space-y-3 text-sm text-on-surface-variant">
                  <p>
                    <span class="text-on-surface">场景：</span>
                    {{ selectedVideo?.sceneTitle || '暂无' }}
                  </p>
                  <p>
                    <span class="text-on-surface">镜头类型：</span>
                    {{ selectedVideo?.shotType || '未标注' }}
                  </p>
                  <p>
                    <span class="text-on-surface">片段时长：</span>
                    {{ formatDuration(selectedVideo?.durationSeconds) }}
                  </p>
                  <p>
                    <span class="text-on-surface">候选版本：</span>
                    V{{ selectedVideo?.versionNo || 0 }}
                  </p>
                  <p>
                    <span class="text-on-surface">当前状态：</span>
                    {{ selectedVideo?.enabled === false ? '已禁用' : '已启用' }}
                  </p>
                  <p>
                    <span class="text-on-surface">确认时间：</span>
                    {{ formatDateTime(selectedVideo?.confirmedAt) }}
                  </p>
                </div>
              </div>

              <div class="mt-5 rounded-[24px] border border-outline-variant bg-background px-5 py-5">
                <p class="text-[11px] uppercase tracking-[0.22em] text-primary">Validation</p>
                <div class="mt-4 space-y-3">
                  <div
                    v-if="localValidation.blockingIssues.length === 0 && localValidation.warningIssues.length === 0"
                    class="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200"
                  >
                    当前成片草稿可以直接进入导出。
                  </div>

                  <div
                    v-for="issue in localValidation.blockingIssues"
                    :key="issue.code"
                    class="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200"
                  >
                    {{ issue.message }}
                  </div>

                  <div
                    v-for="issue in localValidation.warningIssues"
                    :key="issue.code"
                    class="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100"
                  >
                    {{ issue.message }}
                  </div>
                </div>

                <div class="mt-5 grid grid-cols-2 gap-3 text-sm">
                  <div class="rounded-2xl border border-outline-variant bg-surface-container-low px-4 py-3">
                    <p class="text-on-surface-variant">对白轨</p>
                    <p class="mt-2 text-2xl font-semibold text-on-surface">{{ audioCounts.dialogue }}</p>
                  </div>
                  <div class="rounded-2xl border border-outline-variant bg-surface-container-low px-4 py-3">
                    <p class="text-on-surface-variant">旁白轨</p>
                    <p class="mt-2 text-2xl font-semibold text-on-surface">{{ audioCounts.narration }}</p>
                  </div>
                  <div class="rounded-2xl border border-outline-variant bg-surface-container-low px-4 py-3">
                    <p class="text-on-surface-variant">音乐轨</p>
                    <p class="mt-2 text-2xl font-semibold text-on-surface">{{ audioCounts.music }}</p>
                  </div>
                  <div class="rounded-2xl border border-outline-variant bg-surface-container-low px-4 py-3">
                    <p class="text-on-surface-variant">音效轨</p>
                    <p class="mt-2 text-2xl font-semibold text-on-surface">{{ audioCounts.sfx }}</p>
                  </div>
                </div>

                <p class="mt-4 text-sm leading-6 text-on-surface-variant">
                  {{
                    hasAudio
                      ? '当前已支持保存项目级成片草稿，导出时会带上当前视频排序、启用状态和音频控制配置。'
                      : '当前还没有已确认音频，成片草稿仍可先保存视频时间线，但建议在导出前补齐音频。'
                  }}
                </p>

                <div class="mt-5 flex flex-col gap-3">
                  <button
                    class="rounded-[14px] border border-outline-variant px-4 py-3 text-sm text-on-surface-variant"
                    type="button"
                    @click="goAudio"
                  >
                    去完善音频主版本
                  </button>
                  <button
                    class="burning-orange-btn px-4 py-3 text-sm font-semibold disabled:opacity-50"
                    type="button"
                    :disabled="!localValidation.canExport"
                    @click="goExport"
                  >
                    保存并进入导出
                  </button>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  </WorkspaceLayout>
</template>
