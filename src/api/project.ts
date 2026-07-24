import { getAuthToken } from './auth'

const API_BASE_URL = `${import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3001/api'}`.replace(
  /\/$/,
  '',
)
const API_CONNECT_RETRY_DELAYS_MS = [300, 800, 1500, 2500, 4000]

export interface ProjectDTO {
  id: number
  userId: number
  name: string
  category?: string | null
  targetDuration?: number | null
  narrativeVision?: string | null
  visualStyle?: string | null
  aspectRatio?: string | null
  status: string
  createdAt: string
  updatedAt: string
  progressPercent?: number
  progressStage?: string | null
  progressComplete?: boolean
  progressDetails?: {
    outlineCount: number
    sceneCount: number
    storyboardCount: number
    confirmedImageCount: number
    confirmedVideoCount: number
    confirmedAudioCount: number
    completedExportCount: number
  } | null
  latestVideo?: {
    exportId: number
    videoUrl?: string | null
    durationSeconds?: number | null
    createdAt?: string | null
  } | null
}

export interface OutlineAct {
  act: number
  title?: string
  summary: string
}

export interface OutlineScene {
  scene_no: number
  title: string
  summary: string
  location: string
  time_of_day: string
  estimated_duration: number
}

export interface OutlineDTO {
  id: number
  projectId: number
  versionNo: number
  title?: string | null
  logline?: string | null
  premise?: string | null
  act1Text?: string | null
  act2Text?: string | null
  act3Text?: string | null
  visualStyle?: string | null
  acts: OutlineAct[]
  scenes: OutlineScene[]
  createdAt: string
}

export interface SceneDTO {
  id: number
  projectId: number
  outlineId?: number | null
  sceneNo: number
  title?: string | null
  summary?: string | null
  content?: string | null
  mood?: string | null
  location?: string | null
  timeOfDay?: string | null
  estimatedDuration?: number | null
  sortOrder: number
  status: string
  createdAt: string
  updatedAt: string
}

export interface StoryboardDTO {
  id: number
  sceneId: number
  shotNo: string
  shotType?: string | null
  cameraAngle?: string | null
  composition?: string | null
  durationSeconds?: number | null
  characterId?: number | null
  characterName?: string | null
  actionText?: string | null
  dialogueText?: string | null
  visualPrompt?: string | null
  startVisualPrompt?: string | null
  endVisualPrompt?: string | null
  imageUrl?: string | null
  endImageUrl?: string | null
  videoUrl?: string | null
  sortOrder: number
  status: string
  createdAt: string
  updatedAt: string
  frameCharacterContext?: FrameCharacterContextDTO | null
}

export interface FrameCharacterConstraintDTO {
  characterId: number
  name: string
  roleTag?: string | null
  gender?: 'male' | 'female' | 'neutral' | string | null
  genderLabel: string
  ageGroup?: string | null
  ageGroupLabel: string
  appearance?: string | null
  personality?: string | null
  referenceImageUrl?: string | null
  hasReferenceImage: boolean
  isPrimary: boolean
  inferredGender: boolean
  inferredAge: boolean
}

export interface FrameCharacterContextDTO {
  ready: boolean
  characterFree: boolean
  primaryCharacterId?: number | null
  characters: FrameCharacterConstraintDTO[]
  blockers: string[]
  warnings: string[]
}

export interface FramePromptRewriteDTO {
  visualPrompt: string
  notes?: string | null
  frameCharacterContext?: FrameCharacterContextDTO | null
}

export interface CharacterDTO {
  id: number
  projectId: number
  name: string
  roleTag?: string | null
  personality?: string | null
  appearance?: string | null
  voiceSetting?: string | null
  ageGroup?: 'child' | 'teen' | 'young_adult' | 'middle_aged' | 'senior' | string | null
  gender?: 'male' | 'female' | 'neutral' | string | null
  voiceStyle?: string | null
  voiceProfileKey?: string | null
  voiceLocked: boolean
  referenceImageUrl?: string | null
  status: string
  createdAt: string
  updatedAt: string
}

export interface CharacterRenameImpactDTO {
  characterId: number
  oldName: string
  newName: string
  sourceNames: string[]
  totalRecords: number
  totalOccurrences: number
  sections: {
    project: { records: number; occurrences: number }
    outline: { records: number; occurrences: number }
    scenes: { records: number; occurrences: number }
    storyboards: { records: number; occurrences: number }
  }
  historicalMedia: {
    characterImages: number
    imageAssets: number
    videoAssets: number
    audioAssets: number
  }
  warnings: {
    invalidOutlineJson: boolean
  }
}

export interface CharacterImageDTO {
  id: number
  characterId: number
  versionNo: number
  imageUrl: string
  thumbnailUrl?: string | null
  promptSnapshot?: string | null
  modelName?: string | null
  status: string
  confirmedAt?: string | null
  createdAt: string
}

export interface CharacterVoicePreviewDTO {
  audioUrl: string
  durationSeconds?: number | null
  voiceName: string
  modelName: string
  voiceProfileKey?: string | null
  voiceProfileName?: string | null
  voiceInstructions?: string | null
}

export interface VoiceProfileDTO {
  profileKey: string
  displayName: string
  provider: string
  modelName: string
  voiceId: string
  gender: 'male' | 'female' | 'neutral' | string
  ageGroups: string[]
  styleTags: string[]
  description: string
  instructions?: string | null
  languageType: string
  status: string
  sortOrder: number
}

export interface VoiceRecommendationDTO extends VoiceProfileDTO {
  score: number
  matchReasons: string[]
}

export interface CharacterVoiceTraitsDTO {
  ageGroup?: string | null
  gender?: string | null
  styleTags: string[]
  inferredAge: boolean
  inferredGender: boolean
}

export interface CharacterVoiceCastDTO {
  character: CharacterDTO
  traits: CharacterVoiceTraitsDTO
  selectedProfile?: VoiceProfileDTO | null
  recommendations: VoiceRecommendationDTO[]
  ready: boolean
}

export interface ImageAssetDTO {
  id: number
  storyboardId: number
  versionNo: number
  frameRole?: 'primary' | 'start' | 'end' | string
  imageUrl: string
  thumbnailUrl?: string | null
  promptSnapshot?: string | null
  negativePrompt?: string | null
  characterSnapshot?: {
    version: number
    primaryCharacterId?: number | null
    characterFree: boolean
    characters: Array<{
      characterId: number
      name: string
      roleTag?: string | null
      gender?: string | null
      genderLabel: string
      ageGroup?: string | null
      ageGroupLabel: string
      appearance?: string | null
      referenceImageUrl?: string | null
      isPrimary: boolean
      inferredGender: boolean
      inferredAge: boolean
    }>
  } | null
  modelName?: string | null
  status: string
  confirmedAt?: string | null
  createdAt: string
}

export interface GenerationJobDTO {
  id: number
  jobKey: string
  projectId: number
  jobType: 'frame_image' | 'character_image' | 'lip_sync'
  sourceId: number
  status: 'queued' | 'running' | 'success' | 'failed' | 'canceled'
  progressPercent: number
  result?: { items?: Array<ImageAssetDTO | CharacterImageDTO>; item?: VideoAssetDTO } | null
  errorText?: string | null
  createdAt: string
  updatedAt: string
}

export interface VideoAssetDTO {
  id: number
  storyboardId: number
  imageAssetId: number
  versionNo: number
  videoUrl: string
  thumbnailUrl?: string | null
  motionMode?: string | null
  durationSeconds?: number | null
  modelName?: string | null
  audioAssetId?: number | null
  generationJobId?: number | null
  sourceType?: 'generated_video' | 'lip_sync' | string
  status: string
  confirmedAt?: string | null
  createdAt: string
}

export interface AudioAssetDTO {
  id: number
  projectId: number
  trackType: 'dialogue' | 'narration' | 'music' | 'sfx' | string
  sceneId?: number | null
  sceneNo?: number | null
  sceneTitle?: string | null
  storyboardId?: number | null
  shotNo?: string | null
  characterId?: number | null
  characterName?: string | null
  versionNo: number
  title: string
  audioUrl: string
  durationSeconds?: number | null
  startOffsetSeconds?: number | null
  voiceName?: string | null
  modelName?: string | null
  voiceProfileKey?: string | null
  voiceInstructions?: string | null
  status: string
  confirmedAt?: string | null
  createdAt: string
}

export interface ExportPackageItemDTO {
  sceneId: number
  sceneNo: number
  sceneTitle?: string | null
  storyboardId: number
  shotNo?: string | null
  shotType?: string | null
  durationSeconds: number
  imageUrl?: string | null
  videoUrl?: string | null
  exportStatus: 'ready' | 'static-ready' | 'missing-video'
}

export interface ExportPackageDTO {
  projectId: number
  coverUrl?: string | null
  totalShots: number
  readyShots: number
  confirmedShots: number
  missingShots: number
  missingStoryboardScenes: number
  incompleteScenes: Array<{
    sceneId: number
    sceneNo: number
    sceneTitle?: string | null
  }>
  canExport: boolean
  blockingIssues: FinalEditValidationIssueDTO[]
  totalDurationSeconds: number
  items: ExportPackageItemDTO[]
}

export interface ExportRecordDTO {
  id: number
  projectId: number
  status: string
  videoUrl: string
  coverUrl?: string | null
  durationSeconds?: number | null
  config?: {
    format?: string
    resolution?: string
    frameRate?: number
    burnSubtitle?: boolean
  } | null
  sourceCount: number
  readyCount: number
  missingCount: number
  createdAt: string
  updatedAt: string
}

export interface ProjectAssetSummaryDTO {
  totalCount: number
  characterCount: number
  imageCount: number
  videoCount: number
  audioCount: number
  confirmedImageCount: number
  confirmedVideoCount: number
  confirmedAudioCount: number
}

export interface ProjectAssetItemDTO {
  id: number
  assetType: 'character' | 'image' | 'video' | 'audio'
  projectId: number
  sceneId?: number | null
  sceneNo?: number | null
  sceneTitle?: string | null
  storyboardId?: number | null
  characterId?: number | null
  shotNo?: string | null
  characterName?: string | null
  name: string
  subtitle?: string | null
  status: string
  previewUrl?: string | null
  videoUrl?: string | null
  audioUrl?: string | null
  trackType?: string | null
  durationSeconds?: number | null
  voiceName?: string | null
  confirmedAt?: string | null
  versionNo?: number | null
  createdAt?: string | null
  updatedAt?: string | null
}

export interface ProjectAssetsDTO {
  projectId: number
  summary: ProjectAssetSummaryDTO
  items: ProjectAssetItemDTO[]
}

export interface ProjectTaskSummaryDTO {
  totalCount: number
  imageCount: number
  videoCount: number
  audioCount: number
  exportCount: number
  confirmedCount: number
  candidateCount: number
  completedCount: number
  queuedCount: number
  runningCount: number
  successCount: number
  failedCount: number
  canceledCount: number
}

export interface ProjectTaskItemDTO {
  taskKey: string
  taskType: 'image' | 'video' | 'audio' | 'export'
  sourceId: number
  projectId: number
  sceneId?: number | null
  sceneNo?: number | null
  sceneTitle?: string | null
  storyboardId?: number | null
  characterId?: number | null
  shotNo?: string | null
  versionNo?: number | null
  title: string
  subtitle?: string | null
  status: string
  previewUrl?: string | null
  fileUrl?: string | null
  detailText?: string | null
  runtimeStatus?: 'queued' | 'running' | 'success' | 'failed' | 'canceled' | null
  progressPercent?: number | null
  runtimeMessage?: string | null
  errorText?: string | null
  canRetry?: boolean
  canCancel?: boolean
  confirmedAt?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export interface ProjectTasksDTO {
  projectId: number
  summary: ProjectTaskSummaryDTO
  items: ProjectTaskItemDTO[]
}

export interface FinalEditVideoClipDTO {
  storyboardId: number
  sceneId: number
  sceneNo: number
  sceneTitle?: string | null
  shotNo?: string | null
  shotType?: string | null
  durationSeconds: number
  sourceType?: 'video' | 'static' | string
  videoUrl?: string | null
  imageUrl?: string | null
  thumbnailUrl?: string | null
  versionNo: number
  confirmedAt?: string | null
  sortOrder: number
  enabled: boolean
  order: number
}

export interface FinalEditAudioClipDTO {
  id: number
  projectId: number
  trackType: 'dialogue' | 'narration' | 'music' | 'sfx' | string
  sceneId?: number | null
  storyboardId?: number | null
  shotNo?: string | null
  characterId?: number | null
  versionNo: number
  title: string
  audioUrl: string
  durationSeconds?: number | null
  startOffsetSeconds?: number | null
  voiceName?: string | null
  modelName?: string | null
  confirmedAt?: string | null
  createdAt: string
}

export interface FinalEditAudioMixTrackDTO {
  enabled: boolean
  volume: number
}

export interface FinalEditDraftDTO {
  videoClips: Array<{
    storyboardId: number
    enabled: boolean
    order: number
  }>
  audioMix: {
    dialogue: FinalEditAudioMixTrackDTO
    narration: FinalEditAudioMixTrackDTO
    music: FinalEditAudioMixTrackDTO
    sfx: FinalEditAudioMixTrackDTO
  }
  updatedAt?: string | null
}

export interface FinalEditValidationIssueDTO {
  code: string
  message: string
}

export interface FinalEditDTO {
  projectId: number
  projectName: string
  videoTrack: {
    items: FinalEditVideoClipDTO[]
    totalCount: number
    totalDurationSeconds: number
    enabledCount: number
    enabledDurationSeconds: number
  }
  audioTracks: {
    dialogue: FinalEditAudioClipDTO[]
    narration: FinalEditAudioClipDTO[]
    music: FinalEditAudioClipDTO[]
    sfx: FinalEditAudioClipDTO[]
  }
  audioMix: FinalEditDraftDTO['audioMix']
  draft: FinalEditDraftDTO
  validation: {
    canExport: boolean
    enabledVideoCount: number
    enabledVideoDurationSeconds: number
    availableAudioTrackCount: number
    enabledAudioTrackCount: number
    totalStoryboardCount: number
    confirmedVideoCount: number
    missingVideoCount: number
    missingStoryboardSceneCount: number
    blockingIssues: FinalEditValidationIssueDTO[]
    warningIssues: FinalEditValidationIssueDTO[]
  }
  summary: {
    confirmedVideoCount: number
    confirmedAudioCount: number
    hasVideo: boolean
    hasAudio: boolean
    totalDurationSeconds: number
    sourceDurationSeconds: number
    enabledAudioTrackCount: number
    availableAudioTrackCount: number
    totalStoryboardCount: number
    missingVideoCount: number
    missingStoryboardSceneCount: number
  }
}

export interface ModelSettingGroupDTO {
  key: string
  label: string
}

export interface ModelSettingFieldDTO {
  key: string
  group: string
  label: string
  type: 'text' | 'secret' | 'select' | 'boolean' | 'number'
  value: string
  options?: string[]
  persisted: boolean
  secretConfigured?: boolean
  source: 'database' | 'environment' | string
}

export interface ModelSettingsDTO {
  groups: ModelSettingGroupDTO[]
  fields: ModelSettingFieldDTO[]
  effective: {
    text: {
      provider: string
      defaultModel: string
      outlineModel: string
      scriptModel: string
      storyboardModel: string
      characterModel: string
    }
    frame: {
      provider: string
      defaultModel: string
      fallbackModels: string[]
      imageSize: string
      imageRatio: string
    }
    video: {
      provider: string
      defaultModel: string
      size: string
      lipSyncProvider: string
      lipSyncModel: string
    }
    audio: {
      provider: string
      defaultModel: string
      fallbackModel: string
      defaultVoice: string
    }
  }
}

interface ApiResponse<T> {
  code: number
  message: string
  data: T
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

async function fetchWithConnectRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= API_CONNECT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await fetch(url, init)
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
      lastError = error
      const delayMs = API_CONNECT_RETRY_DELAYS_MS[attempt]
      if (delayMs == null) break
      await sleep(delayMs)
    }
  }
  throw lastError instanceof Error ? lastError : new TypeError('fetch failed')
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAuthToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  let response: Response
  try {
    response = await fetchWithConnectRetry(`${API_BASE_URL}${path}`, { ...init, headers })
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('后端连接暂时不可用，请确认服务正在运行')
    }
    throw error
  }

  const payload = (await response.json()) as ApiResponse<T> | { code?: number; message?: string }
  if (!response.ok || ('code' in payload && payload.code !== 0)) {
    const message = 'message' in payload && payload.message ? payload.message : '请求失败'
    throw new Error(message)
  }

  return (payload as ApiResponse<T>).data
}

export function listProjects() {
  return request<{ items: ProjectDTO[] }>('/projects').then((res) => res.items)
}

export function getProject(id: number) {
  return request<ProjectDTO>(`/projects/${id}`)
}

export function createProject(payload: {
  name: string
  category?: string
  targetDuration?: number
  narrativeVision?: string
  visualStyle?: string
  aspectRatio?: string
}) {
  return request<ProjectDTO>('/projects', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getLatestOutline(projectId: number) {
  return request<OutlineDTO | null>(`/projects/${projectId}/outline`)
}

export function generateOutline(projectId: number) {
  return request<OutlineDTO>(`/projects/${projectId}/outline/generate`, {
    method: 'POST',
  })
}

export function listScenes(projectId: number) {
  return request<{ items: SceneDTO[] }>(`/projects/${projectId}/scenes`).then((res) => res.items)
}

export function generateScenes(projectId: number) {
  return request<{ items: SceneDTO[] }>(`/projects/${projectId}/scenes/generate`, {
    method: 'POST',
  }).then((res) => res.items)
}

export function getScene(sceneId: number) {
  return request<SceneDTO>(`/scenes/${sceneId}`)
}

export function generateSceneScript(sceneId: number) {
  return request<SceneDTO>(`/scenes/${sceneId}/script/generate`, {
    method: 'POST',
  })
}

export function saveSceneScript(
  sceneId: number,
  payload: { content?: string; mood?: string; title?: string },
) {
  return request<SceneDTO>(`/scenes/${sceneId}/script`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function updateScene(
  sceneId: number,
  payload: Partial<{
    title: string | null
    summary: string | null
    location: string | null
    timeOfDay: string | null
    estimatedDuration: number | null
  }>,
) {
  return request<SceneDTO>(`/scenes/${sceneId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function listStoryboards(sceneId: number) {
  return request<{ items: StoryboardDTO[] }>(`/scenes/${sceneId}/storyboards`).then(
    (res) => res.items,
  )
}

export function generateStoryboards(sceneId: number) {
  return request<{ items: StoryboardDTO[] }>(`/scenes/${sceneId}/storyboards/generate`, {
    method: 'POST',
  }).then((res) => res.items)
}

export function getStoryboard(storyboardId: number) {
  return request<StoryboardDTO>(`/storyboards/${storyboardId}`)
}

export function updateStoryboard(
  storyboardId: number,
  payload: Partial<{
    shotType: string
    cameraAngle: string
    composition: string
    durationSeconds: number
    characterId: number | null
    characterName: string
    actionText: string
    dialogueText: string
    visualPrompt: string
    startVisualPrompt: string
    endVisualPrompt: string
    imageUrl: string
    endImageUrl: string
    status: string
  }>,
) {
  return request<StoryboardDTO>(`/storyboards/${storyboardId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function rewriteStoryboardFramePrompt(storyboardId: number) {
  return request<FramePromptRewriteDTO>(`/storyboards/${storyboardId}/frame-prompt/rewrite`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function optimizeStoryboardKeyframes(storyboardId: number) {
  return request<{
    storyboard: StoryboardDTO
    startVisualPrompt: string
    endVisualPrompt: string
    notes?: string | null
  }>(`/storyboards/${storyboardId}/keyframes/optimize`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function copyPreviousFrameToStoryboard(storyboardId: number) {
  return request<{
    storyboard: StoryboardDTO
    image: ImageAssetDTO
    sourceStoryboardId: number
    sourceShotNo?: string | null
  }>(`/storyboards/${storyboardId}/continuity/start-frame`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function splitStoryboard(storyboardId: number) {
  return request<{
    items: StoryboardDTO[]
    current?: StoryboardDTO | null
    createdCount: number
  }>(`/storyboards/${storyboardId}/split`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function splitStoryboardDialogue(storyboardId: number) {
  return request<{
    items: StoryboardDTO[]
    current?: StoryboardDTO | null
    createdCount: number
    speakers: string[]
  }>(`/storyboards/${storyboardId}/dialogue/split`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function reorderStoryboards(orders: Array<{ id: number; sortOrder: number }>) {
  return request<{ success: boolean }>('/storyboards/reorder', {
    method: 'POST',
    body: JSON.stringify({ orders }),
  })
}

export function listCharacters(projectId: number) {
  return request<{ items: CharacterDTO[] }>(`/projects/${projectId}/characters`).then(
    (res) => res.items,
  )
}

export function generateProjectCharacters(projectId: number) {
  return request<{ items: CharacterDTO[] }>(`/projects/${projectId}/characters/generate`, {
    method: 'POST',
  }).then((res) => res.items)
}

export function getCharacter(characterId: number) {
  return request<CharacterDTO>(`/characters/${characterId}`)
}

export function createCharacter(
  projectId: number,
  payload: {
    name: string
    roleTag?: string | null
    personality?: string | null
    appearance?: string | null
    voiceSetting?: string | null
    ageGroup?: string | null
    gender?: string | null
    voiceStyle?: string | null
    referenceImageUrl?: string | null
  },
) {
  return request<CharacterDTO>(`/projects/${projectId}/characters`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateCharacter(
  characterId: number,
  payload: Partial<{
    name: string
    roleTag: string | null
    personality: string | null
    appearance: string | null
    voiceSetting: string | null
    ageGroup: string | null
    gender: string | null
    voiceStyle: string | null
    referenceImageUrl: string | null
    status: string
    syncNameReferences: boolean
  }>,
) {
  return request<CharacterDTO>(`/characters/${characterId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function previewCharacterRename(characterId: number, name: string) {
  return request<CharacterRenameImpactDTO>(`/characters/${characterId}/rename-preview`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export function generateCharacterProfile(characterId: number) {
  return request<CharacterDTO>(`/characters/${characterId}/generate-profile`, {
    method: 'POST',
  })
}

export function listCharacterImages(characterId: number) {
  return request<{ items: CharacterImageDTO[] }>(`/characters/${characterId}/images`).then(
    (res) => res.items,
  )
}

export function generateCharacterImages(
  characterId: number,
  payload?: { prompt?: string; modelName?: string; candidateCount?: number },
) {
  return request<GenerationJobDTO>(`/characters/${characterId}/images/generate`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
}

export function getGenerationJob(jobId: number) {
  return request<GenerationJobDTO>(`/generation-jobs/${jobId}`)
}

export function confirmCharacterImage(imageId: number) {
  return request<CharacterImageDTO>(`/character-images/${imageId}/confirm`, {
    method: 'POST',
  })
}

export function previewCharacterVoice(
  characterId: number,
  payload?: { text?: string; voiceName?: string; modelName?: string; voiceProfileKey?: string },
) {
  return request<CharacterVoicePreviewDTO>(`/characters/${characterId}/voice-preview`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
}

export function listVoiceProfiles() {
  return request<{
    items: VoiceProfileDTO[]
    ageGroups: Array<{ value: string; label: string }>
    genders: Array<{ value: string; label: string }>
  }>('/voice-profiles')
}

export function getCharacterVoiceRecommendations(characterId: number) {
  return request<{
    character: CharacterDTO
    traits: CharacterVoiceTraitsDTO
    selectedProfile?: VoiceProfileDTO | null
    items: VoiceRecommendationDTO[]
  }>(`/characters/${characterId}/voice-recommendations`)
}

export function bindCharacterVoice(
  characterId: number,
  payload: {
    voiceProfileKey: string
    ageGroup?: string | null
    gender?: string | null
    voiceStyle?: string | null
    locked?: boolean
  },
) {
  return request<{
    character: CharacterDTO
    selectedProfile: VoiceProfileDTO
    traits: CharacterVoiceTraitsDTO
  }>(`/characters/${characterId}/voice-binding`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function listProjectVoiceCast(projectId: number) {
  return request<{ items: CharacterVoiceCastDTO[] }>(`/projects/${projectId}/voice-cast`).then(
    (res) => res.items,
  )
}

export function generateShotImages(
  shotId: number,
  payload?: {
    prompt?: string
    negativePrompt?: string
    modelName?: string
    candidateCount?: number
    frameRole?: 'primary' | 'start' | 'end' | string
  },
) {
  return request<GenerationJobDTO>(`/shots/${shotId}/images/generate`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
}

export function listShotImages(shotId: number) {
  return request<{ items: ImageAssetDTO[] }>(`/shots/${shotId}/images`).then((res) => res.items)
}

export function confirmImage(imageId: number) {
  return request<ImageAssetDTO>(`/images/${imageId}/confirm`, {
    method: 'POST',
  })
}

export function generateStoryboardVideos(
  storyboardId: number,
  payload?: {
    prompt?: string
    motionMode?: string
    durationSeconds?: number
    modelName?: string
    candidateCount?: number
  },
) {
  return request<{ items: VideoAssetDTO[] }>(`/storyboards/${storyboardId}/videos/generate`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  }).then((res) => res.items)
}

export function generateStoryboardLipSync(
  storyboardId: number,
  payload?: { prompt?: string; autoConfirm?: boolean },
) {
  return request<GenerationJobDTO>(`/storyboards/${storyboardId}/lip-sync/generate`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
}

export function listStoryboardVideos(storyboardId: number) {
  return request<{ items: VideoAssetDTO[] }>(`/storyboards/${storyboardId}/videos`).then(
    (res) => res.items,
  )
}

export function confirmVideo(videoId: number) {
  return request<VideoAssetDTO>(`/videos/${videoId}/confirm`, {
    method: 'POST',
  })
}

export function generateProjectAudio(
  projectId: number,
  payload?: {
    trackType?: 'dialogue' | 'narration' | 'music' | 'sfx' | string
    sceneId?: number | null
    storyboardId?: number | null
    characterId?: number | null
    title?: string
    text?: string
    voiceName?: string
    voiceProfileKey?: string
    durationSeconds?: number
    startOffsetSeconds?: number
    modelName?: string
    candidateCount?: number
  },
) {
  return request<{ items: AudioAssetDTO[] }>(`/projects/${projectId}/audio/generate`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  }).then((res) => res.items)
}

export function listProjectAudio(projectId: number) {
  return request<{ items: AudioAssetDTO[] }>(`/projects/${projectId}/audio`).then(
    (res) => res.items,
  )
}

export function confirmProjectAudio(audioId: number) {
  return request<AudioAssetDTO>(`/audio-assets/${audioId}/confirm`, {
    method: 'POST',
  })
}

export function updateProjectAudioPlacement(
  audioId: number,
  payload: { storyboardId?: number | null; startOffsetSeconds?: number },
) {
  return request<AudioAssetDTO>(`/audio-assets/${audioId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function archiveAudio(audioId: number) {
  return request<AudioAssetDTO>(`/audio-assets/${audioId}/archive`, {
    method: 'POST',
  })
}

export function getProjectExportPackage(projectId: number) {
  return request<ExportPackageDTO>(`/projects/${projectId}/export-package`)
}

export function listProjectExports(projectId: number) {
  return request<{ items: ExportRecordDTO[] }>(`/projects/${projectId}/exports`).then(
    (res) => res.items,
  )
}

export function createProjectExport(
  projectId: number,
  payload?: {
    format?: string
    resolution?: string
    frameRate?: number
    burnSubtitle?: boolean
  },
) {
  return request<ExportRecordDTO>(`/projects/${projectId}/exports`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
}

export function getExport(exportId: number) {
  return request<ExportRecordDTO>(`/exports/${exportId}`)
}

export function getProjectAssets(projectId: number) {
  return request<ProjectAssetsDTO>(`/projects/${projectId}/assets`)
}

export function getProjectTasks(projectId: number) {
  return request<ProjectTasksDTO>(`/projects/${projectId}/tasks`)
}

export function retryProjectTask(taskKey: string) {
  return request<ProjectTaskItemDTO>(`/project-tasks/${taskKey}/retry`, {
    method: 'POST',
  })
}

export function cancelProjectTask(taskKey: string) {
  return request<ProjectTaskItemDTO>(`/project-tasks/${taskKey}/cancel`, {
    method: 'POST',
  })
}

export function getProjectFinalEdit(projectId: number) {
  return request<FinalEditDTO>(`/projects/${projectId}/final-edit`)
}

export function updateProjectFinalEditDraft(
  projectId: number,
  payload: Pick<FinalEditDraftDTO, 'videoClips' | 'audioMix'>,
) {
  return request<FinalEditDTO>(`/projects/${projectId}/final-edit-draft`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function getModelSettings() {
  return request<ModelSettingsDTO>('/model-settings')
}

export function updateModelSettings(
  settings: Array<{ key: string; value: string | number | boolean }>,
) {
  return request<ModelSettingsDTO>('/model-settings', {
    method: 'PUT',
    body: JSON.stringify({ settings }),
  })
}
