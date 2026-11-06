<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  downloadProjectDeliveryArchive,
  exportProjectJianyingDraft,
  getProject,
  getProjectDeliveryPackage,
  getProjectFinalEdit,
  getProjectJianyingPlan,
  getProjectJianyingStatus,
  listStoryboardVideos,
  uninstallProjectJianyingDraft,
  updateProjectFinalEditDraft,
  type DeliveryPackageDTO,
  type FinalEditAudioClipDTO,
  type FinalEditAudioMixTrackDTO,
  type FinalEditDraftDTO,
  type FinalEditDTO,
  type FinalEditOverlayClipDTO,
  type FinalEditVideoClipDTO,
  type JianyingDraftPlanDTO,
  type JianyingExportResultDTO,
  type JianyingStatusDTO,
  type ProjectDTO,
  type VideoAssetDTO,
} from '@/api/project'
import { getWorkspaceContext, setWorkspaceContext } from '@/lib/context'

type PageState = 'missing-project' | 'loading' | 'missing-video' | 'error' | 'ready'
type AudioTrackKey = 'dialogue' | 'narration' | 'music' | 'sfx'
type TransitionType = 'cut' | 'fade' | 'dip' | 'push'
type TrimEdge = 'start' | 'end'
type PreviewMode = 'program' | 'clip'
type DraftPayload = Pick<
  FinalEditDraftDTO,
  | 'videoClips'
  | 'overlayClips'
  | 'audioMix'
  | 'audioClips'
  | 'subtitleCues'
  | 'beatMarkers'
  | 'emotionCurve'
  | 'versionHistory'
>
type OverlayPosition = FinalEditOverlayClipDTO['position']

const route = useRoute()
const router = useRouter()

const audioTrackMeta: Array<{ key: AudioTrackKey; label: string; tone: string }> = [
  { key: 'dialogue', label: '对白轨', tone: 'border-sky-400/30 bg-sky-400/10 text-sky-100' },
  { key: 'narration', label: '旁白轨', tone: 'border-amber-400/30 bg-amber-400/10 text-amber-100' },
  { key: 'music', label: '音乐轨', tone: 'border-primary/30 bg-primary/10 text-primary' },
  { key: 'sfx', label: '音效轨', tone: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100' },
]

const transitionOptions: Array<{ value: TransitionType; label: string }> = [
  { value: 'cut', label: '硬切' },
  { value: 'fade', label: '淡入淡出' },
  { value: 'dip', label: '暗场过渡' },
  { value: 'push', label: '轻推镜头' },
]

const projectId = computed(() => {
  const fromQuery = Number(route.query.projectId) || 0
  if (fromQuery > 0) return fromQuery
  return getWorkspaceContext()?.projectId || 0
})
const selectedEpisodeNo = computed(() => {
  const value = Number(route.query.episodeNo) || 0
  return value > 0 ? value : undefined
})

const pageState = ref<PageState>('loading')
const project = ref<ProjectDTO | null>(null)
const finalEdit = ref<FinalEditDTO | null>(null)
const editableVideoClips = ref<FinalEditVideoClipDTO[]>([])
const editableAudioTracks = ref<Record<AudioTrackKey, FinalEditAudioClipDTO[]>>(createEmptyAudioTracks())
const audioMixState = ref<FinalEditDraftDTO['audioMix']>(createEmptyAudioMix())
const editableSubtitleCues = ref<FinalEditDraftDTO['subtitleCues']>([])
const selectedStoryboardId = ref<number | null>(null)
const selectedClipId = ref<string | null>(null)
const selectedVideoCandidates = ref<VideoAssetDTO[]>([])
const draggedClipId = ref<string | null>(null)
const draggedClipFromBin = ref(false)
const mainDropIndex = ref<number | null>(null)
const timelineMainLaneRef = ref<HTMLElement | null>(null)
const timelineOverlayLaneRef = ref<HTMLElement | null>(null)
// 画中画叠加轨：引用已确认镜头，只记录起点/时长/锚点/缩放/不透明度，不复制素材。
const overlayClips = ref<FinalEditOverlayClipDTO[]>([])
const selectedOverlayClipId = ref<string | null>(null)
const overlayDropActive = ref(false)
const overlayPointerDrag = ref<{
  clipId: string
  startX: number
  initialStart: number
  moved: boolean
} | null>(null)
const clipPointerDrag = ref<{
  clipId: string
  startX: number
  currentIndex: number
  moved: boolean
} | null>(null)
const suppressClipClick = ref(false)
const undoStack = ref<string[]>([])
const redoStack = ref<string[]>([])
const beatMarkers = ref<NonNullable<FinalEditDraftDTO['beatMarkers']>>([])
const emotionCurve = ref<NonNullable<FinalEditDraftDTO['emotionCurve']>>([])
const versionHistory = ref<NonNullable<FinalEditDraftDTO['versionHistory']>>([])
const lastSavedSignature = ref('')
const errorMsg = ref('')
const infoMsg = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
const isSaving = ref(false)
const isLoadingVideoCandidates = ref(false)
const isPlaying = ref(false)
const volume = ref(80)
const videoRef = ref<HTMLVideoElement | null>(null)
const previewAudioElements = new Map<number, HTMLAudioElement>()
const previewMode = ref<PreviewMode>('program')
const timelinePositionSeconds = ref(0)
const isScrubbingTimeline = ref(false)
const timelinePixelsPerSecond = ref(72)
const timelineSnapEnabled = ref(true)
const timelineDockHeight = ref(200)
const timelineResize = ref<{ startY: number; initialHeight: number } | null>(null)
const trimDrag = ref<{
  clipId: string
  edge: TrimEdge
  startX: number
  initialStart: number
  initialEnd: number
} | null>(null)
const activeMaterialPanel = ref<'media' | 'audio' | 'text' | 'transitions'>('media')
const activeInspectorTab = ref<'picture' | 'audio' | 'subtitle' | 'review' | 'versions'>('picture')
let programAdvanceTimer: ReturnType<typeof setTimeout> | null = null
let previewAudioSyncTimer: ReturnType<typeof setInterval> | null = null
let previewClockLastAt = 0
let programTransitioning = false

function clearToastTimer(): void {
  if (toastTimer) {
    clearTimeout(toastTimer)
    toastTimer = null
  }
}

function showInfo(message: string, duration = 2800): void {
  clearToastTimer()
  errorMsg.value = ''
  infoMsg.value = message
  toastTimer = setTimeout(() => {
    infoMsg.value = ''
    toastTimer = null
  }, duration)
}

function showError(message: string, duration = 4600): void {
  clearToastTimer()
  infoMsg.value = ''
  errorMsg.value = message
  toastTimer = setTimeout(() => {
    errorMsg.value = ''
    toastTimer = null
  }, duration)
}

function dismissToast(): void {
  clearToastTimer()
  infoMsg.value = ''
  errorMsg.value = ''
}

const audioCounts = computed(() => ({
  dialogue: editableAudioTracks.value.dialogue.length || 0,
  narration: editableAudioTracks.value.narration.length || 0,
  music: editableAudioTracks.value.music.length || 0,
  sfx: editableAudioTracks.value.sfx.length || 0,
}))

const selectedVideo = computed<FinalEditVideoClipDTO | null>(
  () =>
    editableVideoClips.value.find((item) => clipIdentity(item) === selectedClipId.value) ||
    editableVideoClips.value.find((item) => item.storyboardId === selectedStoryboardId.value) ||
    null,
)

const totalTimelineDurationSeconds = computed(() =>
  editableVideoClips.value
    .filter((item) => item.enabled !== false)
    .reduce((sum, item) => sum + (Number(item.durationSeconds) || 0), 0),
)
const previewClip = computed<FinalEditVideoClipDTO | null>(() => {
  if (previewMode.value === 'clip') return selectedVideo.value
  return resolveTimelineClipAt(timelinePositionSeconds.value) || selectedVideo.value
})
const previewSourceUrl = computed(() => previewClip.value?.videoUrl || '')
const previewClipIndex = computed(() => {
  const clip = previewClip.value
  if (!clip) return -1
  return enabledVideoClips().findIndex((item) => clipIdentity(item) === clipIdentity(clip))
})
const enabledSubtitleCueCount = computed(
  () =>
    editableSubtitleCues.value.filter(
      (cue) =>
        cue.enabled !== false &&
        Boolean(cue.text.trim()) &&
        editableVideoClips.value.some(
          (clip) => clip.enabled !== false && clip.storyboardId === cue.storyboardId,
        ),
    ).length,
)
const unmatchedAudioItems = computed(() => finalEdit.value?.unmatchedAudio || [])

// 素材库需要能按场景/镜头直接定位，54 个镜头靠滚动找太慢。
const binQuery = ref('')
const filteredVideoClips = computed(() => {
  const query = binQuery.value.trim().toLowerCase()
  if (!query) return editableVideoClips.value
  return editableVideoClips.value.filter((clip) => {
    const sceneNo = String(clip.sceneNo ?? '').padStart(2, '0')
    return [
      `scene ${sceneNo}`,
      `scene${clip.sceneNo ?? ''}`,
      String(clip.sceneNo ?? ''),
      resolveShotLabel(clip),
      clip.sceneTitle || '',
      String(clip.shotNo ?? ''),
    ]
      .join(' ')
      .toLowerCase()
      .includes(query)
  })
})

const localValidation = computed(() => {
  // 页面本地再做一层导出前校验，让用户拖动/禁用片段后能立刻看到问题。
  // 后端仍然会做最终校验，本地校验只是为了交互反馈更快。
  const enabledVideoItems = editableVideoClips.value.filter((item) => item.enabled !== false)
  const enabledVideoDurationSeconds = enabledVideoItems.reduce(
    (sum, item) => sum + (Number(item.durationSeconds) || 0),
    0,
  )
  const availableAudioTrackCount = audioTrackMeta.filter(
    (track) => (editableAudioTracks.value[track.key].length || 0) > 0,
  ).length
  const enabledAudioTrackCount = audioTrackMeta.filter(
    (track) =>
      editableAudioTracks.value[track.key].some((item) => item.enabled !== false) &&
      audioMixState.value[track.key].enabled,
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

  // 已确认音频只是因为还没找到对应画面而暂时不能播放时，不再重复提示“还没有音频”，
  // 否则会把创作者推向“再去生成音频”，而不是“先确认对应镜头”。
  const unmatchedAudioCount = unmatchedAudioItems.value.length
  if (availableAudioTrackCount === 0 && unmatchedAudioCount === 0) {
    warningIssues.push({
      code: 'missing-audio',
      message: '当前还没有已确认音频，成片可以先预览视频，但导出前建议补齐音频主版本。',
    })
  } else if (availableAudioTrackCount > 0 && enabledAudioTrackCount === 0) {
    warningIssues.push({
      code: 'all-audio-disabled',
      message: '当前所有音频轨都被关闭了，如需带音频导出，请至少开启一个轨道。',
    })
  }
  if (unmatchedAudioCount > 0) {
    warningIssues.push({
      code: 'audio-without-video-clip',
      message: `有 ${unmatchedAudioCount} 条对白/旁白还没有对应的已确认画面，已暂不加入整集预览；请先确认对应镜头。`,
    })
  }
  if (overlayClips.value.length > 0) {
    // 画中画只在编辑器预览里合成；导出链路还没有叠加滤镜，必须明说。
    warningIssues.push({
      code: 'overlay-not-rendered',
      message: `画中画轨道有 ${overlayClips.value.length} 个片段，目前只在编辑器预览中生效，导出合成尚未接入；导出前请确认是否保留。`,
    })
  }
  const hasEnabledSpeech = ['dialogue', 'narration'].some(
    (trackKey) =>
      editableAudioTracks.value[trackKey as AudioTrackKey].some((item) => item.enabled !== false) &&
      audioMixState.value[trackKey as AudioTrackKey].enabled,
  )
  if (hasEnabledSpeech && enabledSubtitleCueCount.value === 0) {
    blockingIssues.push({
      code: 'missing-subtitles',
      message: '当前启用了对白或旁白，请先确认至少一条有效字幕。',
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
    items: editableAudioTracks.value[track.key] || [],
    enabled: audioMixState.value[track.key].enabled,
    volume: audioMixState.value[track.key].volume,
  })),
)

const audioPreviewEntries = computed(() =>
  audioTrackMeta.flatMap((track) =>
    (editableAudioTracks.value[track.key] || [])
      .filter((item) => Boolean(item.audioUrl))
      .map((item) => ({
        ...item,
        trackKey: track.key,
      })),
  ),
)

const activePreviewSubtitleCues = computed(() =>
  editableSubtitleCues.value.filter((cue) => {
    if (cue.enabled === false || !cue.text.trim()) return false
    const clip = editableVideoClips.value.find(
      (item) => item.storyboardId === cue.storyboardId && item.enabled !== false,
    )
    if (!clip) return false
    const start = clipStartSeconds(clip) + Math.max(0, Number(cue.startOffsetSeconds) || 0)
    const end = start + Math.max(0.25, Number(cue.durationSeconds) || 0.25)
    return timelinePositionSeconds.value >= start && timelinePositionSeconds.value < end
  }),
)

const selectedAudioGroups = computed(() =>
  audioGroups.value.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (!selectedStoryboardId.value) return false
      return Number(item.storyboardId) === Number(selectedStoryboardId.value)
    }),
  })).filter((group) => group.items.length > 0),
)

const selectedSubtitleCues = computed(() =>
  editableSubtitleCues.value.filter(
    (cue) => Number(cue.storyboardId) === Number(selectedStoryboardId.value),
  ),
)

const selectedBeatMarkers = computed(() => {
  const clip = selectedVideo.value
  if (!clip) return []
  const start = clipStartSeconds(clip)
  const end = start + (Number(clip.durationSeconds) || 0)
  return beatMarkers.value.filter((marker) => marker.atSeconds >= start && marker.atSeconds <= end)
})

const selectedEmotionPoints = computed(() => {
  const clip = selectedVideo.value
  if (!clip) return []
  const start = clipStartSeconds(clip)
  const end = start + (Number(clip.durationSeconds) || 0)
  return emotionCurve.value.filter((point) => point.atSeconds >= start && point.atSeconds <= end)
})

const timelineStarts = computed(() => {
  const starts = new Map<string, number>()
  let cursor = 0
  for (const clip of editableVideoClips.value) {
    if (clip.enabled === false) continue
    starts.set(clipIdentity(clip), cursor)
    cursor += Number(clip.durationSeconds) || 0
  }
  return starts
})

function enabledVideoClips(): FinalEditVideoClipDTO[] {
  return editableVideoClips.value.filter((item) => item.enabled !== false)
}

function resolveTimelineClipAt(seconds: number): FinalEditVideoClipDTO | null {
  const clips = enabledVideoClips()
  if (!clips.length) return null
  const target = Math.max(0, Math.min(totalTimelineDurationSeconds.value, Number(seconds) || 0))
  let cursor = 0
  for (const [index, clip] of clips.entries()) {
    const duration = Math.max(0.25, Number(clip.durationSeconds) || 0.25)
    const end = cursor + duration
    if (target < end || index === clips.length - 1) return clip
    cursor = end
  }
  return clips[clips.length - 1] || null
}

function clearProgramAdvanceTimer(): void {
  if (programAdvanceTimer) {
    clearTimeout(programAdvanceTimer)
    programAdvanceTimer = null
  }
}

const canUndo = computed(() => undoStack.value.length > 0)
const canRedo = computed(() => redoStack.value.length > 0)
const timelineTrackWidthPx = computed(() =>
  Math.max(920, Math.ceil(totalTimelineDurationSeconds.value * timelinePixelsPerSecond.value + 24)),
)
const timelineCanvasWidthPx = computed(() => timelineTrackWidthPx.value + 122)
const timelineZoomPercent = computed(() => Math.round((timelinePixelsPerSecond.value / 72) * 100))
const timelinePlayheadStyle = computed(() => ({
  // 用 transform 而不是 left 移动播放头：left 每次都触发布局与整条轨道重绘，
  // 重绘期间 Chromium 会把轨道文字切到灰度抗锯齿层，看起来像被描了边。
  transform: `translate3d(${122 + timelinePositionSeconds.value * timelinePixelsPerSecond.value}px, 0, 0)`,
}))
const timelineTicks = computed(() => {
  const total = totalTimelineDurationSeconds.value
  if (total <= 0) return [{ seconds: 0, label: '00:00' }]
  const step = total <= 12 ? 1 : total <= 45 ? 5 : 10
  const ticks: Array<{ seconds: number; label: string }> = []
  for (let seconds = 0; seconds <= total + 0.001; seconds += step) {
    ticks.push({ seconds: Math.min(seconds, total), label: formatTimecode(seconds) })
  }
  if (ticks[ticks.length - 1]?.seconds !== total) {
    ticks.push({ seconds: total, label: formatTimecode(total) })
  }
  return ticks
})

function createEmptyAudioMix(): FinalEditDraftDTO['audioMix'] {
  return {
    dialogue: { enabled: false, volume: 100 },
    narration: { enabled: false, volume: 100 },
    music: { enabled: false, volume: 100 },
    sfx: { enabled: false, volume: 100 },
  }
}

function createEmptyAudioTracks(): Record<AudioTrackKey, FinalEditAudioClipDTO[]> {
  return {
    dialogue: [],
    narration: [],
    music: [],
    sfx: [],
  }
}

function cloneAudioTracks(
  source?: FinalEditDTO['audioTracks'] | null,
): Record<AudioTrackKey, FinalEditAudioClipDTO[]> {
  const fallback = createEmptyAudioTracks()
  for (const track of audioTrackMeta) {
    fallback[track.key] = Array.isArray(source?.[track.key])
      ? source[track.key].map((item) => ({
          ...item,
          enabled: item.enabled !== false,
          startOffsetSeconds: clampAudioOffset(item.startOffsetSeconds),
          volume: normalizeVolume(item.volume, 100),
        }))
      : []
  }
  return fallback
}

function clipSourceDuration(clip?: FinalEditVideoClipDTO | null): number {
  return Math.max(
    0.25,
    Number(clip?.sourceDurationSeconds) ||
      Number(clip?.trimEndSeconds) ||
      Number(clip?.durationSeconds) ||
      4,
  )
}

function clipDurationFromTrim(clip: FinalEditVideoClipDTO): number {
  const sourceDuration = clipSourceDuration(clip)
  const start = Math.max(0, Math.min(Number(clip.trimStartSeconds) || 0, sourceDuration - 0.25))
  const end = Math.max(start + 0.25, Math.min(Number(clip.trimEndSeconds) || sourceDuration, sourceDuration))
  return Number((end - start).toFixed(3))
}

function normalizeEditableVideoClip(item: FinalEditVideoClipDTO, index: number): FinalEditVideoClipDTO {
  const sourceDurationSeconds = clipSourceDuration(item)
  const trimStartSeconds = Math.max(
    0,
    Math.min(Number(item.trimStartSeconds) || 0, Math.max(0, sourceDurationSeconds - 0.25)),
  )
  const trimEndSeconds = Math.max(
    trimStartSeconds + 0.25,
    Math.min(Number(item.trimEndSeconds) || sourceDurationSeconds, sourceDurationSeconds),
  )
  const normalized = {
    ...item,
    clipId: item.clipId || `storyboard-${item.storyboardId}`,
    videoAssetId: Number(item.videoAssetId || item.id || item.originalVideoAssetId) || null,
    originalVideoAssetId: Number(item.originalVideoAssetId || item.id || item.videoAssetId) || null,
    enabled: item.enabled !== false,
    order: index + 1,
    transition: cloneClipTransition(item.transition),
    sourceDurationSeconds,
    trimStartSeconds: Number(trimStartSeconds.toFixed(3)),
    trimEndSeconds: Number(trimEndSeconds.toFixed(3)),
  }
  return {
    ...normalized,
    durationSeconds: clipDurationFromTrim(normalized),
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

function clampAudioOffset(value?: number | null, fallback = 0): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Number(Math.max(-5, Math.min(9999, n)).toFixed(3))
}

function clipIdentity(clip?: Pick<FinalEditVideoClipDTO, 'clipId' | 'storyboardId'> | null): string {
  if (!clip) return ''
  return clip.clipId || `storyboard-${clip.storyboardId}`
}

function cloneClipTransition(
  transition?: FinalEditVideoClipDTO['transition'] | null,
): NonNullable<FinalEditVideoClipDTO['transition']> {
  const type = transitionOptions.some((item) => item.value === transition?.type)
    ? (transition?.type as TransitionType)
    : 'cut'
  return {
    type,
    durationSeconds: type === 'cut'
      ? 0
      : Number(Math.max(0, Math.min(2, Number(transition?.durationSeconds) || 0.3)).toFixed(3)),
    manual: transition?.manual === true,
  }
}

function cloneBeatMarkers(source?: FinalEditDraftDTO['beatMarkers'] | null): NonNullable<FinalEditDraftDTO['beatMarkers']> {
  return Array.isArray(source)
    ? source.map((marker) => ({
        markerId: String(marker.markerId || `beat-${Date.now()}`),
        atSeconds: Math.max(0, Number(marker.atSeconds) || 0),
        label: String(marker.label || '节拍点'),
      }))
    : []
}

function cloneEmotionCurve(source?: FinalEditDraftDTO['emotionCurve'] | null): NonNullable<FinalEditDraftDTO['emotionCurve']> {
  return Array.isArray(source)
    ? source.map((point) => ({
        pointId: String(point.pointId || `emotion-${Date.now()}`),
        atSeconds: Math.max(0, Number(point.atSeconds) || 0),
        intensity: Math.max(0, Math.min(100, Math.round(Number(point.intensity) || 50))),
        label: String(point.label || '情绪点'),
      }))
    : []
}

function cloneVersionHistory(
  source?: FinalEditDraftDTO['versionHistory'] | null,
): NonNullable<FinalEditDraftDTO['versionHistory']> {
  return Array.isArray(source)
    ? source.map((item) => ({
        versionId: String(item.versionId || `snapshot-${Date.now()}`),
        label: String(item.label || '剪辑版本'),
        createdAt: String(item.createdAt || new Date().toISOString()),
        payload: item.payload || {},
      }))
    : []
}

function cloneSubtitleCues(
  source?: FinalEditDraftDTO['subtitleCues'] | null,
): FinalEditDraftDTO['subtitleCues'] {
  return Array.isArray(source)
    ? source.map((cue) => ({
        cueId: String(cue.cueId || ''),
        storyboardId: Number(cue.storyboardId) || 0,
        enabled: cue.enabled !== false,
        startOffsetSeconds: Math.max(0, Number(cue.startOffsetSeconds) || 0),
        durationSeconds: Math.max(0.25, Number(cue.durationSeconds) || 1),
        text: String(cue.text || ''),
      }))
    : []
}

function buildDraftSnapshotPayload(): Omit<DraftPayload, 'versionHistory'> {
  // 成片编辑不直接修改分镜或资产，只保存“剪辑草稿”：
  // 哪些镜头启用、顺序如何、镜头内裁切、候选替换、转场、音频偏移和字幕。
  return {
    videoClips: editableVideoClips.value.map((item, index) => ({
      clipId: clipIdentity(item),
      storyboardId: item.storyboardId,
      enabled: item.enabled !== false,
      order: index + 1,
      videoAssetId: item.videoAssetId || item.id || null,
      trimStartSeconds: Math.max(0, Number(item.trimStartSeconds) || 0),
      trimEndSeconds: Math.max(0.25, Number(item.trimEndSeconds) || clipSourceDuration(item)),
      transition: cloneClipTransition(item.transition),
    })),
    audioMix: cloneAudioMix(audioMixState.value),
    overlayClips: overlayClips.value.map((item) => ({
      clipId: item.clipId,
      storyboardId: item.storyboardId,
      startSeconds: Number(Math.max(0, Number(item.startSeconds) || 0).toFixed(3)),
      durationSeconds: Number(Math.max(0.25, Number(item.durationSeconds) || 0.25).toFixed(3)),
      trimStartSeconds: Number(Math.max(0, Number(item.trimStartSeconds) || 0).toFixed(3)),
      enabled: item.enabled !== false,
      position: item.position,
      scale: Number(Math.max(0.1, Math.min(1, Number(item.scale) || 0.36)).toFixed(3)),
      opacity: Math.round(Math.max(0, Math.min(100, Number(item.opacity ?? 100)))),
    })),
    audioClips: audioTrackMeta.flatMap((track) =>
      editableAudioTracks.value[track.key].map((item) => ({
        audioId: item.id,
        enabled: item.enabled !== false,
        startOffsetSeconds: clampAudioOffset(item.startOffsetSeconds),
        volume: normalizeVolume(item.volume, 100),
      })),
    ),
    subtitleCues: cloneSubtitleCues(editableSubtitleCues.value),
    beatMarkers: cloneBeatMarkers(beatMarkers.value),
    emotionCurve: cloneEmotionCurve(emotionCurve.value),
  }
}

function buildDraftPayload(): DraftPayload {
  return {
    ...buildDraftSnapshotPayload(),
    versionHistory: cloneVersionHistory(versionHistory.value),
  }
}

function buildDraftSignature(): string {
  return JSON.stringify(buildDraftPayload())
}

function applyDraftPayloadToLocal(payload: Partial<DraftPayload>, preferredClipId?: string | null): void {
  const baseByStoryboardId = new Map(editableVideoClips.value.map((item) => [item.storyboardId, item]))
  editableVideoClips.value = (Array.isArray(payload.videoClips) ? payload.videoClips : [])
    .map((item, index) => {
      const base = baseByStoryboardId.get(item.storyboardId)
      if (!base) return null
      return normalizeEditableVideoClip({
        ...base,
        ...item,
        clipId: item.clipId || `storyboard-${item.storyboardId}`,
      }, index)
    })
    .filter((item): item is FinalEditVideoClipDTO => Boolean(item))
  if (payload.audioMix) audioMixState.value = cloneAudioMix(payload.audioMix)
  if (Array.isArray(payload.overlayClips)) {
    overlayClips.value = payload.overlayClips
      .map((item) => normalizeLocalOverlayClip(item))
      .filter((item): item is FinalEditOverlayClipDTO => Boolean(item))
    if (
      selectedOverlayClipId.value &&
      !overlayClips.value.some((item) => item.clipId === selectedOverlayClipId.value)
    ) {
      selectedOverlayClipId.value = null
    }
  }
  if (Array.isArray(payload.audioClips)) {
    for (const track of audioTrackMeta) {
      editableAudioTracks.value[track.key] = editableAudioTracks.value[track.key].map((item) => {
        const patch = payload.audioClips?.find((clip) => clip.audioId === item.id)
        return patch
          ? {
              ...item,
              enabled: patch.enabled !== false,
              startOffsetSeconds: clampAudioOffset(patch.startOffsetSeconds),
              volume: normalizeVolume(patch.volume, 100),
            }
          : item
      })
    }
  }
  if (Array.isArray(payload.subtitleCues)) editableSubtitleCues.value = cloneSubtitleCues(payload.subtitleCues)
  if (Array.isArray(payload.beatMarkers)) beatMarkers.value = cloneBeatMarkers(payload.beatMarkers)
  if (Array.isArray(payload.emotionCurve)) emotionCurve.value = cloneEmotionCurve(payload.emotionCurve)
  syncSelectedVideoByClipId(preferredClipId)
}

function rememberEditState(): void {
  const signature = buildDraftSignature()
  if (undoStack.value.at(-1) !== signature) {
    undoStack.value = [...undoStack.value.slice(-29), signature]
  }
  redoStack.value = []
}

function undoEdit(): void {
  const previous = undoStack.value.at(-1)
  if (!previous) return
  undoStack.value = undoStack.value.slice(0, -1)
  redoStack.value = [...redoStack.value.slice(-29), buildDraftSignature()]
  applyDraftPayloadToLocal(JSON.parse(previous), selectedClipId.value)
  showInfo('已撤销上一步剪辑操作。')
}

function redoEdit(): void {
  const next = redoStack.value.at(-1)
  if (!next) return
  redoStack.value = redoStack.value.slice(0, -1)
  undoStack.value = [...undoStack.value.slice(-29), buildDraftSignature()]
  applyDraftPayloadToLocal(JSON.parse(next), selectedClipId.value)
  showInfo('已重做剪辑操作。')
}

function createVersionSnapshot(label = '人工检查点'): void {
  versionHistory.value = [
    {
      versionId: `version-${Date.now()}`,
      label,
      createdAt: new Date().toISOString(),
      payload: buildDraftSnapshotPayload(),
    },
    ...versionHistory.value,
  ].slice(0, 8)
  showInfo('已创建一个可回退的剪辑版本。')
}

function rollbackToVersion(versionId: string): void {
  const snapshot = versionHistory.value.find((item) => item.versionId === versionId)
  if (!snapshot) return
  rememberEditState()
  applyDraftPayloadToLocal(snapshot.payload as Partial<DraftPayload>, selectedClipId.value)
  showInfo(`已回退到「${snapshot.label}」。保存草稿后才会写入导出链路。`, 4200)
}

function syncSelectedVideo(preferredStoryboardId?: number | null): void {
  if (
    preferredStoryboardId &&
    editableVideoClips.value.some((item) => item.storyboardId === preferredStoryboardId)
  ) {
    selectedStoryboardId.value = preferredStoryboardId
    selectedClipId.value = clipIdentity(
      editableVideoClips.value.find((item) => item.storyboardId === preferredStoryboardId),
    )
    return
  }

  selectedStoryboardId.value = editableVideoClips.value[0]?.storyboardId || null
  selectedClipId.value = clipIdentity(editableVideoClips.value[0]) || null
}

function syncSelectedVideoByClipId(preferredClipId?: string | null): void {
  const nextClip =
    editableVideoClips.value.find((item) => clipIdentity(item) === preferredClipId) ||
    editableVideoClips.value[0] ||
    null
  selectedStoryboardId.value = nextClip?.storyboardId || null
  selectedClipId.value = nextClip ? clipIdentity(nextClip) : null
}

function syncEditableState(data: FinalEditDTO, preferredStoryboardId?: number | null): void {
  // 把后端返回的 final-edit payload 转成页面可编辑状态。
  // editableVideoClips 是页面本地副本，保存前可以自由拖动/开关。
  finalEdit.value = data
  editableVideoClips.value = [...data.videoTrack.items]
    .sort((a, b) => a.order - b.order)
    .map((item, index) => normalizeEditableVideoClip(item, index))
  editableAudioTracks.value = cloneAudioTracks(data.audioTracks)
  overlayClips.value = (Array.isArray(data.overlayClips) ? data.overlayClips : [])
    .map((item) => normalizeLocalOverlayClip(item))
    .filter((item): item is FinalEditOverlayClipDTO => Boolean(item))
  selectedOverlayClipId.value = null
  audioMixState.value = cloneAudioMix(data.draft?.audioMix || data.audioMix)
  editableSubtitleCues.value = cloneSubtitleCues(data.draft?.subtitleCues)
  beatMarkers.value = cloneBeatMarkers(data.draft?.beatMarkers)
  emotionCurve.value = cloneEmotionCurve(data.draft?.emotionCurve)
  versionHistory.value = cloneVersionHistory(data.draft?.versionHistory)
  undoStack.value = []
  redoStack.value = []
  syncSelectedVideo(preferredStoryboardId)
  timelinePositionSeconds.value = clipStartSeconds(selectedVideo.value)
  void loadSelectedVideoCandidates()
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

function formatTimecode(seconds?: number | null): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const mins = Math.floor(total / 60)
  const rest = total % 60
  return `${String(mins).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

function formatSignedSeconds(value?: number | null): string {
  const total = Number(value) || 0
  if (Math.abs(total) < 0.05) return '0.0s'
  return `${total > 0 ? '+' : ''}${total.toFixed(1)}s`
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

function timelinePercent(value: number): string {
  const total = Math.max(0.25, totalTimelineDurationSeconds.value || 0)
  return `${Math.max(0, Math.min(100, (value / total) * 100))}%`
}

function timelinePixels(value: number): string {
  return `${Math.max(0, Number(value) || 0) * timelinePixelsPerSecond.value}px`
}

function percentOf(value: number, total: number): string {
  const safeTotal = Math.max(0.25, Number(total) || 0.25)
  return `${Math.max(0, Math.min(100, (Number(value) / safeTotal) * 100))}%`
}

function clipStartSeconds(clip?: FinalEditVideoClipDTO | number | null): number {
  if (!clip) return 0
  if (typeof clip === 'number') {
    const matched = editableVideoClips.value.find((item) => item.storyboardId === clip)
    return matched ? timelineStarts.value.get(clipIdentity(matched)) || 0 : 0
  }
  return timelineStarts.value.get(clipIdentity(clip)) || 0
}

function timelineClipStyle(startSeconds: number, durationSeconds?: number | null): Record<string, string> {
  const duration = Math.max(0.25, Number(durationSeconds) || 0.25)
  return {
    left: timelinePixels(startSeconds),
    width: timelinePixels(duration),
  }
}

function videoClipTimelineStyle(clip: FinalEditVideoClipDTO): Record<string, string> {
  return timelineClipStyle(clipStartSeconds(clip), clip.durationSeconds)
}

function audioClipTimelineStyle(item: FinalEditAudioClipDTO): Record<string, string> {
  const start = clipStartSeconds(item.storyboardId) + (Number(item.startOffsetSeconds) || 0)
  return timelineClipStyle(start, item.durationSeconds)
}

function subtitleTimelineStyle(cue: FinalEditDraftDTO['subtitleCues'][number]): Record<string, string> {
  const start = clipStartSeconds(cue.storyboardId) + Math.max(0, Number(cue.startOffsetSeconds) || 0)
  return timelineClipStyle(start, cue.durationSeconds)
}

const overlayPositionOptions: Array<{ value: OverlayPosition; label: string }> = [
  { value: 'bottom-right', label: '右下角' },
  { value: 'bottom-left', label: '左下角' },
  { value: 'top-right', label: '右上角' },
  { value: 'top-left', label: '左上角' },
  { value: 'center', label: '居中' },
]

const selectedOverlayClip = computed(
  () => overlayClips.value.find((item) => item.clipId === selectedOverlayClipId.value) || null,
)

// 播放头落在叠加片段区间内时才参与预览合成，和剪映的叠加轨行为一致。
const activeOverlayClips = computed(() =>
  overlayClips.value.filter(
    (clip) =>
      clip.enabled !== false &&
      timelinePositionSeconds.value >= clip.startSeconds - 0.001 &&
      timelinePositionSeconds.value < clip.startSeconds + clip.durationSeconds,
  ),
)

function overlaySourceClip(clip: FinalEditOverlayClipDTO): FinalEditVideoClipDTO | null {
  return editableVideoClips.value.find((item) => item.storyboardId === clip.storyboardId) || null
}

function overlayClipLabel(clip: FinalEditOverlayClipDTO): string {
  const source = overlaySourceClip(clip)
  return source ? resolveShotLabel(source) : `SHOT ${clip.storyboardId}`
}

function overlayClipStyle(clip: FinalEditOverlayClipDTO): Record<string, string> {
  return timelineClipStyle(clip.startSeconds, clip.durationSeconds)
}

function nextOverlayClipId(storyboardId: number): string {
  return `overlay-${storyboardId}-${Date.now().toString(36)}`
}

function normalizeLocalOverlayClip(
  item: Partial<FinalEditOverlayClipDTO> & { storyboardId?: number },
): FinalEditOverlayClipDTO | null {
  const storyboardId = Number(item.storyboardId) || 0
  const source = editableVideoClips.value.find((clip) => clip.storyboardId === storyboardId)
  if (!storyboardId || !source) return null
  const limit = Math.max(
    0.25,
    Number(source.sourceDurationSeconds) || Number(source.durationSeconds) || 4,
  )
  const position = overlayPositionOptions.some((option) => option.value === item.position)
    ? (item.position as OverlayPosition)
    : 'bottom-right'
  return {
    clipId: String(item.clipId || nextOverlayClipId(storyboardId)),
    storyboardId,
    startSeconds: Math.max(0, Number(item.startSeconds) || 0),
    durationSeconds: Math.max(0.25, Math.min(limit, Number(item.durationSeconds) || 1.5)),
    trimStartSeconds: Math.max(0, Number(item.trimStartSeconds) || 0),
    enabled: item.enabled !== false,
    position,
    scale: Math.max(0.1, Math.min(1, Number(item.scale) || 0.36)),
    opacity: Math.round(Math.max(0, Math.min(100, Number(item.opacity ?? 100)))),
  }
}

function addOverlayClip(storyboardId: number, startSeconds: number): void {
  const source = editableVideoClips.value.find((item) => item.storyboardId === storyboardId)
  if (!source) return
  const start = Number(Math.max(0, Number(startSeconds) || 0).toFixed(3))
  const existing = overlayClips.value.find((item) => item.storyboardId === storyboardId)
  if (existing) {
    rememberEditState()
    updateOverlayClip(existing.clipId, { startSeconds: start, enabled: true })
    selectedOverlayClipId.value = existing.clipId
    showInfo(`画中画已移动到 ${formatTimecode(start)}。`)
    return
  }
  rememberEditState()
  const duration = Number(
    Math.min(3, Math.max(0.5, Number(source.durationSeconds) || 3)).toFixed(3),
  )
  const clip: FinalEditOverlayClipDTO = {
    clipId: nextOverlayClipId(storyboardId),
    storyboardId,
    startSeconds: start,
    durationSeconds: duration,
    trimStartSeconds: 0,
    enabled: true,
    position: 'bottom-right',
    scale: 0.36,
    opacity: 100,
  }
  overlayClips.value = [...overlayClips.value, clip]
  selectedOverlayClipId.value = clip.clipId
  showInfo(`已把 ${resolveShotLabel(source)} 加入画中画轨，原素材不会被修改。`)
}

function updateOverlayClip(clipId: string, patch: Partial<FinalEditOverlayClipDTO>): void {
  overlayClips.value = overlayClips.value.map((item) =>
    item.clipId === clipId ? { ...item, ...patch } : item,
  )
}

function removeOverlayClip(clipId: string): void {
  const target = overlayClips.value.find((item) => item.clipId === clipId)
  if (!target) return
  rememberEditState()
  overlayClips.value = overlayClips.value.filter((item) => item.clipId !== clipId)
  if (selectedOverlayClipId.value === clipId) selectedOverlayClipId.value = null
  showInfo('已移除画中画片段，原始素材和历史候选保持不变。')
}

function resolveOverlaySnap(value: number): number {
  return Number(Math.max(0, resolveSnapPosition(value)).toFixed(3))
}

function startOverlayPointerDrag(event: PointerEvent, clip: FinalEditOverlayClipDTO): void {
  if (event.button !== 0) return
  event.stopPropagation()
  selectedOverlayClipId.value = clip.clipId
  selectedClipId.value = null
  overlayPointerDrag.value = {
    clipId: clip.clipId,
    startX: event.clientX,
    initialStart: clip.startSeconds,
    moved: false,
  }
  window.addEventListener('pointermove', onOverlayPointerMove)
  window.addEventListener('pointerup', stopOverlayPointerDrag, { once: true })
}

function onOverlayPointerMove(event: PointerEvent): void {
  const drag = overlayPointerDrag.value
  if (!drag) return
  if (Math.abs(event.clientX - drag.startX) < 4 && !drag.moved) return
  if (!drag.moved) rememberEditState()
  drag.moved = true
  const deltaSeconds = (event.clientX - drag.startX) / timelinePixelsPerSecond.value
  updateOverlayClip(drag.clipId, {
    startSeconds: resolveOverlaySnap(drag.initialStart + deltaSeconds),
  })
}

function stopOverlayPointerDrag(): void {
  const drag = overlayPointerDrag.value
  overlayPointerDrag.value = null
  window.removeEventListener('pointermove', onOverlayPointerMove)
  if (drag?.moved) showInfo('已调整画中画起点。')
}

function onOverlayLaneDragOver(event: DragEvent): void {
  if (!draggedClipId.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  overlayDropActive.value = true
}

function onOverlayLaneDragLeave(): void {
  overlayDropActive.value = false
}

function onOverlayLaneDrop(event: DragEvent): void {
  event.preventDefault()
  overlayDropActive.value = false
  mainDropIndex.value = null
  const sourceId = draggedClipId.value
  draggedClipId.value = null
  draggedClipFromBin.value = false
  if (!sourceId) return
  const source = editableVideoClips.value.find((item) => clipIdentity(item) === sourceId)
  if (!source) return
  const lane = timelineOverlayLaneRef.value
  const rect = lane?.getBoundingClientRect()
  const rawSeconds = rect
    ? (event.clientX - rect.left) / timelinePixelsPerSecond.value
    : timelinePositionSeconds.value
  addOverlayClip(source.storyboardId, resolveOverlaySnap(rawSeconds))
}

const overlayPreviewAnchors: Record<OverlayPosition, { left: string; top: string; transform: string }> = {
  center: { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' },
  'top-left': { left: '4%', top: '4%', transform: 'translate(0, 0)' },
  'top-right': { left: '96%', top: '4%', transform: 'translate(-100%, 0)' },
  'bottom-left': { left: '4%', top: '96%', transform: 'translate(0, -100%)' },
  'bottom-right': { left: '96%', top: '96%', transform: 'translate(-100%, -100%)' },
}

function overlayPreviewStyle(clip: FinalEditOverlayClipDTO): Record<string, string> {
  const anchor = overlayPreviewAnchors[clip.position] || overlayPreviewAnchors['bottom-right']
  return {
    left: anchor.left,
    top: anchor.top,
    width: `${Math.round(Math.max(0.1, Math.min(1, clip.scale)) * 100)}%`,
    opacity: String(Math.max(0, Math.min(100, clip.opacity)) / 100),
    transform: anchor.transform,
  }
}

function setTimelineZoom(value: number): void {
  timelinePixelsPerSecond.value = Math.max(36, Math.min(220, Math.round(Number(value) || 72)))
}

function adjustTimelineZoom(delta: number): void {
  setTimelineZoom(timelinePixelsPerSecond.value + delta)
}

function toggleTimelineSnap(): void {
  timelineSnapEnabled.value = !timelineSnapEnabled.value
  showInfo(timelineSnapEnabled.value ? '已开启时间线吸附。' : '已关闭时间线吸附。')
}

function startTimelineResize(event: PointerEvent): void {
  timelineResize.value = {
    startY: event.clientY,
    initialHeight: timelineDockHeight.value,
  }
  window.addEventListener('pointermove', onTimelineResizeMove)
  window.addEventListener('pointerup', stopTimelineResize, { once: true })
}

function onTimelineResizeMove(event: PointerEvent): void {
  const drag = timelineResize.value
  if (!drag) return
  const nextHeight = drag.initialHeight - (event.clientY - drag.startY)
  // 预览区保底由 CSS 的 --fe-preview-min-height 行最小值兜住，这里只限制时间线自身范围。
  timelineDockHeight.value = Math.max(180, Math.min(620, Math.round(nextHeight)))
}

function stopTimelineResize(): void {
  timelineResize.value = null
  window.removeEventListener('pointermove', onTimelineResizeMove)
}

function resolveSnapPosition(value: number, excludedClipId?: string): number {
  const clamped = Math.max(0, Math.min(totalTimelineDurationSeconds.value, Number(value) || 0))
  if (!timelineSnapEnabled.value) return clamped

  const snapPoints = new Set<number>([0, totalTimelineDurationSeconds.value])
  for (const clip of editableVideoClips.value) {
    if (clipIdentity(clip) === excludedClipId || clip.enabled === false) continue
    const start = clipStartSeconds(clip)
    snapPoints.add(start)
    snapPoints.add(start + (Number(clip.durationSeconds) || 0))
  }
  for (const marker of beatMarkers.value) snapPoints.add(Number(marker.atSeconds) || 0)

  const threshold = Math.max(0.08, 8 / timelinePixelsPerSecond.value)
  let nearest = clamped
  let nearestDistance = threshold
  for (const point of snapPoints) {
    const distance = Math.abs(point - clamped)
    if (distance <= nearestDistance) {
      nearest = point
      nearestDistance = distance
    }
  }
  return Number(nearest.toFixed(3))
}

function startTrimDrag(event: PointerEvent, clip: FinalEditVideoClipDTO, edge: TrimEdge): void {
  const clipId = clipIdentity(clip)
  if (!clipId || clip.enabled === false) return
  const currentStart = Math.max(0, Number(clip.trimStartSeconds) || 0)
  const currentEnd = Math.max(currentStart + 0.25, Number(clip.trimEndSeconds) || clipSourceDuration(clip))
  rememberEditState()
  trimDrag.value = {
    clipId,
    edge,
    startX: event.clientX,
    initialStart: currentStart,
    initialEnd: currentEnd,
  }
  window.addEventListener('pointermove', onTrimPointerMove)
  window.addEventListener('pointerup', stopTrimDrag, { once: true })
}

function onTrimPointerMove(event: PointerEvent): void {
  const drag = trimDrag.value
  if (!drag) return
  const delta = (event.clientX - drag.startX) / timelinePixelsPerSecond.value
  const clip = editableVideoClips.value.find((item) => clipIdentity(item) === drag.clipId)
  if (!clip) return
  if (drag.edge === 'start') {
    const nextStart = Math.min(
      drag.initialEnd - 0.25,
      Math.max(0, resolveSnapPosition(drag.initialStart + delta, drag.clipId)),
    )
    updateVideoClip(drag.clipId, { trimStartSeconds: Number(nextStart.toFixed(3)) })
    return
  }
  const sourceDuration = clipSourceDuration(clip)
  const nextEnd = Math.max(
    drag.initialStart + 0.25,
    Math.min(sourceDuration, resolveSnapPosition(drag.initialEnd + delta, drag.clipId)),
  )
  updateVideoClip(drag.clipId, { trimEndSeconds: Number(nextEnd.toFixed(3)) })
}

function stopTrimDrag(): void {
  const drag = trimDrag.value
  if (!drag) return
  const clip = editableVideoClips.value.find((item) => clipIdentity(item) === drag.clipId)
  trimDrag.value = null
  window.removeEventListener('pointermove', onTrimPointerMove)
  if (clip) {
    showInfo(`已调整 ${resolveShotLabel(clip)} 的${drag.edge === 'start' ? '入点' : '出点'}。`)
  }
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

function goExport(): void {
  if (!projectId.value) return
  router.push({
    path: '/workspace/export',
    query: {
      projectId: String(projectId.value),
      ...(selectedEpisodeNo.value ? { episodeNo: String(selectedEpisodeNo.value) } : {}),
    },
  })
}

const episodeNo = computed(() => Number(route.query.episodeNo) || 1)

const deliveryPackage = ref<DeliveryPackageDTO | null>(null)
const isDeliveryLoading = ref(false)
const isDeliveryDownloading = ref(false)
const isDeliveryPanelOpen = ref(false)

const isJianyingPanelOpen = ref(false)
const jianyingPlan = ref<JianyingDraftPlanDTO | null>(null)
const jianyingStatus = ref<JianyingStatusDTO | null>(null)
const jianyingResult = ref<JianyingExportResultDTO | null>(null)
const isJianyingLoading = ref(false)
const isJianyingExporting = ref(false)
const jianyingExportStage = ref('')

/** 剪映导出面板打开时刷新演练结果与环境状态。 */
async function openJianyingPanel(): Promise<void> {
  isJianyingPanelOpen.value = true
  await refreshJianyingPanel()
}

async function refreshJianyingPanel(): Promise<void> {
  if (!projectId.value) return
  isJianyingLoading.value = true
  try {
    const [plan, status] = await Promise.all([
      getProjectJianyingPlan(projectId.value, episodeNo.value),
      getProjectJianyingStatus(projectId.value),
    ])
    jianyingPlan.value = plan
    jianyingStatus.value = status
  } catch (error) {
    showError(error instanceof Error ? error.message : '剪映导出信息获取失败')
  } finally {
    isJianyingLoading.value = false
  }
}

/**
 * 导出到剪映。install=true 会写进剪映草稿库，必须剪映处于关闭状态，
 * 否则剪映退出时会覆盖草稿索引（后端也会 409 拦一次）。
 */
async function exportToJianying(install: boolean): Promise<void> {
  if (!projectId.value || isJianyingExporting.value) return
  isJianyingExporting.value = true
  jianyingExportStage.value = install ? '正在下载素材并写入剪映草稿库…' : '正在下载素材…'
  try {
    const result = await exportProjectJianyingDraft(projectId.value, {
      episodeNo: episodeNo.value,
      install,
    })
    jianyingResult.value = result
    if (install) {
      showInfo(`已导出到剪映：「${result.draftName}」。打开剪映就能看到。`)
    } else {
      showInfo(`素材已落地 ${result.media.materialized + result.media.reused} 个，尚未写入剪映。`)
    }
    await refreshJianyingPanel()
  } catch (error) {
    showError(error instanceof Error ? error.message : '导出到剪映失败')
  } finally {
    isJianyingExporting.value = false
    jianyingExportStage.value = ''
  }
}

async function removeJianyingDraft(folder: string): Promise<void> {
  if (!projectId.value) return
  try {
    const result = await uninstallProjectJianyingDraft(projectId.value, folder)
    showInfo(result.restoredIndex ? '已移除草稿并还原剪映索引。' : '已移除草稿。')
    await refreshJianyingPanel()
  } catch (error) {
    showError(error instanceof Error ? error.message : '移除失败')
  }
}

async function refreshDeliveryPackage(): Promise<void> {
  if (!projectId.value) return
  isDeliveryLoading.value = true
  try {
    deliveryPackage.value = await getProjectDeliveryPackage(projectId.value, episodeNo.value)
  } catch (error) {
    showError(error instanceof Error ? error.message : '交付清单生成失败')
  } finally {
    isDeliveryLoading.value = false
  }
}

async function openDeliveryPanel(): Promise<void> {
  isDeliveryPanelOpen.value = true
  await refreshDeliveryPackage()
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 4000)
}

async function downloadDeliveryArchive(includeMedia: boolean): Promise<void> {
  if (!projectId.value || isDeliveryDownloading.value) return
  isDeliveryDownloading.value = true
  try {
    const { blob, fileName } = await downloadProjectDeliveryArchive(
      projectId.value,
      episodeNo.value,
      { includeMedia },
    )
    saveBlob(blob, fileName)
    showInfo(includeMedia ? '交付包开始下载，素材较多时需要等一下。' : '清单文件已开始下载。')
  } catch (error) {
    showError(error instanceof Error ? error.message : '交付包下载失败')
  } finally {
    isDeliveryDownloading.value = false
  }
}

function downloadDeliveryTextFile(kind: 'srt' | 'csv' | 'readme'): void {
  const pkg = deliveryPackage.value
  if (!pkg) return
  const content = kind === 'srt' ? pkg.srt : kind === 'csv' ? pkg.csv : pkg.readme
  if (!content) {
    showError('这个文件暂时是空的。')
    return
  }
  const mime =
    kind === 'srt'
      ? 'text/plain;charset=utf-8'
      : kind === 'csv'
        ? 'text/csv;charset=utf-8'
        : 'text/markdown;charset=utf-8'
  saveBlob(new Blob([content], { type: mime }), pkg.files[kind])
}

function goTaskCenter(): void {
  if (!projectId.value) return
  router.push({ path: '/workspace/ai-tasks', query: { projectId: String(projectId.value) } })
}

function currentClipTrimStart(clip: FinalEditVideoClipDTO): number {
  return Math.max(0, Number(clip.trimStartSeconds) || 0)
}

function currentClipTrimEnd(clip: FinalEditVideoClipDTO): number {
  return Math.max(
    currentClipTrimStart(clip) + 0.25,
    Number(clip.trimEndSeconds) || clipSourceDuration(clip),
  )
}

function clearPreviewAudioSyncTimer(): void {
  if (previewAudioSyncTimer) {
    clearInterval(previewAudioSyncTimer)
    previewAudioSyncTimer = null
  }
  previewClockLastAt = 0
}

function setPreviewAudioElement(audioId: number, element: unknown): void {
  if (element instanceof HTMLAudioElement) {
    previewAudioElements.set(audioId, element)
    return
  }
  previewAudioElements.delete(audioId)
}

const previewOverlayElements = new Map<string, HTMLVideoElement>()

function setPreviewOverlayElement(clipId: string, element: unknown): void {
  if (element instanceof HTMLVideoElement) {
    previewOverlayElements.set(clipId, element)
    return
  }
  previewOverlayElements.delete(clipId)
}

function previewAudioPlacement(item: FinalEditAudioClipDTO): {
  startSeconds: number
  sourceOffsetSeconds: number
  endSeconds: number
} {
  const requestedStart = clipStartSeconds(item.storyboardId) + (Number(item.startOffsetSeconds) || 0)
  const sourceOffsetSeconds = Math.max(0, -requestedStart)
  const startSeconds = Math.max(0, requestedStart)
  const durationSeconds = Math.max(0.25, Number(item.durationSeconds) || 0.25)
  return {
    startSeconds,
    sourceOffsetSeconds,
    endSeconds: startSeconds + Math.max(0.05, durationSeconds - sourceOffsetSeconds),
  }
}

function applyPreviewAudioVolume(
  entry: (typeof audioPreviewEntries.value)[number],
  audio: HTMLAudioElement,
): void {
  const trackVolume = audioMixState.value[entry.trackKey].volume ?? 100
  const clipVolume = entry.volume ?? 100
  audio.volume = Math.max(
    0,
    Math.min(1, (volume.value / 100) * (trackVolume / 100) * (clipVolume / 100)),
  )
}

function syncPreviewAudioToTimeline(autoplay = false): void {
  const position = Math.max(0, timelinePositionSeconds.value)
  const activeIds = new Set<number>()

  for (const entry of audioPreviewEntries.value) {
    const audio = previewAudioElements.get(entry.id)
    if (!audio) continue

    applyPreviewAudioVolume(entry, audio)
    const track = audioMixState.value[entry.trackKey]
    const enabled = track?.enabled !== false && entry.enabled !== false
    const placement = previewAudioPlacement(entry)
    const isActive = enabled && position >= placement.startSeconds && position < placement.endSeconds

    if (!isActive) {
      audio.pause()
      if (audio.readyState >= 1) {
        const nextTime = position < placement.startSeconds
          ? placement.sourceOffsetSeconds
          : (Number.isFinite(audio.duration) ? audio.duration : audio.currentTime)
        if (Math.abs(audio.currentTime - nextTime) > 0.05) audio.currentTime = nextTime
      }
      continue
    }

    activeIds.add(entry.id)
    if (audio.readyState >= 1) {
      const desiredTime = placement.sourceOffsetSeconds + position - placement.startSeconds
      if (Math.abs(audio.currentTime - desiredTime) > 0.16) {
        audio.currentTime = Math.max(
          0,
          Math.min(Number.isFinite(audio.duration) ? audio.duration : desiredTime, desiredTime),
        )
      }
    }

    if (autoplay) {
      void audio.play().catch(() => {
        // 浏览器可能阻止单条音频自动播放；主视频仍可继续播放。
      })
    } else {
      audio.pause()
    }
  }

  for (const [audioId, audio] of previewAudioElements.entries()) {
    if (!activeIds.has(audioId)) audio.pause()
  }

  syncPreviewOverlaysToTimeline(autoplay)
}

// 画中画与主时间线共用同一个时钟：播放时跟着走，跳转时直接对齐帧。
function syncPreviewOverlaysToTimeline(autoplay = false): void {
  const position = Math.max(0, timelinePositionSeconds.value)
  const activeIds = new Set<string>()

  for (const clip of overlayClips.value) {
    const element = previewOverlayElements.get(clip.clipId)
    const isActive =
      clip.enabled !== false &&
      position >= clip.startSeconds &&
      position < clip.startSeconds + clip.durationSeconds
    if (!element) continue

    if (!isActive) {
      element.pause()
      continue
    }

    activeIds.add(clip.clipId)
    if (element.readyState >= 1) {
      const desiredTime = Math.max(
        0,
        (Number(clip.trimStartSeconds) || 0) + position - clip.startSeconds,
      )
      if (Math.abs(element.currentTime - desiredTime) > 0.2) element.currentTime = desiredTime
    }
    if (autoplay) {
      void element.play().catch(() => {
        // 叠加视频可能被浏览器阻止自动播放；主轨画面照常推进。
      })
    } else {
      element.pause()
    }
  }

  for (const [clipId, element] of previewOverlayElements.entries()) {
    if (!activeIds.has(clipId)) element.pause()
  }
}

function startPreviewAudioSyncTimer(): void {
  clearPreviewAudioSyncTimer()
  previewClockLastAt = performance.now()
  previewAudioSyncTimer = setInterval(() => {
    if (!isPlaying.value) return
    const clip = previewClip.value
    if (clip && (clip.sourceType === 'static' || !clip.videoUrl)) {
      const now = performance.now()
      const elapsed = Math.max(0, Math.min(0.2, (now - previewClockLastAt) / 1000))
      previewClockLastAt = now
      timelinePositionSeconds.value = Math.min(
        totalTimelineDurationSeconds.value,
        timelinePositionSeconds.value + elapsed,
      )
      const clipEnd = clipStartSeconds(clip) + Math.max(0.25, Number(clip.durationSeconds) || 0.25)
      if (timelinePositionSeconds.value >= clipEnd - 0.02) {
        handlePreviewEnded()
        return
      }
    } else {
      previewClockLastAt = performance.now()
    }
    syncPreviewAudioToTimeline(true)
  }, 80)
}

function handlePreviewPlay(): void {
  isPlaying.value = true
  startPreviewAudioSyncTimer()
  syncPreviewAudioToTimeline(true)
}

function handlePreviewPause(): void {
  isPlaying.value = false
  clearPreviewAudioSyncTimer()
  syncPreviewAudioToTimeline(false)
}

function pausePreview(): void {
  clearProgramAdvanceTimer()
  clearPreviewAudioSyncTimer()
  videoRef.value?.pause()
  syncPreviewAudioToTimeline(false)
  isPlaying.value = false
}

function syncPreviewMediaToTimeline(autoplay = false): void {
  const clip = previewClip.value
  const video = videoRef.value
  if (!clip) return

  if (clip.sourceType === 'static' || !clip.videoUrl) {
    if (autoplay) scheduleStaticProgramAdvance()
    return
  }

  if (!video || video.readyState < 1) return
  const localTime = Math.max(
    currentClipTrimStart(clip),
    Math.min(
      currentClipTrimEnd(clip),
      currentClipTrimStart(clip) + timelinePositionSeconds.value - clipStartSeconds(clip),
    ),
  )
  if (Math.abs(video.currentTime - localTime) > 0.02) video.currentTime = localTime
  if (autoplay) {
    void video.play().catch(() => {
      isPlaying.value = false
      showError('浏览器阻止了自动播放，请再次点击播放按钮。')
    })
  }
}

function scheduleStaticProgramAdvance(): void {
  clearProgramAdvanceTimer()
  if (!isPlaying.value) return
  const clip = previewClip.value
  if (!clip) return
  const remaining = Math.max(0.1, clipStartSeconds(clip) + Number(clip.durationSeconds || 0) - timelinePositionSeconds.value)
  programAdvanceTimer = setTimeout(() => {
    handlePreviewEnded()
  }, remaining * 1000)
}

function startProgramPlayback(): void {
  if (!enabledVideoClips().length) {
    showError('当前时间线没有可播放的启用片段。')
    return
  }
  if (timelinePositionSeconds.value >= totalTimelineDurationSeconds.value - 0.02) {
    timelinePositionSeconds.value = 0
    const firstClip = enabledVideoClips()[0]
    if (firstClip) selectClip(firstClip)
  }
  isPlaying.value = true
  startPreviewAudioSyncTimer()
  syncPreviewMediaToTimeline(true)
  syncPreviewAudioToTimeline(true)
}

function handlePreviewEnded(): void {
  if (programTransitioning) return
  const current = previewClip.value
  if (!current) {
    pausePreview()
    return
  }

  if (previewMode.value !== 'program') {
    timelinePositionSeconds.value = clipStartSeconds(current) + Number(current.durationSeconds || 0)
    pausePreview()
    return
  }

  const clips = enabledVideoClips()
  const currentIndex = clips.findIndex((item) => clipIdentity(item) === clipIdentity(current))
  const nextClip = currentIndex >= 0 ? clips[currentIndex + 1] : undefined
  if (!nextClip) {
    timelinePositionSeconds.value = totalTimelineDurationSeconds.value
    pausePreview()
    return
  }

  programTransitioning = true
  timelinePositionSeconds.value = clipStartSeconds(nextClip)
  selectedClipId.value = clipIdentity(nextClip)
  selectedStoryboardId.value = nextClip.storyboardId
  nextTick(() => {
    programTransitioning = false
    syncPreviewMediaToTimeline(true)
    scheduleStaticProgramAdvance()
  })
}

function moveProgramPlayback(direction: -1 | 1): void {
  const clips = enabledVideoClips()
  const currentIndex = previewClipIndex.value
  const target = clips[currentIndex + direction]
  if (!target) return
  pausePreview()
  timelinePositionSeconds.value = clipStartSeconds(target)
  selectedClipId.value = clipIdentity(target)
  selectedStoryboardId.value = target.storyboardId
  void nextTick(() => syncPreviewMediaToTimeline())
}

function handlePreviewTimeUpdate(): void {
  if (previewMode.value !== 'program') {
    syncTimelineToVideoTime()
    return
  }
  const video = videoRef.value
  const clip = previewClip.value
  if (!video || !clip) return
  const trimEnd = currentClipTrimEnd(clip)
  if (video.currentTime >= trimEnd - 0.04) {
    handlePreviewEnded()
    return
  }
  timelinePositionSeconds.value = Math.max(
    clipStartSeconds(clip),
    Math.min(
      clipStartSeconds(clip) + Number(clip.durationSeconds || 0),
      clipStartSeconds(clip) + video.currentTime - currentClipTrimStart(clip),
    ),
  )
}

function setPreviewMode(mode: PreviewMode): void {
  if (previewMode.value === mode) return
  pausePreview()
  previewMode.value = mode
  if (mode === 'clip' && selectedVideo.value) {
    timelinePositionSeconds.value = clipStartSeconds(selectedVideo.value)
  }
  void nextTick(() => {
    syncPreviewMediaToTimeline()
    syncPreviewAudioToTimeline(false)
  })
}

function togglePlay(): void {
  if (previewMode.value === 'program') {
    if (isPlaying.value) pausePreview()
    else startProgramPlayback()
    return
  }

  const video = videoRef.value
  if (!video) {
    if (isPlaying.value) {
      pausePreview()
    } else if (previewClip.value) {
      isPlaying.value = true
      startPreviewAudioSyncTimer()
      syncPreviewAudioToTimeline(true)
      scheduleStaticProgramAdvance()
    }
    return
  }
  if (video.paused) {
    isPlaying.value = true
    startPreviewAudioSyncTimer()
    syncPreviewMediaToTimeline(true)
    syncPreviewAudioToTimeline(true)
    return
  }
  pausePreview()
}

function syncTimelineToVideoTime(): void {
  const video = videoRef.value
  const clip = selectedVideo.value
  if (!video || !clip) return
  const localTime = Math.max(
    currentClipTrimStart(clip),
    Math.min(currentClipTrimEnd(clip), video.currentTime),
  )
  timelinePositionSeconds.value = Math.min(
    totalTimelineDurationSeconds.value,
    clipStartSeconds(clip) + localTime - currentClipTrimStart(clip),
  )
}

function seekSelectedVideoToTimelinePosition(): void {
  syncPreviewMediaToTimeline()
}

function seekTimeline(seconds: number): void {
  const total = totalTimelineDurationSeconds.value
  timelinePositionSeconds.value = Math.max(0, Math.min(total, Number(seconds) || 0))
  const clip = editableVideoClips.value.find((item) => {
    if (item.enabled === false) return false
    const start = clipStartSeconds(item)
    const end = start + (Number(item.durationSeconds) || 0)
    return timelinePositionSeconds.value >= start && timelinePositionSeconds.value <= end
  })
  if (clip && clipIdentity(clip) !== selectedClipId.value) {
    selectedStoryboardId.value = clip.storyboardId
    selectedClipId.value = clipIdentity(clip)
  }
  requestAnimationFrame(() => {
    seekSelectedVideoToTimelinePosition()
    syncPreviewAudioToTimeline(isPlaying.value)
  })
}

function timelineSecondsFromPointer(event: PointerEvent): number {
  const target = event.currentTarget as HTMLElement | null
  if (!target) return 0
  const rect = target.getBoundingClientRect()
  const isTrackStack = target.classList.contains('fe-edit-track-stack')
  const laneOffset = isTrackStack ? 122 : 0
  const contentWidth = isTrackStack ? timelineTrackWidthPx.value : rect.width
  const ratio = contentWidth <= 0 ? 0 : (event.clientX - rect.left - laneOffset) / contentWidth
  return Math.max(0, Math.min(1, ratio)) * totalTimelineDurationSeconds.value
}

function onTimelinePointerDown(event: PointerEvent): void {
  if (!totalTimelineDurationSeconds.value) return
  isScrubbingTimeline.value = true
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  seekTimeline(timelineSecondsFromPointer(event))
}

function onTimelinePointerMove(event: PointerEvent): void {
  if (!isScrubbingTimeline.value) return
  seekTimeline(timelineSecondsFromPointer(event))
}

function onTimelinePointerUp(event: PointerEvent): void {
  if (!isScrubbingTimeline.value) return
  isScrubbingTimeline.value = false
  ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
}

function onTimelineKeydown(event: KeyboardEvent): void {
  const total = totalTimelineDurationSeconds.value
  if (!total) return
  const step = event.shiftKey ? 1 : 0.25
  let next = timelinePositionSeconds.value
  if (event.key === 'ArrowLeft') next -= step
  else if (event.key === 'ArrowRight') next += step
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = total
  else return
  event.preventDefault()
  seekTimeline(next)
}

function onVolumeChange(): void {
  const video = videoRef.value
  if (video) video.volume = Math.max(0, Math.min(1, volume.value / 100))
  syncPreviewAudioToTimeline(isPlaying.value)
}

function selectVideo(storyboardId: number): void {
  selectedStoryboardId.value = storyboardId
  const clip = editableVideoClips.value.find((item) => item.storyboardId === storyboardId)
  selectedClipId.value = clip ? clipIdentity(clip) : null
  if (clip) {
    timelinePositionSeconds.value = clipStartSeconds(clip)
    requestAnimationFrame(() => seekSelectedVideoToTimelinePosition())
  }
}

function selectClip(clip: FinalEditVideoClipDTO): void {
  selectedStoryboardId.value = clip.storyboardId
  selectedClipId.value = clipIdentity(clip)
  timelinePositionSeconds.value = clipStartSeconds(clip)
  requestAnimationFrame(() => seekSelectedVideoToTimelinePosition())
}

function selectClipAtPointer(event: MouseEvent, clip: FinalEditVideoClipDTO): void {
  selectedStoryboardId.value = clip.storyboardId
  selectedClipId.value = clipIdentity(clip)
  const trackStack = (event.currentTarget as HTMLElement | null)?.closest('.fe-edit-track-stack')
  if (!trackStack) {
    selectClip(clip)
    return
  }
  const rect = trackStack.getBoundingClientRect()
  const ratio = timelineTrackWidthPx.value <= 0
    ? 0
    : (event.clientX - rect.left - 122) / timelineTrackWidthPx.value
  seekTimeline(Math.max(0, Math.min(1, ratio)) * totalTimelineDurationSeconds.value)
}

function selectStoryboardAtPointer(event: MouseEvent, storyboardId: number): void {
  const trackStack = (event.currentTarget as HTMLElement | null)?.closest('.fe-edit-track-stack')
  if (!trackStack) {
    selectVideo(storyboardId)
    return
  }
  const rect = trackStack.getBoundingClientRect()
  const ratio = timelineTrackWidthPx.value <= 0
    ? 0
    : (event.clientX - rect.left - 122) / timelineTrackWidthPx.value
  selectVideo(storyboardId)
  seekTimeline(Math.max(0, Math.min(1, ratio)) * totalTimelineDurationSeconds.value)
}

function updateVideoClip(
  clipIdOrStoryboardId: string | number,
  patch: Partial<FinalEditVideoClipDTO>,
): void {
  editableVideoClips.value = editableVideoClips.value.map((item, index) => {
    const matched = typeof clipIdOrStoryboardId === 'string'
      ? clipIdentity(item) === clipIdOrStoryboardId
      : item.storyboardId === clipIdOrStoryboardId
    if (!matched) return item
    return normalizeEditableVideoClip({ ...item, ...patch }, index)
  })
}

function updateSelectedTrim(kind: 'start' | 'end', value: number): void {
  const clip = selectedVideo.value
  if (!clip) return
  const sourceDuration = clipSourceDuration(clip)
  const currentStart = Math.max(0, Number(clip.trimStartSeconds) || 0)
  const currentEnd = Math.max(0.25, Number(clip.trimEndSeconds) || sourceDuration)
  if (kind === 'start') {
    const nextStart = Math.min(Math.max(0, Number(value) || 0), currentEnd - 0.25)
    rememberEditState()
    updateVideoClip(clipIdentity(clip), { trimStartSeconds: Number(nextStart.toFixed(3)) })
    return
  }
  const nextEnd = Math.max(currentStart + 0.25, Math.min(Number(value) || sourceDuration, sourceDuration))
  rememberEditState()
  updateVideoClip(clipIdentity(clip), { trimEndSeconds: Number(nextEnd.toFixed(3)) })
}

function splitSelectedClip(): void {
  const playheadClip = editableVideoClips.value.find((item) => {
    if (item.enabled === false) return false
    const start = clipStartSeconds(item)
    const end = start + (Number(item.durationSeconds) || 0)
    return timelinePositionSeconds.value > start + 0.001 && timelinePositionSeconds.value < end - 0.001
  })
  const clip = playheadClip || selectedVideo.value
  if (!clip) return
  const sourceDuration = clipSourceDuration(clip)
  const trimStart = Math.max(0, Number(clip.trimStartSeconds) || 0)
  const trimEnd = Math.min(sourceDuration, Number(clip.trimEndSeconds) || sourceDuration)
  const availableDuration = trimEnd - trimStart
  const clipStart = clipStartSeconds(clip)
  const clipEnd = clipStart + (Number(clip.durationSeconds) || 0)
  const isPlayheadInsideClip =
    timelinePositionSeconds.value > clipStart + 0.001 && timelinePositionSeconds.value < clipEnd - 0.001
  if (!isPlayheadInsideClip) {
    showError('请先把播放头移到当前片段内部，再执行分割。')
    return
  }
  const splitAt = Number(
    (trimStart + (timelinePositionSeconds.value - clipStart)).toFixed(3),
  )
  const firstDuration = splitAt - trimStart
  const secondDuration = trimEnd - splitAt
  if (availableDuration < 0.8 || firstDuration < 0.25 || secondDuration < 0.25) {
    showError('播放头两侧都至少需要保留 0.25 秒才能分割。')
    return
  }

  rememberEditState()
  const baseId = clipIdentity(clip)
  const first = normalizeEditableVideoClip(
    {
      ...clip,
      clipId: `${baseId}-a-${Date.now()}`,
      trimEndSeconds: splitAt,
      transition: cloneClipTransition({ type: 'cut', durationSeconds: 0 }),
    },
    0,
  )
  const second = normalizeEditableVideoClip(
    {
      ...clip,
      clipId: `${baseId}-b-${Date.now()}`,
      trimStartSeconds: splitAt,
      trimEndSeconds: trimEnd,
      transition: cloneClipTransition(clip.transition),
    },
    1,
  )
  const index = editableVideoClips.value.findIndex((item) => clipIdentity(item) === baseId)
  const next = [...editableVideoClips.value]
  next.splice(index, 1, first, second)
  editableVideoClips.value = next.map((item, itemIndex) => normalizeEditableVideoClip(item, itemIndex))
  selectedStoryboardId.value = first.storyboardId
  selectedClipId.value = clipIdentity(first)
  timelinePositionSeconds.value = clipStart + firstDuration
  showInfo(`已在播放头 ${formatTimecode(timelinePositionSeconds.value)} 处分割，源候选保持不变。`)
}

function updateSelectedTransition(type: TransitionType, durationSeconds: number): void {
  const clip = selectedVideo.value
  if (!clip) return
  rememberEditState()
  updateVideoClip(clipIdentity(clip), {
    transition: cloneClipTransition({ type, durationSeconds, manual: true }),
  })
}

function applyVideoCandidate(candidate: VideoAssetDTO): void {
  const clip = selectedVideo.value
  if (!clip) return
  const sourceDurationSeconds = Math.max(0.25, Number(candidate.durationSeconds) || clipSourceDuration(clip))
  rememberEditState()
  updateVideoClip(clipIdentity(clip), {
    id: candidate.id,
    videoAssetId: candidate.id,
    videoUrl: candidate.videoUrl,
    thumbnailUrl: candidate.thumbnailUrl || clip.thumbnailUrl,
    versionNo: candidate.versionNo || clip.versionNo,
    sourceType: 'video',
    sourceDurationSeconds,
    trimStartSeconds: 0,
    trimEndSeconds: sourceDurationSeconds,
  })
  showInfo(`已将当前镜头草稿切换到候选 V${candidate.versionNo || candidate.id}，原候选未被覆盖。`)
}

function updateAudioClip(
  trackKey: AudioTrackKey,
  audioId: number,
  patch: Partial<FinalEditAudioClipDTO>,
): void {
  editableAudioTracks.value = {
    ...editableAudioTracks.value,
    [trackKey]: editableAudioTracks.value[trackKey].map((item) =>
      item.id === audioId
        ? {
            ...item,
            ...patch,
            startOffsetSeconds: Math.max(
              -5,
              Math.min(9999, Number(patch.startOffsetSeconds ?? item.startOffsetSeconds) || 0),
            ),
            volume: normalizeVolume(patch.volume ?? item.volume, 100),
            enabled: patch.enabled === undefined ? item.enabled !== false : patch.enabled !== false,
          }
        : item,
    ),
  }
}

function nudgeSelectedAudioLead(seconds: number): void {
  const groups = selectedAudioGroups.value
  if (!groups.length) {
    showError('当前镜头没有可提前的声音片段。')
    return
  }
  rememberEditState()
  for (const group of groups) {
    for (const item of group.items) {
      updateAudioClip(group.key, item.id, {
        startOffsetSeconds: clampAudioOffset((Number(item.startOffsetSeconds) || 0) + seconds),
      })
    }
  }
  showInfo(seconds < 0 ? '已让当前镜头声音提前进入。' : '已让当前镜头声音稍后进入。')
}

function moveClip(storyboardId: number, direction: -1 | 1): void {
  // 调整镜头顺序只修改页面内的数组，真正保存由 handleSaveDraft() 统一提交。
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

function onClipDragStart(clip: FinalEditVideoClipDTO): void {
  draggedClipId.value = clipIdentity(clip)
}

function onBinTileDragStart(event: DragEvent, clip: FinalEditVideoClipDTO): void {
  // 素材库卡片是原生 HTML5 拖拽源：拖到主轨=插入换序，拖到画中画轨=新建叠加片段。
  const clipId = clipIdentity(clip)
  if (!clipId) return
  draggedClipId.value = clipId
  draggedClipFromBin.value = true
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.setData('text/plain', clipId)
  }
}

function resolveMainDropIndex(clientX: number): number {
  const lane = timelineMainLaneRef.value
  if (!lane) return editableVideoClips.value.length
  const clips = Array.from(lane.querySelectorAll<HTMLElement>('.fe-edit-clip-video'))
  for (const [index, element] of clips.entries()) {
    const rect = element.getBoundingClientRect()
    if (clientX < rect.left + rect.width / 2) return index
  }
  return clips.length
}

function onMainLaneDragOver(event: DragEvent): void {
  if (!draggedClipId.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  mainDropIndex.value = resolveMainDropIndex(event.clientX)
}

function onMainLaneDragLeave(): void {
  mainDropIndex.value = null
}

function onMainLaneDrop(event: DragEvent): void {
  event.preventDefault()
  const sourceId = draggedClipId.value
  const targetIndex = mainDropIndex.value
  mainDropIndex.value = null
  draggedClipId.value = null
  draggedClipFromBin.value = false
  if (!sourceId || targetIndex == null) return

  const sourceIndex = editableVideoClips.value.findIndex((item) => clipIdentity(item) === sourceId)
  if (sourceIndex < 0) return

  const insertAt = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
  if (insertAt === sourceIndex) return

  rememberEditState()
  const nextItems = [...editableVideoClips.value]
  const [source] = nextItems.splice(sourceIndex, 1)
  if (!source) return
  nextItems.splice(insertAt, 0, source)
  editableVideoClips.value = nextItems.map((item, index) => normalizeEditableVideoClip(item, index))
  selectedClipId.value = sourceId
  selectedStoryboardId.value = source.storyboardId
  showInfo(`已把 ${resolveShotLabel(source)} 插入主轨第 ${insertAt + 1} 位。`)
}

function startClipPointerDrag(event: PointerEvent, clip: FinalEditVideoClipDTO): void {
  if (event.button !== 0 || clip.enabled === false) return
  const clipId = clipIdentity(clip)
  const currentIndex = editableVideoClips.value.findIndex((item) => clipIdentity(item) === clipId)
  if (!clipId || currentIndex < 0) return
  clipPointerDrag.value = {
    clipId,
    startX: event.clientX,
    currentIndex,
    moved: false,
  }
  window.addEventListener('pointermove', onClipPointerMove)
  window.addEventListener('pointerup', stopClipPointerDrag, { once: true })
}

function onClipPointerMove(event: PointerEvent): void {
  const drag = clipPointerDrag.value
  if (!drag) return
  if (Math.abs(event.clientX - drag.startX) < 6 && !drag.moved) return

  const target = document
    .elementFromPoint(event.clientX, event.clientY)
    ?.closest<HTMLElement>('.fe-edit-clip-video[data-clip-id]')
  const targetId = target?.dataset.clipId
  if (!targetId || targetId === drag.clipId) {
    drag.moved = true
    return
  }

  const targetIndex = editableVideoClips.value.findIndex((item) => clipIdentity(item) === targetId)
  if (targetIndex < 0 || targetIndex === drag.currentIndex) return
  if (!drag.moved) rememberEditState()
  drag.moved = true

  const nextItems = [...editableVideoClips.value]
  const [source] = nextItems.splice(drag.currentIndex, 1)
  if (!source) return
  nextItems.splice(targetIndex, 0, source)
  editableVideoClips.value = nextItems.map((item, index) => normalizeEditableVideoClip(item, index))
  drag.currentIndex = targetIndex
  selectedClipId.value = drag.clipId
  selectedStoryboardId.value = source.storyboardId
}

function stopClipPointerDrag(): void {
  const drag = clipPointerDrag.value
  if (!drag) return
  clipPointerDrag.value = null
  window.removeEventListener('pointermove', onClipPointerMove)
  if (drag.moved) {
    suppressClipClick.value = true
    showInfo(timelineSnapEnabled.value ? '已将镜头吸附到主轨片段边界。' : '已调整镜头在主轨中的顺序。')
    window.setTimeout(() => {
      suppressClipClick.value = false
    }, 0)
  }
}

function handleTimelineClipClick(event: MouseEvent, clip: FinalEditVideoClipDTO): void {
  if (suppressClipClick.value) {
    event.preventDefault()
    return
  }
  selectClipAtPointer(event, clip)
}

function onClipDrop(targetClip: FinalEditVideoClipDTO): void {
  const sourceId = draggedClipId.value
  const targetId = clipIdentity(targetClip)
  draggedClipId.value = null
  if (!sourceId || sourceId === targetId) return
  const sourceIndex = editableVideoClips.value.findIndex((item) => clipIdentity(item) === sourceId)
  const targetIndex = editableVideoClips.value.findIndex((item) => clipIdentity(item) === targetId)
  if (sourceIndex < 0 || targetIndex < 0) return
  rememberEditState()
  const nextItems = [...editableVideoClips.value]
  const [source] = nextItems.splice(sourceIndex, 1)
  if (!source) return
  nextItems.splice(targetIndex, 0, source)
  editableVideoClips.value = nextItems.map((item, index) => normalizeEditableVideoClip(item, index))
}

function onClipDragEnd(): void {
  draggedClipId.value = null
}

function toggleClipEnabled(storyboardId: number): void {
  // 禁用镜头不会删除资产，只是在最终成片草稿里标记 enabled=false。
  editableVideoClips.value = editableVideoClips.value.map((item) =>
    item.storyboardId === storyboardId ? { ...item, enabled: item.enabled === false } : item,
  )
}

function addBeatMarker(): void {
  const clip = selectedVideo.value
  if (!clip) return
  rememberEditState()
  const atSeconds = Number((clipStartSeconds(clip) + Math.max(0.1, Number(clip.durationSeconds) || 0) / 2).toFixed(3))
  beatMarkers.value = [
    ...beatMarkers.value,
    { markerId: `beat-${Date.now()}`, atSeconds, label: '新节拍点' },
  ]
}

function updateBeatMarker(markerId: string, patch: Partial<NonNullable<FinalEditDraftDTO['beatMarkers']>[number]>): void {
  rememberEditState()
  beatMarkers.value = beatMarkers.value.map((marker) =>
    marker.markerId === markerId
      ? { ...marker, ...patch, atSeconds: Math.max(0, Number(patch.atSeconds ?? marker.atSeconds) || 0) }
      : marker,
  )
}

function addEmotionPoint(): void {
  const clip = selectedVideo.value
  if (!clip) return
  rememberEditState()
  const atSeconds = Number((clipStartSeconds(clip) + Math.max(0.1, Number(clip.durationSeconds) || 0) / 2).toFixed(3))
  emotionCurve.value = [
    ...emotionCurve.value,
    { pointId: `emotion-${Date.now()}`, atSeconds, intensity: 60, label: '情绪推进' },
  ]
}

function updateEmotionPoint(pointId: string, patch: Partial<NonNullable<FinalEditDraftDTO['emotionCurve']>[number]>): void {
  rememberEditState()
  emotionCurve.value = emotionCurve.value.map((point) =>
    point.pointId === pointId
      ? {
          ...point,
          ...patch,
          atSeconds: Math.max(0, Number(patch.atSeconds ?? point.atSeconds) || 0),
          intensity: Math.max(0, Math.min(100, Math.round(Number(patch.intensity ?? point.intensity) || 50))),
        }
      : point,
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

async function loadSelectedVideoCandidates(): Promise<void> {
  const storyboardId = selectedStoryboardId.value
  if (!storyboardId) {
    selectedVideoCandidates.value = []
    return
  }
  isLoadingVideoCandidates.value = true
  try {
    const candidates = (await listStoryboardVideos(storyboardId)).filter((item) => Boolean(item.videoUrl))
    if (selectedStoryboardId.value === storyboardId) {
      selectedVideoCandidates.value = candidates
    }
  } catch {
    if (selectedStoryboardId.value === storyboardId) {
      selectedVideoCandidates.value = []
    }
  } finally {
    if (selectedStoryboardId.value === storyboardId) {
      isLoadingVideoCandidates.value = false
    }
  }
}

function updateSubtitleCue(
  cueId: string,
  patch: Partial<FinalEditDraftDTO['subtitleCues'][number]>,
): void {
  editableSubtitleCues.value = editableSubtitleCues.value.map((cue) =>
    cue.cueId === cueId ? { ...cue, ...patch } : cue,
  )
}

function addSubtitleCue(): void {
  const clip = editableVideoClips.value.find((item) => item.enabled !== false)
  if (!clip) {
    showError('请先保留至少一个启用视频片段，再添加字幕。')
    return
  }
  const index = editableSubtitleCues.value.length + 1
  editableSubtitleCues.value = [
    ...editableSubtitleCues.value,
    {
      cueId: `manual-${Date.now()}-${index}`,
      storyboardId: clip.storyboardId,
      enabled: true,
      startOffsetSeconds: 0,
      durationSeconds: Math.max(0.25, Number(clip.durationSeconds) || 1),
      text: '',
    },
  ]
}

function resolveSubtitleCueLabel(cue: FinalEditDraftDTO['subtitleCues'][number]): string {
  const clip = editableVideoClips.value.find((item) => item.storyboardId === cue.storyboardId)
  return clip
    ? `Scene ${String(clip.sceneNo).padStart(2, '0')} / ${resolveShotLabel(clip)}`
    : `镜头 ${cue.storyboardId}`
}

function resetDraft(): void {
  if (!finalEdit.value) return
  syncEditableState(finalEdit.value, selectedStoryboardId.value)
  showInfo('已恢复到最近一次保存的成片草稿。')
}

async function applyRecommendedTransitionReplan(): Promise<void> {
  // 只重规划剪辑草稿里的转场参数：不改镜头顺序、源视频、裁切、音轨或字幕。
  // 同一场景的连续动作保留硬切；明确换场才给极短淡入淡出，避免“全片一套转场”。
  const source = editableVideoClips.value
  editableVideoClips.value = source.map((clip, index) => {
    const nextClip = source[index + 1]
    const sameScene = Boolean(nextClip && clip.sceneId === nextClip.sceneId)
    const transition = nextClip
      ? sameScene ? { type: 'cut', durationSeconds: 0, manual: false } : { type: 'fade', durationSeconds: 0.18, manual: false }
      : { type: 'cut', durationSeconds: 0, manual: false }
    return normalizeEditableVideoClip({ ...clip, transition }, index)
  })

  if (await handleSaveDraft(true)) {
    await router.replace({
      query: {
        ...route.query,
        replan: undefined,
      },
    })
    showInfo('已按镜头语义重新规划转场并保存草稿；原始分镜视频未改动。', 4200)
  }
}

async function handleSaveDraft(silentSuccess = false): Promise<boolean> {
  // 保存的是 final_edit_drafts，不会改写原始分镜顺序或删除视频资产。
  if (!projectId.value || !finalEdit.value) return false
  if (isSaving.value) return false

  isSaving.value = true
  errorMsg.value = ''

  try {
    const payload = await updateProjectFinalEditDraft(projectId.value, buildDraftPayload(), selectedEpisodeNo.value)
    syncEditableState(payload, selectedStoryboardId.value)
    pageState.value = payload.summary.hasVideo ? 'ready' : 'missing-video'
    if (!silentSuccess) {
      showInfo('成片编辑草稿已保存。')
    }
    return true
  } catch (error) {
    showError(error instanceof Error ? error.message : '成片编辑草稿保存失败')
    return false
  } finally {
    isSaving.value = false
  }
}

async function loadPage(): Promise<void> {
  // 后端返回完整的剪辑工作区数据：
  // 视频轨、四类音频轨、当前草稿、导出校验结果和统计摘要。
  if (!projectId.value) {
    pageState.value = 'missing-project'
    project.value = null
    finalEdit.value = null
    editableVideoClips.value = []
    editableAudioTracks.value = createEmptyAudioTracks()
    audioMixState.value = createEmptyAudioMix()
    editableSubtitleCues.value = []
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
      getProjectFinalEdit(projectId.value, selectedEpisodeNo.value),
    ])

    project.value = projectData
    syncEditableState(finalEditData, selectedStoryboardId.value)

    if (!finalEditData.summary.hasVideo) {
      pageState.value = 'missing-video'
      return
    }

    pageState.value = 'ready'
    if (!finalEditData.summary.hasAudio) {
      showInfo('当前还没有已确认音频，建议在导出前先去音频模块确认主版本。', 5200)
    }
    onVolumeChange()
    if (route.query.replan === '1') {
      await applyRecommendedTransitionReplan()
    }
  } catch (error) {
    project.value = null
    finalEdit.value = null
    editableVideoClips.value = []
    editableAudioTracks.value = createEmptyAudioTracks()
    audioMixState.value = createEmptyAudioMix()
    editableSubtitleCues.value = []
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
  if (previewMode.value === 'clip') pausePreview()
  void loadSelectedVideoCandidates()
})

watch(
  [
    previewMode,
    () => (previewClip.value ? clipIdentity(previewClip.value) : null),
    previewSourceUrl,
  ],
  () => {
    void nextTick(() => {
      syncPreviewMediaToTimeline(isPlaying.value)
      syncPreviewAudioToTimeline(isPlaying.value)
    })
  },
)

onMounted(() => {
  void loadPage()
})

onBeforeUnmount(() => {
  clearToastTimer()
  clearProgramAdvanceTimer()
  clearPreviewAudioSyncTimer()
  videoRef.value?.pause()
  for (const audio of previewAudioElements.values()) audio.pause()
  previewAudioElements.clear()
  window.removeEventListener('pointermove', onTrimPointerMove)
  window.removeEventListener('pointerup', stopTrimDrag)
  window.removeEventListener('pointermove', onTimelineResizeMove)
  window.removeEventListener('pointerup', stopTimelineResize)
  window.removeEventListener('pointermove', onClipPointerMove)
  window.removeEventListener('pointerup', stopClipPointerDrag)
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
          请先在视频模块确认至少一个主视频，再开始成片编辑。
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

    <div v-else class="final-edit-shell flex h-full bg-background">
      <div class="final-edit-main flex min-w-0 flex-1 flex-col overflow-hidden">
        <header class="final-edit-header">
          <div class="final-edit-title-row">
            <div class="min-w-0">
              <p class="final-edit-kicker">{{ project?.name || `项目 #${projectId}` }}</p>
              <h1>成片编辑</h1>
              <p class="final-edit-subtitle">
                整理镜头顺序、字幕与声音，确认后进入导出。
              </p>
            </div>

            <div class="final-edit-actions">
              <button class="fe-button fe-button-quiet" type="button" @click="goTaskCenter">
                <span class="material-symbols-outlined" aria-hidden="true">pending_actions</span>
                任务中心
              </button>
              <button class="fe-button fe-button-quiet" type="button" @click="goAudio">
                <span class="material-symbols-outlined" aria-hidden="true">mic</span>
                音频模块
              </button>
              <button class="fe-button fe-button-primary" type="button" :disabled="isSaving" @click="handleSaveDraft()">
                <span class="material-symbols-outlined" aria-hidden="true">
                  {{ isSaving ? 'progress_activity' : 'save' }}
                </span>
                {{ isSaving ? '保存中' : isDirty ? '保存草稿' : '已保存' }}
              </button>
              <button
                class="fe-button fe-button-quiet"
                type="button"
                @click="openDeliveryPanel"
              >
                <span class="material-symbols-outlined" aria-hidden="true">package_2</span>
                交付包
              </button>
              <button
                class="fe-button fe-button-quiet"
                type="button"
                @click="openJianyingPanel"
              >
                <span class="material-symbols-outlined" aria-hidden="true">movie_edit</span>
                导出到剪映
              </button>
              <button
                class="fe-button fe-button-quiet"
                type="button"
                :disabled="!localValidation.canExport"
                @click="goExport"
              >
                <span class="material-symbols-outlined" aria-hidden="true">ios_share</span>
                导出
              </button>
            </div>
          </div>
        </header>

        <div class="final-edit-status-bar">
          <div class="final-edit-stats">
            <article class="fe-stat">
              <p>已确认视频</p>
              <strong>
                {{ finalEdit?.summary.confirmedVideoCount || 0 }}
              </strong>
            </article>
            <article class="fe-stat">
              <p>启用片段</p>
              <strong>
                {{ localValidation.enabledVideoCount }}
              </strong>
            </article>
            <article class="fe-stat">
              <p>启用时长</p>
              <strong>
                {{ formatDuration(localValidation.enabledVideoDurationSeconds) }}
              </strong>
            </article>
            <article class="fe-stat">
              <p>已确认音频</p>
              <strong>
                {{ finalEdit?.summary.confirmedAudioCount || 0 }}
              </strong>
            </article>
            <article class="fe-stat">
              <p>启用音频轨</p>
              <strong>
                {{ localValidation.enabledAudioTrackCount }}
              </strong>
            </article>
          </div>
        </div>

        <Transition name="fe-toast">
          <div
            v-if="errorMsg || infoMsg"
            class="fe-toast-layer"
            aria-live="polite"
            aria-atomic="true"
          >
            <div v-if="errorMsg" class="fe-toast fe-toast-error" role="alert">
              <span class="material-symbols-outlined fe-toast-icon" aria-hidden="true">error</span>
              <span class="fe-toast-message">{{ errorMsg }}</span>
              <button
                class="fe-toast-close"
                type="button"
                aria-label="关闭提示"
                @click="dismissToast"
              >
                <span class="material-symbols-outlined" aria-hidden="true">close</span>
              </button>
            </div>
            <div v-else class="fe-toast fe-toast-info" role="status">
              <span class="material-symbols-outlined fe-toast-icon" aria-hidden="true">check_circle</span>
              <span class="fe-toast-message">{{ infoMsg }}</span>
              <button
                class="fe-toast-close"
                type="button"
                aria-label="关闭提示"
                @click="dismissToast"
              >
                <span class="material-symbols-outlined" aria-hidden="true">close</span>
              </button>
            </div>
          </div>
        </Transition>

        <Transition name="fe-toast">
          <div
            v-if="isDeliveryPanelOpen"
            class="fe-delivery-layer"
            role="dialog"
            aria-modal="true"
            aria-label="交付包"
          >
            <div class="fe-delivery-panel">
              <div class="fe-delivery-head">
                <div>
                  <p class="fe-section-label">Delivery</p>
                  <h2>交付包</h2>
                  <p class="fe-control-hint">
                    把这一集的镜头、音轨、字幕整理成能直接拖进剪映（或 DaVinci）的素材包。原始素材和历史候选不会被改动。
                  </p>
                </div>
                <button
                  class="fe-icon-button"
                  type="button"
                  aria-label="关闭交付包"
                  @click="isDeliveryPanelOpen = false"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">close</span>
                </button>
              </div>

              <p v-if="isDeliveryLoading" class="fe-delivery-loading">正在生成清单…</p>

              <template v-else-if="deliveryPackage">
                <div class="fe-delivery-summary">
                  <div><span>画布</span><strong>{{ deliveryPackage.canvas.ratio }}</strong></div>
                  <div><span>成片时长</span><strong>{{ formatDuration(deliveryPackage.totalDurationSeconds) }}</strong></div>
                  <div>
                    <span>镜头</span>
                    <strong>{{ deliveryPackage.totals.clipCount }} / {{ deliveryPackage.totals.totalClipCount }}</strong>
                  </div>
                  <div><span>字幕</span><strong>{{ deliveryPackage.totals.subtitleCount }}</strong></div>
                  <div><span>音频</span><strong>{{ deliveryPackage.totals.audioCount }}</strong></div>
                </div>

                <ol class="fe-delivery-steps">
                  <li>点下面的按钮下载 ZIP，解压到任意文件夹。</li>
                  <li>剪映新建成片草稿，画布比例选 <strong>{{ deliveryPackage.canvas.ratio }}</strong>。</li>
                  <li>
                    导入 <code>materials/</code> 里全部文件，一次性拖到主轨；文件名已经按顺序编号。
                  </li>
                  <li>
                    导入 <code>audio/</code> 各轨文件拖到对应音轨；字幕用「文本 → 智能字幕 → 导入字幕」选
                    <code>subtitles.srt</code>。
                  </li>
                </ol>

                <div class="fe-delivery-actions">
                  <button
                    class="fe-button fe-button-primary"
                    type="button"
                    :disabled="isDeliveryDownloading"
                    @click="downloadDeliveryArchive(true)"
                  >
                    <span class="material-symbols-outlined" aria-hidden="true">download</span>
                    {{ isDeliveryDownloading ? '打包中…' : '下载完整交付包' }}
                  </button>
                  <button
                    class="fe-button fe-button-quiet"
                    type="button"
                    :disabled="isDeliveryDownloading"
                    @click="downloadDeliveryArchive(false)"
                  >
                    只下载清单文件
                  </button>
                  <button
                    class="fe-button fe-button-quiet"
                    type="button"
                    @click="downloadDeliveryTextFile('srt')"
                  >
                    单独下载字幕 SRT
                  </button>
                </div>

                <ul
                  v-if="
                    deliveryPackage.unmatchedAudioCount ||
                    deliveryPackage.overlayClipCount ||
                    deliveryPackage.orphanSubtitleCount ||
                    deliveryPackage.orphanAudioCount
                  "
                  class="fe-delivery-warnings"
                >
                  <li v-if="deliveryPackage.unmatchedAudioCount">
                    有 {{ deliveryPackage.unmatchedAudioCount }} 条对白/旁白还没有对应画面，没有包含在交付包里。
                  </li>
                  <li v-if="deliveryPackage.orphanAudioCount">
                    有 {{ deliveryPackage.orphanAudioCount }} 条音频挂在没进时间线的镜头上，已剔除，避免声音跑到成片开头。
                  </li>
                  <li v-if="deliveryPackage.orphanSubtitleCount">
                    有 {{ deliveryPackage.orphanSubtitleCount }} 条字幕对应的镜头不在时间线上，已剔除。
                  </li>
                  <li v-if="deliveryPackage.overlayClipCount">
                    画中画有 {{ deliveryPackage.overlayClipCount }} 个片段，导出合成尚未接入，交付包里没有，需要在剪辑软件里手动叠加。
                  </li>
                </ul>

                <div class="fe-delivery-list">
                  <div class="fe-bin-subtitle-row">
                    <strong>素材顺序</strong>
                    <span>{{ deliveryPackage.clips.length }} 个镜头</span>
                  </div>
                  <ol>
                    <li v-for="clip in deliveryPackage.clips" :key="`delivery-${clip.index}`">
                      <code>{{ clip.fileName }}</code>
                      <span>{{ formatDuration(clip.durationSeconds) }}</span>
                      <em v-if="clip.trimStartSeconds || clip.trimEndSeconds < clip.sourceDurationSeconds">
                        源 {{ clip.trimStartSeconds }}s → {{ clip.trimEndSeconds }}s
                      </em>
                    </li>
                  </ol>
                </div>
              </template>

              <p v-else class="fe-control-hint">
                还没有拿到交付清单，可以重新打开这个面板再试一次。
              </p>
            </div>
          </div>
        </Transition>

        <Transition name="fe-toast">
          <div
            v-if="isJianyingPanelOpen"
            class="fe-delivery-layer"
            role="dialog"
            aria-modal="true"
            aria-label="导出到剪映"
          >
            <div class="fe-delivery-panel">
              <div class="fe-delivery-head">
                <div>
                  <p class="fe-section-label">CapCut</p>
                  <h2>导出到剪映</h2>
                  <p class="fe-control-hint">
                    把这集的镜头顺序、字幕、声音写成剪映草稿，打开剪映就是排好的时间线，可以继续加转场、特效、调色。原始素材和历史候选不会被改动。
                  </p>
                </div>
                <button
                  class="fe-icon-button"
                  type="button"
                  aria-label="关闭导出到剪映"
                  @click="isJianyingPanelOpen = false"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">close</span>
                </button>
              </div>

              <p v-if="isJianyingLoading" class="fe-delivery-loading">正在读取剪映环境…</p>

              <template v-else>
                <!-- 环境状态：剪映开着的时候不允许安装，否则索引会被覆盖 -->
                <div
                  class="fe-jy-status"
                  :class="{
                    'is-blocked': jianyingStatus && jianyingStatus.jianyingRunning === true,
                    'is-ready': jianyingStatus && jianyingStatus.rootReady && jianyingStatus.jianyingRunning === false,
                  }"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">
                    {{ jianyingStatus?.jianyingRunning === true ? 'error' : jianyingStatus?.rootReady ? 'check_circle' : 'help' }}
                  </span>
                  <div>
                    <strong v-if="jianyingStatus?.jianyingRunning === true">剪映正在运行，请先完全退出</strong>
                    <strong v-else-if="!jianyingStatus?.rootReady">没找到剪映草稿库</strong>
                    <strong v-else>可以导出，剪映已关闭</strong>
                    <p class="fe-jy-path">{{ jianyingStatus?.draftRoot || '未检测到剪映草稿目录' }}</p>
                    <p v-if="jianyingStatus?.jianyingRunning === true" class="fe-jy-hint">
                      剪映退出时会重写草稿索引，运行中导出会被它覆盖。
                    </p>
                  </div>
                </div>

                <template v-if="jianyingPlan">
                  <div class="fe-delivery-summary fe-jy-summary">
                    <div><span>草稿名</span><strong class="fe-jy-name">{{ jianyingPlan.draftName }}</strong></div>
                    <div>
                      <span>画布</span>
                      <strong>
                        {{ jianyingPlan.canvas.ratio }}
                        <em class="fe-jy-px">{{ jianyingPlan.canvas.width }}×{{ jianyingPlan.canvas.height }}</em>
                      </strong>
                    </div>
                    <div><span>成片时长</span><strong>{{ formatDuration(jianyingPlan.totalDurationSeconds) }}</strong></div>
                    <div><span>主轨镜头</span><strong>{{ jianyingPlan.stats.videoSegments }}</strong></div>
                    <div><span>字幕</span><strong>{{ jianyingPlan.stats.textSegments }}</strong></div>
                    <div><span>素材</span><strong>{{ jianyingPlan.mediaRequestCount }}</strong></div>
                  </div>

                  <p class="fe-control-hint">
                    其中真视频 {{ jianyingPlan.videoClipCount }} 个、静帧 {{ jianyingPlan.stillFrameClipCount }} 个。
                    静帧会以图片形式进剪映，按镜头时长定格。
                  </p>

                  <!-- 画布来源必须说清楚：声明比例和真实素材经常不一致 -->
                  <p
                    v-if="
                      jianyingPlan.canvasSource === 'media' &&
                      jianyingPlan.declaredAspectRatio &&
                      jianyingPlan.declaredAspectRatio !== jianyingPlan.canvas.ratio
                    "
                    class="fe-control-hint"
                  >
                    画布是按真实素材量出来的 <strong>{{ jianyingPlan.canvas.ratio }}</strong>
                    （{{ jianyingPlan.canvas.width }}×{{ jianyingPlan.canvas.height }}），和项目声明的
                    {{ jianyingPlan.declaredAspectRatio }} 不一致——<strong>以素材为准</strong>，避免横屏素材被塞进竖屏画布。
                  </p>
                  <p
                    v-else-if="jianyingPlan.canvasSource === 'fallback'"
                    class="fe-control-hint fe-jy-warn"
                  >
                    项目声明的比例「{{ jianyingPlan.declaredAspectRatio || '空' }}」认不出来，草稿先按 9:16 生成；
                    请在剪映里确认画布比例。
                  </p>
                  <p v-else-if="!jianyingPlan.mediaCached" class="fe-control-hint">
                    素材还没下载到本机，所以画布暂时按项目声明算；下载后会自动改成真实素材比例。
                  </p>

                  <div class="fe-delivery-actions">
                    <button
                      class="fe-button fe-button-primary"
                      type="button"
                      :disabled="isJianyingExporting || jianyingStatus?.jianyingRunning === true || !jianyingStatus?.rootReady"
                      @click="exportToJianying(true)"
                    >
                      <span class="material-symbols-outlined" aria-hidden="true">movie_edit</span>
                      {{ isJianyingExporting ? '处理中…' : '导出到剪映' }}
                    </button>
                    <button
                      class="fe-button fe-button-quiet"
                      type="button"
                      :disabled="isJianyingExporting"
                      @click="exportToJianying(false)"
                    >
                      只下载素材到本机
                    </button>
                    <button
                      class="fe-button fe-button-quiet"
                      type="button"
                      :disabled="isJianyingLoading"
                      @click="refreshJianyingPanel"
                    >
                      刷新
                    </button>
                  </div>

                  <p v-if="jianyingExportStage" class="fe-delivery-loading">{{ jianyingExportStage }}</p>

                  <ul v-if="jianyingPlan.stats.unsupportedTransitions.length" class="fe-delivery-warnings">
                    <li>
                      有 {{ jianyingPlan.stats.unsupportedTransitions.length }} 个转场（如叠化）会按**硬切**导出——
                      剪映转场要用它内置的特效 ID，占位 ID 只会被忽略。需要在剪映里手动补。
                    </li>
                  </ul>
                  <p v-if="jianyingPlan.unmatchedAudioCount" class="fe-control-hint">
                    另有 {{ jianyingPlan.unmatchedAudioCount }} 条对白/旁白还没有对应画面，不会进入草稿。
                  </p>

                  <div v-if="jianyingResult" class="fe-jy-result">
                    <strong>上次导出结果</strong>
                    <ul>
                      <li>素材 {{ jianyingResult.media.materialized }} 个新下载、{{ jianyingResult.media.reused }} 个复用本机缓存</li>
                      <li v-if="jianyingResult.media.failed.length" class="is-warn">
                        {{ jianyingResult.media.failed.length }} 个素材下载失败，已从草稿中剔除
                      </li>
                      <li v-if="jianyingResult.stats.imageMaterials">
                        静帧 {{ jianyingResult.stats.imageMaterials }} 张、视频 {{ jianyingResult.stats.videoMaterials }} 个
                      </li>
                      <li v-if="jianyingResult.installed">
                        已写入剪映{{ jianyingResult.replacedExisting ? '（覆盖上一次同集导出）' : '' }}{{ jianyingResult.createdBackup ? '，并已备份剪映索引' : '' }}
                      </li>
                      <li v-else>素材已落地，尚未写入剪映</li>
                    </ul>
                  </div>

                  <div v-if="jianyingStatus?.drafts.length" class="fe-delivery-list">
                    <div class="fe-bin-subtitle-row">
                      <strong>已导出的剪映草稿</strong>
                      <span>{{ jianyingStatus.drafts.length }} 个</span>
                    </div>
                    <ol>
                      <li v-for="draft in jianyingStatus.drafts" :key="draft.folder">
                        <code>{{ draft.name }}</code>
                        <span v-if="draft.projectId === projectId">本项目</span>
                        <button
                          class="fe-jy-remove"
                          type="button"
                          :disabled="jianyingStatus.jianyingRunning === true"
                          @click="removeJianyingDraft(draft.folder)"
                        >
                          移除
                        </button>
                      </li>
                    </ol>
                  </div>
                </template>

                <p v-else class="fe-control-hint">还没拿到导出演练结果，点刷新再试一次。</p>
              </template>
            </div>
          </div>
        </Transition>

        <div
          class="final-edit-content min-h-0 flex-1"
          :style="{ '--fe-timeline-height': `${timelineDockHeight}px` }"
        >
          <aside class="fe-material-bin" aria-label="剪辑素材库">
            <div class="fe-bin-header">
              <div>
                <h2>素材库</h2>
                <p>{{ editableVideoClips.length }} 个镜头 · 已确认的对白、旁白与音轨</p>
              </div>
              <button class="fe-icon-button" type="button" aria-label="去任务中心" @click="goTaskCenter">
                <span class="material-symbols-outlined" aria-hidden="true">pending_actions</span>
              </button>
            </div>

            <nav class="fe-bin-tabs" aria-label="素材类别">
              <button
                type="button"
                class="fe-bin-tab"
                :class="activeMaterialPanel === 'media' ? 'fe-bin-tab-active' : ''"
                @click="activeMaterialPanel = 'media'"
              >
                <span class="material-symbols-outlined" aria-hidden="true">movie</span>
                媒体
              </button>
              <button
                type="button"
                class="fe-bin-tab"
                :class="activeMaterialPanel === 'audio' ? 'fe-bin-tab-active' : ''"
                @click="activeMaterialPanel = 'audio'"
              >
                <span class="material-symbols-outlined" aria-hidden="true">graphic_eq</span>
                音频
              </button>
              <button
                type="button"
                class="fe-bin-tab"
                :class="activeMaterialPanel === 'text' ? 'fe-bin-tab-active' : ''"
                @click="activeMaterialPanel = 'text'"
              >
                <span class="material-symbols-outlined" aria-hidden="true">subtitles</span>
                字幕
              </button>
              <button
                type="button"
                class="fe-bin-tab"
                :class="activeMaterialPanel === 'transitions' ? 'fe-bin-tab-active' : ''"
                @click="activeMaterialPanel = 'transitions'"
              >
                <span class="material-symbols-outlined" aria-hidden="true">animation</span>
                转场
              </button>
            </nav>

            <div class="fe-bin-body">
              <div v-if="activeMaterialPanel === 'media'" class="fe-bin-panel">
                <div class="fe-bin-search" role="search" aria-label="素材搜索">
                  <span class="material-symbols-outlined" aria-hidden="true">search</span>
                  <input
                    v-model.trim="binQuery"
                    type="search"
                    class="fe-bin-search-input"
                    placeholder="搜索场景 / 镜头号"
                    aria-label="搜索素材"
                  />
                  <span class="fe-bin-search-count">
                    {{ filteredVideoClips.length }} / {{ editableVideoClips.length }}
                  </span>
                </div>
                <p class="fe-bin-drag-hint">
                  <span class="material-symbols-outlined" aria-hidden="true">drag_indicator</span>
                  把卡片拖到时间线主轨即可加入剪辑，按住卡片也能在主轨里换序
                </p>
                <div class="fe-media-grid">
                  <button
                    v-for="clip in filteredVideoClips"
                    :key="`bin-${clipIdentity(clip)}`"
                    type="button"
                    class="fe-media-tile"
                    :class="selectedClipId === clipIdentity(clip) ? 'fe-media-tile-active' : ''"
                    draggable="true"
                    :title="`Scene ${String(clip.sceneNo).padStart(2, '0')} / ${resolveShotLabel(clip)} · ${formatDuration(clip.durationSeconds)}`"
                    @click="selectClip(clip)"
                    @dragstart="onBinTileDragStart($event, clip)"
                    @dragend="onClipDragEnd"
                  >
                    <span class="fe-media-thumb">
                      <img
                        v-if="clip.thumbnailUrl || clip.imageUrl"
                        :src="clip.thumbnailUrl || clip.imageUrl || undefined"
                        :alt="`${resolveShotLabel(clip)} 缩略图`"
                      />
                      <span v-else class="fe-media-placeholder material-symbols-outlined" aria-hidden="true">movie</span>
                      <em class="fe-media-badge fe-media-badge-time">{{ formatDuration(clip.durationSeconds) }}</em>
                      <em
                        class="fe-media-badge fe-media-badge-state"
                        :class="clip.enabled === false ? 'fe-media-badge-off' : ''"
                      >
                        {{ clip.enabled === false ? '已停用' : '在时间线' }}
                      </em>
                    </span>
                    <strong>Scene {{ String(clip.sceneNo).padStart(2, '0') }} / {{ resolveShotLabel(clip) }}</strong>
                  </button>
                </div>
                <p v-if="filteredVideoClips.length === 0" class="fe-control-hint">
                  没有匹配的镜头，清空搜索后再试。
                </p>

                <div class="fe-bin-subsection">
                  <div class="fe-bin-subtitle-row">
                    <strong>候选版本</strong>
                    <span>{{ isLoadingVideoCandidates ? '加载中' : `${selectedVideoCandidates.length} 个` }}</span>
                  </div>
                  <div v-if="selectedVideoCandidates.length" class="fe-candidate-list fe-candidate-list-bin">
                    <button
                      v-for="candidate in selectedVideoCandidates"
                      :key="`bin-candidate-${candidate.id}`"
                      type="button"
                      class="fe-candidate-item"
                      :class="selectedVideo && Number(selectedVideo.videoAssetId || selectedVideo.id) === candidate.id ? 'fe-candidate-item-active' : ''"
                      @click="applyVideoCandidate(candidate)"
                    >
                      <img
                        v-if="candidate.thumbnailUrl"
                        :src="candidate.thumbnailUrl"
                        :alt="`候选 V${candidate.versionNo}`"
                      />
                      <span>
                        <strong>V{{ candidate.versionNo || candidate.id }}</strong>
                        <em>{{ candidate.status }} · {{ formatDuration(candidate.durationSeconds) }}</em>
                      </span>
                    </button>
                  </div>
                  <p v-else class="fe-control-hint">选择镜头后，这里显示可替换的视频候选。</p>
                </div>
              </div>

              <div v-else-if="activeMaterialPanel === 'audio'" class="fe-bin-panel">
                <div class="fe-bin-audio-stack">
                  <div v-for="group in audioGroups" :key="`bin-audio-${group.key}`" class="fe-bin-audio-row">
                    <div class="fe-bin-audio-title">
                      <strong>{{ group.label }}</strong>
                      <span>{{ group.items.length ? `${group.items.length} 条` : '暂无素材' }}</span>
                    </div>
                    <div class="fe-audio-controls fe-bin-audio-controls">
                      <label class="fe-toggle">
                        <input
                          :checked="group.enabled"
                          :disabled="group.items.length === 0"
                          type="checkbox"
                          @change="updateTrackEnabled(group.key, ($event.target as HTMLInputElement).checked)"
                        />
                        <span>{{ group.enabled ? '开启' : '关闭' }}</span>
                      </label>
                      <label class="fe-volume-control">
                        <span>音量</span>
                        <input
                          :value="group.volume"
                          :disabled="group.items.length === 0"
                          type="range"
                          min="0"
                          max="100"
                          class="fe-range"
                          @input="updateTrackVolume(group.key, Number(($event.target as HTMLInputElement).value))"
                        />
                        <span class="fe-value">{{ group.volume }}%</span>
                      </label>
                    </div>
                  </div>
                </div>
                <div v-if="unmatchedAudioItems.length" class="fe-unmatched-audio">
                  <div class="fe-unmatched-audio-head">
                    <span class="material-symbols-outlined" aria-hidden="true">link_off</span>
                    <strong>待对应画面</strong>
                    <span>{{ unmatchedAudioItems.length }} 条</span>
                  </div>
                  <p>这些对白/旁白已保留，但暂不进入整集播放，避免声音跑到错误镜头。</p>
                  <ul>
                    <li v-for="item in unmatchedAudioItems" :key="`unmatched-audio-${item.id}`">
                      {{ item.title || `${item.trackType} 音频` }} · Scene {{ String(item.sceneNo || '?').padStart(2, '0') }} / {{ item.shotNo || '?' }}
                    </li>
                  </ul>
                </div>

              </div>

              <div v-else-if="activeMaterialPanel === 'text'" class="fe-bin-panel">
                <button class="fe-button fe-button-primary w-full justify-center" type="button" @click="addSubtitleCue">
                  <span class="material-symbols-outlined" aria-hidden="true">add</span>
                  新增字幕
                </button>
                <div v-if="editableSubtitleCues.length" class="fe-bin-subtitle-list">
                  <article v-for="cue in editableSubtitleCues" :key="`bin-subtitle-${cue.cueId}`" class="fe-mini-subtitle-row">
                    <div class="fe-bin-audio-title">
                      <strong>{{ resolveSubtitleCueLabel(cue) }}</strong>
                      <span>{{ cue.enabled ? '启用' : '停用' }}</span>
                    </div>
                    <textarea
                      :value="cue.text"
                      class="fe-control fe-textarea fe-mini-textarea"
                      rows="2"
                      @input="updateSubtitleCue(cue.cueId, { text: ($event.target as HTMLTextAreaElement).value })"
                    ></textarea>
                  </article>
                </div>
                <p v-else class="fe-control-hint">当前没有字幕。启用对白或旁白后，导出前需要补齐有效字幕。</p>
              </div>

              <div v-else class="fe-bin-panel">
                <div class="fe-transition-grid">
                  <button
                    v-for="option in transitionOptions"
                    :key="`bin-transition-${option.value}`"
                    type="button"
                    class="fe-transition-option"
                    :class="selectedVideo?.transition?.type === option.value ? 'fe-transition-option-active' : ''"
                    :disabled="!selectedVideo"
                    @click="selectedVideo && updateSelectedTransition(option.value, selectedVideo.transition?.durationSeconds || 0)"
                  >
                    <span class="material-symbols-outlined" aria-hidden="true">animation</span>
                    {{ option.label }}
                  </button>
                </div>
                <p class="fe-control-hint">转场会写入当前草稿。源素材和候选版本保持不变。</p>
              </div>
            </div>
          </aside>

          <main class="final-edit-scroll">
            <section class="fe-preview-panel">
                <div class="fe-preview-head">
                  <div class="min-w-0">
                    <h2>剪辑画布</h2>
                    <p>
                      {{
                        previewMode === 'program'
                          ? `整集预览 / ${formatDuration(totalTimelineDurationSeconds)}`
                          : selectedVideo
                            ? `${selectedVideo.sceneTitle || '未命名场景'} / ${formatDuration(selectedVideo.durationSeconds)}`
                            : '选择时间线片段后预览'
                      }}
                    </p>
                  </div>
                  <div class="flex items-start gap-2">
                    <div class="fe-preview-mode-switch" role="group" aria-label="预览范围">
                      <button
                        type="button"
                        :class="{ 'fe-preview-mode-active': previewMode === 'program' }"
                        :aria-pressed="previewMode === 'program'"
                        aria-label="整集预览"
                        @click="setPreviewMode('program')"
                      >
                        <span class="material-symbols-outlined" aria-hidden="true">movie</span>
                        整集
                      </button>
                      <button
                        type="button"
                        :class="{ 'fe-preview-mode-active': previewMode === 'clip' }"
                        :aria-pressed="previewMode === 'clip'"
                        aria-label="当前镜头预览"
                        @click="setPreviewMode('clip')"
                      >
                        <span class="material-symbols-outlined" aria-hidden="true">crop_free</span>
                        当前镜头
                      </button>
                    </div>
                    <span class="fe-preview-count">
                      {{ localValidation.enabledVideoCount }} / {{ editableVideoClips.length }}
                    </span>
                  </div>
              </div>

              <div class="fe-preview-frame">
                <video
                  v-if="previewClip && previewClip.sourceType !== 'static'"
                  ref="videoRef"
                  class="aspect-video w-full bg-black object-contain"
                  :src="previewSourceUrl || undefined"
                  :poster="previewClip?.thumbnailUrl || undefined"
                  controls
                  @play="handlePreviewPlay"
                  @pause="handlePreviewPause"
                  @ended="handlePreviewEnded"
                  @loadedmetadata="seekSelectedVideoToTimelinePosition"
                  @timeupdate="handlePreviewTimeUpdate"
                  @volumechange="volume = Math.round(($event.target as HTMLVideoElement).volume * 100)"
                ></video>
                <img
                  v-else
                  class="aspect-video w-full bg-black object-contain"
                  :src="previewClip?.imageUrl || previewClip?.thumbnailUrl || undefined"
                  :alt="previewClip ? resolveShotLabel(previewClip) : 'static frame'"
                />

                <div
                  v-for="clip in activeOverlayClips"
                  :key="`overlay-preview-${clip.clipId}`"
                  class="fe-preview-overlay"
                  :style="overlayPreviewStyle(clip)"
                >
                  <video
                    v-if="overlaySourceClip(clip)?.sourceType !== 'static'"
                    :ref="(element) => setPreviewOverlayElement(clip.clipId, element)"
                    :src="overlaySourceClip(clip)?.videoUrl || undefined"
                    :poster="overlaySourceClip(clip)?.thumbnailUrl || undefined"
                    muted
                    playsinline
                    preload="metadata"
                    @loadedmetadata="syncPreviewOverlaysToTimeline(isPlaying)"
                  ></video>
                  <img
                    v-else
                    :src="overlaySourceClip(clip)?.imageUrl || overlaySourceClip(clip)?.thumbnailUrl || undefined"
                    :alt="`${overlayClipLabel(clip)} 画中画`"
                  />
                  <span class="fe-preview-overlay-tag">画中画 · {{ overlayClipLabel(clip) }}</span>
                </div>

                <audio
                  v-for="entry in audioPreviewEntries"
                  :key="`preview-audio-${entry.trackKey}-${entry.id}`"
                  :ref="(element) => setPreviewAudioElement(entry.id, element)"
                  :src="entry.audioUrl"
                  class="fe-preview-audio"
                  preload="auto"
                  aria-hidden="true"
                  tabindex="-1"
                  @loadedmetadata="syncPreviewAudioToTimeline(isPlaying)"
                ></audio>

                <div
                  v-if="activePreviewSubtitleCues.length"
                  class="fe-preview-subtitles"
                  aria-live="polite"
                >
                  <span v-for="cue in activePreviewSubtitleCues" :key="`preview-subtitle-${cue.cueId}`">
                    {{ cue.text }}
                  </span>
                </div>

                <div class="fe-preview-tag">
                  {{
                    previewMode === 'program'
                      ? `整集 · ${previewClip ? `Scene ${String(previewClip.sceneNo).padStart(2, '0')} / ${resolveShotLabel(previewClip)}` : '暂无片段'}`
                      : previewClip
                        ? `Scene ${String(previewClip.sceneNo).padStart(2, '0')} / ${resolveShotLabel(previewClip)}`
                        : '暂无选中片段'
                  }}
                </div>
                <div
                  v-if="previewClip && previewClip.enabled === false"
                  class="fe-preview-tag fe-preview-tag-warning"
                >
                  当前片段已禁用
                </div>
              </div>

              <div class="fe-preview-footer">
                <div class="flex min-w-0 items-center gap-3">
                  <button
                    v-if="previewMode === 'program'"
                    class="fe-preview-nav-button material-symbols-outlined"
                    type="button"
                    aria-label="上一镜"
                    :disabled="previewClipIndex <= 0"
                    @click="moveProgramPlayback(-1)"
                  >
                    skip_previous
                  </button>
                  <button
                    class="fe-play-button material-symbols-outlined"
                    type="button"
                    :aria-label="isPlaying ? '暂停整集预览' : previewMode === 'program' ? '播放整集' : '播放当前镜头'"
                    @click="togglePlay"
                  >
                    {{ isPlaying ? 'pause_circle' : 'play_circle' }}
                  </button>
                  <button
                    v-if="previewMode === 'program'"
                    class="fe-preview-nav-button material-symbols-outlined"
                    type="button"
                    aria-label="下一镜"
                    :disabled="previewClipIndex < 0 || previewClipIndex >= localValidation.enabledVideoCount - 1"
                    @click="moveProgramPlayback(1)"
                  >
                    skip_next
                  </button>

                  <div class="min-w-0 text-sm text-on-surface-variant">
                    <p class="truncate font-medium text-on-surface">
                      {{ previewMode === 'program' ? '整集预览' : previewClip?.sceneTitle || '请先选择一个视频片段' }}
                    </p>
                    <p class="truncate text-xs">
                      {{
                        previewClip
                          ? `${resolveShotLabel(previewClip)} / ${formatDuration(previewClip.durationSeconds)}`
                          : '暂无可播放片段'
                      }}
                    </p>
                  </div>
                </div>

                <div class="fe-preview-timecode" aria-live="off">
                  <strong>{{ formatTimecode(timelinePositionSeconds) }}</strong>
                  <span>/</span>
                  <span>{{ formatTimecode(totalTimelineDurationSeconds) }}</span>
                </div>

                <div class="fe-preview-sync-state" :class="{ 'fe-preview-sync-state-muted': !audioPreviewEntries.length }">
                  <span class="material-symbols-outlined" aria-hidden="true">
                    {{ audioPreviewEntries.length ? 'volume_up' : 'volume_off' }}
                  </span>
                  <span>{{ audioPreviewEntries.length ? '音画预览' : '暂无音频' }}</span>
                </div>

                <label class="fe-inline-control text-sm text-on-surface-variant">
                  <span>预览音量</span>
                  <input
                    v-model.number="volume"
                    type="range"
                    min="0"
                    max="100"
                    class="fe-range w-32"
                    @input="onVolumeChange"
                  />
                  <span>{{ volume }}%</span>
                </label>
              </div>
            </section>

            <section class="fe-section fe-timeline-dock">
              <div
                class="fe-timeline-resize-handle"
                role="separator"
                aria-label="调整时间线高度"
                aria-orientation="horizontal"
                @pointerdown="startTimelineResize"
              >
                <span></span>
              </div>
              <div class="fe-section-heading">
                <div>
                  <h2>时间线</h2>
                  <p class="fe-section-description">
                    共 {{ editableVideoClips.length }} 个片段 / 启用 {{ localValidation.enabledVideoCount }} 个 / {{ formatDuration(totalTimelineDurationSeconds) }} · {{ audioGroups.length + 2 }} 条轨道
                  </p>
                </div>
                <div class="fe-timeline-toolbar" role="toolbar" aria-label="时间线工具">
                  <button
                    class="fe-icon-button"
                    type="button"
                    aria-label="缩小时间线"
                    :disabled="timelinePixelsPerSecond <= 36"
                    @click="adjustTimelineZoom(-12)"
                  >
                    <span class="material-symbols-outlined" aria-hidden="true">remove</span>
                  </button>
                  <label class="fe-timeline-zoom">
                    <span>缩放</span>
                    <input
                      :value="timelinePixelsPerSecond"
                      type="range"
                      min="36"
                      max="220"
                      step="4"
                      aria-label="时间线缩放"
                      @input="setTimelineZoom(Number(($event.target as HTMLInputElement).value))"
                    />
                    <strong>{{ timelineZoomPercent }}%</strong>
                  </label>
                  <button
                    class="fe-icon-button"
                    type="button"
                    aria-label="放大时间线"
                    :disabled="timelinePixelsPerSecond >= 220"
                    @click="adjustTimelineZoom(12)"
                  >
                    <span class="material-symbols-outlined" aria-hidden="true">add</span>
                  </button>
                  <button
                    class="fe-icon-button"
                    :class="{ 'fe-icon-button-active': timelineSnapEnabled }"
                    type="button"
                    :aria-pressed="timelineSnapEnabled"
                    aria-label="切换时间线吸附"
                    @click="toggleTimelineSnap"
                  >
                    <span class="material-symbols-outlined" aria-hidden="true">magnet</span>
                  </button>
                  <button class="fe-icon-button" type="button" :disabled="!canUndo" aria-label="撤销" @click="undoEdit">
                    <span class="material-symbols-outlined" aria-hidden="true">undo</span>
                  </button>
                  <button class="fe-icon-button" type="button" :disabled="!canRedo" aria-label="重做" @click="redoEdit">
                    <span class="material-symbols-outlined" aria-hidden="true">redo</span>
                  </button>
                  <button class="fe-icon-button" type="button" :disabled="!selectedVideo" aria-label="在播放头处分割当前片段" @click="splitSelectedClip">
                    <span class="material-symbols-outlined" aria-hidden="true">content_cut</span>
                  </button>
                  <button class="fe-icon-button" type="button" :disabled="isSaving" aria-label="保存版本" @click="createVersionSnapshot('人工检查点')">
                    <span class="material-symbols-outlined" aria-hidden="true">bookmark_add</span>
                  </button>
                  <button class="fe-button fe-button-primary" type="button" :disabled="isSaving" @click="handleSaveDraft()">
                    <span class="material-symbols-outlined" aria-hidden="true">{{ isSaving ? 'progress_activity' : 'save' }}</span>
                    {{ isSaving ? '保存中' : isDirty ? '保存草稿' : '已保存' }}
                  </button>
                </div>
              </div>

              <div class="fe-edit-timeline">
                <div class="fe-timeline-scroll-body">
                  <div class="fe-edit-ruler" :style="{ width: `${timelineCanvasWidthPx}px` }">
                  <span class="fe-edit-ruler-label">时间</span>
                  <div
                    class="fe-edit-ruler-track"
                    :style="{ width: `${timelineTrackWidthPx}px` }"
                    role="slider"
                    aria-label="时间线播放位置"
                    :aria-valuemin="0"
                    :aria-valuemax="totalTimelineDurationSeconds"
                    :aria-valuenow="timelinePositionSeconds"
                    :aria-valuetext="`${formatTimecode(timelinePositionSeconds)} / ${formatTimecode(totalTimelineDurationSeconds)}`"
                    tabindex="0"
                    @pointerdown="onTimelinePointerDown"
                    @pointermove="onTimelinePointerMove"
                    @pointerup="onTimelinePointerUp"
                    @pointercancel="onTimelinePointerUp"
                    @keydown="onTimelineKeydown"
                  >
                    <span
                      v-for="tick in timelineTicks"
                      :key="`timeline-tick-${tick.seconds}`"
                      class="fe-ruler-tick"
                      :style="{ left: timelinePercent(tick.seconds) }"
                    >
                      <i></i>
                      <em>{{ tick.label }}</em>
                    </span>
                  </div>
                  </div>

                  <div
                    class="fe-edit-track-stack"
                    :style="{ width: `${timelineCanvasWidthPx}px` }"
                    @pointerdown="onTimelinePointerDown"
                    @pointermove="onTimelinePointerMove"
                    @pointerup="onTimelinePointerUp"
                    @pointercancel="onTimelinePointerUp"
                  >
                  <div
                    class="fe-timeline-playhead"
                    :style="timelinePlayheadStyle"
                    aria-hidden="true"
                  >
                    <span>{{ formatTimecode(timelinePositionSeconds) }}</span>
                    <i></i>
                  </div>

                  <div class="fe-edit-row fe-edit-row-overlay">
                  <div class="fe-edit-track-label">
                    <strong>V2</strong>
                    <span>画中画</span>
                  </div>
                  <div
                    ref="timelineOverlayLaneRef"
                    class="fe-edit-lane fe-edit-lane-overlay"
                    :class="{ 'fe-edit-lane-dropping': overlayDropActive }"
                    @dragover="onOverlayLaneDragOver"
                    @dragleave="onOverlayLaneDragLeave"
                    @drop="onOverlayLaneDrop"
                  >
                    <button
                      v-for="clip in overlayClips"
                      :key="clip.clipId"
                      type="button"
                      class="fe-edit-clip fe-edit-clip-overlay"
                      :class="{
                        'fe-edit-clip-selected': selectedOverlayClipId === clip.clipId,
                        'fe-edit-clip-muted': clip.enabled === false,
                        'fe-edit-clip-dragging': overlayPointerDrag?.clipId === clip.clipId,
                      }"
                      :data-overlay-clip-id="clip.clipId"
                      :style="overlayClipStyle(clip)"
                      @pointerdown="startOverlayPointerDrag($event, clip)"
                    >
                      <span>画中画 · {{ overlayClipLabel(clip) }}</span>
                      <em>{{ formatDuration(clip.durationSeconds) }}</em>
                    </button>
                    <span v-if="overlayClips.length === 0" class="fe-edit-empty">
                      把素材库卡片拖到这里做画中画
                    </span>
                  </div>
                  </div>

                  <div class="fe-edit-row fe-edit-row-main">
                  <div class="fe-edit-track-label">
                    <strong>V1</strong>
                    <span>画面</span>
                  </div>
                  <div
                    ref="timelineMainLaneRef"
                    class="fe-edit-lane"
                    :class="{
                      'fe-edit-lane-dropping': mainDropIndex != null,
                      'fe-edit-lane-drop-end':
                        mainDropIndex != null && mainDropIndex >= editableVideoClips.length,
                    }"
                    @dragover="onMainLaneDragOver"
                    @dragleave="onMainLaneDragLeave"
                    @drop="onMainLaneDrop"
                  >
                    <button
                      v-for="(clip, clipIndex) in editableVideoClips"
                      :key="clipIdentity(clip)"
                      type="button"
                      class="fe-edit-clip fe-edit-clip-video"
                      :class="{
                        'fe-edit-clip-selected': selectedClipId === clipIdentity(clip),
                        'fe-edit-clip-muted': clip.enabled === false,
                        'fe-edit-clip-dragging': clipPointerDrag?.clipId === clipIdentity(clip),
                        'fe-edit-clip-drop-before': mainDropIndex === clipIndex,
                      }"
                      :data-clip-id="clipIdentity(clip)"
                      :style="clip.enabled === false ? { width: '120px' } : videoClipTimelineStyle(clip)"
                      @click="handleTimelineClipClick($event, clip)"
                      @pointerdown.stop="startClipPointerDrag($event, clip)"
                    >
                      <span
                        class="fe-clip-handle fe-clip-handle-start"
                        aria-hidden="true"
                        @pointerdown.stop.prevent="startTrimDrag($event, clip, 'start')"
                      ></span>
                      <span
                        class="fe-clip-handle fe-clip-handle-end"
                        aria-hidden="true"
                        @pointerdown.stop.prevent="startTrimDrag($event, clip, 'end')"
                      ></span>
                      <span>Scene {{ String(clip.sceneNo).padStart(2, '0') }} / {{ resolveShotLabel(clip) }}</span>
                      <em>{{ formatDuration(clip.durationSeconds) }}</em>
                      <small v-if="clip.videoAssetId && clip.videoAssetId !== clip.originalVideoAssetId">替换候选</small>
                      <small v-else-if="clip.trimStartSeconds || clip.durationSeconds !== clipSourceDuration(clip)">已裁切</small>
                      <small v-else>主版本</small>
                    </button>
                    <div class="fe-edit-overlays" aria-hidden="true">
                      <span
                        v-for="marker in beatMarkers"
                        :key="marker.markerId"
                        class="fe-beat-marker"
                        :style="{ left: timelinePixels(marker.atSeconds) }"
                      >
                        {{ marker.label }}
                      </span>
                      <span
                        v-for="point in emotionCurve"
                        :key="point.pointId"
                        class="fe-emotion-point"
                        :style="{ left: timelinePixels(point.atSeconds), bottom: `${Math.max(6, point.intensity * 0.24)}px` }"
                      ></span>
                    </div>
                  </div>
                  </div>

                  <div
                    v-for="group in audioGroups"
                    :key="`track-${group.key}`"
                    class="fe-edit-row"
                  >
                    <div class="fe-edit-track-label">
                      <strong>{{ group.label }}</strong>
                      <span>{{ group.enabled ? `${group.volume}%` : '关闭' }}</span>
                    </div>
                    <div class="fe-edit-lane">
                      <button
                        v-for="item in group.items"
                        :key="`${group.key}-${item.id}`"
                        type="button"
                        class="fe-edit-clip fe-edit-clip-audio"
                        :class="[
                          group.key === 'dialogue' ? 'fe-edit-clip-dialogue' : '',
                          group.key === 'narration' ? 'fe-edit-clip-narration' : '',
                          group.key === 'music' ? 'fe-edit-clip-music' : '',
                          group.key === 'sfx' ? 'fe-edit-clip-sfx' : '',
                          item.enabled === false || !group.enabled ? 'fe-edit-clip-muted' : '',
                        ]"
                        :style="audioClipTimelineStyle(item)"
                        @click="item.storyboardId && selectStoryboardAtPointer($event, item.storyboardId)"
                      >
                        <span>{{ item.title }}</span>
                        <em>{{ formatSignedSeconds(item.startOffsetSeconds) }}</em>
                      </button>
                      <span v-if="group.items.length === 0" class="fe-edit-empty">暂无音频</span>
                    </div>
                  </div>

                  <div class="fe-edit-row">
                    <div class="fe-edit-track-label">
                      <strong>字幕</strong>
                      <span>{{ enabledSubtitleCueCount }} 条</span>
                    </div>
                    <div class="fe-edit-lane">
                      <button
                        v-for="cue in editableSubtitleCues"
                        :key="cue.cueId"
                        type="button"
                        class="fe-edit-clip fe-edit-clip-subtitle"
                        :class="{ 'fe-edit-clip-muted': cue.enabled === false }"
                        :style="subtitleTimelineStyle(cue)"
                        @click="selectStoryboardAtPointer($event, cue.storyboardId)"
                      >
                        <span>{{ cue.text || '空字幕' }}</span>
                        <em>{{ formatDuration(cue.durationSeconds) }}</em>
                      </button>
                      <span v-if="editableSubtitleCues.length === 0" class="fe-edit-empty">暂无字幕</span>
                    </div>
                  </div>
                  </div>
                </div>
              </div>
            </section>

            <section class="fe-section">
              <div class="fe-section-heading">
                <div>
                  <p class="fe-section-label">Audio mix</p>
                  <h2>音频轨控制</h2>
                </div>
                <p class="fe-section-meta">
                  可用音频轨 {{ localValidation.availableAudioTrackCount }} / 已启用 {{ localValidation.enabledAudioTrackCount }}
                </p>
              </div>

              <div class="fe-audio-list">
                <div
                  v-for="group in audioGroups"
                  :key="group.key"
                  class="fe-audio-row"
                >
                  <div class="fe-audio-head">
                    <div class="flex min-w-0 items-center gap-3">
                      <span class="fe-audio-name" :class="group.tone">
                        {{ group.label }}
                      </span>
                      <span class="truncate text-xs text-on-surface-variant">
                        {{ group.items.length ? `${group.items.length} 条已确认音频` : '当前还没有已确认音频' }}
                      </span>
                    </div>

                    <div class="fe-audio-controls">
                      <label class="fe-toggle">
                        <input
                          :checked="group.enabled"
                          :disabled="group.items.length === 0"
                          type="checkbox"
                          @change="updateTrackEnabled(group.key, ($event.target as HTMLInputElement).checked)"
                        />
                        <span>{{ group.enabled ? '开启' : '关闭' }}</span>
                      </label>

                      <label class="fe-volume-control">
                        <span class="text-xs text-on-surface-variant">音量</span>
                        <input
                          :value="group.volume"
                          :disabled="group.items.length === 0"
                          type="range"
                          min="0"
                          max="100"
                          class="fe-range w-24"
                          @input="updateTrackVolume(group.key, Number(($event.target as HTMLInputElement).value))"
                        />
                        <span class="fe-value">{{ group.volume }}%</span>
                      </label>
                    </div>
                  </div>

                  <div v-if="group.items.length" class="fe-audio-clips">
                    <div
                      v-for="item in group.items"
                      :key="item.id"
                      class="fe-audio-clip"
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

            <section class="fe-section">
              <div class="fe-section-heading">
                <div>
                  <p class="fe-section-label">Subtitles</p>
                  <h2>字幕时间线</h2>
                  <p class="fe-section-description">
                    {{ enabledSubtitleCueCount }} 条有效字幕将写入本次成片的 SRT 文件。
                  </p>
                </div>
                <button
                  class="fe-button fe-button-quiet"
                  type="button"
                  @click="addSubtitleCue"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">add</span>
                  新增字幕
                </button>
              </div>

              <div v-if="editableSubtitleCues.length === 0" class="fe-empty-state">
                当前没有字幕。启用对白或旁白后，导出前必须补充有效字幕。
              </div>

              <div v-else class="fe-subtitle-list">
                <article
                  v-for="cue in editableSubtitleCues"
                  :key="cue.cueId"
                  class="fe-subtitle-row"
                >
                  <div class="fe-subtitle-head">
                    <div class="min-w-0">
                      <p class="fe-subtitle-index">{{ String(editableSubtitleCues.indexOf(cue) + 1).padStart(2, '0') }}</p>
                      <p class="truncate text-sm font-semibold text-on-surface">{{ resolveSubtitleCueLabel(cue) }}</p>
                    </div>
                    <label class="fe-toggle">
                      <input
                        :checked="cue.enabled"
                        type="checkbox"
                        @change="updateSubtitleCue(cue.cueId, { enabled: ($event.target as HTMLInputElement).checked })"
                      />
                      <span>{{ cue.enabled ? '启用' : '停用' }}</span>
                    </label>
                  </div>

                  <div class="fe-subtitle-fields">
                    <label class="fe-field-group fe-field-wide">
                      <span>绑定镜头</span>
                      <div class="fe-control-wrap">
                        <span class="material-symbols-outlined" aria-hidden="true">movie</span>
                        <select
                          :value="cue.storyboardId"
                          class="fe-control"
                          @change="updateSubtitleCue(cue.cueId, { storyboardId: Number(($event.target as HTMLSelectElement).value) })"
                        >
                          <option
                            v-for="clip in editableVideoClips.filter((item) => item.enabled !== false)"
                            :key="clip.storyboardId"
                            :value="clip.storyboardId"
                          >
                            Scene {{ String(clip.sceneNo).padStart(2, '0') }} / {{ resolveShotLabel(clip) }}
                          </option>
                        </select>
                      </div>
                    </label>
                    <label class="fe-field-group">
                      <span>入点秒数</span>
                      <div class="fe-control-wrap">
                        <span class="material-symbols-outlined" aria-hidden="true">login</span>
                        <input
                          :value="cue.startOffsetSeconds"
                          class="fe-control fe-number-control"
                          min="0"
                          step="0.1"
                          type="number"
                          @input="updateSubtitleCue(cue.cueId, { startOffsetSeconds: Number(($event.target as HTMLInputElement).value) })"
                        />
                        <em>s</em>
                      </div>
                    </label>
                    <label class="fe-field-group">
                      <span>显示秒数</span>
                      <div class="fe-control-wrap">
                        <span class="material-symbols-outlined" aria-hidden="true">schedule</span>
                        <input
                          :value="cue.durationSeconds"
                          class="fe-control fe-number-control"
                          min="0.25"
                          step="0.1"
                          type="number"
                          @input="updateSubtitleCue(cue.cueId, { durationSeconds: Number(($event.target as HTMLInputElement).value) })"
                        />
                        <em>s</em>
                      </div>
                    </label>
                  </div>

                  <label class="fe-field-group fe-textarea-group">
                    <span>字幕文本</span>
                    <textarea
                      :value="cue.text"
                      class="fe-control fe-textarea"
                      rows="2"
                      @input="updateSubtitleCue(cue.cueId, { text: ($event.target as HTMLTextAreaElement).value })"
                    ></textarea>
                  </label>
                </article>
              </div>
            </section>

          </main>

          <aside class="final-edit-inspector" aria-label="剪辑检查面板">
            <div class="final-edit-inspector-scroll">
              <section class="fe-inspector-section fe-inspector-selected">
                <div class="fe-inspector-titleline">
                  <div class="min-w-0">
                    <h2>
                      {{
                        selectedVideo
                          ? `${resolveShotLabel(selectedVideo)} / Scene ${String(selectedVideo.sceneNo).padStart(2, '0')}`
                          : '未选中片段'
                      }}
                    </h2>
                  </div>
                  <span
                    v-if="selectedVideo"
                    class="fe-clip-badge"
                    :class="selectedVideo.enabled === false ? 'fe-clip-badge-muted' : ''"
                  >
                    {{ selectedVideo.enabled === false ? '停用' : '启用' }}
                  </span>
                </div>

                <nav class="fe-inspector-tabs" aria-label="片段属性分类">
                  <button
                    type="button"
                    class="fe-inspector-tab"
                    :class="activeInspectorTab === 'picture' ? 'fe-inspector-tab-active' : ''"
                    @click="activeInspectorTab = 'picture'"
                  >
                    画面
                  </button>
                  <button
                    type="button"
                    class="fe-inspector-tab"
                    :class="activeInspectorTab === 'audio' ? 'fe-inspector-tab-active' : ''"
                    @click="activeInspectorTab = 'audio'"
                  >
                    声音
                  </button>
                  <button
                    type="button"
                    class="fe-inspector-tab"
                    :class="activeInspectorTab === 'subtitle' ? 'fe-inspector-tab-active' : ''"
                    @click="activeInspectorTab = 'subtitle'"
                  >
                    字幕
                  </button>
                  <button
                    type="button"
                    class="fe-inspector-tab"
                    :class="activeInspectorTab === 'review' ? 'fe-inspector-tab-active' : ''"
                    @click="activeInspectorTab = 'review'"
                  >
                    质检
                  </button>
                  <button
                    type="button"
                    class="fe-inspector-tab"
                    :class="activeInspectorTab === 'versions' ? 'fe-inspector-tab-active' : ''"
                    @click="activeInspectorTab = 'versions'"
                  >
                    版本
                  </button>
                </nav>

                <div v-if="selectedVideo" class="fe-inspector-stack">
                  <div class="fe-inspector-meta fe-inspector-meta-tight">
                    <div>
                      <span>场景</span>
                      <strong>{{ selectedVideo.sceneTitle || '暂无' }}</strong>
                    </div>
                    <div>
                      <span>版本</span>
                      <strong>V{{ selectedVideo.versionNo || 0 }} · #{{ selectedVideo.videoAssetId || selectedVideo.id || 'static' }}</strong>
                    </div>
                    <div>
                      <span>源时长</span>
                      <strong>{{ formatDuration(clipSourceDuration(selectedVideo)) }}</strong>
                    </div>
                    <div>
                      <span>有效时长</span>
                      <strong>{{ formatDuration(selectedVideo.durationSeconds) }}</strong>
                    </div>
                  </div>

                  <div v-if="selectedOverlayClip" class="fe-control-card fe-overlay-card">
                    <div class="fe-control-card-head">
                      <strong>画中画 · {{ overlayClipLabel(selectedOverlayClip) }}</strong>
                      <span>仅预览</span>
                    </div>
                    <div class="fe-trim-grid">
                      <label class="fe-field-group">
                        <span>起点</span>
                        <div class="fe-control-wrap">
                          <input
                            class="fe-control fe-number-control"
                            type="number"
                            min="0"
                            step="0.1"
                            :value="selectedOverlayClip.startSeconds"
                            @input="updateOverlayClip(selectedOverlayClip.clipId, { startSeconds: Math.max(0, Number(($event.target as HTMLInputElement).value) || 0) })"
                          />
                          <em>s</em>
                        </div>
                      </label>
                      <label class="fe-field-group">
                        <span>时长</span>
                        <div class="fe-control-wrap">
                          <input
                            class="fe-control fe-number-control"
                            type="number"
                            min="0.25"
                            step="0.1"
                            :value="selectedOverlayClip.durationSeconds"
                            @input="updateOverlayClip(selectedOverlayClip.clipId, { durationSeconds: Math.max(0.25, Number(($event.target as HTMLInputElement).value) || 0.25) })"
                          />
                          <em>s</em>
                        </div>
                      </label>
                    </div>
                    <label class="fe-field-group">
                      <span>位置</span>
                      <select
                        class="fe-control"
                        :value="selectedOverlayClip.position"
                        @change="updateOverlayClip(selectedOverlayClip.clipId, { position: ($event.target as HTMLSelectElement).value as OverlayPosition })"
                      >
                        <option v-for="option in overlayPositionOptions" :key="option.value" :value="option.value">
                          {{ option.label }}
                        </option>
                      </select>
                    </label>
                    <label class="fe-inline-control">
                      <span>缩放 {{ Math.round(selectedOverlayClip.scale * 100) }}%</span>
                      <input
                        class="fe-range"
                        type="range"
                        min="10"
                        max="100"
                        step="1"
                        :value="Math.round(selectedOverlayClip.scale * 100)"
                        @input="updateOverlayClip(selectedOverlayClip.clipId, { scale: Number(($event.target as HTMLInputElement).value) / 100 })"
                      />
                    </label>
                    <label class="fe-inline-control">
                      <span>不透明度 {{ selectedOverlayClip.opacity }}%</span>
                      <input
                        class="fe-range"
                        type="range"
                        min="0"
                        max="100"
                        step="1"
                        :value="selectedOverlayClip.opacity"
                        @input="updateOverlayClip(selectedOverlayClip.clipId, { opacity: Number(($event.target as HTMLInputElement).value) })"
                      />
                    </label>
                    <div class="fe-overlay-actions">
                      <label class="fe-toggle">
                        <input
                          type="checkbox"
                          :checked="selectedOverlayClip.enabled !== false"
                          @change="updateOverlayClip(selectedOverlayClip.clipId, { enabled: ($event.target as HTMLInputElement).checked })"
                        />
                        <span>参与预览</span>
                      </label>
                      <button
                        class="fe-button fe-button-quiet"
                        type="button"
                        @click="removeOverlayClip(selectedOverlayClip.clipId)"
                      >
                        移除画中画
                      </button>
                    </div>
                    <p class="fe-control-hint">
                      画中画只在编辑器预览里合成，导出合成尚未接入；移除或停用都不会改动原始素材。
                    </p>
                  </div>

                  <div v-show="activeInspectorTab === 'picture'" class="fe-control-card">
                    <div class="fe-control-card-head">
                      <strong>镜头裁切</strong>
                      <span>非破坏式</span>
                    </div>
                    <div class="fe-trim-grid">
                      <label class="fe-field-group">
                        <span>入点</span>
                        <div class="fe-control-wrap">
                          <span class="fe-control-tag" aria-hidden="true">IN</span>
                          <input
                            :value="selectedVideo.trimStartSeconds || 0"
                            class="fe-control fe-number-control"
                            min="0"
                            :max="Math.max(0, Number(selectedVideo.trimEndSeconds || clipSourceDuration(selectedVideo)) - 0.25)"
                            step="0.1"
                            type="number"
                            @input="updateSelectedTrim('start', Number(($event.target as HTMLInputElement).value))"
                          />
                          <em>s</em>
                        </div>
                      </label>
                      <label class="fe-field-group">
                        <span>出点</span>
                        <div class="fe-control-wrap">
                          <span class="fe-control-tag" aria-hidden="true">OUT</span>
                          <input
                            :value="selectedVideo.trimEndSeconds || clipSourceDuration(selectedVideo)"
                            class="fe-control fe-number-control"
                            :min="Math.max(0.25, Number(selectedVideo.trimStartSeconds || 0) + 0.25)"
                            :max="clipSourceDuration(selectedVideo)"
                            step="0.1"
                            type="number"
                            @input="updateSelectedTrim('end', Number(($event.target as HTMLInputElement).value))"
                          />
                          <em>s</em>
                        </div>
                      </label>
                    </div>
                    <div class="fe-trim-bar" aria-hidden="true">
                      <span
                        class="fe-trim-window"
                        :style="{
                          left: percentOf(Number(selectedVideo.trimStartSeconds || 0), clipSourceDuration(selectedVideo)),
                          width: percentOf(selectedVideo.durationSeconds, clipSourceDuration(selectedVideo)),
                        }"
                      ></span>
                    </div>
                    <p class="fe-control-hint">
                      裁切只保存到成片草稿，源视频和候选历史不会被覆盖。
                    </p>
                  </div>

                  <div v-show="activeInspectorTab === 'picture'" class="fe-control-card fe-cut-card">
                    <div class="fe-control-card-head">
                      <strong>切分与转场</strong>
                      <span>当前片段</span>
                    </div>
                    <button
                      class="fe-button fe-button-primary w-full justify-center"
                      type="button"
                      @click="splitSelectedClip"
                    >
                      <span class="material-symbols-outlined" aria-hidden="true">content_cut</span>
                      在播放头处分割
                    </button>
                    <p class="fe-control-hint fe-split-hint">
                      播放头：{{ formatTimecode(timelinePositionSeconds) }}。两侧至少保留 0.25 秒。
                    </p>
                    <div class="fe-mini-fields">
                      <label class="fe-field-group">
                        <span>转场</span>
                        <select
                          :value="selectedVideo.transition?.type || 'cut'"
                          class="fe-control"
                          @change="updateSelectedTransition(($event.target as HTMLSelectElement).value as TransitionType, selectedVideo.transition?.durationSeconds || 0)"
                        >
                          <option
                            v-for="option in transitionOptions"
                            :key="option.value"
                            :value="option.value"
                          >
                            {{ option.label }}
                          </option>
                        </select>
                      </label>
                      <label class="fe-field-group">
                        <span>持续</span>
                        <div class="fe-control-wrap">
                          <input
                            :value="selectedVideo.transition?.durationSeconds || 0"
                            class="fe-control fe-number-control"
                            min="0"
                            max="2"
                            step="0.1"
                            type="number"
                            @input="updateSelectedTransition((selectedVideo.transition?.type || 'cut') as TransitionType, Number(($event.target as HTMLInputElement).value))"
                          />
                          <em>s</em>
                        </div>
                      </label>
                    </div>
                    <p class="fe-control-hint">
                      拖拽主时间线片段可以调整顺序；转场只记录到当前草稿，不改素材。
                    </p>
                  </div>

                  <div v-show="activeInspectorTab === 'picture'" class="fe-control-card">
                    <div class="fe-control-card-head">
                      <strong>候选替换</strong>
                      <span>{{ isLoadingVideoCandidates ? '加载中' : `${selectedVideoCandidates.length} 个候选` }}</span>
                    </div>
                    <div v-if="selectedVideoCandidates.length" class="fe-candidate-list">
                      <button
                        v-for="candidate in selectedVideoCandidates"
                        :key="candidate.id"
                        type="button"
                        class="fe-candidate-item"
                        :class="Number(selectedVideo.videoAssetId || selectedVideo.id) === candidate.id ? 'fe-candidate-item-active' : ''"
                        @click="applyVideoCandidate(candidate)"
                      >
                        <img
                          v-if="candidate.thumbnailUrl"
                          :src="candidate.thumbnailUrl"
                          :alt="`候选 V${candidate.versionNo}`"
                        />
                        <span>
                          <strong>V{{ candidate.versionNo || candidate.id }}</strong>
                          <em>{{ candidate.status }} · {{ formatDuration(candidate.durationSeconds) }}</em>
                        </span>
                      </button>
                    </div>
                    <p v-else class="fe-control-hint">
                      当前镜头暂无可替换视频候选。
                    </p>
                  </div>

                  <div v-show="activeInspectorTab === 'audio'" class="fe-control-card">
                    <div class="fe-control-card-head">
                      <strong>声音对齐</strong>
                      <span>{{ selectedAudioGroups.reduce((sum, group) => sum + group.items.length, 0) }} 条</span>
                    </div>
                    <div class="fe-audio-lead-actions">
                      <button class="fe-button fe-button-quiet" type="button" @click="nudgeSelectedAudioLead(-0.25)">
                        <span class="material-symbols-outlined" aria-hidden="true">keyboard_double_arrow_left</span>
                        声音先入 0.25s
                      </button>
                      <button class="fe-button fe-button-quiet" type="button" @click="nudgeSelectedAudioLead(0.25)">
                        <span class="material-symbols-outlined" aria-hidden="true">keyboard_double_arrow_right</span>
                        延后 0.25s
                      </button>
                    </div>
                    <div v-if="selectedAudioGroups.length" class="fe-mini-track-list">
                      <div
                        v-for="group in selectedAudioGroups"
                        :key="`selected-${group.key}`"
                        class="fe-mini-track"
                      >
                        <div class="fe-mini-track-title">
                          <strong>{{ group.label }}</strong>
                          <span>{{ group.enabled ? '轨道开启' : '轨道关闭' }}</span>
                        </div>
                        <div
                          v-for="item in group.items"
                          :key="item.id"
                          class="fe-mini-audio-row"
                        >
                          <label class="fe-toggle">
                            <input
                              :checked="item.enabled !== false"
                              type="checkbox"
                              @change="updateAudioClip(group.key, item.id, { enabled: ($event.target as HTMLInputElement).checked })"
                            />
                            <span>{{ item.title }}</span>
                          </label>
                          <div class="fe-mini-fields">
                            <label class="fe-field-group">
                              <span>起始偏移</span>
                              <div class="fe-control-wrap">
                                <input
                                  :value="item.startOffsetSeconds || 0"
                                  class="fe-control fe-number-control"
                                  min="-5"
                                  step="0.1"
                                  type="number"
                                  @input="updateAudioClip(group.key, item.id, { startOffsetSeconds: Number(($event.target as HTMLInputElement).value) })"
                                />
                                <em>s</em>
                              </div>
                            </label>
                            <label class="fe-field-group">
                              <span>片段音量</span>
                              <div class="fe-control-wrap">
                                <input
                                  :value="item.volume ?? 100"
                                  class="fe-control fe-number-control"
                                  min="0"
                                  max="100"
                                  step="1"
                                  type="number"
                                  @input="updateAudioClip(group.key, item.id, { volume: Number(($event.target as HTMLInputElement).value) })"
                                />
                                <em>%</em>
                              </div>
                            </label>
                          </div>
                        </div>
                      </div>
                    </div>
                    <p v-else class="fe-control-hint">
                      当前镜头暂无绑定声音，BGM/SFX 可以在音频区继续加入。
                    </p>
                  </div>

                  <div v-show="activeInspectorTab === 'subtitle'" class="fe-control-card">
                    <div class="fe-control-card-head">
                      <strong>字幕微调</strong>
                      <span>{{ selectedSubtitleCues.length }} 条</span>
                    </div>
                    <div v-if="selectedSubtitleCues.length" class="fe-mini-subtitle-list">
                      <div
                        v-for="cue in selectedSubtitleCues"
                        :key="`selected-sub-${cue.cueId}`"
                        class="fe-mini-subtitle-row"
                      >
                        <label class="fe-toggle">
                          <input
                            :checked="cue.enabled"
                            type="checkbox"
                            @change="updateSubtitleCue(cue.cueId, { enabled: ($event.target as HTMLInputElement).checked })"
                          />
                          <span>烧录</span>
                        </label>
                        <div class="fe-mini-fields">
                          <label class="fe-field-group">
                            <span>入点</span>
                            <div class="fe-control-wrap">
                              <input
                                :value="cue.startOffsetSeconds"
                                class="fe-control fe-number-control"
                                min="0"
                                step="0.1"
                                type="number"
                                @input="updateSubtitleCue(cue.cueId, { startOffsetSeconds: Number(($event.target as HTMLInputElement).value) })"
                              />
                              <em>s</em>
                            </div>
                          </label>
                          <label class="fe-field-group">
                            <span>时长</span>
                            <div class="fe-control-wrap">
                              <input
                                :value="cue.durationSeconds"
                                class="fe-control fe-number-control"
                                min="0.25"
                                step="0.1"
                                type="number"
                                @input="updateSubtitleCue(cue.cueId, { durationSeconds: Number(($event.target as HTMLInputElement).value) })"
                              />
                              <em>s</em>
                            </div>
                          </label>
                        </div>
                        <textarea
                          :value="cue.text"
                          class="fe-control fe-textarea fe-mini-textarea"
                          rows="2"
                          @input="updateSubtitleCue(cue.cueId, { text: ($event.target as HTMLTextAreaElement).value })"
                        ></textarea>
                      </div>
                    </div>
                    <button
                      class="fe-button fe-button-quiet w-full justify-center"
                      type="button"
                      @click="addSubtitleCue"
                    >
                      <span class="material-symbols-outlined" aria-hidden="true">subtitles</span>
                      给当前时间线新增字幕
                    </button>
                  </div>

                  <div v-show="activeInspectorTab === 'review'" class="fe-control-card">
                    <div class="fe-control-card-head">
                      <strong>节拍卡点</strong>
                      <span>{{ selectedBeatMarkers.length }} 个</span>
                    </div>
                    <button class="fe-button fe-button-quiet w-full justify-center" type="button" @click="addBeatMarker">
                      <span class="material-symbols-outlined" aria-hidden="true">add_location_alt</span>
                      添加当前镜头节拍点
                    </button>
                    <div v-if="selectedBeatMarkers.length" class="fe-marker-list">
                      <div v-for="marker in selectedBeatMarkers" :key="marker.markerId" class="fe-marker-row">
                        <input
                          aria-label="节拍点名称"
                          :value="marker.label"
                          class="fe-control"
                          type="text"
                          @input="updateBeatMarker(marker.markerId, { label: ($event.target as HTMLInputElement).value })"
                        />
                        <input
                          aria-label="节拍点时间"
                          :value="marker.atSeconds"
                          class="fe-control fe-number-control"
                          min="0"
                          step="0.1"
                          type="number"
                          @input="updateBeatMarker(marker.markerId, { atSeconds: Number(($event.target as HTMLInputElement).value) })"
                        />
                      </div>
                    </div>
                  </div>

                  <div v-show="activeInspectorTab === 'review'" class="fe-control-card">
                    <div class="fe-control-card-head">
                      <strong>情绪曲线</strong>
                      <span>{{ selectedEmotionPoints.length }} 个</span>
                    </div>
                    <button class="fe-button fe-button-quiet w-full justify-center" type="button" @click="addEmotionPoint">
                      <span class="material-symbols-outlined" aria-hidden="true">show_chart</span>
                      添加情绪点
                    </button>
                    <div v-if="selectedEmotionPoints.length" class="fe-marker-list">
                      <div v-for="point in selectedEmotionPoints" :key="point.pointId" class="fe-marker-row fe-emotion-row">
                        <input
                          aria-label="情绪点名称"
                          :value="point.label"
                          class="fe-control"
                          type="text"
                          @input="updateEmotionPoint(point.pointId, { label: ($event.target as HTMLInputElement).value })"
                        />
                        <input
                          aria-label="情绪强度"
                          :value="point.intensity"
                          class="fe-control fe-number-control"
                          min="0"
                          max="100"
                          step="1"
                          type="number"
                          @input="updateEmotionPoint(point.pointId, { intensity: Number(($event.target as HTMLInputElement).value) })"
                        />
                      </div>
                    </div>
                  </div>

                  <div v-show="activeInspectorTab === 'versions'" class="fe-control-card">
                    <div class="fe-control-card-head">
                      <strong>版本回退</strong>
                      <span>{{ versionHistory.length }} 个</span>
                    </div>
                    <button
                      class="fe-button fe-button-quiet w-full justify-center"
                      type="button"
                      :disabled="!isDirty || isSaving"
                      @click="resetDraft"
                    >
                      <span class="material-symbols-outlined" aria-hidden="true">history</span>
                      恢复到上次保存草稿
                    </button>
                    <div v-if="versionHistory.length" class="fe-version-list">
                      <button
                        v-for="version in versionHistory"
                        :key="version.versionId"
                        class="fe-version-item"
                        type="button"
                        @click="rollbackToVersion(version.versionId)"
                      >
                        <strong>{{ version.label }}</strong>
                        <span>{{ formatDateTime(version.createdAt) }}</span>
                      </button>
                    </div>
                    <p v-else class="fe-control-hint">
                      点击顶部“保存版本”后，这里会出现可回退的剪辑检查点。
                    </p>
                  </div>
                </div>
                <p v-else class="fe-inspector-note">
                  从时间线选择一个镜头后，可以在这里裁切画面、替换候选、对齐声音和微调字幕。
                </p>
              </section>

              <section v-show="activeInspectorTab === 'review'" class="fe-inspector-section">
                <div class="fe-inspector-section-heading">
                  <div>
                    <p class="fe-section-label">Validation</p>
                    <h3>导出检查</h3>
                  </div>
                  <span
                    class="fe-check-state"
                    :class="localValidation.canExport ? 'fe-check-state-good' : 'fe-check-state-blocked'"
                  >
                    {{ localValidation.canExport ? '可导出' : '需处理' }}
                  </span>
                </div>

                <div class="fe-validation-list">
                  <div
                    v-if="localValidation.blockingIssues.length === 0 && localValidation.warningIssues.length === 0"
                    class="fe-validation-item fe-validation-good"
                  >
                    <span class="material-symbols-outlined" aria-hidden="true">check_circle</span>
                    当前成片草稿可以直接进入导出。
                  </div>

                  <div
                    v-for="issue in localValidation.blockingIssues"
                    :key="issue.code"
                    class="fe-validation-item fe-validation-danger"
                  >
                    <span class="material-symbols-outlined" aria-hidden="true">error</span>
                    {{ issue.message }}
                  </div>

                  <div
                    v-for="issue in localValidation.warningIssues"
                    :key="issue.code"
                    class="fe-validation-item fe-validation-warning"
                  >
                    <span class="material-symbols-outlined" aria-hidden="true">warning</span>
                    {{ issue.message }}
                  </div>
                </div>

                <div class="fe-track-summary">
                  <div>
                    <span>对白轨</span>
                    <strong>{{ audioCounts.dialogue }}</strong>
                  </div>
                  <div>
                    <span>旁白轨</span>
                    <strong>{{ audioCounts.narration }}</strong>
                  </div>
                  <div>
                    <span>音乐轨</span>
                    <strong>{{ audioCounts.music }}</strong>
                  </div>
                  <div>
                    <span>音效轨</span>
                    <strong>{{ audioCounts.sfx }}</strong>
                  </div>
                </div>

                <p class="fe-inspector-note">
                  {{
                    hasAudio
                      ? '当前已支持保存项目级成片草稿，导出时会带上当前视频排序、启用状态和音频控制配置。'
                      : '当前还没有已确认音频，成片草稿仍可先保存视频时间线，但建议在导出前补齐音频。'
                  }}
                </p>

                <div class="fe-inspector-actions">
                  <button
                    class="fe-button fe-button-quiet justify-center"
                    type="button"
                    @click="goAudio"
                  >
                    <span class="material-symbols-outlined" aria-hidden="true">tune</span>
                    去完善音频主版本
                  </button>
                  <button
                    class="fe-button fe-button-primary justify-center disabled:opacity-50"
                    type="button"
                    :disabled="!localValidation.canExport"
                    @click="goExport"
                  >
                    <span class="material-symbols-outlined" aria-hidden="true">ios_share</span>
                    保存并进入导出
                  </button>
                </div>
              </section>
            </div>
          </aside>
        </div>
      </div>
    </div>
  </WorkspaceLayout>
</template>

<style scoped>
.final-edit-shell {
  --fe-bg: #111310;
  --fe-surface: #181b18;
  --fe-surface-raised: #1e221e;
  --fe-surface-soft: #151815;
  --fe-line: rgba(164, 132, 84, 0.3);
  --fe-line-soft: rgba(164, 132, 84, 0.16);
  --fe-text: #e7e4dc;
  --fe-muted: #a9aaa2;
  --fe-dim: #777b72;
  --fe-accent: #e8a266;
  --fe-accent-soft: rgba(232, 162, 102, 0.12);
  --fe-danger: #ef8f84;
  --fe-success: #9fc99f;
  color: var(--fe-text);
  background: var(--fe-bg);
}

.final-edit-main {
  min-height: 0;
}

.final-edit-header {
  flex: 0 0 auto;
  padding: 24px 28px 22px;
  border-bottom: 1px solid var(--fe-line-soft);
  background:
    linear-gradient(90deg, rgba(232, 162, 102, 0.06), transparent 44%),
    var(--fe-surface);
}

.final-edit-title-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
}

.final-edit-kicker,
.fe-section-label {
  margin: 0;
  color: var(--fe-accent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.18em;
  line-height: 1.4;
  text-transform: uppercase;
}

.final-edit-header h1 {
  margin: 6px 0 0;
  color: var(--fe-text);
  font-family: 'Noto Sans', sans-serif;
  font-size: clamp(1.65rem, 2.4vw, 2.25rem);
  font-weight: 650;
  letter-spacing: -0.025em;
  line-height: 1.1;
}

.final-edit-subtitle {
  margin: 8px 0 0;
  color: var(--fe-muted);
  font-size: 13px;
  line-height: 1.6;
}

.final-edit-actions,
.fe-audio-controls,
.fe-inspector-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.fe-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  border: 1px solid var(--fe-line);
  border-radius: 7px;
  padding: 0 12px;
  color: var(--fe-text);
  font-size: 12px;
  font-weight: 650;
  line-height: 1;
  transition:
    border-color 180ms ease,
    background-color 180ms ease,
    color 180ms ease,
    transform 180ms ease;
}

.fe-button .material-symbols-outlined {
  font-size: 17px;
}

.fe-button:hover:not(:disabled) {
  border-color: rgba(232, 162, 102, 0.7);
  transform: translateY(-1px);
}

.fe-button:active:not(:disabled) {
  transform: translateY(0);
}

.fe-button:disabled,
.fe-icon-button:disabled {
  cursor: not-allowed;
  opacity: 0.38;
}

.fe-button-quiet {
  background: rgba(255, 255, 255, 0.02);
  color: var(--fe-muted);
}

.fe-button-quiet:hover:not(:disabled) {
  background: rgba(232, 162, 102, 0.08);
  color: var(--fe-text);
}

.fe-button-primary {
  border-color: transparent;
  background: var(--fe-accent);
  color: #21170f;
}

.fe-button-primary:hover:not(:disabled) {
  border-color: transparent;
  background: #f2b47a;
  color: #21170f;
}

.final-edit-status-bar {
  flex: 0 0 auto;
  padding: 12px 28px 16px;
  border-bottom: 1px solid var(--fe-line-soft);
  background: var(--fe-bg);
}

.final-edit-status-bar > div:first-child:not(.final-edit-stats),
.final-edit-status-bar > div:nth-child(2):not(.final-edit-stats) {
  border-radius: 8px;
}

.fe-toast-layer {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 80;
  display: grid;
  width: min(430px, calc(100vw - 32px));
  pointer-events: none;
}

.fe-toast {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-height: 48px;
  border: 1px solid;
  border-radius: 10px;
  padding: 12px 13px;
  box-shadow: 0 16px 38px rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(14px);
  pointer-events: auto;
}

.fe-toast-info {
  border-color: rgba(229, 161, 95, 0.46);
  background: rgba(45, 32, 22, 0.96);
  color: #f0b476;
}

.fe-toast-error {
  border-color: rgba(239, 143, 132, 0.52);
  background: rgba(54, 26, 24, 0.97);
  color: #ffb2a8;
}

.fe-toast-icon {
  flex: 0 0 auto;
  margin-top: 1px;
  font-size: 19px;
}

.fe-toast-message {
  min-width: 0;
  flex: 1;
  color: currentColor;
  font-size: 12px;
  line-height: 1.55;
}

.fe-toast-close {
  display: inline-grid;
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 5px;
  color: currentColor;
  opacity: 0.68;
  transition: background-color 160ms ease, opacity 160ms ease;
}

.fe-toast-close:hover,
.fe-toast-close:focus-visible {
  background: rgba(255, 255, 255, 0.09);
  opacity: 1;
}

.fe-toast-close .material-symbols-outlined {
  font-size: 17px;
}

.fe-toast-enter-active,
.fe-toast-leave-active {
  transition: opacity 180ms ease, transform 180ms ease, filter 180ms ease;
}

.fe-toast-enter-from,
.fe-toast-leave-to {
  opacity: 0;
  transform: translateY(10px);
  filter: blur(4px);
}

.final-edit-stats {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 1px;
  margin-top: 12px;
  overflow: hidden;
  border: 1px solid var(--fe-line-soft);
  background: var(--fe-line-soft);
}

.fe-stat {
  min-width: 0;
  padding: 12px 14px;
  background: var(--fe-surface);
}

.fe-stat p {
  margin: 0;
  color: var(--fe-muted);
  font-size: 11px;
}

.fe-stat strong {
  display: block;
  margin-top: 4px;
  color: var(--fe-text);
  font-size: 20px;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  line-height: 1.1;
}

.final-edit-content {
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(320px, 24vw, 380px);
  align-items: start;
  gap: 20px;
  min-height: 0;
  min-width: 0;
  padding: 22px 28px 48px;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-gutter: stable both-edges;
  scroll-padding-block: 1rem;
  background:
    radial-gradient(circle at 36% 0%, rgba(232, 162, 102, 0.05), transparent 34rem),
    var(--fe-bg);
}

.final-edit-scroll {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 18px;
  min-width: 0;
  overflow: visible;
}

.fe-preview-panel,
.fe-section {
  min-width: 0;
  border: 1px solid var(--fe-line-soft);
  border-radius: 12px;
  background: var(--fe-surface);
}

.fe-preview-panel {
  position: relative;
  padding: 14px;
  border-color: rgba(232, 162, 102, 0.2);
  border-radius: 14px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.035), transparent 42%),
    var(--fe-surface);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.22);
}

.fe-preview-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 2px 2px 12px;
}

.fe-preview-head h2 {
  margin: 0;
  color: var(--fe-text);
  font-size: 18px;
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: 1.25;
}

.fe-preview-head p {
  margin: 5px 0 0;
  max-width: 62ch;
  color: var(--fe-muted);
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.fe-preview-count {
  flex: 0 0 auto;
  border: 1px solid rgba(232, 162, 102, 0.22);
  border-radius: 6px;
  padding: 5px 8px;
  background: rgba(232, 162, 102, 0.08);
  color: var(--fe-accent);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
}

.fe-preview-mode-switch {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.18);
}

.fe-preview-mode-switch button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 28px;
  border: 0;
  border-radius: 5px;
  padding: 0 8px;
  color: var(--fe-dim);
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
  transition: background-color 180ms ease, color 180ms ease;
}

.fe-preview-mode-switch button:hover,
.fe-preview-mode-switch button:focus-visible {
  color: var(--fe-text);
}

.fe-preview-mode-switch button.fe-preview-mode-active {
  background: rgba(232, 162, 102, 0.18);
  color: var(--fe-accent);
}

.fe-preview-mode-switch .material-symbols-outlined {
  font-size: 15px;
}

.fe-preview-frame {
  position: relative;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  background: #080908;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.025),
    0 14px 30px rgba(0, 0, 0, 0.26);
}

.fe-preview-frame video,
.fe-preview-frame img {
  display: block;
  max-height: min(52vh, 560px);
}

.fe-preview-audio {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.fe-preview-subtitles {
  position: absolute;
  right: clamp(18px, 5%, 72px);
  bottom: clamp(22px, 7%, 56px);
  left: clamp(18px, 5%, 72px);
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px 8px;
  pointer-events: none;
  text-align: center;
}

.fe-preview-subtitles span {
  max-width: min(92%, 720px);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 5px;
  padding: 6px 10px;
  background: rgba(0, 0, 0, 0.74);
  color: #fffaf2;
  font-size: clamp(12px, 1.4vw, 18px);
  font-weight: 650;
  line-height: 1.45;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.65);
}

.fe-preview-tag {
  position: absolute;
  top: 12px;
  left: 12px;
  border: 1px solid rgba(232, 162, 102, 0.45);
  border-radius: 5px;
  padding: 5px 8px;
  background: rgba(10, 12, 10, 0.82);
  color: var(--fe-accent);
  font-size: 11px;
  font-weight: 650;
}

.fe-preview-tag-warning {
  right: 12px;
  left: auto;
  border-color: rgba(239, 143, 132, 0.45);
  color: var(--fe-danger);
}

.fe-preview-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 12px 2px 2px;
}

.fe-play-button {
  display: inline-grid;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid var(--fe-line);
  border-radius: 50%;
  color: var(--fe-accent);
  font-size: 25px;
  transition:
    background-color 180ms ease,
    transform 180ms ease;
}

.fe-play-button:hover {
  background: var(--fe-accent-soft);
  transform: scale(1.04);
}

.fe-preview-nav-button {
  display: inline-grid;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid var(--fe-line-soft);
  border-radius: 7px;
  color: var(--fe-muted);
  font-size: 19px;
  transition: background-color 180ms ease, color 180ms ease, border-color 180ms ease;
}

.fe-preview-nav-button:hover:not(:disabled),
.fe-preview-nav-button:focus-visible:not(:disabled) {
  border-color: rgba(232, 162, 102, 0.4);
  background: var(--fe-accent-soft);
  color: var(--fe-accent);
}

.fe-preview-nav-button:disabled {
  cursor: not-allowed;
  opacity: 0.36;
}

.fe-inline-control,
.fe-volume-control {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  white-space: nowrap;
}

.fe-range {
  height: 4px;
  accent-color: var(--fe-accent);
  cursor: pointer;
}

.fe-section {
  padding: 18px;
}

.fe-section-heading,
.fe-inspector-section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.fe-section-heading h2,
.fe-inspector-section-heading h3 {
  margin: 5px 0 0;
  color: var(--fe-text);
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.fe-section-meta,
.fe-section-description {
  margin: 0;
  color: var(--fe-muted);
  font-size: 12px;
  line-height: 1.5;
}

.fe-section-description {
  margin-top: 6px;
}

.fe-edit-timeline {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 7px;
  margin-top: 16px;
  overflow: hidden;
  border: 1px solid var(--fe-line-soft);
  border-radius: 10px;
  padding: 10px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.025), transparent 42%),
    #0d0f0d;
  scrollbar-color: #64503e transparent;
  scrollbar-width: thin;
}

.fe-timeline-scroll-body {
  min-height: 0;
  flex: 1;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-color: #64503e transparent;
  scrollbar-width: thin;
}

.fe-timeline-scroll-body::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.fe-timeline-scroll-body::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: #64503e;
}

.fe-timeline-scroll-body .fe-edit-ruler {
  position: sticky;
  top: 0;
  z-index: 12;
  background: #10120f;
}

.fe-edit-timeline::-webkit-scrollbar {
  height: 6px;
}

.fe-edit-timeline::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: #64503e;
}

.fe-edit-ruler,
.fe-edit-row {
  display: grid;
  grid-template-columns: 92px minmax(760px, 1fr);
  gap: 10px;
  min-width: 880px;
}

.fe-edit-ruler {
  align-items: end;
  min-height: 20px;
  color: var(--fe-dim);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.fe-edit-ruler span:first-child {
  grid-column: 2;
}

.fe-edit-ruler span:last-child {
  grid-column: 2;
  justify-self: end;
}

.fe-edit-track-label {
  display: grid;
  align-content: center;
  min-height: 38px;
  border: 1px solid rgba(255, 255, 255, 0.055);
  border-radius: 7px;
  padding: 7px 9px;
  background: rgba(255, 255, 255, 0.025);
}

.fe-edit-track-label strong {
  color: var(--fe-text);
  font-size: 11px;
  font-weight: 700;
}

.fe-edit-track-label span {
  margin-top: 2px;
  color: var(--fe-dim);
  font-size: 10px;
}

.fe-edit-lane {
  position: relative;
  min-height: 38px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.065);
  border-radius: 7px;
  background:
    repeating-linear-gradient(
      90deg,
      rgba(255, 255, 255, 0.035) 0,
      rgba(255, 255, 255, 0.035) 1px,
      transparent 1px,
      transparent 8.333%
    ),
    rgba(255, 255, 255, 0.018);
}

.fe-edit-overlays {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 3;
}

.fe-beat-marker {
  position: absolute;
  top: 2px;
  max-width: 92px;
  transform: translateX(-1px);
  border-left: 1px solid rgba(232, 190, 119, 0.86);
  padding-left: 5px;
  color: #e8be77;
  font-size: 9px;
  line-height: 1.15;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fe-emotion-point {
  position: absolute;
  width: 7px;
  height: 7px;
  transform: translateX(-50%);
  border: 1px solid rgba(255, 255, 255, 0.42);
  border-radius: 999px;
  background: #ef8f84;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.35);
}

.fe-edit-clip {
  position: absolute;
  z-index: 2;
  top: 5px;
  bottom: 5px;
  display: grid;
  min-width: 72px;
  align-content: center;
  justify-items: start;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 0 8px;
  color: var(--fe-text);
  text-align: left;
  transition:
    border-color 180ms ease,
    box-shadow 180ms ease,
    transform 180ms ease,
    opacity 180ms ease;
}

.fe-clip-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 4;
  display: block !important;
  width: 8px;
  margin: 0 !important;
  padding: 0 !important;
  border: 0;
  border-radius: 0;
  background: rgba(255, 255, 255, 0.08);
  cursor: ew-resize;
  opacity: 0;
  transition: background-color 140ms ease, opacity 140ms ease;
}

.fe-clip-handle-start {
  left: 0;
}

.fe-clip-handle-end {
  right: 0;
}

.fe-edit-clip:hover .fe-clip-handle,
.fe-edit-clip-selected .fe-clip-handle {
  opacity: 1;
}

.fe-clip-handle:hover {
  background: var(--fe-accent);
}

.fe-edit-clip:hover {
  border-color: rgba(232, 162, 102, 0.7);
  transform: translateY(-1px);
}

.fe-edit-clip-video {
  cursor: grab;
}

.fe-edit-clip-video:active {
  cursor: grabbing;
}

.fe-edit-clip-dragging {
  z-index: 5;
  opacity: 0.82;
  transform: translateY(-2px) scale(1.012);
  box-shadow:
    0 0 0 1px rgba(232, 162, 102, 0.7),
    0 12px 22px rgba(0, 0, 0, 0.32);
  cursor: grabbing !important;
}

.fe-edit-clip:focus-visible,
.fe-candidate-item:focus-visible {
  outline: 2px solid var(--fe-accent);
  outline-offset: 2px;
}

.fe-edit-clip span,
.fe-edit-clip em,
.fe-edit-clip small {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fe-edit-clip span {
  font-size: 11px;
  font-weight: 700;
}

.fe-edit-clip em,
.fe-edit-clip small {
  margin-top: 1px;
  color: rgba(255, 255, 255, 0.74);
  font-size: 9px;
  font-style: normal;
}

.fe-edit-clip-video {
  background: linear-gradient(135deg, rgba(232, 162, 102, 0.36), rgba(171, 122, 82, 0.18));
}

.fe-edit-clip-dialogue {
  background: rgba(112, 166, 133, 0.34);
}

.fe-edit-clip-narration {
  background: rgba(120, 166, 206, 0.3);
}

.fe-edit-clip-music {
  background: rgba(185, 152, 112, 0.28);
}

.fe-edit-clip-sfx {
  background: rgba(211, 130, 92, 0.3);
}

.fe-edit-clip-subtitle {
  background: rgba(232, 228, 220, 0.24);
}

.fe-edit-clip-selected {
  border-color: var(--fe-accent);
  box-shadow:
    inset 0 0 0 1px rgba(232, 162, 102, 0.24),
    0 8px 18px rgba(0, 0, 0, 0.22);
}

.fe-edit-clip-muted {
  filter: saturate(0.42);
  opacity: 0.52;
}

.fe-edit-empty {
  display: inline-flex;
  align-items: center;
  height: 100%;
  padding-left: 10px;
  color: var(--fe-dim);
  font-size: 11px;
}

.fe-timeline {
  margin-top: 16px;
  overflow: hidden;
  border: 1px solid var(--fe-line-soft);
  border-radius: 8px;
  background: var(--fe-bg);
}

.fe-timeline-ruler {
  display: flex;
  justify-content: space-between;
  padding: 9px 12px;
  border-bottom: 1px solid var(--fe-line-soft);
  color: var(--fe-dim);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.fe-timeline-track {
  display: flex;
  gap: 8px;
  min-height: 190px;
  overflow-x: auto;
  padding: 10px;
  scrollbar-color: #64503e transparent;
  scrollbar-width: thin;
}

.fe-timeline-track::-webkit-scrollbar,
.fe-audio-clips::-webkit-scrollbar {
  height: 5px;
}

.fe-timeline-track::-webkit-scrollbar-thumb,
.fe-audio-clips::-webkit-scrollbar-thumb {
  background: #64503e;
}

.fe-clip {
  display: flex;
  min-width: 220px;
  flex: 0 0 auto;
  flex-direction: column;
  justify-content: space-between;
  overflow: hidden;
  border: 1px solid var(--fe-line-soft);
  border-radius: 7px;
  padding: 8px;
  background: var(--fe-surface);
  transition:
    border-color 180ms ease,
    background-color 180ms ease,
    transform 180ms ease;
}

.fe-clip:hover {
  border-color: var(--fe-line);
  transform: translateY(-1px);
}

.fe-clip-selected {
  border-color: var(--fe-accent);
  background: var(--fe-accent-soft);
  box-shadow: inset 0 0 0 1px rgba(232, 162, 102, 0.16);
}

.fe-clip-disabled {
  border-color: rgba(239, 143, 132, 0.25);
  background: rgba(239, 143, 132, 0.05);
}

.fe-clip-image {
  display: block;
  width: 100%;
  height: 76px;
  border-radius: 4px;
  object-fit: cover;
  opacity: 0.9;
}

.fe-clip-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  color: var(--fe-dim);
  font-size: 10px;
}

.fe-status {
  display: inline-flex;
  align-items: center;
  border-radius: 3px;
  padding: 3px 5px;
  font-size: 10px;
}

.fe-status-success {
  background: rgba(159, 201, 159, 0.12);
  color: var(--fe-success);
}

.fe-status-danger {
  background: rgba(239, 143, 132, 0.12);
  color: var(--fe-danger);
}

.fe-clip-actions {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 5px;
  margin-top: 9px;
}

.fe-icon-button,
.fe-clip-toggle {
  display: grid;
  min-height: 28px;
  place-items: center;
  border: 1px solid var(--fe-line-soft);
  border-radius: 5px;
  color: var(--fe-muted);
  transition:
    border-color 180ms ease,
    background-color 180ms ease,
    color 180ms ease;
}

.fe-icon-button:hover:not(:disabled),
.fe-clip-toggle:hover {
  border-color: var(--fe-line);
  background: rgba(255, 255, 255, 0.04);
  color: var(--fe-text);
}

.fe-icon-button-active {
  border-color: rgba(229, 161, 95, 0.68);
  background: rgba(229, 161, 95, 0.14);
  color: var(--fe-accent);
}

.fe-icon-button .material-symbols-outlined,
.fe-clip-toggle .material-symbols-outlined {
  font-size: 16px;
}

.fe-clip-toggle-disable {
  color: var(--fe-danger);
}

.fe-clip-toggle-enable {
  color: var(--fe-success);
}

.fe-audio-list,
.fe-subtitle-list {
  display: grid;
  gap: 8px;
  margin-top: 16px;
}

.fe-audio-row,
.fe-subtitle-row {
  border: 1px solid var(--fe-line-soft);
  border-radius: 8px;
  background: var(--fe-bg);
}

.fe-audio-row {
  overflow: hidden;
  padding: 12px;
}

.fe-audio-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.fe-audio-name {
  display: inline-flex;
  align-items: center;
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 4px 7px;
  font-size: 11px;
  font-weight: 650;
}

.fe-toggle {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--fe-muted);
  font-size: 11px;
  white-space: nowrap;
}

.fe-toggle input {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--fe-accent);
}

.fe-value {
  min-width: 35px;
  color: var(--fe-text);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.fe-audio-clips {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  overflow-x: auto;
  padding-bottom: 2px;
}

.fe-audio-clip {
  min-width: 100px;
  flex: 0 0 auto;
  border-radius: 5px;
  padding: 8px;
}

.fe-subtitle-row {
  padding: 14px;
}

.fe-subtitle-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.fe-subtitle-index {
  display: inline-block;
  margin: 0 0 3px;
  color: var(--fe-accent);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.12em;
}

.fe-subtitle-fields {
  display: grid;
  grid-template-columns: minmax(180px, 1.55fr) minmax(120px, 0.7fr) minmax(120px, 0.7fr);
  gap: 10px;
  margin-top: 14px;
}

.fe-field-group {
  display: grid;
  min-width: 0;
  gap: 6px;
}

.fe-field-group > span {
  color: var(--fe-muted);
  font-size: 11px;
  font-weight: 600;
}

.fe-field-wide {
  min-width: 0;
}

.fe-control-wrap {
  display: flex;
  align-items: center;
  min-width: 0;
  border: 1px solid var(--fe-line-soft);
  border-radius: 6px;
  background: var(--fe-surface-soft);
  transition:
    border-color 180ms ease,
    background-color 180ms ease;
}

.fe-control-wrap:focus-within {
  border-color: var(--fe-accent);
  background: var(--fe-surface-raised);
  box-shadow: 0 0 0 2px rgba(232, 162, 102, 0.1);
}

.fe-control-wrap > .material-symbols-outlined {
  flex: 0 0 auto;
  margin-left: 9px;
  color: var(--fe-dim);
  font-size: 16px;
}

.fe-control-tag {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  min-width: 34px;
  height: 20px;
  margin-left: 9px;
  border: 1px solid rgba(232, 162, 102, 0.24);
  border-radius: 4px;
  color: var(--fe-accent);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.fe-control-wrap em {
  margin-right: 9px;
  color: var(--fe-dim);
  font-size: 11px;
  font-style: normal;
}

.fe-control,
.fe-control-wrap .fe-control {
  width: 100%;
  min-width: 0;
  height: 38px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--fe-text);
  font: inherit;
  font-size: 12px;
}

.fe-control {
  border: 1px solid var(--fe-line-soft);
  border-radius: 6px;
  padding: 0 10px;
  background: var(--fe-surface-soft);
}

.fe-control-wrap .fe-control {
  border-radius: 6px;
  padding: 0 8px;
}

.fe-control option {
  background: #20231f;
  color: var(--fe-text);
}

.fe-number-control {
  font-variant-numeric: tabular-nums;
}

.fe-textarea-group {
  margin-top: 12px;
}

.fe-textarea {
  min-height: 76px;
  resize: vertical;
  padding: 10px;
  line-height: 1.65;
}

.fe-empty-state {
  margin-top: 16px;
  border: 1px dashed var(--fe-line);
  border-radius: 7px;
  padding: 18px;
  color: var(--fe-muted);
  font-size: 12px;
  line-height: 1.6;
}

.fe-file-control {
  height: auto;
  min-height: 38px;
  padding: 8px 10px;
}

.fe-file-control::file-selector-button {
  margin-right: 8px;
  border: 1px solid var(--fe-line);
  border-radius: 4px;
  padding: 5px 8px;
  background: var(--fe-accent-soft);
  color: var(--fe-accent);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
}

.final-edit-inspector {
  width: auto;
  min-width: 0;
  align-self: flex-start;
  overflow: hidden;
  border: 1px solid rgba(232, 162, 102, 0.18);
  border-radius: 14px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.035), transparent 34%),
    var(--fe-surface-soft);
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.2);
}

.final-edit-inspector-scroll {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: 20px;
}

.final-edit-inspector-scroll::-webkit-scrollbar {
  width: 6px;
}

.final-edit-inspector-scroll::-webkit-scrollbar-thumb {
  border: 1px solid transparent;
  border-radius: 999px;
  background: rgba(112, 93, 75, 0.78);
  background-clip: padding-box;
}

@media (min-width: 1280px) {
  .final-edit-content {
    grid-template-rows: minmax(0, 1fr);
    overflow: hidden;
  }

  .final-edit-scroll {
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    padding-bottom: 24px;
  }

  .final-edit-inspector {
    height: 100%;
    position: static;
  }

  .final-edit-inspector-scroll {
    height: 100%;
  }
}

.fe-inspector-section {
  border-top: 1px solid var(--fe-line-soft);
  padding: 18px 0;
}

.fe-inspector-section:first-child {
  border-top: 0;
  padding-top: 2px;
}

.fe-inspector-selected {
  padding-bottom: 20px;
}

.fe-inspector-titleline {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.fe-inspector-titleline h2 {
  margin: 6px 0 0;
  color: var(--fe-text);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.015em;
  line-height: 1.2;
}

.fe-clip-badge {
  flex: 0 0 auto;
  border: 1px solid rgba(159, 201, 159, 0.32);
  border-radius: 999px;
  padding: 4px 8px;
  background: rgba(159, 201, 159, 0.08);
  color: var(--fe-success);
  font-size: 10px;
  font-weight: 700;
}

.fe-clip-badge-muted {
  border-color: rgba(239, 143, 132, 0.32);
  background: rgba(239, 143, 132, 0.08);
  color: var(--fe-danger);
}

.fe-inspector-stack {
  display: grid;
  gap: 12px;
  margin-top: 16px;
}

.fe-inspector-meta {
  display: grid;
  gap: 10px;
  margin-top: 18px;
}

.fe-inspector-meta-tight {
  margin-top: 0;
  border: 1px solid var(--fe-line-soft);
  border-radius: 9px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.018);
}

.fe-inspector-meta > div {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 8px;
  align-items: baseline;
}

.fe-inspector-meta span {
  color: var(--fe-dim);
  font-size: 11px;
}

.fe-inspector-meta strong {
  min-width: 0;
  color: var(--fe-text);
  font-size: 12px;
  font-weight: 550;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.fe-control-card {
  display: grid;
  gap: 11px;
  border: 1px solid var(--fe-line-soft);
  border-radius: 10px;
  padding: 12px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.025), transparent 54%),
    rgba(255, 255, 255, 0.014);
}

.fe-control-card-head,
.fe-mini-track-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.fe-control-card-head strong,
.fe-mini-track-title strong {
  color: var(--fe-text);
  font-size: 13px;
  font-weight: 700;
}

.fe-control-card-head span,
.fe-mini-track-title span,
.fe-control-hint {
  color: var(--fe-dim);
  font-size: 11px;
  line-height: 1.55;
}

.fe-trim-grid,
.fe-mini-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.fe-trim-bar {
  position: relative;
  height: 10px;
  overflow: hidden;
  border-radius: 999px;
  background:
    repeating-linear-gradient(
      90deg,
      rgba(255, 255, 255, 0.09) 0,
      rgba(255, 255, 255, 0.09) 1px,
      transparent 1px,
      transparent 12.5%
    ),
    rgba(0, 0, 0, 0.26);
}

.fe-trim-window {
  position: absolute;
  top: 0;
  bottom: 0;
  min-width: 5%;
  border-radius: inherit;
  background: linear-gradient(90deg, #e8a266, #f2c08c);
  box-shadow: 0 0 18px rgba(232, 162, 102, 0.22);
}

.fe-candidate-list,
.fe-mini-track-list,
.fe-mini-subtitle-list {
  display: grid;
  gap: 8px;
}

.fe-candidate-item {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  min-height: 48px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 8px;
  padding: 6px;
  background: rgba(255, 255, 255, 0.02);
  color: var(--fe-text);
  text-align: left;
  transition:
    border-color 180ms ease,
    background-color 180ms ease,
    transform 180ms ease;
}

.fe-candidate-item:hover {
  border-color: rgba(232, 162, 102, 0.48);
  background: rgba(232, 162, 102, 0.055);
  transform: translateY(-1px);
}

.fe-candidate-item-active {
  border-color: rgba(232, 162, 102, 0.72);
  background: rgba(232, 162, 102, 0.11);
}

.fe-candidate-item img {
  width: 56px;
  height: 38px;
  border-radius: 5px;
  object-fit: cover;
  background: #080908;
}

.fe-candidate-item span {
  min-width: 0;
}

.fe-candidate-item strong,
.fe-candidate-item em {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fe-candidate-item strong {
  color: var(--fe-text);
  font-size: 12px;
}

.fe-candidate-item em {
  margin-top: 2px;
  color: var(--fe-dim);
  font-size: 10px;
  font-style: normal;
}

.fe-mini-track,
.fe-mini-audio-row,
.fe-mini-subtitle-row {
  display: grid;
  gap: 9px;
}

.fe-mini-track,
.fe-mini-subtitle-row {
  border: 1px solid rgba(255, 255, 255, 0.055);
  border-radius: 8px;
  padding: 10px;
  background: rgba(0, 0, 0, 0.12);
}

.fe-audio-lead-actions,
.fe-marker-list,
.fe-version-list {
  display: grid;
  gap: 8px;
}

.fe-audio-lead-actions {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.fe-audio-lead-actions .fe-button {
  justify-content: center;
  min-height: 34px;
  padding-inline: 8px;
}

.fe-marker-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 86px;
  gap: 8px;
}

.fe-emotion-row {
  grid-template-columns: minmax(0, 1fr) 72px;
}

.fe-version-item {
  display: grid;
  gap: 3px;
  width: 100%;
  border: 1px solid rgba(255, 255, 255, 0.065);
  border-radius: 8px;
  padding: 9px 10px;
  background: rgba(255, 255, 255, 0.02);
  text-align: left;
  transition:
    border-color 180ms ease,
    background-color 180ms ease,
    transform 180ms ease;
}

.fe-version-item:hover {
  border-color: rgba(232, 162, 102, 0.48);
  background: rgba(232, 162, 102, 0.055);
  transform: translateY(-1px);
}

.fe-version-item strong {
  color: var(--fe-text);
  font-size: 12px;
}

.fe-version-item span {
  color: var(--fe-dim);
  font-size: 10px;
}

.fe-mini-audio-row + .fe-mini-audio-row {
  border-top: 1px solid rgba(255, 255, 255, 0.055);
  padding-top: 9px;
}

.fe-mini-textarea {
  min-height: 58px;
}

.fe-inspector-section-heading h3 {
  font-size: 15px;
}

.fe-check-state {
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 4px 7px;
  font-size: 10px;
  font-weight: 700;
}

.fe-check-state-good {
  color: var(--fe-success);
}

.fe-check-state-blocked {
  color: var(--fe-danger);
}

.fe-validation-list {
  display: grid;
  gap: 7px;
  margin-top: 14px;
}

.fe-validation-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  border: 1px solid currentColor;
  border-radius: 6px;
  padding: 10px;
  font-size: 12px;
  line-height: 1.5;
}

.fe-validation-item .material-symbols-outlined {
  flex: 0 0 auto;
  font-size: 17px;
}

.fe-validation-good {
  border-color: rgba(159, 201, 159, 0.3);
  background: rgba(159, 201, 159, 0.08);
  color: var(--fe-success);
}

.fe-validation-danger {
  border-color: rgba(239, 143, 132, 0.3);
  background: rgba(239, 143, 132, 0.08);
  color: var(--fe-danger);
}

.fe-validation-warning {
  border-color: rgba(232, 190, 119, 0.3);
  background: rgba(232, 190, 119, 0.08);
  color: #e8be77;
}

.fe-track-summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  margin-top: 16px;
  border: 1px solid var(--fe-line-soft);
  background: var(--fe-line-soft);
}

.fe-track-summary > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  padding: 9px;
  background: var(--fe-surface);
}

.fe-track-summary span {
  color: var(--fe-muted);
  font-size: 11px;
}

.fe-track-summary strong {
  color: var(--fe-text);
  font-size: 17px;
  font-variant-numeric: tabular-nums;
}

.fe-inspector-note {
  margin: 14px 0 0;
  color: var(--fe-muted);
  font-size: 11px;
  line-height: 1.7;
}

.fe-inspector-actions {
  display: grid;
  margin-top: 16px;
}

@media (max-width: 1279px) {
  .final-edit-content {
    grid-template-columns: 1fr;
  }

  .final-edit-inspector {
    height: auto;
    max-height: none;
    position: static;
  }

  .final-edit-inspector-scroll {
    height: auto;
    overflow: visible;
  }
}

@media (max-width: 900px) {
  .final-edit-title-row {
    align-items: flex-start;
    flex-direction: column;
  }

  .final-edit-actions {
    width: 100%;
  }

  .final-edit-actions .fe-button-primary {
    margin-left: auto;
  }

  .final-edit-stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .fe-subtitle-fields {
    grid-template-columns: 1fr;
  }

  .fe-field-wide {
    grid-column: auto;
  }
}

@media (max-width: 640px) {
  .final-edit-header,
  .final-edit-status-bar {
    padding-right: 16px;
    padding-left: 16px;
  }

  .final-edit-content {
    gap: 14px;
    padding: 16px 16px 36px;
  }

  .final-edit-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .fe-stat {
    padding: 10px;
  }

  .fe-preview-footer,
  .fe-preview-head,
  .fe-section-heading,
  .fe-audio-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .fe-inline-control {
    width: 100%;
    justify-content: space-between;
  }

  .fe-inline-control .fe-range {
    flex: 1;
  }

  .fe-audio-controls {
    width: 100%;
    justify-content: space-between;
  }

  .fe-volume-control {
    flex: 1;
    justify-content: flex-end;
  }

  .fe-volume-control .fe-range {
    flex: 1;
    max-width: 140px;
  }

  .final-edit-inspector-scroll {
    padding: 16px;
  }
}

/* P28.1 professional editor shell: Jianying-like NLE layout, mapped to existing draft logic. */
.final-edit-shell {
  --fe-bg: #0f100e;
  --fe-surface: #171915;
  --fe-surface-raised: #1d201b;
  --fe-surface-soft: #121410;
  --fe-line: rgba(184, 143, 95, 0.28);
  --fe-line-soft: rgba(184, 143, 95, 0.14);
  --fe-text: #eee9dd;
  --fe-muted: #bbb5a7;
  --fe-dim: #8d877b;
  --fe-accent: #e5a15f;
  --fe-accent-soft: rgba(229, 161, 95, 0.12);
  height: 100%;
  overflow: hidden;
  background:
    radial-gradient(circle at 48% -20%, rgba(229, 161, 95, 0.09), transparent 34rem),
    linear-gradient(180deg, #171915 0%, #0f100e 44%);
}

.final-edit-header {
  padding: 10px 18px 8px;
  background: rgba(18, 20, 16, 0.96);
}

.final-edit-header h1 {
  font-size: clamp(1.25rem, 1.5vw, 1.55rem);
  letter-spacing: 0;
}

.final-edit-subtitle {
  margin-top: 4px;
}

.final-edit-kicker,
.fe-section-label {
  letter-spacing: 0.08em;
}

.final-edit-status-bar {
  padding: 6px 16px 8px;
  background: #0f100e;
}

.final-edit-stats {
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 0;
  margin-top: 0;
  border-radius: 10px;
}

.fe-stat {
  padding: 6px 12px;
}

.fe-stat strong {
  font-size: 15px;
}

.final-edit-content {
  display: grid;
  grid-template-areas:
    "materials player inspector"
    "timeline timeline timeline";
  /* 素材区加宽、播放区保底：时间线可以往上提，但不能把预览压没。 */
  grid-template-columns: minmax(300px, 360px) minmax(520px, 1fr) minmax(288px, 340px);
    grid-template-rows: minmax(var(--fe-preview-min-height, 380px), 1fr) minmax(180px, var(--fe-timeline-height, 22vh));
  gap: 12px;
  height: 100%;
  min-height: 0;
  padding: 10px 14px 14px;
  overflow: hidden;
}

.final-edit-scroll {
  display: contents;
}

.final-edit-scroll > .fe-section:not(.fe-timeline-dock) {
  display: none;
}

.fe-material-bin,
.fe-preview-panel,
.final-edit-inspector,
.fe-timeline-dock {
  min-width: 0;
  min-height: 0;
  height: 100%;
  max-height: 100%;
  align-self: stretch;
  border: 1px solid rgba(232, 162, 102, 0.14);
  border-radius: 10px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.035), transparent 38%),
    rgba(20, 22, 18, 0.96);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.24);
}

.fe-material-bin {
  grid-area: materials;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.fe-bin-header,
.fe-bin-subtitle-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.fe-bin-header {
  padding: 14px;
  border-bottom: 1px solid var(--fe-line-soft);
}

.fe-bin-header h2,
.fe-preview-head h2,
.fe-section-heading h2,
.fe-inspector-titleline h2 {
  margin: 0;
  color: var(--fe-text);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0;
}

.fe-bin-header p,
.fe-bin-subtitle-row span {
  margin: 4px 0 0;
  color: var(--fe-muted);
  font-size: 11px;
  line-height: 1.45;
}

.fe-bin-tabs,
.fe-inspector-tabs {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px;
  padding: 8px;
  border-bottom: 1px solid var(--fe-line-soft);
}

.fe-inspector-tabs {
  grid-template-columns: repeat(5, minmax(0, 1fr));
  margin-top: 14px;
  padding: 4px;
  border: 1px solid var(--fe-line-soft);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.16);
}

.fe-bin-tab,
.fe-inspector-tab {
  display: inline-flex;
  min-width: 0;
  min-height: 34px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border-radius: 7px;
  color: var(--fe-muted);
  font-size: 11px;
  font-weight: 650;
  transition:
    background-color 180ms ease,
    color 180ms ease,
    transform 180ms ease;
}

.fe-bin-tab .material-symbols-outlined {
  font-size: 16px;
}

.fe-bin-tab:hover,
.fe-inspector-tab:hover {
  background: rgba(255, 255, 255, 0.045);
  color: var(--fe-text);
}

.fe-bin-tab-active,
.fe-inspector-tab-active {
  background: rgba(229, 161, 95, 0.16);
  color: var(--fe-accent);
}

.fe-bin-body,
.final-edit-inspector-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.fe-bin-body {
  padding: 12px;
}

.fe-bin-panel,
.fe-bin-audio-stack,
.fe-bin-subtitle-list {
  display: grid;
  gap: 10px;
}

.fe-unmatched-audio {
  border: 1px solid rgba(232, 190, 119, 0.28);
  border-radius: 9px;
  padding: 10px 11px;
  background: rgba(232, 190, 119, 0.07);
  color: #e8be77;
}

.fe-unmatched-audio-head {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
}

.fe-unmatched-audio-head .material-symbols-outlined {
  font-size: 16px;
}

.fe-unmatched-audio-head > span:last-child {
  margin-left: auto;
  color: rgba(232, 190, 119, 0.78);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.fe-unmatched-audio p {
  margin: 7px 0 0;
  color: rgba(238, 233, 221, 0.72);
  font-size: 11px;
  line-height: 1.45;
}

.fe-unmatched-audio ul {
  display: grid;
  gap: 4px;
  margin: 8px 0 0;
  padding-left: 16px;
  color: rgba(238, 233, 221, 0.82);
  font-size: 11px;
  line-height: 1.4;
}

.fe-bin-search {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 8px;
  padding: 0 10px;
  background: rgba(0, 0, 0, 0.2);
  color: var(--fe-dim);
  font-size: 12px;
}

.fe-bin-search .material-symbols-outlined {
  font-size: 16px;
}

.fe-media-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.fe-media-tile {
  display: grid;
  gap: 6px;
  min-width: 0;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 8px;
  padding: 7px;
  background: rgba(255, 255, 255, 0.025);
  color: var(--fe-text);
  text-align: left;
  transition:
    border-color 180ms ease,
    background-color 180ms ease,
    transform 180ms ease;
}

.fe-media-tile:hover,
.fe-media-tile-active {
  border-color: rgba(229, 161, 95, 0.62);
  background: rgba(229, 161, 95, 0.08);
  transform: translateY(-1px);
}

.fe-media-tile img,
.fe-media-placeholder {
  width: 100%;
  aspect-ratio: 9 / 16;
  border-radius: 6px;
  background: #070806;
  object-fit: cover;
}

.fe-media-placeholder {
  display: grid;
  place-items: center;
  color: var(--fe-dim);
  font-size: 28px;
}

.fe-media-tile strong,
.fe-media-tile em {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fe-media-tile strong {
  font-size: 11px;
  font-weight: 700;
}

.fe-media-tile em {
  color: var(--fe-dim);
  font-size: 10px;
  font-style: normal;
}

.fe-bin-subsection,
.fe-bin-audio-row {
  border: 1px solid rgba(255, 255, 255, 0.065);
  border-radius: 9px;
  padding: 10px;
  background: rgba(0, 0, 0, 0.14);
}

.fe-bin-audio-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.fe-bin-audio-title strong,
.fe-bin-subtitle-row strong {
  min-width: 0;
  color: var(--fe-text);
  font-size: 12px;
  font-weight: 700;
}

.fe-bin-audio-title span {
  color: var(--fe-dim);
  font-size: 10px;
}

.fe-bin-audio-controls {
  margin-top: 9px;
}

.fe-transition-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.fe-transition-option {
  display: grid;
  min-height: 74px;
  place-items: center;
  gap: 5px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.025);
  color: var(--fe-muted);
  font-size: 12px;
  transition:
    border-color 180ms ease,
    background-color 180ms ease,
    color 180ms ease,
    transform 180ms ease;
}

.fe-transition-option:hover:not(:disabled),
.fe-transition-option-active {
  border-color: rgba(229, 161, 95, 0.62);
  background: rgba(229, 161, 95, 0.1);
  color: var(--fe-accent);
  transform: translateY(-1px);
}

.fe-preview-panel {
  grid-area: player;
  display: flex;
  flex-direction: column;
  padding: 12px;
  overflow: hidden;
}

.fe-preview-head {
  flex: 0 0 auto;
}

.fe-preview-frame {
  display: grid;
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  aspect-ratio: 16 / 9;
  place-items: center;
  border-radius: 9px;
  background:
    radial-gradient(circle at center, rgba(255, 255, 255, 0.055), transparent 16rem),
    #050604;
}

.fe-preview-frame video,
.fe-preview-frame img {
  position: absolute;
  inset: 0;
  width: 100% !important;
  height: 100% !important;
  max-width: 100%;
  max-height: 100%;
  aspect-ratio: auto !important;
  border-radius: 8px;
  object-fit: contain;
}

.fe-preview-footer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    "main time"
    "main sync"
    "volume volume";
  align-items: center;
  column-gap: 12px;
  row-gap: 6px;
  flex: 0 0 auto;
}

.fe-preview-footer > div:first-child {
  grid-area: main;
  min-width: 0;
}

.fe-preview-footer > .fe-preview-timecode {
  grid-area: time;
}

.fe-preview-footer > .fe-preview-sync-state {
  grid-area: sync;
  justify-self: end;
}

.fe-preview-footer > .fe-inline-control {
  grid-area: volume;
  justify-self: end;
}

.fe-preview-timecode {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  min-width: 104px;
  padding: 7px 10px;
  border: 1px solid rgba(229, 161, 95, 0.22);
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.26);
  color: var(--fe-muted);
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.fe-preview-timecode strong {
  color: var(--fe-accent);
  font-size: 14px;
  font-weight: 750;
}

.fe-preview-sync-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--fe-success);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.fe-preview-sync-state .material-symbols-outlined {
  font-size: 16px;
}

.fe-preview-sync-state-muted {
  color: var(--fe-dim);
}

.final-edit-inspector {
  grid-area: inspector;
  align-self: stretch;
}

.final-edit-inspector-scroll {
  height: 100%;
  padding: 14px;
}

.fe-inspector-section {
  border-top: 0;
  padding: 0;
}

.fe-inspector-selected {
  padding-bottom: 0;
}

.fe-inspector-stack {
  gap: 10px;
}

.fe-inspector-meta-tight {
  margin-top: 14px;
}

.fe-control-card {
  animation: fe-panel-enter 220ms ease-out;
}

/* P28.6 对照剪映：素材区可搜可拖、播放区加大、时间线不再压掉预览。 */
.fe-timeline-dock {
  position: relative;
  grid-area: timeline;
  display: flex;
  flex-direction: column;
  min-height: 180px;
  padding: 12px;
  overflow: hidden;
}

.fe-timeline-resize-handle {
  position: absolute;
  z-index: 4;
  top: -7px;
  right: 14px;
  left: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 14px;
  cursor: ns-resize;
  touch-action: none;
}

.fe-timeline-resize-handle span {
  display: block;
  width: 72px;
  height: 3px;
  border-radius: 999px;
  background: rgba(229, 161, 95, 0.26);
  opacity: 0;
  transform: scaleX(0.7);
  transition:
    opacity 160ms ease,
    transform 160ms ease,
    background-color 160ms ease;
}

.fe-timeline-resize-handle:hover span,
.fe-timeline-resize-handle:focus-visible span,
.fe-timeline-resize-handle:active span {
  background: var(--fe-accent);
  opacity: 1;
  transform: scaleX(1);
}

.fe-timeline-resize-handle:focus-visible {
  outline: 0;
}

.fe-timeline-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 7px;
}

.fe-timeline-zoom {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 30px;
  border: 1px solid var(--fe-line-soft);
  border-radius: 6px;
  padding: 0 8px;
  background: rgba(255, 255, 255, 0.018);
  color: var(--fe-dim);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.fe-timeline-zoom input {
  width: 74px;
  height: 4px;
  accent-color: var(--fe-accent);
}

.fe-timeline-zoom strong {
  min-width: 34px;
  color: var(--fe-muted);
  font-size: 10px;
  font-weight: 650;
  text-align: right;
}

.fe-timeline-dock .fe-edit-timeline {
  flex: 1;
  min-height: 0;
  margin-top: 10px;
}

.fe-timeline-dock .fe-edit-row,
.fe-timeline-dock .fe-edit-ruler {
  grid-template-columns: 112px minmax(920px, 1fr);
  min-width: 1050px;
}

.fe-timeline-dock .fe-edit-ruler {
  min-height: 34px;
  align-items: stretch;
}

.fe-edit-ruler-label {
  display: flex;
  align-items: center;
  color: var(--fe-dim);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.fe-edit-ruler-track {
  position: relative;
  min-height: 34px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  cursor: ew-resize;
  touch-action: none;
}

.fe-edit-ruler-track:focus-visible {
  outline: 2px solid rgba(229, 161, 95, 0.86);
  outline-offset: 2px;
}

.fe-ruler-tick {
  position: absolute;
  inset-block: 0;
  transform: translateX(-50%);
  pointer-events: none;
}

.fe-ruler-tick i {
  display: block;
  width: 1px;
  height: 8px;
  margin: 0 auto;
  background: rgba(255, 255, 255, 0.22);
}

.fe-ruler-tick:first-child i,
.fe-ruler-tick:last-child i {
  height: 12px;
  background: rgba(229, 161, 95, 0.68);
}

.fe-ruler-tick em {
  display: block;
  margin-top: 4px;
  color: var(--fe-dim);
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 9px;
  font-style: normal;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.fe-edit-track-stack {
  position: relative;
  display: grid;
  gap: 7px;
  min-width: 1050px;
  padding-top: 8px;
  cursor: ew-resize;
  touch-action: none;
}

.fe-timeline-playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  z-index: 10;
  width: 0;
  pointer-events: none;
  /* 播放头独占一个合成层，拖动时只移动自己，不再重绘轨道文字。 */
  will-change: transform;
  transform: translate3d(0, 0, 0);
}

.fe-timeline-playhead::before {
  content: "";
  position: absolute;
  top: 0;
  left: -5px;
  width: 10px;
  height: 10px;
  border: 2px solid #171915;
  border-radius: 3px;
  background: var(--fe-accent);
  box-shadow: 0 2px 10px rgba(229, 161, 95, 0.35);
}

.fe-timeline-playhead i {
  position: absolute;
  top: 9px;
  bottom: 0;
  left: -1px;
  width: 2px;
  background: var(--fe-accent);
  box-shadow: 0 0 10px rgba(229, 161, 95, 0.52);
}

.fe-timeline-playhead span {
  position: absolute;
  top: -25px;
  left: 7px;
  z-index: 2;
  min-width: 48px;
  border: 1px solid rgba(229, 161, 95, 0.36);
  border-radius: 4px;
  padding: 3px 5px;
  background: #2b2117;
  color: #f6d3ab;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  text-align: center;
  white-space: nowrap;
}

.fe-timeline-dock .fe-edit-track-label {
  grid-template-columns: auto auto;
  align-content: center;
  align-items: center;
  justify-content: space-between;
  min-height: 42px;
}

.fe-timeline-dock .fe-edit-lane {
  min-height: 42px;
  cursor: ew-resize;
}

.fe-timeline-dock .fe-edit-clip {
  top: 5px;
  bottom: 5px;
}

.fe-button:focus-visible,
.fe-icon-button:focus-visible,
.fe-bin-tab:focus-visible,
.fe-inspector-tab:focus-visible,
.fe-media-tile:focus-visible,
.fe-transition-option:focus-visible {
  outline: 2px solid rgba(229, 161, 95, 0.86);
  outline-offset: 2px;
}

@keyframes fe-panel-enter {
  from {
    opacity: 0.72;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* P28.6 对照剪映收口：素材库可搜可拖、图标悬浮提示、播放头拖动不重绘轨道文字。 */
.fe-icon-button[aria-label],
.fe-bin-tab[aria-label],
.fe-preview-nav-button[aria-label],
.fe-play-button[aria-label] {
  position: relative;
}

.fe-icon-button[aria-label]::after,
.fe-bin-tab[aria-label]::after,
.fe-preview-nav-button[aria-label]::after,
.fe-play-button[aria-label]::after {
  content: attr(aria-label);
  position: absolute;
  top: calc(100% + 8px);
  left: 50%;
  z-index: 40;
  border: 1px solid rgba(229, 161, 95, 0.34);
  border-radius: 6px;
  padding: 5px 9px;
  background: #221e18;
  color: #f6e8d6;
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.2;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transform: translateX(-50%) translateY(-3px);
  transition:
    opacity 110ms ease,
    transform 110ms ease;
}

.fe-preview-nav-button[aria-label]::after,
.fe-play-button[aria-label]::after {
  top: auto;
  bottom: calc(100% + 10px);
  transform: translateX(-50%) translateY(3px);
}

.fe-icon-button[aria-label]:hover::after,
.fe-icon-button[aria-label]:focus-visible::after,
.fe-bin-tab[aria-label]:hover::after,
.fe-preview-nav-button[aria-label]:hover::after,
.fe-preview-nav-button[aria-label]:focus-visible::after,
.fe-play-button[aria-label]:hover::after,
.fe-play-button[aria-label]:focus-visible::after {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

.fe-bin-search-input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--fe-text);
  font-family: inherit;
  font-size: 12px;
  outline: none;
}

.fe-bin-search-input::placeholder {
  color: var(--fe-dim);
}

.fe-bin-search-count {
  flex: 0 0 auto;
  color: var(--fe-dim);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.fe-bin-drag-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--fe-dim);
  font-size: 11px;
  line-height: 1.45;
}

.fe-bin-drag-hint .material-symbols-outlined {
  flex: 0 0 auto;
  font-size: 15px;
}

.fe-media-thumb {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 9 / 16;
  overflow: hidden;
  border-radius: 6px;
  background: #070806;
}

.fe-media-thumb img {
  width: 100%;
  height: 100%;
  aspect-ratio: auto;
  object-fit: cover;
}

.fe-media-thumb .fe-media-placeholder {
  width: 100%;
  height: 100%;
  aspect-ratio: auto;
}

.fe-media-badge {
  position: absolute;
  border-radius: 4px;
  padding: 1px 5px;
  background: rgba(8, 9, 7, 0.84);
  font-size: 9px;
  font-style: normal;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.fe-media-badge-time {
  top: 4px;
  right: 4px;
  color: #f3e7d7;
  font-variant-numeric: tabular-nums;
}

.fe-media-badge-state {
  top: 4px;
  left: 4px;
  color: #9fdca6;
}

.fe-media-badge-off {
  color: var(--fe-dim);
}

.fe-edit-clip-drop-before::before {
  content: "";
  position: absolute;
  top: -3px;
  bottom: -3px;
  left: -2px;
  width: 3px;
  border-radius: 2px;
  background: var(--fe-accent);
  box-shadow: 0 0 10px rgba(229, 161, 95, 0.6);
}

.fe-edit-lane-dropping {
  border-color: rgba(229, 161, 95, 0.5);
  background-color: rgba(229, 161, 95, 0.05);
}

.fe-edit-lane-drop-end::after {
  content: "";
  position: absolute;
  top: 4px;
  right: 3px;
  bottom: 4px;
  width: 3px;
  border-radius: 2px;
  background: var(--fe-accent);
  box-shadow: 0 0 10px rgba(229, 161, 95, 0.6);
}

.fe-edit-timeline,
.fe-bin-body {
  user-select: none;
}

/* 画中画叠加轨：与主轨并存，只在编辑器里合成预览。 */
.fe-edit-lane-overlay {
  background:
    repeating-linear-gradient(
      90deg,
      rgba(120, 200, 255, 0.06) 0,
      rgba(120, 200, 255, 0.06) 1px,
      transparent 1px,
      transparent 8.333%
    ),
    rgba(86, 160, 214, 0.04);
}

.fe-edit-clip-overlay {
  top: 6px;
  bottom: 6px;
  min-width: 56px;
  border-color: rgba(120, 200, 255, 0.36);
  background: linear-gradient(180deg, rgba(86, 160, 214, 0.34), rgba(38, 74, 104, 0.52));
  cursor: grab;
}

.fe-edit-clip-overlay:active {
  cursor: grabbing;
}

.fe-preview-overlay {
  position: absolute;
  z-index: 3;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1px solid rgba(229, 161, 95, 0.46);
  border-radius: 8px;
  background: #050604;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.5);
  pointer-events: none;
}

.fe-preview-overlay video,
.fe-preview-overlay img {
  display: block;
  width: 100%;
  height: 100%;
  aspect-ratio: auto !important;
  object-fit: cover;
}

.fe-preview-overlay-tag {
  position: absolute;
  right: 6px;
  bottom: 6px;
  border-radius: 4px;
  padding: 2px 6px;
  background: rgba(8, 9, 7, 0.78);
  color: #f6d3ab;
  font-size: 9px;
  font-weight: 700;
}

.fe-overlay-card {
  border: 1px solid rgba(120, 200, 255, 0.26);
}

.fe-overlay-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
}

/* 交付包面板：把草稿整理成外部 NLE 能直接用的素材集合。 */
.fe-delivery-layer {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(6, 7, 5, 0.74);
}

.fe-delivery-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: min(760px, 100%);
  max-height: min(84vh, 760px);
  overflow: auto;
  border: 1px solid rgba(229, 161, 95, 0.24);
  border-radius: 14px;
  padding: 18px 20px 20px;
  background: var(--fe-surface, #171915);
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6);
}

.fe-delivery-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.fe-delivery-head h2 {
  margin: 2px 0 4px;
  font-size: 18px;
}

.fe-delivery-loading {
  margin: 0;
  color: var(--fe-muted);
  font-size: 12px;
}

.fe-delivery-summary {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
}

.fe-delivery-summary > div {
  display: grid;
  gap: 2px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 8px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.02);
}

.fe-delivery-summary span {
  color: var(--fe-dim);
  font-size: 11px;
}

.fe-delivery-summary strong {
  font-size: 15px;
}

.fe-delivery-steps {
  display: grid;
  gap: 6px;
  margin: 0;
  padding-left: 18px;
  color: var(--fe-muted);
  font-size: 12px;
  line-height: 1.65;
}

.fe-delivery-steps code,
.fe-delivery-list code {
  border-radius: 4px;
  padding: 1px 5px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--fe-text);
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 11px;
}

.fe-delivery-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.fe-delivery-warnings {
  display: grid;
  gap: 4px;
  margin: 0;
  padding-left: 18px;
  color: #f0c98a;
  font-size: 12px;
  line-height: 1.6;
}

.fe-delivery-list ol {
  display: grid;
  gap: 4px;
  margin: 8px 0 0;
  padding-left: 18px;
}

.fe-delivery-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
}

.fe-delivery-list li span {
  flex: 0 0 auto;
  color: var(--fe-dim);
}

.fe-delivery-list li em {
  color: var(--fe-accent);
  font-style: normal;
  font-size: 11px;
}

/* 导出到剪映：环境状态卡 + 结果摘要 */
.fe-jy-summary {
  /* 6 张卡片按 3 列排，避免最后一张被挤到第二行单独占位 */
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.fe-jy-status {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.02);
}

.fe-jy-status .material-symbols-outlined {
  color: var(--fe-dim);
  font-size: 18px;
}

.fe-jy-status.is-ready {
  border-color: rgba(122, 199, 122, 0.32);
  background: rgba(122, 199, 122, 0.06);
}

.fe-jy-status.is-ready .material-symbols-outlined {
  color: #7ac77a;
}

.fe-jy-status.is-blocked {
  border-color: rgba(233, 150, 122, 0.36);
  background: rgba(233, 150, 122, 0.07);
}

.fe-jy-status.is-blocked .material-symbols-outlined {
  color: #e9967a;
}

.fe-jy-status strong {
  font-size: 13px;
}

.fe-jy-path {
  margin: 3px 0 0;
  color: var(--fe-dim);
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 11px;
  word-break: break-all;
}

.fe-jy-hint {
  margin: 4px 0 0;
  color: #e9967a;
  font-size: 11px;
}

.fe-jy-name {
  font-size: 13px !important;
}

.fe-jy-px {
  display: block;
  color: var(--fe-dim);
  font-style: normal;
  font-size: 11px;
  font-weight: 400;
}

.fe-jy-warn {
  color: #f0c98a;
}

.fe-jy-result {
  display: grid;
  gap: 6px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 8px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.02);
  font-size: 12px;
}

.fe-jy-result ul {
  display: grid;
  gap: 3px;
  margin: 0;
  padding-left: 18px;
  color: var(--fe-muted);
}

.fe-jy-result li.is-warn {
  color: #f0c98a;
}

.fe-jy-remove {
  margin-left: auto;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  padding: 2px 8px;
  background: transparent;
  color: var(--fe-muted);
  font-size: 11px;
  cursor: pointer;
}

.fe-jy-remove:hover:not(:disabled) {
  border-color: rgba(233, 150, 122, 0.5);
  color: #e9967a;
}

.fe-jy-remove:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

@media (max-width: 640px) {
  .fe-jy-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 1180px) {
  .final-edit-content {
    grid-template-areas:
      "player"
      "timeline"
      "materials"
      "inspector";
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows:
      minmax(440px, auto)
      minmax(360px, auto)
      minmax(420px, auto)
      minmax(420px, auto);
    overflow-y: auto;
  }

  .final-edit-scroll {
    display: contents;
  }

  .fe-material-bin,
  .fe-preview-panel,
  .final-edit-inspector,
  .fe-timeline-dock {
    height: auto;
    max-height: none;
  }

  .fe-preview-panel {
    min-height: 440px;
  }

  .fe-timeline-dock {
    min-height: 360px;
  }

  .fe-material-bin,
  .final-edit-inspector,
  .fe-timeline-dock {
    max-height: none;
  }

  .fe-material-bin,
  .final-edit-inspector {
    min-height: 420px;
  }

  .fe-bin-body,
  .final-edit-inspector-scroll {
    max-height: none;
    overflow: visible;
  }

  .fe-preview-frame video,
  .fe-preview-frame img {
    width: 100% !important;
  }
}

@media (max-width: 640px) {
  .final-edit-content {
    padding: 12px;
  }

  .final-edit-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .fe-bin-tabs,
  .fe-inspector-tabs {
    overflow-x: auto;
    grid-template-columns: repeat(4, minmax(76px, 1fr));
  }

  .fe-inspector-tabs {
    grid-template-columns: repeat(5, minmax(64px, 1fr));
  }

  .fe-media-grid,
  .fe-transition-grid,
  .fe-trim-grid,
  .fe-mini-fields,
  .fe-audio-lead-actions {
    grid-template-columns: 1fr;
  }

  .fe-preview-frame video,
  .fe-preview-frame img {
    width: 100% !important;
  }

  .fe-preview-panel {
    min-height: 440px;
  }

  .fe-preview-frame {
    min-height: 0;
  }

  .fe-timeline-dock {
    min-height: 360px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .fe-control-card {
    animation: none;
  }
}
</style>
