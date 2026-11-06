//前端所有后端请求，统一遥控器
/*自动拼 API 地址
自动带上登录 token
连接失败会短暂重试
把接口包装成 listProjects()、generateShotImages()、generateStoryboardVideos() 这种业务函数*/
import { getAuthToken } from './auth'
import { normalizeBrowserMediaUrl } from '@/lib/media-url'

const API_BASE_URL = `${import.meta.env.VITE_API_BASE_URL || '/api'}`.replace(/\/$/, '')
const API_CONNECT_RETRY_DELAYS_MS = [300, 800, 1500, 2500, 4000]
const API_REQUEST_TIMEOUT_MS = 12_000

// 这个文件是前端访问后端业务接口的统一客户端。
// 页面不要直接手写 fetch，而是调用这里的函数，比如 generateShotImages / createProjectExport。
// 好处是 token、错误处理、重试和返回结构都集中管理。

export interface ProjectDTO {
  /** 项目 ID（主键） */
  id: number
  /** 所属用户 ID */
  userId: number
  /** 项目名称 */
  name: string
  /** 项目分类（如"都市爱情""悬疑推理"等） */
  category?: string | null
  /** 目标成片时长（单位：秒） */
  targetDuration?: number | null
  /** 叙事愿景（整体故事调性描述） */
  narrativeVision?: string | null
  /** 视觉风格（如"赛博朋克""复古胶片"等） */
  visualStyle?: string | null
  /** 画面比例（如 "16:9" "9:16" "1:1"） */
  aspectRatio?: string | null
  /** 项目状态：draft/outlined/scripting/storyboarding 等 */
  status: string
  /** 归档时间；为空表示项目仍在主列表 */
  archivedAt?: string | null
  /** 创建时间（ISO 字符串） */
  createdAt: string
  /** 最近更新时间（ISO 字符串） */
  updatedAt: string
  /** 项目整体进度百分比（0-100） */
  progressPercent?: number
  /** 当前进度阶段标签 */
  progressStage?: string | null
  /** 进度是否已完成 */
  progressComplete?: boolean
  /** 各素材类型的数量统计 */
  progressDetails?: {
    /** 已生成大纲数量 */
    outlineCount: number
    /** 场景数量 */
    sceneCount: number
    /** 分镜数量 */
    storyboardCount: number
    /** 已确认的图片数量 */
    confirmedImageCount: number
    /** 已确认的视频数量 */
    confirmedVideoCount: number
    /** 已确认的音频数量 */
    confirmedAudioCount: number
    /** 已完成的导出包数量 */
    completedExportCount: number
  } | null
  /** 最近一次导出的视频信息 */
  latestVideo?: {
    /** 导出记录 ID */
    exportId: number
    /** 视频文件 URL */
    videoUrl?: string | null
    /** 成片封面；无导出封面时可回退为已确认分镜帧 */
    coverUrl?: string | null
    /** 视频时长（秒） */
    durationSeconds?: number | null
    /** 导出时间 */
    createdAt?: string | null
  } | null
  /** 项目列表使用的真实视觉封面 */
  coverUrl?: string | null
}

export interface OutlineAct {
  /** 幕次编号（1/2/3） */
  act: number
  /** 幕次标题 */
  title?: string
  /** 幕次摘要 */
  summary: string
}

export interface OutlineScene {
  /** 场景编号 */
  scene_no: number
  /** 场景标题 */
  title: string
  /** 场景摘要 */
  summary: string
  /** 场景地点 */
  location: string
  /** 时间段（如"白天""夜晚"） */
  time_of_day: string
  /** 预估时长（秒） */
  estimated_duration: number
}

export interface OutlineDTO {
  /** 大纲 ID */
  id: number
  /** 所属项目 ID */
  projectId: number
  /** 版本号 */
  versionNo: number
  /** 大纲标题 */
  title?: string | null
  /** 故事一句话梗概 */
  logline?: string | null
  /** 故事前提/设定 */
  premise?: string | null
  /** 第一幕正文 */
  act1Text?: string | null
  /** 第二幕正文 */
  act2Text?: string | null
  /** 第三幕正文 */
  act3Text?: string | null
  /** 视觉风格描述 */
  visualStyle?: string | null
  /** 三幕结构列表 */
  acts: OutlineAct[]
  /** 场景列表 */
  scenes: OutlineScene[]
  /** 创建时间 */
  createdAt: string
}

export interface StoryQualityBlockerDTO {
  field: string
  message: string
  severity: 'blocker' | 'warning'
}

export interface StoryQualityDimensionDTO {
  key: string
  label: string
  weight: number
  score: number
  passed?: boolean
}

export interface StoryQualityReportDTO {
  type: 'story_bible' | 'season_structure'
  score: number
  threshold: number
  canLock: boolean
  blockers: StoryQualityBlockerDTO[]
  warnings: StoryQualityBlockerDTO[]
  dimensions: StoryQualityDimensionDTO[]
  marketQuality?: {
    type: 'market_season'
    score: number
    threshold: number
    canPass: boolean
    blockers: StoryQualityBlockerDTO[]
    warnings: StoryQualityBlockerDTO[]
    dimensions: StoryQualityDimensionDTO[]
    episodeReports: Array<{
      type: 'market_episode'
      score: number
      threshold: number
      canPass: boolean
      blockers: StoryQualityBlockerDTO[]
      warnings: StoryQualityBlockerDTO[]
      dimensions: StoryQualityDimensionDTO[]
      visualSetPieces: string[]
    }>
    coverage: {
      episodeCount: number
      reversalCount: number
      endingHookCount: number
    }
  }
}

export interface StoryBibleCharacterDTO {
  name: string
  role: string
  goal: string
  fear: string
  secret: string
  growthArc: string
  visualDescription: string
}

export interface StoryBibleDTO {
  id: number
  projectId: number
  versionNo: number
  status: 'draft' | 'locked'
  title: string
  logline: string
  audience: string
  emotionalPromise: string
  worldRules: string[]
  timeline: string[]
  locations: string[]
  characters: StoryBibleCharacterDTO[]
  relationships: string[]
  props: string[]
  mainPlot: string
  subplots: string[]
  foreshadowing: string[]
  lockedFacts: string[]
  flexibleFacts: string[]
  visualSymbols: string[]
  qualityReport?: StoryQualityReportDTO | null
  lockedAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface SeasonEpisodeDTO {
  episodeNo: number
  title: string
  logline: string
  openingHook: string
  goal: string
  coreConflict: string
  irreversibleChange: string
  endingHook: string
  protagonistChoice: string
  reversal: string
  visualSetPieces: string[]
}

export interface SeasonStructureDTO {
  id: number
  projectId: number
  storyBibleId?: number | null
  versionNo: number
  status: 'draft' | 'locked'
  seasonTheme: string
  coreConflict: string
  structureType: string
  episodeCount: number
  episodes: SeasonEpisodeDTO[]
  foreshadowingPlan: string[]
  characterArcs: string[]
  qualityReport?: StoryQualityReportDTO | null
  lockedAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface SceneDTO {
  /** 场景 ID */
  id: number
  /** 所属项目 ID */
  projectId: number
  /** 所属集数；与 sceneNo（场景顺序号）分开 */
  episodeNo: number
  /** 关联大纲 ID */
  outlineId?: number | null
  /** 场景编号（顺序号） */
  sceneNo: number
  /** 场景标题 */
  title?: string | null
  /** 场景摘要 */
  summary?: string | null
  /** 场景正文（完整剧本内容） */
  content?: string | null
  /** 场景氛围/情绪 */
  mood?: string | null
  /** 场景地点 */
  location?: string | null
  /** 时间段 */
  timeOfDay?: string | null
  /** 预估时长（秒） */
  estimatedDuration?: number | null
  /** 排序序号 */
  sortOrder: number
  /** 场景状态 */
  status: string
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
}

export interface StoryboardDTO {
  /** 分镜 ID */
  id: number
  /** 所属场景 ID */
  sceneId: number
  /** 镜头编号（如 "01" "02"） */
  shotNo: string
  /** 景别（如"特写""全景""中景"等） */
  shotType?: string | null
  /** 镜头角度（如"俯拍""仰拍""正面"等） */
  cameraAngle?: string | null
  /** 构图方式 */
  composition?: string | null
  /** 镜头时长（秒） */
  durationSeconds?: number | null
  /** 关联角色 ID */
  characterId?: number | null
  /** 角色名称（冗余存储，方便展示） */
  characterName?: string | null
  /** 动作描述文本 */
  actionText?: string | null
  /** 对白文本 */
  dialogueText?: string | null
  /** AI 生成的画面提示词 */
  visualPrompt?: string | null
  /** 本镜头结构化表演、情绪、声音和口型同步参数 */
  performance?: StoryboardPerformanceDTO | null
  /** 本镜头的叙事目的：hook/dialogue/reaction/insert 等 */
  shotPurpose?: string | null
  /** 镜头内的表演节拍 */
  actingBeat?: string | null
  /** 对白与环境声的表演方向 */
  audioDirection?: string | null
  /** 对白时长策略；生产默认 preserve */
  speechDurationPolicy?: 'preserve' | 'compress' | string | null
  /** 是否为反应镜头 */
  reactionShot?: boolean
  /** 起始帧提示词（用于首尾帧生成） */
  startVisualPrompt?: string | null
  /** 结束帧提示词 */
  endVisualPrompt?: string | null
  /** 生成的静帧图片 URL */
  imageUrl?: string | null
  /** 结束帧图片 URL */
  endImageUrl?: string | null
  /** 生成的视频 URL */
  videoUrl?: string | null
  /** 排序序号 */
  sortOrder: number
  /** 分镜状态 */
  status: string
  /** 已确认角色、场景和道具的生产版本快照 */
  assetReference?: Record<string, unknown> | null
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
  /** 分镜角色约束上下文（用于保证角色一致性） */
  frameCharacterContext?: FrameCharacterContextDTO | null
}

export interface StoryboardPerformanceDTO {
  emotion: string
  intensity: number
  emotionStart: string
  emotionTrigger: string
  emotionChange: string
  emotionEnd: string
  microExpression: string
  breathAction: string
  bodyAction: string
  voiceTone: string
  voiceVolume: string
  speechRate: string
  speechPauses: string
  lipSync: string
  continuityFromPrevious: string
}

export interface StoryboardPerformanceSubShotDTO {
  shotType: string
  cameraAngle: string
  composition: string
  characterId?: number | null
  characterName?: string | null
  durationSeconds: number
  actionText: string
  dialogueText: string
  visualPrompt: string
  startVisualPrompt?: string
  endVisualPrompt?: string
  shotPurpose: string
  actingBeat: string
  audioDirection: string
  speechDurationPolicy: string
  reactionShot: boolean
}

export interface StoryboardPerformancePlanDTO {
  version: string
  strategy: string
  source: {
    storyboardId: number | null
    sceneId: number | null
    shotNo: string
    durationSeconds: number
  }
  hasDialogue: boolean
  hasReaction: boolean
  speechTimingPreserved: boolean
  totalDurationSeconds: number
  durationDeltaSeconds: number
  subShots: StoryboardPerformanceSubShotDTO[]
  blockingIssues: string[]
  assets: {
    imageCount: number
    continuityStartImageCount: number
    videoCount: number
    audioCount: number
  }
  applyAllowed: boolean
  applyBlockers: string[]
}

export interface FrameCharacterConstraintDTO {
  /** 角色 ID */
  characterId: number
  /** 当前生产基线版本 */
  characterVersionNo?: number | null
  /** 角色名称 */
  name: string
  /** 角色标签（如"主角""反派"等） */
  roleTag?: string | null
  /** 性别 */
  gender?: 'male' | 'female' | 'neutral' | string | null
  /** 性别中文标签 */
  genderLabel: string
  /** 年龄段 */
  ageGroup?: string | null
  /** 年龄段中文标签 */
  ageGroupLabel: string
  /** 外貌描述 */
  appearance?: string | null
  /** 固定服装与随身物件 */
  costume?: string | null
  /** 性格描述 */
  personality?: string | null
  /** 参考图 URL（用于保持角色形象一致性） */
  referenceImageUrl?: string | null
  /** 角色参考音频 URL */
  referenceAudioUrl?: string | null
  /** 是否已配置参考图 */
  hasReferenceImage: boolean
  /** 是否为主要角色 */
  isPrimary: boolean
  /** 性别是否由 AI 推断 */
  inferredGender: boolean
  /** 年龄是否由 AI 推断 */
  inferredAge: boolean
}

export interface FrameCharacterContextDTO {
  /** 角色信息是否准备就绪（可开始生成） */
  ready: boolean
  /** 是否为无角色的纯画面分镜 */
  characterFree: boolean
  /** 主要角色 ID */
  primaryCharacterId?: number | null
  /** 分镜涉及的所有角色约束列表 */
  characters: FrameCharacterConstraintDTO[]
  /** 阻塞原因（阻止生成的错误信息） */
  blockers: string[]
  /** 警告信息（不阻止生成但需注意） */
  warnings: string[]
}

export interface FramePromptRewriteDTO {
  /** 重写后的画面提示词 */
  visualPrompt: string
  /** AI 备注/说明 */
  notes?: string | null
  /** 重写时使用的角色约束上下文 */
  frameCharacterContext?: FrameCharacterContextDTO | null
}

export interface CharacterDTO {
  /** 角色 ID */
  id: number
  /** 所属项目 ID */
  projectId: number
  /** 角色名称 */
  name: string
  /** 角色标签（如"主角""反派""导师"等） */
  roleTag?: string | null
  /** 性格描述 */
  personality?: string | null
  /** 外貌描述 */
  appearance?: string | null
  /** 固定服装与随身物件描述 */
  costume?: string | null
  /** 语音设置文本 */
  voiceSetting?: string | null
  /** 年龄段：child/teen/young_adult/middle_aged/senior */
  ageGroup?: 'child' | 'teen' | 'young_adult' | 'middle_aged' | 'senior' | string | null
  /** 性别 */
  gender?: 'male' | 'female' | 'neutral' | string | null
  /** 语音风格描述 */
  voiceStyle?: string | null
  /** 绑定的声线 Profile Key */
  voiceProfileKey?: string | null
  /** 千问等供应商创建的自定义声音设计记录 */
  voiceDesign?: CharacterVoicePreviewDTO['voiceDesign'] | null
  /** 声线是否已锁定（锁定后 AI 不会自动切换） */
  voiceLocked: boolean
  /** 外貌与身份参考是否已锁定 */
  appearanceLocked: boolean
  /** 固定服装与随身物件是否已锁定 */
  costumeLocked: boolean
  /** 参考图 URL（用于保持角色形象一致性） */
  referenceImageUrl?: string | null
  /** 角色参考音频 URL（用于绑定角色音色） */
  referenceAudioUrl?: string | null
  /** 角色状态 */
  status: string
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
}

export interface CharacterRenameImpactDTO {
  /** 角色 ID */
  characterId: number
  /** 原始名称 */
  oldName: string
  /** 新名称 */
  newName: string
  /** 可能受影响的源名称列表（别名/昵称） */
  sourceNames: string[]
  /** 受影响的总记录数 */
  totalRecords: number
  /** 受影响的出现次数 */
  totalOccurrences: number
  /** 各数据区域的影响统计 */
  sections: {
    /** 项目级描述中的影响 */
    project: { records: number; occurrences: number }
    /** 大纲中的影响 */
    outline: { records: number; occurrences: number }
    /** 场景中的影响 */
    scenes: { records: number; occurrences: number }
    /** 分镜中的影响 */
    storyboards: { records: number; occurrences: number }
  }
  /** 历史媒体素材影响（已生成的图片/视频/音频中包含旧名称） */
  historicalMedia: {
    /** 角色形象数 */
    characterImages: number
    /** 图片资产数 */
    imageAssets: number
    /** 视频资产数 */
    videoAssets: number
    /** 音频资产数 */
    audioAssets: number
  }
  /** 重命名过程中的警告 */
  warnings: {
    /** 大纲 JSON 是否存在解析异常 */
    invalidOutlineJson: boolean
  }
}

export interface CharacterImageDTO {
  /** 角色形象 ID */
  id: number
  /** 所属角色 ID */
  characterId: number
  /** 版本号（第几代生成结果） */
  versionNo: number
  /** 生成的图片 URL */
  imageUrl: string
  /** 缩略图 URL */
  thumbnailUrl?: string | null
  /** 生成时使用的提示词快照 */
  promptSnapshot?: string | null
  /** 使用的 AI 模型名称 */
  modelName?: string | null
  /** 状态：pending/confirmed/rejected */
  status: string
  /** 确认时间 */
  confirmedAt?: string | null
  /** 创建时间 */
  createdAt: string
}

export interface CharacterVersionDTO {
  id: number
  characterId: number
  versionNo: number
  status: string
  snapshot: Record<string, unknown>
  constraintText: string
  productionReady: boolean
  changeReason?: string | null
  createdBy?: number | null
  createdAt?: string | null
}

export type CharacterRegressionSampleType =
  | 'character_image'
  | 'storyboard_image'
  | 'video_frame'

export interface CharacterRegressionSampleDTO {
  id: number
  projectId: number
  characterId: number
  versionNo: number
  sampleType: CharacterRegressionSampleType
  sourceId?: number | null
  assetUrl: string
  note?: string | null
  status: string
  createdBy?: number | null
  createdAt?: string | null
  updatedAt?: string | null
}

export interface CharacterConsistencyReportDTO {
  ready: boolean
  summary: {
    totalCharacters: number
    readyCharacters: number
    blockedCharacters: number
    regressionSamples: number
    staleSamples: number
  }
  characters: Array<{
    characterId: number | null
    name: string
    ready: boolean
    blockers: Array<{ code: string; message: string; severity: string }>
    warnings: Array<{ code: string; message: string; severity: string }>
    locks: { appearance: boolean; costume: boolean; voice: boolean }
    latestVersionNo: number | null
  }>
  samples: {
    total: number
    stale: CharacterRegressionSampleDTO[]
    current: CharacterRegressionSampleDTO[]
  }
  blockers: Array<Record<string, unknown>>
  warnings: Array<Record<string, unknown>>
}

export interface CharacterVoicePreviewDTO {
  /** 预览音频 URL */
  audioUrl: string
  /** 音频时长（秒） */
  durationSeconds?: number | null
  /** 声线名称 */
  voiceName: string
  /** 使用的模型名称 */
  modelName: string
  /** 声线 Profile Key */
  voiceProfileKey?: string | null
  /** 声线显示名称 */
  voiceProfileName?: string | null
  /** 实际使用的声线性别 */
  voiceProfileGender?: string | null
  /** 声线指令/风格说明 */
  voiceInstructions?: string | null
  /** 声音 Agent 设计结果 */
  voiceDesign?: {
    name: string
    summary: string
    timbre?: string
    ageAndGender?: string
    emotionArc?: string
    rhythm?: string
    breathingAndPauses?: string
    performanceInstructions?: string
    avoid?: string[]
    sampleText?: string
    provider?: string
    model?: string
    voiceId?: string
    targetModel?: string
    status?: string
    voicePrompt?: string
    generationSource?: 'agent' | 'rules_fallback' | string
  } | null
  /** 创建或试听的自定义音色 ID */
  voiceId?: string | null
  /** 创建或试听的目标合成模型 */
  targetModel?: string | null
  /** 是否已把试听音频保存为角色参考音频 */
  referenceAudioBound?: boolean
  referenceAudioUrl?: string | null
  character?: CharacterDTO | null
}

function normalizePreviewMediaUrl(value: string): string {
  return normalizeBrowserMediaUrl(value, typeof window === 'undefined' ? '' : window.location.origin)
}

export interface VoiceProfileDTO {
  /** 声线唯一 Key */
  profileKey: string
  /** 声线显示名称 */
  displayName: string
  /** 提供商标识（如 "doubao" "cosyvoice"） */
  provider: string
  /** 模型名称 */
  modelName: string
  /** 底层声音 ID */
  voiceId: string
  /** 性别倾向 */
  gender: 'male' | 'female' | 'neutral' | string
  /** 适用年龄段 */
  ageGroups: string[]
  /** 风格标签（如"温柔""磁性""活泼"等） */
  styleTags: string[]
  /** 声线描述 */
  description: string
  /** 使用说明/指令 */
  instructions?: string | null
  /** 语言类型（如"zh-CN"） */
  languageType: string
  /** 状态：active/inactive */
  status: string
  /** 排序序号 */
  sortOrder: number
}

export interface VoiceRecommendationDTO extends VoiceProfileDTO {
  /** 匹配度评分（0-100） */
  score: number
  /** 推荐理由列表 */
  matchReasons: string[]
}

export interface CharacterVoiceTraitsDTO {
  /** 推断/指定的年龄段 */
  ageGroup?: string | null
  /** 推断/指定的性别 */
  gender?: string | null
  /** 匹配的风格标签 */
  styleTags: string[]
  /** 年龄段是否由 AI 推断 */
  inferredAge: boolean
  /** 性别是否由 AI 推断 */
  inferredGender: boolean
}

export interface CharacterVoiceCastDTO {
  /** 角色信息 */
  character: CharacterDTO
  /** 角色语音特征 */
  traits: CharacterVoiceTraitsDTO
  /** 当前选中的声线 */
  selectedProfile?: VoiceProfileDTO | null
  /** AI 推荐的声线列表 */
  recommendations: VoiceRecommendationDTO[]
  /** 角色声线是否已配置完成 */
  ready: boolean
}

export interface ImageAssetDTO {
  /** 图片资产 ID */
  id: number
  /** 所属分镜 ID */
  storyboardId: number
  /** 版本号 */
  versionNo: number
  /** 帧角色：primary(主帧)/start(起始帧)/end(结束帧) */
  frameRole?: 'primary' | 'start' | 'end' | string
  /** 图片 URL */
  imageUrl: string
  /** 缩略图 URL */
  thumbnailUrl?: string | null
  /** 生成时的提示词快照 */
  promptSnapshot?: string | null
  /** 负面提示词 */
  negativePrompt?: string | null
  /** 生成时使用的角色约束快照（用于追溯角色一致性） */
  characterSnapshot?: {
    /** 快照版本 */
    version: number
    /** 主要角色 ID */
    primaryCharacterId?: number | null
    /** 是否为无角色画面 */
    characterFree: boolean
    /** 参与的角色列表快照 */
    characters: Array<{
      characterId: number
      characterVersionNo?: number | null
      name: string
      roleTag?: string | null
      gender?: string | null
      genderLabel: string
      ageGroup?: string | null
      ageGroupLabel: string
      appearance?: string | null
      costume?: string | null
      referenceImageUrl?: string | null
      isPrimary: boolean
      inferredGender: boolean
      inferredAge: boolean
    }>
  } | null
  /** 使用的 AI 模型 */
  modelName?: string | null
  /** 状态 */
  status: string
  /** 确认时间 */
  confirmedAt?: string | null
  /** 创建时间 */
  createdAt: string
}

export interface GenerationJobDTO {
  /** 任务 ID */
  id: number
  /** 任务唯一 Key（用于重试/取消） */
  jobKey: string
  /** 所属项目 ID */
  projectId: number
  /** 任务类型：帧图片/角色图片/资产画布节点图片/视频/口型同步 */
  jobType: 'frame_image' | 'character_image' | 'asset_node_image' | 'video_image' | 'lip_sync' | 'subtitle_cleanup'
  /** 源对象 ID（分镜 ID / 角色 ID 等） */
  sourceId: number
  /** 任务状态 */
  status: 'queued' | 'running' | 'success' | 'failed' | 'canceled'
  /** 进度百分比（0-100） */
  progressPercent: number
  /** 任务结果 */
  result?: {
    /** 批量生成结果列表 */
    items?: Array<ImageAssetDTO | CharacterImageDTO | AssetNodeImageDTO | VideoAssetDTO>
    /** 单个视频结果 */
    item?: VideoAssetDTO
  } | null
  /** 错误信息 */
  errorText?: string | null
  /** 最近一次失败错误码 */
  lastErrorCode?: string | null
  /** 已执行次数 */
  attemptCount: number
  /** 最大执行次数 */
  maxAttempts: number
  /** 延迟重试的最早执行时间 */
  nextRunAt?: string | null
  /** 最近一次开始执行的时间 */
  lastStartedAt?: string | null
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
}

export interface VideoAssetDTO {
  /** 视频资产 ID */
  id: number
  /** 所属分镜 ID */
  storyboardId: number
  /** 关联的静帧图片 ID（视频基于该图片生成） */
  imageAssetId: number
  /** 版本号 */
  versionNo: number
  /** 视频 URL */
  videoUrl: string
  /** 缩略图 URL */
  thumbnailUrl?: string | null
  /** 视频确认尾帧，可作为下一镜首帧引用 */
  endFrameUrl?: string | null
  endFrameStorageKey?: string | null
  /** 运动模式（如"zoom_in""pan""static"等） */
  motionMode?: string | null
  /** 视频时长（秒） */
  durationSeconds?: number | null
  /** 使用的 AI 模型 */
  modelName?: string | null
  /** 视频生成后的媒体技术检查；剧情表现仍需人工观看确认 */
  qualityReport?: {
    version: number
    technicalStatus: 'passed' | 'needs_attention' | 'unchecked' | string
    semanticStatus: 'pending_review' | 'accepted_by_user' | string
    summary: string
    expected?: {
      durationSeconds?: number | null
      requiresMotion?: boolean
      requiresAudio?: boolean
    }
    metrics?: {
      width?: number | null
      height?: number | null
      durationSeconds?: number | null
      frameRate?: number | null
      audioCodec?: string
      meanVolumeDb?: number | null
      silenceRatio?: number | null
      frozenDurationSeconds?: number | null
      meanFrameDifference?: number | null
      maxFrameDifference?: number | null
      activeFrameRatio?: number | null
    }
    issues: Array<{ code: string; message: string; severity: string }>
    checkedAt?: string
  } | null
  /** 关联的音频资产 ID（口型同步时绑定的对白） */
  audioAssetId?: number | null
  /** 生成任务 ID */
  generationJobId?: number | null
  /** 是否由过期视频恢复队列生成 */
  isRecoveryVideo?: boolean
  /** 过期恢复视频的人工复核记录 */
  recoveryReview?: {
    decision: 'approved' | 'rework' | null
    checklist: {
      visualReviewed: boolean
      characterConsistencyReviewed: boolean
      motionContinuityReviewed: boolean
      characterChecks: Array<{
        characterId: number
        decision: 'matched' | 'rework'
        note?: string | null
      }>
    }
    note?: string | null
    reviewedBy?: number | null
    reviewedAt?: string | null
  }
  /** 过期恢复视频的自动技术检查与抽帧证据 */
  recoveryInspection?: {
    status: 'ready' | 'failed'
    media: {
      width?: number
      height?: number
      frameRate?: number
      durationSeconds?: number
      videoCodec?: string | null
      audioCodec?: string | null
      formatName?: string | null
    }
    sampleFrames: Array<{
      second: number
      storageKey: string
      imageUrl: string
    }>
    characterChecklist: Array<{
      characterId: number
      versionNo: number | null
      name: string
      appearance: string | null
      costume: string | null
      referenceImageUrl: string | null
      isPrimary: boolean
    }>
    blockingIssues: Array<{
      code: string
      message: string
    }>
    warnings: Array<{
      code: string
      message: string
    }>
    /** 平台发布规格状态；不等同于自动技术检查 ready */
    releaseReadiness: RecoveryReleaseReadinessDTO | null
    manualFocus: string[]
  } | null
  /** 来源类型：AI 生成视频 / 口型同步视频 */
  sourceType?: 'generated_video' | 'lip_sync' | 'subtitle_cleaned' | string | null
  /** 状态 */
  status: string
  /** 确认时间 */
  confirmedAt?: string | null
  /** 创建时间 */
  createdAt: string
}

export interface AudioAssetDTO {
  /** 音频资产 ID */
  id: number
  /** 所属项目 ID */
  projectId: number
  /** 音轨类型：对白/旁白/音乐/音效 */
  trackType: 'dialogue' | 'narration' | 'music' | 'sfx' | string
  /** 关联场景 ID */
  sceneId?: number | null
  /** 场景编号（冗余展示） */
  sceneNo?: number | null
  /** 场景标题（冗余展示） */
  sceneTitle?: string | null
  /** 关联分镜 ID */
  storyboardId?: number | null
  /** 镜头编号（冗余展示） */
  shotNo?: string | null
  /** 关联角色 ID */
  characterId?: number | null
  /** 角色名称（冗余展示） */
  characterName?: string | null
  /** 版本号 */
  versionNo: number
  /** 音频标题 */
  title: string
  /** 音频文件 URL */
  audioUrl: string
  /** 时长（秒） */
  durationSeconds?: number | null
  /** 在时间线中的起始偏移（秒） */
  startOffsetSeconds?: number | null
  /** 声线名称 */
  voiceName?: string | null
  /** 使用的 AI 模型 */
  modelName?: string | null
  /** 声线 Profile Key */
  voiceProfileKey?: string | null
  /** 声线指令 */
  voiceInstructions?: string | null
  /** 生成时绑定的角色生产基线版本 */
  characterVersionNo?: number | null
  /** 生成时绑定的角色生产基线快照 */
  characterSnapshot?: Record<string, unknown> | null
  /** 状态 */
  status: string
  /** 确认时间 */
  confirmedAt?: string | null
  /** 创建时间 */
  createdAt: string
}

export interface ExportPackageItemDTO {
  /** 场景 ID */
  sceneId: number
  episodeNo?: number | null
  /** 场景编号 */
  sceneNo: number
  /** 场景标题 */
  sceneTitle?: string | null
  /** 分镜 ID */
  storyboardId: number
  /** 镜头编号 */
  shotNo?: string | null
  /** 景别 */
  shotType?: string | null
  /** 时长（秒） */
  durationSeconds: number
  /** 静帧图片 URL */
  imageUrl?: string | null
  /** 视频 URL */
  videoUrl?: string | null
  /** 导出状态：就绪/仅有静帧/缺失视频 */
  exportStatus: 'ready' | 'static-ready' | 'missing-video'
}

export interface ExportPackageDTO {
  /** 项目 ID */
  projectId: number
  /** 封面图 URL */
  coverUrl?: string | null
  /** 总镜头数 */
  totalShots: number
  /** 就绪镜头数（有视频） */
  readyShots: number
  /** 已确认镜头数 */
  confirmedShots: number
  /** 缺失镜头数 */
  missingShots: number
  /** 缺失分镜的场景数 */
  missingStoryboardScenes: number
  /** 不完整的场景列表 */
  incompleteScenes: Array<{
    sceneId: number
    sceneNo: number
    sceneTitle?: string | null
  }>
  /** 是否可以开始导出 */
  canExport: boolean
  /** 阻塞性问题（阻止导出） */
  blockingIssues: FinalEditValidationIssueDTO[]
  /** 总时长（秒） */
  totalDurationSeconds: number
  /** 导出包明细列表 */
  items: ExportPackageItemDTO[]
}

export interface ExportRecordDTO {
  /** 导出记录 ID */
  id: number
  /** 所属项目 ID */
  projectId: number
  /** 导出状态 */
  status: string
  /** 最终视频 URL */
  videoUrl: string
  /** 同源 Range 播放地址，优先用于工作台播放器 */
  playbackUrl?: string | null
  /** 封面图 URL */
  coverUrl?: string | null
  /** 视频时长（秒） */
  durationSeconds?: number | null
  /** 导出配置快照 */
  config?: {
    episodeNo?: number | null
    /** 输出格式 */
    format?: string
    /** 分辨率 */
    resolution?: string
    /** 帧率 */
    frameRate?: number
    /** 是否烧录字幕 */
    burnSubtitle?: boolean
    /** 10 条终剪回归覆盖标签 */
    regressionTags?: string[]
    /** 10 条终剪回归人工标注信息 */
    finalQualityRegression?: {
      tags?: string[]
      note?: string | null
      updatedAt?: string
      updatedBy?: number
    }
    cinematicEditPlan?: {
      planVersion?: string
      mode?: string
      sourceCandidatePreserved?: boolean
      sourceVideoAssetIds?: number[]
      clips?: Array<{
        storyboardId: number
        sourceVideoAssetId?: number | null
        trimStartSeconds?: number
        trimEndSeconds?: number
        transition?: { type?: string; durationSeconds?: number }
        reason?: string
      }>
    }
    cinematicQualityReport?: {
      passed?: boolean
      status?: string
      summary?: string
      blockers?: Array<{ code?: string; message?: string; severity?: string }>
      warnings?: Array<{ code?: string; message?: string; severity?: string }>
      issueShots?: Array<{ storyboardId?: number; code?: string; message?: string }>
      recommendations?: string[]
      checkedAt?: string
    }
    technicalQuality?: {
      status?: string
      automaticPassed?: boolean
      blockingIssues?: Array<{ code?: string; message?: string }>
    }
  } | null
  /** 源素材镜头数 */
  sourceCount: number
  /** 就绪素材镜头数 */
  readyCount: number
  /** 缺失素材镜头数 */
  missingCount: number
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
}

export interface ProjectAssetSummaryDTO {
  /** 资产总数 */
  totalCount: number
  /** 角色形象数 */
  characterCount: number
  /** 图片资产数 */
  imageCount: number
  /** 视频资产数 */
  videoCount: number
  /** 音频资产数 */
  audioCount: number
  /** 已确认图片数 */
  confirmedImageCount: number
  /** 已确认视频数 */
  confirmedVideoCount: number
  /** 已确认音频数 */
  confirmedAudioCount: number
}

export interface ProjectAssetItemDTO {
  /** 资产 ID */
  id: number
  /** 资产类型 */
  assetType: 'character' | 'image' | 'video' | 'audio'
  /** 所属项目 ID */
  projectId: number
  /** 关联场景 ID */
  sceneId?: number | null
  /** 场景编号 */
  sceneNo?: number | null
  /** 场景标题 */
  sceneTitle?: string | null
  /** 关联分镜 ID */
  storyboardId?: number | null
  /** 关联角色 ID */
  characterId?: number | null
  /** 镜头编号 */
  shotNo?: string | null
  /** 角色名称 */
  characterName?: string | null
  /** 资产名称 */
  name: string
  /** 副标题/描述 */
  subtitle?: string | null
  /** 状态 */
  status: string
  /** 预览 URL */
  previewUrl?: string | null
  /** 视频 URL */
  videoUrl?: string | null
  /** 音频 URL */
  audioUrl?: string | null
  /** 音轨类型 */
  trackType?: string | null
  /** 时长（秒） */
  durationSeconds?: number | null
  /** 声线名称 */
  voiceName?: string | null
  /** 确认时间 */
  confirmedAt?: string | null
  /** 版本号 */
  versionNo?: number | null
  /** 创建时间 */
  createdAt?: string | null
  /** 更新时间 */
  updatedAt?: string | null
}

export type ProjectAssetType = ProjectAssetItemDTO['assetType']

export interface ProjectAssetsDTO {
  /** 项目 ID */
  projectId: number
  /** 资产汇总统计 */
  summary: ProjectAssetSummaryDTO
  /** 资产明细列表 */
  items: ProjectAssetItemDTO[]
}

export interface ProjectTaskSummaryDTO {
  /** 任务总数 */
  totalCount: number
  /** 图片任务数 */
  imageCount: number
  /** 视频任务数 */
  videoCount: number
  /** 音频任务数 */
  audioCount: number
  /** 导出任务数 */
  exportCount: number
  /** 已确认任务数 */
  confirmedCount: number
  /** 候选任务数 */
  candidateCount: number
  /** 已完成任务数 */
  completedCount: number
  /** 排队中任务数 */
  queuedCount: number
  /** 执行中任务数 */
  runningCount: number
  /** 成功任务数 */
  successCount: number
  /** 失败任务数 */
  failedCount: number
  /** 已取消任务数 */
  canceledCount: number
}

export interface ProjectTaskItemDTO {
  /** 任务唯一 Key */
  taskKey: string
  /** 任务类型 */
  taskType: 'image' | 'video' | 'audio' | 'export'
  /** 源对象 ID */
  sourceId: number
  /** 是否为恢复视频竖屏终剪导出 */
  isRecoveryFinalEdit?: boolean
  /** 是否仍允许回滚恢复终剪任务 */
  canRollback?: boolean
  /** 所属项目 ID */
  projectId: number
  /** 关联场景 ID */
  sceneId?: number | null
  /** 场景编号 */
  sceneNo?: number | null
  /** 场景标题 */
  sceneTitle?: string | null
  /** 关联分镜 ID */
  storyboardId?: number | null
  /** 关联角色 ID */
  characterId?: number | null
  /** 镜头编号 */
  shotNo?: string | null
  /** 版本号 */
  versionNo?: number | null
  /** 任务标题 */
  title: string
  /** 副标题/描述 */
  subtitle?: string | null
  /** 任务状态 */
  status: string
  /** 预览 URL */
  previewUrl?: string | null
  /** 文件 URL */
  fileUrl?: string | null
  /** 详细文本描述 */
  detailText?: string | null
  /** 运行时状态 */
  runtimeStatus?: 'queued' | 'running' | 'success' | 'failed' | 'canceled' | null
  /** 进度百分比 */
  progressPercent?: number | null
  /** 运行时消息 */
  runtimeMessage?: string | null
  /** 错误信息 */
  errorText?: string | null
  /** 已执行次数 */
  attemptCount?: number | null
  /** 最大执行次数 */
  maxAttempts?: number | null
  /** 延迟重试的最早执行时间 */
  nextRunAt?: string | null
  /** 最近一次开始执行的时间 */
  lastStartedAt?: string | null
  /** 是否可重试 */
  canRetry?: boolean
  /** 是否可取消 */
  canCancel?: boolean
  /** 确认时间 */
  confirmedAt?: string | null
  /** 创建时间 */
  createdAt?: string | null
  /** 更新时间 */
  updatedAt?: string | null
}

export interface ProjectTasksDTO {
  /** 项目 ID */
  projectId: number
  /** 任务汇总统计 */
  summary: ProjectTaskSummaryDTO
  /** 任务明细列表 */
  items: ProjectTaskItemDTO[]
}

export interface RecoveryReleaseReadinessDTO {
  status: 'needs-technical-check' | 'needs-vertical-final-edit' | 'release-format-ready'
  canPublishDirectly: boolean
  message?: string | null
  blockingIssues: Array<{
    code: string
    message: string
  }>
}

export interface RecoveryVideoReviewQueueItemDTO {
  id: number
  storyboardId: number
  sceneId: number
  sceneNo?: number | null
  sceneTitle?: string | null
  shotNo?: string | null
  versionNo?: number | null
  videoUrl?: string | null
  thumbnailUrl?: string | null
  durationSeconds?: number | null
  modelName?: string | null
  status: string
  reviewDecision: 'approved' | 'rework' | null
  reviewChecklist: {
    visualReviewed: boolean
    characterConsistencyReviewed: boolean
    motionContinuityReviewed: boolean
  }
  reviewStatus: 'pending' | 'rework' | 'approved'
  requiresReview: boolean
  /** 自动技术检查状态，仅用于决定人工复核的处理顺序 */
  inspectionReadiness: 'ready' | 'pending-inspection' | 'blocked'
  /** 技术检查失败时首条阻塞项的内部标识 */
  inspectionBlockingCode?: string | null
  /** 技术检查失败时的首条可读阻塞原因 */
  inspectionBlockingReason?: string | null
  /** 基于技术检查状态生成的人工处理建议，不会自动执行重试或生成 */
  inspectionGuidance?: string | null
  /** 只有技术检查通过后才能开始人工画面、人物与动作复核 */
  canStartManualReview: boolean
  /** 平台发布规格状态；ready 只代表可人工复核，不代表可直发平台 */
  releaseReadiness: RecoveryReleaseReadinessDTO
  /** 是否已满足直发平台的技术规格 */
  canPublishDirectly: boolean
  /** 竖屏终剪计划状态；只做计划分流，不会自动创建导出或模型任务 */
  finalEditReadiness: {
    status:
      | 'needs-technical-check'
      | 'waiting-manual-review'
      | 'blocked-by-rework'
      | 'ready-for-final-edit'
      | 'not-required'
    canStartFinalEdit: boolean
    message: string
  }
  /** 竖屏终剪目标与阻塞原因；仅为受控计划，不会自动执行 */
  finalEditPlan: {
    planId: string
    videoId: number
    storyboardId: number | null
    sceneId: number | null
    sceneNo: number | null
    shotNo: string | null
    durationSeconds: number | null
    status: 'ready' | 'blocked'
    canStart: boolean
    executionMode: 'manual-gate'
    target: {
      templateId: string
      aspectRatio: '9:16'
      width: number
      height: number
      frameRate: number
      videoCodec: string
      audioCodec: string
      container: 'mp4'
      burnSubtitle: boolean
    }
    blockers: Array<{
      code: string
      message: string
    }>
  }
  reworkReasons: Array<{
    scope: 'video' | 'character'
    characterId: number | null
    message: string
  }>
  nextAction: {
    code:
      | 'resolve-technical-blocker'
      | 'regenerate-recovery-candidate'
      | 'start-recovery-final-edit'
      | 'complete-recovery-review'
      | 'inspect-recovery-status'
    label: string
    message: string
  }
  characterReviewSummary: {
    expectedCount: number
    matchedCount: number
    reworkCount: number
    pendingCount: number
  }
  reviewNote?: string | null
  reviewedAt?: string | null
  createdAt?: string | null
}

export interface RecoveryVideoReviewQueueDTO {
  projectId: number
  summary: {
    total: number
    pendingCount: number
    reworkCount: number
    approvedCount: number
    finalEditRequiredCount: number
    publishFormatReadyCount: number
    readyForFinalEditCount: number
    waitingManualReviewBeforeFinalEditCount: number
    finalEditBlockedCount: number
  }
  items: RecoveryVideoReviewQueueItemDTO[]
}

export interface RecoveryFinalEditPlanDTO {
  videoId: number
  finalEditReadiness: RecoveryVideoReviewQueueItemDTO['finalEditReadiness']
  finalEditPlan: RecoveryVideoReviewQueueItemDTO['finalEditPlan']
  canStart: boolean
}

export interface RecoveryFinalEditExecutionDTO {
  export: ExportRecordDTO
  execution: {
    reused: boolean
    canRollback: boolean
    sourceVideoId: number
    rollbackStrategy: 'preserve-source-candidate'
  }
}

export interface RecoveryFinalEditRollbackDTO {
  export: ExportRecordDTO
  rollback: {
    idempotent: boolean
    mediaDeleted: false
    sourceCandidatePreserved?: boolean
  }
}

export interface FinalEditVideoClipDTO {
  /** 时间线片段 ID；同一分镜被切分时用于区分多个草稿片段 */
  clipId?: string | null
  /** 当前采用的视频资产 ID；替换候选时只改草稿，不改原资产状态 */
  id?: number | null
  videoAssetId?: number | null
  originalVideoAssetId?: number | null
  /** 分镜 ID */
  storyboardId: number
  /** 场景 ID */
  sceneId: number
  /** 场景编号 */
  sceneNo: number
  /** 场景标题 */
  sceneTitle?: string | null
  /** 镜头编号 */
  shotNo?: string | null
  /** 景别 */
  shotType?: string | null
  /** 时长（秒） */
  durationSeconds: number
  /** 源素材原始时长（秒） */
  sourceDurationSeconds?: number | null
  /** 源素材裁切入点（秒） */
  trimStartSeconds?: number | null
  /** 源素材裁切出点（秒） */
  trimEndSeconds?: number | null
  /** 来源类型：视频/静态图片 */
  sourceType?: 'video' | 'static' | string
  /** 视频 URL */
  videoUrl?: string | null
  /** 图片 URL（静态帧回退） */
  imageUrl?: string | null
  /** 缩略图 URL */
  thumbnailUrl?: string | null
  /** 版本号 */
  versionNo: number
  /** 确认时间 */
  confirmedAt?: string | null
  /** 原始排序 */
  sortOrder: number
  /** 是否启用（参与最终导出） */
  enabled: boolean
  /** 在时间线中的排列顺序 */
  order: number
  /** 与下一个片段之间的非破坏式转场 */
  transition?: {
    type: 'cut' | 'fade' | 'dip' | 'push' | string
    durationSeconds: number
    manual?: boolean
  } | null
  nonDestructiveEdit?: {
    sourceCandidatePreserved?: boolean
    replacedFromVideoAssetId?: number | null
  }
}

export interface FinalEditOverlayClipDTO {
  /** 画中画片段 ID */
  clipId: string
  /** 引用的分镜 ID；只引用已确认画面，不复制原始素材 */
  storyboardId: number
  /** 在整集时间线上的起点（秒） */
  startSeconds: number
  /** 叠加时长（秒） */
  durationSeconds: number
  /** 源素材裁切入点（秒） */
  trimStartSeconds: number
  /** 是否参与预览 */
  enabled: boolean
  /** 画面锚点 */
  position: 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  /** 相对画布的缩放比例（0.1 - 1） */
  scale: number
  /** 不透明度（0 - 100） */
  opacity: number
  /** 画面来源类型 */
  sourceType?: 'video' | 'static' | string
  /** 场景编号 */
  sceneNo?: number | null
  /** 场景标题 */
  sceneTitle?: string | null
  /** 镜头编号 */
  shotNo?: string | null
  /** 视频 URL */
  videoUrl?: string | null
  /** 图片 URL */
  imageUrl?: string | null
  /** 缩略图 URL */
  thumbnailUrl?: string | null
}

export interface FinalEditAudioClipDTO {
  /** 音频片段 ID */
  id: number
  /** 所属项目 ID */
  projectId: number
  /** 音轨类型 */
  trackType: 'dialogue' | 'narration' | 'music' | 'sfx' | string
  /** 关联场景 ID */
  sceneId?: number | null
  /** 场景编号 */
  sceneNo?: number | null
  /** 场景标题 */
  sceneTitle?: string | null
  /** 关联分镜 ID */
  storyboardId?: number | null
  /** 镜头编号 */
  shotNo?: string | null
  /** 关联角色 ID */
  characterId?: number | null
  /** 版本号 */
  versionNo: number
  /** 音频标题 */
  title: string
  /** 音频 URL */
  audioUrl: string
  /** 时长（秒） */
  durationSeconds?: number | null
  /** 时间线起始偏移（秒） */
  startOffsetSeconds?: number | null
  /** 单条音频是否启用 */
  enabled?: boolean
  /** 单条音频音量（0-100） */
  volume?: number | null
  /** 声线名称 */
  voiceName?: string | null
  /** 模型名称 */
  modelName?: string | null
  /** 授权素材库 ID */
  libraryAssetId?: number | null
  /** 素材来源 */
  sourceName?: string | null
  /** 授权状态 */
  licenseStatus?: string | null
  /** 授权凭证 */
  licenseEvidence?: string | null
  /** 确认时间 */
  confirmedAt?: string | null
  /** 创建时间 */
  createdAt: string
}

export interface FinalQualityReportDTO {
  id: number
  projectId: number
  exportId: number
  automaticPassed: boolean
  automaticReport: {
    status?: string
    inspectedMedia?: {
      width?: number
      height?: number
      videoCodec?: string
      audioCodec?: string
      formatName?: string
    }
    blockingIssues?: FinalEditValidationIssueDTO[]
  }
  reviewDecision?: 'approved' | 'rework' | null
  reviewChecklist: {
    visualReviewed?: boolean
    subtitleReviewed?: boolean
    audioReviewed?: boolean
    characterConsistencyReviewed?: boolean
    characterConsistencyNotApplicable?: boolean
    visualEvidence?: {
      reviewed?: boolean
      notApplicable?: boolean
      note?: string | null
    }
    subtitleEvidence?: {
      reviewed?: boolean
      notApplicable?: boolean
      note?: string | null
    }
    audioEvidence?: {
      reviewed?: boolean
      notApplicable?: boolean
      listeningConfirmed?: boolean
      clarityReviewed?: boolean
      loudnessReviewed?: boolean
      clippingReviewed?: boolean
      syncReviewed?: boolean
      syncNotApplicable?: boolean
      note?: string | null
    }
    characterConsistencyEvidence?: {
      reviewed?: boolean
      notApplicable?: boolean
      note?: string | null
    }
  }
  reviewNote?: string | null
  reviewedBy?: number | null
  reviewedAt?: string | null
  releaseStatus: 'blocked' | 'pending-review' | 'release-candidate'
  createdAt: string
  updatedAt: string
}

export interface CostLedgerEntryDTO {
  id: number
  projectId: number
  entryType: string
  modelName?: string | null
  quantity: number
  unit: string
  unitPrice?: number | null
  currency: string
  estimatedCost?: number | null
  pricingStatus: 'estimated' | 'unpriced' | string
  source: string
  generationJobId?: number | null
  exportId?: number | null
  audioAssetId?: number | null
  evidence?: Record<string, unknown> | null
  note?: string | null
  createdAt: string
  updatedAt: string
}

export interface CostLedgerDTO {
  projectId: number
  summary: {
    entryCount: number
    pricedEntryCount: number
    unpricedEntryCount: number
    totalEstimatedCostByCurrency: Record<string, number>
    byType: Record<
      string,
      {
        entryCount: number
        quantity: number
        pricedEntryCount: number
        unpricedEntryCount: number
        estimatedCostByCurrency: Record<string, number>
      }
    >
  }
  items: CostLedgerEntryDTO[]
  pricingCatalogConfigured: boolean
}

export interface ReleaseCandidateSnapshotDTO {
  snapshotVersion: string
  projectId: number
  exportId: number
  evidenceHash: string
  generatedAt?: string
  platforms: string[]
  technicalSpec: {
    format?: string | null
    resolution?: string | null
    frameRate?: number | null
    videoCodec?: string | null
    audioCodec?: string | null
  }
  subtitle: {
    hasSpeech: boolean
    cueCount: number
    burnedIn: boolean
  }
  humanReviewEvidence: {
    visual?: string | null
    subtitle?: string | null
    audio?: string | null
    audioChecklist?: {
      listeningConfirmed: boolean
      clarityReviewed: boolean
      loudnessReviewed: boolean
      clippingReviewed: boolean
      syncReviewed: boolean
      syncNotApplicable: boolean
    }
  }
  aiDisclosure: {
    isAiGenerated: boolean
    disclosureConfirmed: boolean
    label?: string | null
    platformEvidence?: PlatformComplianceEvidenceDTO[]
  }
}

export interface ReleaseComplianceDTO {
  projectId: number
  exportId: number
  status: 'blocked' | 'release-candidate' | string
  canPublish: boolean
  checks: {
    technical: {
      passed: boolean
      spec: {
        format?: string | null
        resolution?: string | null
        frameRate?: number | null
        videoCodec?: string | null
        audioCodec?: string | null
      }
    }
    subtitle: {
      passed: boolean
      hasSpeech: boolean
      hasValidCues: boolean
      burnedIn: boolean
      cueCount: number
    }
    audioLicensing: {
      passed: boolean
      assets: Array<{
        id?: number | null
        trackType: string
        title: string
        licenseStatus: string
        licenseEvidence: string
        sourceName?: string | null
      }>
    }
    humanReview: {
      passed: boolean
      automaticPassed: boolean
      reviewDecision?: string | null
      checklist: {
        visualReviewed: boolean
        subtitleReviewed: boolean
        audioReviewed: boolean
        visualEvidence?: { reviewed: boolean; note?: string | null }
        subtitleEvidence?: { reviewed: boolean; note?: string | null }
        audioEvidence?: {
          reviewed: boolean
          listeningConfirmed?: boolean
          clarityReviewed?: boolean
          loudnessReviewed?: boolean
          clippingReviewed?: boolean
          syncReviewed?: boolean
          syncNotApplicable?: boolean
          note?: string | null
        }
      }
    }
    platformCompliance?: {
      passed: boolean
      evidence: PlatformComplianceEvidenceDTO[]
      missingPlatforms: string[]
    }
  }
  aiDisclosure: {
    isAiGenerated: boolean
    disclosureConfirmed: boolean
    label?: string | null
    platformEvidence?: PlatformComplianceEvidenceDTO[]
  }
  platforms: string[]
  blockingIssues: Array<{ code: string; message: string; assetId?: number | null }>
  warnings: Array<{ code: string; message: string; platforms?: string[] }>
  audit?: {
    snapshotVersion: string
    evidenceHash: string
  }
  releaseCandidateSnapshot?: ReleaseCandidateSnapshotDTO | null
  export?: ExportRecordDTO
  generatedAt: string
}

export interface FinalQualityRegressionDTO {
  projectId: number
  status: 'insufficient-samples' | 'coverage-incomplete' | 'ready' | string
  ready: boolean
  summary: {
    requiredSampleCount: number
    sampleCount: number
    missingSampleCount: number
    completedCount: number
    failedCount: number
    automaticPassedCount: number
    approvedCount: number
    reworkCount: number
    missingReviewCount: number
    characterConsistencyGapCount: number
    reviewEvidenceGapCount: number
    approvalRate: number
    automaticPassRate: number
    averageTurnaroundSeconds?: number | null
  }
  sampleScope: {
    includedStatuses: string[]
    excludedStatuses: string[]
    excludedCount: number
  }
  cost: {
    pricedEntryCount: number
    unpricedEntryCount: number
    totalEstimatedCostByCurrency: Record<string, number>
    averageEstimatedCostByCurrency: Record<string, number>
  }
  coverage: {
    requiredCount: number
    coveredCount: number
    buckets: Array<{
      key: string
      label: string
      count: number
      covered: boolean
    }>
    missingBuckets: Array<{
      key: string
      label: string
      count: number
      covered: boolean
    }>
  }
  reviewEvidence: {
    totalGapCount: number
    buckets: Array<{
      code: string
      label: string
      message: string
      count: number
      missing: boolean
    }>
  }
  reworkReasons: Array<{
    exportId: number
    code: string
    message: string
  }>
  blockers: Array<{
    code: string
    message: string
    missingSampleCount?: number
  }>
  productionReadiness: {
    status: 'ready' | 'blocked' | string
    ready: boolean
    requiredPassedSampleCount: number
    passedSampleCount: number
    blockers: Array<{
      code: string
      message: string
      count?: number
    }>
  }
  items: Array<{
    exportId: number
    status: string
    technicalPassed: boolean
    reviewDecision?: string | null
    releaseStatus?: string | null
    turnaroundSeconds?: number | null
    estimatedCostByCurrency: Record<string, number>
    qualityGapCodes: string[]
    reviewEvidenceGaps: Array<{
      code: string
      label: string
      message: string
    }>
    coverageTags: string[]
    nextAction: {
      code: string
      label: string
      message: string
    }
  }>
}

export interface ProductionReadinessBlockerDTO {
  code: string
  message: string
  count?: number
  missing?: string[]
  missingBuckets?: string[]
  missingPlatforms?: string[]
  exportIds?: number[]
  [key: string]: unknown
}

export interface ProductionReadinessStageDTO {
  status: 'passed' | 'blocked' | string
  passed: boolean
  summary: Record<string, unknown>
  blockers: ProductionReadinessBlockerDTO[]
}

export interface ProductionReadinessDTO {
  projectId: number
  generatedAt: string
  status: 'blocked' | 'ready-for-controlled-publish' | 'stable-revenue-evidence-ready' | string
  releaseCandidateReady: boolean
  stableRevenueReady: boolean
  stages: {
    finalEditRegression: ProductionReadinessStageDTO
    marketMachineQuality: ProductionReadinessStageDTO
    releaseCompliance: ProductionReadinessStageDTO
    storageOperations: ProductionReadinessStageDTO
    costControl: ProductionReadinessStageDTO
    platformValidation: ProductionReadinessStageDTO
  }
  blockers: ProductionReadinessBlockerDTO[]
  actionQueue: Array<{
    code: string
    label: string
    message: string
  }>
  disclaimer: string
}

export interface PlatformComplianceEvidenceDTO {
  platform: string
  aiLabelReviewed: boolean
  copyrightFieldsReviewed: boolean
  ruleReviewNote?: string | null
}

export interface FinalEditAudioMixTrackDTO {
  /** 此音轨是否启用 */
  enabled: boolean
  /** 音量（0.0 - 1.0） */
  volume: number
}

export interface FinalEditSubtitleCueDTO {
  /** 字幕轨内唯一标识 */
  cueId: string
  /** 绑定的分镜 ID */
  storyboardId: number
  /** 是否烧录到最终字幕文件 */
  enabled: boolean
  /** 相对镜头起始的偏移秒数 */
  startOffsetSeconds: number
  /** 字幕显示时长（秒） */
  durationSeconds: number
  /** 已人工确认的字幕文本 */
  text: string
}

export interface FinalEditDraftDTO {
  /** 视频时间线（分镜启用状态 + 排序） */
  videoClips: Array<{
    clipId?: string | null
    storyboardId: number
    enabled: boolean
    order: number
    videoAssetId?: number | null
    trimStartSeconds?: number | null
    trimEndSeconds?: number | null
    transition?: {
      type: 'cut' | 'fade' | 'dip' | 'push' | string
      durationSeconds: number
      manual?: boolean
    } | null
  }>
  /** 画中画叠加轨（编辑器内可编辑；导出合成尚未接入，草稿保存不会删除原始素材） */
  overlayClips?: Array<{
    clipId: string
    storyboardId: number
    startSeconds: number
    durationSeconds: number
    trimStartSeconds: number
    enabled: boolean
    position: 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
    scale: number
    opacity: number
  }>
  /** 各音轨混音配置 */
  audioMix: {
    dialogue: FinalEditAudioMixTrackDTO
    narration: FinalEditAudioMixTrackDTO
    music: FinalEditAudioMixTrackDTO
    sfx: FinalEditAudioMixTrackDTO
  }
  /** 单条音频片段的非破坏式偏移、启用和音量配置 */
  audioClips?: Array<{
    audioId: number
    enabled: boolean
    startOffsetSeconds: number
    volume: number
  }>
  /** 剪辑节拍标记，用于卡点、信息释放和动作点 */
  beatMarkers?: Array<{
    markerId: string
    atSeconds: number
    label: string
  }>
  /** 情绪强度曲线，用于判断整集递进是否成立 */
  emotionCurve?: Array<{
    pointId: string
    atSeconds: number
    intensity: number
    label: string
  }>
  /** 非破坏式版本快照；用于回退到人工确认过的剪辑状态 */
  versionHistory?: Array<{
    versionId: string
    label: string
    createdAt: string
    payload: Record<string, unknown>
  }>
  /** 可编辑字幕时间线 */
  subtitleCues: FinalEditSubtitleCueDTO[]
  /** 最后更新时间 */
  updatedAt?: string | null
}

export interface FinalEditValidationIssueDTO {
  /** 问题代码 */
  code: string
  /** 问题描述 */
  message: string
}

export interface FinalEditUnmatchedAudioDTO extends FinalEditAudioClipDTO {
  /** 未进入可播放时间线的原因 */
  reason: 'missing-matching-video-clip' | string
}

export interface FinalEditDTO {
  /** 项目 ID */
  projectId: number
  /** 项目名称 */
  projectName: string
  /** 视频轨道 */
  videoTrack: {
    /** 视频片段列表 */
    items: FinalEditVideoClipDTO[]
    /** 总片段数 */
    totalCount: number
    /** 总时长（秒） */
    totalDurationSeconds: number
    /** 启用片段数 */
    enabledCount: number
    /** 启用片段总时长（秒） */
    enabledDurationSeconds: number
  }
  /** 各类型音轨的音频片段 */
  audioTracks: {
    /** 对白轨 */
    dialogue: FinalEditAudioClipDTO[]
    /** 旁白轨 */
    narration: FinalEditAudioClipDTO[]
    /** 音乐轨 */
    music: FinalEditAudioClipDTO[]
    /** 音效轨 */
    sfx: FinalEditAudioClipDTO[]
  }
  /** 已确认但暂时没有对应画面片段的对白/旁白，保留用于后续自动归位 */
  unmatchedAudio: FinalEditUnmatchedAudioDTO[]
  /** 画中画叠加轨（已解析素材信息） */
  overlayClips: FinalEditOverlayClipDTO[]
  /** 各音轨混音配置 */
  audioMix: FinalEditDraftDTO['audioMix']
  /** 草稿数据 */
  draft: FinalEditDraftDTO
  /** 校验结果 */
  validation: {
    /** 是否可以导出 */
    canExport: boolean
    /** 启用的视频片段数 */
    enabledVideoCount: number
    /** 启用视频总时长（秒） */
    enabledVideoDurationSeconds: number
    /** 可用音轨数 */
    availableAudioTrackCount: number
    /** 启用音轨数 */
    enabledAudioTrackCount: number
    /** 总分镜数 */
    totalStoryboardCount: number
    /** 已确认视频数 */
    confirmedVideoCount: number
    /** 缺失视频数 */
    missingVideoCount: number
    /** 缺失分镜的场景数 */
    missingStoryboardSceneCount: number
    /** 尚未找到对应画面片段的对白/旁白数量 */
    unmatchedAudioCount: number
    /** 阻塞性问题列表 */
    blockingIssues: FinalEditValidationIssueDTO[]
    /** 警告性问题列表 */
    warningIssues: FinalEditValidationIssueDTO[]
  }
  /** 汇总信息 */
  summary: {
    /** 已确认视频数 */
    confirmedVideoCount: number
    /** 已确认音频数 */
    confirmedAudioCount: number
    /** 是否有视频素材 */
    hasVideo: boolean
    /** 是否有音频素材 */
    hasAudio: boolean
    /** 总时长（秒） */
    totalDurationSeconds: number
    /** 源素材时长（秒） */
    sourceDurationSeconds: number
    /** 启用音轨数 */
    enabledAudioTrackCount: number
    /** 可用音轨数 */
    availableAudioTrackCount: number
    /** 总分镜数 */
    totalStoryboardCount: number
    /** 缺失视频数 */
    missingVideoCount: number
    /** 缺失分镜的场景数 */
    missingStoryboardSceneCount: number
    /** 尚未找到对应画面片段的对白/旁白数量 */
    unmatchedAudioCount: number
  }
}

export interface ModelSettingGroupDTO {
  /** 分组 Key */
  key: string
  /** 分组显示标签 */
  label: string
}

export interface ModelSettingFieldDTO {
  /** 字段 Key */
  key: string
  /** 所属分组 Key */
  group: string
  /** 字段显示标签 */
  label: string
  /** 字段类型 */
  type: 'text' | 'secret' | 'select' | 'boolean' | 'number'
  /** 当前值（字符串化存储） */
  value: string
  /** 可选项列表（select 类型） */
  options?: string[]
  /** 是否已持久化到数据库 */
  persisted: boolean
  /** 密钥是否已配置 */
  secretConfigured?: boolean
  /** 值来源：数据库/环境变量/其他 */
  source: 'database' | 'environment' | string
}

export interface ModelSettingsDTO {
  /** 设置分组列表 */
  groups: ModelSettingGroupDTO[]
  /** 设置字段列表 */
  fields: ModelSettingFieldDTO[]
  /** 实际生效的模型配置（环境变量 + 数据库合并后的结果） */
  effective: {
    /** 文本生成相关模型 */
    text: {
      provider: string
      defaultModel: string
      outlineModel: string
      scriptModel: string
      storyboardModel: string
      characterModel: string
    }
    /** 帧图片生成相关模型 */
    frame: {
      provider: string
      defaultModel: string
      fallbackModels: string[]
      imageSize: string
      imageRatio: string
    }
    /** 视频生成相关模型 */
    video: {
      provider: string
      defaultModel: string
      size: string
      lipSyncProvider: string
      lipSyncModel: string
    }
    /** 音频生成相关模型 */
    audio: {
      provider: string
      defaultModel: string
      fallbackModel: string
      defaultVoice: string
    }
  }
}

/** 后端统一响应结构 */
interface ApiResponse<T> {
  /** 业务状态码：0 表示成功 */
  code: number
  /** 消息文本 */
  message: string
  /** 业务数据 */
  data: T
}

/**
 * 异步等待指定时间（用于重试间隔）
 * @param {number} ms - 等待毫秒数
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/**
 * 带连接重试的 fetch 封装
 * @param {string} url - 请求 URL
 * @param {RequestInit} [init] - fetch 初始化参数
 * @description 仅对 TypeError（网络不可达）进行重试，其他 HTTP 错误不重试
 *              重试间隔：300ms → 800ms → 1500ms → 2500ms → 4000ms
 */
async function fetchWithConnectRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= API_CONNECT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await fetch(url, {
        ...init,
        signal: init?.signal || AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
      })
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

/**
 * 统一 API 请求封装
 * @param {string} path - 请求路径（相对 API_BASE_URL）
 * @param {RequestInit} [init] - fetch 初始化参数
 * @returns {Promise<T>} 后端返回的 data 字段
 * @description 自动拼接 API_BASE_URL、附加 Authorization Token、
 *              统一解析 { code, message, data } 结构、
 *              处理非 0 code 和网络错误
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 所有项目业务请求都从这里出去：
  // 1. 自动补 API_BASE_URL
  // 2. 自动带 Authorization: Bearer token
  // 3. 统一解析后端的 { code, message, data }
  // 4. 非 0 code 或 HTTP 非 2xx 时抛 Error，页面用 try/catch 展示错误
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
    if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error('服务响应超时，请稍后重试')
    }
    if (error instanceof TypeError) {
      throw new Error('后端连接暂时不可用，请确认服务正在运行')
    }
    throw error
  }

  const payload = (await response.json().catch(() => null)) as
    | ApiResponse<T>
    | { code?: number; message?: string }
    | null
  if (response.status === 401 || payload?.code === 4010) {
    throw new Error('登录状态已过期，请重新登录')
  }
  if (!response.ok || !payload || ('code' in payload && payload.code !== 0)) {
    const message = payload && 'message' in payload && payload.message ? payload.message : '请求失败'
    throw new Error(message)
  }

  return (payload as ApiResponse<T>).data
}

/**
 * 获取当前用户的项目列表
 * @returns {Promise<ProjectDTO[]>} 项目列表
 */
export function listProjects(options?: { includeArchived?: boolean }) {
  const query = options?.includeArchived ? '?includeArchived=true' : ''
  return request<{ items: ProjectDTO[] }>(`/projects${query}`).then((res) => res.items)
}

/**
 * 获取单个项目详情
 * @param {number} id - 项目 ID
 * @returns {Promise<ProjectDTO>} 项目详情
 */
export function getProject(id: number) {
  return request<ProjectDTO>(`/projects/${id}`)
}

/**
 * 创建新项目
 * @param {Object} payload - 项目创建参数
 * @param {string} payload.name - 项目名称
 * @param {string} [payload.category] - 项目分类
 * @param {number} [payload.targetDuration] - 目标时长（秒）
 * @param {string} [payload.narrativeVision] - 叙事愿景
 * @param {string} [payload.visualStyle] - 视觉风格
 * @param {string} [payload.aspectRatio] - 画面比例
 * @returns {Promise<ProjectDTO>} 创建的项目
 */
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

/**
 * 更新项目创作参数。
 * 新建项目只收项目名，作品类型 / 画面规格 / 视觉方向 / 故事愿景都在创作首页填写，
 * 通过这个接口回写到项目上（后端 PATCH /api/projects/:id）。
 */
export function updateProject(
  id: number,
  payload: {
    name?: string
    category?: string
    narrativeVision?: string
    visualStyle?: string
    aspectRatio?: string
  },
) {
  return request<ProjectDTO>(`/projects/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

/** 归档项目：项目从默认工作台列表隐藏，数据仍可恢复。 */
export function archiveProject(id: number) {
  return request<ProjectDTO>(`/projects/${id}/archive`, {
    method: 'POST',
  })
}

/** 恢复已归档项目到默认工作台列表。 */
export function restoreProject(id: number) {
  return request<ProjectDTO>(`/projects/${id}/restore`, {
    method: 'POST',
  })
}

/** 永久删除项目及其关联内容，必须传入完整项目名称确认。 */
export function deleteProject(id: number, confirmName: string) {
  return request<{ id: number }>(`/projects/${id}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmName }),
  })
}

/**
 * 获取项目最新版本的大纲
 * @param {number} projectId - 项目 ID
 * @returns {Promise<OutlineDTO | null>} 大纲详情（不存在时返回 null）
 */
export function getLatestOutline(projectId: number) {
  return request<OutlineDTO | null>(`/projects/${projectId}/outline`)
}

/**
 * 触发 AI 生成项目大纲
 * @param {number} projectId - 项目 ID
 * @returns {Promise<OutlineDTO>} 生成的大纲
 */
export function generateOutline(projectId: number) {
  return request<OutlineDTO>(`/projects/${projectId}/outline/generate`, {
    method: 'POST',
  })
}

export function getStoryBible(projectId: number) {
  return request<StoryBibleDTO | null>(`/projects/${projectId}/story-bible`)
}

export function generateStoryBible(projectId: number, payload: { idea: string; episodeCount: number }) {
  return request<{ item: StoryBibleDTO; report: StoryQualityReportDTO }>(
    `/projects/${projectId}/story-bible/generate`,
    { method: 'POST', body: JSON.stringify(payload) },
  )
}

export function saveStoryBible(projectId: number, payload: Omit<StoryBibleDTO, 'id' | 'projectId' | 'versionNo' | 'status' | 'qualityReport' | 'lockedAt' | 'createdAt' | 'updatedAt'>) {
  return request<{ item: StoryBibleDTO; report: StoryQualityReportDTO }>(
    `/projects/${projectId}/story-bible`,
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    },
  )
}

export function evaluateStoryBible(projectId: number, payload: Partial<StoryBibleDTO>) {
  return request<{ item: StoryBibleDTO; report: StoryQualityReportDTO }>(
    `/projects/${projectId}/story-bible/evaluate`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  )
}

export function lockStoryBible(projectId: number, payload: Partial<StoryBibleDTO>) {
  return request<{ item: StoryBibleDTO; report: StoryQualityReportDTO }>(
    `/projects/${projectId}/story-bible/lock`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  )
}

export function getSeasonStructure(projectId: number) {
  return request<SeasonStructureDTO | null>(`/projects/${projectId}/season-structure`)
}

export function generateSeasonStructure(projectId: number, payload: Partial<SeasonStructureDTO>) {
  return request<{ item: SeasonStructureDTO; report: StoryQualityReportDTO }>(
    `/projects/${projectId}/season-structure/generate`,
    { method: 'POST', body: JSON.stringify(payload) },
  )
}

export function saveSeasonStructure(projectId: number, payload: Omit<SeasonStructureDTO, 'id' | 'projectId' | 'versionNo' | 'status' | 'storyBibleId' | 'qualityReport' | 'lockedAt' | 'createdAt' | 'updatedAt'>) {
  return request<{ item: SeasonStructureDTO; report: StoryQualityReportDTO }>(
    `/projects/${projectId}/season-structure`,
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    },
  )
}

export function evaluateSeasonStructure(projectId: number, payload: Partial<SeasonStructureDTO>) {
  return request<{ item: SeasonStructureDTO; report: StoryQualityReportDTO }>(
    `/projects/${projectId}/season-structure/evaluate`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  )
}

export function lockSeasonStructure(projectId: number, payload: Partial<SeasonStructureDTO>) {
  return request<{ item: SeasonStructureDTO; report: StoryQualityReportDTO }>(
    `/projects/${projectId}/season-structure/lock`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  )
}

/**
 * 获取项目的场景列表
 * @param {number} projectId - 项目 ID
 * @returns {Promise<SceneDTO[]>} 场景列表
 */
export function listScenes(projectId: number) {
  return request<{ items: SceneDTO[] }>(`/projects/${projectId}/scenes`).then((res) => res.items)
}

/**
 * 触发 AI 根据大纲生成场景列表
 * @param {number} projectId - 项目 ID
 * @returns {Promise<SceneDTO[]>} 生成的场景列表
 */
export function generateScenes(projectId: number, options: { confirmRegenerate?: boolean } = {}) {
  return request<{ items: SceneDTO[] }>(`/projects/${projectId}/scenes/generate`, {
    method: 'POST',
    headers: options.confirmRegenerate ? { 'X-Confirm-Regenerate': 'true' } : undefined,
  }).then((res) => res.items)
}

/**
 * 获取单个场景详情
 * @param {number} sceneId - 场景 ID
 * @returns {Promise<SceneDTO>} 场景详情
 */
export function getScene(sceneId: number) {
  return request<SceneDTO>(`/scenes/${sceneId}`)
}

/**
 * 触发 AI 生成场景剧本
 * @param {number} sceneId - 场景 ID
 * @returns {Promise<SceneDTO>} 更新后的场景（含剧本内容）
 */
export function generateSceneScript(sceneId: number) {
  return request<SceneDTO>(`/scenes/${sceneId}/script/generate`, {
    method: 'POST',
  })
}

/**
 * 手动保存/编辑场景剧本
 * @param {number} sceneId - 场景 ID
 * @param {Object} payload - 剧本参数
 * @param {string} [payload.content] - 剧本正文
 * @param {string} [payload.mood] - 氛围描述
 * @param {string} [payload.title] - 标题
 * @returns {Promise<SceneDTO>} 更新后的场景
 */
export function saveSceneScript(
  sceneId: number,
  payload: { content?: string; mood?: string; title?: string },
) {
  return request<SceneDTO>(`/scenes/${sceneId}/script`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

/**
 * 更新场景元数据（标题/地点/时长等）
 * @param {number} sceneId - 场景 ID
 * @param {Object} payload - 要更新的字段
 * @returns {Promise<SceneDTO>} 更新后的场景
 */
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

/**
 * 获取场景下的分镜列表
 * @param {number} sceneId - 场景 ID
 * @returns {Promise<StoryboardDTO[]>} 分镜列表
 */
export function listStoryboards(sceneId: number) {
  return request<{ items: StoryboardDTO[] }>(`/scenes/${sceneId}/storyboards`).then(
    (res) => res.items,
  )
}

/**
 * 触发 AI 根据场景剧本生成分镜
 * @param {number} sceneId - 场景 ID
 * @returns {Promise<StoryboardDTO[]>} 生成的分镜列表
 */
export function generateStoryboards(sceneId: number) {
  return request<{ items: StoryboardDTO[] }>(`/scenes/${sceneId}/storyboards/generate`, {
    method: 'POST',
  }).then((res) => res.items)
}

/**
 * 获取单个分镜详情
 * @param {number} storyboardId - 分镜 ID
 * @returns {Promise<StoryboardDTO>} 分镜详情
 */
export function getStoryboard(storyboardId: number) {
  return request<StoryboardDTO>(`/storyboards/${storyboardId}`)
}

/**
 * 更新分镜内容（镜头类型、画面提示词等）
 * @param {number} storyboardId - 分镜 ID
 * @param {Object} payload - 要更新的字段
 * @returns {Promise<StoryboardDTO>} 更新后的分镜
 */
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
    videoPrompt: string
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

/**
 * AI 重写分镜的画面提示词（使其更适合图像生成）
 * @param {number} storyboardId - 分镜 ID
 * @returns {Promise<FramePromptRewriteDTO>} 重写结果
 */
export function rewriteStoryboardFramePrompt(storyboardId: number) {
  return request<FramePromptRewriteDTO>(`/storyboards/${storyboardId}/frame-prompt/rewrite`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

/**
 * AI 优化分镜的首尾帧提示词（用于视频生成的起止关键帧）
 * @param {number} storyboardId - 分镜 ID
 * @returns {Promise<Object>} 优化后的首尾帧提示词 + 备注
 */
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

/**
 * 将上一个分镜的尾帧复制为当前分镜的起始帧（保证画面连贯性）
 * @param {number} storyboardId - 当前分镜 ID
 * @returns {Promise<Object>} 复制结果
 */
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

/**
 * 将分镜一分为二（便于在中间插入新镜头）
 * @param {number} storyboardId - 分镜 ID
 * @returns {Promise<Object>} 拆分后的分镜列表
 */
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

/**
 * 只读预览分镜的表演节拍拆分计划。
 * 页面必须先展示该计划，再由用户明确确认后调用 splitStoryboard。
 */
export function getStoryboardPerformancePlan(storyboardId: number) {
  return request<StoryboardPerformancePlanDTO>(
    `/storyboards/${storyboardId}/performance-plan`,
  )
}

/**
 * 按对白拆分分镜（将含多人对白的分镜拆为多个单人分镜）
 * @param {number} storyboardId - 分镜 ID
 * @returns {Promise<Object>} 拆分结果 + 说话人列表
 */
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

/**
 * 批量更新分镜排序
 * @param {Array<{id: number, sortOrder: number}>} orders - 排序映射列表
 * @returns {Promise<{success: boolean}>} 是否成功
 */
export function reorderStoryboards(orders: Array<{ id: number; sortOrder: number }>) {
  return request<{ success: boolean }>('/storyboards/reorder', {
    method: 'POST',
    body: JSON.stringify({ orders }),
  })
}

/**
 * 获取项目的角色列表
 * @param {number} projectId - 项目 ID
 * @returns {Promise<CharacterDTO[]>} 角色列表
 */
export function listCharacters(projectId: number) {
  return request<{ items: CharacterDTO[] }>(`/projects/${projectId}/characters`).then(
    (res) => res.items,
  )
}

/**
 * 触发 AI 根据剧情生成角色列表
 * @param {number} projectId - 项目 ID
 * @returns {Promise<CharacterDTO[]>} 生成的角色列表
 */
export function generateProjectCharacters(projectId: number) {
  return request<{ items: CharacterDTO[] }>(`/projects/${projectId}/characters/generate`, {
    method: 'POST',
  }).then((res) => res.items)
}

/**
 * 获取单个角色详情
 * @param {number} characterId - 角色 ID
 * @returns {Promise<CharacterDTO>} 角色详情
 */
export function getCharacter(characterId: number) {
  return request<CharacterDTO>(`/characters/${characterId}`)
}

/**
 * 创建新角色
 * @param {number} projectId - 项目 ID
 * @param {Object} payload - 角色创建参数
 * @param {string} payload.name - 角色名称
 * @param {string} [payload.roleTag] - 角色标签
 * @param {string} [payload.personality] - 性格描述
 * @param {string} [payload.appearance] - 外貌描述
 * @param {string} [payload.voiceSetting] - 语音设置
 * @param {string} [payload.ageGroup] - 年龄段
 * @param {string} [payload.gender] - 性别
 * @param {string} [payload.voiceStyle] - 语音风格
 * @param {string} [payload.referenceImageUrl] - 参考图 URL
 * @returns {Promise<CharacterDTO>} 创建的角色
 */
export function createCharacter(
  projectId: number,
  payload: {
    name: string
    roleTag?: string | null
    personality?: string | null
    appearance?: string | null
    costume?: string | null
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

/**
 * 更新角色信息
 * @param {number} characterId - 角色 ID
 * @param {Object} payload - 要更新的字段
 * @param {boolean} [payload.syncNameReferences] - 是否同步更新项目中所有引用此角色名称的地方
 * @returns {Promise<CharacterDTO>} 更新后的角色
 */
export function updateCharacter(
  characterId: number,
  payload: Partial<{
    name: string
    roleTag: string | null
    personality: string | null
    appearance: string | null
    costume: string | null
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

export function getProjectCharacterConsistency(projectId: number) {
  return request<{
    report: CharacterConsistencyReportDTO
    characters: CharacterDTO[]
    versions: CharacterVersionDTO[]
    samples: CharacterRegressionSampleDTO[]
    latestReport?: {
      id: number
      status: string
      report: CharacterConsistencyReportDTO | null
      createdBy?: number | null
      createdAt?: string | null
    } | null
  }>(`/projects/${projectId}/character-consistency`)
}

export function saveProjectCharacterConsistencyReport(projectId: number) {
  return request<{
    report: CharacterConsistencyReportDTO
    latestReport?: {
      id: number
      status: string
      report: CharacterConsistencyReportDTO | null
      createdBy?: number | null
      createdAt?: string | null
    } | null
  }>(`/projects/${projectId}/character-consistency/reports`, {
    method: 'POST',
  })
}

export function listCharacterVersions(characterId: number) {
  return request<{
    items: CharacterVersionDTO[]
    current?: CharacterVersionDTO | null
  }>(`/characters/${characterId}/versions`)
}

export function syncCharacterVersion(characterId: number, changeReason?: string) {
  return request<CharacterVersionDTO>(`/characters/${characterId}/versions`, {
    method: 'POST',
    body: JSON.stringify({ changeReason }),
  })
}

export function listCharacterRegressionSamples(characterId: number) {
  return request<{ items: CharacterRegressionSampleDTO[] }>(
    `/characters/${characterId}/regression-samples`,
  ).then((res) => res.items)
}

export function addCharacterRegressionSample(
  characterId: number,
  payload: {
    sampleType: CharacterRegressionSampleType
    assetUrl: string
    versionNo: number
    sourceId?: number | null
    note?: string | null
  },
) {
  return request<CharacterRegressionSampleDTO>(`/characters/${characterId}/regression-samples`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function setCharacterLock(
  characterId: number,
  group: 'appearance' | 'costume' | 'voice',
  locked: boolean,
) {
  return request<{
    character: CharacterDTO
    readiness: {
      ready: boolean
      blockers: Array<{ code: string; message: string; severity: string }>
      warnings: Array<{ code: string; message: string; severity: string }>
      locks: { appearance: boolean; costume: boolean; voice: boolean }
    }
    currentVersion?: CharacterVersionDTO | null
  }>(`/characters/${characterId}/locks`, {
    method: 'PUT',
    body: JSON.stringify({ group, locked }),
  })
}

/**
 * 删除角色（归档处理）
 * @param {number} characterId - 角色 ID
 * @returns {Promise<{ success: boolean }>} 删除结果
 */
export function deleteCharacter(characterId: number) {
  return request<{ success: boolean }>(`/characters/${characterId}`, {
    method: 'DELETE',
  })
}

/**
 * 预览角色重命名的影响范围
 * @param {number} characterId - 角色 ID
 * @param {string} name - 新名称
 * @returns {Promise<CharacterRenameImpactDTO>} 影响详情
 */
export function previewCharacterRename(characterId: number, name: string) {
  return request<CharacterRenameImpactDTO>(`/characters/${characterId}/rename-preview`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

/**
 * AI 自动生成角色档案（外貌/性格/声线等）
 * @param {number} characterId - 角色 ID
 * @returns {Promise<CharacterDTO>} 更新后的角色
 */
export function generateCharacterProfile(characterId: number) {
  return request<CharacterDTO>(`/characters/${characterId}/generate-profile`, {
    method: 'POST',
  })
}

/**
 * 获取角色的形象生成历史
 * @param {number} characterId - 角色 ID
 * @returns {Promise<CharacterImageDTO[]>} 形象列表
 */
export function listCharacterImages(characterId: number) {
  return request<{ items: CharacterImageDTO[] }>(`/characters/${characterId}/images`).then(
    (res) => res.items,
  )
}

/**
 * 触发 AI 生成角色形象
 * @param {number} characterId - 角色 ID
 * @param {Object} [payload] - 生成参数
 * @param {string} [payload.prompt] - 自定义提示词
 * @param {string} [payload.modelName] - 指定模型
 * @param {number} [payload.candidateCount] - 候选数量
 * @returns {Promise<GenerationJobDTO>} 生成任务
 */
export function generateCharacterImages(
  characterId: number,
  payload?: { prompt?: string; modelName?: string; candidateCount?: number },
) {
  return request<GenerationJobDTO>(`/characters/${characterId}/images/generate`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
}

/**
 * 查询生成任务状态（轮询用）
 * @param {number} jobId - 任务 ID
 * @returns {Promise<GenerationJobDTO>} 任务详情
 */
export function getGenerationJob(jobId: number) {
  return request<GenerationJobDTO>(`/generation-jobs/${jobId}`)
}

/** 为已有视频创建真实的 FFmpeg 字幕清理派生视频。原视频不会被覆盖。 */
export function removeVideoSubtitles(videoId: number) {
  return request<GenerationJobDTO>(`/videos/${videoId}/subtitles/remove`, {
    method: 'POST',
  })
}

/**
 * 确认采用某张角色形象
 * @param {number} imageId - 形象 ID
 * @returns {Promise<CharacterImageDTO>} 确认后的形象
 */
export function confirmCharacterImage(imageId: number) {
  return request<CharacterImageDTO>(`/character-images/${imageId}/confirm`, {
    method: 'POST',
  })
}

/**
 * 预览角色声线（生成一段测试音频）
 * @param {number} characterId - 角色 ID
 * @param {Object} [payload] - 声线参数
 * @param {string} [payload.text] - 要合成的文本
 * @param {string} [payload.voiceName] - 声线名称
 * @param {string} [payload.modelName] - 模型名称
 * @param {string} [payload.voiceProfileKey] - 声线 Profile Key
 * @returns {Promise<CharacterVoicePreviewDTO>} 预览结果（含音频 URL）
 */
export function previewCharacterVoice(
  characterId: number,
  payload?: {
    text?: string
    voiceName?: string
    modelName?: string
    voiceProfileKey?: string
    voiceStyle?: string | null
    voiceAgent?: boolean
    bindReferenceAudio?: boolean
    previewAudioUrl?: string | null
    voiceId?: string | null
    voiceDesign?: CharacterVoicePreviewDTO['voiceDesign'] | null
  },
) {
  return request<CharacterVoicePreviewDTO>(`/characters/${characterId}/voice-preview`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  }).then((result) => ({ ...result, audioUrl: normalizePreviewMediaUrl(result.audioUrl) }))
}

/**
 * 获取系统可用的声线库列表
 * @returns {Promise<Object>} 声线列表 + 年龄段/性别选项
 */
export function listVoiceProfiles() {
  return request<{
    items: VoiceProfileDTO[]
    ageGroups: Array<{ value: string; label: string }>
    genders: Array<{ value: string; label: string }>
  }>('/voice-profiles')
}

/**
 * 获取角色的 AI 声线推荐
 * @param {number} characterId - 角色 ID
 * @returns {Promise<Object>} 角色特征 + 推荐声线列表
 */
export function getCharacterVoiceRecommendations(characterId: number) {
  return request<{
    character: CharacterDTO
    traits: CharacterVoiceTraitsDTO
    selectedProfile?: VoiceProfileDTO | null
    items: VoiceRecommendationDTO[]
  }>(`/characters/${characterId}/voice-recommendations`)
}

/**
 * 为角色绑定/切换声线
 * @param {number} characterId - 角色 ID
 * @param {Object} payload - 绑定参数
 * @param {string} payload.voiceProfileKey - 声线 Profile Key
 * @param {string} [payload.ageGroup] - 年龄段
 * @param {string} [payload.gender] - 性别
 * @param {string} [payload.voiceStyle] - 语音风格
 * @param {boolean} [payload.locked] - 是否锁定
 * @returns {Promise<Object>} 绑定后的角色信息 + 声线
 */
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

export function saveCharacterReferenceAudio(
  characterId: number,
  payload: { fileName: string; mimeType: string; dataBase64: string },
) {
  return request<{ character: CharacterDTO }>(`/characters/${characterId}/reference-audio`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

/**
 * 获取项目中所有角色的声线配置总览
 * @param {number} projectId - 项目 ID
 * @returns {Promise<CharacterVoiceCastDTO[]>} 角色声线配置列表
 */
export function listProjectVoiceCast(projectId: number) {
  return request<{ items: CharacterVoiceCastDTO[] }>(`/projects/${projectId}/voice-cast`).then(
    (res) => res.items,
  )
}

/**
 * 触发 AI 生成分镜静帧图片（后台任务）
 * @param {number} shotId - 分镜 ID
 * @param {Object} [payload] - 生成参数
 * @param {string} [payload.prompt] - 自定义提示词
 * @param {string} [payload.negativePrompt] - 负面提示词
 * @param {string} [payload.modelName] - 指定模型
 * @param {number} [payload.candidateCount] - 候选数量
 * @param {string} [payload.frameRole] - 帧角色：primary/start/end
 * @returns {Promise<GenerationJobDTO>} 生成任务（需轮询进度）
 */
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

/**
 * 获取分镜的所有静帧图片
 * @param {number} shotId - 分镜 ID
 * @returns {Promise<ImageAssetDTO[]>} 图片列表
 */
export function listShotImages(shotId: number) {
  return request<{ items: ImageAssetDTO[] }>(`/shots/${shotId}/images`).then((res) => res.items)
}

/**
 * 确认采用某张图片
 * @param {number} imageId - 图片资产 ID
 * @returns {Promise<ImageAssetDTO>} 确认后的图片
 */
export function confirmImage(imageId: number) {
  return request<ImageAssetDTO>(`/images/${imageId}/confirm`, {
    method: 'POST',
  })
}

/**
 * 触发 AI 生成分镜视频（图生视频，后台任务）
 * @param {number} storyboardId - 分镜 ID
 * @param {Object} [payload] - 生成参数
 * @param {string} [payload.prompt] - 自定义提示词
 * @param {string} [payload.motionMode] - 运动模式
 * @param {number} [payload.durationSeconds] - 目标时长
 * @param {string} [payload.modelName] - 指定模型
 * @param {number} [payload.candidateCount] - 候选数量
 * @returns {Promise<GenerationJobDTO>} 生成任务
 */
export function generateStoryboardVideos(
  storyboardId: number,
  payload?: {
    prompt?: string
    referencedAssets?: Array<{
      key: string
      kind: 'character' | 'scene' | 'prop'
      name: string
      imageUrl?: string | null
      promptText?: string | null
      appearance?: string | null
      costume?: string | null
      voiceProfileKey?: string | null
      voiceLocked?: boolean
      viewKeys?: string[]
      viewSetVersion?: number | null
      versionNo?: number | null
      sceneViewKey?: string | null
    }>
    mentionTools?: Array<{ key?: string; name: string }>
    voiceBindings?: Array<{
      characterId?: number | null
      characterName: string
      voiceProfileKey?: string | null
      voiceLocked?: boolean
      referenceAudioUrl?: string | null
    }>
    motionMode?: string
    durationSeconds?: number
    modelName?: string
    candidateCount?: number
    autoConfirm?: boolean
    allowCandidateAssets?: boolean
    /** 首帧地址；无上一镜尾帧时用于锁定本镜起点。 */
    startImageUrl?: string | null
  },
) {
  return request<GenerationJobDTO>(`/storyboards/${storyboardId}/videos/generate`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
}

/**
 * 触发 AI 生成口型同步视频（将角色对白音频与视频帧对齐）
 * @param {number} storyboardId - 分镜 ID
 * @param {Object} [payload] - 生成参数
 * @param {string} [payload.prompt] - 自定义提示词
 * @param {boolean} [payload.autoConfirm] - 是否自动确认
 * @returns {Promise<GenerationJobDTO>} 生成任务
 */
export function generateStoryboardLipSync(
  storyboardId: number,
  payload?: { prompt?: string; autoConfirm?: boolean },
) {
  return request<GenerationJobDTO>(`/storyboards/${storyboardId}/lip-sync/generate`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
}

/**
 * 获取分镜的所有视频资产
 * @param {number} storyboardId - 分镜 ID
 * @returns {Promise<VideoAssetDTO[]>} 视频列表
 */
export function listStoryboardVideos(storyboardId: number) {
  return request<{ items: VideoAssetDTO[] }>(`/storyboards/${storyboardId}/videos`).then(
    (res) => res.items,
  )
}

/**
 * 确认采用某个视频
 * @param {number} videoId - 视频资产 ID
 * @returns {Promise<VideoAssetDTO>} 确认后的视频
 */
export function confirmVideo(videoId: number) {
  return request<VideoAssetDTO>(`/videos/${videoId}/confirm`, {
    method: 'POST',
  })
}

/**
 * 保存过期恢复视频的人工复核结果
 * @param {number} videoId - 视频资产 ID
 * @param {Object} payload - 复核结论与检查项
 * @returns {Promise<VideoAssetDTO>} 更新后的视频
 */
export function saveRecoveryVideoReview(
  videoId: number,
  payload: {
    decision: 'approved' | 'rework'
    checklist: {
      visualReviewed: boolean
      characterConsistencyReviewed: boolean
      motionContinuityReviewed: boolean
      characterChecks: Array<{
        characterId: number
        decision: 'matched' | 'rework'
        note?: string
      }>
    }
    note?: string
    confirm?: boolean
    confirmationToken?: string
  },
) {
  return request<VideoAssetDTO>(`/videos/${videoId}/recovery-review`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

/**
 * 触发 AI 生成项目音频（对白/旁白/音乐/音效）
 * @param {number} projectId - 项目 ID
 * @param {Object} [payload] - 生成参数
 * @param {string} [payload.trackType] - 音轨类型：dialogue/narration/music/sfx
 * @param {number | null} [payload.sceneId] - 关联场景 ID
 * @param {number | null} [payload.storyboardId] - 关联分镜 ID
 * @param {number | null} [payload.characterId] - 关联角色 ID
 * @param {string} [payload.title] - 音频标题
 * @param {string} [payload.text] - TTS 文本
 * @param {string} [payload.voiceName] - 声线名称
 * @param {string} [payload.voiceProfileKey] - 声线配置 Key
 * @param {number} [payload.durationSeconds] - 目标时长
 * @param {number} [payload.startOffsetSeconds] - 时间线起始偏移
 * @param {string} [payload.modelName] - 指定模型
 * @param {number} [payload.candidateCount] - 候选数量
 * @returns {Promise<AudioAssetDTO[]>} 生成的音频列表
 */
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

/**
 * 获取项目的全部音频资产列表
 * @param {number} projectId - 项目 ID
 * @returns {Promise<AudioAssetDTO[]>} 音频列表
 */
export function listProjectAudio(projectId: number) {
  return request<{ items: AudioAssetDTO[] }>(`/projects/${projectId}/audio`).then(
    (res) => res.items,
  )
}

/**
 * 确认采用某段音频（标记为最终版）
 * @param {number} audioId - 音频资产 ID
 * @returns {Promise<AudioAssetDTO>} 确认后的音频
 */
export function confirmProjectAudio(audioId: number) {
  return request<AudioAssetDTO>(`/audio-assets/${audioId}/confirm`, {
    method: 'POST',
  })
}

/**
 * 更新音频在时间线中的位置
 * @param {number} audioId - 音频资产 ID
 * @param {Object} payload - 位置参数
 * @param {number | null} [payload.storyboardId] - 关联分镜 ID
 * @param {number} [payload.startOffsetSeconds] - 起始偏移（秒）
 * @returns {Promise<AudioAssetDTO>} 更新后的音频
 */
export function updateProjectAudioPlacement(
  audioId: number,
  payload: { storyboardId?: number | null; startOffsetSeconds?: number },
) {
  return request<AudioAssetDTO>(`/audio-assets/${audioId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

/**
 * 归档音频（从活跃列表移至归档）
 * @param {number} audioId - 音频资产 ID
 * @returns {Promise<AudioAssetDTO>} 归档后的音频
 */
export function archiveAudio(audioId: number) {
  return request<AudioAssetDTO>(`/audio-assets/${audioId}/archive`, {
    method: 'POST',
  })
}

/**
 * 获取项目的导出包预览（含完整性校验）
 * @param {number} projectId - 项目 ID
 * @returns {Promise<ExportPackageDTO>} 导出包信息
 */
export function getProjectExportPackage(projectId: number, episodeNo?: number) {
  const episodeQuery = episodeNo ? `?episodeNo=${encodeURIComponent(String(episodeNo))}` : ''
  return request<ExportPackageDTO>(`/projects/${projectId}/export-package${episodeQuery}`)
}

/**
 * 获取项目的导出历史记录
 * @param {number} projectId - 项目 ID
 * @returns {Promise<ExportRecordDTO[]>} 导出记录列表
 */
export function listProjectExports(projectId: number) {
  return request<{ items: ExportRecordDTO[] }>(`/projects/${projectId}/exports`).then(
    (res) => res.items,
  )
}

/**
 * 创建导出任务（将成片渲染为最终视频）
 * @param {number} projectId - 项目 ID
 * @param {Object} [payload] - 导出配置
 * @param {string} [payload.format] - 输出格式（如 mp4）
 * @param {string} [payload.resolution] - 分辨率（如 1920x1080）
 * @param {number} [payload.frameRate] - 帧率
 * @param {boolean} [payload.burnSubtitle] - 是否烧录字幕
 * @returns {Promise<ExportRecordDTO>} 导出记录
 */
export function createProjectExport(
  projectId: number,
  payload?: {
    episodeNo?: number
    format?: string
    resolution?: string
    frameRate?: number
    burnSubtitle?: boolean
    hybridVideoPerScene?: number
    strictStoryboardAudio?: boolean
    /** 分集成片保留源视频环境音，避免无旁白时导出静音。 */
    preserveSourceAudio?: boolean
  },
) {
  return request<ExportRecordDTO>(`/projects/${projectId}/exports`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
}

/**
 * 获取单个导出记录详情
 * @param {number} exportId - 导出记录 ID
 * @returns {Promise<ExportRecordDTO>} 导出详情
 */
export function getExport(exportId: number) {
  return request<ExportRecordDTO>(`/exports/${exportId}`)
}

export function listFinalQualityReports(projectId: number) {
  return request<{ items: FinalQualityReportDTO[] }>(
    `/projects/${projectId}/final-quality-reports`,
  ).then((res) => res.items)
}

export function getProjectFinalQualityRegression(projectId: number) {
  return request<FinalQualityRegressionDTO>(
    `/projects/${projectId}/final-quality-regression`,
  )
}

export function saveExportFinalQualityRegressionTags(
  exportId: number,
  payload: {
    tags: string[]
    note?: string | null
    confirm: true
    confirmationToken: 'CONFIRM_FINAL_QUALITY_REGRESSION_TAGS'
  },
) {
  return request<ExportRecordDTO>(`/exports/${exportId}/final-quality-regression-tags`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function createExportQualityReport(exportId: number) {
  return request<FinalQualityReportDTO>(`/exports/${exportId}/quality-report`, {
    method: 'POST',
  })
}

export function reviewFinalQualityReport(
  reportId: number,
  payload: {
    decision: 'approved' | 'rework'
    checklist: {
      visualReviewed: boolean
      subtitleReviewed: boolean
      audioReviewed: boolean
      characterConsistencyReviewed: boolean
      characterConsistencyNotApplicable?: boolean
      visualNote?: string
      subtitleNote?: string
      audioNote?: string
      audioEvidence?: {
        reviewed: boolean
        listeningConfirmed: boolean
        clarityReviewed: boolean
        loudnessReviewed: boolean
        clippingReviewed: boolean
        syncReviewed: boolean
        syncNotApplicable: boolean
        note?: string
      }
      characterConsistencyNote?: string
      characterConsistencyEvidence?: {
        reviewed: boolean
        notApplicable: boolean
        note?: string
      }
    }
    note?: string
    confirm?: boolean
    confirmationToken?: string
  },
) {
  return request<FinalQualityReportDTO>(`/final-quality-reports/${reportId}/review`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

/**
 * 获取项目资产总览（角色/图片/视频/音频汇总）
 * @param {number} projectId - 项目 ID
 * @returns {Promise<ProjectAssetsDTO>} 资产汇总数据
 */
export function getProjectAssets(projectId: number) {
  return request<ProjectAssetsDTO>(`/projects/${projectId}/assets`)
}

/** 归档项目资产；已确认或定稿资产由后端保护，避免误删生产链路。 */
export function archiveProjectAsset(assetType: ProjectAssetType, assetId: number) {
  return request<{ id: number; assetType: ProjectAssetType; status: 'archived' }>(
    `/project-assets/${assetType}/${assetId}/archive`,
    {
      method: 'POST',
    },
  )
}

/**
 * 获取项目的任务中心（所有生成任务状态汇总）
 * @param {number} projectId - 项目 ID
 * @returns {Promise<ProjectTasksDTO>} 任务汇总数据
 */
export function getProjectTasks(projectId: number) {
  return request<ProjectTasksDTO>(`/projects/${projectId}/tasks`)
}

/**
 * 获取项目内由过期链接恢复的视频人工复核清单
 */
export function getRecoveryVideoReviewQueue(projectId: number) {
  return request<RecoveryVideoReviewQueueDTO>(`/projects/${projectId}/recovery-video-reviews`)
}

/**
 * 重新从服务端读取单条恢复视频的竖屏终剪计划。
 */
export function getRecoveryVideoFinalEditPlan(videoId: number) {
  return request<RecoveryFinalEditPlanDTO>(`/videos/${videoId}/recovery-final-edit-plan`)
}

/**
 * 在人工复核通过后，明确确认并创建单条竖屏终剪任务。
 */
export function executeRecoveryVideoFinalEdit(
  videoId: number,
  payload: {
    planId: string
    confirm: true
    confirmationToken: 'START_RECOVERY_FINAL_EDIT'
  },
) {
  return request<RecoveryFinalEditExecutionDTO>(
    `/videos/${videoId}/recovery-final-edit/execute`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  )
}

export interface SingleVideoFinalEditPlanDTO {
  videoId: number
  projectId: number
  storyboardId: number
  sceneId: number
  status: string
  canStart: boolean
  target: {
    pipeline: string
    resolution: string
    frameRate: number
    videoCodec: string
    audioCodec: string
    audioSampleRate: number
    container: string
    burnSubtitle: boolean
  }
  export: ExportRecordDTO | null
  rollback: {
    reversible: boolean
    sourceCandidatePreserved: boolean
  }
}

export function getSingleVideoFinalEditPlan(videoId: number) {
  return request<SingleVideoFinalEditPlanDTO>(
    `/videos/${videoId}/single-video-final-edit-plan`,
  )
}

export function executeSingleVideoFinalEdit(
  videoId: number,
  payload: {
    confirm: true
    confirmationToken: 'START_SINGLE_VIDEO_FINAL_EDIT'
  },
) {
  return request<{
    export: ExportRecordDTO
    execution: {
      reused: boolean
      canRollback: boolean
      sourceVideoId: number
      rollbackStrategy: string
    }
  }>(`/videos/${videoId}/single-video-final-edit/execute`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function rollbackSingleVideoFinalEdit(
  exportId: number,
  payload: {
    confirm: true
    confirmationToken: 'ROLLBACK_SINGLE_VIDEO_FINAL_EDIT'
  },
) {
  return request<{
    export: ExportRecordDTO
    rollback: {
      idempotent: boolean
      mediaDeleted: boolean
      sourceCandidatePreserved?: boolean
    }
  }>(`/exports/${exportId}/single-video-final-edit/rollback`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/**
 * 回滚单条恢复视频竖屏终剪任务；保留媒体对象和原候选，便于审计。
 */
export function rollbackRecoveryVideoFinalEdit(
  exportId: number,
  payload: {
    confirm: true
    confirmationToken: 'ROLLBACK_RECOVERY_FINAL_EDIT'
  },
) {
  return request<RecoveryFinalEditRollbackDTO>(
    `/exports/${exportId}/recovery-final-edit/rollback`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  )
}

/**
 * 获取项目成本台账与估算汇总
 */
export function getProjectCostLedger(projectId: number) {
  return request<CostLedgerDTO>(`/projects/${projectId}/cost-ledger`)
}

/**
 * 获取指定项目最近一次导出的发布合规包
 */
export function getProjectReleaseCompliance(projectId: number, exportId?: number) {
  const query = exportId ? `?exportId=${encodeURIComponent(String(exportId))}` : ''
  return request<ReleaseComplianceDTO>(
    `/projects/${projectId}/release-compliance${query}`,
  )
}

/**
 * 获取项目生产发布准备度总闸门。
 */
export function getProjectProductionReadiness(projectId: number) {
  return request<ProductionReadinessDTO>(`/projects/${projectId}/production-readiness`)
}

/**
 * 保存导出记录的 AI 生成标识和目标平台
 */
export function saveExportReleaseCompliance(
  exportId: number,
  payload: {
    aiDisclosure: {
      isAiGenerated: boolean
      disclosureConfirmed: boolean
      label?: string | null
      platformEvidence?: PlatformComplianceEvidenceDTO[]
    }
    platforms?: string[]
    confirm?: boolean
    confirmationToken?: string
  },
) {
  return request<ReleaseComplianceDTO>(`/exports/${exportId}/release-compliance`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

/**
 * 重试失败的任务
 * @param {string} taskKey - 任务唯一 Key
 * @returns {Promise<ProjectTaskItemDTO>} 重试后的任务
 */
export function retryProjectTask(taskKey: string) {
  return request<ProjectTaskItemDTO>(`/project-tasks/${taskKey}/retry`, {
    method: 'POST',
  })
}

/**
 * 取消正在执行的任务
 * @param {string} taskKey - 任务唯一 Key
 * @returns {Promise<ProjectTaskItemDTO>} 取消后的任务
 */
export function cancelProjectTask(taskKey: string) {
  return request<ProjectTaskItemDTO>(`/project-tasks/${taskKey}/cancel`, {
    method: 'POST',
  })
}

/**
 * 获取项目成片编辑数据（时间线 + 音轨 + 校验）
 * @param {number} projectId - 项目 ID
 * @returns {Promise<FinalEditDTO>} 成片编辑完整数据
 */
export function getProjectFinalEdit(projectId: number, episodeNo?: number) {
  const episodeQuery = episodeNo ? `?episodeNo=${encodeURIComponent(String(episodeNo))}` : ''
  return request<FinalEditDTO>(`/projects/${projectId}/final-edit${episodeQuery}`)
}

/**
 * 保存成片编辑草稿（视频片段排序 + 音频混音配置）
 * @param {number} projectId - 项目 ID
 * @param {Object} payload - 草稿数据
 * @param {FinalEditDraftDTO['videoClips']} payload.videoClips - 视频时间线
 * @param {FinalEditDraftDTO['audioMix']} payload.audioMix - 音频混音配置
 * @returns {Promise<FinalEditDTO>} 更新后的成片编辑数据
 */
export function updateProjectFinalEditDraft(
  projectId: number,
  payload: Pick<
    FinalEditDraftDTO,
    'videoClips' | 'audioMix' | 'audioClips' | 'subtitleCues' | 'beatMarkers' | 'emotionCurve' | 'versionHistory'
  >,
  episodeNo?: number,
) {
  const episodeQuery = episodeNo ? `?episodeNo=${encodeURIComponent(String(episodeNo))}` : ''
  return request<FinalEditDTO>(`/projects/${projectId}/final-edit-draft${episodeQuery}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

/**
 * 获取系统 AI 模型设置（各 Provider 配置 + 实际生效值）
 * @returns {Promise<ModelSettingsDTO>} 模型配置完整数据
 */
export function getModelSettings() {
  return request<ModelSettingsDTO>('/model-settings')
}

/**
 * 批量更新 AI 模型设置
 * @param {Array<{key: string, value: string | number | boolean}>} settings - 要更新的字段键值对列表
 * @returns {Promise<ModelSettingsDTO>} 更新后的完整配置
 */
export function updateModelSettings(
  settings: Array<{ key: string; value: string | number | boolean }>,
) {
  return request<ModelSettingsDTO>('/model-settings', {
    method: 'PUT',
    body: JSON.stringify({ settings }),
  })
}

/** 交付包里的一条镜头素材 */
export interface DeliveryClipDTO {
  index: number
  fileName: string
  archivePath: string
  clipId: string
  storyboardId: number
  sceneNo: number | null
  sceneTitle: string
  shotNo: string
  startSeconds: number
  endSeconds: number
  durationSeconds: number
  trimStartSeconds: number
  trimEndSeconds: number
  sourceDurationSeconds: number
  sourceUrl: string | null
}

/** 交付包里的一条音轨素材 */
export interface DeliveryAudioItemDTO {
  index: number
  audioId: number
  storyboardId: number
  title: string
  startSeconds: number
  endSeconds: number
  durationSeconds: number
  fileName: string
  archivePath: string
  sourceUrl: string | null
}

/** 交付包清单：交给外部 NLE（剪映 / DaVinci）的素材与字幕说明 */
export interface DeliveryPackageDTO {
  projectId: number
  projectName: string
  episodeNo: number
  generatedAt: string
  canvas: { ratio: string; width: number; height: number }
  totalDurationSeconds: number
  clips: DeliveryClipDTO[]
  audioTracks: Array<{ key: string; label: string; prefix: string; items: DeliveryAudioItemDTO[] }>
  subtitles: Array<{
    index: number
    storyboardId: number
    startSeconds: number
    endSeconds: number
    text: string
  }>
  unmatchedAudioCount: number
  overlayClipCount: number
  orphanAudioCount: number
  orphanSubtitleCount: number
  totals: {
    clipCount: number
    totalClipCount: number
    audioCount: number
    subtitleCount: number
  }
  files: { srt: string; csv: string; readme: string }
  srt: string
  csv: string
  readme: string
}

/**
 * 获取交付包清单（不下载素材本体）
 */
export function getProjectDeliveryPackage(projectId: number, episodeNo = 1) {
  return request<DeliveryPackageDTO>(
    `/projects/${projectId}/delivery-package?episodeNo=${encodeURIComponent(String(episodeNo))}`,
  )
}

/**
 * 下载交付包 ZIP。因为接口需要 Bearer Token，不能直接用 <a href>，
 * 这里带着 token 取回二进制再交给浏览器保存。
 */
export async function downloadProjectDeliveryArchive(
  projectId: number,
  episodeNo = 1,
  options: { includeMedia?: boolean; limit?: number } = {},
): Promise<{ blob: Blob; fileName: string }> {
  const params = new URLSearchParams({ episodeNo: String(episodeNo) })
  if (options.includeMedia === false) params.set('includeMedia', '0')
  if (options.limit && options.limit > 0) params.set('limit', String(options.limit))

  const token = getAuthToken()
  const response = await fetch(
    `${API_BASE_URL}/projects/${projectId}/delivery-package/archive?${params.toString()}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  )
  if (!response.ok) {
    throw new Error(response.status === 413 ? '交付包超过 512MB，请分批导出' : '交付包下载失败')
  }

  const disposition = response.headers.get('Content-Disposition') || ''
  const utf8Name = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  const fallbackName = disposition.match(/filename="([^"]+)"/i)
  let fileName: string = fallbackName?.[1] || `delivery-${projectId}.zip`
  const decodedName = utf8Name?.[1]
  if (decodedName) {
    try {
      fileName = decodeURIComponent(decodedName)
    } catch {
      // 文件名编码异常时退回 ASCII 名字，不影响下载内容。
    }
  }

  return { blob: await response.blob(), fileName }
}

/** 剪映导出的转场告警：转场需要剪映内置特效 ID，本次按硬切导出。 */
export interface JianyingTransitionWarningDTO {
  storyboardId: number
  type: string
  durationSeconds: number
}

/** 剪映导出的缺失素材记录 */
export interface JianyingMissingMediaDTO {
  kind: string
  url: string | null
  label: string
}

/** 导出到剪映的演练结果：只说明「要导出什么」，不下载素材、不写剪映目录 */
export interface JianyingDraftPlanDTO {
  draftName: string
  canvas: {
    ratio: string
    width: number
    height: number
    /** media=按真实素材量出来的；declared=按项目声明算的；fallback=认不出来兜底 */
    source?: 'media' | 'declared' | 'fallback'
    declaredRatio?: string | null
  }
  canvasSource?: 'media' | 'declared' | 'fallback'
  declaredAspectRatio?: string | null
  canvasProbedFrom?: string | null
  mediaCached?: boolean
  totalDurationSeconds: number
  stats: {
    videoSegments: number
    overlaySegments: number
    audioSegments: number
    textSegments: number
    unsupportedTransitions: JianyingTransitionWarningDTO[]
  }
  mediaRequests: Array<{ kind: string; label: string; fileName: string }>
  mediaRequestCount: number
  videoClipCount: number
  stillFrameClipCount: number
  unmatchedAudioCount: number
}

/** 正式导出的结果 */
export interface JianyingExportResultDTO {
  draftName: string
  folderName?: string
  installed: boolean
  canvas: { ratio: string; width: number; height: number }
  totalDurationSeconds: number
  stats: {
    videoSegments: number
    overlaySegments: number
    audioSegments: number
    textSegments: number
    videoMaterials: number
    imageMaterials: number
    missingMedia: JianyingMissingMediaDTO[]
    unsupportedTransitions: JianyingTransitionWarningDTO[]
  }
  mediaCacheDir: string
  media: {
    total: number
    materialized: number
    reused: number
    failed: Array<{ kind: string; label: string; reason: string }>
  }
  draftDir: string | null
  indexEntryCount: number | null
  createdBackup: boolean
  replacedExisting: boolean
  videoClipCount: number
  stillFrameClipCount: number
  unmatchedAudioCount: number
  jianyingRunning: boolean | null
}

/** 剪映草稿库环境状态 */
export interface JianyingStatusDTO {
  draftRoot: string
  rootReady: boolean
  jianyingRunning: boolean | null
  drafts: Array<{
    folder: string
    name: string
    projectId: number | null
    episodeNo: number | null
    installedAt: string | null
  }>
}

/** 演练：算出这份成片导出到剪映会长什么样（不下载素材、不写剪映目录） */
export function getProjectJianyingPlan(projectId: number, episodeNo = 1) {
  return request<JianyingDraftPlanDTO>(
    `/projects/${projectId}/jianying-draft?episodeNo=${encodeURIComponent(String(episodeNo))}`,
  )
}

/**
 * 正式导出。install=false 只把素材落到本机缓存，install=true 才写进剪映草稿库。
 * 剪映运行中安装会被它退出时覆盖，后端会直接 409 拒绝。
 */
export function exportProjectJianyingDraft(
  projectId: number,
  options: { episodeNo?: number; install?: boolean } = {},
) {
  return request<JianyingExportResultDTO>(`/projects/${projectId}/jianying-draft`, {
    method: 'POST',
    body: JSON.stringify({
      episodeNo: options.episodeNo ?? 1,
      install: options.install === true,
    }),
  })
}

/** 剪映草稿库是否就绪 + 剪映是否正在运行 + 我们已导出的草稿 */
export function getProjectJianyingStatus(projectId: number) {
  return request<JianyingStatusDTO>(`/projects/${projectId}/jianying-draft/status`)
}

/** 卸载帧心帧意导出的草稿（只删带标记的那一条，并还原索引） */
export function uninstallProjectJianyingDraft(projectId: number, folder: string) {
  return request<{ removed: boolean; restoredIndex: boolean; draftDir: string }>(
    `/projects/${projectId}/jianying-draft?folder=${encodeURIComponent(folder)}`,
    { method: 'DELETE' },
  )
}

/* ------------------------------------------------------------------
 * 资产画布
 *
 * 画布节点是「形象变体」层，和角色身份层（角色库 / 定妆图）分开：
 * 同一个角色可以并存多个时空形象，它们互不降级、也不会推高角色版本。
 * ------------------------------------------------------------------ */

/** 画布节点分类：角色 / 场景 / 道具 / 素材 */
export type AssetNodeType = 'character' | 'scene' | 'prop' | 'material'

/**
 * 节点状态由真实图片派生，不是数据库里的标记：
 * draft 表示还没有任何图（界面上叫「待补充」），ready 表示有候选待挑，confirmed 表示已采用。
 */
export type AssetNodeState = 'draft' | 'ready' | 'confirmed'

/** 画布节点的一张形象候选图 */
export interface AssetNodeImageDTO {
  /** 形象图 ID */
  id: number
  /** 所属画布节点 ID */
  assetNodeId: number
  /** 出图批次号 */
  versionNo: number
  /** 图片地址 */
  imageUrl: string
  /** 缩略图地址 */
  thumbnailUrl?: string | null
  /** 生成时的提示词快照 */
  promptSnapshot: string
  /** 使用的模型名 */
  modelName?: string | null
  /** candidate 候选 / confirmed 已采用 */
  status: 'candidate' | 'confirmed' | string
  /** 采用时间 */
  confirmedAt?: string | null
  /** 生成时间 */
  createdAt?: string | null
  viewSetType?: 'character-asset-pack' | 'single' | 'character-turnaround' | 'character-face-closeup' | 'scene-nine-grid' | 'prop-turnaround' | string
  viewSetVersion?: number
  viewIndex?: number | null
  viewKey?: string | null
  viewLabel?: string | null
  /** 九宫格/衍生图所依赖的确认母图 ID */
  sourceImageId?: number | null
  /** 九宫格/衍生图所依赖的母图地址 */
  sourceImageUrl?: string | null
  visionStatus?: 'pending' | 'passed' | 'failed' | string
  visionReason?: string | null
  visionCheckedAt?: string | null
  characterIdentityLock?: Record<string, unknown> | null
  identityStatus?: 'not_checked' | 'pending' | 'passed' | 'failed' | string
  identityReason?: string | null
  identitySimilarityScore?: number | null
  wardrobeConsistencyScore?: number | null
}

export interface AssetViewValidationDTO {
  viewSetType: string
  ready: boolean
  blockers: string[]
  missing: string[]
  unconfirmed?: AssetNodeImageDTO[]
}

/** 画布上的一个节点 */
export interface AssetNodeDTO {
  /** 节点 ID */
  id: number
  /** 所属项目 ID */
  projectId: number
  /** 节点分类 */
  nodeType: AssetNodeType
  /** 关联的角色 ID（仅角色节点有值） */
  refId: number | null
  /** 节点名称 */
  label: string
  /** 时空标签，例如「5 岁的小光」「十八年前的老陈」 */
  appearanceLabel: string | null
  /** 提示词 */
  promptText: string
  /** 场景专用空场环境提示词 */
  environmentPromptText?: string
  /** 仅用于基于基础图生成角色三视图的独立提示词 */
  turnaroundPromptText?: string
  /** 负面提示词 */
  negativePrompt: string
  /** 画布坐标 X */
  x: number
  /** 画布坐标 Y */
  y: number
  /** 节点宽度 */
  width: number
  /** 节点高度 */
  height: number
  /** 分组标识，同一角色的多个时空形象共用一个分组 */
  groupKey: string | null
  characterIdentityLock?: Record<string, unknown> | null
  /** 生命周期：active / archived */
  lifecycleStatus: string
  /** 派生状态 */
  state: AssetNodeState
  /** 全部候选图 */
  images: AssetNodeImageDTO[]
  /** 当前采用的图 */
  confirmedImage: AssetNodeImageDTO | null
  viewItems?: Array<{
    viewSetType: string
    viewSetVersion: number
    viewIndex: number | null
    viewKey: string
    viewLabel: string
    status: string
  }>
  viewSetValidation?: AssetViewValidationDTO[]
}

/** 资产组：角色、场景、道具或素材的稳定容器 */
export interface AssetGroupDTO {
  /** 稳定分组键 */
  key: string
  /** 组内节点类型 */
  nodeType: AssetNodeType
  /** 类型中文名 */
  typeLabel: string
  /** 组名，例如「唐宁」「合规办公室」 */
  label: string
  /** 组内节点 ID */
  nodeIds: number[]
  /** 组内节点数量，单节点组也会返回 */
  nodeCount: number
  /** 组内真实节点状态统计 */
  stateCounts: {
    draft: number
    ready: number
    confirmed: number
  }
  /** 组框边界 */
  bounds: {
    x: number
    y: number
    width: number
    height: number
  }
}

/** 整张画布：分组 + 节点 + 分类计数 */
export interface AssetCanvasDTO {
  /** 项目 ID */
  projectId: number
  /** 稳定资产组，包含单节点组 */
  groups: AssetGroupDTO[]
  /** 全部节点 */
  nodes: AssetNodeDTO[]
  relations: Array<{
    id: string
    fromNodeId: number
    toNodeId: number
    kind: string
    label: string
    storyboardIds: number[]
  }>
  /** 分类与进度计数 */
  summary: {
    /** 节点总数 */
    total: number
    /** 各分类数量 */
    byType: Record<AssetNodeType, number>
    /** 待补充数量（还没有任何图） */
    pendingCount: number
    /** 有候选待挑的数量 */
    readyCount: number
    /** 已采用的数量 */
    confirmedCount: number
  }
}

export interface CreativeWorkflowGatesDTO {
  script: { complete: boolean; sceneCount: number; incompleteCount: number }
  assets: {
    allowed: boolean
    code: string
    reason: string
    requiredCount: number
    missingCount: number
    pendingCount: number
  }
  storyboard: {
    allowed: boolean
    code: string
    reason: string
    requiredCount: number
    missingCount: number
    pendingCount: number
  }
}

export function getCreativeWorkflowGates(projectId: number) {
  return request<CreativeWorkflowGatesDTO>(`/projects/${projectId}/workflow-readiness`)
}

export function confirmProjectScriptParsed(projectId: number) {
  return request<CreativeWorkflowGatesDTO>(`/projects/${projectId}/workflow-readiness/parse-complete`, {
    method: 'POST',
  })
}

/** 读取整张资产画布 */
export function getAssetCanvas(projectId: number) {
  return request<AssetCanvasDTO>(`/projects/${projectId}/asset-canvas`)
}

/** 在画布上新建节点 */
export function createAssetNode(
  projectId: number,
  payload: {
    /** 节点分类 */
    nodeType: AssetNodeType
    /** 关联角色（角色节点用） */
    refId?: number | null
    /** 节点名称；角色节点不填时后端会用角色真名 */
    label?: string
    /** 时空标签 */
    appearanceLabel?: string | null
    /** 画布坐标 */
    x?: number
    /** 画布坐标 */
    y?: number
    /** 分组标识 */
    groupKey?: string | null
    /** 创建时可选的详细提示词；省略时由剧本 Agent 自动整理 */
    promptText?: string | null
    /** 创建角色节点时可选的三视图专用提示词；省略时由资产 Agent 自动整理 */
    turnaroundPromptText?: string | null
    /** 创建时可选的负面提示词 */
    negativePrompt?: string | null
  },
) {
  return request<AssetNodeDTO>(`/projects/${projectId}/asset-nodes`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/** 更新节点：名称、时空标签、提示词、坐标尺寸、分组 */
export function updateAssetNode(
  nodeId: number,
  payload: {
    /** 节点名称 */
    label?: string
    /** 时空标签 */
    appearanceLabel?: string | null
    /** 提示词 */
    promptText?: string
    /** 仅用于角色三视图，独立于剧情提示词 */
    turnaroundPromptText?: string
    /** 负面提示词 */
    negativePrompt?: string
    /** 画布坐标 */
    x?: number
    /** 画布坐标 */
    y?: number
    /** 节点宽度 */
    width?: number
    /** 节点高度 */
    height?: number
    /** 分组标识 */
    groupKey?: string | null
  },
) {
  return request<AssetNodeDTO>(`/asset-nodes/${nodeId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

/** 为旧的空场景节点按关联剧本补齐并保存详细场景提示词 */
export function hydrateAssetNodePrompt(nodeId: number) {
  return request<AssetNodeDTO>(`/asset-nodes/${nodeId}/hydrate-prompt`, {
    method: 'POST',
  })
}

/** 从画布移除节点（归档，已生成的形象图仍保留为证据） */
export function deleteAssetNode(nodeId: number) {
  return request<{ success: boolean }>(`/asset-nodes/${nodeId}`, { method: 'DELETE' })
}

/** 读取某个节点的全部形象候选 */
export function listAssetNodeImages(nodeId: number) {
  return request<{ items: AssetNodeImageDTO[] }>(`/asset-nodes/${nodeId}/images`).then(
    (res) => res.items,
  )
}

/**
 * 触发节点形象生成。
 * 角色节点可以只靠身份约束生成；场景和道具节点必须先写提示词，否则后端返回 400。
 */
export function generateAssetNodeImages(
  nodeId: number,
  payload?: {
    /** 覆盖节点提示词 */
    prompt?: string
    /** 指定模型 */
    modelName?: string
    /** 角色请求一张完整资产板；全身、脸部特写和三视图作为同源母板保存 */
    assetPackEnabled?: boolean
      /** 候选数量：角色为 1，场景多角度组图为 9 */
    candidateCount?: number
    viewType?: 'single' | 'character-asset-pack' | 'scene-nine-grid'
    viewKey?: string
    referenceImageUrl?: string | null
    /** 场景九宫格明确使用的全景母图 ID，避免后端回退到旧 confirmed 图 */
    referenceImageId?: number | null
  },
) {
  return request<GenerationJobDTO>(`/asset-nodes/${nodeId}/images/generate`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
}

/**
 * 采用某张形象。
 * 只替换同一节点、同一视角的旧版本；其它时空组和其它视角保持不变。
 * 画布要的正是「十八年前的老陈」和「现在的陈叔」同时成立。
 */
export function confirmAssetNodeImage(imageId: number) {
  return request<AssetNodeImageDTO>(`/asset-node-images/${imageId}/confirm`, {
    method: 'POST',
  })
}

/** Retry the visual inspection for a generated asset that is still pending. */
export function inspectAssetNodeImage(imageId: number) {
  return request<AssetNodeImageDTO>(`/asset-node-images/${imageId}/vision-check`, {
    method: 'POST',
  })
}
