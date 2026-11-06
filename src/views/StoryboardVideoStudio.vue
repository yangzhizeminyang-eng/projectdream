<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter, type LocationQueryValue } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  loadShotDetail,
  loadStudioSnapshot,
  type ShotProductionDetail,
  type ShotSummary,
  type StudioSnapshot,
} from '@/api/production-studio'
import {
  downloadProjectDeliveryArchive,
  generateStoryboardVideos,
  getGenerationJob,
  getAssetCanvas,
  getProject,
  getProjectDeliveryPackage,
  getProjectAssets,
  getStoryboard,
  listStoryboardVideos,
  confirmVideo,
  listVoiceProfiles,
  bindCharacterVoice,
  listCharacterImages,
  previewCharacterVoice,
  saveCharacterReferenceAudio,
  listCharacters,
  updateAssetNode,
  updateStoryboard,
  removeVideoSubtitles,
  type AssetNodeDTO,
  type CharacterDTO,
  type ProjectAssetItemDTO,
  type StoryboardDTO,
  type VoiceProfileDTO,
  type CharacterVoicePreviewDTO,
} from '@/api/project'
import { registerAgentPipelineStageAction } from '@/api/agent-pipeline'
import { getShotVoiceBindingState } from '@/lib/voice-binding-status'
import { buildEpisodeClips, formatAggregateDuration, formatShotDuration } from '@/lib/episode-clips.mjs'

const route = useRoute()
const router = useRouter()

const snapshot = ref<StudioSnapshot | null>(null)
const loading = ref(true)
const loadError = ref('')
const selectedShotId = ref<number | null>(null)
const selectedClipId = ref<number | null>(null)
const detail = ref<ShotProductionDetail | null>(null)
const detailLoading = ref(false)
const projectCharacters = ref<CharacterDTO[]>([])
const projectAssets = ref<ProjectAssetItemDTO[]>([])
const assetNodes = ref<AssetNodeDTO[]>([])
const characterImageOverrides = ref<Record<number, string>>({})
const episodeStoryboards = ref<StoryboardDTO[]>([])
const videoCandidatesByStoryboard = ref<Map<number, Awaited<ReturnType<typeof listStoryboardVideos>>>>(new Map())
const voiceProfiles = ref<VoiceProfileDTO[]>([])
const assetEditor = ref<StudioAsset | null>(null)
const assetPrompt = ref('')
const assetSaving = ref(false)
const assetMessage = ref('')
const voiceProfileKey = ref('')
const voiceStyle = ref('')
const voiceBusy = ref(false)
const voiceMessage = ref('')
const voicePreviewUrl = ref('')
const voicePreviewProfileKey = ref('')
const voicePreviewing = ref(false)
const voicePreviewReady = ref(false)
const voiceAgentDesign = ref<CharacterVoicePreviewDTO['voiceDesign']>(null)
const referenceAudioUrl = ref('')
const referenceAudioName = ref('')
const referenceAudioInput = ref<HTMLInputElement | null>(null)
const activeAssetTab = ref<'characters' | 'scenes' | 'props'>('characters')
const promptInput = ref<HTMLTextAreaElement | null>(null)
const mentionOpen = ref(false)
const mentionQuery = ref('')
const mentionStart = ref(-1)
const mentionTab = ref<'assets' | 'tools'>('assets')
const continuityOpen = ref(false)
const draft = ref({
  actionText: '',
  visualPrompt: '',
  dialogueText: '',
  shotType: '',
  cameraAngle: '',
  composition: '',
  startVisualPrompt: '',
  endVisualPrompt: '',
})
const saving = ref(false)
const saveMessage = ref('')
const generating = ref(false)
const generationMessage = ref('')
const qualityReport = ref<{
  passed: boolean
  summary: string
  blockers: Array<{ code?: string; message?: string }>
  warnings: Array<{ code?: string; message?: string }>
} | null>(null)
const previewZoomed = ref(false)
const subtitleErased = ref(false)
const subtitleCleanupBusy = ref(false)
const subtitleCleanupMessage = ref('')
const subtitleCleanedVideoUrl = ref('')
const exportBusy = ref(false)
const exportMessage = ref('')
let videoPollTimer: number | null = null

type StudioAssetKind = 'character' | 'scene' | 'prop'
type StudioAsset = {
  key: string
  id: number
  kind: StudioAssetKind
  name: string
  subtitle: string
  imageUrl: string
  character?: CharacterDTO
  projectAsset?: ProjectAssetItemDTO
  node?: AssetNodeDTO
}

type MentionOption = StudioAsset | {
  key: string
  kind: 'tool'
  name: string
  subtitle: string
  icon: string
}

function queryNumber(value: LocationQueryValue | LocationQueryValue[] | undefined): number | undefined {
  if (value == null) return undefined
  const parsed = Number(Array.isArray(value) ? value[0] : value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

const projectId = computed(() => queryNumber(route.query.projectId) ?? 0)
const episodeNo = computed(() => queryNumber(route.query.episodeNo) ?? 1)
const context = computed(() => snapshot.value?.context)
const currentShots = computed<ShotSummary[]>(() => {
  const scenes = snapshot.value?.scenesRaw.filter((scene) => (scene.episodeNo ?? 1) === episodeNo.value) || []
  return scenes
    .flatMap((scene) => snapshot.value?.shotSummariesByScene[scene.id] || [])
    .sort((a, b) => Number(a.shotNo) - Number(b.shotNo))
})
const episodeClips = computed(() => buildEpisodeClips(episodeScenes.value, currentShots.value))
const activeClip = computed(() => episodeClips.value.find((clip) => clip.id === selectedClipId.value) || episodeClips.value[0] || null)
const visibleShots = computed(() => activeClip.value?.shots || [])
const selectedShot = computed(() => currentShots.value.find((shot) => shot.storyboardId === selectedShotId.value) || null)
const continuityCandidates = computed(() => {
  const index = currentShots.value.findIndex((shot) => shot.storyboardId === selectedShotId.value)
  return index > 0 ? currentShots.value.slice(0, index).reverse() : []
})
const pendingVideo = computed(() => detail.value?.videoCandidates
  .filter((item) => item.status === 'candidate' && Boolean(item.url))
  .sort((left, right) => right.versionNo - left.versionNo || right.id - left.id)[0] || null)
const previewVideo = computed(() => pendingVideo.value || detail.value?.currentVideo || null)
const visibleVideoCandidates = computed(() => previewVideo.value ? [previewVideo.value] : [])
const adoptingVideoId = ref<number | null>(null)
const selectedVideoUrl = computed(() => subtitleCleanedVideoUrl.value || previewVideo.value?.url || selectedShot.value?.videoUrl || '')
const episodeScenes = computed(() => snapshot.value?.scenesRaw.filter((scene) => (scene.episodeNo ?? 1) === episodeNo.value) || [])
const episodeCharacterIds = computed(() => new Set(
  episodeStoryboards.value
    .map((shot) => Number(shot.characterId || 0))
    .filter((id) => id > 0),
))
const episodeCharacterNames = computed(() => new Set(
  episodeStoryboards.value
    .map((shot) => String(shot.characterName || '').trim())
    .filter(Boolean),
))
function nodePreviewUrl(node: AssetNodeDTO | undefined): string {
  if (!node) return ''
  const image = node.confirmedImage || [...node.images].sort((a, b) => b.versionNo - a.versionNo || b.id - a.id)[0]
  return image?.thumbnailUrl || image?.imageUrl || ''
}
const relevantCharacters = computed(() => {
  const filtered = projectCharacters.value.filter((character) =>
    episodeCharacterIds.value.has(character.id) || episodeCharacterNames.value.has(character.name),
  )
  return filtered.length ? filtered : projectCharacters.value.filter((character) => character.referenceImageUrl)
})
const sceneNodeAssets = computed<StudioAsset[]>(() =>
  assetNodes.value
    .filter((node) => node.nodeType === 'scene' && node.lifecycleStatus !== 'archived')
    .map((node) => ({
      key: `node-${node.id}`,
      id: node.id,
      kind: 'scene',
      name: node.label,
      subtitle: node.state === 'ready' ? '已生成待确认' : node.appearanceLabel || '场景资产',
      imageUrl: nodePreviewUrl(node),
      node,
    })),
)
const propNodeAssets = computed<StudioAsset[]>(() =>
  assetNodes.value
    .filter((node) => (node.nodeType === 'prop' || node.nodeType === 'material') && node.lifecycleStatus !== 'archived')
    .map((node) => ({
      key: `node-${node.id}`,
      id: node.id,
      kind: 'prop',
      name: node.label,
      subtitle: node.state === 'ready'
        ? '已生成待确认'
        : node.nodeType === 'material' ? '素材资产' : '道具资产',
      imageUrl: nodePreviewUrl(node),
      node,
    })),
)
const fallbackSceneAssets = computed<StudioAsset[]>(() => {
  const seen = new Set<number>()
  return projectAssets.value
    .filter((asset) => asset.assetType === 'image' && (asset.sceneNo === episodeNo.value || !asset.sceneNo))
    .filter((asset) => {
      const key = Number(asset.sceneId || asset.id)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((asset) => {
      const scene = episodeScenes.value.find((item) => item.id === asset.sceneId)
      return {
        key: `image-${asset.id}`,
        id: asset.id,
        kind: 'scene',
        name: scene?.title || asset.sceneTitle || `第 ${asset.sceneNo || episodeNo.value} 集场景`,
        subtitle: asset.subtitle || '已生成场景画面',
        imageUrl: asset.previewUrl || '',
        projectAsset: asset,
      }
    })
})
const characterAssets = computed<StudioAsset[]>(() =>
  relevantCharacters.value.map((character) => {
    const node = assetNodes.value.find((item) => item.nodeType === 'character' && item.refId === character.id)
    return {
      key: `character-${character.id}`,
      id: character.id,
      kind: 'character',
      name: character.name,
      subtitle: node?.state === 'ready' ? '已生成待确认' : character.roleTag || '角色资产',
      imageUrl: nodePreviewUrl(node) || character.referenceImageUrl || characterImageOverrides.value[character.id] || '',
      character,
      node,
    }
  }),
)
const sceneAssets = computed<StudioAsset[]>(() => sceneNodeAssets.value.length ? sceneNodeAssets.value : fallbackSceneAssets.value)
const propAssets = computed<StudioAsset[]>(() => propNodeAssets.value)
const filteredAssets = computed(() => {
  if (activeAssetTab.value === 'characters') return characterAssets.value
  if (activeAssetTab.value === 'scenes') return sceneAssets.value
  return propAssets.value
})
const allStudioAssets = computed(() => [...characterAssets.value, ...sceneAssets.value, ...propAssets.value])
const assetCounts = computed(() => ({
  characters: characterAssets.value.length,
  scenes: sceneAssets.value.length,
  props: propAssets.value.length,
}))
const mentionAssetOptions = computed<StudioAsset[]>(() => {
  const query = mentionQuery.value.trim().toLocaleLowerCase('zh-CN')
  return allStudioAssets.value.filter((asset) =>
    !query || `${asset.name} ${asset.subtitle}`.toLocaleLowerCase('zh-CN').includes(query),
  ).slice(0, 10)
})
const mentionToolOptions = computed<MentionOption[]>(() => {
  const query = mentionQuery.value.trim().toLocaleLowerCase('zh-CN')
  return ([
    { key: 'tool-time', kind: 'tool', name: '添加时间', subtitle: '插入片段时长标签', icon: 'schedule' },
    { key: 'tool-transition', kind: 'tool', name: '片段衔接', subtitle: '继承上一镜尾帧作为本镜首帧', icon: 'link' },
    { key: 'tool-frame-reference', kind: 'tool', name: '首尾帧参考', subtitle: '把上一镜尾帧接到本镜首帧', icon: 'compare_arrows' },
    { key: 'tool-ambience', kind: 'tool', name: '环境音', subtitle: '补充空间与情绪节拍', icon: 'graphic_eq' },
  ] as MentionOption[]).filter((tool) => !query || `${tool.name} ${tool.subtitle}`.toLocaleLowerCase('zh-CN').includes(query))
})
const mentionOptions = computed<MentionOption[]>(() => {
  return (mentionTab.value === 'assets' ? mentionAssetOptions.value : mentionToolOptions.value).slice(0, 8)
})
const referencedAssets = computed(() =>
  allStudioAssets.value.filter((asset) => draft.value.visualPrompt.includes(`@${asset.name}`)),
)
const referencedAssetPayload = computed(() => referencedAssets.value.map((asset) => ({
  id: asset.id,
  refId: asset.node?.refId || asset.character?.id || null,
  characterId: asset.character?.id || null,
  sceneViewKey: asset.kind === 'scene' ? asset.node?.confirmedImage?.viewKey || null : null,
  key: asset.key,
  kind: asset.kind,
  name: asset.name,
  imageUrl: asset.imageUrl || null,
  promptText: asset.node?.promptText || null,
  appearance: asset.character?.appearance || asset.node?.appearanceLabel || null,
  costume: asset.character?.costume || null,
  voiceProfileKey: asset.character?.voiceProfileKey || null,
  voiceLocked: asset.character?.voiceLocked === true,
  referenceAudioUrl: asset.character?.referenceAudioUrl || null,
  viewKeys: asset.kind === 'character'
    ? (asset.node?.viewItems || []).filter((item) => item.viewSetType === 'character-turnaround').map((item) => item.viewKey)
    : [],
  viewSetVersion: asset.kind === 'character'
    ? asset.node?.images
        .filter((image) => image.viewSetType === 'character-turnaround' && image.status === 'confirmed')
        .sort((a, b) => Number(b.viewSetVersion || 0) - Number(a.viewSetVersion || 0))[0]?.viewSetVersion || null
    : null,
  versionNo: asset.node?.confirmedImage?.versionNo || null,
})))
const referencedMentionTools = computed(() =>
  mentionToolOptions.value
    .filter((tool) => draft.value.visualPrompt.includes(`@${tool.name}`))
    .map((tool) => ({ key: tool.key, name: tool.name })),
)
const referencedVoiceBindings = computed(() =>
  referencedAssets.value
    .filter((asset) => asset.kind === 'character' && asset.character)
    .map((asset) => ({
      characterId: asset.character?.id || null,
      characterName: asset.name,
      voiceProfileKey: asset.character?.voiceProfileKey || null,
      voiceLocked: asset.character?.voiceLocked === true,
      referenceAudioUrl: asset.character?.referenceAudioUrl || null,
    })),
)
const assetEditorCharacter = computed(() => assetEditor.value?.character || null)
const editorVoiceProfiles = computed(() => {
  const gender = assetEditorCharacter.value?.gender
  if (gender !== 'male' && gender !== 'female') return voiceProfiles.value
  return voiceProfiles.value.filter((profile) => profile.gender === gender || profile.gender === 'neutral')
})
const assetEditorImageUrl = computed(() => assetEditor.value?.imageUrl || '')
const confirmedVideoCount = computed(() => currentShots.value.filter((shot) => {
  if (shot.videoUrl) return true
  return (videoCandidatesByStoryboard.value.get(shot.storyboardId) || []).some((video) => video.status === 'confirmed')
}).length)
const candidateVideoCount = computed(() => currentShots.value.filter((shot) =>
  (videoCandidatesByStoryboard.value.get(shot.storyboardId) || []).some((video) => video.status === 'candidate'),
).length)
const completedShots = computed(() => confirmedVideoCount.value)
const episodeReadyForExport = computed(() =>
  currentShots.value.length > 0 && completedShots.value === currentShots.value.length,
)
const currentShotVoiceState = computed(() => {
  return getShotVoiceBindingState(projectCharacters.value, {
    allowedEntities: detail.value?.continuity.allowedEntities,
    visualPrompt: draft.value.visualPrompt,
    dialogueText: draft.value.dialogueText,
  })
})

async function registerProductionAgentAction(
  stageKey: 'voice' | 'video' | 'quality' | 'delivery',
  inputSnapshot: Record<string, unknown>,
  outputSnapshot: Record<string, unknown> = {},
  status: 'waiting_approval' | 'completed' = 'waiting_approval',
): Promise<void> {
  const runId = Number(route.query.pipelineRunId || 0)
  if (!runId) return
  const fingerprint = JSON.stringify({ projectId: projectId.value, episodeNo: episodeNo.value, stageKey, inputSnapshot })
  const encoded = btoa(unescape(encodeURIComponent(fingerprint))).slice(0, 120)
  await registerAgentPipelineStageAction(runId, {
    stageKey,
    idempotencyKey: `pipeline:${runId}:${stageKey}:${encoded}`,
    inputSnapshot,
    outputSnapshot,
    status,
  })
}

async function loadPage(): Promise<void> {
  if (!projectId.value) {
    loadError.value = '缺少项目参数，请从分镜视频生成进入。'
    loading.value = false
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    const [studio, characters, assets, canvas, voices] = await Promise.all([
      loadStudioSnapshot({ projectId: projectId.value, episodeNo: episodeNo.value }),
      listCharacters(projectId.value).catch(() => [] as CharacterDTO[]),
      getProjectAssets(projectId.value).catch(() => ({ items: [] as ProjectAssetItemDTO[] })),
      getAssetCanvas(projectId.value).catch(() => ({ nodes: [] } as { nodes: AssetNodeDTO[] })),
      listVoiceProfiles().catch(() => ({ items: [] as VoiceProfileDTO[] })),
    ])
    snapshot.value = studio
    projectCharacters.value = characters
    projectAssets.value = assets.items
    assetNodes.value = canvas.nodes
    voiceProfiles.value = voices.items
    episodeStoryboards.value = (
      await Promise.all(currentShots.value.map((shot) => getStoryboard(shot.storyboardId).catch(() => null)))
    ).filter((shot): shot is StoryboardDTO => Boolean(shot))
    const videoEntries = await Promise.all(currentShots.value.map(async (shot) => [
      shot.storyboardId,
      await listStoryboardVideos(shot.storyboardId).catch(() => []),
    ] as const))
    videoCandidatesByStoryboard.value = new Map(videoEntries)
    const imageEntries = await Promise.all(
      characters.map(async (character) => {
        if (character.referenceImageUrl) return [character.id, character.referenceImageUrl] as const
        const images = await listCharacterImages(character.id).catch(() => [])
        const usable = [...images]
          .filter((image) => Boolean(image.thumbnailUrl || image.imageUrl))
          .sort((a, b) => Number(b.status === 'confirmed') - Number(a.status === 'confirmed') || b.versionNo - a.versionNo)
        const image = usable[0]
        return image ? [character.id, image.thumbnailUrl || image.imageUrl] as const : null
      }),
    )
    characterImageOverrides.value = Object.fromEntries(imageEntries.filter((entry): entry is readonly [number, string] => Boolean(entry)))
    const requestedStoryboardId = queryNumber(route.query.storyboardId)
    const requestedShot = requestedStoryboardId
      ? currentShots.value.find((shot) => shot.storyboardId === requestedStoryboardId)
      : null
    const first = requestedShot || currentShots.value[0]
    await selectShot(first?.storyboardId ?? null)
  } catch (cause) {
    loadError.value = cause instanceof Error ? cause.message : '分镜创作页加载失败'
  } finally {
    loading.value = false
  }
}

async function hydrateDraft(storyboardId: number): Promise<void> {
  const shot = await getStoryboard(storyboardId)
  draft.value = {
    actionText: shot.actionText || '',
    visualPrompt: shot.visualPrompt || [shot.actionText, shot.dialogueText].filter(Boolean).join('；'),
    dialogueText: shot.dialogueText || '',
    shotType: shot.shotType || '',
    cameraAngle: shot.cameraAngle || '',
    composition: shot.composition || '',
    startVisualPrompt: shot.startVisualPrompt || '',
    endVisualPrompt: shot.endVisualPrompt || '',
  }
  saveMessage.value = ''
}

async function loadDetail(storyboardId: number): Promise<void> {
  const shot = currentShots.value.find((item) => item.storyboardId === storyboardId)
  if (!shot || !snapshot.value) {
    detail.value = null
    return
  }
  detailLoading.value = true
  try {
    const index = currentShots.value.findIndex((item) => item.storyboardId === storyboardId)
    const previous = index > 0 ? (currentShots.value[index - 1] ?? null) : null
    detail.value = await loadShotDetail(shot, previous, snapshot.value.audioByStoryboard, snapshot.value.costLedger)
  } catch {
    detail.value = null
  } finally {
    detailLoading.value = false
  }
}

async function selectShot(storyboardId: number | null): Promise<void> {
  selectedShotId.value = storyboardId
  const shot = currentShots.value.find((item) => item.storyboardId === storyboardId)
  if (shot) selectedClipId.value = shot.sceneId
  subtitleCleanedVideoUrl.value = ''
  subtitleCleanupMessage.value = ''
  subtitleErased.value = false
  if (!storyboardId) {
    detail.value = null
    return
  }
  await Promise.all([hydrateDraft(storyboardId), loadDetail(storyboardId)])
}

async function selectClip(sceneId: number): Promise<void> {
  selectedClipId.value = sceneId
  const firstShot = currentShots.value.find((shot) => shot.sceneId === sceneId)
  await selectShot(firstShot?.storyboardId ?? null)
}

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

async function saveDraft(): Promise<void> {
  if (!selectedShotId.value || saving.value) return
  saving.value = true
  saveMessage.value = ''
  try {
    await updateStoryboard(selectedShotId.value, {
      ...draft.value,
      videoPrompt: draft.value.visualPrompt,
      // Keep legacy fields in the database for subtitle/audio compatibility;
      // the single video prompt is the only visible editing surface.
      actionText: undefined,
      dialogueText: undefined,
    })
    saveMessage.value = '分镜脚本已保存'
    await loadDetail(selectedShotId.value)
  } catch (cause) {
    saveMessage.value = cause instanceof Error ? cause.message : '保存失败，请稍后重试'
  } finally {
    saving.value = false
  }
}

function insertPromptToken(token: string): void {
  const input = promptInput.value
  if (!input) {
    draft.value.visualPrompt = `${draft.value.visualPrompt}${draft.value.visualPrompt ? ' ' : ''}@${token} `
  } else {
    const caret = input.selectionStart ?? draft.value.visualPrompt.length
    const start = mentionStart.value >= 0 ? mentionStart.value : caret
    const before = draft.value.visualPrompt.slice(0, start)
    const after = draft.value.visualPrompt.slice(caret)
    draft.value.visualPrompt = `${before}@${token} ${after}`
  }
  mentionOpen.value = false
  mentionQuery.value = ''
  mentionStart.value = -1
  nextTick(() => promptInput.value?.focus())
}

function insertToken(token: string): void {
  if (token === '片段衔接') {
    continuityOpen.value = true
    mentionOpen.value = false
    return
  }
  insertPromptToken(token)
}

function selectContinuityShot(shot: ShotSummary): void {
  insertPromptToken(`片段衔接[镜头${shot.shotNo}]`)
  continuityOpen.value = false
}

function onPromptInput(event: Event): void {
  const input = event.target as HTMLTextAreaElement
  const caret = input.selectionStart ?? input.value.length
  const beforeCaret = input.value.slice(0, caret)
  const at = beforeCaret.lastIndexOf('@')
  if (at < 0) {
    mentionOpen.value = false
    return
  }
  const query = beforeCaret.slice(at + 1)
  if (/\s/.test(query)) {
    mentionOpen.value = false
    return
  }
  mentionStart.value = at
  mentionQuery.value = query
  if (!mentionOpen.value) mentionTab.value = 'assets'
  mentionOpen.value = true
}

function selectMention(option: MentionOption): void {
  if (option.kind === 'tool' && option.name === '片段衔接') {
    continuityOpen.value = true
    mentionOpen.value = false
    mentionQuery.value = ''
    return
  }
  const input = promptInput.value
  if (!input || option.kind === 'tool') {
    insertToken(option.name)
    return
  }
  const caret = input.selectionStart ?? draft.value.visualPrompt.length
  const start = mentionStart.value >= 0 ? mentionStart.value : draft.value.visualPrompt.lastIndexOf('@', caret)
  const before = draft.value.visualPrompt.slice(0, Math.max(0, start))
  const after = draft.value.visualPrompt.slice(caret)
  draft.value.visualPrompt = `${before}@${option.name} ${after}`
  mentionOpen.value = false
  mentionQuery.value = ''
  nextTick(() => {
    input.focus()
    const nextCaret = before.length + option.name.length + 2
    input.setSelectionRange(nextCaret, nextCaret)
  })
}

function closeMention(): void {
  window.setTimeout(() => {
    mentionOpen.value = false
  }, 120)
}

async function generateVideo(): Promise<void> {
  if (!selectedShotId.value || generating.value) return
  generating.value = true
  qualityReport.value = null
  generationMessage.value = '正在提交生成任务…'
  try {
    await saveDraft()
    const shotIndex = currentShots.value.findIndex((shot) => shot.storyboardId === selectedShotId.value)
    const previousShot = shotIndex > 0 ? currentShots.value[shotIndex - 1] : null
    const mentionTools = [...referencedMentionTools.value]
    if (previousShot?.videoUrl && !mentionTools.some((tool) => tool.name === '片段衔接')) {
      mentionTools.push({ key: 'continuity', name: '片段衔接' })
    }
    const job = await generateStoryboardVideos(selectedShotId.value, {
      prompt: draft.value.visualPrompt,
      referencedAssets: referencedAssetPayload.value,
      mentionTools,
      voiceBindings: referencedVoiceBindings.value,
      durationSeconds: selectedShot.value?.durationSeconds || undefined,
      candidateCount: 1,
      autoConfirm: false,
      // 第一镜没有上一镜尾帧时，用当前已确认静帧作为唯一首帧。
      startImageUrl: detail.value?.currentImage?.url || selectedShot.value?.imageUrl || null,
    })
    await registerProductionAgentAction(
      'video',
      { storyboardId: selectedShotId.value, prompt: draft.value.visualPrompt, referencedAssets: referencedAssetPayload.value },
      { storyboardId: selectedShotId.value, submitted: true },
    )
    await registerProductionAgentAction(
      'quality',
      { storyboardId: selectedShotId.value, videoSubmission: true },
      { pendingReview: true },
    )
    generationMessage.value = '任务已提交，正在等待视频模型返回结果…'
    void pollVideoGenerationJob(job.id, selectedShotId.value)
  } catch (cause) {
    const error = cause as Error & { qualityReport?: typeof qualityReport.value }
    qualityReport.value = error.qualityReport || null
    generationMessage.value = error.message || '视频生成失败，请检查服务状态'
    generating.value = false
  }
}

async function pollVideoGenerationJob(jobId: number, storyboardId: number, attempt = 0): Promise<void> {
  try {
    const job = await getGenerationJob(jobId)
    if (job.status === 'success') {
      const [videos, refreshed] = await Promise.all([
        listStoryboardVideos(storyboardId),
        loadDetailForStoryboard(storyboardId),
      ])
      const next = new Map(videoCandidatesByStoryboard.value)
      next.set(storyboardId, videos)
      videoCandidatesByStoryboard.value = next
      if (selectedShotId.value === storyboardId) {
        detail.value = refreshed
      }
      generating.value = false
      generationMessage.value = selectedShotId.value === storyboardId
        ? `单条视频已生成（${job.result?.item?.durationSeconds || '—'} 秒），等待你采用；不满意可重新生成替换这条待采用视频。`
        : '单条视频已生成，等待你采用；不满意可重新生成替换这条待采用视频。'
      return
    }
    if (job.status === 'failed' || job.status === 'canceled') {
      generating.value = false
      generationMessage.value = job.errorText || (job.status === 'canceled' ? '视频任务已取消' : '视频生成失败，请检查任务详情后重试')
      return
    }
    if (attempt >= 180) {
      generating.value = false
      generationMessage.value = '视频仍在后台处理中；候选完成后重新进入本页即可读取，不会重复提交任务。'
      return
    }
    videoPollTimer = window.setTimeout(() => void pollVideoGenerationJob(jobId, storyboardId, attempt + 1), 5000)
  } catch {
    if (attempt >= 180) {
      generating.value = false
      generationMessage.value = '暂时无法读取任务状态。任务仍可能在后台运行，请稍后重新进入页面，不要重复提交。'
      return
    }
    videoPollTimer = window.setTimeout(() => void pollVideoGenerationJob(jobId, storyboardId, attempt + 1), 5000)
  }
}

async function adoptVideo(videoId: number): Promise<void> {
  if (adoptingVideoId.value || generating.value) return
  const targetStoryboardId = selectedShotId.value
  if (!targetStoryboardId) return
  adoptingVideoId.value = videoId
  generationMessage.value = '正在采用当前视频…'
  try {
    await confirmVideo(videoId)
    const videos = await listStoryboardVideos(targetStoryboardId)
    const next = new Map(videoCandidatesByStoryboard.value)
    next.set(targetStoryboardId, videos)
    videoCandidatesByStoryboard.value = next
    if (selectedShotId.value === targetStoryboardId) {
      detail.value = await loadDetailForStoryboard(targetStoryboardId)
      generationMessage.value = '当前视频已采用；后续重新生成不会覆盖它，直到你采用新视频。'
    }
  } catch (cause) {
    generationMessage.value = cause instanceof Error ? cause.message : '采用视频失败，请重试'
  } finally {
    adoptingVideoId.value = null
  }
}

async function loadDetailForStoryboard(storyboardId: number): Promise<ShotProductionDetail> {
  const shot = currentShots.value.find((item) => item.storyboardId === storyboardId)
  if (!shot || !snapshot.value) throw new Error('当前镜头已离开本集，无法刷新候选')
  const index = currentShots.value.findIndex((item) => item.storyboardId === storyboardId)
  const previous = index > 0 ? currentShots.value[index - 1] ?? null : null
  return loadShotDetail(shot, previous, snapshot.value.audioByStoryboard, snapshot.value.costLedger)
}

function openAssetEditor(asset: StudioAsset): void {
  assetEditor.value = asset
  assetPrompt.value = asset.node?.promptText ||
    (asset.character?.appearance ? `${asset.character.appearance}；` : '') +
    '保持身份、外观材质、色彩关系与当前剧本设定一致；补充本镜头中的姿态、情绪和光线。'
  assetMessage.value = ''
  const boundVoice = voiceProfiles.value.find((profile) => profile.profileKey === asset.character?.voiceProfileKey)
  const characterGender = asset.character?.gender
  const boundVoiceMatchesGender = !characterGender || characterGender === 'neutral' ||
    boundVoice?.gender === characterGender || boundVoice?.gender === 'neutral'
  voiceProfileKey.value = boundVoiceMatchesGender ? boundVoice?.profileKey || '' : ''
  if (!voiceProfileKey.value) {
    const matchingProfiles = voiceProfiles.value.filter((profile) =>
      !characterGender || characterGender === 'neutral'
        ? true
        : profile.gender === characterGender || profile.gender === 'neutral',
    )
    const ageGroup = asset.character?.ageGroup
    const ageMatch = matchingProfiles.find((profile) => ageGroup && profile.ageGroups.includes(ageGroup))
    voiceProfileKey.value = (ageMatch || matchingProfiles[0])?.profileKey || ''
  }
  voiceStyle.value = asset.character?.voiceStyle || ''
  referenceAudioUrl.value = asset.character?.referenceAudioUrl || ''
  referenceAudioName.value = referenceAudioUrl.value ? '已上传参考音频' : ''
  voicePreviewUrl.value = ''
  voicePreviewProfileKey.value = ''
  voicePreviewReady.value = false
  voiceMessage.value = ''
}

async function saveAsset(): Promise<void> {
  if (!assetEditor.value || assetSaving.value) return
  assetSaving.value = true
  assetMessage.value = '正在保存本镜提示词…'
  try {
    if (assetEditor.value.node) {
      const updated = await updateAssetNode(assetEditor.value.node.id, { promptText: assetPrompt.value.trim() })
      const index = assetNodes.value.findIndex((node) => node.id === updated.id)
      if (index >= 0) assetNodes.value[index] = updated
      assetEditor.value.node = updated
    }
    const marker = `【${assetEditor.value.kind === 'character' ? '角色' : assetEditor.value.kind === 'scene' ? '场景' : '道具'}：${assetEditor.value.name}】`
    const withoutPrevious = draft.value.visualPrompt
      .split('\n')
      .filter((line) => !line.startsWith(marker))
      .join('\n')
      .trim()
    draft.value.visualPrompt = `${withoutPrevious}${withoutPrevious ? '\n' : ''}${marker}\n${assetPrompt.value.trim()}`.trim()
    assetMessage.value = '提示词已写入当前镜头，点击“保存脚本”后正式落库'
  } catch (cause) {
    assetMessage.value = cause instanceof Error ? cause.message : '提示词保存失败'
  } finally {
    assetSaving.value = false
  }
}

async function bindEditorVoice(): Promise<void> {
  const character = assetEditorCharacter.value
  if (!character || !voiceProfileKey.value || voiceBusy.value) return
  voiceBusy.value = true
  voiceMessage.value = ''
  try {
    const result = await bindCharacterVoice(character.id, {
      voiceProfileKey: voiceProfileKey.value,
      voiceStyle: voiceStyle.value.trim() || null,
      locked: true,
    })
    const index = projectCharacters.value.findIndex((item) => item.id === character.id)
    if (index >= 0) projectCharacters.value[index] = result.character
    if (assetEditor.value) assetEditor.value.character = result.character
    await registerProductionAgentAction(
      'voice',
      { characterId: character.id, voiceProfileKey: voiceProfileKey.value, voiceStyle: voiceStyle.value.trim() },
      { characterId: character.id, locked: true },
    )
    voiceMessage.value = '音色已绑定并锁定'
  } catch (cause) {
    voiceMessage.value = cause instanceof Error ? cause.message : '音色绑定失败'
  } finally {
    voiceBusy.value = false
  }
}

function pickReferenceAudio(): void {
  referenceAudioInput.value?.click()
}

async function generateAgentVoicePreview(): Promise<void> {
  const character = assetEditorCharacter.value
  if (!character || voiceBusy.value) return
  voiceBusy.value = true
  voicePreviewing.value = true
  voiceMessage.value = '声音 Agent 正在结合剧情设计声线并生成试听…'
  try {
    const result = await previewCharacterVoice(character.id, {
      voiceAgent: true,
      voiceStyle: voiceStyle.value.trim() || null,
      voiceProfileKey: voiceProfileKey.value || character.voiceProfileKey || undefined,
      text: `你好，我是${character.name}。这是根据当前剧情设计的角色声音试听。`,
    })
    voicePreviewUrl.value = result.audioUrl
    voiceProfileKey.value = result.voiceProfileKey || voiceProfileKey.value
    voicePreviewProfileKey.value = result.voiceProfileKey || ''
    voiceAgentDesign.value = result.voiceDesign || null
    voicePreviewReady.value = Boolean(result.audioUrl)
    voiceMessage.value = `声音 Agent 试听已生成：${result.voiceProfileName || result.voiceName}，请听完后确认绑定`
  } catch (cause) {
    voicePreviewReady.value = false
    voiceMessage.value = cause instanceof Error ? cause.message : '声音 Agent 生成失败'
  } finally {
    voiceBusy.value = false
    voicePreviewing.value = false
  }
}

async function bindVoiceAgentPreview(): Promise<void> {
  const character = assetEditorCharacter.value
  if (!character || !voicePreviewUrl.value || voiceBusy.value) return
  voiceBusy.value = true
  voiceMessage.value = '正在绑定已试听的声音…'
  try {
    const result = await previewCharacterVoice(character.id, {
      bindReferenceAudio: true,
      previewAudioUrl: voicePreviewUrl.value,
      voiceId: voiceAgentDesign.value?.voiceId || null,
      voiceProfileKey: voicePreviewProfileKey.value || voiceProfileKey.value || character.voiceProfileKey || undefined,
      voiceStyle: voiceStyle.value.trim() || null,
      voiceDesign: voiceAgentDesign.value,
    })
    if (result.character) {
      const index = projectCharacters.value.findIndex((item) => item.id === character.id)
      if (index >= 0) projectCharacters.value[index] = result.character
      if (assetEditor.value) assetEditor.value.character = result.character
      referenceAudioUrl.value = result.referenceAudioUrl || result.character.referenceAudioUrl || ''
      referenceAudioName.value = '声音 Agent 已确认'
    }
    voiceMessage.value = '声音 Agent 试听已确认，后续分镜会携带真实参考音频'
    if (voiceAgentDesign.value?.voiceId) {
      voiceMessage.value = `自定义音色已绑定并锁定（${voiceAgentDesign.value.voiceId}），后续对白复用该音色`
    }
  } catch (cause) {
    voiceMessage.value = cause instanceof Error ? cause.message : '声音绑定失败'
  } finally {
    voiceBusy.value = false
  }
}

async function onReferenceAudioChange(event: Event): Promise<void> {
  const character = assetEditorCharacter.value
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!character || !file) return
  if (!file.type.startsWith('audio/')) {
    voiceMessage.value = '请选择音频文件'
    return
  }
  if (file.size > 15 * 1024 * 1024) {
    voiceMessage.value = '参考音频不能超过 15MB'
    return
  }
  voiceBusy.value = true
  voiceMessage.value = '正在上传参考音频…'
  try {
    const dataBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(new Error('读取音频失败'))
      reader.readAsDataURL(file)
    })
    const result = await saveCharacterReferenceAudio(character.id, {
      fileName: file.name,
      mimeType: file.type,
      dataBase64,
    })
    const index = projectCharacters.value.findIndex((item) => item.id === character.id)
    if (index >= 0) projectCharacters.value[index] = result.character
    if (assetEditor.value) assetEditor.value.character = result.character
    referenceAudioName.value = file.name
    referenceAudioUrl.value = result.character.referenceAudioUrl || ''
    voiceMessage.value = '参考音频已保存'
  } catch (cause) {
    voiceMessage.value = cause instanceof Error ? cause.message : '参考音频上传失败'
  } finally {
    voiceBusy.value = false
  }
}

async function previewEditorVoice(): Promise<void> {
  const character = assetEditorCharacter.value
  if (!character || voiceBusy.value) return
  voiceBusy.value = true
  voicePreviewing.value = true
  try {
    const result = await previewCharacterVoice(character.id, {
      voiceProfileKey: voiceProfileKey.value || character.voiceProfileKey || undefined,
      voiceId: character.voiceLocked && character.voiceDesign?.provider === 'qwen'
        ? character.voiceDesign.voiceId || null
        : null,
      text: `你好，我是${character.name}。这是我的角色音色预览。`,
    })
    voicePreviewUrl.value = result.audioUrl
    voicePreviewProfileKey.value = result.voiceProfileKey || ''
    voicePreviewReady.value = false
    await nextTick()
    const audio = document.querySelector<HTMLAudioElement>('.studio-voice-preview')
    if (audio) {
      await new Promise<void>((resolve, reject) => {
        if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
          resolve()
          return
        }
        const onLoaded = () => {
          cleanup()
          resolve()
        }
        const onError = () => {
          cleanup()
          reject(new Error('音频文件无法访问，请重新生成试听'))
        }
        const cleanup = () => {
          audio.removeEventListener('loadedmetadata', onLoaded)
          audio.removeEventListener('error', onError)
        }
        audio.addEventListener('loadedmetadata', onLoaded, { once: true })
        audio.addEventListener('error', onError, { once: true })
        audio.load()
      })
      audio.currentTime = 0
      await audio.play().catch(() => undefined)
      voicePreviewReady.value = true
    }
    voiceMessage.value = voicePreviewReady.value ? '试听已生成' : '音频文件无法访问，请重新生成试听'
  } catch (cause) {
    voicePreviewReady.value = false
    voiceMessage.value = cause instanceof Error ? cause.message : '音色试听失败'
  } finally {
    voiceBusy.value = false
    voicePreviewing.value = false
  }
}

function backToEpisodes(): void {
  router.push({
    path: '/workspace/episodes',
    query: {
      projectId: String(projectId.value),
      ...(route.query.pipelineRunId
        ? { pipelineRunId: String(route.query.pipelineRunId) }
        : {}),
    },
  })
}

async function exportEpisode(): Promise<void> {
  if (!projectId.value || exportBusy.value || !episodeReadyForExport.value) return
  exportBusy.value = true
  exportMessage.value = '正在整理本集视频…'
  try {
    const pack = await getProjectDeliveryPackage(projectId.value, episodeNo.value)
    if (!pack.clips.length) throw new Error('本集还没有可导出的镜头')
    const result = await downloadProjectDeliveryArchive(projectId.value, episodeNo.value, { includeMedia: true })
    const anchor = document.createElement('a')
    anchor.href = URL.createObjectURL(result.blob)
    anchor.download = result.fileName
    anchor.click()
    URL.revokeObjectURL(anchor.href)
    await registerProductionAgentAction(
      'delivery',
      { episodeNo: episodeNo.value, includeMedia: true },
      { fileName: result.fileName, clipCount: pack.clips.length },
      'completed',
    )
    exportMessage.value = '本集已导出，可继续进入音频与剪辑流程'
  } catch (cause) {
    exportMessage.value = cause instanceof Error ? cause.message : '导出失败，请稍后重试'
  } finally {
    exportBusy.value = false
  }
}

onMounted(() => {
  void loadPage()
})

onBeforeUnmount(() => {
  if (videoPollTimer != null) window.clearTimeout(videoPollTimer)
  mentionOpen.value = false
  continuityOpen.value = false
})
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true">
    <section class="storyboard-studio" aria-labelledby="storyboard-studio-heading">
      <header class="storyboard-studio__topbar">
        <button type="button" class="storyboard-studio__back" @click="backToEpisodes">
          <span class="storyboard-studio__back-icon material-symbols-outlined">arrow_back</span>
          分集管理
        </button>
        <div class="storyboard-studio__identity">
          <span class="storyboard-studio__eyebrow">STORYBOARD VIDEO STUDIO</span>
           <h1 id="storyboard-studio-heading">{{ context?.projectName || '分镜视频创作' }}</h1>
          <span>项目 / 第 {{ episodeNo }} 集 / {{ episodeClips.length }} 个片段 · {{ context?.episodeTitle || '逐镜检查与生成' }}</span>
        </div>
        <div class="storyboard-studio__top-actions">
              <span class="storyboard-studio__progress" :aria-label="`${completedShots}/${currentShots.length} 镜已采用${candidateVideoCount ? `，${candidateVideoCount} 镜待采用` : ''}`">
            {{ completedShots }}/{{ currentShots.length }} 镜已采用
            <small v-if="candidateVideoCount"> · {{ candidateVideoCount }} 镜待采用</small>
          </span>
          <button
            v-if="episodeReadyForExport"
            type="button"
            class="storyboard-studio__export"
            :disabled="exportBusy"
            @click="exportEpisode"
          >
            <span class="material-symbols-outlined">download</span>
            {{ exportBusy ? '整理中' : '导出本集' }}
          </button>
        </div>
      </header>

      <nav v-if="!loading && !loadError" class="episode-clip-nav" aria-label="选择本集片段">
        <div class="episode-clip-nav__heading">
          <span class="studio-kicker">EPISODE / CLIPS</span>
          <strong>第 {{ episodeNo }} 集片段</strong>
          <small>每个场景作为一个片段，片段内镜头共用场景上下文</small>
        </div>
        <div class="episode-clip-nav__items">
          <button
            v-for="clip in episodeClips"
            :key="clip.id"
            type="button"
            class="episode-clip"
            :class="{ 'is-active': activeClip?.id === clip.id }"
            :aria-current="activeClip?.id === clip.id ? 'step' : undefined"
            @click="selectClip(clip.id)"
          >
            <span class="episode-clip__index">场 {{ String(clip.sceneNo).padStart(2, '0') }}</span>
            <strong>{{ clip.title }}</strong>
            <span class="episode-clip__meta">
              <span>{{ clip.shotCount }} 镜</span>
              <span>{{ formatAggregateDuration(clip.durationSeconds) }}</span>
              <span v-if="clip.location">{{ clip.location }}</span>
            </span>
            <small v-if="!clip.shotCount" class="episode-clip__empty">尚无分镜</small>
          </button>
          <p v-if="!episodeClips.length" class="episode-clip-nav__empty">本集还没有片段场景，请先完成剧本拆解与分镜生成。</p>
        </div>
      </nav>

      <div v-if="loading" class="storyboard-studio__state" role="status">
        <span class="material-symbols-outlined is-spin">progress_activity</span>
        正在同步本集分镜与资产…
      </div>
      <div v-else-if="loadError" class="storyboard-studio__state is-error" role="alert">
        <span class="material-symbols-outlined">error</span>
        {{ loadError }}
        <button type="button" @click="loadPage">重新加载</button>
      </div>
      <template v-else>
        <section class="storyboard-studio__workspace">
          <aside class="studio-panel studio-assets">
            <div class="studio-panel__head">
              <div>
                <span class="studio-kicker">ASSET DECK</span>
                <h1>本集资产</h1>
              </div>
              <span class="studio-panel__count">{{ allStudioAssets.length }}</span>
            </div>
            <p class="studio-panel__hint">
              当前集：第 {{ episodeNo }} 集
              <template v-if="context?.episodeTitle"> · {{ context.episodeTitle }}</template>
              <template v-if="selectedShot"> · 场景 {{ String(selectedShot.sceneNo).padStart(2, '0') }}</template>
            </p>
            <div class="studio-tabs" role="tablist" aria-label="资产分类">
              <button
                type="button"
                role="tab"
                :aria-selected="activeAssetTab === 'characters'"
                :class="{ 'is-active': activeAssetTab === 'characters' }"
                @click="activeAssetTab = 'characters'"
              >
                角色 <span>{{ assetCounts.characters }}</span>
              </button>
              <button
                type="button"
                role="tab"
                :aria-selected="activeAssetTab === 'scenes'"
                :class="{ 'is-active': activeAssetTab === 'scenes' }"
                @click="activeAssetTab = 'scenes'"
              >
                场景 <span>{{ assetCounts.scenes }}</span>
              </button>
              <button
                type="button"
                role="tab"
                :aria-selected="activeAssetTab === 'props'"
                :class="{ 'is-active': activeAssetTab === 'props' }"
                @click="activeAssetTab = 'props'"
              >
                道具 <span>{{ assetCounts.props }}</span>
              </button>
            </div>
            <div class="studio-asset-list">
              <button
                v-for="asset in filteredAssets"
                :key="asset.key"
                type="button"
                class="studio-asset"
                @click="openAssetEditor(asset)"
              >
                <span class="studio-asset__thumb">
                  <img v-if="asset.imageUrl" :src="asset.imageUrl" :alt="asset.name" loading="lazy" />
                  <span v-else class="studio-asset__missing"><span class="material-symbols-outlined">{{ asset.kind === 'character' ? 'person' : asset.kind === 'scene' ? 'landscape' : 'category' }}</span><small>待生成</small></span>
                </span>
                <span class="studio-asset__copy">
                  <strong>{{ asset.name }}</strong>
                  <small>{{ asset.subtitle }}</small>
                </span>
                <span class="material-symbols-outlined">tune</span>
              </button>
              <div v-if="!filteredAssets.length" class="studio-empty studio-empty--assets">
                <span class="material-symbols-outlined">inventory_2</span>
                <strong>该分类还没有可用资产</strong>
                <span>完成剧本解析或资产生成后，这里会自动同步。</span>
              </div>
            </div>
            <div class="studio-asset-tools">
              <span class="studio-kicker">TOOLS</span>
              <button type="button" @click="insertToken('片段衔接')">
                <span class="material-symbols-outlined">link</span>
                片段衔接
                <small>继承上一镜尾帧</small>
              </button>
              <button type="button" @click="insertToken('环境音')">
                <span class="material-symbols-outlined">graphic_eq</span>
                环境音
                <small>补充空间与情绪节拍</small>
              </button>
              <div v-if="continuityOpen" class="continuity-picker" role="dialog" aria-label="选择片段衔接来源">
                <div class="continuity-picker__head">
                  <strong>选择衔接来源</strong>
                  <button type="button" aria-label="关闭片段选择" @click="continuityOpen = false">
                    <span class="material-symbols-outlined">close</span>
                  </button>
                </div>
                <button
                  v-for="shot in continuityCandidates"
                  :key="`continuity-${shot.storyboardId}`"
                  type="button"
                  class="continuity-picker__option"
                  @click="selectContinuityShot(shot)"
                >
                  <span class="material-symbols-outlined">movie</span>
                  <span><strong>镜头 {{ shot.shotNo }}</strong><small>{{ shot.primaryAction || '上一镜结束状态' }}</small></span>
                  <span class="material-symbols-outlined">add</span>
                </button>
                <p v-if="!continuityCandidates.length" class="continuity-picker__empty">当前镜头前没有可衔接的片段</p>
              </div>
            </div>
          </aside>

          <section class="studio-panel studio-script">
            <div class="studio-panel__head">
              <div>
                <span class="studio-kicker">SHOT SCRIPT</span>
                <h1>{{ activeClip ? `场 ${String(activeClip.sceneNo).padStart(2, '0')} · ${activeClip.title}` : '分镜脚本' }}</h1>
                <p class="studio-panel__subhead">
                  {{ activeClip ? `${activeClip.location || '场景待绑定'} · ${activeClip.mood || '情绪待标注'} · ${activeClip.shotCount} 个连续镜头 / ${formatAggregateDuration(activeClip.durationSeconds)}` : '选择片段查看镜头' }}
                </p>
              </div>
              <span v-if="saveMessage" class="studio-save-state">{{ saveMessage }}</span>
            </div>
            <div class="shot-switcher" role="group" aria-label="选择镜头">
              <button
                v-for="shot in visibleShots"
                :key="shot.storyboardId"
                type="button"
                :class="{ 'is-active': selectedShotId === shot.storyboardId }"
                @click="selectShot(shot.storyboardId)"
              >
                <strong>{{ shot.shotNo }}</strong>
                <small>{{ formatShotDuration(shot.durationSeconds) }}</small>
              </button>
              <span v-if="!visibleShots.length" class="studio-empty">这个片段还没有分镜脚本</span>
            </div>
            <div v-if="selectedShot" class="studio-form">
              <div class="studio-form__meta studio-form__meta--agent">
                <label><span>景别 <em>Agent 已生成</em></span><input v-model="draft.shotType" placeholder="等待分镜 Agent 生成" /></label>
                <label><span>机位 <em>Agent 已生成</em></span><input v-model="draft.cameraAngle" placeholder="等待分镜 Agent 生成" /></label>
                <label><span>构图 <em>Agent 已生成</em></span><input v-model="draft.composition" placeholder="等待分镜 Agent 生成" /></label>
              </div>
              <label class="studio-field">
                    <span>视频提示词 <em>Agent 已生成，可微调 · 输入 @ 调用资产、工具和音色</em></span>
                <div class="studio-prompt-editor">
                  <textarea
                    ref="promptInput"
                    v-model="draft.visualPrompt"
                    rows="7"
                    placeholder="@角色、@场景、@道具、情绪微表演、动作、机位、运镜、对白、@音色、声音与口型同步、首尾帧承接"
                    @input="onPromptInput"
                    @keydown.esc="mentionOpen = false"
                    @blur="closeMention"
                  ></textarea>
                  <Transition name="mention-popover">
                    <div v-if="mentionOpen" class="mention-popover" role="listbox" aria-label="资产与工具">
                      <div class="mention-popover__head">
                        <div class="mention-popover__tabs" role="tablist" aria-label="插入分类">
                          <button
                            type="button"
                            role="tab"
                            :aria-selected="mentionTab === 'assets'"
                            :class="{ 'is-active': mentionTab === 'assets' }"
                            @mousedown.prevent="mentionTab = 'assets'"
                          >
                            <span class="material-symbols-outlined">inventory_2</span>
                            本集资产
                            <b>{{ allStudioAssets.length }}</b>
                          </button>
                          <button
                            type="button"
                            role="tab"
                            :aria-selected="mentionTab === 'tools'"
                            :class="{ 'is-active': mentionTab === 'tools' }"
                            @mousedown.prevent="mentionTab = 'tools'"
                          >
                            <span class="material-symbols-outlined">auto_awesome</span>
                            小工具
                            <b>{{ mentionToolOptions.length }}</b>
                          </button>
                        </div>
                        <small>{{ mentionQuery ? `匹配“${mentionQuery}”` : mentionTab === 'assets' ? '角色 · 场景 · 道具' : '让镜头更完整' }}</small>
                      </div>
                      <button
                        v-for="option in mentionOptions"
                        :key="option.key"
                        type="button"
                        class="mention-option"
                        role="option"
                        @mousedown.prevent="selectMention(option)"
                      >
                        <span class="mention-option__thumb">
                          <img v-if="option.kind !== 'tool' && option.imageUrl" :src="option.imageUrl" :alt="option.name" />
                          <span v-else class="mention-option__missing"><span class="material-symbols-outlined">{{ option.kind === 'tool' ? option.icon : option.kind === 'character' ? 'person' : option.kind === 'scene' ? 'landscape' : 'category' }}</span><small v-if="option.kind !== 'tool'">待生成</small></span>
                        </span>
                        <span class="mention-option__copy">
                          <strong>{{ option.name }}</strong>
                          <small>{{ option.subtitle }}</small>
                        </span>
                        <span class="material-symbols-outlined">add</span>
                      </button>
                      <div v-if="!mentionOptions.length" class="mention-popover__empty">
                        {{ mentionTab === 'assets' ? '本集还没有匹配的角色、场景或道具' : '没有匹配的小工具' }}
                      </div>
                    </div>
                  </Transition>
                </div>
                <div v-if="referencedAssets.length" class="prompt-references" aria-label="当前镜头引用资产">
                  <button
                    v-for="asset in referencedAssets"
                    :key="asset.key"
                    type="button"
                    class="prompt-reference"
                    @click="openAssetEditor(asset)"
                  >
                    <span class="prompt-reference__thumb">
                      <img v-if="asset.imageUrl" :src="asset.imageUrl" :alt="asset.name" />
                      <span v-else class="prompt-reference__missing"><span class="material-symbols-outlined">{{ asset.kind === 'character' ? 'person' : 'landscape' }}</span><small>待生成</small></span>
                    </span>
                    <span><small>{{ asset.kind === 'character' ? '角色' : asset.kind === 'scene' ? '场景' : '道具' }}</small><strong>{{ asset.name }}</strong></span>
                    <span class="material-symbols-outlined">tune</span>
                  </button>
                </div>
              </label>
              <div class="studio-script-actions">
                <button type="button" class="studio-button studio-button--quiet" :disabled="saving" @click="saveDraft">
                  <span class="material-symbols-outlined">save</span>
                  {{ saving ? '保存中' : '保存脚本' }}
                </button>
                <button type="button" class="studio-button studio-button--primary" :disabled="generating" @click="generateVideo">
                  <span class="material-symbols-outlined" :class="{ 'is-spin': generating }">{{ generating ? 'progress_activity' : 'movie_creation' }}</span>
                  {{ generating ? '提交中' : previewVideo ? '不满意，重新生成' : '立即生成视频' }}
                </button>
              </div>
              <p v-if="generationMessage" class="studio-feedback" role="status">{{ generationMessage }}</p>
              <section v-if="qualityReport" class="studio-quality-report" aria-live="polite">
                <div class="studio-quality-report__head">
                  <span class="material-symbols-outlined">{{ qualityReport.passed ? 'check_circle' : 'gpp_maybe' }}</span>
                  <strong>质检 Agent</strong>
                  <span>{{ qualityReport.passed ? '已通过' : '需要处理' }}</span>
                </div>
                <p>{{ qualityReport.summary }}</p>
                <ul v-if="qualityReport.blockers.length">
                  <li v-for="item in qualityReport.blockers" :key="`${item.code}-${item.message}`">{{ item.message }}</li>
                </ul>
                <ul v-if="qualityReport.warnings.length" class="studio-quality-report__warnings">
                  <li v-for="item in qualityReport.warnings" :key="`${item.code}-${item.message}`">{{ item.message }}</li>
                </ul>
              </section>
            </div>
            <div v-else class="studio-empty studio-empty--script">
              <span class="material-symbols-outlined">movie_edit</span>
              <strong>等待分镜脚本</strong>
              <span>返回分集管理生成本集分镜脚本后，这里会逐镜展开。</span>
            </div>
          </section>

          <aside class="studio-panel studio-preview">
            <div class="studio-panel__head">
              <div>
                <span class="studio-kicker">PREVIEW MONITOR</span>
                <h1>视频预览</h1>
              </div>
              <button type="button" class="studio-icon-button" :title="previewZoomed ? '退出放大' : '放大预览'" @click="previewZoomed = !previewZoomed">
                <span class="material-symbols-outlined">{{ previewZoomed ? 'close_fullscreen' : 'fullscreen' }}</span>
              </button>
            </div>
            <div class="preview-player" :class="{ 'is-zoomed': previewZoomed }">
              <video v-if="selectedVideoUrl" :src="selectedVideoUrl" controls playsinline></video>
              <div v-else class="studio-empty">
                <span class="material-symbols-outlined">movie</span>
                  <strong>{{ detailLoading ? '正在读取镜头' : '等待视频生成' }}</strong>
                  <span>当前镜头生成完成后会在这里预览。</span>
              </div>
              <div v-if="selectedVideoUrl && detail?.currentVideo" class="preview-tools">
                <button type="button" :class="{ 'is-active': subtitleErased }" :disabled="subtitleCleanupBusy" @click="removeSubtitles">
                  <span class="material-symbols-outlined">subtitles_off</span>
                  {{ subtitleCleanupBusy ? '处理中' : subtitleErased ? '已生成无字幕版' : '生成无字幕版' }}
                </button>
                <button type="button" @click="previewZoomed = true">
                  <span class="material-symbols-outlined">zoom_in</span>
                  放大查看
                </button>
              </div>
              <p v-if="subtitleCleanupMessage" class="preview-tool-message" role="status">{{ subtitleCleanupMessage }}</p>
            </div>
            <section v-if="visibleVideoCandidates.length" class="preview-candidates" aria-label="当前视频">
              <div class="preview-candidates__head">
                <div>
                  <span class="studio-kicker">CURRENT VIDEO</span>
                  <strong>当前视频</strong>
                </div>
                <span>{{ pendingVideo ? '待你采用' : '已采用' }}</span>
              </div>
              <div
                v-for="candidate in visibleVideoCandidates"
                :key="candidate.id"
                class="preview-candidate-row"
                :class="{ 'is-selected': candidate.id === previewVideo?.id }"
              >
                <button
                  class="preview-candidate-row__select"
                  type="button"
                  :aria-label="`预览当前视频 v${candidate.versionNo}`"
                  :aria-pressed="true"
                >
                  <strong>v{{ candidate.versionNo }}</strong>
                  <span>{{ candidate.modelName || '视频模型未记录' }} · {{ candidate.durationSeconds || '—' }}s</span>
                </button>
                <span
                  v-if="candidate.id === detail?.currentVideo?.id"
                  class="preview-candidate-row__confirmed"
                ><span class="material-symbols-outlined">verified</span>当前主视频</span>
                <button
                  v-else
                  type="button"
                  class="studio-button studio-button--primary preview-adopt-button"
                  :disabled="generating || adoptingVideoId === candidate.id || Boolean(candidate.qualityReport && candidate.qualityReport.technicalStatus !== 'passed')"
                  @click="adoptVideo(candidate.id)"
                >
                  <span class="material-symbols-outlined">check_circle</span>
                  {{ adoptingVideoId === candidate.id ? '采用中…' : '采用此视频' }}
                </button>
                <div v-if="candidate.qualityReport" class="candidate-quality" :class="`is-${candidate.qualityReport.technicalStatus}`">
                  <strong>
                    {{ candidate.qualityReport.technicalStatus === 'passed' ? '媒体技术检查通过' : candidate.qualityReport.technicalStatus === 'needs_attention' ? '媒体检查发现风险' : '媒体检查未完成' }}
                    <span>· {{ candidate.qualityReport.semanticStatus === 'accepted_by_user' ? '已人工确认内容' : '动作与剧情待观看复核' }}</span>
                  </strong>
                  <p>{{ candidate.qualityReport.summary }}</p>
                  <ul v-if="candidate.qualityReport.issues.length">
                    <li v-for="issue in candidate.qualityReport.issues" :key="`${candidate.id}-${issue.code}`">{{ issue.message }}</li>
                  </ul>
                  <small v-if="candidate.qualityReport.metrics">
                    {{ candidate.qualityReport.metrics.width || '—' }}×{{ candidate.qualityReport.metrics.height || '—' }} · 实际 {{ candidate.qualityReport.metrics.durationSeconds?.toFixed(2) || '—' }}s
                    <template v-if="candidate.qualityReport.metrics.meanVolumeDb !== null && candidate.qualityReport.metrics.meanVolumeDb !== undefined"> · 音量 {{ candidate.qualityReport.metrics.meanVolumeDb.toFixed(1) }} dB</template>
                    <template v-if="candidate.qualityReport.metrics.meanFrameDifference !== null && candidate.qualityReport.metrics.meanFrameDifference !== undefined"> · 平均帧差 {{ candidate.qualityReport.metrics.meanFrameDifference.toFixed(2) }}</template>
                    <template v-if="candidate.qualityReport.metrics.activeFrameRatio !== null && candidate.qualityReport.metrics.activeFrameRatio !== undefined"> · 活跃帧 {{ (candidate.qualityReport.metrics.activeFrameRatio * 100).toFixed(1) }}%</template>
                  </small>
                </div>
                <div v-else class="candidate-quality is-unchecked">
                  <strong>媒体检查未完成 · 动作与剧情待观看复核</strong>
                  <p>旧候选没有保存媒体检查报告，不能据此宣称质量通过。</p>
                </div>
              </div>
            </section>
            <div class="preview-checks">
              <div><span>人物与场景</span><strong :class="{ 'is-ready': Boolean(detail?.continuity.allowedEntities.length) }">{{ detail?.continuity.allowedEntities.length ? '已引用' : '待引用' }}</strong></div>
              <div><span>角色音色</span><strong :class="{ 'is-ready': currentShotVoiceState === 'ready' }">{{ currentShotVoiceState === 'ready' ? '已绑定' : currentShotVoiceState === 'pending' ? '待绑定' : '无对白' }}</strong></div>
              <div><span>镜头脚本</span><strong :class="{ 'is-ready': Boolean(draft.visualPrompt || draft.actionText) }">{{ draft.visualPrompt || draft.actionText ? '已就绪' : '待生成' }}</strong></div>
            </div>
          </aside>
        </section>

        <section class="storyboard-timeline">
          <div class="storyboard-timeline__head">
            <div>
              <span class="studio-kicker">EPISODE TIMELINE</span>
              <h2>片段镜头顺序</h2>
            </div>
            <span>第 {{ episodeNo }} 集 · {{ currentShots.length }} 镜 / {{ episodeClips.length }} 段</span>
          </div>
          <div class="storyboard-timeline__clips" aria-label="按片段分组的镜头">
            <section v-for="clip in episodeClips" :key="`timeline-${clip.id}`" class="timeline-clip" :class="{ 'is-active': activeClip?.id === clip.id }">
              <button type="button" class="timeline-clip__head" @click="selectClip(clip.id)">
                <span class="timeline-clip__title"><small>场 {{ String(clip.sceneNo).padStart(2, '0') }}</small><strong>{{ clip.title }}</strong></span>
                <span>{{ clip.shotCount }} 镜 · {{ formatAggregateDuration(clip.durationSeconds) }}</span>
              </button>
              <div v-if="clip.shots.length" class="storyboard-timeline__track" role="group" :aria-label="`${clip.title}镜头顺序`">
                <button v-for="shot in clip.shots" :key="shot.storyboardId" type="button" class="timeline-shot" :class="{ 'is-active': selectedShotId === shot.storyboardId }" @click="selectShot(shot.storyboardId)">
                  <span class="timeline-shot__thumb">
                    <img v-if="shot.videoUrl || shot.imageUrl" :src="shot.videoUrl || shot.imageUrl || ''" :alt="`${shot.shotNo} 画面`" loading="lazy" />
                    <span v-else class="material-symbols-outlined">movie</span>
                    <b>{{ formatShotDuration(shot.durationSeconds) }}</b>
                  </span>
                  <span class="timeline-shot__copy"><strong>{{ shot.shotNo }}</strong><small>{{ shot.primaryAction || shot.dialogueText || '待补充镜头内容' }}</small></span>
                </button>
              </div>
              <p v-else class="timeline-clip__empty">此片段已保留，尚无分镜记录。</p>
            </section>
            <div v-if="!currentShots.length" class="studio-empty">生成分镜脚本后，这里会出现按时间排列的剧情片段。</div>
          </div>
        </section>
      </template>

      <Transition name="asset-editor">
        <div v-if="assetEditor" class="asset-editor-backdrop" @click.self="assetEditor = null">
          <section class="asset-editor" role="dialog" aria-modal="true" aria-labelledby="asset-editor-title">
            <header>
              <div>
                <span class="studio-kicker">{{ assetEditor.kind === 'character' ? 'CHARACTER ASSET' : assetEditor.kind === 'scene' ? 'SCENE ASSET' : 'PROP ASSET' }}</span>
                <h2 id="asset-editor-title">{{ assetEditor.name }}</h2>
                <p>{{ assetEditor.subtitle }}</p>
              </div>
              <button type="button" class="studio-icon-button" aria-label="关闭提示词编辑" @click="assetEditor = null"><span class="material-symbols-outlined">close</span></button>
            </header>
            <div class="asset-editor__body">
              <div class="asset-editor__visual">
                <div class="asset-editor__hero">
                  <img v-if="assetEditorImageUrl" :src="assetEditorImageUrl" :alt="assetEditor.name" />
                  <span v-else class="asset-editor__missing"><span class="material-symbols-outlined">{{ assetEditor.kind === 'character' ? 'person' : assetEditor.kind === 'scene' ? 'landscape' : 'category' }}</span><small>尚未生成参考图</small></span>
                </div>
                <div class="asset-editor__visual-meta">
                  <span>{{ assetEditor.kind === 'character' ? '角色形象' : assetEditor.kind === 'scene' ? '场景定妆' : '道具参考' }}</span>
                  <strong>{{ assetEditor.imageUrl ? '已有参考图' : '等待生成参考图' }}</strong>
                </div>
              </div>
              <div class="asset-editor__form">
                <label class="studio-field">
                  <span>本镜提示词 <em>会写入当前镜头</em></span>
                  <textarea v-model="assetPrompt" rows="8" placeholder="写清楚当前镜头中的外观、状态、动作、光线和连续性要求"></textarea>
                </label>

                <section v-if="assetEditorCharacter" class="studio-voice-card" aria-labelledby="studio-voice-title">
                  <div class="studio-voice-card__head">
                    <div>
                      <span class="studio-kicker">VOICE LOCK</span>
                      <h3 id="studio-voice-title">角色音色</h3>
                    </div>
                    <span v-if="assetEditorCharacter.voiceLocked" class="studio-voice-card__locked"><span class="material-symbols-outlined">lock</span>已锁定</span>
                  </div>
                  <label class="studio-field studio-field--compact">
                    <span>系统声线</span>
                    <span class="studio-select-wrap">
                      <select v-model="voiceProfileKey" class="studio-select" :disabled="voiceBusy || Boolean(assetEditorCharacter.voiceLocked && assetEditorCharacter.voiceDesign?.provider === 'qwen')">
                        <option value="">自动匹配角色性别的声线</option>
                        <option v-for="profile in editorVoiceProfiles" :key="profile.profileKey" :value="profile.profileKey">
                          {{ profile.displayName }} · {{ profile.styleTags.slice(0, 2).join(' / ') }}
                        </option>
                      </select>
                      <span class="material-symbols-outlined studio-select-arrow" aria-hidden="true">expand_more</span>
                    </span>
                  </label>
                  <label class="studio-field studio-field--compact">
                    <span>声音气质</span>
                    <input v-model="voiceStyle" :disabled="voiceBusy" placeholder="例：低沉、克制，语速偏慢" />
                  </label>
                   <div class="studio-voice-card__actions">
                    <button type="button" class="studio-button studio-button--primary" :disabled="voiceBusy || !voiceProfileKey" @click="bindEditorVoice">
                      <span class="material-symbols-outlined">{{ voiceBusy ? 'progress_activity' : 'lock' }}</span>
                      绑定并锁定
                    </button>
                     <button type="button" class="studio-button studio-button--quiet" :disabled="voiceBusy || (!voiceProfileKey && !assetEditorCharacter.voiceProfileKey)" @click="previewEditorVoice">
                      <span class="material-symbols-outlined">volume_up</span>
                       {{ voicePreviewing ? '生成中' : '试听' }}
                     </button>
                     <button type="button" class="studio-button studio-button--quiet" :disabled="voiceBusy" @click="generateAgentVoicePreview">
                       <span class="material-symbols-outlined">auto_awesome</span>
                       {{ voicePreviewing ? '生成中' : '声音 Agent 试听' }}
                     </button>
                     <button v-if="voiceAgentDesign && voicePreviewUrl" type="button" class="studio-button studio-button--primary" :disabled="voiceBusy" @click="bindVoiceAgentPreview">
                       <span class="material-symbols-outlined">check</span>
                       确认绑定试听
                     </button>
                   </div>
                  <input ref="referenceAudioInput" class="studio-visually-hidden" type="file" accept="audio/*" @change="onReferenceAudioChange" />
                  <button type="button" class="studio-reference-audio" :disabled="voiceBusy" @click="pickReferenceAudio">
                    <span class="material-symbols-outlined">upload_file</span>
                    <span><strong>{{ referenceAudioName || '上传参考音频' }}</strong><small>清晰人声，最大 15MB</small></span>
                  </button>
                  <audio v-if="referenceAudioUrl" class="studio-audio-player" :src="referenceAudioUrl" controls preload="metadata"></audio>
                   <audio v-if="voicePreviewUrl" class="studio-voice-preview" :src="voicePreviewUrl" controls preload="auto" @error="voicePreviewReady = false; voiceMessage = '音频文件无法访问，请重新生成试听'"></audio>
                   <p v-if="voiceAgentDesign" class="studio-voice-design">
                     <strong>{{ voiceAgentDesign.name }}</strong>
                     <span>{{ voiceAgentDesign.summary }}</span>
                     <small>{{ voiceAgentDesign.performanceInstructions }}</small>
                   </p>
                  <p v-if="voiceMessage" class="studio-voice-message" :class="{ 'is-error': voiceMessage.includes('失败') || voiceMessage.includes('不能') || voiceMessage.includes('请选择') }">
                    <span class="material-symbols-outlined">{{ voiceMessage.includes('失败') || voiceMessage.includes('不能') || voiceMessage.includes('请选择') ? 'error' : 'check_circle' }}</span>
                    {{ voiceMessage }}
                  </p>
                </section>
                <p v-if="assetMessage" class="studio-feedback" role="status">{{ assetMessage }}</p>
              </div>
            </div>
            <footer>
              <button type="button" class="studio-button studio-button--quiet" @click="assetEditor = null">取消</button>
              <button type="button" class="studio-button studio-button--primary" :disabled="assetSaving || !assetPrompt.trim()" @click="saveAsset">
                <span class="material-symbols-outlined">{{ assetSaving ? 'progress_activity' : 'save' }}</span>
                {{ assetSaving ? '保存中' : '保存并用于本镜' }}
              </button>
            </footer>
          </section>
        </div>
      </Transition>
    </section>
  </WorkspaceLayout>
</template>

<style scoped>
.storyboard-studio {
  --ink: #f4eadf;
  --muted: #a79f95;
  --quiet: #77736c;
  --line: rgba(243, 222, 199, .13);
  --line-strong: rgba(243, 167, 108, .46);
  --accent: #f2a36c;
  min-height: 100%;
  overflow: visible;
  padding: .75rem clamp(.8rem, 2.5vw, 2.5rem) 2rem;
  background: #0c0f0d;
  color: var(--ink);
}
.storyboard-studio__topbar { display: flex; min-height: 3.7rem; align-items: center; gap: 1rem; border-bottom: 1px solid var(--line); }
.storyboard-studio__back, .storyboard-studio__export { display: inline-flex; min-height: 2.35rem; align-items: center; gap: .4rem; border: 1px solid var(--line); padding: .5rem .7rem; color: #dfd2c5; font-size: .7rem; transition: border-color .18s ease, background-color .18s ease, transform .18s ease; }
.storyboard-studio__back:hover, .storyboard-studio__export:hover { border-color: var(--accent); background: rgba(242, 163, 108, .08); transform: translateY(-1px); }
.storyboard-studio__back-icon { transition: transform .22s cubic-bezier(.22, 1, .36, 1); }
.storyboard-studio__back:hover .storyboard-studio__back-icon { transform: translateX(-3px); }
.storyboard-studio__export .material-symbols-outlined { transition: transform .22s cubic-bezier(.22, 1, .36, 1); }
.storyboard-studio__export:hover .material-symbols-outlined { transform: translateY(2px); }
.storyboard-studio__identity { display: flex; min-width: 0; flex-direction: column; gap: .08rem; }
.storyboard-studio__identity h1 { overflow: hidden; color: #eee3d7; font-size: .85rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.storyboard-studio__identity > span:last-child { color: var(--muted); font-size: .65rem; }
.storyboard-studio__top-actions { display: flex; align-items: center; gap: .75rem; margin-left: auto; }
.storyboard-studio__progress { color: var(--muted); font-size: .68rem; }
.storyboard-studio__export { border-color: rgba(242, 163, 108, .42); color: var(--accent); }
.storyboard-studio__export:disabled, .studio-button:disabled { cursor: progress; opacity: .55; }
.storyboard-studio__eyebrow, .studio-kicker { color: #c18f6f; font-family: ui-monospace, monospace; font-size: .56rem; letter-spacing: .14em; }
.episode-clip-nav { display: grid; grid-template-columns: minmax(11rem, .26fr) minmax(0, 1fr); gap: .8rem; margin-top: .75rem; border: 1px solid var(--line); background: #101410; padding: .75rem; }
.episode-clip-nav__heading { display: flex; flex-direction: column; justify-content: center; gap: .3rem; border-right: 1px solid var(--line); padding: .3rem .8rem .3rem .25rem; }
.episode-clip-nav__heading strong { color: #eee3d7; font-size: .78rem; font-weight: 600; }
.episode-clip-nav__heading small { color: var(--muted); font-size: .58rem; line-height: 1.5; }
.episode-clip-nav__items { display: flex; min-width: 0; gap: .45rem; overflow-x: auto; padding: .08rem .1rem .28rem; }
.episode-clip { display: flex; min-width: 11.5rem; max-width: 17rem; flex: 0 0 11.5rem; flex-direction: column; align-items: flex-start; gap: .32rem; border: 1px solid var(--line); background: #151a15; padding: .55rem .65rem; text-align: left; transition: border-color .18s ease, background-color .18s ease; }
.episode-clip:hover, .episode-clip.is-active { border-color: var(--line-strong); background: rgba(242, 163, 108, .07); }
.episode-clip__index { color: #c18f6f; font: 500 .55rem ui-monospace, monospace; }
.episode-clip > strong { max-width: 100%; overflow: hidden; color: #eee3d7; font-size: .7rem; text-overflow: ellipsis; white-space: nowrap; }
.episode-clip__meta { display: flex; max-width: 100%; flex-wrap: wrap; gap: .3rem .55rem; color: var(--muted); font-size: .55rem; }
.episode-clip__empty { color: #dca47c; font-size: .53rem; }
.episode-clip-nav__empty { align-self: center; padding: .5rem; color: var(--muted); font-size: .65rem; }
.storyboard-studio__workspace { display: grid; grid-template-columns: minmax(15rem, .82fr) minmax(25rem, 1.4fr) minmax(18rem, .95fr); gap: .7rem; padding-top: .75rem; }
.studio-panel, .storyboard-timeline { border: 1px solid var(--line); background: #121612; }
.studio-panel { min-width: 0; min-height: 37rem; }
.studio-panel__head { display: flex; min-height: 3.65rem; align-items: center; justify-content: space-between; gap: .75rem; border-bottom: 1px solid var(--line); padding: .75rem .9rem; }
.studio-panel__head h1, .storyboard-timeline__head h2 { margin-top: .28rem; color: #eee5d9; font-family: 'Noto Serif SC', serif; font-size: 1rem; font-weight: 600; }
.studio-panel__subhead { margin-top: .24rem; color: var(--muted); font-size: .57rem; line-height: 1.45; }
.studio-panel__count { display: grid; width: 1.8rem; height: 1.8rem; place-items: center; border: 1px solid var(--line-strong); color: var(--accent); font-family: ui-monospace, monospace; font-size: .65rem; }
.studio-panel__hint { margin: .75rem .9rem .6rem; color: var(--muted); font-size: .68rem; line-height: 1.55; }
.studio-tabs { display: grid; grid-template-columns: repeat(3, 1fr); margin: 0 .9rem .7rem; border-bottom: 1px solid var(--line); }
.studio-tabs button { display: flex; align-items: center; justify-content: center; gap: .28rem; border-bottom: 2px solid transparent; padding: .6rem .2rem; color: #b8b2a8; font-size: .68rem; transition: color .18s ease, border-color .18s ease; }
.studio-tabs button span { color: inherit; font-family: ui-monospace, monospace; font-size: .58rem; }
.studio-tabs button.is-active { border-color: var(--accent); color: var(--accent); }
.studio-asset-list { max-height: 22rem; overflow: auto; padding: 0 .65rem .8rem; }
.studio-asset { display: grid; width: 100%; grid-template-columns: 2.4rem minmax(0, 1fr) 1.1rem; align-items: center; gap: .58rem; border-bottom: 1px solid rgba(243, 222, 199, .07); padding: .55rem .25rem; text-align: left; transition: background-color .18s ease, transform .18s ease; }
.studio-asset:hover { background: rgba(242, 163, 108, .07); transform: translateX(2px); }
.studio-asset__thumb { display: grid; width: 2.4rem; height: 2.4rem; overflow: hidden; place-items: center; border: 1px solid var(--line); background: #1e241e; color: var(--accent); font-size: .7rem; }
.studio-asset__thumb img { width: 100%; height: 100%; object-fit: cover; }
.studio-asset__missing, .mention-option__missing, .prompt-reference__missing, .asset-editor__missing { display: flex; align-items: center; justify-content: center; gap: .12rem; color: #8d9a8a; }
.studio-asset__missing { flex-direction: column; }
.studio-asset__missing small, .mention-option__missing small, .prompt-reference__missing small, .asset-editor__missing small { color: #8d9a8a; font-size: .43rem; line-height: 1; }
.studio-asset__copy { display: flex; min-width: 0; flex-direction: column; gap: .18rem; }
.studio-asset__copy strong { overflow: hidden; color: #e6d9ca; font-size: .72rem; text-overflow: ellipsis; white-space: nowrap; }
.studio-asset__copy small { overflow: hidden; color: #a8a299; font-size: .6rem; text-overflow: ellipsis; white-space: nowrap; }
.studio-asset > .material-symbols-outlined { color: var(--quiet); font-size: 1rem; }
.studio-asset-tools { display: flex; flex-direction: column; gap: .28rem; border-top: 1px solid var(--line); padding: .8rem .9rem; }
.studio-asset-tools > button { display: grid; grid-template-columns: 1.25rem 1fr; column-gap: .35rem; align-items: center; padding: .45rem 0; color: #d9cbbd; text-align: left; font-size: .68rem; }
.studio-asset-tools > button .material-symbols-outlined { grid-row: span 2; color: var(--accent); font-size: 1rem; }
.studio-asset-tools > button small { grid-column: 2; color: #a8a299; font-size: .57rem; }
.continuity-picker { margin-top: .35rem; border: 1px solid rgba(242, 163, 108, .28); background: rgba(12, 16, 13, .82); }
.continuity-picker__head { display: flex; align-items: center; justify-content: space-between; padding: .42rem .5rem; border-bottom: 1px solid var(--line); color: #eadfd2; font-size: .62rem; }
.continuity-picker__head button { display: grid; width: 1.5rem; height: 1.5rem; place-items: center; color: var(--muted); }
.continuity-picker__head .material-symbols-outlined { font-size: .9rem; }
.continuity-picker__option { display: grid; width: 100%; grid-template-columns: 1.15rem minmax(0, 1fr) 1rem; align-items: center; gap: .35rem; padding: .45rem .5rem; color: var(--muted); text-align: left; }
.continuity-picker__option:hover { background: rgba(242, 163, 108, .1); color: #f1e5d8; }
.continuity-picker__option > .material-symbols-outlined { color: var(--accent); font-size: .9rem; }
.continuity-picker__option span:nth-child(2) { display: flex; min-width: 0; flex-direction: column; gap: .12rem; }
.continuity-picker__option strong { color: #eadfd2; font-size: .62rem; }
.continuity-picker__option small { overflow: hidden; color: var(--quiet); font-size: .55rem; text-overflow: ellipsis; white-space: nowrap; }
.continuity-picker__empty { margin: 0; padding: .55rem; color: var(--quiet); font-size: .58rem; line-height: 1.4; }
.studio-form { padding: 1rem; }
.studio-form__meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: .5rem; }
.studio-form__meta--two { grid-template-columns: repeat(2, 1fr); }
.studio-field, .studio-form__meta label { display: flex; flex-direction: column; gap: .32rem; margin-bottom: .75rem; color: var(--muted); font-size: .65rem; }
.studio-field em { margin-left: .3rem; color: var(--accent); font-style: normal; font-size: .58rem; }
.studio-field input, .studio-field textarea, .studio-form__meta input { width: 100%; box-sizing: border-box; border: 1px solid rgba(243, 222, 199, .14); background: #0e120f; padding: .58rem .62rem; color: #eee4d9; font: inherit; line-height: 1.55; outline: none; resize: vertical; transition: border-color .18s ease, box-shadow .18s ease; }
.studio-field input:focus, .studio-field textarea:focus, .studio-form__meta input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(242, 163, 108, .08); }
.studio-field textarea { min-height: 3.6rem; }
.studio-prompt-editor { position: relative; }
.studio-prompt-editor textarea { min-height: 11rem; }
.mention-popover { position: absolute; top: calc(100% + .5rem); right: .55rem; left: .55rem; z-index: 8; overflow: hidden; border: 1px solid rgba(242, 163, 108, .42); background: rgba(16, 21, 17, .98); box-shadow: 0 18px 44px rgba(0, 0, 0, .42); backdrop-filter: blur(16px); }
.mention-popover__head { display: flex; flex-direction: column; gap: .55rem; border-bottom: 1px solid var(--line); padding: .5rem .6rem .55rem; color: #e9ddcf; font-size: .65rem; }
.mention-popover__tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .28rem; }
.mention-popover__tabs button { display: inline-flex; min-height: 2.25rem; align-items: center; justify-content: center; gap: .3rem; border: 1px solid transparent; color: var(--muted); font-size: .65rem; transition: border-color .18s ease, color .18s ease, background-color .18s ease, transform .18s ease; }
.mention-popover__tabs button:hover { color: #f1e5d8; transform: translateY(-1px); }
.mention-popover__tabs button.is-active { border-color: rgba(242, 163, 108, .38); background: rgba(242, 163, 108, .1); color: var(--accent); }
.mention-popover__tabs .material-symbols-outlined { font-size: .9rem; }
.mention-popover__tabs b { min-width: 1.15rem; color: inherit; font: 500 .55rem ui-monospace, monospace; }
.mention-popover__head small { color: var(--quiet); font-size: .57rem; }
.mention-option { display: grid; width: 100%; grid-template-columns: 2.1rem minmax(0, 1fr) 1rem; align-items: center; gap: .55rem; border-bottom: 1px solid rgba(243, 222, 199, .07); padding: .52rem .7rem; text-align: left; transition: background-color .18s ease, transform .18s ease; }
.mention-option:hover { background: rgba(242, 163, 108, .1); transform: translateX(2px); }
.mention-option:focus-visible, .mention-popover__tabs button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.mention-option__thumb { display: grid; width: 2.1rem; height: 2.1rem; place-items: center; overflow: hidden; border: 1px solid var(--line); background: #202720; color: var(--accent); font-size: .85rem; }
.mention-option__thumb img { width: 100%; height: 100%; object-fit: cover; }
.mention-option__missing { flex-direction: column; }
.mention-option__copy { display: flex; min-width: 0; flex-direction: column; gap: .16rem; }
.mention-option__copy strong { overflow: hidden; color: #eadfd2; font-size: .68rem; text-overflow: ellipsis; white-space: nowrap; }
.mention-option__copy small { overflow: hidden; color: var(--quiet); font-size: .58rem; text-overflow: ellipsis; white-space: nowrap; }
.mention-option > .material-symbols-outlined { color: var(--accent); font-size: .95rem; }
.mention-popover__empty { padding: .9rem; color: var(--quiet); text-align: center; font-size: .62rem; }
.mention-popover-enter-active, .mention-popover-leave-active { transition: opacity .16s ease, transform .16s ease; transform-origin: top center; }
.mention-popover-enter-from, .mention-popover-leave-to { opacity: 0; transform: translateY(-5px) scale(.98); }
.prompt-references { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .45rem; }
.prompt-reference { display: inline-flex; min-height: 2rem; align-items: center; gap: .38rem; border: 1px solid rgba(242, 163, 108, .25); background: rgba(242, 163, 108, .06); padding: .25rem .38rem .25rem .25rem; text-align: left; transition: border-color .18s ease, background-color .18s ease, transform .18s ease; }
.prompt-reference:hover { border-color: var(--accent); background: rgba(242, 163, 108, .12); transform: translateY(-1px); }
.prompt-reference__thumb { display: grid; width: 1.55rem; height: 1.55rem; place-items: center; overflow: hidden; background: #202720; color: var(--accent); font-size: .7rem; }
.prompt-reference__thumb img { width: 100%; height: 100%; object-fit: cover; }
.prompt-reference__missing { flex-direction: column; }
.prompt-reference > span:nth-child(2) { display: flex; min-width: 0; flex-direction: column; gap: .1rem; }
.prompt-reference small { color: var(--accent); font-size: .48rem; }
.prompt-reference strong { max-width: 8rem; overflow: hidden; color: #e6d8ca; font-size: .6rem; text-overflow: ellipsis; white-space: nowrap; }
.prompt-reference > .material-symbols-outlined { color: var(--muted); font-size: .85rem; }
.studio-script-actions { display: flex; justify-content: flex-end; gap: .5rem; padding-top: .15rem; }
.studio-button { display: inline-flex; min-height: 2.4rem; align-items: center; justify-content: center; gap: .4rem; border: 1px solid var(--line); padding: .55rem .75rem; font-size: .68rem; transition: transform .18s ease, border-color .18s ease, background-color .18s ease, box-shadow .18s ease; }
.studio-button:hover:not(:disabled) { transform: translateY(-1px); }
.studio-button--quiet { color: #d8cabe; }
.studio-button--quiet:hover:not(:disabled) { border-color: var(--accent); background: rgba(242, 163, 108, .08); }
.studio-button--primary { border-color: var(--accent); background: var(--accent); color: #291a11; font-weight: 700; }
.studio-button--primary:hover:not(:disabled) { background: #ffc38d; box-shadow: 0 8px 24px rgba(242, 163, 108, .16); }
.studio-save-state { color: #a8d6b2; font-size: .62rem; }
.studio-feedback { margin-top: .6rem; color: var(--muted); font-size: .66rem; line-height: 1.5; }
.studio-quality-report { margin-top: .7rem; border: 1px solid rgba(242, 163, 108, .24); background: rgba(242, 163, 108, .05); padding: .7rem; color: var(--muted); font-size: .62rem; line-height: 1.55; animation: preview-in .22s ease both; }
.studio-quality-report__head { display: flex; align-items: center; gap: .35rem; color: var(--accent); }
.studio-quality-report__head .material-symbols-outlined { font-size: .95rem; }
.studio-quality-report__head span:last-child { margin-left: auto; color: #e7c28e; }
.studio-quality-report p { margin: .35rem 0 0; }
.studio-quality-report ul { margin: .45rem 0 0; padding-left: 1rem; color: #e9b0a5; }
.studio-quality-report__warnings { color: #e7c28e !important; }
.shot-switcher { display: flex; gap: .38rem; overflow-x: auto; border-bottom: 1px solid var(--line); padding: .6rem .8rem; }
.shot-switcher button { display: flex; min-width: 3.1rem; flex-direction: column; gap: .18rem; border: 1px solid transparent; padding: .42rem .5rem; color: #b8b2a8; text-align: left; transition: border-color .18s ease, background-color .18s ease, color .18s ease; }
.shot-switcher button.is-active { border-color: var(--line-strong); background: rgba(242, 163, 108, .09); color: var(--accent); }
.shot-switcher strong { font-family: ui-monospace, monospace; font-size: .7rem; }
.shot-switcher small { font-size: .58rem; }
.studio-preview { display: flex; flex-direction: column; }
.studio-icon-button { display: grid; width: 2rem; height: 2rem; place-items: center; border: 1px solid var(--line); color: var(--muted); transition: border-color .18s ease, color .18s ease, background-color .18s ease; }
.studio-icon-button:hover { border-color: var(--accent); background: rgba(242, 163, 108, .08); color: var(--accent); }
.preview-player { position: relative; display: grid; min-height: 20rem; margin: .8rem; place-items: center; overflow: hidden; background: #080a08; }
.preview-player.is-zoomed { position: fixed; inset: 5vh 5vw; z-index: 20; min-height: 0; margin: 0; border: 1px solid var(--line-strong); box-shadow: 0 24px 80px rgba(0,0,0,.5); animation: preview-in .22s ease both; }
.preview-player video { width: 100%; max-height: 29rem; background: #080a08; object-fit: contain; }
.preview-tools { position: absolute; right: .6rem; bottom: .6rem; left: .6rem; display: flex; justify-content: space-between; gap: .35rem; }
.preview-tools button { display: inline-flex; align-items: center; gap: .25rem; border: 1px solid rgba(255,255,255,.16); background: rgba(7, 9, 7, .78); padding: .42rem .55rem; color: #e7dbce; font-size: .6rem; backdrop-filter: blur(8px); }
.preview-tools button.is-active { border-color: var(--accent); color: var(--accent); }
.preview-candidates { margin: 0 .8rem .8rem; border: 1px solid var(--line); background: rgba(255,255,255,.025); }
.preview-candidates__head { display: flex; align-items: center; justify-content: space-between; gap: .75rem; border-bottom: 1px solid var(--line); padding: .65rem .7rem; color: var(--quiet); font-size: .62rem; }
.preview-candidates__head > div { display: grid; gap: .18rem; }
.preview-candidates__head strong { color: var(--text); font-size: .74rem; }
.preview-candidate-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: .55rem .65rem; padding: .65rem .7rem; }
.preview-candidate-row + .preview-candidate-row { border-top: 1px solid var(--line); }
.preview-candidate-row.is-selected { background: rgba(242,163,108,.08); }
.preview-candidate-row__select { display: grid; min-width: 0; flex: 1; gap: .18rem; border: 0; background: transparent; padding: 0; text-align: left; color: inherit; cursor: pointer; }
.preview-candidate-row__select strong { color: var(--accent); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .72rem; }
.preview-candidate-row__select span { overflow: hidden; color: var(--quiet); font-size: .62rem; text-overflow: ellipsis; white-space: nowrap; }
.preview-candidate-row__select:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.preview-candidate-row__confirmed { display: inline-flex; align-items: center; gap: .2rem; color: #a8d6b2; font-size: .62rem; white-space: nowrap; }
.preview-candidate-row__confirmed .material-symbols-outlined { font-size: .9rem; }
.preview-adopt-button { grid-column: 1 / -1; justify-self: end; min-height: 2.2rem; padding: .4rem .65rem; font-size: .62rem; white-space: nowrap; }
.candidate-quality { grid-column: 1 / -1; min-width: 0; border-left: 2px solid #6da77b; padding: .38rem .55rem; background: rgba(109,167,123,.07); }
.candidate-quality.is-needs_attention { border-color: #dc9c50; background: rgba(220,156,80,.08); }
.candidate-quality.is-unchecked { border-color: #8a96a0; background: rgba(138,150,160,.07); }
.candidate-quality strong { display: block; color: var(--text); font-size: .65rem; line-height: 1.5; }
.candidate-quality strong span { color: var(--quiet); font-weight: 500; }
.candidate-quality p { margin: .18rem 0; color: var(--quiet); font-size: .62rem; line-height: 1.5; }
.candidate-quality ul { display: grid; gap: .12rem; margin: .2rem 0; padding-left: 1rem; color: #e7bd83; font-size: .62rem; line-height: 1.45; }
.candidate-quality small { display: block; color: var(--quiet); font-size: .58rem; }
.preview-checks { display: grid; grid-template-columns: repeat(3, 1fr); gap: .35rem; margin: auto .8rem .8rem; border-top: 1px solid var(--line); padding-top: .7rem; }
.preview-checks div { display: flex; flex-direction: column; gap: .25rem; color: var(--quiet); font-size: .58rem; }
.preview-checks strong { color: #d99b7f; font-size: .63rem; font-weight: 500; }
.preview-checks strong.is-ready { color: #a8d6b2; }
.studio-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .4rem; min-height: 5rem; color: #a8a299; text-align: center; font-size: .68rem; }
.studio-empty .material-symbols-outlined { color: #8b674f; font-size: 1.5rem; }
.studio-empty strong { color: #cdbdaf; font-size: .75rem; font-weight: 500; }
.studio-empty--assets { min-height: 10rem; }
.studio-empty--script { min-height: 29rem; padding: 1.5rem; }
.storyboard-timeline { margin-top: .7rem; }
.storyboard-timeline__head { display: flex; min-height: 3.8rem; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid var(--line); padding: .7rem .9rem; }
.storyboard-timeline__head > span { color: var(--muted); font-size: .65rem; }
.storyboard-timeline__clips { display: grid; gap: .55rem; padding: .65rem; }
.timeline-clip { min-width: 0; border-left: 2px solid var(--line); background: rgba(255, 255, 255, .012); }
.timeline-clip.is-active { border-left-color: var(--accent); }
.timeline-clip__head { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: .8rem; border-bottom: 1px solid var(--line); padding: .55rem .65rem; color: var(--muted); text-align: left; font-size: .58rem; }
.timeline-clip__head:hover { background: rgba(242, 163, 108, .05); }
.timeline-clip__title { display: flex; min-width: 0; align-items: baseline; gap: .5rem; }
.timeline-clip__title small { flex: 0 0 auto; color: #c18f6f; font: 500 .54rem ui-monospace, monospace; }
.timeline-clip__title strong { overflow: hidden; color: #e8ddd1; font-size: .65rem; text-overflow: ellipsis; white-space: nowrap; }
.timeline-clip__empty { margin: 0; padding: .65rem; color: var(--quiet); font-size: .6rem; }
.storyboard-timeline__track { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: .55rem; padding: .55rem .65rem; }
.timeline-shot { display: grid; grid-template-columns: 4.3rem minmax(0, 1fr); gap: .55rem; border: 1px solid transparent; padding: .35rem; text-align: left; transition: border-color .18s ease, background-color .18s ease, transform .18s ease; }
.timeline-shot:hover, .timeline-shot.is-active { border-color: var(--line-strong); background: rgba(242, 163, 108, .06); transform: translateY(-1px); }
.timeline-shot__thumb { position: relative; display: grid; height: 3.2rem; place-items: center; overflow: hidden; background: #1b211c; color: var(--quiet); }
.timeline-shot__thumb img { width: 100%; height: 100%; object-fit: cover; }
.timeline-shot__thumb b { position: absolute; right: .2rem; bottom: .18rem; background: rgba(0,0,0,.7); padding: .12rem .2rem; color: #fff; font: 500 .52rem ui-monospace, monospace; }
.timeline-shot__copy { display: flex; min-width: 0; flex-direction: column; gap: .25rem; padding-top: .15rem; }
.timeline-shot__copy strong { color: var(--accent); font: 600 .65rem ui-monospace, monospace; }
.timeline-shot__copy small { display: -webkit-box; overflow: hidden; color: var(--muted); font-size: .6rem; line-height: 1.45; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.storyboard-studio__state { display: flex; min-height: 35rem; align-items: center; justify-content: center; gap: .55rem; color: var(--muted); font-size: .78rem; }
.storyboard-studio__state.is-error { color: #efa79a; }
.storyboard-studio__state button { border-bottom: 1px solid currentColor; }
.is-spin { animation: spin 1s linear infinite; }
.asset-editor-backdrop { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center; background: rgba(3, 5, 4, .72); padding: 1rem; backdrop-filter: blur(10px); }
.asset-editor { width: min(55rem, 100%); max-height: min(90vh, 46rem); overflow: auto; border: 1px solid var(--line-strong); background: #121612; box-shadow: 0 28px 90px rgba(0,0,0,.45); animation: editor-in .22s ease both; }
.asset-editor > header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid var(--line); padding: .9rem 1rem; }
.asset-editor h2 { margin-top: .3rem; color: #eee5d9; font-family: 'Noto Serif SC', serif; font-size: 1.05rem; }
.asset-editor > header p { margin-top: .28rem; color: var(--muted); font-size: .62rem; }
.asset-editor__body { display: grid; grid-template-columns: minmax(13rem, .78fr) minmax(20rem, 1.22fr); gap: 1rem; padding: 1rem; }
.asset-editor__visual { min-width: 0; }
.asset-editor__hero { display: grid; min-height: 20rem; place-items: center; overflow: hidden; border: 1px solid var(--line); background: radial-gradient(circle at 50% 20%, rgba(242, 163, 108, .13), transparent 46%), #0b0e0c; color: var(--accent); }
.asset-editor__hero img { width: 100%; height: 100%; min-height: 20rem; object-fit: cover; }
.asset-editor__hero > .material-symbols-outlined { font-size: 3rem; }
.asset-editor__missing { flex-direction: column; gap: .5rem; }
.asset-editor__missing > .material-symbols-outlined { font-size: 3rem; }
.asset-editor__missing small { font-size: .62rem; }
.asset-editor__visual-meta { display: flex; justify-content: space-between; gap: .5rem; padding-top: .55rem; color: var(--quiet); font-size: .58rem; }
.asset-editor__visual-meta strong { color: #b9d7bd; font-weight: 500; }
.asset-editor__form .studio-field { margin: 0 0 .6rem; }
.studio-voice-card { margin-top: .8rem; border-top: 1px solid var(--line); padding-top: .8rem; }
.studio-voice-card__head { display: flex; align-items: flex-start; justify-content: space-between; gap: .75rem; margin-bottom: .65rem; }
.studio-voice-card__head h3 { margin-top: .25rem; color: #e7dbcf; font-size: .78rem; font-weight: 600; }
.studio-voice-card__locked { display: inline-flex; align-items: center; gap: .2rem; color: #a8d6b2; font-size: .58rem; }
.studio-voice-card__locked .material-symbols-outlined { font-size: .8rem; }
.studio-field--compact { margin-bottom: .55rem !important; }
.studio-select-wrap { position: relative; display: block; }
.studio-select { width: 100%; appearance: none; border: 1px solid rgba(243, 222, 199, .14); background: #0e120f; padding: .58rem 2rem .58rem .62rem; color: #eee4d9; font: inherit; outline: none; transition: border-color .18s ease, box-shadow .18s ease; }
.studio-select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(242, 163, 108, .08); }
.studio-select-arrow { position: absolute; top: 50%; right: .55rem; pointer-events: none; color: var(--muted); font-size: 1rem; transform: translateY(-50%); transition: color .18s ease, transform .22s cubic-bezier(.22, 1, .36, 1); }
.studio-select-wrap:hover .studio-select-arrow, .studio-select-wrap:focus-within .studio-select-arrow { color: var(--accent); transform: translateY(-50%) rotate(180deg); }
.studio-voice-card__actions { display: flex; gap: .4rem; }
.studio-voice-card__actions .studio-button { min-height: 2.15rem; }
.studio-reference-audio { display: flex; width: 100%; align-items: center; gap: .5rem; margin-top: .6rem; border: 1px dashed rgba(242, 163, 108, .3); padding: .55rem .6rem; color: #d8cabe; text-align: left; transition: border-color .18s ease, background-color .18s ease; }
.studio-reference-audio:hover:not(:disabled) { border-color: var(--accent); background: rgba(242, 163, 108, .06); }
.studio-reference-audio > .material-symbols-outlined { color: var(--accent); font-size: 1rem; }
.studio-reference-audio span:nth-child(2) { display: flex; flex-direction: column; gap: .15rem; }
.studio-reference-audio strong { font-size: .62rem; font-weight: 500; }
.studio-reference-audio small { color: var(--quiet); font-size: .55rem; }
.studio-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
.studio-audio-player, .studio-voice-preview { width: 100%; height: 2rem; margin-top: .55rem; }
.studio-voice-design { display: grid; gap: .22rem; margin: .6rem 0 0; padding: .55rem .6rem; border-left: 2px solid var(--accent); background: rgba(242, 163, 108, .05); color: #d8cabe; font-size: .62rem; line-height: 1.5; }
.studio-voice-design strong { color: #f3ddc9; font-size: .68rem; }
.studio-voice-design span { color: #c8b9ad; }
.studio-voice-design small { color: var(--quiet); }
.studio-voice-message { display: flex; align-items: center; gap: .25rem; margin-top: .5rem; color: #a8d6b2; font-size: .58rem; }
.studio-voice-message.is-error { color: #efa79a; }
.studio-voice-message .material-symbols-outlined { font-size: .85rem; }
.asset-editor footer { display: flex; justify-content: flex-end; gap: .5rem; border-top: 1px solid var(--line); padding: .8rem 1rem; }
.asset-editor .studio-feedback { min-height: 1rem; margin: .4rem 0 .6rem; }
.asset-editor-enter-active, .asset-editor-leave-active { transition: opacity .2s ease; }
.asset-editor-enter-from, .asset-editor-leave-to { opacity: 0; }
@keyframes preview-in { from { opacity: 0; transform: scale(.98); } to { opacity: 1; transform: scale(1); } }
@keyframes editor-in { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 1180px) { .storyboard-studio__workspace { grid-template-columns: minmax(14rem, .75fr) minmax(22rem, 1.35fr); } .studio-preview { grid-column: 1 / -1; min-height: auto; } .preview-player { min-height: 16rem; } }
@media (max-width: 760px) { .storyboard-studio__topbar { align-items: flex-start; flex-wrap: wrap; padding-bottom: .65rem; } .storyboard-studio__top-actions { width: 100%; margin-left: 0; justify-content: space-between; } .episode-clip-nav { grid-template-columns: 1fr; } .episode-clip-nav__heading { border-right: 0; border-bottom: 1px solid var(--line); padding: .15rem .1rem .55rem; } .episode-clip { min-width: 10.5rem; flex-basis: 10.5rem; } .storyboard-studio__workspace { grid-template-columns: 1fr; } .studio-panel { min-height: auto; } .studio-asset-list { max-height: 17rem; } .studio-empty--script { min-height: 17rem; } .studio-form__meta, .studio-form__meta--two { grid-template-columns: 1fr; } .studio-script-actions { flex-direction: column-reverse; } .studio-button { width: 100%; } .storyboard-timeline__track { grid-template-columns: 1fr; } .timeline-clip__head { align-items: flex-start; flex-direction: column; gap: .28rem; } .preview-player.is-zoomed { inset: 3vh 3vw; } .asset-editor__body { grid-template-columns: 1fr; } .asset-editor__hero, .asset-editor__hero img { min-height: 13rem; } .studio-voice-card__actions { flex-direction: column; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }
</style>
