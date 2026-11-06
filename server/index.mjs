/*登录、注册、短信验证码
项目、总纲、场景、剧本、分镜 CRUD
调 AI 生成文本、图、视频、音频
管理生成任务状态
提供本地生成媒体文件访问
调 FFmpeg 做成片导出*/

import { createHash, randomInt, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { URL } from 'node:url'
import mysql from 'mysql2/promise'
import tencentcloud from 'tencentcloud-sdk-nodejs-sms'

import { generateOutline as aiGenerateOutline } from './services/ai/outline.mjs'
import { getAiConfig } from './services/ai/config.mjs'
import { generateStructuredJson } from './services/ai/provider.mjs'
import { buildPromptTemplateContext } from './services/ai/prompt-template-skill.mjs'
import { inspectAssetImage, locateCharacterHeadBounds } from './services/ai/vision.mjs'
import { rewriteFrameVisualPrompt } from './services/ai/frame-prompt.mjs'
import { generateSceneScript as aiGenerateSceneScript } from './services/ai/script.mjs'
import { generateStoryboards as aiGenerateStoryboards } from './services/ai/storyboard.mjs'
import {
  buildVoicePerformanceInstructions,
  buildVoicePreviewText,
  generateVoiceDesign as aiGenerateVoiceDesign,
  normalizeVoiceDesign,
  resolvePersistedCustomVoiceDesign,
} from './services/ai/voice.mjs'
import { extractSceneSpecsFromScriptScenes } from './services/ai/scene-extraction.mjs'
import {
  extractScenesWithAgent,
  extractSceneSpaceAnchorsWithAgent,
} from './services/ai/scene-extraction-agent.mjs'
import {
  resolveSceneSpaceManifest,
} from './services/scene-space-manifest.mjs'
import {
  generateCharacters as aiGenerateCharacters,
  generateCharacterProfile as aiGenerateCharacterProfile,
} from './services/ai/characters.mjs'
import { normalizeCharacterCostume } from './services/ai/character-costume.mjs'
import {
  generateCharacterImageCandidates,
  generateFrameCandidates,
  assertFrameReferenceImageSupport,
  buildAssetNodeImageStorageKey,
  buildCharacterImageStorageKey,
  buildGeneratedFrameStorageKey,
  getFrameConfig,
  isMockFrameProvider,
} from './services/frame.mjs'
import {
  assetNodeImageRow,
  buildAssetCanvasView,
  findSceneNodeMatch,
  normalizeAssetNodeLayout,
  normalizeAssetNodeType,
} from './services/asset-canvas.mjs'
import {
  buildAssetNodeGenerationPrompt,
  buildAssetNodePromptSnapshot,
  buildAssetNodeViewPrompt,
  buildCharacterViewNegativePrompt,
  resolveAssetNodeGenerationPrompt,
} from './services/asset-node-prompt.mjs'
import {
  buildScriptCharacterPrompt,
  buildCharacterAssetPackPrompt,
  buildSceneEnvironmentPrompt,
  buildScriptScenePrompt,
  buildTemporalVariantPrompt,
  extractTemporalStates,
  inferSceneLocation,
  inferSceneTimeOfDay,
  isLegacyCharacterPrompt,
} from './services/asset-character-prompt.mjs'
import {
  buildPropAssetGroupKey,
  buildTemporalAssetGroupKey,
  normalizeAssetGroupKey,
  resolveTemporalState,
} from './services/asset-temporal-groups.mjs'
import {
  buildActiveAssetNodeDedupPlan,
  buildAssetParserSyncPlan,
  buildCharacterRecordSyncPlan,
} from './services/asset-parser-sync.mjs'
import { buildSceneDisplayLabel } from './services/scene-label.mjs'
import { normalizeStoryboardDurationSeconds } from './services/storyboard-duration.mjs'
import { validateStoryboardDurationContracts } from './services/storyboard-duration-contract.mjs'
import { buildReferencedAssetPromptContext } from './services/storyboard-asset-references.mjs'
import { normalizePropAssets } from './services/asset-props.mjs'
import { createCaptchaStore } from './services/auth-captcha.mjs'
import { chooseSceneForRelink } from './services/asset-node-relink.mjs'
import {
  getConfirmedCharacterBaseImage,
  getCharacterBaseReferenceImage,
  validateCharacterAssetPackConfirmation,
  validateCharacterTurnaroundConfirmation,
  validateCharacterFaceCloseupConfirmation,
  validateAssetImageConfirmation,
  validateCharacterViewGeneration,
  validatePropTurnaroundConfirmation,
  resolveCharacterReferenceImageUrls,
} from './services/asset-character-workflow.mjs'
import {
  buildCharacterIdentityLockPrompt,
  buildCharacterIdentityLockSnapshot,
  parseCharacterIdentityLock,
  resolveCharacterReferenceSet,
} from './services/character-identity-lock.mjs'
import {
  buildCharacterFaceCropFilter,
  buildCharacterQualityRepairPrompt,
  characterDerivedQualityAttempts,
} from './services/character-face-crop.mjs'
import {
  buildSceneNineGridCropFilter,
  buildSceneNineGridAnglePrompt,
  buildSceneNineGridQualityRepairPrompt,
  buildSceneNineGridViewDescriptors,
  getSceneNineGridAngles,
  sceneNineGridQualityAttempts,
  validateSceneNineGridViewConfirmation,
} from './services/scene-nine-grid.mjs'
import { enforceEmptySceneVision, isSceneVisionCheckEnabled, shouldStopAssetRetry } from './services/scene-vision-policy.mjs'
import {
  buildCharacterAssetPackCropFilter,
  buildCharacterAssetPackDescriptors,
} from './services/character-asset-pack.mjs'
import { probeMediaDimensions } from './services/media-probe.mjs'
import { createObjectStorageFromEnv } from './services/object-storage.mjs'
import { replaceVideoFirstFrame } from './services/video-first-frame.mjs'
import {
  isCharacterAssetPackRow,
  planAssetPackAdoption,
  planSingleAssetAdoption,
} from './services/asset-pack-lifecycle.mjs'
import {
  buildGeneratedVideoStorageKey,
  buildGeneratedVideoEndFrameStorageKey,
  buildExportStorageKey,
  buildLipSyncVideoStorageKey,
  buildSubtitleCleanedVideoStorageKey,
} from './services/media-storage-keys.mjs'
import {
  buildFrameConsistencyPrompt,
  createFrameCharacterSnapshot,
  resolveFrameCharacterContext,
} from './services/frame-character-consistency.mjs'
import {
  generateVideoCandidates,
  getVideoConfig,
  isMockVideoProvider,
  isOfficialAgnesModel,
  isWanVideoProvider,
  assertVideoProviderSnapshot,
  assertVideoModelProvider,
  uploadVideoImageBytes,
  buildVideoContinuityConstraints,
  buildColorContinuityConstraints,
  resolveVideoImageInput,
} from './services/video.mjs'
import {
  extractExactLastFrame,
} from './services/video-last-frame.mjs'
import {
  buildLipSyncPrompt,
  createDashScopeLipSyncTask,
  createLipSyncVideoTask,
  createPrivateAvatarAsset,
  createPrivateAvatarGroup,
  getLipSyncConfig,
  resolveDashScopeLipSyncDuration,
  resolveLipSyncDuration,
  uploadDashScopeLipSyncFile,
  waitForDashScopeLipSyncTask,
  buildLatentSyncPayload,
  createLatentSyncTask,
  waitForLatentSyncTask,
  waitForLipSyncVideoTask,
  waitForPrivateAvatarAsset,
} from './services/lip-sync.mjs'
import {
  buildAudioAssetStorageKey,
  createQwenDesignedVoice,
  generateAudioCandidates,
  getAudioConfig,
  isMockAudioProvider,
} from './services/audio.mjs'
import { extractSpokenDialogue } from './services/audio-dialogue.mjs'
import {
  buildScriptAgentActivityPayload,
  normalizeScriptAgentActivityInput,
} from './services/script-agent.mjs'
import { createAgentRegistry } from './services/agent/registry.mjs'
import { createAgentExecutor } from './services/agent/executor.mjs'
import { drainQueuedAgentPipelines, recoverInterruptedAgentPipelines } from './services/agent/pipeline-queue.mjs'
import { indexRagDocuments, queryRagDocuments } from './services/rag-client.mjs'
import { buildProjectKnowledgeChunks, buildRagDocuments } from './services/project-knowledge.mjs'
import { buildStoryboardAssetCatalog } from './services/storyboard-asset-catalog.mjs'
import { resolveStoryboardStageResult } from './services/agent/storyboard-stage-result.mjs'
import { normalizeMysqlDateTime } from './services/agent/mysql-datetime.mjs'
import {
  inspectGeneratedVideoResult,
  inspectVideoConfirmationEligibility,
  inspectStoryboardAssetReferenceGate,
  inspectStoryboardGenerationContext,
} from './services/agent/quality-gate.mjs'
import {
  AGENT_PIPELINE_STAGES,
  SCRIPTING_PIPELINE_STAGE_KEYS,
  getAgentPipelineStage,
  getNextAgentPipelineStageForKeys,
} from './services/agent/pipeline-stages.mjs'
import {
  buildStoryboardReferenceSnapshot,
  validateStoryboardReferenceSnapshot,
} from './services/storyboard-asset-references.mjs'
import {
  buildMentionContextPrompt,
  normalizeStoryboardMentionContext,
} from './services/storyboard-mention-context.mjs'
import {
  bindStoryboardShotAssets,
  buildStoryboardMentionedPrompt,
} from './services/storyboard-asset-binding.mjs'
import { assetNodeRowId } from './services/storyboard-asset-row.mjs'
import {
  requiresCharacterFaceReference,
} from './services/character-face-policy.mjs'
import {
  buildStoryboardPerformancePrompt,
  normalizeStoryboardPerformance,
} from './services/storyboard-performance.mjs'
import { validateStoryboardDirectionContract } from './services/storyboard-direction-contract.mjs'
import {
  buildStoryboardVideoPromptParts,
  buildStoryboardDirectionPrompt,
  buildVideoReferenceImageGuide,
} from './services/video-generation-request.mjs'
import {
  buildVideoCandidateInspection,
  inferVideoCandidateExpectations,
  inspectVideoCandidateFile,
} from './services/video-candidate-inspection.mjs'
import { sanitizeStoryboardPrompt } from './services/storyboard-prompt-sanitizer.mjs'
import {
  buildAudioSourceTitle,
  isMalformedAudioTitle,
  resolveAudioSourceTitle,
} from './services/audio-title.mjs'
import { buildMediaCompleteness } from './services/export-validation.mjs'
import { selectExportClips } from './services/episode-export-selection.mjs'
import {
  normalizeEpisodeExportRequest,
  resolveEpisodeExportPolicy,
} from './services/episode-export-policy.mjs'
import {
  applyFinalEditDraftToAudioTracks,
  applyFinalEditDraftToVideoItems,
  normalizeFinalEditDraft as normalizeFinalEditDraftPayload,
  saveFinalEditDraftForEpisode,
  selectFinalEditDraftForEpisode,
} from './services/final-edit-draft.mjs'
import {
  buildCinematicEditPlan,
  buildCinematicAudioFilter,
  buildCinematicVideoFilter,
  validateCinematicEditPlan,
} from './services/cinematic-edit-plan.mjs'
import {
  evaluateCinematicQuality,
  resolveCinematicAudioRenderIssues,
  resolveCinematicInspectionIssues,
} from './services/cinematic-quality-gate.mjs'
import { resolveCinematicExportStatus } from './services/cinematic-export-state.mjs'
import {
  evaluateSeasonStructure,
  evaluateStoryBible,
  normalizeSeasonStructureInput,
  normalizeStoryBibleInput,
} from './services/story-quality.mjs'
import { normalizeProjectUpdateInput } from './services/project-settings.mjs'
import { normalizeGeneratedMediaUrl } from './services/media-public-url.mjs'
import { resolveVideoConfirmationSource } from './services/media-url.mjs'
import { resolveAppRuntimeRole } from './services/runtime-role.mjs'
import { startExportQueueSweep } from './services/export-queue.mjs'
import { createScriptFingerprint, evaluateCreativeWorkflowGates } from './services/workflow-gates.mjs'
import {
  buildStoryboardContinuityPrompt,
  buildStoryboardFrameReference,
  resolveContinuitySourceShotNo,
  shouldUseStoryboardContinuity,
} from './services/storyboard-continuity.mjs'
import { buildSubtitleCleanupFfmpegArgs, buildSubtitleCleanupFilter } from './services/subtitle-cleanup.mjs'
import {
  canArchiveProjectAsset,
  normalizeProjectAssetType,
} from './services/project-assets.mjs'
import { generateStoryBible } from './services/ai/story-bible.mjs'
import { generateSeasonStructure } from './services/ai/season-structure.mjs'
import {
  buildEpisodeBlueprint,
  buildProductionRunSeed,
  evaluateEpisodeBlueprint,
  normalizeProductionRunInput,
  PRODUCTION_RUN_STAGES,
} from './services/production-run.mjs'
import { buildProductionStageCompletionTransition } from './services/production-stage-transition.mjs'
import { buildProductionScriptSource } from './services/production-script-source.mjs'
import {
  buildAtempoFilter,
  buildLegacySceneAudioOffsets,
  buildMediaTimeline,
  hasStoryboardTimelineEntry,
  resolveMediaStartSeconds,
  resolveRequiredSpeechDuration,
} from './services/media-timeline.mjs'
import {
  extractRelatedSpeakerNames,
  transformCharacterNames,
  transformCharacterNamesJson,
} from './services/character-rename.mjs'
import {
  CHARACTER_AGE_GROUPS,
  CHARACTER_GENDERS,
  VOICE_PROFILE_SEEDS,
  inferCharacterVoiceTraits,
  getDialogueSpeakerNames,
  normalizeCharacterAgeGroup,
  normalizeCharacterGender,
  recommendVoiceProfiles,
  resolveCharacterVoiceProfile,
  isCharacterVoiceReady,
  voiceProfileRow,
} from './services/voice-profiles.mjs'

const require = createRequire(import.meta.url)
const Dypnsapi20170525 = require('@alicloud/dypnsapi20170525')
const OpenApi = require('@alicloud/openapi-client')
const { SendSmsVerifyCodeRequest } = require('@alicloud/dypnsapi20170525')

// 后端主文件承担三类职责：
// 1. 启动并初始化 MySQL 数据库
// 2. 接收 HTTP 请求并执行项目业务
// 3. 把耗时的图片、视频、口型同步、导出任务交给后台任务函数处理
//
// 这里使用 Node 原生 http，而不是 Express，所以路由会在文件底部通过 pathname + method 手动分发。
const PORT = Number(process.env.PORT || 3001)
// 生产部署时浏览器不能访问容器里的 127.0.0.1，所以媒体公开地址要允许从环境变量覆盖。
// 例如腾讯云上设置 PUBLIC_BASE_URL=http://<YOUR_SERVER_IP> 后，导出视频会返回公网可访问的地址。
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '')
const CODE_TTL_SECONDS = 5 * 60
const DEFAULT_ALIYUN_SIGN_NAME = '恒创联众'
const LEGACY_ALIYUN_SIGN_NAME_ALIASES = new Set(['鎭掑垱鑱斾紬', '\u93ad\u6391\u57b1\u9471\u65be\u7d2c'])

const DB_HOST = process.env.DB_HOST || '127.0.0.1'
const DB_PORT = Number(process.env.DB_PORT || 3306)
const DB_USER = process.env.DB_USER || 'root'
const DB_PASSWORD = process.env.DB_PASSWORD || ''
const DB_NAME = process.env.DB_NAME || 'projectdream'
const appRuntimeRole = resolveAppRuntimeRole()
const DEMO_PHONE = '13912345678'
const DEMO_NICKNAME = '测试用户'
const DEMO_PASSWORD = '123456'
const GENERATED_FRAME_DIR = path.join(process.cwd(), '.codex-runtime', 'generated-frames')
const GENERATED_AUDIO_DIR = path.join(process.cwd(), '.codex-runtime', 'generated-audio')
const GENERATED_VIDEO_DIR = path.join(process.cwd(), '.codex-runtime', 'generated-videos')
const GENERATED_EXPORT_DIR = path.join(process.cwd(), '.codex-runtime', 'exports')
const FFMPEG_BIN = String(process.env.FFMPEG_BIN || 'ffmpeg').trim() || 'ffmpeg'
const FFPROBE_BIN = String(process.env.FFPROBE_BIN || 'ffprobe').trim() || 'ffprobe'
const objectStorage = createObjectStorageFromEnv()
const captchaSigningSecret = process.env.CAPTCHA_SECRET || process.env.SESSION_SECRET
if (!captchaSigningSecret && appRuntimeRole.requiresCaptchaSecret) {
  throw new Error('CAPTCHA_SECRET must be configured in production')
}
const captchaStore = createCaptchaStore({
  secret: captchaSigningSecret || 'projectdream-captcha-development-secret',
})

const MODEL_SETTING_GROUPS = [
  { key: 'text', label: '文本模型' },
  { key: 'frame', label: '图片模型' },
  { key: 'video', label: '视频模型' },
  { key: 'audio', label: '音频模型' },
]

const MODEL_SETTING_FIELDS = [
  { key: 'AI_PROVIDER', group: 'text', label: '文本服务商', type: 'select', options: ['openai-compatible', 'mock'] },
  { key: 'AI_BASE_URL', group: 'text', label: '文本接口地址', type: 'text' },
  { key: 'AI_API_KEY', group: 'text', label: '文本接口密钥', type: 'secret' },
  { key: 'AI_MODEL', group: 'text', label: '文本默认模型', type: 'text' },
  { key: 'AI_MODEL_OUTLINE', group: 'text', label: '总纲模型', type: 'text' },
  { key: 'AI_MODEL_SCRIPT', group: 'text', label: '剧本模型', type: 'text' },
  { key: 'AI_MODEL_STORYBOARD', group: 'text', label: '分镜模型', type: 'text' },
  { key: 'AI_MODEL_CHARACTER', group: 'text', label: '角色模型', type: 'text' },
  { key: 'AI_TIMEOUT_MS', group: 'text', label: '文本超时毫秒', type: 'number' },
  { key: 'AI_LONG_TASK_TIMEOUT_MS', group: 'text', label: '长文本任务超时毫秒', type: 'number' },
  { key: 'AI_FALLBACK_TO_MOCK', group: 'text', label: '文本失败回退 mock', type: 'boolean' },

  { key: 'FRAME_PROVIDER', group: 'frame', label: '图片服务商', type: 'select', options: ['volcengine', 'bigmodel', 'zhipu', 'toapi', 'agnes', 'trae-url', 'mock'] },
  { key: 'FRAME_BASE_URL', group: 'frame', label: '图片接口地址', type: 'text' },
  { key: 'FRAME_API_KEY', group: 'frame', label: '图片接口密钥', type: 'secret' },
  { key: 'ARK_API_KEY', group: 'frame', label: '火山方舟 / 豆包图片密钥', type: 'secret' },
  { key: 'VOLCENGINE_API_KEY', group: 'frame', label: '火山方舟兼容密钥', type: 'secret' },
  { key: 'BIGMODEL_API_KEY', group: 'frame', label: '智谱接口密钥', type: 'secret' },
  { key: 'FRAME_MODEL', group: 'frame', label: '静帧默认模型', type: 'text' },
  { key: 'FRAME_FALLBACK_MODELS', group: 'frame', label: '静帧备用模型链', type: 'text' },
  { key: 'FRAME_ASSET_PACK_MODEL', group: 'frame', label: '角色资产包模型', type: 'text' },
  { key: 'FRAME_CHARACTER_ASSET_PACK_ENABLED', group: 'frame', label: '启用角色资产包', type: 'boolean' },
  { key: 'FRAME_IMAGE_SIZE', group: 'frame', label: '静帧尺寸', type: 'text' },
  { key: 'FRAME_IMAGE_RATIO', group: 'frame', label: '静帧比例', type: 'select', options: ['16:9', '9:16', '1:1'] },
  { key: 'FRAME_FALLBACK_TO_MOCK', group: 'frame', label: '图片失败回退 mock', type: 'boolean' },

  { key: 'VIDEO_PROVIDER', group: 'video', label: '视频服务商', type: 'select', options: ['bigmodel', 'zhipu', 'agnes', 'minimax', 'wan', 'mock'] },
  { key: 'VIDEO_BASE_URL', group: 'video', label: '视频接口地址', type: 'text' },
  { key: 'VIDEO_API_KEY', group: 'video', label: '视频接口密钥', type: 'secret' },
  { key: 'VIDEO_MODEL', group: 'video', label: '图生视频模型', type: 'text' },
  { key: 'VIDEO_SIZE', group: 'video', label: '视频尺寸', type: 'text' },
  { key: 'VIDEO_WATERMARK_ENABLED', group: 'video', label: '供应商水印', type: 'boolean' },
  { key: 'VIDEO_FALLBACK_TO_MOCK', group: 'video', label: '视频失败回退 mock', type: 'boolean' },
  { key: 'VIDEO_CREATE_RATE_LIMIT_MAX_REQUESTS', group: 'video', label: '视频创建限流次数', type: 'number' },
  { key: 'VIDEO_CREATE_RATE_LIMIT_WINDOW_MS', group: 'video', label: '视频创建限流窗口毫秒', type: 'number' },
  { key: 'VIDEO_IMAGE_UPLOAD_BASE_URL', group: 'video', label: '源图上传接口地址', type: 'text' },
  { key: 'VIDEO_IMAGE_UPLOAD_API_KEY', group: 'video', label: '源图上传接口密钥', type: 'secret' },
  { key: 'LIP_SYNC_PROVIDER', group: 'video', label: '口型服务商', type: 'select', options: ['dashscope', 'toapi', 'seedance', 'latentsync', 'mock'] },
  { key: 'LIP_SYNC_BASE_URL', group: 'video', label: '口型接口地址', type: 'text' },
  { key: 'LIP_SYNC_MODEL', group: 'video', label: '口型模型', type: 'text' },
  { key: 'LIP_SYNC_API_KEY', group: 'video', label: '口型接口密钥', type: 'secret' },

  { key: 'AUDIO_PROVIDER', group: 'audio', label: '音频服务商', type: 'select', options: ['dashscope', 'mock'] },
  { key: 'AUDIO_BASE_URL', group: 'audio', label: '音频接口地址', type: 'text' },
  { key: 'DASHSCOPE_API_KEY', group: 'audio', label: 'DashScope 接口密钥', type: 'secret' },
  { key: 'AUDIO_MODEL', group: 'audio', label: 'TTS 主模型', type: 'text' },
  { key: 'AUDIO_FALLBACK_MODEL', group: 'audio', label: 'TTS 备用模型', type: 'text' },
  { key: 'AUDIO_VOICE', group: 'audio', label: '默认音色', type: 'text' },
  { key: 'AUDIO_LANGUAGE_TYPE', group: 'audio', label: '默认语言', type: 'text' },
  { key: 'AUDIO_FALLBACK_TO_MOCK', group: 'audio', label: '音频失败回退 mock', type: 'boolean' },
]

const MODEL_SETTING_FIELD_MAP = new Map(MODEL_SETTING_FIELDS.map((field) => [field.key, field]))

const smsRuntime = createSmsRuntime()
const db = await createDatabasePool()
await applyPersistedModelSettings(db)
const activeGenerationJobs = new Map()
const activeExportJobs = new Map()
const activeLipSyncProfileRequests = new Map()

// 下面这些工具函数主要负责“边界适配”：
// 外部模型返回的内容可能是字符串、JSON、远程 URL 或本地生成文件，
// 后端先把它们统一成项目内部可处理的格式。
function safeJsonParse(value, fallback = null) {
  if (value && typeof value === 'object') return value
  try {
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}

function runExternalCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      ...options,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      const detail = String(stderr || stdout || `exit code ${code}`).trim().slice(-1600)
      reject(new Error(`${command} failed (${code}): ${detail}`))
    })
  })
}

async function fileExists(filePath) {
  try {
    const info = await stat(filePath)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

function localGeneratedPathFromUrl(value) {
  let parsed
  try {
    parsed = new URL(String(value || '').trim())
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  let configuredPublicHost = ''
  try {
    configuredPublicHost = new URL(PUBLIC_BASE_URL).hostname.toLowerCase()
  } catch {
    configuredPublicHost = ''
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && host !== configuredPublicHost) {
    return null
  }
  const pathname = decodeURIComponent(parsed.pathname)
  if (pathname.startsWith('/storage/') && objectStorage.provider === 'local') {
    const key = pathname.slice('/storage/'.length)
    try {
      return objectStorage.resolveLocalPath(key)
    } catch {
      return null
    }
  }
  if (pathname.startsWith('/generated/frame/')) {
    return path.join(GENERATED_FRAME_DIR, path.basename(pathname))
  }
  if (pathname.startsWith('/generated/audio/')) {
    return path.join(GENERATED_AUDIO_DIR, path.basename(pathname))
  }
  if (pathname.startsWith('/generated/video/')) {
    return path.join(GENERATED_VIDEO_DIR, path.basename(pathname))
  }
  if (pathname.startsWith('/generated/export/')) {
    return path.join(GENERATED_EXPORT_DIR, path.basename(pathname))
  }
  return null
}

async function downloadMediaToFile(sourceUrl, targetPath, timeoutMs = 120000) {
  if (await fileExists(targetPath)) return targetPath

  const localPath = localGeneratedPathFromUrl(sourceUrl)
  if (localPath && (await fileExists(localPath))) {
    await mkdir(path.dirname(targetPath), { recursive: true })
    const bytes = await readFile(localPath)
    await writeFile(targetPath, bytes)
    return targetPath
  }

  const value = String(sourceUrl || '').trim()
  if (!value) throw new Error('missing media URL')
  let response
  try {
    response = await fetch(value, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new Error(`media download failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  if (!response.ok) throw new Error(`media download failed with HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.length) throw new Error('media download returned an empty file')
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(targetPath, bytes)
  return targetPath
}

function mediaFileExtension(value, fallback) {
  try {
    const extension = path.extname(new URL(String(value || '')).pathname).toLowerCase()
    if (/^\.[a-z0-9]{2,5}$/.test(extension)) return extension
  } catch {
    // Fall through to the known-safe extension.
  }
  return fallback
}

function audioMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.mp3') return 'audio/mpeg'
  if (extension === '.m4a' || extension === '.mp4') return 'audio/mp4'
  if (extension === '.ogg' || extension === '.opus') return 'audio/ogg'
  if (extension === '.flac') return 'audio/flac'
  return 'audio/wav'
}

async function buildLipSyncAudioDataUrl(audioId, sourceUrl) {
  const extension = mediaFileExtension(sourceUrl, '.wav')
  const sourcePath = path.join(GENERATED_VIDEO_DIR, 'sources', `audio-${audioId}${extension}`)
  await downloadMediaToFile(sourceUrl, sourcePath)
  const bytes = await readFile(sourcePath)
  if (!bytes.length) throw new Error('Lip-sync audio source is empty')
  return `data:${audioMimeType(sourcePath)};base64,${bytes.toString('base64')}`
}

async function prepareDashScopeLipSyncMedia(request) {
  const baseName = `storyboard-${request.storyboardId}-v${request.versionNo}-videoretalk`
  const sourceDir = path.join(GENERATED_VIDEO_DIR, 'sources')
  const imageExtension = mediaFileExtension(request.imageUrl, '.png')
  const videoExtension = mediaFileExtension(request.sourceVideoUrl, '.mp4')
  const audioExtension = mediaFileExtension(request.audioUrl, '.wav')
  const imagePath = path.join(sourceDir, `${baseName}-image${imageExtension}`)
  const sourceVideoPath = path.join(sourceDir, `${baseName}-source-video${videoExtension}`)
  const sourceAudioPath = path.join(sourceDir, `${baseName}-source-audio${audioExtension}`)
  const cleanAudioPath = path.join(sourceDir, `${baseName}-dialogue.wav`)
  const baseVideoPath = path.join(sourceDir, `${baseName}-base.mp4`)
  const durationSeconds = resolveDashScopeLipSyncDuration(
    request.audioDurationSeconds,
    request.generationDurationSeconds,
  )
  const hasSourceVideo = /^https?:\/\//i.test(String(request.sourceVideoUrl || '').trim())

  if (hasSourceVideo) {
    await Promise.all([
      downloadMediaToFile(request.sourceVideoUrl, sourceVideoPath),
      downloadMediaToFile(request.audioUrl, sourceAudioPath),
    ])
  } else {
    await Promise.all([
      downloadMediaToFile(request.imageUrl, imagePath),
      downloadMediaToFile(request.audioUrl, sourceAudioPath),
    ])
  }
  await runExternalCommand(FFMPEG_BIN, [
    '-y',
    '-i', sourceAudioPath,
    '-af', 'highpass=f=70,lowpass=f=12000,apad',
    '-t', String(durationSeconds),
    '-ar', '24000',
    '-ac', '1',
    '-c:a', 'pcm_s16le',
    cleanAudioPath,
  ])
  const cropMatch = String(request.cropFilter || '').trim().match(/^(\d{3,4}):(\d{3,4}):(\d{1,4}):(\d{1,4})$/)
  const cropFilter = cropMatch
    ? `crop=${cropMatch[1]}:${cropMatch[2]}:${cropMatch[3]}:${cropMatch[4]},`
    : ''
  if (hasSourceVideo) {
    await runExternalCommand(FFMPEG_BIN, [
      '-y',
      '-stream_loop', '-1',
      '-i', sourceVideoPath,
      '-t', String(durationSeconds),
      '-vf', `${cropFilter}scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=25,format=yuv420p`,
      '-an',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      baseVideoPath,
    ])
  } else {
    await runExternalCommand(FFMPEG_BIN, [
      '-y',
      '-loop', '1',
      '-i', imagePath,
      '-t', String(durationSeconds),
      '-vf', `${cropFilter}scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
      '-r', '25',
      '-an',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      baseVideoPath,
    ])
  }
  return {
    baseVideoPath,
    cleanAudioPath,
    durationSeconds,
  }
}

async function persistSilentLipSyncVideo({ projectId, storyboardId, versionNo, sourceUrl }) {
  const baseName = `storyboard-${storyboardId}-v${versionNo}-lip-sync`
  const sourcePath = path.join(GENERATED_VIDEO_DIR, 'sources', `${baseName}-provider.mp4`)
  const outputPath = path.join(GENERATED_VIDEO_DIR, `${baseName}.mp4`)
  await mkdir(GENERATED_VIDEO_DIR, { recursive: true })
  if (!(await fileExists(outputPath))) {
    await downloadMediaToFile(sourceUrl, sourcePath, 180000)
    await runExternalCommand(FFMPEG_BIN, [
      '-y', '-i', sourcePath, '-map', '0:v:0', '-an', '-c:v', 'copy', '-movflags', '+faststart', outputPath,
    ])
  }
  const storageKey = buildLipSyncVideoStorageKey({ projectId, storyboardId, versionNo })
  const stored = await objectStorage.putObject({
    key: storageKey,
    bytes: await readFile(outputPath),
    contentType: 'video/mp4',
  })
  return {
    outputPath,
    storageKey: stored.key,
    videoUrl: stored.url,
  }
}

async function ensureAudioAssetStorage(audio) {
  if (!audio?.id || !audio?.project_id) return audio
  const existingKey = String(audio.storage_key || '').trim()
  if (existingKey) {
    const existing = await objectStorage.getObject(existingKey)
    if (existing?.bytes?.length) {
      return { ...audio, audio_url: objectStorage.createSignedUrl({ key: existingKey }) }
    }
  }
  const sourceUrl = String(audio.audio_url || '').trim()
  if (!sourceUrl && !audio.filePath) throw new Error(`音频资产 ${audio.id} 缺少可访问地址`)
  const extension = mediaFileExtension(sourceUrl || audio.filePath, '.wav')
  const sourcePath = audio.filePath
    ? String(audio.filePath)
    : path.join(GENERATED_AUDIO_DIR, 'sources', `audio-asset-${audio.id}${extension}`)
  if (!audio.filePath) await downloadMediaToFile(sourceUrl, sourcePath)
  const storageKey = buildAudioAssetStorageKey({
    projectId: audio.project_id,
    audioAssetId: audio.id,
    extension,
  })
  const stored = await objectStorage.putObject({
    key: storageKey,
    bytes: await readFile(sourcePath),
    contentType: audioMimeType(sourcePath),
  })
  await db.execute(
    'UPDATE audio_assets SET storage_key = ?, audio_url = ? WHERE id = ?',
    [stored.key, stored.url, audio.id],
  )
  return { ...audio, storage_key: stored.key, audio_url: stored.url }
}

async function persistGeneratedVideo({ projectId, storyboardId, versionNo, candidateNo, sourceUrl, expected, frameReferences }) {
  const fileName = `storyboard-${storyboardId}-v${versionNo}-c${candidateNo}.mp4`
  const outputPath = path.join(GENERATED_VIDEO_DIR, fileName)
  await mkdir(GENERATED_VIDEO_DIR, { recursive: true })
  await downloadMediaToFile(sourceUrl, outputPath, 180000)
  let persistedVideoPath = outputPath
  let continuityEvidence = null
  if (frameReferences?.continuityEnabled) {
    const referenceStorageKey = String(frameReferences.startFrameStorageKey || '').trim()
    const referenceUrl = String(frameReferences.startFrameUrl || '').trim()
    if (!referenceStorageKey && !referenceUrl) {
      throw new Error('已启用镜头连续性，但缺少上一镜确认尾帧，拒绝保存视频')
    }
    const referenceFramePath = path.join(
      GENERATED_VIDEO_DIR,
      'sources',
      `storyboard-${storyboardId}-v${versionNo}-c${candidateNo}-start.tiff`,
    )
    await mkdir(path.dirname(referenceFramePath), { recursive: true })
    if (referenceStorageKey) {
      const storedReference = await objectStorage.getObject(referenceStorageKey)
      if (!storedReference?.bytes?.length) {
        throw new Error('上一镜确认尾帧对象不存在或为空，拒绝丢弃连续性参考继续保存')
      }
      await writeFile(referenceFramePath, storedReference.bytes)
    } else {
      await downloadMediaToFile(referenceUrl, referenceFramePath)
    }
    const continuityResult = await replaceVideoFirstFrame({
      videoPath: outputPath,
      referenceFramePath,
      outputPath: `${outputPath}.continuity`,
      ffmpegBin: FFMPEG_BIN,
      ffprobeBin: FFPROBE_BIN,
      run: runExternalCommand,
    })
    persistedVideoPath = continuityResult.outputPath
    continuityEvidence = {
      verified: true,
      frameHash: continuityResult.frameHash,
      width: continuityResult.width,
      height: continuityResult.height,
      sourceStoryboardId: Number(frameReferences.sourceStoryboardId) || null,
      sourceShotNo: String(frameReferences.sourceShotNo || '').trim() || null,
    }
    if (!(await fileExists(persistedVideoPath))) {
      throw new Error('连续性首帧修正未产出视频，拒绝保存生成结果')
    }
  }
  const endFramePath = path.join(
    GENERATED_VIDEO_DIR,
    'sources',
    `storyboard-${storyboardId}-v${versionNo}-c${candidateNo}-end.tiff`,
  )
  await mkdir(path.dirname(endFramePath), { recursive: true })
  await extractExactLastFrame({
    videoPath: persistedVideoPath,
    outputPath: endFramePath,
    ffmpegBin: FFMPEG_BIN,
    ffprobeBin: FFPROBE_BIN,
    run: runExternalCommand,
  })
  if (!(await fileExists(endFramePath))) {
    throw new Error('视频已下载，但尾帧抽取没有产出文件')
  }

  const storageKey = buildGeneratedVideoStorageKey({ projectId, storyboardId, versionNo, candidateNo })
  const stored = await objectStorage.putObject({
    key: storageKey,
    bytes: await readFile(persistedVideoPath),
    contentType: 'video/mp4',
  })
  const endFrameStorageKey = buildGeneratedVideoEndFrameStorageKey({
    projectId,
    storyboardId,
    versionNo,
    candidateNo,
    extension: '.tiff',
  })
  const endFrameStored = await objectStorage.putObject({
    key: endFrameStorageKey,
    bytes: await readFile(endFramePath),
    contentType: 'image/tiff',
  })
  const qualityReport = await inspectVideoCandidateFile({
    filePath: persistedVideoPath,
    expected,
    ffprobeBin: FFPROBE_BIN,
    ffmpegBin: FFMPEG_BIN,
  })
  if (continuityEvidence) qualityReport.continuity = continuityEvidence
  return {
    outputPath: persistedVideoPath,
    storageKey: stored.key,
    videoUrl: stored.url,
    endFrameStorageKey,
    endFrameUrl: endFrameStored.url,
    qualityReport,
  }
}

function exportResolution(value) {
  const match = String(value || '').match(/(\d{3,5})\s*x\s*(\d{3,5})/i)
  const width = Number(match?.[1] || 1920)
  const height = Number(match?.[2] || 1080)
  return {
    width: Number.isFinite(width) && width > 0 ? width : 1920,
    height: Number.isFinite(height) && height > 0 ? height : 1080,
  }
}

function ffmpegPath(value) {
  return String(value || '').replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "\\'")
}

function formatSrtTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000))
  const hours = Math.floor(totalMs / 3600000)
  const minutes = Math.floor((totalMs % 3600000) / 60000)
  const secs = Math.floor((totalMs % 60000) / 1000)
  const millis = totalMs % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`
}

function buildSubtitleText(clips, timeline = buildMediaTimeline(clips)) {
  const rows = []
  for (const clip of clips) {
    const entry = timeline.byStoryboardId.get(Number(clip.storyboardId))
    if (!entry) continue
    const text = extractSpokenDialogue(String(clip.dialogueText || ''))
      .replace(/\s+/g, ' ')
      .trim()
    const duration = Math.max(1, Number(clip.durationSeconds) || 5)
    if (text && !/(?:无对白|无台词|no\s+dialogue)/i.test(text)) {
      rows.push(
        `${rows.length + 1}\n${formatSrtTimestamp(entry.startSeconds)} --> ${formatSrtTimestamp(
          entry.startSeconds + Math.min(duration, entry.durationSeconds),
        )}\n${text}\n`,
      )
    }
  }
  return rows.join('\n')
}

async function probeMediaDurationSeconds(filePath) {
  try {
    const result = await runExternalCommand(FFPROBE_BIN, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath,
    ])
    const duration = Number(String(result.stdout || '').trim())
    return Number.isFinite(duration) && duration > 0 ? duration : 0
  } catch {
    return 0
  }
}

async function renameWithRetry(from, to, attempts = 10) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(error?.code) || attempt === attempts - 1) throw error
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
    }
  }
}

async function hasAudioStream(filePath) {
  try {
    const result = await runExternalCommand(FFPROBE_BIN, [
      '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type',
      '-of', 'default=nw=1:nk=1', filePath,
    ])
    return String(result.stdout || '').trim().toLowerCase() === 'audio'
  } catch {
    return false
  }
}

function boundaryPreservingVideoEncodeArgs(enabled) {
  // Constant-QP intra frames make the same source frame encode identically no
  // matter which clip it belongs to. CRF encoding shifts QP at cuts and breaks
  // the decoded-frame hash even when both sides originate from the same image.
  return enabled
    ? ['-c:v', 'libx264', '-qp', '20', '-g', '1', '-keyint_min', '1', '-sc_threshold', '0', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-color_range', 'tv']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p']
}

async function renderHybridExport({ exportId, projectId, config, clips, audioTracks, editPlan = null }) {
  const exportDir = path.join(GENERATED_EXPORT_DIR, String(exportId))
  const sourceDir = path.join(exportDir, 'sources')
  const clipDir = path.join(exportDir, 'clips')
  await mkdir(sourceDir, { recursive: true })
  await mkdir(clipDir, { recursive: true })

  const resolution = exportResolution(config.resolution)
  const frameRate = Math.max(1, Number(config.frameRate) || 24)
  const preserveClipBoundaries = config.preserveClipBoundaries === true
  const preserveSourceAudio = config.preserveSourceAudio === true
  const renderedClips = []
  const renderedClipItems = []
  const skipped = []
  for (const [index, clip] of clips.entries()) {
    const sourceDuration = Math.max(
      0.25,
      Number(clip.sourceDurationSeconds || clip.durationSeconds) || 5,
    )
    const trimStartSeconds = Math.max(
      0,
      Math.min(Number(clip.trimStartSeconds) || 0, Math.max(0, sourceDuration - 0.25)),
    )
    const requestedTrimEnd = Number(clip.trimEndSeconds)
    const trimEndSeconds = Math.max(
      trimStartSeconds + 0.25,
      Math.min(Number.isFinite(requestedTrimEnd) && requestedTrimEnd > 0 ? requestedTrimEnd : sourceDuration, sourceDuration),
    )
    const duration = Math.max(
      0.25,
      Number(clip.durationSeconds) > 0
        ? Number(clip.durationSeconds)
        : trimEndSeconds - trimStartSeconds,
    )
    const baseName = `clip-${String(index + 1).padStart(3, '0')}`
    const outputPath = path.join(clipDir, `${baseName}.mp4`)
    try {
      if (clip.sourceType === 'video' && clip.videoUrl) {
        const sourcePath = path.join(sourceDir, `${baseName}.mp4`)
        await downloadMediaToFile(clip.videoUrl, sourcePath)
        const sourceHasAudio = preserveSourceAudio ? await hasAudioStream(sourcePath) : false
        const audioInputArgs = preserveSourceAudio && !sourceHasAudio
          ? ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']
          : []
        const audioMapArgs = preserveSourceAudio
          ? sourceHasAudio
            ? ['-map', '0:v:0', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2']
            : ['-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-shortest']
          : ['-an']
        await runExternalCommand(FFMPEG_BIN, [
          '-y', '-i', sourcePath, ...audioInputArgs,
          '-ss', String(trimStartSeconds), '-t', String(duration),
          '-vf', `scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=decrease:in_range=auto:out_range=limited,pad=${resolution.width}:${resolution.height}:(ow-iw)/2:(oh-ih)/2${preserveClipBoundaries ? '' : `,tpad=stop_mode=clone:stop_duration=${duration}`},format=yuv420p`,
          '-r', String(frameRate), ...audioMapArgs, ...boundaryPreservingVideoEncodeArgs(preserveClipBoundaries), outputPath,
        ])
      } else if (clip.imageUrl) {
        const sourcePath = path.join(sourceDir, `${baseName}.png`)
        await downloadMediaToFile(clip.imageUrl, sourcePath)
        await runExternalCommand(FFMPEG_BIN, [
          '-y', '-loop', '1', '-i', sourcePath,
          ...(preserveSourceAudio
            ? ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']
            : []),
          '-t', String(duration),
          ...(preserveSourceAudio
            ? ['-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-shortest']
            : ['-an']),
          '-vf', `scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=decrease:in_range=auto:out_range=limited,pad=${resolution.width}:${resolution.height}:(ow-iw)/2:(oh-ih)/2,zoompan=z='min(zoom+0.0008,1.08)':d=${Math.max(1, Math.round(duration * frameRate))}:s=${resolution.width}x${resolution.height}:fps=${frameRate},format=yuv420p`,
          ...boundaryPreservingVideoEncodeArgs(preserveClipBoundaries), outputPath,
        ])
      } else {
        skipped.push({ storyboardId: clip.storyboardId, reason: 'missing-video-and-image' })
        continue
      }
      renderedClips.push(outputPath)
      renderedClipItems.push({
        ...clip,
        trimStartSeconds: Number(trimStartSeconds.toFixed(3)),
        trimEndSeconds: Number(trimEndSeconds.toFixed(3)),
        durationSeconds: Number(duration.toFixed(3)),
      })
    } catch (error) {
      if (config.episodeNo) throw new Error(`分镜 ${clip.storyboardId} 成片标准化失败：${error instanceof Error ? error.message : 'render failed'}`)
      skipped.push({ storyboardId: clip.storyboardId, reason: error instanceof Error ? error.message : 'render failed' })
    }
  }
  if (!renderedClips.length) throw new Error('no usable video or static frame clips')

  const boundaryEvidence = []
  if (preserveClipBoundaries && renderedClips.length > 1) {
    const boundaryDir = path.join(exportDir, 'boundaries')
    await mkdir(boundaryDir, { recursive: true })
    for (let index = 1; index < renderedClips.length; index += 1) {
      const previousPath = renderedClips[index - 1]
      const currentPath = renderedClips[index]
      const boundaryPath = path.join(
        boundaryDir,
        `boundary-${String(index).padStart(3, '0')}.tiff`,
      )
      await extractExactLastFrame({
        videoPath: previousPath,
        outputPath: boundaryPath,
        ffmpegBin: FFMPEG_BIN,
        ffprobeBin: FFPROBE_BIN,
        run: runExternalCommand,
      })
      const replaced = await replaceVideoFirstFrame({
        videoPath: currentPath,
        referenceFramePath: boundaryPath,
        outputPath: `${currentPath}.boundary.mp4`,
        ffmpegBin: FFMPEG_BIN,
        ffprobeBin: FFPROBE_BIN,
        run: runExternalCommand,
      })
      const beforeBoundaryPath = `${currentPath}.before-boundary.mp4`
      await renameWithRetry(currentPath, beforeBoundaryPath)
      try {
        await renameWithRetry(replaced.outputPath, currentPath)
        await rm(beforeBoundaryPath, { force: true })
      } catch (error) {
        await renameWithRetry(beforeBoundaryPath, currentPath).catch(() => {})
        throw error
      }
      boundaryEvidence.push({
        index,
        previousStoryboardId: Number(renderedClipItems[index - 1]?.storyboardId) || null,
        storyboardId: Number(renderedClipItems[index]?.storyboardId) || null,
        frameHash: replaced.frameHash,
        referencePath: boundaryPath,
      })
    }
  }

  const baseVideoPath = path.join(exportDir, 'video-base.mp4')
  const timelineClips = renderedClipItems.map((item) => ({
    ...item,
    durationSeconds: Math.max(0.25, Number(item.durationSeconds) || 4),
  }))
  const videoGraph = buildCinematicVideoFilter({ clips: timelineClips })
  const baseFilterParts = [videoGraph.filterComplex].filter(Boolean)
  const baseInputs = renderedClips.flatMap((file) => ['-i', file])
  const mapArgs = ['-map', videoGraph.outputLabel]
  if (preserveSourceAudio) {
    const audioGraph = buildCinematicAudioFilter({ clips: timelineClips })
    baseFilterParts.push(audioGraph.filterComplex)
    mapArgs.push('-map', audioGraph.outputLabel, '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2')
  }
  await runExternalCommand(FFMPEG_BIN, [
    '-hide_banner', '-loglevel', 'error', '-y', ...baseInputs,
    '-filter_complex', baseFilterParts.join(';'),
    ...mapArgs,
    ...boundaryPreservingVideoEncodeArgs(preserveClipBoundaries),
    '-movflags', '+faststart', baseVideoPath,
  ])

  const timeline = buildMediaTimeline(renderedClipItems)
  const generateSubtitleSidecar = config.generateSubtitleSidecar !== false
  const subtitleText = generateSubtitleSidecar ? buildSubtitleText(renderedClipItems, timeline) : ''
  const subtitlePath = generateSubtitleSidecar ? path.join(exportDir, 'subtitles.srt') : null
  if (subtitlePath) {
    await writeFile(subtitlePath, subtitleText || '1\n00:00:00,000 --> 00:00:01,000\n\n')
  }
  const probedDuration = config.preserveClipBoundaries
    ? await probeMediaDurationSeconds(baseVideoPath)
    : 0
  const duration = probedDuration > 0 ? probedDuration : videoGraph.durationSeconds || timeline.durationSeconds

  const audioFiles = []
  let skippedLegacyAudioCount = 0
  const allAudioItems = FINAL_EDIT_AUDIO_TRACKS.flatMap((trackKey) =>
    Array.isArray(audioTracks?.[trackKey]) ? audioTracks[trackKey] : [],
  )
  const strictStoryboardAudio = config.strictStoryboardAudio !== false
  const legacyAudioOffsets = strictStoryboardAudio
    ? new Map()
    : buildLegacySceneAudioOffsets(allAudioItems, timeline)
  for (const trackKey of FINAL_EDIT_AUDIO_TRACKS) {
    const track = audioTracks?.[trackKey]
    if (!Array.isArray(track) || !track.length || config.finalEditDraft?.audioMix?.[trackKey]?.enabled === false) continue
    for (const [index, item] of track.entries()) {
      if (!item.audioUrl) continue
      const isSpeechTrack = ['dialogue', 'narration'].includes(trackKey)
      if (strictStoryboardAudio && isSpeechTrack && !Number(item.storyboardId)) {
        skippedLegacyAudioCount += 1
        continue
      }
      if (
        strictStoryboardAudio &&
        isSpeechTrack &&
        !hasStoryboardTimelineEntry(item, timeline)
      ) {
        skipped.push({
          audioId: item.id,
          storyboardId: Number(item.storyboardId),
          reason: 'storyboard-disabled-in-final-edit',
        })
        continue
      }
      try {
        const target = path.join(sourceDir, `audio-${trackKey}-${index + 1}${path.extname(new URL(item.audioUrl).pathname) || '.wav'}`)
        await downloadMediaToFile(item.audioUrl, target)
        const placement =
          legacyAudioOffsets.get(item.id) || resolveMediaStartSeconds(item, timeline)
        audioFiles.push({
          path: target,
          trackKey,
          startSeconds: Math.max(0, Number(placement.startSeconds) || 0),
          clipEndSeconds: Math.max(0, Number(placement.clipEndSeconds) || duration),
          sourceDurationSeconds: Number(item.durationSeconds) || 0,
          volume: Math.max(0, Math.min(1, Number(config.finalEditDraft?.audioMix?.[trackKey]?.volume ?? 100) / 100)),
        })
      } catch (error) {
        skipped.push({ audioId: item.id, reason: error instanceof Error ? error.message : 'audio download failed' })
      }
    }
  }

  const finalPath = path.join(GENERATED_EXPORT_DIR, `export-${exportId}.mp4`)
  const baseHasAudio = preserveSourceAudio ? await hasAudioStream(baseVideoPath) : false
  let sourceAudioPreserved = false
  if (baseHasAudio && audioFiles.length === 0) {
    // Keep the video model's generated ambience instead of a silent bed.
    const subtitleArgs = config.burnSubtitle !== false && subtitleText
      ? ['-vf', `subtitles='${ffmpegPath(subtitlePath)}':force_style='FontName=Microsoft YaHei,FontSize=22,Outline=2,Alignment=2'`]
      : []
    await runExternalCommand(FFMPEG_BIN, [
      '-y', '-i', baseVideoPath,
      ...subtitleArgs,
      '-map', '0:v:0', '-map', '0:a:0',
      '-t', String(duration),
      ...boundaryPreservingVideoEncodeArgs(config.preserveClipBoundaries === true),
      '-af', 'volume=2.5,alimiter=limit=0.95',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', finalPath,
    ])
    sourceAudioPreserved = true
  }
  if (sourceAudioPreserved) {
    return {
      finalPath,
      durationSeconds: duration,
      coverPath: renderedClips[0],
      skipped,
      skippedLegacyAudioCount,
      boundAudioCount: 0,
      subtitlePath,
      boundaryEvidence,
      sourceAudioPreserved: true,
    }
  }

  const inputs = ['-y', '-i', baseVideoPath]
  const filterParts = []
  const audioLabels = []
  audioFiles.forEach((audio, index) => {
    inputs.push('-i', audio.path)
    const label = `a${index}`
    const voiceGain = ['dialogue', 'narration'].includes(audio.trackKey) ? 1.28 : 1
    const availableDuration = Math.max(
      0.25,
      Math.min(duration - audio.startSeconds, audio.clipEndSeconds - audio.startSeconds),
    )
    const tempoFilter = buildAtempoFilter(audio.sourceDurationSeconds, availableDuration)
    const sourceDuration = Number(audio.sourceDurationSeconds) || 0
    const delayMs = Math.max(0, Math.round(Number(audio.startSeconds || 0) * 1000))
    const delayFilter = delayMs > 0 ? `adelay=${delayMs}:all=1` : ''
    const fadeOutStart = Math.max(0.05, sourceDuration > 0 ? sourceDuration - 0.06 : availableDuration - 0.06)
    const audioChain = [
      'afade=t=in:st=0:d=0.04',
      `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.06`,
      delayFilter,
      tempoFilter,
      `volume=${(audio.volume * voiceGain).toFixed(3)}`,
      'aresample=async=1:first_pts=0',
      'apad',
      `atrim=0:${duration}`,
    ]
      .filter(Boolean)
      .join(',')
    filterParts.push(`[${index + 1}:a]${audioChain}[${label}]`)
    audioLabels.push(`[${label}]`)
  })
  if (preserveSourceAudio && baseHasAudio) {
    filterParts.push(`[0:a]volume=0.6,apad,atrim=0:${duration}[src]`)
    audioLabels.push('[src]')
  }
  // A silent bed keeps the output stream valid when no music, SFX or source
  // ambience exists. Do not synthesize a test tone.
  if (!audioLabels.length) {
    const silenceIndex = audioFiles.length + 1
    inputs.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${duration}`)
    filterParts.push(`[${silenceIndex}:a]atrim=0:${duration}[silence]`)
    audioLabels.push('[silence]')
  }
  filterParts.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0,aresample=async=1:first_pts=0,apad,atrim=0:${duration}[mixed]`)
  if (config.burnSubtitle !== false && subtitleText) {
    filterParts.push(`[0:v]subtitles='${ffmpegPath(subtitlePath)}':force_style='FontName=Microsoft YaHei,FontSize=22,Outline=2,Alignment=2'[subbed]`)
  }
  const videoMap = config.burnSubtitle !== false && subtitleText ? '[subbed]' : '0:v'
  try {
    await runExternalCommand(FFMPEG_BIN, [
      ...inputs, '-filter_complex', filterParts.join(';'), '-map', videoMap, '-map', '[mixed]',
      '-t', String(duration), ...boundaryPreservingVideoEncodeArgs(config.preserveClipBoundaries === true), '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', finalPath,
    ])
  } catch (error) {
    if (config.burnSubtitle !== false && subtitleText) {
      await runExternalCommand(FFMPEG_BIN, [
        ...inputs, '-filter_complex', filterParts.filter((part) => !part.startsWith('[0:v]subtitles')).join(';'), '-map', '0:v', '-map', '[mixed]',
        '-t', String(duration), ...boundaryPreservingVideoEncodeArgs(config.preserveClipBoundaries === true), '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', finalPath,
      ])
    } else {
      throw error
    }
  }

  return {
    finalPath,
    durationSeconds: duration,
    coverPath: renderedClips[0],
    skipped,
    skippedLegacyAudioCount,
    boundAudioCount: audioFiles.filter((item) => ['dialogue', 'narration'].includes(item.trackKey) && item.startSeconds >= 0).length,
    subtitlePath,
    boundaryEvidence,
    sourceAudioPreserved: false,
  }
}

function sanitizeProviderError(error) {
  return String(error?.message || error || 'unknown provider error')
    .replace(/sk-[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .slice(0, 1200)
}

function generationJobRow(row) {
  return {
    id: Number(row.id),
    jobKey: row.job_key,
    projectId: Number(row.project_id),
    jobType: row.job_type,
    sourceId: Number(row.source_id),
    status: row.status,
    progressPercent: Number(row.progress_percent || 0),
    result: safeJsonParse(row.result_json, null),
    errorText: row.error_text || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function fetchGenerationJob(jobId) {
  const [rows] = await db.execute(`SELECT * FROM generation_jobs WHERE id = ? LIMIT 1`, [jobId])
  return rows[0] || null
}

async function createGenerationJob({ projectId, jobType, sourceId, request }) {
  // 任务表有 project_id，但执行器只接收 request 快照；把项目归属同时写入快照，
  // 让对象存储键、重试和审计都使用同一个项目上下文。
  const requestSnapshot = { ...(request || {}), projectId: Number(projectId) }
  const requestJson = JSON.stringify(requestSnapshot)
  const requestedViewType = String(request?.viewType || '').trim()
  const requestedViewKey = String(request?.viewKey || '').trim()
  const [activeRows] = await db.execute(
    `SELECT * FROM generation_jobs
     WHERE project_id = ? AND job_type = ? AND source_id = ?
       AND status IN ('queued', 'running')
       AND (? = '' OR JSON_UNQUOTE(JSON_EXTRACT(request_json, '$.viewType')) = ?)
       AND (? = '' OR JSON_UNQUOTE(JSON_EXTRACT(request_json, '$.viewKey')) = ?)
     ORDER BY id DESC LIMIT 1`,
    [projectId, jobType, sourceId, requestedViewType, requestedViewType, requestedViewKey, requestedViewKey],
  )
  if (activeRows[0]) {
    queueGenerationJob(Number(activeRows[0].id))
    return generationJobRow(activeRows[0])
  }

  const jobKey = `${jobType}-${sourceId}-${randomUUID()}`
  const [result] = await db.execute(
    `INSERT INTO generation_jobs
       (job_key, project_id, job_type, source_id, status, progress_percent, request_json)
     VALUES (?, ?, ?, ?, 'queued', 0, ?)`,
    [jobKey, projectId, jobType, sourceId, requestJson],
  )
  const row = await fetchGenerationJob(Number(result.insertId))
  queueGenerationJob(Number(result.insertId))
  return generationJobRow(row)
}

function queueGenerationJob(jobId) {
  if (!jobId || activeGenerationJobs.has(jobId)) return
  const promise = Promise.resolve()
    .then(() => processGenerationJob(jobId))
    .catch((error) => console.error(`[generation-job:${jobId}] unhandled failure`, error))
    .finally(() => activeGenerationJobs.delete(jobId))
  activeGenerationJobs.set(jobId, promise)
}

async function updateGenerationJob(jobId, fields) {
  const sets = []
  const values = []
  for (const [column, value] of Object.entries(fields)) {
    sets.push(`${column} = ?`)
    values.push(value)
  }
  if (!sets.length) return
  await db.execute(
    `UPDATE generation_jobs SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`,
    [...values, jobId],
  )
}

async function processFrameGenerationJob(jobId, request) {
  const frameConfig = getFrameConfig()
  let candidates
  if (isMockFrameProvider(frameConfig)) {
    candidates = Array.from({ length: request.candidateCount }, (_, index) => {
      const imageUrl = buildMockImageUrl(request.shotId, index, request.versionNo)
      return {
        imageUrl,
        thumbnailUrl: buildMockThumbnailUrl(imageUrl),
        promptSnapshot: request.promptSnapshot,
        negativePrompt: request.negativePrompt || null,
        characterSnapshot: request.characterSnapshot,
        modelName: 'mock-frame-v1',
      }
    })
  } else {
    candidates = await generateFrameCandidates({
      storyboardId: request.shotId,
      versionNo: request.versionNo,
      prompt: request.promptSnapshot,
      negativePrompt: request.negativePrompt,
      modelName: request.modelName,
      publicBaseUrl: buildGeneratedFramePublicBaseUrl(),
      outputDir: GENERATED_FRAME_DIR,
      candidateCount: request.candidateCount,
      referenceImageUrls: request.referenceImageUrls || [],
      referenceImageStorageKeys: request.referenceImageStorageKeys || [],
      createSignedUrl: (key) => objectStorage.createSignedUrl({
        key,
        expiresInSeconds: Math.max(900, Number(process.env.FRAME_REFERENCE_IMAGE_SIGNED_URL_TTL_SECONDS) || 3600),
      }),
    })
  }

  await updateGenerationJob(jobId, { progress_percent: 85 })
  const insertedIds = []
  for (const candidate of candidates) {
    const [result] = await db.execute(
      `INSERT INTO image_assets
        (storyboard_id, version_no, image_url, thumbnail_url,
         prompt_snapshot, frame_role, negative_prompt, character_snapshot, model_name, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate')`,
      [
        request.shotId,
        request.versionNo,
        candidate.imageUrl,
        candidate.thumbnailUrl,
        candidate.promptSnapshot || request.promptSnapshot || null,
        normalizeFrameRole(request.frameRole),
        candidate.negativePrompt || request.negativePrompt || null,
        JSON.stringify(candidate.characterSnapshot || request.characterSnapshot || []),
        candidate.modelName || request.modelName,
        request.viewType || 'single',
      ],
    )
    insertedIds.push(Number(result.insertId))
  }
  const placeholders = insertedIds.map(() => '?').join(', ')
  const [rows] = await db.execute(
    `SELECT * FROM image_assets WHERE id IN (${placeholders}) ORDER BY id ASC`,
    insertedIds,
  )
  return { items: rows.map(imageAssetRow) }
}

async function processVideoGenerationJob(jobId, request) {
  const [existingRows] = await db.execute(
    `SELECT * FROM video_assets WHERE generation_job_id = ? ORDER BY id ASC`,
    [jobId],
  )
  if (existingRows.length >= request.candidateCount) {
    return { items: existingRows.map(videoAssetRow), providerTasks: request.providerTasks || [] }
  }

  const videoConfig = getVideoConfig()
  assertVideoProviderSnapshot(request.videoProvider, videoConfig)
  assertVideoModelProvider(request.modelName, videoConfig)
  request.videoProvider ||= videoConfig.provider
  request.videoGenerationStage = '准备资产引用'
  let candidates
  if (isMockVideoProvider(videoConfig)) {
    candidates = Array.from({ length: request.candidateCount }, (_, index) => ({
      videoUrl: buildMockVideoUrl(request.storyboardId, index, request.versionNo),
      thumbnailUrl: buildMockVideoThumbnailUrl(request.imageUrl),
      motionMode: request.motionMode,
      durationSeconds: request.durationSeconds,
      modelName: 'mock-video-v1',
    }))
  } else {
    // Wan accepts Base64 media and the job already carries an exact first frame.
    // Do not route its reference images through the Agnes/ToAPI public-URL bridge.
    const wanProvider = isWanVideoProvider(videoConfig)
    const referenceImages = wanProvider ? [] : await prepareVideoReferenceImages(request, videoConfig)
    // Persist the exact provider-facing URLs so a failed job can be diagnosed
    // without guessing whether it used a COS URL or the public storage proxy.
    request.providerReferenceImages = referenceImages
    request.videoGenerationStage = '提交并等待视频服务商任务'
    await updateGenerationJob(jobId, { request_json: JSON.stringify(request) })
    candidates = await generateVideoCandidates({
      imageUrl: request.imageUrl,
      firstFrameUrl: request.firstFrameUrl || request.imageUrl || '',
      lastFrameUrl: request.lastFrameUrl || '',
      prompt: request.promptSnapshot,
      motionMode: request.motionMode,
      durationSeconds: request.durationSeconds,
      modelName: request.modelName,
      candidateCount: request.candidateCount,
      imageRatio: request.imageRatio || null,
      generationMode: request.generationMode || 'image_to_video',
      referenceImages,
      referenceAudios: request.referenceAudioUrls || [],
      resolveReferenceImages: wanProvider
        ? async () => []
        : async () => {
            const refreshed = await prepareVideoReferenceImages(request, videoConfig)
            request.providerReferenceImages = refreshed
            await updateGenerationJob(jobId, { request_json: JSON.stringify(request) })
            return refreshed
          },
      providerTasks: request.providerTasks || [],
      onTasksCreated: async (providerTasks) => {
        request.providerTasks = providerTasks.map((task) => ({
          videoId: task.videoId,
          initialPayload: task.initialPayload || null,
          candidatePrompt: task.candidatePrompt,
          videoUrl: task.videoUrl || null,
          payload: task.payload || null,
          status: task.status || 'pending',
        }))
        await updateGenerationJob(jobId, {
          progress_percent: 30,
          request_json: JSON.stringify(request),
        })
      },
      onTasksCompleted: async (providerTasks) => {
        // 供应商已经完成后，先把结果 URL 写入任务快照，再进行下载、抽帧和 COS
        // 后处理。后处理失败时重试可复用该 URL，避免再次创建付费任务。
        request.providerTasks = providerTasks.map((task) => ({
          videoId: task.videoId,
          initialPayload: task.initialPayload || null,
          candidatePrompt: task.candidatePrompt,
          videoUrl: task.videoUrl,
          payload: task.payload || null,
          status: task.status || 'succeeded',
        }))
        request.videoGenerationStage = '保存服务商视频结果'
        await updateGenerationJob(jobId, {
          progress_percent: 70,
          request_json: JSON.stringify(request),
        })
      },
    })
  }

  await updateGenerationJob(jobId, { progress_percent: 85 })
  request.videoGenerationStage = '下载视频并写入 COS'
  await updateGenerationJob(jobId, { request_json: JSON.stringify(request) })
  const insertedIds = existingRows.map((row) => Number(row.id))
  const persistedItems = existingRows.map((row) => ({
    providerVideoUrl: null,
    localVideoUrl: row.video_url,
  }))
  for (let index = existingRows.length; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const providerVideoUrl = candidate.videoUrl
    const persisted = isMockVideoProvider(videoConfig)
      ? {
        videoUrl: providerVideoUrl,
        qualityReport: buildVideoCandidateInspection({
          expected: request.videoInspectionExpected,
          inspectionError: '模拟视频没有本地媒体文件，未执行媒体技术检查。',
        }),
      }
      : await persistGeneratedVideo({
          projectId: request.projectId,
          storyboardId: request.storyboardId,
          versionNo: request.versionNo,
          candidateNo: index + 1,
          sourceUrl: providerVideoUrl,
          expected: request.videoInspectionExpected,
          frameReferences: request.frameReferences,
        })
    const [result] = await db.execute(
      `INSERT INTO video_assets
        (storyboard_id, image_asset_id, version_no, video_url, storage_key,
         end_frame_url, end_frame_storage_key, thumbnail_url,
         motion_mode, duration_seconds, model_name, generation_job_id, quality_report_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate')`,
      [
        request.storyboardId,
        request.imageAssetId,
        request.versionNo,
        persisted.videoUrl,
        persisted.storageKey,
        persisted.endFrameUrl || null,
        persisted.endFrameStorageKey || null,
        candidate.thumbnailUrl || request.imageUrl || null,
        candidate.motionMode || request.motionMode || null,
        candidate.durationSeconds || request.durationSeconds,
        candidate.modelName || request.modelName,
        jobId,
        JSON.stringify(persisted.qualityReport || buildVideoCandidateInspection({
          expected: request.videoInspectionExpected,
          inspectionError: '缺少视频技术检查结果。',
        })),
      ],
    )
    insertedIds.push(Number(result.insertId))
    persistedItems.push({ providerVideoUrl, localVideoUrl: persisted.videoUrl })
  }

  if (request.autoConfirm === true && insertedIds.length) {
    const [selectedRows] = await db.execute(
      `SELECT quality_report_json FROM video_assets WHERE id = ? LIMIT 1`,
      [insertedIds[0]],
    )
    const selectedReport = safeJsonParse(selectedRows[0]?.quality_report_json, null)
    if (selectedReport?.technicalStatus !== 'passed') {
      throw new Error('视频技术质检尚未通过，不能自动采用；请在创作页检查候选后手动确认。')
    }
    const selectedVideoId = insertedIds[0]
    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()
      await conn.execute(
        `UPDATE video_assets
         SET status = CASE WHEN status = 'confirmed' THEN 'archived' ELSE status END,
             confirmed_at = NULL
         WHERE storyboard_id = ? AND id <> ?`,
        [request.storyboardId, selectedVideoId],
      )
      await conn.execute(
        `UPDATE video_assets SET status = 'confirmed', confirmed_at = NOW() WHERE id = ?`,
        [selectedVideoId],
      )
      const [selectedRows] = await conn.execute(`SELECT video_url FROM video_assets WHERE id = ? LIMIT 1`, [
        selectedVideoId,
      ])
      await conn.execute(
        `UPDATE storyboards SET video_url = ?, updated_at = NOW() WHERE id = ?`,
        [selectedRows[0]?.video_url || null, request.storyboardId],
      )
      await conn.commit()
    } catch (error) {
      await conn.rollback()
      throw error
    } finally {
      conn.release()
    }
  }

  const placeholders = insertedIds.map(() => '?').join(', ')
  const [rows] = await db.execute(
    `SELECT * FROM video_assets WHERE id IN (${placeholders}) ORDER BY id ASC`,
    insertedIds,
  )
  return {
    items: rows.map(videoAssetRow),
    providerTasks: request.providerTasks || [],
    persistedItems,
  }
}

async function processSubtitleCleanupJob(jobId, request) {
  const sourceDir = path.join(GENERATED_VIDEO_DIR, 'sources')
  await mkdir(sourceDir, { recursive: true })
  const sourcePath = path.join(sourceDir, `subtitle-cleanup-${jobId}-source.mp4`)
  const outputPath = path.join(GENERATED_VIDEO_DIR, `subtitle-cleanup-${jobId}.mp4`)
  if (request.sourceStorageKey) {
    const stored = await objectStorage.getObject(request.sourceStorageKey)
    if (!stored?.bytes?.length) throw new Error('原视频对象不存在或为空，无法清理字幕')
    await writeFile(sourcePath, stored.bytes)
  } else {
    await downloadMediaToFile(request.sourceVideoUrl, sourcePath, 180000)
  }
  await updateGenerationJob(jobId, { progress_percent: 35 })
  await runExternalCommand(FFMPEG_BIN, buildSubtitleCleanupFfmpegArgs({
    inputPath: sourcePath,
    outputPath,
    filter: buildSubtitleCleanupFilter(request.filterOptions),
  }))
  const storageKey = buildSubtitleCleanedVideoStorageKey({
    projectId: request.projectId,
    storyboardId: request.storyboardId,
    sourceVideoId: request.sourceVideoId,
  })
  const stored = await objectStorage.putObject({
    key: storageKey,
    bytes: await readFile(outputPath),
    contentType: 'video/mp4',
  })
  await updateGenerationJob(jobId, { progress_percent: 75 })
  const [versionRows] = await db.execute(
    `SELECT COALESCE(MAX(version_no), 0) AS maxVersion
     FROM video_assets WHERE storyboard_id = ?`,
    [request.storyboardId],
  )
  const [insertResult] = await db.execute(
    `INSERT INTO video_assets
       (storyboard_id, image_asset_id, version_no, video_url, storage_key,
        thumbnail_url, motion_mode, duration_seconds, model_name, generation_job_id, source_type, status)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'subtitle_cleaned', 'candidate')`,
    [
      request.storyboardId,
      Number(versionRows[0]?.maxVersion || 0) + 1,
      stored.url,
      storageKey,
      request.thumbnailUrl || null,
      'subtitle-cleanup',
      request.durationSeconds || null,
      request.modelName || 'ffmpeg-subtitle-cleanup',
      jobId,
    ],
  )
  const [rows] = await db.execute('SELECT * FROM video_assets WHERE id = ? LIMIT 1', [insertResult.insertId])
  return { item: videoAssetRow(rows[0]) }
}

function looksLikeImageBytes(bytes) {
  if (!bytes || bytes.length < 12) return false
  const head = Buffer.from(bytes.subarray(0, 12)).toString('hex').toLowerCase()
  return head.startsWith('89504e470d0a1a0a')
    || head.startsWith('ffd8ff')
    || head.startsWith('52494646') && head.slice(16, 24) === '57454250'
    || head.startsWith('47494638')
}

async function prepareVideoReferenceImages(request, videoConfig) {
  const uploaded = []
  const publicStorageBaseUrl = String(PUBLIC_BASE_URL || '').replace(/\/+$/, '')
  const canUsePublicStorageProxy = Boolean(
    publicStorageBaseUrl &&
    !/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::|\/|$)/i.test(publicStorageBaseUrl),
  )
  const storageKeys = [...new Set(
    (Array.isArray(request.referenceImageStorageKeys) ? request.referenceImageStorageKeys : [])
      .map((key) => String(key || '').trim())
      .filter(Boolean),
  )]
  const maxImages = /^minimax(?:-|$)/i.test(String(request.modelName || ''))
    ? 9
    : isOfficialAgnesModel(request.modelName) ? 5 : 6
  const requestedImageCount = storageKeys.length || new Set(
    (Array.isArray(request.referenceImages) ? request.referenceImages : [])
      .map((url) => String(url || '').trim()).filter(Boolean),
  ).size
  if (requestedImageCount > maxImages) {
    throw new Error(`本镜头绑定 ${requestedImageCount} 张参考图，当前模型最多接收 ${maxImages} 张。请减少非必要参考图后重试；系统不会静默丢弃已确认资产。`)
  }
  for (const storageKey of storageKeys) {
    const stored = await objectStorage.getObject(storageKey)
    if (!stored?.bytes?.length) {
      throw new Error(`视频参考图对象不存在或为空：${storageKey}`)
    }
    if (!looksLikeImageBytes(stored.bytes)) {
      throw new Error(`视频参考图不是有效图片文件：${storageKey}。请检查公网存储代理和 PUBLIC_BASE_URL 配置`)
    }
    // COS public URLs are often private even when they look like normal HTTPS
    // links. Give Agnes a real signed URL so it receives PNG bytes, not the
    // provider's HTML error page. Local storage still uses the app proxy.
    if (objectStorage.provider === 'cos') {
      uploaded.push(objectStorage.createSignedUrl({
        key: storageKey,
        // A queued free-tier video may wait behind several provider creation
        // windows. The URL is still short-lived, but must outlive that queue.
        expiresInSeconds: Math.max(
          900,
          Number(process.env.VIDEO_REFERENCE_IMAGE_SIGNED_URL_TTL_SECONDS) || 3600,
        ),
      }))
    } else if (canUsePublicStorageProxy) {
      const encodedKey = storageKey.split('/').map((part) => encodeURIComponent(part)).join('/')
      uploaded.push(`${publicStorageBaseUrl}/storage/${encodedKey}`)
    } else if (videoConfig.imageUploadApiKey) {
      uploaded.push(await uploadVideoImageBytes(
        stored.bytes,
        stored.contentType || 'image/png',
        storageKey,
        videoConfig,
      ))
    } else {
      if (!publicStorageBaseUrl || /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::|\/|$)/i.test(publicStorageBaseUrl)) {
        throw new Error('视频参考图无法提供公网地址：请配置 VIDEO_IMAGE_UPLOAD_API_KEY 或公网 PUBLIC_BASE_URL')
      }
      const encodedKey = storageKey.split('/').map((part) => encodeURIComponent(part)).join('/')
      uploaded.push(`${publicStorageBaseUrl}/storage/${encodedKey}`)
    }
  }
  if (storageKeys.length) return [...new Set(uploaded)]

  const fallbackUrls = (Array.isArray(request.referenceImages) ? request.referenceImages : [])
    .map((url) => String(url || '').trim())
    .filter(Boolean)
  return [...new Set(fallbackUrls)]
}

async function processCharacterImageGenerationJob(jobId, request) {
  const frameConfig = getFrameConfig()
  let candidates
  if (isMockFrameProvider(frameConfig)) {
    candidates = Array.from({ length: request.candidateCount }, (_, index) => {
      const imageUrl = buildMockImageUrl(900000000 + request.characterId, index, request.versionNo)
      return {
        imageUrl,
        thumbnailUrl: imageUrl,
        promptSnapshot: request.promptSnapshot,
        modelName: 'mock-frame-v1',
      }
    })
  } else {
    candidates = await generateCharacterImageCandidates({
      characterId: request.characterId,
      versionNo: request.versionNo,
      character: request.character,
      projectVisualStyle: request.projectVisualStyle,
      prompt: request.prompt,
      modelName: request.modelName,
      publicBaseUrl: buildGeneratedFramePublicBaseUrl(),
      outputDir: GENERATED_FRAME_DIR,
      candidateCount: request.candidateCount,
      referenceImageUrls: request.referenceImageUrls || [],
    })
  }

  await updateGenerationJob(jobId, { progress_percent: 85 })
  const insertedIds = []
  for (const [index, candidate] of candidates.entries()) {
    let storageKey = null
    let imageUrl = candidate.imageUrl
    if (candidate.filePath) {
      const persisted = await persistGeneratedImageCandidate({
          projectId: request.projectId,
          ownerType: 'character',
          ownerId: request.characterId,
          versionNo: request.versionNo,
          candidateNo: index + 1,
          filePath: candidate.filePath,
        })
      storageKey = persisted.storageKey
      imageUrl = persisted.imageUrl || imageUrl
    }
    const [result] = await db.execute(
      `INSERT INTO character_images
        (character_id, version_no, image_url, storage_key, thumbnail_url, prompt_snapshot, model_name, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate')`,
      [
        request.characterId,
        request.versionNo,
        imageUrl,
        storageKey,
        candidate.thumbnailUrl,
        candidate.promptSnapshot || request.promptSnapshot,
        candidate.modelName || request.modelName,
      ],
    )
    insertedIds.push(Number(result.insertId))
  }
  const placeholders = insertedIds.map(() => '?').join(', ')
  const [rows] = await db.execute(
    `SELECT * FROM character_images WHERE id IN (${placeholders}) ORDER BY id ASC`,
    insertedIds,
  )
  return { items: rows.map(characterImageRow) }
}

async function loadStoredImageBytes(storageKeys = []) {
  const bytes = []
  for (const storageKey of Array.isArray(storageKeys) ? storageKeys : []) {
    const stored = await objectStorage.getObject(storageKey)
    if (stored?.bytes?.length) bytes.push(stored.bytes)
  }
  return bytes
}

async function materializeCharacterFaceCropCandidate(request) {
  const sourceKey = String(request.baseReferenceStorageKey || '').trim()
  if (!sourceKey) {
    throw new Error('角色基础图没有可读取的原始文件，无法确定性裁切脸部特写；请重新生成并确认基础图')
  }
  const source = await objectStorage.getObject(sourceKey)
  if (!source?.bytes?.length) {
    throw new Error('角色基础图原始文件不存在或为空，无法确定性裁切脸部特写')
  }
  const cropRoot = path.join(
    GENERATED_FRAME_DIR,
    `asset-node-${Number(request.assetNodeId)}-v${Number(request.versionNo)}-face-crop`,
  )
  await mkdir(cropRoot, { recursive: true })
  const sourcePath = path.join(cropRoot, 'source.png')
  const outputPath = path.join(cropRoot, 'face.png')
  await writeFile(sourcePath, source.bytes)
  const dimensions = await probeMediaDimensions(sourcePath)
  if (!dimensions) {
    throw new Error('无法读取基础图的实际尺寸，已停止脸部特写裁切')
  }
  const localization = await locateCharacterHeadBounds({
    imageBytes: source.bytes,
    imageWidth: dimensions.width,
    imageHeight: dimensions.height,
  })
  if (!localization.ok) {
    throw new Error(`脸部特写定位失败：${localization.reason}。基础全身图保持不变，请重新定位或重试`)
  }
  const cropFilter = buildCharacterFaceCropFilter({
    imageWidth: dimensions.width,
    imageHeight: dimensions.height,
    headBox: localization.headBox,
  })
  await runExternalCommand(FFMPEG_BIN, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    sourcePath,
    '-vf',
    cropFilter,
    '-frames:v',
    '1',
    '-c:v',
    'png',
    outputPath,
  ])
  if (!(await fileExists(outputPath))) {
    throw new Error('基础图脸部裁切没有产出图片')
  }
  return {
    filePath: outputPath,
    imageUrl: null,
    thumbnailUrl: null,
    promptSnapshot: request.promptSnapshot,
    modelName: 'vision-localized-face-crop-v3',
  }
}

async function inspectCharacterGeneratedCandidate({ candidate, request, viewKey, identityReferenceBytes }) {
  const localBytes = candidate.filePath && await fileExists(candidate.filePath)
    ? await readFile(candidate.filePath)
    : null
  return inspectAssetImage({
    imageUrl: localBytes ? null : candidate.imageUrl,
    imageBytes: localBytes,
    referenceImageUrls: identityReferenceBytes.length ? [] : request.referenceImageUrls || [],
    referenceImageBytesList: identityReferenceBytes,
    viewKey,
    nodeType: 'character',
    identityLock: true,
    noFace: /不露脸|正面不呈现|不直接露脸|不出现正脸|脸部.*不可见/u.test(String(request.prompt || '')),
  })
}

async function generateCharacterDerivedCandidate({
  request,
  prompt,
  viewKey,
  storageReferenceUrls,
  identityReferenceBytes,
}) {
  if (request.viewType === 'character-face-closeup') {
    const candidate = await materializeCharacterFaceCropCandidate(request)
    return {
      ...candidate,
      precheckedVision: await inspectCharacterGeneratedCandidate({
        candidate,
        request,
        viewKey,
        identityReferenceBytes,
      }),
    }
  }

  const maxAttempts = characterDerivedQualityAttempts(request.qualityAttempts, 3)
  let lastCandidate = null
  let previousReason = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptPrompt = attempt === 1
      ? prompt
      : `${prompt}\n${buildCharacterQualityRepairPrompt({ viewKey, previousReason, attempt })}`
    const [candidate] = isMockFrameProvider(getFrameConfig())
      ? [{
          imageUrl: buildMockImageUrl(900000000 + request.assetNodeId, attempt - 1, request.versionNo),
          thumbnailUrl: buildMockImageUrl(900000000 + request.assetNodeId, attempt - 1, request.versionNo),
          promptSnapshot: attemptPrompt,
          modelName: 'mock-frame-v1',
        }]
      : await generateFrameCandidates({
          storyboardId: `asset-node-${request.assetNodeId}-${viewKey}-quality-${attempt}`,
          versionNo: request.versionNo,
          prompt: attemptPrompt,
          negativePrompt: request.negativePrompt,
          modelName: request.modelName,
          publicBaseUrl: buildGeneratedFramePublicBaseUrl(),
          outputDir: GENERATED_FRAME_DIR,
          candidateCount: 1,
          generationMode: request.generationMode || 'image_to_video',
          imageRatio: request.imageRatio || null,
          referenceImageUrls: storageReferenceUrls.length ? storageReferenceUrls : request.referenceImageUrls || [],
          generationContext: 'character-reference',
        })
    if (!candidate) throw new Error(`角色${request.viewLabel || viewKey}视角没有产出图片`)
    const vision = await inspectCharacterGeneratedCandidate({
      candidate,
      request,
      viewKey,
      identityReferenceBytes,
    })
    lastCandidate = {
      ...candidate,
      promptSnapshot: attemptPrompt,
      qualityAttempt: attempt,
      precheckedVision: vision,
    }
    if (vision.passed) return lastCandidate
    if (shouldStopAssetRetry(vision)) {
      throw new Error(`角色${request.viewLabel || viewKey}视角内容门禁失败：${vision.reason}`)
    }
    previousReason = vision.reason || '视觉检查未通过'
  }
  return lastCandidate
}

async function inspectSceneGeneratedCandidate({ candidate, viewKey, sceneReferenceImageBytes }) {
  const localBytes = candidate.filePath && await fileExists(candidate.filePath)
    ? await readFile(candidate.filePath)
    : null
  const vision = await inspectAssetImage({
    imageUrl: localBytes ? null : candidate.imageUrl,
    imageBytes: localBytes,
    referenceImageBytes: sceneReferenceImageBytes,
    viewKey,
    scene: true,
    nodeType: 'scene',
  })
  return enforceEmptySceneVision(vision)
}

async function processAssetNodeImageGenerationJob(jobId, request) {
  const frameConfig = getFrameConfig()
  let candidates
  const isSceneNineGridBatch = request.viewType === 'scene-nine-grid' && !request.viewKey
  const isSceneNineGridAngle = request.viewType === 'scene-nine-grid' && Boolean(request.viewKey)
  const isCharacterTurnaroundBatch = request.viewType === 'character-turnaround'
    && !request.viewKey
    && Array.isArray(request.viewBatch)
    && request.viewBatch.length
  const isCharacterDerivedSingle = request.nodeType === 'character'
    && ['character-turnaround', 'character-face-closeup'].includes(request.viewType)
    && Boolean(request.viewKey)
  let identityReferenceBytes = await loadStoredImageBytes(request.identityReferenceImageStorageKeys)
  // 资产板拆分后的每个区域都可能进入身份复核。检查当前区域时排除它自身，
  // 避免把“自己和自己”判成一致。
  let assetPackReferenceBytesByView = {}
  let sceneReferenceImageBytes = null
  if (isSceneVisionCheckEnabled()
    && request.viewType === 'scene-nine-grid'
    && Array.isArray(request.referenceImageStorageKeys)) {
    const sceneReferenceStorageKeys = [
      request.panoramaStorageKey,
      ...request.referenceImageStorageKeys,
    ].filter((key, index, keys) => key && keys.indexOf(key) === index)
    for (const storageKey of sceneReferenceStorageKeys) {
      const stored = await objectStorage.getObject(storageKey)
      if (stored?.bytes?.length) {
        sceneReferenceImageBytes = stored.bytes
        break
      }
    }
    if (!sceneReferenceImageBytes) {
      throw new Error('场景九宫格母图原始对象不存在，已阻止使用过期签名 URL 继续视觉检查')
    }
  }
  const isCharacterAssetPack = Boolean(request.assetPackEnabled)
    && request.nodeType === 'character'
    && request.viewType === 'single'
  if (isCharacterAssetPack) {
    const storageReferenceUrls = []
    for (const storageKey of Array.isArray(request.referenceImageStorageKeys)
      ? request.referenceImageStorageKeys
      : []) {
      const stored = await objectStorage.getObject(storageKey)
      if (!stored?.bytes?.length) throw new Error(`参考图对象不存在或为空：${storageKey}`)
      storageReferenceUrls.push(`data:${stored.contentType || 'image/png'};base64,${Buffer.from(stored.bytes).toString('base64')}`)
    }
    const [board] = isMockFrameProvider(frameConfig)
      ? [{
          imageUrl: buildMockImageUrl(900000000 + request.assetNodeId, 0, request.versionNo),
          thumbnailUrl: buildMockImageUrl(900000000 + request.assetNodeId, 0, request.versionNo),
          filePath: await materializeMockCharacterAssetPackBoard({
            assetNodeId: request.assetNodeId,
            versionNo: request.versionNo,
          }),
          promptSnapshot: request.promptSnapshot,
          modelName: 'mock-frame-v1',
        }]
      : await generateFrameCandidates({
          storyboardId: `asset-node-${request.assetNodeId}-character-pack`,
          versionNo: request.versionNo,
          prompt: request.prompt,
          negativePrompt: request.negativePrompt,
          modelName: request.modelName,
          publicBaseUrl: buildGeneratedFramePublicBaseUrl(),
          outputDir: GENERATED_FRAME_DIR,
          candidateCount: 1,
          imageRatio: '16:9',
          referenceImageUrls: storageReferenceUrls.length
            ? storageReferenceUrls
            : request.referenceImageUrls || [],
          generationContext: 'character-reference',
        })
    if (!board?.filePath) {
      throw new Error('角色资产包模型没有返回可读取的资产板文件，已回退到普通角色基础图流程')
    }
    // 豆包资产包本身就是图4所示的完整母板。不要再按旧版固定坐标裁切：
    // 不同模型会改变人物留白和排版，强行裁切会把脸、下巴和三视图切坏。
    // 母板以一个独立结果保存，后续视频和视觉检查都引用这张同源图。
    candidates = [{
      ...board,
      assetPackViewType: 'character-asset-pack',
      viewIndex: null,
      viewKey: null,
      viewLabel: '角色资产板',
      promptSnapshot: request.prompt,
    }]
    const boardBytes = await readFile(board.filePath)
    identityReferenceBytes = [boardBytes]
    assetPackReferenceBytesByView = { __pack__: boardBytes }
  } else if (isSceneNineGridBatch) {
    const storageReferenceUrls = []
    for (const storageKey of Array.isArray(request.referenceImageStorageKeys)
      ? request.referenceImageStorageKeys
      : []) {
      const stored = await objectStorage.getObject(storageKey)
      if (!stored?.bytes?.length) {
        throw new Error(`参考图对象不存在或为空：${storageKey}`)
      }
      const contentType = stored.contentType || 'image/png'
      storageReferenceUrls.push(
        `data:${contentType};base64,${Buffer.from(stored.bytes).toString('base64')}`,
      )
    }
    const panoramaReference = String(
      request.panoramaImageUrl || request.panoramaStorageKey || 'confirmed-panorama-reference',
    ).trim()
    candidates = []
    const maxAttempts = isSceneVisionCheckEnabled()
      ? sceneNineGridQualityAttempts(request.qualityAttempts, 5)
      : 1
    const failedAngles = []
    for (const descriptor of buildSceneNineGridViewDescriptors({}).map((item) => item)) {
      const baseAnglePrompt = buildSceneNineGridAnglePrompt({
        angle: descriptor.viewKey,
        panorama: panoramaReference,
        spatialAnchors: request.sceneSpatialAnchors,
      })
      let accepted = null
      let previousReason = ''
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const anglePrompt = attempt === 1
          ? baseAnglePrompt
          : `${baseAnglePrompt}\n${buildSceneNineGridQualityRepairPrompt({
              angle: descriptor.viewKey,
              previousReason,
              attempt,
            })}`
        const [candidate] = isMockFrameProvider(frameConfig)
          ? [{
              imageUrl: buildMockImageUrl(900000000 + request.assetNodeId, descriptor.viewIndex - 1, request.versionNo),
              thumbnailUrl: buildMockImageUrl(900000000 + request.assetNodeId, descriptor.viewIndex - 1, request.versionNo),
              promptSnapshot: anglePrompt,
              modelName: 'mock-frame-v1',
            }]
          : await generateFrameCandidates({
              storyboardId: `asset-node-${request.assetNodeId}-${descriptor.viewKey}-quality-${attempt}`,
              versionNo: request.versionNo,
              prompt: anglePrompt,
              negativePrompt: request.negativePrompt,
              modelName: request.modelName,
              publicBaseUrl: buildGeneratedFramePublicBaseUrl(),
              outputDir: GENERATED_FRAME_DIR,
              candidateCount: 1,
              generationMode: request.generationMode || 'image_to_video',
              imageRatio: request.imageRatio || null,
              referenceImageUrls: storageReferenceUrls.length
                ? storageReferenceUrls
                : request.referenceImageUrls || [],
              generationContext: 'scene-environment',
            })
        if (!candidate) throw new Error(`场景${descriptor.viewLabel}视角没有产出图片`)
        const vision = isSceneVisionCheckEnabled()
          ? await inspectSceneGeneratedCandidate({
              candidate,
              viewKey: descriptor.viewKey,
              sceneReferenceImageBytes,
            })
          : {
              passed: true,
              skipped: true,
              reason: '未运行视觉检查；结果需由用户按全景基准人工确认',
            }
        const enriched = {
          ...candidate,
          // 每个视角都留存自己的完整提示词，不能退回到九宫格批次的泛化提示词。
          promptSnapshot: anglePrompt,
          viewIndex: descriptor.viewIndex,
          viewKey: descriptor.viewKey,
          viewLabel: descriptor.viewLabel,
          precheckedVision: vision,
        }
        if (vision.passed) {
          accepted = enriched
          break
        }
        if (shouldStopAssetRetry(vision)) {
          throw new Error(`场景${descriptor.viewLabel}视角内容门禁失败：${vision.reason}`)
        }
        previousReason = vision.reason || '视觉检查未通过'
      }
      if (!accepted) {
        failedAngles.push(`${descriptor.viewLabel}：${previousReason || '视觉检查未通过'}`)
        continue
      }
      candidates.push(accepted)
    }
    if (candidates.length !== buildSceneNineGridViewDescriptors({}).length) {
      throw new Error(`场景九宫格未完成 9/9：${failedAngles.join('；')}`)
    }
  } else if (isCharacterTurnaroundBatch) {
    const storageReferenceUrls = []
    for (const storageKey of Array.isArray(request.referenceImageStorageKeys)
      ? request.referenceImageStorageKeys
      : []) {
      const stored = await objectStorage.getObject(storageKey)
      if (!stored?.bytes?.length) throw new Error(`参考图对象不存在或为空：${storageKey}`)
      storageReferenceUrls.push(`data:${stored.contentType || 'image/png'};base64,${Buffer.from(stored.bytes).toString('base64')}`)
    }
    candidates = []
    for (const [index, descriptor] of request.viewBatch.entries()) {
      const candidate = await generateCharacterDerivedCandidate({
        request,
        prompt: descriptor.prompt,
        viewKey: descriptor.viewKey,
        storageReferenceUrls,
        identityReferenceBytes,
      })
      candidates.push({
        ...candidate,
        promptSnapshot: descriptor.prompt,
        viewIndex: descriptor.viewIndex,
        viewKey: descriptor.viewKey,
        viewLabel: descriptor.viewLabel,
      })
    }
  } else if (isSceneNineGridAngle) {
    const [descriptor] = buildSceneNineGridViewDescriptors({}).filter((item) => item.viewKey === request.viewKey)
    if (!descriptor) throw new Error(`无效的场景九宫格视角：${request.viewKey}`)
    const storageReferenceUrls = []
    for (const storageKey of Array.isArray(request.referenceImageStorageKeys)
      ? request.referenceImageStorageKeys
      : []) {
      const stored = await objectStorage.getObject(storageKey)
      if (!stored?.bytes?.length) throw new Error(`参考图对象不存在或为空：${storageKey}`)
      storageReferenceUrls.push(`data:${stored.contentType || 'image/png'};base64,${Buffer.from(stored.bytes).toString('base64')}`)
    }
    const baseAnglePrompt = buildSceneNineGridAnglePrompt({
      angle: descriptor.viewKey,
      panorama: request.panoramaImageUrl || request.panoramaStorageKey,
      spatialAnchors: request.sceneSpatialAnchors,
    })
    // Scene angle retries are not character derivatives. Reusing the
    // character helper here makes its precheck treat the panorama URL as a
    // character identity reference, which can send an expired COS URL to the
    // vision model. Scene retries use the same direct provider path as the
    // nine-grid batch; the common insert/inspection path supplies panorama
    // bytes for the spatial check.
    const maxAttempts = isSceneVisionCheckEnabled()
      ? sceneNineGridQualityAttempts(request.qualityAttempts, 5)
      : 1
    let accepted = null
    let previousReason = ''
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const anglePrompt = attempt === 1
        ? baseAnglePrompt
        : `${baseAnglePrompt}\n${buildSceneNineGridQualityRepairPrompt({
            angle: descriptor.viewKey,
            previousReason,
            attempt,
          })}`
      const [candidate] = isMockFrameProvider(frameConfig)
        ? [{
            imageUrl: buildMockImageUrl(900000000 + request.assetNodeId, descriptor.viewIndex - 1, request.versionNo),
            thumbnailUrl: buildMockImageUrl(900000000 + request.assetNodeId, descriptor.viewIndex - 1, request.versionNo),
            promptSnapshot: anglePrompt,
            modelName: 'mock-frame-v1',
          }]
        : await generateFrameCandidates({
            storyboardId: `asset-node-${request.assetNodeId}-${descriptor.viewKey}-retry-quality-${attempt}`,
            versionNo: request.versionNo,
            prompt: anglePrompt,
            negativePrompt: request.negativePrompt,
            modelName: request.modelName,
            publicBaseUrl: buildGeneratedFramePublicBaseUrl(),
            outputDir: GENERATED_FRAME_DIR,
            candidateCount: 1,
            generationMode: request.generationMode || 'image_to_video',
            imageRatio: request.imageRatio || null,
            referenceImageUrls: storageReferenceUrls.length
              ? storageReferenceUrls
              : request.referenceImageUrls || [],
            generationContext: 'scene-environment',
          })
      if (!candidate) throw new Error(`场景${descriptor.viewLabel}视角没有产出图片`)
      const vision = isSceneVisionCheckEnabled()
        ? await inspectSceneGeneratedCandidate({
            candidate,
            viewKey: descriptor.viewKey,
            sceneReferenceImageBytes,
          })
        : {
            passed: true,
            skipped: true,
            reason: '未运行视觉检查；结果需由用户按全景基准人工确认',
          }
      const enriched = {
        ...candidate,
        promptSnapshot: anglePrompt,
        viewIndex: descriptor.viewIndex,
        viewKey: descriptor.viewKey,
        viewLabel: descriptor.viewLabel,
        precheckedVision: vision,
      }
      if (vision.passed) {
        accepted = enriched
        break
      }
      if (shouldStopAssetRetry(vision)) {
        throw new Error(`场景${descriptor.viewLabel}视角内容门禁失败：${vision.reason}`)
      }
      previousReason = vision.reason || '视觉检查未通过'
    }
    if (!accepted) throw new Error(`场景${descriptor.viewLabel}视角没有生成可用图片：${previousReason}`)
    candidates = [accepted]
  } else if (isCharacterDerivedSingle) {
    // Single retries must use the same derived-image path as the batch job.
    // In particular, face closeups are deterministic crops of the confirmed
    // base image; falling through to the generic provider path recreates the
    // old bug where a full-body reference was redrawn as a different face.
    const storageReferenceUrls = []
    for (const storageKey of Array.isArray(request.referenceImageStorageKeys)
      ? request.referenceImageStorageKeys
      : []) {
      const stored = await objectStorage.getObject(storageKey)
      if (!stored?.bytes?.length) throw new Error(`参考图对象不存在或为空：${storageKey}`)
      storageReferenceUrls.push(`data:${stored.contentType || 'image/png'};base64,${Buffer.from(stored.bytes).toString('base64')}`)
    }
    const candidate = await generateCharacterDerivedCandidate({
      request,
      prompt: request.prompt,
      viewKey: request.viewKey,
      storageReferenceUrls,
      identityReferenceBytes,
    })
    candidates = [{
      ...candidate,
      promptSnapshot: candidate.promptSnapshot || request.promptSnapshot,
      viewIndex: request.viewIndex,
      viewKey: request.viewKey,
      viewLabel: request.viewLabel,
    }]
  } else if (isMockFrameProvider(frameConfig)) {
    candidates = Array.from({ length: request.candidateCount }, (_, index) => {
      const imageUrl = buildMockImageUrl(900000000 + request.assetNodeId, index, request.versionNo)
      return {
        imageUrl,
        thumbnailUrl: imageUrl,
        promptSnapshot: request.promptSnapshot,
        modelName: 'mock-frame-v1',
        viewIndex: request.viewIndex || null,
        viewKey: request.viewKey || null,
        viewLabel: request.viewLabel || null,
      }
    })
  } else {
    const storageReferenceUrls = []
    for (const storageKey of Array.isArray(request.referenceImageStorageKeys)
      ? request.referenceImageStorageKeys
      : []) {
      const stored = await objectStorage.getObject(storageKey)
      if (!stored?.bytes?.length) {
        throw new Error(`参考图对象不存在或为空：${storageKey}`)
      }
      const contentType = stored.contentType || 'image/png'
      storageReferenceUrls.push(
        `data:${contentType};base64,${Buffer.from(stored.bytes).toString('base64')}`,
      )
    }
    candidates = await generateFrameCandidates({
      storyboardId: `asset-node-${request.assetNodeId}`,
      versionNo: request.versionNo,
      prompt: request.prompt,
      negativePrompt: request.negativePrompt,
      modelName: request.modelName,
      publicBaseUrl: buildGeneratedFramePublicBaseUrl(),
      outputDir: GENERATED_FRAME_DIR,
      candidateCount: request.candidateCount,
      generationMode: request.generationMode || 'image_to_video',
      imageRatio: request.imageRatio || null,
      referenceImageUrls: storageReferenceUrls.length
        ? storageReferenceUrls
        : request.referenceImageUrls || [],
      generationContext: request.nodeType === 'scene' ? 'scene-environment' : 'cinematic-frame',
    })
  }

  if (['character-turnaround', 'character-face-closeup'].includes(request.viewType) && request.viewKey) {
    candidates = candidates.slice(0, 1).map((candidate) => ({
      ...candidate,
      viewIndex: request.viewIndex,
      viewKey: request.viewKey,
      viewLabel: request.viewLabel,
    }))
  }
  await updateGenerationJob(jobId, { progress_percent: 85 })
  const insertedIds = []
  async function insertImage({
    candidate,
    candidateNo,
    viewSetType = request.viewType || 'single',
    viewIndex = candidate.viewIndex || request.viewIndex || null,
    viewKey = candidate.viewKey || request.viewKey || null,
    viewLabel = candidate.viewLabel || request.viewLabel || null,
    sourceImageId = null,
    sourceImageUrl = null,
    crop = null,
  }) {
    let storageKey = null
    let imageUrl = candidate.imageUrl
    if (candidate.filePath) {
      const persisted = await persistGeneratedImageCandidate({
        projectId: request.projectId,
        ownerType: 'asset_node',
        ownerId: request.assetNodeId,
        versionNo: request.versionNo,
        candidateNo,
        filePath: candidate.filePath,
      })
      storageKey = persisted.storageKey
      imageUrl = persisted.imageUrl || imageUrl
    }
    const [result] = await db.execute(
      `INSERT INTO asset_node_images
        (asset_node_id, version_no, image_url, storage_key, thumbnail_url, prompt_snapshot, model_name,
         view_set_type, view_set_version, view_index, view_key, view_label,
         source_image_id, source_image_url, crop_json,
         character_identity_lock_json, identity_status, identity_reason,
         identity_similarity_score, wardrobe_consistency_score,
         vision_status, vision_reason, vision_checked_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'pending', NULL, NULL, 'candidate')`,
      [
        request.assetNodeId,
        request.versionNo,
        imageUrl,
        storageKey,
        // 模型返回的缩略图通常是短时地址；图片落盘后必须跟随持久化地址。
        storageKey ? imageUrl : candidate.thumbnailUrl,
        candidate.promptSnapshot || request.promptSnapshot,
        candidate.modelName || request.modelName,
        viewSetType,
        request.versionNo,
        viewIndex,
        viewKey,
        viewLabel,
        sourceImageId,
        sourceImageUrl,
        crop ? JSON.stringify(crop) : null,
        request.identityLockSnapshot && request.nodeType === 'character'
          ? JSON.stringify(request.identityLockSnapshot)
          : null,
        request.identityLockSnapshot && request.nodeType === 'character'
          && ['character-turnaround', 'character-face-closeup'].includes(viewSetType)
          ? 'pending'
          : 'not_checked',
      ],
    )
    const imageId = Number(result.insertId)
    insertedIds.push(imageId)
    if (request.nodeType === 'scene') {
      await db.execute(
        `UPDATE asset_node_images
         SET vision_status = 'skipped',
             vision_reason = '未运行视觉检查；结果需由用户按全景基准人工确认',
             vision_checked_at = NULL,
             identity_status = 'not_checked'
         WHERE id = ?`,
        [imageId],
      )
    }
    if (candidate.precheckedVision) {
      const prechecked = candidate.precheckedVision
      const identityChecked = request.nodeType === 'character'
        && ['character-turnaround', 'character-face-closeup'].includes(viewSetType)
      await db.execute(
        `UPDATE asset_node_images
         SET vision_status = ?, vision_reason = ?, vision_checked_at = IF(?, NULL, NOW()),
             identity_status = ?, identity_reason = ?,
             identity_similarity_score = ?, wardrobe_consistency_score = ?
         WHERE id = ?`,
        [
          prechecked.skipped ? 'skipped' : prechecked.pending ? 'pending' : prechecked.passed ? 'passed' : 'failed',
          prechecked.reason || null,
          Boolean(prechecked.skipped),
          identityChecked ? (prechecked.pending ? 'pending' : prechecked.passed ? 'passed' : 'failed') : 'not_checked',
          identityChecked ? prechecked.reason || null : null,
          identityChecked ? prechecked.identitySimilarityScore : null,
          identityChecked ? prechecked.wardrobeConsistencyScore : null,
          imageId,
        ],
      )
    }
    return { imageId, imageUrl, storageKey }
  }

  for (const [index, candidate] of candidates.entries()) {
    if (request.viewType === 'scene-nine-grid') {
      await insertImage({
        candidate,
        candidateNo: index + 1,
        viewSetType: 'scene-nine-grid',
        viewIndex: candidate.viewIndex,
        viewKey: candidate.viewKey,
        viewLabel: candidate.viewLabel,
        sourceImageId: request.panoramaImageId,
        sourceImageUrl: request.panoramaImageUrl,
        crop: null,
      })
    } else if (candidate.assetPackViewType) {
      await insertImage({
        candidate,
        candidateNo: index + 1,
        viewSetType: candidate.assetPackViewType,
        viewIndex: candidate.viewIndex,
        viewKey: candidate.viewKey,
        viewLabel: candidate.viewLabel,
        sourceImageId: null,
        sourceImageUrl: null,
      })
    } else {
      await insertImage({
        candidate,
        candidateNo: index + 1,
        sourceImageId: request.sourceImageId,
        sourceImageUrl: request.baseReferenceImageUrl || null,
      })
    }
  }
  if (!insertedIds.length) throw new Error('画布节点形象生成没有产出任何候选')
  for (const insertedId of insertedIds) {
    const [imageRows] = await db.execute(
      `SELECT image_url, storage_key, view_key, view_set_type, source_image_id,
              vision_status, identity_status, character_identity_lock_json
       FROM asset_node_images WHERE id = ? LIMIT 1`,
      [insertedId],
    )
    const image = imageRows[0]
    const shouldInspect = request.nodeType !== 'scene'
      && (['character-asset-pack', 'character-turnaround', 'character-face-closeup', 'prop-turnaround'].includes(image?.view_set_type)
      || (
        image?.view_set_type === 'single'
        && ['character', 'scene', 'prop', 'material'].includes(request.nodeType)
        && !image?.view_key
      ))
    if (!shouldInspect || image?.vision_status !== 'pending') continue
    let vision
    try {
      const stored = image.storage_key ? await objectStorage.getObject(image.storage_key) : null
      let sourceStored = null
      let sourceRows = []
      if (image.view_set_type === 'scene-nine-grid' && image.source_image_id) {
        const [rows] = await db.execute(
          'SELECT storage_key, image_url FROM asset_node_images WHERE id = ? LIMIT 1',
          [image.source_image_id],
        )
        sourceRows = rows
        if (sourceRows[0]?.storage_key) {
          sourceStored = await objectStorage.getObject(sourceRows[0].storage_key)
        }
      }
      const imageReferenceKey = image.view_key || (image.view_set_type === 'single' ? '__base__' : '')
      const assetPackReferences = Object.entries(assetPackReferenceBytesByView)
        .filter(([key]) => key !== imageReferenceKey)
        .map(([, bytes]) => bytes)
      const identityReferencesForImage = assetPackReferences.length
        ? assetPackReferences
        : identityReferenceBytes
      vision = await inspectAssetImage({
        imageUrl: stored ? null : image.image_url,
        imageBytes: stored?.bytes || null,
        // Scene checks must never send a signed COS URL to the vision model.
        // The panorama bytes loaded from object storage are the only accepted
        // reference for a scene-nine-grid result.
        referenceImageUrl: null,
        referenceImageBytes: image.view_set_type === 'scene-nine-grid'
          ? sceneReferenceImageBytes
          : sourceStored?.bytes || null,
        referenceImageUrls: request.nodeType === 'character'
          && ['character-turnaround', 'character-face-closeup'].includes(image.view_set_type)
          ? identityReferencesForImage.length ? [] : request.referenceImageUrls || []
          : [],
        referenceImageBytesList: request.nodeType === 'character'
          && ['character-turnaround', 'character-face-closeup'].includes(image.view_set_type)
          ? identityReferencesForImage
          : [],
        viewKey: image.view_key || (request.nodeType === 'character' ? 'front' : null),
        scene: request.nodeType === 'scene',
        assetPack: image.view_set_type === 'character-asset-pack',
        nodeType: request.nodeType,
        identityLock: request.nodeType === 'character'
          && ['character-turnaround', 'character-face-closeup'].includes(image.view_set_type),
        noFace: request.nodeType === 'character'
          && /不露脸|正脸不呈现|不直接露脸|不出现正脸|脸部.*不可见/u.test(String(request.prompt || '')),
      })
    } catch (error) {
      vision = {
        passed: false,
        reason: `视觉检查无法读取已生成图片：${error instanceof Error ? error.message : '未知错误'}`,
      }
    }
    const identityChecked = request.nodeType === 'character'
      && ['character-turnaround', 'character-face-closeup'].includes(image.view_set_type)
    await db.execute(
      `UPDATE asset_node_images
       SET vision_status = ?, vision_reason = ?, vision_checked_at = NOW(),
           identity_status = ?, identity_reason = ?,
           identity_similarity_score = ?, wardrobe_consistency_score = ?
       WHERE id = ?`,
      [
        vision.pending ? 'pending' : vision.passed ? 'passed' : 'failed',
        vision.reason || null,
        identityChecked ? (vision.pending ? 'pending' : vision.passed ? 'passed' : 'failed') : 'not_checked',
        identityChecked ? vision.reason || null : null,
        identityChecked ? vision.identitySimilarityScore : null,
        identityChecked ? vision.wardrobeConsistencyScore : null,
        insertedId,
      ],
    )
  }
  // Vision approval only makes a generated image eligible for user adoption.
  // Do not supersede or confirm an older image here: retries must remain
  // reversible until the user explicitly clicks the adoption action.
  const [generatedRows] = await db.execute(
    `SELECT id, view_set_type, view_key, vision_status
     FROM asset_node_images WHERE id IN (${insertedIds.map(() => '?').join(', ')})`,
    insertedIds,
  )
  for (const generated of generatedRows) {
    if (generated.vision_status === 'failed') {
      await db.execute(
        `UPDATE asset_node_images SET status = 'failed' WHERE id = ? AND status = 'candidate'`,
        [generated.id],
      )
    }
  }
  if (request.nodeType === 'character' && request.assetPackEnabled) {
    await autoAdoptAssetPack(request.assetNodeId, insertedIds)
  } else if (['prop', 'material'].includes(String(request.nodeType || ''))
    && request.viewType === 'single') {
    for (const insertedId of insertedIds) await autoAdoptSingleAsset(insertedId)
  }
  if (isSceneVisionCheckEnabled()
    && request.viewType === 'scene-nine-grid'
    && generatedRows.some((generated) => generated.vision_status === 'failed')) {
    const failedCount = generatedRows.filter((generated) => generated.vision_status === 'failed').length
    throw new Error(`场景九宫格视觉检查未通过：${failedCount} 个视角不符合当前全景母图，请重试失败视角`)
  }
  const placeholders = insertedIds.map(() => '?').join(', ')
  const [rows] = await db.execute(
    `SELECT * FROM asset_node_images WHERE id IN (${placeholders}) ORDER BY id ASC`,
    insertedIds,
  )
  return { items: rows.map(assetNodeImageDto) }
}

const CHARACTER_PACK_LEGACY_TYPES = "'single', 'character-asset-pack', 'character-face-closeup', 'character-turnaround'"

async function commitAssetAdoption({ candidateIds, nodeType, assetNodeId, viewType }) {
  const ids = [...new Set((Array.isArray(candidateIds) ? candidateIds : [candidateIds])
    .map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))]
  if (!ids.length) return false
  const connection = await db.getConnection()
  let adopted = false
  try {
    await connection.beginTransaction()
    const [candidateRows] = await connection.execute(
      `SELECT * FROM asset_node_images WHERE asset_node_id = ? AND id IN (${ids.map(() => '?').join(', ')}) FOR UPDATE`,
      [Number(assetNodeId), ...ids],
    )
    if (nodeType === 'character') {
      const legacyBoardIds = candidateRows
        .filter((row) => isCharacterAssetPackRow(row)
          && String(row.view_set_type || '') === 'single')
        .map((row) => Number(row.id))
        .filter((id) => Number.isSafeInteger(id) && id > 0)
      if (legacyBoardIds.length) {
        await connection.execute(
          `UPDATE asset_node_images
           SET view_set_type = 'character-asset-pack', view_key = NULL,
               view_index = NULL, view_label = '角色资产板'
           WHERE id IN (${legacyBoardIds.map(() => '?').join(', ')})`,
          legacyBoardIds,
        )
        for (const row of candidateRows) {
          if (legacyBoardIds.includes(Number(row.id))) {
            row.view_set_type = 'character-asset-pack'
            row.view_key = null
            row.view_index = null
            row.view_label = '角色资产板'
          }
        }
      }
    }
    const [existingRows] = await connection.execute(
      nodeType === 'character'
        ? `SELECT * FROM asset_node_images WHERE asset_node_id = ? AND view_set_type IN (${CHARACTER_PACK_LEGACY_TYPES}) FOR UPDATE`
        : `SELECT * FROM asset_node_images WHERE asset_node_id = ? AND view_set_type = ? FOR UPDATE`,
      nodeType === 'character' ? [Number(assetNodeId)] : [Number(assetNodeId), viewType],
    )
    let plan
    if (nodeType === 'character') {
      plan = planAssetPackAdoption(candidateRows, existingRows)
    } else {
      const candidate = candidateRows.find((row) => Number(row.id) === ids[0])
      plan = planSingleAssetAdoption(candidate, existingRows)
    }
    if (!plan.ready) {
      await connection.rollback()
      return false
    }
    const replaceIds = plan.replaceIds
    if (replaceIds.length) {
      await connection.execute(
        `UPDATE asset_node_images SET status = 'superseded' WHERE id IN (${replaceIds.map(() => '?').join(', ')}) AND status IN ('candidate', 'confirmed')`,
        replaceIds,
      )
    }
    const adoptIds = plan.adoptIds || [plan.adoptId]
    await connection.execute(
      `UPDATE asset_node_images SET status = 'confirmed', confirmed_at = NOW() WHERE id IN (${adoptIds.map(() => '?').join(', ')})`,
      adoptIds,
    )
    await connection.commit()
    adopted = true
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
  return adopted
}

async function autoAdoptAssetPack(assetNodeId, candidateIds) {
  return commitAssetAdoption({ candidateIds, nodeType: 'character', assetNodeId })
}

async function autoAdoptSingleAsset(imageId) {
  const [rows] = await db.execute(
    'SELECT asset_node_id, view_set_type FROM asset_node_images WHERE id = ? LIMIT 1',
    [Number(imageId)],
  )
  const row = rows[0]
  if (!row || row.view_set_type !== 'single') return false
  const [nodeRows] = await db.execute('SELECT node_type FROM asset_nodes WHERE id = ? LIMIT 1', [row.asset_node_id])
  const nodeType = String(nodeRows[0]?.node_type || '')
  if (!['prop', 'material'].includes(nodeType)) return false
  return commitAssetAdoption({
    candidateIds: [imageId],
    nodeType,
    assetNodeId: row.asset_node_id,
    viewType: 'single',
  })
}

async function resolveLipSyncAvatarProfile(request, config) {
  const [existingRows] = await db.execute(
    `SELECT * FROM lip_sync_profiles
     WHERE character_id = ? AND provider = ? LIMIT 1`,
    [request.characterId, config.provider],
  )
  if (existingRows[0]) return existingRows[0]

  const created = await createPrivateAvatarGroup({
    name: `project-${request.projectId}-character-${request.characterId}`,
    description: `${request.characterName || 'character'} lip-sync assets`,
    config,
  })
  await db.execute(
    `INSERT INTO lip_sync_profiles (character_id, provider, group_id, status)
     VALUES (?, ?, ?, 'active')
     ON DUPLICATE KEY UPDATE updated_at = NOW()`,
    [request.characterId, config.provider, created.groupId],
  )
  const [rows] = await db.execute(
    `SELECT * FROM lip_sync_profiles
     WHERE character_id = ? AND provider = ? LIMIT 1`,
    [request.characterId, config.provider],
  )
  return rows[0]
}

async function ensureLipSyncAvatarProfile(request, config) {
  const key = `${config.provider}:${request.characterId}`
  if (activeLipSyncProfileRequests.has(key)) return activeLipSyncProfileRequests.get(key)

  const promise = resolveLipSyncAvatarProfile(request, config)
    .finally(() => activeLipSyncProfileRequests.delete(key))
  activeLipSyncProfileRequests.set(key, promise)
  return promise
}

async function ensureLipSyncAvatarAsset(jobId, request, config) {
  const [existingRows] = await db.execute(
    `SELECT * FROM lip_sync_assets
     WHERE image_asset_id = ? AND provider = ? LIMIT 1`,
    [request.imageAssetId, config.provider],
  )
  let asset = existingRows[0]

  if (!asset) {
    const profile = await ensureLipSyncAvatarProfile(request, config)
    const publicImageUrl = await resolveVideoImageInput(request.imageUrl, getVideoConfig())
    const created = await createPrivateAvatarAsset({
      groupId: profile.group_id,
      sourceUrl: publicImageUrl,
      name: `storyboard-${request.storyboardId}-frame-${request.imageAssetId}`,
      description: `${request.characterName || 'character'} dialogue lip-sync source`,
      config,
    })
    await db.execute(
      `INSERT INTO lip_sync_assets
        (character_id, image_asset_id, provider, group_id, asset_id, asset_url, source_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE updated_at = NOW()`,
      [
        request.characterId,
        request.imageAssetId,
        config.provider,
        profile.group_id,
        created.assetId,
        created.assetUrl,
        publicImageUrl,
        created.status,
      ],
    )
    const [rows] = await db.execute(
      `SELECT * FROM lip_sync_assets
       WHERE image_asset_id = ? AND provider = ? LIMIT 1`,
      [request.imageAssetId, config.provider],
    )
    asset = rows[0]
  }

  if (asset.status !== 'active') {
    try {
      const active = await waitForPrivateAvatarAsset(asset.asset_id, {
        config,
        onProgress: () => {
          void updateGenerationJob(jobId, { progress_percent: 25 })
        },
      })
      await db.execute(
        `UPDATE lip_sync_assets
         SET asset_url = ?, status = 'active', error_text = NULL, updated_at = NOW()
         WHERE id = ?`,
        [active.assetUrl, asset.id],
      )
      asset.asset_url = active.assetUrl
      asset.status = 'active'
    } catch (error) {
      await db.execute(
        `UPDATE lip_sync_assets SET status = 'failed', error_text = ?, updated_at = NOW()
         WHERE id = ?`,
        [sanitizeProviderError(error), asset.id],
      )
      throw error
    }
  }
  return asset
}

async function processLipSyncGenerationJob(jobId, request) {
  const config = getLipSyncConfig()
  let providerTaskId = String(request.providerTaskId || '').trim()
  let generated
  if (config.provider === 'latentsync') {
    if (!/^https?:\/\//i.test(String(request.sourceVideoUrl || '').trim())) {
      throw new Error('LatentSync 需要先生成一条可访问的原始视频，再进行口型同步')
    }
    if (!/^https?:\/\//i.test(String(request.audioUrl || '').trim())) {
      throw new Error('LatentSync 需要一条可访问的对白音频')
    }
    await updateGenerationJob(jobId, { progress_percent: 20 })
    if (!providerTaskId) {
      const created = await createLatentSyncTask({
        videoUrl: request.sourceVideoUrl,
        audioUrl: request.audioUrl,
        prompt: request.prompt,
        durationSeconds: request.generationDurationSeconds,
        config,
      })
      providerTaskId = created.taskId
      request.providerTaskId = providerTaskId
      await updateGenerationJob(jobId, {
        progress_percent: 40,
        request_json: JSON.stringify(request),
      })
    }
    generated = await waitForLatentSyncTask(providerTaskId, {
      config,
      onProgress: ({ progress }) => {
        const mapped = 40 + Math.round(Math.max(0, Math.min(100, progress)) * 0.5)
        void updateGenerationJob(jobId, { progress_percent: mapped })
      },
    })
  } else if (config.provider === 'dashscope') {
    await updateGenerationJob(jobId, { progress_percent: 20 })
    if (!providerTaskId) {
      const inputExpiresAt = Date.parse(String(request.providerInputExpiresAt || ''))
      const hasReusableInputs =
        /^(?:oss|https?):\/\//i.test(String(request.providerVideoInputUrl || '')) &&
        /^(?:oss|https?):\/\//i.test(String(request.providerAudioInputUrl || '')) &&
        Number.isFinite(inputExpiresAt) &&
        inputExpiresAt > Date.now() + 300000
      if (!hasReusableInputs) {
        const media = await prepareDashScopeLipSyncMedia(request)
        const [videoUpload, audioUpload] = await Promise.all([
          uploadDashScopeLipSyncFile({
            filePath: media.baseVideoPath,
            fileName: `storyboard-${request.storyboardId}-base.mp4`,
            config,
          }),
          uploadDashScopeLipSyncFile({
            filePath: media.cleanAudioPath,
            fileName: `storyboard-${request.storyboardId}-dialogue.wav`,
            config,
          }),
        ])
        request.providerVideoInputUrl = videoUpload.url
        request.providerAudioInputUrl = audioUpload.url
        request.providerInputExpiresAt = new Date(Date.now() + 47 * 60 * 60 * 1000).toISOString()
        request.generationDurationSeconds = media.durationSeconds
        await updateGenerationJob(jobId, {
          progress_percent: 32,
          request_json: JSON.stringify(request),
        })
      }
      const created = await createDashScopeLipSyncTask({
        videoUrl: request.providerVideoInputUrl,
        audioUrl: request.providerAudioInputUrl,
        extendVideo: true,
        config,
      })
      providerTaskId = created.taskId
      request.providerTaskId = providerTaskId
      await updateGenerationJob(jobId, {
        progress_percent: 40,
        request_json: JSON.stringify(request),
      })
    }
    generated = await waitForDashScopeLipSyncTask(providerTaskId, {
      config,
      onProgress: ({ progress }) => {
        const mapped = 40 + Math.round(Math.max(0, Math.min(100, progress)) * 0.5)
        void updateGenerationJob(jobId, { progress_percent: mapped })
      },
    })
  } else {
    const asset = await ensureLipSyncAvatarAsset(jobId, request, config)
    await updateGenerationJob(jobId, { progress_percent: 35 })
    if (!providerTaskId) {
      const audioInput = await buildLipSyncAudioDataUrl(request.audioAssetId, request.audioUrl)
      const created = await createLipSyncVideoTask({
        assetUrl: asset.asset_url,
        audioInput,
        prompt: request.prompt,
        durationSeconds: request.generationDurationSeconds,
        clientBusinessId: `project${request.projectId}-lipsync-${request.storyboardId}-${jobId}`,
        config,
      })
      providerTaskId = created.taskId
      request.providerTaskId = providerTaskId
      await updateGenerationJob(jobId, {
        progress_percent: 40,
        request_json: JSON.stringify(request),
      })
    }
    generated = await waitForLipSyncVideoTask(providerTaskId, {
      config,
      onProgress: ({ progress }) => {
        const mapped = 40 + Math.round(Math.max(0, Math.min(100, progress)) * 0.5)
        void updateGenerationJob(jobId, { progress_percent: mapped })
      },
    })
  }
  await updateGenerationJob(jobId, { progress_percent: 92 })

  const persisted = await persistSilentLipSyncVideo({
    projectId: request.projectId,
    storyboardId: request.storyboardId,
    versionNo: request.versionNo,
    sourceUrl: generated.videoUrl,
  })
  const status = request.autoConfirm === false ? 'candidate' : 'confirmed'
  const conn = await db.getConnection()
  let videoId
  try {
    await conn.beginTransaction()
    if (status === 'confirmed') {
      await conn.execute(
        `UPDATE video_assets
         SET status = 'archived', confirmed_at = NULL
         WHERE storyboard_id = ? AND status = 'confirmed'`,
        [request.storyboardId],
      )
    }
    const [insertResult] = await conn.execute(
      `INSERT INTO video_assets
        (storyboard_id, image_asset_id, version_no, video_url, storage_key, thumbnail_url,
         motion_mode, duration_seconds, model_name, audio_asset_id, generation_job_id,
         source_type, status, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'LIP_SYNC', ?, ?, ?, ?, 'lip_sync', ?, ${status === 'confirmed' ? 'NOW()' : 'NULL'})`,
      [
        request.storyboardId,
        request.imageAssetId,
        request.versionNo,
        persisted.videoUrl,
        persisted.storageKey,
        request.sourceVideoThumbnailUrl || request.imageUrl,
        request.generationDurationSeconds,
        config.model,
        request.audioAssetId,
        jobId,
        status,
      ],
    )
    videoId = Number(insertResult.insertId)
    if (status === 'confirmed') {
      await conn.execute(
        `UPDATE storyboards SET video_url = ?, updated_at = NOW() WHERE id = ?`,
        [persisted.videoUrl, request.storyboardId],
      )
    }
    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }

  const [rows] = await db.execute(`SELECT * FROM video_assets WHERE id = ? LIMIT 1`, [videoId])
  return {
    item: videoAssetRow(rows[0]),
    providerTaskId,
    providerVideoUrl: generated.videoUrl,
    localVideoUrl: persisted.videoUrl,
  }
}

async function processGenerationJob(jobId) {
  // 任务执行的统一入口。
  // 先用 UPDATE 抢占 queued 任务，避免同一个 job 被重复执行；
  // 再根据 job_type 分派到静帧、角色图、视频或口型同步处理器。
  const [claimResult] = await db.execute(
    `UPDATE generation_jobs
     SET status = 'running', progress_percent = 10, error_text = NULL, updated_at = NOW()
     WHERE id = ? AND status = 'queued'`,
    [jobId],
  )
  if (!claimResult.affectedRows) return

  const row = await fetchGenerationJob(jobId)
  const request = safeJsonParse(row?.request_json, {})
  try {
    let result
    if (row.job_type === 'frame_image') {
      result = await processFrameGenerationJob(jobId, request)
    } else if (row.job_type === 'character_image') {
      result = await processCharacterImageGenerationJob(jobId, request)
    } else if (row.job_type === 'asset_node_image') {
      result = await processAssetNodeImageGenerationJob(jobId, request)
    } else if (row.job_type === 'video_image') {
      result = await processVideoGenerationJob(jobId, request)
    } else if (row.job_type === 'subtitle_cleanup') {
      result = await processSubtitleCleanupJob(jobId, request)
    } else if (row.job_type === 'lip_sync') {
      result = await processLipSyncGenerationJob(jobId, request)
    } else {
      throw new Error(`Unsupported generation job type: ${row.job_type}`)
    }
    if (row.job_type === 'video_image') {
      const qualityReport = inspectGeneratedVideoResult({
        items: result?.items || [],
        expectedCandidateCount: request.candidateCount,
      })
      result = { ...result, qualityReport }
      if (!qualityReport.passed) {
        throw new Error(qualityReport.summary)
      }
    }
    await updateGenerationJob(jobId, {
      status: 'success',
      progress_percent: 100,
      result_json: JSON.stringify(result),
      error_text: null,
    })
  } catch (error) {
    const failedRequest = safeJsonParse(row?.request_json, request)
    const stage = request?.videoGenerationStage || failedRequest?.videoGenerationStage
    const errorText = `${stage ? `阶段：${stage}；` : ''}${sanitizeProviderError(error)}`
    console.error(`[generation-job:${jobId}] failed`, errorText)
    await updateGenerationJob(jobId, {
      status: 'failed',
      progress_percent: 100,
      error_text: errorText,
    })
  }
}

async function recoverGenerationJobs() {
  // 服务重启后，之前卡在 running 的任务会重新放回 queued。
  // 这是“进程级任务恢复”，不是完整消息队列，但能避免重启后任务永久丢失。
  await db.execute(
    `UPDATE generation_jobs SET status = 'queued', progress_percent = 0, updated_at = NOW()
     WHERE status = 'running'`,
  )
  await resumeQueuedGenerationJobs()
}

async function resumeQueuedGenerationJobs() {
  // 启动时扫描数据库里的 queued 任务并恢复执行。
  const [rows] = await db.execute(
    `SELECT id FROM generation_jobs WHERE status = 'queued' ORDER BY id ASC`,
  )
  for (const row of rows) queueGenerationJob(Number(row.id))
}

async function repairVideoRetryReferences(job, request) {
  if (job?.job_type !== 'video_image') return request

  const existingKeys = Array.isArray(request.referenceImageStorageKeys)
    ? request.referenceImageStorageKeys.filter(Boolean)
    : []
  const existingImages = Array.isArray(request.referenceImages)
    ? request.referenceImages.filter(Boolean)
    : []
  if (existingKeys.length >= 2 && existingImages.length >= 2) return request

  const [shotRows] = await db.execute(
    `SELECT s.asset_reference_json
     FROM storyboards s
     INNER JOIN script_scenes sc ON sc.id = s.scene_id
     WHERE s.id = ? AND sc.project_id = ? LIMIT 1`,
    [Number(job.source_id), Number(job.project_id)],
  )
  const reference = parseJsonObject(shotRows[0]?.asset_reference_json)
  const nodeIds = [Number(reference.characterId), Number(reference.sceneAssetId)].filter(Boolean)
  if (!nodeIds.length) return request

  const placeholders = nodeIds.map(() => '?').join(', ')
  const [assetRows] = await db.execute(
    `SELECT ai.id, ai.storage_key, ai.image_url, ai.thumbnail_url,
            ai.view_key, ai.view_set_type, ai.status, ai.vision_status,
            an.node_type
     FROM asset_node_images ai
     INNER JOIN asset_nodes an ON an.id = ai.asset_node_id
     WHERE ai.asset_node_id IN (${placeholders})
       AND ai.status = 'confirmed'
       AND ((an.node_type = 'character' AND ai.view_set_type = 'character-asset-pack')
         OR (an.node_type IN ('prop', 'tool', 'material') AND ai.view_set_type = 'single' AND ai.view_key IS NULL)
         OR an.node_type = 'scene')
       AND (ai.vision_status = 'passed' OR ai.vision_status IS NULL
            OR (an.node_type = 'scene' AND ai.vision_status = 'skipped'))
     ORDER BY ai.id ASC`,
    nodeIds,
  )
  const characterRows = assetRows
    .filter((row) => row.node_type === 'character' && ['front', 'side', 'back'].includes(String(row.view_key || '')))
    .sort((left, right) => ({ front: 0, side: 1, back: 2 }[left.view_key] ?? 9) - ({ front: 0, side: 1, back: 2 }[right.view_key] ?? 9))
  const characterBaseRows = assetRows.filter((row) =>
    row.node_type === 'character'
      && ['single', 'character-asset-pack'].includes(String(row.view_set_type || ''))
      && !String(row.view_key || '').trim(),
  )
  const characterFaceRows = assetRows.filter((row) =>
    row.node_type === 'character' && row.view_set_type === 'character-face-closeup' && String(row.view_key || '') === 'face',
  )
  const characterAssetPackRows = assetRows.filter((row) =>
    row.node_type === 'character' && row.view_set_type === 'character-asset-pack',
  )
  const scenePanoramaRows = assetRows.filter(
    (row) => row.node_type === 'scene' && !String(row.view_key || '').trim() && row.view_set_type === 'single',
  )
  const sceneAngleRows = assetRows.filter(
    (row) => row.node_type === 'scene' && String(row.view_key || '') === String(reference.sceneViewKey || ''),
  )
  const selected = [...characterBaseRows, ...characterRows, ...characterFaceRows, ...characterAssetPackRows, ...scenePanoramaRows, ...sceneAngleRows]
    .filter((row, index, rows) => rows.findIndex((item) => item.storage_key && item.storage_key === row.storage_key) === index)
    .filter((row) => row.storage_key || row.image_url || row.thumbnail_url)
    .slice(0, 6)
  if (selected.length < 2) return request

  return {
    ...request,
    referenceImages: selected.map((row) => row.image_url || row.thumbnail_url).filter(Boolean),
    referenceImageStorageKeys: selected.map((row) => row.storage_key).filter(Boolean),
    providerReferenceImages: [],
  }
}

async function enqueueFrameImageJob(userId, shotId, body = {}) {
  // 创建静帧任务前先做权限和角色一致性校验。
  // 注意这里先不调用图片模型，只把完整请求快照写进 generation_jobs。
  const [shotRows] = await db.execute(
    `SELECT s.*, sc.project_id, p.visual_style AS project_visual_style,
            p.user_id AS ownerId
     FROM storyboards s
     INNER JOIN script_scenes sc ON sc.id = s.scene_id
     INNER JOIN projects p ON p.id = sc.project_id
     WHERE s.id = ? LIMIT 1`,
    [shotId],
  )
  const shot = shotRows[0]
  if (!shot || shot.ownerId !== userId) return null
  const assetReferenceGate = inspectStoryboardAssetReferenceGate({
    storyboard: shot,
    requireCharacter: Boolean(shot.character_id || shot.character_name),
  })
  if (!assetReferenceGate.passed) {
    const error = new Error(assetReferenceGate.summary)
    error.statusCode = 409
    error.qualityReport = assetReferenceGate
    throw error
  }

  const [characterRows] = await db.execute(
    `SELECT id, name, role_tag, personality, appearance, age_group, gender,
            reference_image_url, reference_image_storage_key, status
     FROM characters
     WHERE project_id = ? AND status <> 'archived'
     ORDER BY id ASC`,
    [shot.project_id],
  )
  const frameCharacterContext = resolveFrameCharacterContext(shot, characterRows)
  if (!frameCharacterContext.ready) {
    const error = new Error(frameCharacterContext.blockers[0] || '分镜角色信息不完整，无法保证画面一致性')
    error.statusCode = 409
    throw error
  }

  const frameRole = normalizeFrameRole(body.frameRole)
  const promptOverride = body.prompt ? String(body.prompt).trim() : ''
  const negativePrompt = body.negativePrompt ? String(body.negativePrompt).trim() : ''
  const consistencyPrompt = buildFrameConsistencyPrompt({
    prompt: promptOverride || frameRolePromptFallback(shot, frameRole),
    negativePrompt,
    storyboard: shot,
    context: frameCharacterContext,
    projectVisualStyle: shot.project_visual_style,
  })
  const frameConfig = getFrameConfig()
  const modelName = String(body.modelName || frameConfig.defaultModel).trim()
  assertFrameReferenceImageSupport({
    config: frameConfig,
    modelName,
    referenceImageUrls: consistencyPrompt.referenceImageUrls,
    referenceImageStorageKeys: consistencyPrompt.referenceImageStorageKeys,
  })
  const [versionRows] = await db.execute(
    `SELECT COALESCE(MAX(version_no), 0) AS maxVersion FROM image_assets WHERE storyboard_id = ?`,
    [shotId],
  )
  return createGenerationJob({
    projectId: Number(shot.project_id),
    jobType: 'frame_image',
    sourceId: shotId,
    request: {
      shotId,
      versionNo: Number(versionRows[0]?.maxVersion || 0) + 1,
      frameRole,
      candidateCount: Math.max(1, Math.min(3, parseId(body.candidateCount) || 1)),
      modelName,
      promptSnapshot: consistencyPrompt.prompt,
      negativePrompt: consistencyPrompt.negativePrompt,
      characterSnapshot: createFrameCharacterSnapshot(frameCharacterContext),
      referenceImageUrls: consistencyPrompt.referenceImageUrls,
      referenceImageStorageKeys: consistencyPrompt.referenceImageStorageKeys,
    },
  })
}

async function enqueueStoryboardVideoJob(userId, storyboardId, body = {}) {
  // 当前生产链路采用「脚本直出视频」：
  // 分镜 Agent 先写好景别、机位、构图、动作、对白和画面提示词，
  // 视频模型直接读取脚本与资产引用生成，不再把镜头静帧作为硬前置。
  const [shotRows] = await db.execute(
      `SELECT s.*, sc.project_id, p.user_id AS ownerId, p.aspect_ratio
     FROM storyboards s
     INNER JOIN script_scenes sc ON sc.id = s.scene_id
     INNER JOIN projects p ON p.id = sc.project_id
     WHERE s.id = ? LIMIT 1`,
    [storyboardId],
  )
  const shot = shotRows[0]
  if (!shot || shot.ownerId !== userId) return null
  const workflowGates = await getProjectWorkflowReadiness(Number(shot.project_id))
  if (!workflowGates.storyboard.allowed) {
    const error = new Error(workflowGates.storyboard.reason)
    error.statusCode = 409
    error.qualityReport = { passed: false, blockers: [{ code: workflowGates.storyboard.code, message: error.message }] }
    throw error
  }
  let promptOverride = sanitizeStoryboardPrompt(body.prompt || shot.visual_prompt, {
    characterNames: [shot.character_name],
  })

  const reference = parseJsonObject(
    shot.asset_reference_json || shot.assetReference || shot.asset_reference,
  )
  const directionContract = validateStoryboardDirectionContract({
    ...shot,
    ...(reference.performance || {}),
    gazePlan: reference.gazePlan || reference.performance?.gazePlan || shot.gaze_plan,
    soundPlan: reference.soundPlan || reference.performance?.soundPlan || shot.sound_plan,
  })
  if (!directionContract.passed) {
    const error = new Error(`本镜头视线/声音执行计划未通过校验：${directionContract.blockers.join('；')}`)
    error.statusCode = 409
    error.qualityReport = {
      passed: false,
      blockers: directionContract.blockers.map((message) => ({
        code: 'storyboard-direction-contract-incomplete',
        message,
      })),
      summary: '本镜头视线/声音执行计划未就绪',
    }
    throw error
  }
  const continuityEnabled = shouldUseStoryboardContinuity({
    tools: body.mentionTools || reference.tools,
    prompt: [promptOverride, shot.visual_prompt, shot.start_visual_prompt].filter(Boolean).join('\n'),
    assetReference: reference,
  })
  const requestedContinuitySource = continuityEnabled
    ? resolveContinuitySourceShotNo({
        prompt: [promptOverride, shot.visual_prompt, shot.start_visual_prompt].filter(Boolean).join('\n'),
        assetReference: reference,
      })
    : null
  const [previousShotRows] = await db.execute(
    `SELECT s.id, s.shot_no, s.end_image_url, s.sort_order,
            va.end_frame_url, va.end_frame_storage_key
     FROM storyboards s
     LEFT JOIN video_assets va
       ON va.id = (
         SELECT candidate.id FROM video_assets candidate
         WHERE candidate.storyboard_id = s.id AND candidate.status = 'confirmed'
         ORDER BY candidate.confirmed_at DESC, candidate.id DESC LIMIT 1
       )
     WHERE s.scene_id = ?
       AND ((? <> '' AND s.shot_no = ?) OR (? = '' AND s.sort_order < ?))
     ORDER BY s.sort_order DESC, s.id DESC
     LIMIT 1`,
    [
      Number(shot.scene_id),
      requestedContinuitySource || '', requestedContinuitySource || '',
      requestedContinuitySource || '', Number(shot.sort_order || 0),
    ],
  )
  const previousShot = previousShotRows[0] || null
  if (previousShot?.end_frame_storage_key) {
    previousShot.end_frame_url = resolveObjectStorageUrl(
      previousShot.end_frame_storage_key,
      previousShot.end_frame_url,
    )
  }
  const [currentEndRows] = await db.execute(
    `SELECT image_url, storage_key
     FROM image_assets
     WHERE storyboard_id = ? AND frame_role = 'end' AND status = 'confirmed'
     ORDER BY confirmed_at DESC, id DESC LIMIT 1`,
    [storyboardId],
  )
  const frameReference = buildStoryboardFrameReference({
    continuityEnabled,
    previousShot,
    previousVideo: previousShot,
    currentShot: shot,
    currentEndFrame: currentEndRows[0] || null,
  })
  if (continuityEnabled && (!previousShot || frameReference.missingStartFrame)) {
    const error = new Error('当前镜头已选择片段衔接，但上一镜没有可读取的确认尾帧，请先确认上一镜视频或结束帧')
    error.statusCode = 409
    error.qualityReport = {
      passed: false,
      blockers: [{ code: 'missing-previous-end-frame', message: error.message }],
      summary: error.message,
    }
    throw error
  }
  const hasCharacterBinding = Boolean(reference.characterId || shot.character_id || shot.character_name)
  const assetReferenceGate = inspectStoryboardAssetReferenceGate({
    storyboard: shot,
    requireCharacter: hasCharacterBinding,
  })
  if (!assetReferenceGate.passed) {
    const error = new Error(assetReferenceGate.summary)
    error.statusCode = 409
    error.qualityReport = assetReferenceGate
    throw error
  }

  const referencedAssets = Array.isArray(body.referencedAssets) ? body.referencedAssets : []
  if (!Number(reference.sceneAssetId)) {
    const error = new Error('当前分镜没有绑定完整的场景资产版本，请先重新生成分镜并完成资产确认')
    error.statusCode = 409
    throw error
  }
  const mentionContext = normalizeStoryboardMentionContext({
    referencedAssets,
    tools: body.mentionTools,
    voiceBindings: body.voiceBindings,
    prompt: shot.visual_prompt,
  })
  const referencedAssetIds = referencedAssets
    .map((asset) => parseId(asset?.id || asset?.assetId))
    .filter(Boolean)
  let assetRows = []
  if (referencedAssetIds.length) {
    const placeholders = referencedAssetIds.map(() => '?').join(', ')
      const [rows] = await db.execute(
        `SELECT ai.id, an.label, ai.status, ai.storage_key,
                COALESCE(ai.image_url, '') AS image_url,
                ai.thumbnail_url
         FROM asset_node_images ai
         INNER JOIN asset_nodes an ON an.id = ai.asset_node_id
         INNER JOIN projects p ON p.id = an.project_id
         WHERE ai.id IN (${placeholders}) AND p.id = ? AND p.user_id = ?
         ORDER BY ai.id ASC`,
      [...referencedAssetIds, Number(shot.project_id), userId],
    )
    assetRows = rows
  }

  const lockedReferenceRows = []
  const referenceNodeIds = [
    Number(reference.characterId),
    Number(reference.sceneAssetId),
    ...(Array.isArray(reference.propAssetRefs)
      ? reference.propAssetRefs.map((item) => Number(item?.assetNodeId)).filter(Boolean)
      : Array.isArray(reference.propAssetIds) ? reference.propAssetIds.map(Number).filter(Boolean) : []),
  ].filter(Boolean)
  if (referenceNodeIds.length) {
    const placeholders = referenceNodeIds.map(() => '?').join(', ')
    const [rows] = await db.execute(
      `SELECT ai.id, an.id AS asset_node_id, an.ref_id, an.label, an.node_type,
              an.prompt_text AS asset_prompt, an.environment_prompt_text AS environment_prompt,
              ai.status, ai.storage_key, ai.prompt_snapshot AS image_prompt,
              ai.view_set_type, ai.view_key, ai.view_set_version, ai.version_no,
              ai.vision_status, COALESCE(ai.image_url, '') AS image_url, ai.thumbnail_url
       FROM asset_node_images ai
       INNER JOIN asset_nodes an ON an.id = ai.asset_node_id
       INNER JOIN projects p ON p.id = an.project_id
       WHERE an.id IN (${placeholders}) AND p.id = ? AND p.user_id = ?
         AND ai.status = 'confirmed'
         AND ((an.node_type = 'character'
               AND ai.view_set_type IN ('single', 'character-asset-pack', 'character-face-closeup', 'character-turnaround'))
           OR (an.node_type IN ('prop', 'tool', 'material') AND ai.view_set_type = 'single' AND ai.view_key IS NULL)
           OR an.node_type = 'scene')
         AND (ai.vision_status = 'passed' OR ai.vision_status IS NULL
              OR (an.node_type = 'scene' AND ai.vision_status = 'skipped'))
       ORDER BY ai.id ASC`,
      [...referenceNodeIds, Number(shot.project_id), userId],
    )
    lockedReferenceRows.push(...rows)
  }
  const requiredAngleRows = lockedReferenceRows.filter((row) =>
    row.node_type === 'character'
      ? ['front', 'side', 'back'].includes(String(row.view_key || ''))
      : row.node_type === 'scene'
        && Boolean(reference.sceneViewKey)
        && String(row.view_key || '') === String(reference.sceneViewKey || ''),
  ).sort((left, right) => {
    const typeOrder = { character: 0, scene: 1 }
    const viewOrder = { front: 0, side: 1, back: 2 }
    return (typeOrder[left.node_type] ?? 9) - (typeOrder[right.node_type] ?? 9)
      || (viewOrder[left.view_key] ?? 3) - (viewOrder[right.view_key] ?? 3)
      || Number(left.id || 0) - Number(right.id || 0)
  })
  const characterBaseRows = lockedReferenceRows.filter((row) =>
    row.node_type === 'character'
      && ['single', 'character-asset-pack'].includes(String(row.view_set_type || ''))
      && !String(row.view_key || '').trim(),
  )
  const characterFaceRows = lockedReferenceRows.filter((row) =>
    row.node_type === 'character'
      && ((row.view_set_type === 'character-face-closeup' && String(row.view_key || '') === 'face')
        || row.view_set_type === 'character-asset-pack'),
  )
  const characterAssetPackRows = lockedReferenceRows.filter((row) =>
    row.node_type === 'character' && row.view_set_type === 'character-asset-pack',
  )
  const scenePanoramaRows = lockedReferenceRows.filter((row) =>
    row.node_type === 'scene' && !String(row.view_key || '').trim() && row.view_set_type === 'single',
  )
  const propReferenceRows = lockedReferenceRows.filter((row) => ['prop', 'tool', 'material'].includes(String(row.node_type || '')))
  const lockedImageRows = [...characterBaseRows, ...characterFaceRows, ...characterAssetPackRows, ...scenePanoramaRows, ...requiredAngleRows, ...propReferenceRows]
    .filter((row, index, rows) => rows.findIndex((item) => Number(item.id) === Number(row.id)) === index)
  promptOverride = sanitizeStoryboardPrompt(promptOverride, {
    characterNames: [
      shot.character_name,
      ...lockedReferenceRows.filter((row) => row.node_type === 'character').map((row) => row.label),
    ],
  })
  if (promptOverride && promptOverride !== String(shot.visual_prompt || '').trim()) {
    await db.execute(
      `UPDATE storyboards SET visual_prompt = ?, updated_at = NOW() WHERE id = ?`,
      [promptOverride, storyboardId],
    )
    shot.visual_prompt = promptOverride
  }
  const lockedImages = lockedImageRows
    .map((row) => row.image_url || row.thumbnail_url)
    .filter(Boolean)
  const hasCharacterAssetPack = characterAssetPackRows.length > 0
  const minimumLockedImageCount = hasCharacterBinding && !hasCharacterAssetPack ? 6 : 1
  if (lockedImages.length < minimumLockedImageCount) {
    const error = new Error('当前分镜绑定的角色参考图或场景全景基准缺失')
    error.statusCode = 409
    error.qualityReport = {
      passed: false,
      blockers: [{ code: 'locked-asset-images-incomplete', message: error.message }],
      summary: error.message,
    }
    throw error
  }
  assetRows = [...assetRows, ...lockedReferenceRows]
  const autoReferencedAssets = lockedReferenceRows.map((row) => ({
    id: Number(row.id) || null,
    refId: Number(row.ref_id) || null,
    characterId: row.node_type === 'character' ? Number(row.ref_id) || null : null,
    kind: row.node_type === 'character' ? 'character' : row.node_type === 'scene' ? 'scene' : 'prop',
    name: String(row.label || '').trim(),
    imageUrl: row.image_url || row.thumbnail_url || null,
      promptText: row.node_type === 'character'
        ? ''
        : [row.asset_prompt, row.environment_prompt].filter(Boolean).join('；'),
    sceneViewKey: row.view_key || null,
    viewKeys: row.node_type === 'character' ? ['front', 'side', 'back'] : [],
    viewSetVersion: Number(row.view_set_version) || null,
    versionNo: Number(row.version_no) || null,
  }))
  const effectiveReferencedAssets = [...referencedAssets, ...autoReferencedAssets]
    .filter((asset, index, values) => values.findIndex((item) => `${item.kind}:${item.name}:${item.sceneViewKey || ''}` === `${asset.kind}:${asset.name}:${asset.sceneViewKey || ''}`) === index)
  const effectiveMentionContext = normalizeStoryboardMentionContext({
    referencedAssets: effectiveReferencedAssets,
    tools: body.mentionTools || reference.tools,
    voiceBindings: body.voiceBindings,
    prompt: promptOverride || shot.visual_prompt,
  })

  const lockedCharacterRow = lockedReferenceRows.find((row) => row.node_type === 'character')
  const lockedSceneRow = lockedReferenceRows.find((row) => row.node_type === 'scene')
  let characterConstraint = null
  if (Number(lockedCharacterRow?.ref_id)) {
    const [characterRows] = await db.execute(
      `SELECT name, appearance, costume
       FROM characters
       WHERE id = ? AND project_id = ? AND status <> 'archived' LIMIT 1`,
      [Number(lockedCharacterRow.ref_id), Number(shot.project_id)],
    )
    characterConstraint = characterRows[0] || null
  }
  const continuityConstraints = buildVideoContinuityConstraints({
    characterName: characterConstraint?.name || reference.characterName || shot.character_name,
    characterAppearance: characterConstraint?.appearance,
    characterCostume: characterConstraint?.costume,
    isOpeningShot: Number(shot.sort_order) === 1,
    sceneAssetPrompt: [lockedSceneRow?.asset_prompt, lockedSceneRow?.environment_prompt, lockedSceneRow?.image_prompt]
      .filter(Boolean)
      .join('；'),
  })
  const colorContinuityConstraints = buildColorContinuityConstraints({
    visualStyle: shot.project_visual_style,
    scenePrompt: [
      lockedSceneRow?.asset_prompt,
      lockedSceneRow?.environment_prompt,
      lockedSceneRow?.image_prompt,
    ].filter(Boolean).join('；'),
    shotPrompt: [
      shot.visual_prompt,
      shot.composition,
      shot.camera_angle,
    ].filter(Boolean).join('；'),
  })

  const voiceRows = []
  const referencedCharacterIds = [
    shot.character_id,
    ...mentionContext.assets
     .filter((asset) => String(asset?.kind || asset?.type || asset?.nodeType || '').trim() === 'character')
     .map((asset) => parseId(asset?.refId || asset?.characterId))
      .filter(Boolean),
  ].filter(Boolean).filter((id, index, values) => values.indexOf(id) === index)
  if (referencedCharacterIds.length) {
    const placeholders = referencedCharacterIds.map(() => '?').join(', ')
    const [rows] = await db.execute(
      `SELECT id AS character_id, name AS character_name,
              voice_profile_key, reference_audio_url, reference_audio_storage_key, voice_locked
       FROM characters
       WHERE id IN (${placeholders}) AND project_id = ?`,
      [...referencedCharacterIds, Number(shot.project_id)],
    )
    voiceRows.push(...rows)
  }

  const referenceAudioUrls = [...new Set(
    voiceRows
      .filter((row) => row.voice_locked && String(row.reference_audio_url || '').trim())
      .map((row) => resolveReferenceAudioUrl(row))
      .filter((url) => /^https?:\/\//i.test(url)),
  )].slice(0, 3)
  const referenceAudioPrompt = buildReferenceAudioPromptContext(voiceRows, referenceAudioUrls)
  effectiveMentionContext.voices = [
    ...effectiveMentionContext.voices,
    ...voiceRows.map((row) => ({
      characterId: Number(row.character_id) || null,
      characterName: String(row.character_name || '').trim(),
      voiceProfileKey: String(row.voice_profile_key || '').trim() || null,
      voiceLocked: row.voice_locked === 1 || row.voice_locked === true,
      referenceAudioUrl: resolveReferenceAudioUrl(row),
    })),
  ].filter((voice, index, values) => values.findIndex((item) => item.characterName === voice.characterName) === index)

  const videoConfig = getVideoConfig()
  const qualityReport = inspectStoryboardGenerationContext({
    storyboard: shot,
    assets: assetRows,
    characterVoices: voiceRows,
    requireConfirmedAssets: body.allowCandidateAssets !== true,
    requirePublicAssets: videoConfig.provider !== 'wan',
  })
  if (!qualityReport.passed) {
    const error = new Error(qualityReport.summary)
    error.statusCode = 409
    error.qualityReport = qualityReport
    throw error
  }

  const transitionImages = [
    frameReference.startFrameUrl,
    frameReference.endFrameUrl,
  ].filter(Boolean)
  const videoModelName = String(body.modelName || videoConfig.defaultModel).trim()
  assertVideoModelProvider(videoModelName, videoConfig)
  if (
    !/^minimax(?:-|$)/i.test(videoModelName)
    && !['agnes', 'wan'].includes(videoConfig.provider)
  ) {
    const error = new Error('当前视频服务商不支持分镜多资产参考生成，请切换到已支持多参考图的视频模型。')
    error.statusCode = 409
    throw error
  }
  const imageLimit = /^minimax(?:-|$)/i.test(videoModelName)
    ? 9
    : isOfficialAgnesModel(videoModelName)
      ? 5
      : videoConfig.provider === 'agnes' || videoConfig.provider === 'wan' ? 9 : 1
  const requestedDuration = normalizeStoryboardDurationSeconds(
    body.durationSeconds === undefined ? shot.duration_seconds : body.durationSeconds,
  )
  const durationMin = videoConfig.provider === 'wan' ? 2 : 4
  const durationLimit = videoConfig.provider === 'wan'
    ? 30
    : /^minimax(?:-|$)/i.test(videoModelName) ? 15 : 12
  if (requestedDuration < durationMin || requestedDuration > durationLimit) {
    const error = new Error(`${videoModelName} 单镜只支持 ${durationMin}-${durationLimit} 秒，本镜当前为 ${requestedDuration} 秒；请先调整分镜时长再生成。`)
    error.statusCode = 400
    throw error
  }
  const latestUsableImage = (rows) => [...rows]
    .filter((row) => row.image_url || row.thumbnail_url)
    .sort((left, right) => Number(right.version_no || 0) - Number(left.version_no || 0)
      || Number(right.id || 0) - Number(left.id || 0))[0]
  const selectedCharacterRows = hasCharacterBinding
    ? characterAssetPackRows.length
      ? [latestUsableImage(characterAssetPackRows)].filter(Boolean)
      : [
        latestUsableImage(characterBaseRows),
        latestUsableImage(characterFaceRows),
        ...requiredAngleRows,
      ].filter(Boolean)
    : []
  const sceneAngleRows = lockedReferenceRows.filter((row) =>
    row.node_type === 'scene'
      && row.view_set_type === 'scene-nine-grid'
      && String(row.view_key || '') === String(reference.sceneViewKey || ''),
  )
  const selectedSceneRow = latestUsableImage(sceneAngleRows) || latestUsableImage(scenePanoramaRows)
  const requestedPropNames = new Set([
    ...(Array.isArray(reference.propAssetNames) ? reference.propAssetNames : []),
    ...(Array.isArray(reference.propAssetRefs) ? reference.propAssetRefs.map((item) => item?.name) : []),
  ].map((name) => String(name || '').trim()).filter(Boolean))
  const selectedPropRows = [...new Set(propReferenceRows
    .filter((row) => !requestedPropNames.size || requestedPropNames.has(String(row.label || '').trim()))
    .map((row) => Number(row.asset_node_id || row.ref_id || row.id)))]
    .map((nodeId) => latestUsableImage(propReferenceRows.filter((row) =>
      Number(row.asset_node_id || row.ref_id || row.id) === nodeId,
    )))
    .filter(Boolean)
  const selectedAssetRows = [...selectedCharacterRows, selectedSceneRow, ...selectedPropRows]
    .filter(Boolean)
    .filter((row, index, rows) => rows.findIndex((item) => Number(item.id) === Number(row.id)) === index)
  if (!selectedSceneRow || (hasCharacterBinding && !selectedCharacterRows.length)) {
    const error = new Error('本镜缺少已确认的场景视角图或角色资产图，不能提交视频生成。')
    error.statusCode = 409
    throw error
  }
  if (selectedAssetRows.length > imageLimit) {
    const error = new Error(`本镜已确认角色、场景和道具资产共需 ${selectedAssetRows.length} 张参考图，${videoModelName} 最多接收 ${imageLimit} 张；请拆分镜头或减少本镜资产引用。`)
    error.statusCode = 409
    throw error
  }
  const availableSlots = Math.max(0, imageLimit - selectedAssetRows.length)
  const selectedTransitionImages = transitionImages.slice(0, availableSlots)
  const referenceImages = [
    ...selectedAssetRows.map((asset) => asset.image_url || asset.thumbnail_url),
    ...selectedTransitionImages,
  ].filter(Boolean)
  const selectedTransitionStorageKeys = selectedTransitionImages.map((url) =>
    url === frameReference.startFrameUrl ? frameReference.startFrameStorageKey : frameReference.endFrameStorageKey,
  )
  const everyReferenceHasStorageKey = selectedAssetRows.every((asset) => String(asset.storage_key || '').trim())
    && selectedTransitionStorageKeys.every((key) => String(key || '').trim())
  const referenceImageStorageKeys = everyReferenceHasStorageKey
    ? [...selectedAssetRows.map((asset) => asset.storage_key), ...selectedTransitionStorageKeys]
      .map((key) => String(key || '').trim())
    : []
  const referenceSnapshot = buildStoryboardReferenceSnapshot({
    storyboard: shot,
    referenceImages,
    referencedAssets: effectiveReferencedAssets,
  })
  const referenceValidation = validateStoryboardReferenceSnapshot(referenceSnapshot)
  if (!referenceValidation.passed) {
    const error = new Error(`视频资产引用未就绪：${referenceValidation.blockers.join('；')}`)
    error.statusCode = 409
    error.qualityReport = {
      passed: false,
      blockers: referenceValidation.blockers.map((message) => ({
        code: 'storyboard-reference-incomplete',
        message,
      })),
      summary: '视频资产引用未就绪',
    }
    throw error
  }

  const [versionRows] = await db.execute(
    `SELECT COALESCE(MAX(version_no), 0) AS maxVersion
     FROM video_assets WHERE storyboard_id = ?`,
    [storyboardId],
  )

  const motionMode = String(body.motionMode || 'PAN').trim() || 'PAN'
  const requestedStartImageUrl = String(body.startImageUrl || body.startFrameUrl || '').trim()
  const firstFrameUrl = frameReference.startFrameUrl || requestedStartImageUrl || null
  const lastFrameUrl = firstFrameUrl ? frameReference.endFrameUrl || null : null
  const videoReferenceImageGuide = videoConfig.provider === 'wan'
    ? firstFrameUrl
      ? '首帧锁定：以本次提交的首帧作为唯一画面起点，严格延续首帧中的角色身份、服装、场景结构、光线方向和构图关系；动作从首帧状态自然开始，不得重新设计角色或跳变空间。'
      : '本镜未提交首帧：严格按文字中的角色身份、固定服装、场景结构和光线方向生成，不得新增未声明人物或道具；下一镜会以本镜尾帧作为严格首帧。'
    : buildVideoReferenceImageGuide(
      selectedAssetRows.map((asset) => ({
        ...asset,
        costume: asset.node_type === 'character' ? characterConstraint?.costume : asset.costume,
      })),
      selectedTransitionImages.length,
    )
  return createGenerationJob({
    projectId: Number(shot.project_id),
    jobType: 'video_image',
    sourceId: storyboardId,
    request: {
      storyboardId,
      imageAssetId: null,
      imageUrl: null,
      firstFrameUrl,
      lastFrameUrl,
      versionNo: Number(versionRows[0]?.maxVersion || 0) + 1,
      motionMode,
      durationSeconds: requestedDuration,
      candidateCount: Math.max(1, Math.min(3, parseId(body.candidateCount) || 1)),
      videoInspectionExpected: inferVideoCandidateExpectations({
        durationSeconds: body.durationSeconds === undefined ? shot.duration_seconds : body.durationSeconds,
        actionText: [promptOverride, shot.action_text, shot.acting_beat].filter(Boolean).join('\n'),
        actingBeat: shot.acting_beat,
        dialogueText: shot.dialogue_text,
        audioDirection: [promptOverride, shot.audio_direction].filter(Boolean).join('\n'),
        gazePlan: directionContract.gaze,
        soundPlan: directionContract.sound,
      }),
      modelName: videoModelName,
      videoProvider: videoConfig.provider,
      generationMode: 'multi_reference',
      referencedAssets: effectiveMentionContext.assets.map((asset) => ({
        key: asset?.key || null,
        kind: asset?.kind || null,
        name: asset?.name || null,
        imageUrl: asset?.imageUrl || null,
        promptText: asset?.promptText || null,
        appearance: asset?.appearance || null,
        costume: asset?.costume || null,
        sceneViewKey: asset?.sceneViewKey || null,
        viewKeys: asset?.viewKeys || [],
        versionNo: asset?.versionNo || null,
        viewSetVersion: asset?.viewSetVersion || null,
        voiceProfileKey: asset?.voiceProfileKey || null,
        voiceLocked: asset?.voiceLocked === true,
        referenceAudioUrl: asset?.referenceAudioUrl || null,
      })),
      referenceImages,
      referenceImageStorageKeys,
      referenceAudioUrls,
      frameReferences: {
        continuityEnabled,
        sourceStoryboardId: frameReference.sourceStoryboardId,
        sourceShotNo: frameReference.sourceShotNo,
        startFrameUrl: frameReference.startFrameUrl,
        startFrameStorageKey: frameReference.startFrameStorageKey,
        endFrameUrl: frameReference.endFrameUrl,
        endFrameStorageKey: frameReference.endFrameStorageKey,
      },
      imageRatio: String(body.imageRatio || body.aspectRatio || shot.aspect_ratio || '9:16').trim(),
      storyboardAssetReference: referenceSnapshot,
      promptSnapshot: buildTwoKeyframeVideoPrompt({
        prompt: buildStoryboardVideoPromptParts({
          prompt: promptOverride,
          contextParts: [
            videoReferenceImageGuide,
            buildStoryboardDirectionPrompt({
              gazePlan: directionContract.gaze,
              soundPlan: directionContract.sound,
            }),
            buildStoryboardContinuityPrompt(frameReference),
            continuityConstraints,
            buildPromptTemplateContext('video'),
            colorContinuityConstraints,
            buildReferencedAssetPromptContext(effectiveMentionContext.assets),
            referenceAudioPrompt,
            buildMentionContextPrompt(effectiveMentionContext),
          ],
          legacyFieldParts: [
            `景别：${shot.shot_type || '由视频模型根据镜头脚本判断'}`,
            `机位：${shot.camera_angle || '由视频模型根据镜头脚本判断'}`,
            `构图：${shot.composition || '由视频模型根据镜头脚本判断'}`,
            `角色情绪与变化：${shot.emotional_change || ''}`,
            `表演节拍：${shot.acting_beat || ''}`,
            `结构化表演与音画同步：\n${buildStoryboardPerformancePrompt(reference.performance || shot)}`,
            `声音与口型同步：${shot.audio_direction || ''}；对白必须逐字对应口型，按自然语速完成，不得提前、延后或用无声口型替代。`,
            `镜头动作：${shot.action_text || ''}`,
            `对白与声音：${shot.dialogue_text || ''}`,
          ],
        }).join('\n'),
        shot,
        startImage: firstFrameUrl ? { image_url: firstFrameUrl } : null,
        endImage: lastFrameUrl ? { image_url: lastFrameUrl } : null,
      }),
      providerTasks: [],
      autoConfirm: false,
    },
  })
}

async function buildFramePromptRewriteContext(userId, storyboardId) {
  const [shotRows] = await db.execute(
    `SELECT s.*, sc.project_id, sc.outline_id, sc.scene_no, sc.title AS scene_title,
            sc.summary AS scene_summary, sc.content AS scene_content, sc.mood AS scene_mood,
            sc.location, sc.time_of_day, sc.estimated_duration AS scene_estimated_duration,
            p.user_id AS ownerId, p.name AS project_name, p.category AS project_category,
            p.visual_style AS project_visual_style, p.narrative_vision AS project_narrative_vision,
            so.title AS outline_title, so.summary AS outline_summary, so.premise AS outline_premise,
            so.content AS outline_content
     FROM storyboards s
     INNER JOIN script_scenes sc ON sc.id = s.scene_id
     INNER JOIN projects p ON p.id = sc.project_id
     LEFT JOIN story_outlines so ON so.id = sc.outline_id
     WHERE s.id = ? LIMIT 1`,
    [storyboardId],
  )
  const shot = shotRows[0]
  if (!shot || Number(shot.ownerId) !== Number(userId)) return null

  const [characterRows] = await db.execute(
    `SELECT id, name, role_tag, personality, appearance, age_group, gender,
            reference_image_url, status
     FROM characters
     WHERE project_id = ? AND status <> 'archived'
     ORDER BY id ASC`,
    [shot.project_id],
  )

  return {
    project: {
      id: Number(shot.project_id),
      name: shot.project_name,
      category: shot.project_category,
      visualStyle: shot.project_visual_style,
      narrativeVision: shot.project_narrative_vision,
    },
    outline: {
      title: shot.outline_title,
      summary: shot.outline_summary,
      premise: shot.outline_premise,
      content: shot.outline_content,
    },
    scene: {
      id: Number(shot.scene_id),
      scene_no: shot.scene_no,
      title: shot.scene_title,
      summary: shot.scene_summary,
      content: shot.scene_content,
      mood: shot.scene_mood,
      location: shot.location,
      time_of_day: shot.time_of_day,
      estimated_duration: shot.scene_estimated_duration,
    },
    storyboard: shot,
    characters: characterRows,
    frameCharacterContext: resolveFrameCharacterContext(shot, characterRows),
  }
}

async function loadStoryboardDirectorContext(userId, storyboardId) {
  const [shotRows] = await db.execute(
    `SELECT s.*, sc.project_id, sc.outline_id, sc.scene_no, sc.title AS scene_title,
            sc.summary AS scene_summary, sc.content AS scene_content, sc.mood AS scene_mood,
            sc.location, sc.time_of_day, sc.estimated_duration AS scene_estimated_duration,
            p.user_id AS ownerId, p.name AS project_name, p.category AS project_category,
            p.visual_style AS project_visual_style, p.narrative_vision AS project_narrative_vision
     FROM storyboards s
     INNER JOIN script_scenes sc ON sc.id = s.scene_id
     INNER JOIN projects p ON p.id = sc.project_id
     WHERE s.id = ? LIMIT 1`,
    [storyboardId],
  )
  const shot = shotRows[0]
  if (!shot || Number(shot.ownerId) !== Number(userId)) return null

  const [characterRows] = await db.execute(
    `SELECT id, name, role_tag, personality, appearance, age_group, gender,
            reference_image_url, status
     FROM characters
     WHERE project_id = ? AND status <> 'archived'
     ORDER BY id ASC`,
    [shot.project_id],
  )

  return {
    project: {
      id: Number(shot.project_id),
      name: shot.project_name,
      category: shot.project_category,
      visualStyle: shot.project_visual_style,
      narrativeVision: shot.project_narrative_vision,
    },
    scene: {
      id: Number(shot.scene_id),
      sceneNo: shot.scene_no,
      title: shot.scene_title,
      summary: shot.scene_summary,
      content: shot.scene_content,
      mood: shot.scene_mood,
      location: shot.location,
      timeOfDay: shot.time_of_day,
      estimatedDuration: shot.scene_estimated_duration,
    },
    storyboard: shot,
    characters: characterRows,
  }
}

function simpleKeyframePromptFallback(context) {
  const shot = context.storyboard
  const characterText = context.characters
    .map((item) => [item.name, item.role_tag, item.gender, item.age_group, item.appearance].filter(Boolean).join('，'))
    .filter(Boolean)
    .join('\n')
  const base = [
    context.project.visualStyle,
    context.scene.location,
    context.scene.timeOfDay,
    shot.shot_type,
    shot.camera_angle,
    shot.composition,
    shot.visual_prompt,
  ].filter(Boolean).join('，')
  const action = String(shot.action_text || '').trim()
  const shared = [
    base,
    characterText ? `角色外貌锁定：${characterText}` : '',
    '保持同一角色脸型、发型、服装、体型、年龄感和场景光线连续。',
  ].filter(Boolean).join('，')
  return {
    startVisualPrompt: [
      shared,
      action ? `动作开始前：${action}` : '动作开始前：人物处在准备动作的稳定姿态。',
      '起始帧需要清楚交代人物站位、视线方向、道具位置和运动空间。',
    ].filter(Boolean).join('，'),
    endVisualPrompt: [
      shared,
      action ? `动作完成后：${action}` : '动作完成后：人物处在动作结束的稳定姿态。',
      '结束帧需要体现动作结果、表情变化、身体重心变化和场景连续性。',
    ].filter(Boolean).join('，'),
    notes: '已使用本地兜底规则生成，建议确认后再生成起始帧和结束帧。',
  }
}

async function optimizeStoryboardKeyframes(userId, storyboardId) {
  const context = await loadStoryboardDirectorContext(userId, storyboardId)
  if (!context) return null
  let payload = null
  try {
    const result = await generateStructuredJson({
      task: 'storyboard-keyframe-prompts',
      temperature: 0.45,
      systemPrompt: [
        '你是 AI 漫剧导演和分镜提示词设计师。',
        '你的任务是把用户写的动作，改写成起始帧和结束帧两条中文视觉提示词。',
        '必须保持同一角色外貌、服装、年龄感、发型、道具、场景、光线、镜头语言连续。',
        '不要输出英文，不要输出 Markdown，只返回 JSON。',
      ].join('\n'),
      userPrompt: JSON.stringify({
        输出格式: {
          startVisualPrompt: '中文起始帧提示词',
          endVisualPrompt: '中文结束帧提示词',
          notes: '给用户看的简短中文说明',
        },
        项目: context.project,
        场景: context.scene,
        分镜: {
          shotNo: context.storyboard.shot_no,
          shotType: context.storyboard.shot_type,
          cameraAngle: context.storyboard.camera_angle,
          composition: context.storyboard.composition,
          durationSeconds: context.storyboard.duration_seconds,
          actionText: context.storyboard.action_text,
          dialogueText: context.storyboard.dialogue_text,
          visualPrompt: context.storyboard.visual_prompt,
        },
        角色: context.characters,
        要求: [
          '起始帧描述动作开始前一瞬间，写清人物姿态、站位、表情、视线、道具和构图。',
          '结束帧描述动作完成后一瞬间，写清动作结果、重心变化、情绪变化和空间关系。',
          '两帧必须像同一段视频的首尾帧，不能换人、不能换服装、不能换场景。',
          '如果动作过长，不要在这里拆镜头，只把首尾状态写清。',
        ],
      }),
    })
    payload = result.json || {}
  } catch (error) {
    console.warn('[storyboard-keyframes] AI optimize fallback', error?.message || error)
    payload = simpleKeyframePromptFallback(context)
  }

  const fallback = simpleKeyframePromptFallback(context)
  const startVisualPrompt = String(payload.startVisualPrompt || fallback.startVisualPrompt).trim()
  const endVisualPrompt = String(payload.endVisualPrompt || fallback.endVisualPrompt).trim()
  const notes = String(payload.notes || fallback.notes || '').trim()

  await db.execute(
    `UPDATE storyboards
     SET start_visual_prompt = ?, end_visual_prompt = ?, updated_at = NOW()
     WHERE id = ?`,
    [startVisualPrompt, endVisualPrompt, storyboardId],
  )
  const [rows] = await db.execute(`SELECT * FROM storyboards WHERE id = ? LIMIT 1`, [storyboardId])
  return { storyboard: storyboardRow(rows[0]), startVisualPrompt, endVisualPrompt, notes }
}

async function copyPreviousFrameToStoryboard(userId, storyboardId) {
  const context = await loadStoryboardDirectorContext(userId, storyboardId)
  if (!context) return null
  const shot = context.storyboard
  const [previousRows] = await db.execute(
    `SELECT ps.*, ia.id AS image_asset_id, ia.image_url, ia.thumbnail_url, ia.prompt_snapshot,
            ia.negative_prompt, ia.character_snapshot, ia.model_name, ia.frame_role
     FROM storyboards ps
     INNER JOIN image_assets ia ON ia.storyboard_id = ps.id AND ia.status = 'confirmed'
     WHERE ps.scene_id = ? AND ps.sort_order < ?
     ORDER BY ps.sort_order DESC,
       CASE ia.frame_role WHEN 'end' THEN 0 WHEN 'start' THEN 1 ELSE 2 END ASC,
       ia.confirmed_at DESC, ia.id DESC
     LIMIT 1`,
    [shot.scene_id, shot.sort_order],
  )
  const source = previousRows[0]
  if (!source) {
    const error = new Error('上一镜头还没有已确认画面，无法承接')
    error.statusCode = 409
    throw error
  }

  const [versionRows] = await db.execute(
    `SELECT COALESCE(MAX(version_no), 0) AS maxVersion FROM image_assets WHERE storyboard_id = ?`,
    [storyboardId],
  )
  const nextVersion = Number(versionRows[0]?.maxVersion || 0) + 1
  const promptSnapshot = [
    `承接上一镜头 ${source.shot_no || ''} 的${frameRoleLabel(source.frame_role)}作为本镜头起始帧。`,
    source.prompt_snapshot,
  ].filter(Boolean).join(' ')
  const characterSnapshot = typeof source.character_snapshot === 'string'
    ? source.character_snapshot
    : source.character_snapshot
      ? JSON.stringify(source.character_snapshot)
      : null

  const conn = await db.getConnection()
  let insertedId = null
  try {
    await conn.beginTransaction()
    await conn.execute(
      `UPDATE image_assets SET status = 'candidate', confirmed_at = NULL
       WHERE storyboard_id = ? AND frame_role = 'start'`,
      [storyboardId],
    )
    const [insertResult] = await conn.execute(
      `INSERT INTO image_assets
        (storyboard_id, version_no, image_url, thumbnail_url, prompt_snapshot,
         frame_role, negative_prompt, character_snapshot, model_name, status, confirmed_at)
       VALUES (?, ?, ?, ?, ?, 'start', ?, ?, ?, 'confirmed', NOW())`,
      [
        storyboardId,
        nextVersion,
        source.image_url,
        source.thumbnail_url,
        promptSnapshot,
        source.negative_prompt || null,
        characterSnapshot,
        source.model_name || null,
      ],
    )
    insertedId = Number(insertResult.insertId)
    await conn.execute(
      `UPDATE storyboards
       SET image_url = ?, start_visual_prompt = ?, updated_at = NOW()
       WHERE id = ?`,
      [source.image_url, promptSnapshot, storyboardId],
    )
    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }

  const [imageRows] = await db.execute(`SELECT * FROM image_assets WHERE id = ? LIMIT 1`, [insertedId])
  const [shotRows] = await db.execute(`SELECT * FROM storyboards WHERE id = ? LIMIT 1`, [storyboardId])
  return {
    storyboard: storyboardRow(shotRows[0]),
    image: imageAssetRow(imageRows[0]),
    sourceStoryboardId: Number(source.id),
    sourceShotNo: source.shot_no,
  }
}

function fallbackSubShots(context) {
  const shot = context.storyboard
  const action = String(shot.action_text || shot.visual_prompt || '人物完成当前动作').trim()
  const duration = Math.max(2, Number(shot.duration_seconds || 6))
  const halfDuration = Math.max(1, Math.round(duration / 2))
  const basePrompt = String(shot.visual_prompt || action).trim()
  return [
    {
      shotType: shot.shot_type,
      cameraAngle: shot.camera_angle,
      composition: shot.composition,
      durationSeconds: halfDuration,
      actionText: `动作准备：${action}`,
      dialogueText: shot.dialogue_text || '',
      visualPrompt: basePrompt,
      startVisualPrompt: `${basePrompt}，动作开始前的稳定姿态，角色外貌服装保持一致。`,
      endVisualPrompt: `${basePrompt}，动作进行到中段，重心和视线发生变化，角色外貌服装保持一致。`,
    },
    {
      shotType: shot.shot_type,
      cameraAngle: shot.camera_angle,
      composition: shot.composition,
      durationSeconds: Math.max(1, duration - halfDuration),
      actionText: `动作完成：${action}`,
      dialogueText: '',
      visualPrompt: basePrompt,
      startVisualPrompt: `${basePrompt}，承接上一子分镜中段姿态。`,
      endVisualPrompt: `${basePrompt}，动作完成后的稳定姿态，角色外貌服装保持一致。`,
    },
  ]
}

function normalizeSubShots(rawSubShots, context) {
  const fallback = fallbackSubShots(context)
  const items = Array.isArray(rawSubShots) ? rawSubShots : fallback
  return items
    .slice(0, 4)
    .map((item, index) => ({
      shotType: String(item.shotType || context.storyboard.shot_type || '').trim() || null,
      cameraAngle: String(item.cameraAngle || context.storyboard.camera_angle || '').trim() || null,
      composition: String(item.composition || context.storyboard.composition || '').trim() || null,
      durationSeconds: Math.max(1, Math.min(12, parseId(item.durationSeconds) || Math.ceil(Number(context.storyboard.duration_seconds || 4) / 2))),
      actionText: String(item.actionText || fallback[index]?.actionText || context.storyboard.action_text || '').trim(),
      dialogueText: String(item.dialogueText ?? (index === 0 ? context.storyboard.dialogue_text || '' : '')).trim(),
      visualPrompt: String(item.visualPrompt || fallback[index]?.visualPrompt || context.storyboard.visual_prompt || '').trim(),
      startVisualPrompt: String(item.startVisualPrompt || fallback[index]?.startVisualPrompt || '').trim(),
      endVisualPrompt: String(item.endVisualPrompt || fallback[index]?.endVisualPrompt || '').trim(),
      gazePlan: item.gazePlan || item.gaze_plan || context.storyboard.gaze_plan || null,
      soundPlan: item.soundPlan || item.sound_plan || context.storyboard.sound_plan || null,
    }))
    .filter((item) => item.actionText || item.visualPrompt)
}

function buildSubShotDirectionReference(sourceReference, sourceShot, subShot) {
  const reference = parseJsonObject(sourceReference) || {}
  const performance = normalizeStoryboardPerformance({
    ...sourceShot,
    ...subShot,
    gazePlan: subShot.gazePlan || reference.gazePlan || reference.performance?.gazePlan,
    soundPlan: subShot.soundPlan || reference.soundPlan || reference.performance?.soundPlan,
  })
  const direction = validateStoryboardDirectionContract({
    ...sourceShot,
    ...subShot,
    gazePlan: performance.gazePlan,
    soundPlan: performance.soundPlan,
  })
  return {
    ...reference,
    gazePlan: direction.gaze,
    soundPlan: direction.sound,
    performance: {
      ...performance,
      gazePlan: direction.gaze,
      soundPlan: direction.sound,
    },
  }
}

function resolveCharacterForDialogue(context, speakerName) {
  const name = String(speakerName || '').trim()
  if (!name) return null
  return context.characters.find((item) => String(item.name || '').trim() === name) || null
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseDialogueTurns(dialogueText, context) {
  const source = String(dialogueText || '').trim()
  const names = context.characters
    .map((item) => String(item.name || '').trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  const turns = []
  if (!source || !names.length) return turns

  const labelRegex = new RegExp(`【?(${names.map(escapeRegex).join('|')})】?[：:]\\s*`, 'g')
  const labels = Array.from(source.matchAll(labelRegex))
  if (labels.length) {
    for (let index = 0; index < labels.length; index += 1) {
      const label = labels[index]
      const nextLabel = labels[index + 1]
      const character = resolveCharacterForDialogue(context, label[1])
      const text = source
        .slice(Number(label.index) + label[0].length, nextLabel?.index ?? source.length)
        .replace(/^[\s，,。；;]+/, '')
        .trim()
      if (!character || !text) continue
      turns.push({ speakerName: character.name, characterId: Number(character.id), text })
    }
    return turns
  }

  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (const line of lines) {
    const match = line.match(/^【?([^：:]{1,30})】?[：:]\s*(.+)$/)
    if (!match) continue
    const speakerName = match[1].replace(/[（）()【】\s]/g, '').trim()
    const text = match[2].trim()
    const character = resolveCharacterForDialogue(context, speakerName)
    if (!character || !text) continue
    turns.push({ speakerName: character.name, characterId: Number(character.id), text })
  }
  return turns
}

function fallbackDialogueSubShots(context) {
  const shot = context.storyboard
  const turns = parseDialogueTurns(shot.dialogue_text, context)
  const basePrompt = String(shot.visual_prompt || shot.action_text || '').trim()
  return turns.map((turn, index) => ({
    speakerName: turn.speakerName,
    characterId: turn.characterId,
    shotType: shot.shot_type || '中近景',
    cameraAngle: shot.camera_angle || '平视机位',
    composition: shot.composition || '对话构图',
    durationSeconds: Math.max(2, Math.min(6, Math.ceil(Array.from(turn.text).length / 8))),
    actionText: index === 0
      ? `${turn.speakerName}开始说话，其他角色保持反应状态。`
      : `${turn.speakerName}承接上一句对白继续回应。`,
    dialogueText: `${turn.speakerName}：${turn.text}`,
    visualPrompt: [
      basePrompt,
      `${turn.speakerName}作为当前说话主体，镜头重点捕捉其面部、口型、眼神和身体反应。`,
      '同场其他角色可以入画但不张嘴，作为倾听或反应人物。',
    ].filter(Boolean).join('，'),
    startVisualPrompt: [
      basePrompt,
      `${turn.speakerName}说话前的准备姿态，视线和情绪承接上一镜。`,
    ].filter(Boolean).join('，'),
    endVisualPrompt: [
      basePrompt,
      `${turn.speakerName}说完这句对白后的表情停顿，其他角色保持连续反应。`,
    ].filter(Boolean).join('，'),
  }))
}

function normalizeDialogueSubShots(rawSubShots, context) {
  const fallback = fallbackDialogueSubShots(context)
  const items = Array.isArray(rawSubShots) && rawSubShots.length ? rawSubShots : fallback
  return items
    .slice(0, 8)
    .map((item, index) => {
      const character =
        resolveCharacterForDialogue(context, item.speakerName || item.characterName) ||
        context.characters.find((ch) => Number(ch.id) === Number(item.characterId)) ||
        (fallback[index]?.characterId
          ? context.characters.find((ch) => Number(ch.id) === Number(fallback[index].characterId))
          : null)
      return {
        characterId: character ? Number(character.id) : null,
        characterName: character ? String(character.name || '').trim() : '',
        shotType: String(item.shotType || context.storyboard.shot_type || '中近景').trim() || null,
        cameraAngle: String(item.cameraAngle || context.storyboard.camera_angle || '平视机位').trim() || null,
        composition: String(item.composition || context.storyboard.composition || '对话构图').trim() || null,
        durationSeconds: Math.max(1, Math.min(12, parseId(item.durationSeconds) || fallback[index]?.durationSeconds || 4)),
        actionText: String(item.actionText || fallback[index]?.actionText || '').trim(),
        dialogueText: String(item.dialogueText || fallback[index]?.dialogueText || '').trim(),
        visualPrompt: String(item.visualPrompt || fallback[index]?.visualPrompt || context.storyboard.visual_prompt || '').trim(),
        startVisualPrompt: String(item.startVisualPrompt || fallback[index]?.startVisualPrompt || '').trim(),
        endVisualPrompt: String(item.endVisualPrompt || fallback[index]?.endVisualPrompt || '').trim(),
        gazePlan: item.gazePlan || item.gaze_plan || context.storyboard.gaze_plan || null,
        soundPlan: item.soundPlan || item.sound_plan || context.storyboard.sound_plan || null,
      }
    })
    .filter((item) => item.characterId && item.dialogueText)
}

async function assertStoryboardHasNoGeneratedAssets(storyboardId, options = {}) {
  const allowContinuityStartImage = Boolean(options.allowContinuityStartImage)
  const [assetRows] = await db.execute(
    `SELECT
       (SELECT COUNT(*) FROM image_assets WHERE storyboard_id = ?) AS imageCount,
       (SELECT COUNT(*) FROM image_assets
        WHERE storyboard_id = ? AND frame_role = 'start' AND prompt_snapshot LIKE '承接上一镜头%') AS continuityStartImageCount,
       (SELECT COUNT(*) FROM video_assets WHERE storyboard_id = ?) AS videoCount,
       (SELECT COUNT(*) FROM audio_assets WHERE storyboard_id = ?) AS audioCount`,
    [storyboardId, storyboardId, storyboardId, storyboardId],
  )
  const assetInfo = assetRows[0] || {}
  const imageCount = Number(assetInfo.imageCount || 0)
  const continuityStartImageCount = Number(assetInfo.continuityStartImageCount || 0)
  const videoCount = Number(assetInfo.videoCount || 0)
  const audioCount = Number(assetInfo.audioCount || 0)
  const onlyContinuityStartImage =
    allowContinuityStartImage &&
    imageCount > 0 &&
    imageCount === continuityStartImageCount &&
    videoCount === 0 &&
    audioCount === 0
  if ((imageCount || videoCount || audioCount) && !onlyContinuityStartImage) {
    const error = new Error(
      videoCount || audioCount
        ? '当前分镜已经有视频或音频素材，不能再拆分。正确流程是先拆分多人对白/子分镜，再生成静帧、动作视频、对白音频和口型视频。'
        : '当前分镜已经有生成图片素材，不能再拆分。只有“承接上一镜头”的起始帧允许在拆分时保留到第一条子分镜。请先确认流程：拆分 -> 承接/生成静帧 -> 生成视频/音频 -> 口型。'
    )
    error.statusCode = 409
    throw error
  }
}

async function splitStoryboardIntoSubShots(userId, storyboardId) {
  const context = await loadStoryboardDirectorContext(userId, storyboardId)
  if (!context) return null

  await assertStoryboardHasNoGeneratedAssets(storyboardId, { allowContinuityStartImage: true })

  let rawSubShots = null
  try {
    const result = await generateStructuredJson({
      task: 'storyboard-split-subshots',
      temperature: 0.45,
      systemPrompt: [
        '你是 AI 漫剧分镜导演。',
        '请把一个长动作拆成 2 到 4 个更短、更稳定、更省钱的子分镜。',
        '输出必须是中文 JSON，不要 Markdown，不要英文。',
      ].join('\n'),
      userPrompt: JSON.stringify({
        输出格式: {
          subShots: [
            {
              shotType: '景别',
              cameraAngle: '机位',
              composition: '构图',
              durationSeconds: 4,
              actionText: '动作描述',
              dialogueText: '对白，可为空',
              visualPrompt: '视觉提示词',
              startVisualPrompt: '起始帧提示词',
              endVisualPrompt: '结束帧提示词',
            },
          ],
        },
        项目: context.project,
        场景: context.scene,
        分镜: context.storyboard,
        角色: context.characters,
        要求: [
          '每个子分镜只保留一个清晰动作，不要把走路、转身、拿东西、表情变化全塞到同一镜头。',
          '对白优先放在最适合说话的子分镜，不需要每个子分镜都有对白。',
          '子分镜之间必须能顺滑承接，角色外貌、服装、场景和光线连续。',
          '每条 visualPrompt、startVisualPrompt、endVisualPrompt 都要用中文写完整。',
        ],
      }),
    })
    rawSubShots = result.json?.subShots
  } catch (error) {
    console.warn('[storyboard-split] AI fallback', error?.message || error)
  }
  const subShots = normalizeSubShots(rawSubShots, context)
  if (subShots.length < 2) {
    const error = new Error('当前动作不适合继续拆分，建议直接使用两帧模式生成。')
    error.statusCode = 409
    throw error
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const shot = context.storyboard
    const originalReference = shot.asset_reference_json || shot.assetReference || null
    const increment = subShots.length - 1
    await conn.execute(
      `UPDATE storyboards
       SET sort_order = sort_order + ?
       WHERE scene_id = ? AND sort_order > ?`,
      [increment, shot.scene_id, shot.sort_order],
    )
    const first = subShots[0]
    const firstReference = buildSubShotDirectionReference(originalReference, shot, first)
    await conn.execute(
      `UPDATE storyboards
       SET shot_type = ?, camera_angle = ?, composition = ?, duration_seconds = ?,
           action_text = ?, dialogue_text = ?, visual_prompt = ?,
           start_visual_prompt = ?, end_visual_prompt = ?,
           asset_reference_json = ?,
           image_url = ?, end_image_url = NULL, video_url = NULL,
           status = 'pending', updated_at = NOW()
       WHERE id = ?`,
      [
        first.shotType,
        first.cameraAngle,
        first.composition,
        first.durationSeconds,
        first.actionText,
        first.dialogueText,
        first.visualPrompt,
        first.startVisualPrompt,
        first.endVisualPrompt,
        JSON.stringify(firstReference),
        shot.image_url || null,
        storyboardId,
      ],
    )
    const baseShotNo = String(shot.shot_no || 'S').slice(0, 5)
    for (let index = 1; index < subShots.length; index += 1) {
      const item = subShots[index]
      const itemReference = buildSubShotDirectionReference(originalReference, shot, item)
      await conn.execute(
        `INSERT INTO storyboards
          (scene_id, shot_no, shot_type, camera_angle, composition, duration_seconds,
           character_id, character_name, action_text, dialogue_text, visual_prompt,
           start_visual_prompt, end_visual_prompt, asset_reference_json, sort_order, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [
          shot.scene_id,
          `${baseShotNo}-${index + 1}`.slice(0, 8),
          item.shotType,
          item.cameraAngle,
          item.composition,
          item.durationSeconds,
          shot.character_id || null,
          shot.character_name || null,
          item.actionText,
          item.dialogueText,
          item.visualPrompt,
          item.startVisualPrompt,
          item.endVisualPrompt,
          JSON.stringify(itemReference),
          Number(shot.sort_order || 0) + index,
        ],
      )
    }
    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }

  const [rows] = await db.execute(
    `SELECT * FROM storyboards WHERE scene_id = ? ORDER BY sort_order ASC, id ASC`,
    [context.storyboard.scene_id],
  )
  return {
    items: rows.map(storyboardRow),
    current: rows.find((row) => Number(row.id) === Number(storyboardId))
      ? storyboardRow(rows.find((row) => Number(row.id) === Number(storyboardId)))
      : null,
    createdCount: subShots.length,
  }
}

async function splitStoryboardDialogueTurns(userId, storyboardId) {
  const context = await loadStoryboardDirectorContext(userId, storyboardId)
  if (!context) return null
  await assertStoryboardHasNoGeneratedAssets(storyboardId, { allowContinuityStartImage: true })

  const fallbackTurns = fallbackDialogueSubShots(context)
  if (fallbackTurns.length < 2) {
    const error = new Error('当前对白没有识别到两个以上已存在角色的说话行。请用“角色名：对白”格式填写，例如“温叙：我听见了”。')
    error.statusCode = 409
    throw error
  }
  const uniqueSpeakers = new Set(fallbackTurns.map((item) => item.characterId))
  if (uniqueSpeakers.size < 2) {
    const error = new Error('当前对白只识别到一个说话角色，不需要按多人对白拆镜。')
    error.statusCode = 409
    throw error
  }

  let rawSubShots = null
  try {
    const result = await generateStructuredJson({
      task: 'storyboard-dialogue-turn-split',
      temperature: 0.35,
      systemPrompt: [
        '你是 AI 漫剧对话分镜导演。',
        '请把多人对白拆成短分镜，每个分镜只能有一个当前说话角色。',
        '输出必须是中文 JSON，不要 Markdown，不要英文。',
      ].join('\n'),
      userPrompt: JSON.stringify({
        输出格式: {
          subShots: [
            {
              speakerName: '必须匹配角色列表里的中文角色名',
              shotType: '景别',
              cameraAngle: '机位',
              composition: '构图',
              durationSeconds: 4,
              actionText: '当前说话人的动作和其他人的反应',
              dialogueText: '角色名：这一句对白',
              visualPrompt: '画面提示词',
              startVisualPrompt: '起始帧提示词',
              endVisualPrompt: '结束帧提示词',
            },
          ],
        },
        项目: context.project,
        场景: context.scene,
        原分镜: {
          shotNo: context.storyboard.shot_no,
          shotType: context.storyboard.shot_type,
          cameraAngle: context.storyboard.camera_angle,
          composition: context.storyboard.composition,
          durationSeconds: context.storyboard.duration_seconds,
          actionText: context.storyboard.action_text,
          dialogueText: context.storyboard.dialogue_text,
          visualPrompt: context.storyboard.visual_prompt,
        },
        角色: context.characters.map((item) => ({
          id: item.id,
          name: item.name,
          roleTag: item.role_tag,
          appearance: item.appearance,
        })),
        要求: [
          '每个子分镜只能保留一个当前说话角色，dialogueText 必须只包含这个角色的一句或连续短句。',
          'speakerName 必须严格使用角色列表里的 name，不能自造角色名。',
          '多人同框可以保留，但不说话的人只能作为倾听或反应人物，不能张嘴。',
          '每个子分镜都要绑定适合做口型的景别，优先中近景、近景或过肩镜头。',
          '保留原场景、角色外貌、服装、光线和空间连续性。',
        ],
      }),
    })
    rawSubShots = result.json?.subShots
  } catch (error) {
    console.warn('[storyboard-dialogue-split] AI fallback', error?.message || error)
  }

  const subShots = normalizeDialogueSubShots(rawSubShots, context)
  if (subShots.length < 2) {
    const error = new Error('多人对白拆镜失败：没有得到可绑定角色的有效子分镜。请检查对白是否使用“角色名：对白”格式。')
    error.statusCode = 409
    throw error
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const shot = context.storyboard
    const originalReference = shot.asset_reference_json || shot.assetReference || null
    const increment = subShots.length - 1
    await conn.execute(
      `UPDATE storyboards
       SET sort_order = sort_order + ?
       WHERE scene_id = ? AND sort_order > ?`,
      [increment, shot.scene_id, shot.sort_order],
    )
    const first = subShots[0]
    const firstReference = buildSubShotDirectionReference(originalReference, shot, first)
    await conn.execute(
      `UPDATE storyboards
       SET shot_type = ?, camera_angle = ?, composition = ?, duration_seconds = ?,
           character_id = ?, character_name = ?,
           action_text = ?, dialogue_text = ?, visual_prompt = ?,
           start_visual_prompt = ?, end_visual_prompt = ?,
           asset_reference_json = ?,
           image_url = ?, end_image_url = NULL, video_url = NULL,
           status = 'pending', updated_at = NOW()
       WHERE id = ?`,
      [
        first.shotType,
        first.cameraAngle,
        first.composition,
        first.durationSeconds,
        first.characterId,
        first.characterName,
        first.actionText,
        first.dialogueText,
        first.visualPrompt,
        first.startVisualPrompt,
        first.endVisualPrompt,
        JSON.stringify(firstReference),
        shot.image_url || null,
        storyboardId,
      ],
    )
    const baseShotNo = String(shot.shot_no || 'S').slice(0, 5)
    for (let index = 1; index < subShots.length; index += 1) {
      const item = subShots[index]
      const itemReference = buildSubShotDirectionReference(originalReference, shot, item)
      await conn.execute(
        `INSERT INTO storyboards
          (scene_id, shot_no, shot_type, camera_angle, composition, duration_seconds,
           character_id, character_name, action_text, dialogue_text, visual_prompt,
           start_visual_prompt, end_visual_prompt, asset_reference_json, sort_order, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [
          shot.scene_id,
          `${baseShotNo}-${index + 1}`.slice(0, 8),
          item.shotType,
          item.cameraAngle,
          item.composition,
          item.durationSeconds,
          item.characterId,
          item.characterName,
          item.actionText,
          item.dialogueText,
          item.visualPrompt,
          item.startVisualPrompt,
          item.endVisualPrompt,
          JSON.stringify(itemReference),
          Number(shot.sort_order || 0) + index,
        ],
      )
    }
    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }

  const [rows] = await db.execute(
    `SELECT * FROM storyboards WHERE scene_id = ? ORDER BY sort_order ASC, id ASC`,
    [context.storyboard.scene_id],
  )
  const currentRow = rows.find((row) => Number(row.id) === Number(storyboardId))
  return {
    items: rows.map(storyboardRow),
    current: currentRow ? storyboardRow(currentRow) : null,
    createdCount: subShots.length,
    speakers: [...new Set(subShots.map((item) => item.characterName).filter(Boolean))],
  }
}

async function enqueueCharacterImageJob(userId, characterId, body = {}) {
  const [rows] = await db.execute(
    `SELECT c.*, p.user_id AS ownerId, p.visual_style AS project_visual_style
     FROM characters c
     INNER JOIN projects p ON p.id = c.project_id
     WHERE c.id = ? AND c.status <> 'archived' LIMIT 1`,
    [characterId],
  )
  const character = rows[0]
  if (!character || character.ownerId !== userId) return null
  if (!String(character.appearance || '').trim()) {
    const error = new Error('角色缺少外观设定，请先填写或使用 AI 补全角色档案')
    error.statusCode = 400
    throw error
  }

  const frameConfig = getFrameConfig()
  const [versionRows] = await db.execute(
    `SELECT COALESCE(MAX(version_no), 0) AS maxVersion FROM character_images WHERE character_id = ?`,
    [characterId],
  )
  const promptSnapshot = [
    String(body.prompt || '').trim(),
    character.name,
    character.role_tag,
    character.personality,
    character.appearance,
    character.project_visual_style,
  ].filter(Boolean).join('，')

  return createGenerationJob({
    projectId: Number(character.project_id),
    jobType: 'character_image',
    sourceId: characterId,
    request: {
      characterId,
      versionNo: Number(versionRows[0]?.maxVersion || 0) + 1,
      candidateCount: Math.max(1, Math.min(3, parseId(body.candidateCount) || 1)),
      modelName: String(body.modelName || frameConfig.defaultModel).trim(),
      prompt: body.prompt ? String(body.prompt).trim() : '',
      promptSnapshot,
      character: {
        name: character.name,
        roleTag: character.role_tag,
        personality: character.personality,
        appearance: character.appearance,
      },
      projectVisualStyle: character.project_visual_style,
      referenceImageUrls: resolveCharacterReferenceImageUrls(
        character.reference_image_url ? [character.reference_image_url] : [],
      ),
    },
  })
}

async function enqueueLipSyncJob(userId, storyboardId, body = {}) {
  const [shotRows] = await db.execute(
    `SELECT s.*, sc.project_id, p.user_id AS ownerId, c.name AS resolved_character_name
     FROM storyboards s
     INNER JOIN script_scenes sc ON sc.id = s.scene_id
     INNER JOIN projects p ON p.id = sc.project_id
     LEFT JOIN characters c ON c.id = s.character_id
     WHERE s.id = ? LIMIT 1`,
    [storyboardId],
  )
  const shot = shotRows[0]
  if (!shot || shot.ownerId !== userId) return null
  if (!shot.character_id) {
    const error = new Error('当前分镜没有绑定说话角色，无法生成口型视频')
    error.statusCode = 409
    throw error
  }

  const lipSyncConfig = getLipSyncConfig()
  const [imageRows] = await db.execute(
    `SELECT * FROM image_assets
     WHERE storyboard_id = ? AND status = 'confirmed'
     ORDER BY confirmed_at DESC, id DESC LIMIT 1`,
    [storyboardId],
  )
  const image = imageRows[0] || null

  const [audioRows] = await db.execute(
    `SELECT * FROM audio_assets
     WHERE storyboard_id = ? AND track_type = 'dialogue' AND status = 'confirmed'
     ORDER BY CASE
       WHEN character_id = ? THEN 0
       WHEN character_id IS NULL THEN 1
       ELSE 2
     END ASC,
       confirmed_at DESC, id DESC
     LIMIT 1`,
    [storyboardId, shot.character_id],
  )
  const audio = await ensureAudioAssetStorage(audioRows[0])
  if (!audio) {
    const error = new Error('请先为当前分镜确认中文对白音频，再生成口型视频')
    error.statusCode = 409
    throw error
  }
  if (audio.character_id && Number(audio.character_id) !== Number(shot.character_id)) {
    const shotCharacter = shot.resolved_character_name || shot.character_name || `角色 ${shot.character_id}`
    const audioCharacter = audio.character_name || `角色 ${audio.character_id}`
    const error = new Error(
      `当前分镜绑定的说话人是“${shotCharacter}”，但已确认对白音频属于“${audioCharacter}”。请先在分镜编辑页把当前分镜绑定到真正说话的人，或在音频页为“${shotCharacter}”重新生成并确认对白音频。多人对白请先使用“AI 拆分多人对白”，按对白从上到下拆成单人说话分镜。`,
    )
    error.statusCode = 409
    throw error
  }

  const [sourceVideoRows] = await db.execute(
    `SELECT * FROM video_assets
     WHERE storyboard_id = ?
       AND status IN ('confirmed', 'archived')
       AND COALESCE(source_type, 'generated_video') <> 'lip_sync'
       AND video_url IS NOT NULL
       AND video_url <> ''
     ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END ASC,
       confirmed_at DESC, id DESC LIMIT 1`,
    [storyboardId],
  )
  const sourceVideo = sourceVideoRows[0] || null
  const canUseSourceVideo = ['dashscope', 'latentsync'].includes(lipSyncConfig.provider)
  if (!image && !(canUseSourceVideo && sourceVideo?.video_url)) {
    const error = new Error('请先确认当前分镜静帧，再生成口型视频')
    error.statusCode = 409
    throw error
  }
  if (lipSyncConfig.provider === 'latentsync' && !sourceVideo?.video_url) {
    const error = new Error('LatentSync 是视频后处理服务，请先生成并确认当前分镜视频')
    error.statusCode = 409
    throw error
  }

  const [versionRows] = await db.execute(
    `SELECT COALESCE(MAX(version_no), 0) AS maxVersion
     FROM video_assets WHERE storyboard_id = ?`,
    [storyboardId],
  )
  const characterName = shot.resolved_character_name || shot.character_name || '人物'
  const generationDurationSeconds = lipSyncConfig.provider === 'dashscope'
    ? resolveDashScopeLipSyncDuration(audio.duration_seconds, shot.duration_seconds)
    : resolveLipSyncDuration(audio.duration_seconds, shot.duration_seconds)
  const prompt = String(body.prompt || '').trim() || buildLipSyncPrompt({
    characterName,
    dialogueText: shot.dialogue_text,
    actionText: shot.action_text,
  })

  return createGenerationJob({
    projectId: Number(shot.project_id),
    jobType: 'lip_sync',
    sourceId: storyboardId,
    request: {
      projectId: Number(shot.project_id),
      storyboardId,
      characterId: Number(shot.character_id),
      characterName,
      imageAssetId: image ? Number(image.id) : null,
      imageUrl: image?.image_url || sourceVideo?.thumbnail_url || sourceVideo?.video_url || null,
      sourceVideoAssetId: sourceVideo ? Number(sourceVideo.id) : undefined,
      sourceVideoUrl: sourceVideo?.video_url || undefined,
      sourceVideoThumbnailUrl: sourceVideo?.thumbnail_url || undefined,
      audioAssetId: Number(audio.id),
      audioUrl: audio.audio_url,
      audioDurationSeconds: Number(audio.duration_seconds) || 0,
      generationDurationSeconds,
      versionNo: Number(versionRows[0]?.maxVersion || 0) + 1,
      prompt,
      cropFilter: /^(\d{3,4}):(\d{3,4}):(\d{1,4}):(\d{1,4})$/.test(String(body.cropFilter || '').trim())
        ? String(body.cropFilter).trim()
        : undefined,
      autoConfirm: body.autoConfirm !== false,
      providerTaskId: String(body.providerTaskId || '').trim() || undefined,
    },
  })
}

function parseNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeAliyunSignName(value) {
  const raw = String(value || '').trim()

  if (!raw) {
    return DEFAULT_ALIYUN_SIGN_NAME
  }

  if (LEGACY_ALIYUN_SIGN_NAME_ALIASES.has(raw)) {
    return DEFAULT_ALIYUN_SIGN_NAME
  }

  return raw
}

function buildAliyunTemplateParam(rawTemplateParam, validTime, code) {
  const finalCode = String(code || '')
  const validMinutes = String(Math.max(1, Math.ceil(validTime / 60)))

  if (!rawTemplateParam) {
    return JSON.stringify({
      code: finalCode,
      min: validMinutes,
    })
  }

  try {
    const parsed = JSON.parse(rawTemplateParam)
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        parsed[key] = value
          .replaceAll('##code##', finalCode)
          .replaceAll('{{code}}', finalCode)
          .replaceAll('{{validMinutes}}', validMinutes)
      }
    }
    return JSON.stringify(parsed)
  } catch {
    return rawTemplateParam
      .replaceAll('##code##', finalCode)
      .replaceAll('{{code}}', finalCode)
      .replaceAll('{{validMinutes}}', validMinutes)
  }
}

function createSmsRuntime() {
  const provider = (process.env.SMS_PROVIDER || 'mock').toLowerCase()
  const tencent = {
    secretId: process.env.TENCENTCLOUD_SECRET_ID || '',
    secretKey: process.env.TENCENTCLOUD_SECRET_KEY || '',
    sdkAppId: process.env.TENCENTCLOUD_SMS_SDK_APP_ID || '',
    signName: process.env.TENCENTCLOUD_SMS_SIGN_NAME || '',
    templateId: process.env.TENCENTCLOUD_SMS_TEMPLATE_ID || '',
    region: process.env.TENCENTCLOUD_SMS_REGION || 'ap-guangzhou',
  }

  const missingTencentFields = Object.entries(tencent)
    .filter(([, value]) => !value)
    .map(([key]) => key)

  const aliyunValidTime = parseNumber(process.env.ALIYUN_SMS_VALID_TIME, CODE_TTL_SECONDS)
  const aliyun = {
    accessKeyId: process.env.ALIYUN_SMS_ACCESS_KEY_ID || '',
    accessKeySecret: process.env.ALIYUN_SMS_ACCESS_KEY_SECRET || '',
    regionId: process.env.ALIYUN_SMS_REGION_ID || 'cn-hangzhou',
    endpoint: process.env.ALIYUN_SMS_ENDPOINT || 'dypnsapi.aliyuncs.com',
    signName: normalizeAliyunSignName(process.env.ALIYUN_SMS_SIGN_NAME),
    templateCode: process.env.ALIYUN_SMS_TEMPLATE_CODE || '',
    schemeName: process.env.ALIYUN_SMS_SCHEME_NAME || '',
    templateParamRaw: process.env.ALIYUN_SMS_TEMPLATE_PARAM || '',
    codeLength: parseNumber(process.env.ALIYUN_SMS_CODE_LENGTH, 6),
    codeType: parseNumber(process.env.ALIYUN_SMS_CODE_TYPE, 1),
    duplicatePolicy: parseNumber(process.env.ALIYUN_SMS_DUPLICATE_POLICY, 1),
    interval: parseNumber(process.env.ALIYUN_SMS_INTERVAL, 60),
    validTime: aliyunValidTime,
    dypnsSubscriptionId: process.env.ALIYUN_DYPNS_SUBSCRIPTION_ID || '',
  }

  const missingAliyunFields = ['accessKeyId', 'accessKeySecret', 'signName', 'templateCode']
    .filter((key) => !aliyun[key])

  let client = null
  if (provider === 'tencent' && missingTencentFields.length === 0) {
    const SmsClient = tencentcloud.sms.v20210111.Client
    client = new SmsClient({
      credential: {
        secretId: tencent.secretId,
        secretKey: tencent.secretKey,
      },
      region: tencent.region,
      profile: {
        signMethod: 'TC3-HMAC-SHA256',
        httpProfile: {
          reqMethod: 'POST',
          reqTimeout: 30,
          endpoint: 'sms.tencentcloudapi.com',
        },
      },
    })
  }

  if (provider === 'aliyun' && missingAliyunFields.length === 0) {
    const config = new OpenApi.Config({
      accessKeyId: aliyun.accessKeyId,
      accessKeySecret: aliyun.accessKeySecret,
      endpoint: aliyun.endpoint,
      regionId: aliyun.regionId,
      type: 'access_key',
    })
    client = new Dypnsapi20170525.default(config)
  }

  const ready = Boolean(
    provider === 'mock' ||
      (provider === 'tencent' && client) ||
      (provider === 'aliyun' && client),
  )

  const reason =
    provider === 'mock'
      ? 'using mock sms provider'
      : provider === 'tencent'
        ? ready
          ? 'tencent sms provider is configured'
          : `missing tencent config: ${missingTencentFields.join(', ')}`
        : ready
          ? 'aliyun pnvs sms provider is configured'
          : `missing aliyun config: ${missingAliyunFields.join(', ')}`

  return {
    provider,
    client,
    tencent,
    aliyun,
    ready,
    reason,
  }
}

function getBootstrapSql() {
  // 数据库采用“启动时自举”的方式：
  // 服务启动会创建缺失的表，随后执行一组兼容性迁移。
  // 这样本地开发不需要额外手动导入 schema.sql。
  return `
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      phone VARCHAR(20) NOT NULL,
      nickname VARCHAR(100) NOT NULL,
      password_hash VARCHAR(64) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_users_phone (phone)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS sms_codes (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      phone VARCHAR(20) NOT NULL,
      code_type VARCHAR(20) NOT NULL,
      code VARCHAR(16) NOT NULL,
      provider VARCHAR(32) DEFAULT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_sms_codes_lookup (phone, code_type, created_at),
      KEY idx_sms_codes_expiry (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS sessions (
      token VARCHAR(64) NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      phone VARCHAR(20) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at DATETIME DEFAULT NULL,
      PRIMARY KEY (token),
      KEY idx_sessions_user_id (user_id),
      CONSTRAINT fk_sessions_user_id FOREIGN KEY (user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS projects (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(200) NOT NULL,
      category VARCHAR(80) DEFAULT NULL,
      target_duration INT UNSIGNED DEFAULT NULL,
      narrative_vision TEXT,
      visual_style TEXT,
      aspect_ratio VARCHAR(20) DEFAULT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_projects_user_id (user_id),
      KEY idx_projects_status (status),
      CONSTRAINT fk_projects_user_id FOREIGN KEY (user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS story_outlines (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      version_no INT UNSIGNED NOT NULL DEFAULT 1,
      title VARCHAR(200) DEFAULT NULL,
      logline TEXT,
      premise TEXT,
      summary TEXT,
      act1_text TEXT,
      act2_text TEXT,
      act3_text TEXT,
      visual_style TEXT,
      content LONGTEXT,
      raw_json LONGTEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_outlines_project_id (project_id),
      CONSTRAINT fk_outlines_project_id FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS script_scenes (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      episode_no INT UNSIGNED NOT NULL DEFAULT 1,
      outline_id BIGINT UNSIGNED DEFAULT NULL,
      scene_no INT UNSIGNED NOT NULL,
      title VARCHAR(200) DEFAULT NULL,
      summary TEXT,
      content LONGTEXT,
      spatial_anchors_json LONGTEXT DEFAULT NULL,
      mood VARCHAR(200) DEFAULT NULL,
      location VARCHAR(200) DEFAULT NULL,
      time_of_day VARCHAR(40) DEFAULT NULL,
      estimated_duration INT UNSIGNED DEFAULT NULL,
      sort_order INT UNSIGNED NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_scenes_project_episode_no (project_id, episode_no, scene_no),
      KEY idx_scenes_project_episode (project_id, episode_no, sort_order, id),
      KEY idx_scenes_outline_id (outline_id),
      CONSTRAINT fk_scenes_project_id FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      CONSTRAINT fk_scenes_outline_id FOREIGN KEY (outline_id) REFERENCES story_outlines(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS storyboards (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      scene_id BIGINT UNSIGNED NOT NULL,
      shot_no VARCHAR(8) NOT NULL,
      shot_type VARCHAR(40) DEFAULT NULL,
      camera_angle VARCHAR(40) DEFAULT NULL,
      composition VARCHAR(255) DEFAULT NULL,
      duration_seconds INT UNSIGNED DEFAULT NULL,
      character_id BIGINT UNSIGNED DEFAULT NULL,
      character_name VARCHAR(100) DEFAULT NULL,
      action_text TEXT,
      dialogue_text TEXT,
      visual_prompt TEXT,
      start_visual_prompt TEXT,
      end_visual_prompt TEXT,
      asset_reference_json LONGTEXT DEFAULT NULL,
      image_url VARCHAR(500) DEFAULT NULL,
      end_image_url VARCHAR(500) DEFAULT NULL,
      video_url VARCHAR(500) DEFAULT NULL,
      sort_order INT UNSIGNED NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_storyboards_scene_id (scene_id),
      KEY idx_storyboards_character_id (character_id),
      CONSTRAINT fk_storyboards_scene_id FOREIGN KEY (scene_id) REFERENCES script_scenes(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS voice_profiles (
      profile_key VARCHAR(80) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      provider VARCHAR(40) NOT NULL,
      model_name VARCHAR(100) NOT NULL,
      voice_id VARCHAR(100) NOT NULL,
      gender VARCHAR(20) NOT NULL,
      age_groups VARCHAR(160) NOT NULL,
      style_tags VARCHAR(255) DEFAULT NULL,
      description TEXT,
      instructions TEXT,
      language_type VARCHAR(40) NOT NULL DEFAULT 'Chinese',
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      sort_order INT UNSIGNED NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (profile_key),
      KEY idx_voice_profiles_status (status),
      KEY idx_voice_profiles_sort_order (sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS characters (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(200) NOT NULL,
      role_tag VARCHAR(80) DEFAULT NULL,
      personality TEXT,
      appearance TEXT,
      voice_setting TEXT,
      age_group VARCHAR(32) DEFAULT NULL,
      gender VARCHAR(20) DEFAULT NULL,
      voice_style VARCHAR(160) DEFAULT NULL,
      voice_profile_key VARCHAR(80) DEFAULT NULL,
      voice_locked TINYINT(1) NOT NULL DEFAULT 0,
      voice_design_json LONGTEXT DEFAULT NULL,
      reference_image_url VARCHAR(500) DEFAULT NULL,
      reference_audio_url VARCHAR(500) DEFAULT NULL,
      reference_audio_storage_key VARCHAR(500) DEFAULT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_characters_project_id (project_id),
      KEY idx_characters_status (status),
      KEY idx_characters_voice_profile_key (voice_profile_key),
      CONSTRAINT fk_characters_project_id FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS story_bibles (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      version_no INT UNSIGNED NOT NULL DEFAULT 1,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      title VARCHAR(200) DEFAULT NULL,
      logline TEXT,
      audience TEXT,
      emotional_promise TEXT,
      world_rules_json LONGTEXT,
      timeline_json LONGTEXT,
      locations_json LONGTEXT,
      characters_json LONGTEXT,
      relationships_json LONGTEXT,
      props_json LONGTEXT,
      main_plot LONGTEXT,
      subplots_json LONGTEXT,
      foreshadowing_json LONGTEXT,
      locked_facts_json LONGTEXT,
      flexible_facts_json LONGTEXT,
      visual_symbols_json LONGTEXT,
      quality_report_json LONGTEXT,
      locked_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_story_bibles_project_id (project_id),
      CONSTRAINT fk_story_bibles_project_id FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS season_structures (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      story_bible_id BIGINT UNSIGNED DEFAULT NULL,
      version_no INT UNSIGNED NOT NULL DEFAULT 1,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      season_theme TEXT,
      core_conflict TEXT,
      structure_type VARCHAR(80) DEFAULT NULL,
      episode_count INT UNSIGNED NOT NULL DEFAULT 1,
      episodes_json LONGTEXT,
      foreshadowing_plan_json LONGTEXT,
      character_arcs_json LONGTEXT,
      quality_report_json LONGTEXT,
      locked_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_season_structures_project_id (project_id),
      CONSTRAINT fk_season_structures_project_id FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      CONSTRAINT fk_season_structures_story_bible_id FOREIGN KEY (story_bible_id) REFERENCES story_bibles(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS script_agent_activities (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      stage_key VARCHAR(32) NOT NULL,
      action_key VARCHAR(80) NOT NULL,
      agent_key VARCHAR(80) NOT NULL,
      source VARCHAR(20) NOT NULL DEFAULT 'button',
      status VARCHAR(32) NOT NULL DEFAULT 'running',
      title VARCHAR(200) NOT NULL,
      summary TEXT,
      context_json LONGTEXT,
      result_json LONGTEXT,
      reaction_json LONGTEXT,
      error_text TEXT,
      idempotency_key VARCHAR(200) DEFAULT NULL,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_script_agent_activity_idempotency (project_id, idempotency_key),
      KEY idx_script_agent_activity_project (project_id, id, created_at),
      KEY idx_script_agent_activity_status (project_id, status),
      CONSTRAINT fk_script_agent_activity_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      CONSTRAINT fk_script_agent_activity_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS agent_pipeline_runs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      episode_no INT UNSIGNED NOT NULL DEFAULT 1,
      status VARCHAR(32) NOT NULL DEFAULT 'queued',
      current_stage VARCHAR(80) NOT NULL,
      input_snapshot_json LONGTEXT,
      output_snapshot_json LONGTEXT,
      error_text TEXT,
      idempotency_key VARCHAR(200) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_agent_pipeline_run_idempotency (project_id, idempotency_key),
      KEY idx_agent_pipeline_runs_project (project_id, id, updated_at),
      KEY idx_agent_pipeline_runs_status (status),
      CONSTRAINT fk_agent_pipeline_run_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      CONSTRAINT fk_agent_pipeline_run_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS agent_pipeline_executions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      pipeline_run_id BIGINT UNSIGNED NOT NULL,
      stage_key VARCHAR(80) NOT NULL,
      agent_key VARCHAR(80) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'queued',
      attempt INT UNSIGNED NOT NULL DEFAULT 1,
      idempotency_key VARCHAR(240) NOT NULL,
      input_snapshot_json LONGTEXT,
      output_snapshot_json LONGTEXT,
      blockers_json LONGTEXT,
      error_text TEXT,
      started_at DATETIME DEFAULT NULL,
      finished_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_agent_pipeline_execution_idempotency (idempotency_key),
      KEY idx_agent_pipeline_execution_stage (pipeline_run_id, stage_key),
      KEY idx_agent_pipeline_execution_run (pipeline_run_id, id),
      CONSTRAINT fk_agent_pipeline_execution_run FOREIGN KEY (pipeline_run_id) REFERENCES agent_pipeline_runs(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS agent_pipeline_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      pipeline_run_id BIGINT UNSIGNED NOT NULL,
      execution_id BIGINT UNSIGNED DEFAULT NULL,
      stage_key VARCHAR(80) NOT NULL,
      agent_key VARCHAR(80) NOT NULL,
      attempt INT UNSIGNED NOT NULL DEFAULT 1,
      status VARCHAR(32) NOT NULL,
      payload_json LONGTEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_agent_pipeline_event_run (pipeline_run_id, id),
      CONSTRAINT fk_agent_pipeline_event_run FOREIGN KEY (pipeline_run_id) REFERENCES agent_pipeline_runs(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS production_runs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      episode_no INT UNSIGNED NOT NULL DEFAULT 1,
      platform VARCHAR(32) NOT NULL DEFAULT '抖音',
      name VARCHAR(200) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'waiting_approval',
      current_stage VARCHAR(80) NOT NULL,
      current_checkpoint VARCHAR(80) DEFAULT NULL,
      pilot_mode VARCHAR(80) NOT NULL,
      pilot_scene_count INT UNSIGNED NOT NULL DEFAULT 2,
      budget DECIMAL(12,2) DEFAULT NULL,
      candidate_policy_json LONGTEXT NOT NULL,
      success_metrics_json LONGTEXT NOT NULL,
      input_snapshot_json LONGTEXT,
      output_snapshot_json LONGTEXT,
      failure_code VARCHAR(80) DEFAULT NULL,
      failure_text TEXT,
      idempotency_key VARCHAR(200) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_production_runs_idempotency (project_id, idempotency_key),
      KEY idx_production_runs_project_episode (project_id, episode_no, id),
      CONSTRAINT fk_production_runs_project_id FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS production_stage_runs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      production_run_id BIGINT UNSIGNED NOT NULL,
      stage_key VARCHAR(80) NOT NULL,
      sequence_no INT UNSIGNED NOT NULL,
      agent_key VARCHAR(80) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'blocked',
      input_snapshot_json LONGTEXT,
      output_snapshot_json LONGTEXT,
      error_text TEXT,
      started_at DATETIME DEFAULT NULL,
      finished_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_production_stage_run (production_run_id, stage_key),
      KEY idx_production_stage_run_order (production_run_id, sequence_no),
      CONSTRAINT fk_production_stage_run FOREIGN KEY (production_run_id) REFERENCES production_runs(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS production_checkpoints (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      production_run_id BIGINT UNSIGNED NOT NULL,
      checkpoint_key VARCHAR(80) NOT NULL,
      stage_key VARCHAR(80) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'blocked',
      decision_note TEXT,
      reviewed_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_production_checkpoint (production_run_id, checkpoint_key),
      CONSTRAINT fk_production_checkpoint FOREIGN KEY (production_run_id) REFERENCES production_runs(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS production_agent_executions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      production_run_id BIGINT UNSIGNED NOT NULL,
      stage_key VARCHAR(80) NOT NULL,
      agent_key VARCHAR(80) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      model_name VARCHAR(100) DEFAULT NULL,
      output_json LONGTEXT,
      error_text TEXT,
      started_at DATETIME DEFAULT NULL,
      finished_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_production_agent_execution_run (production_run_id, id),
      CONSTRAINT fk_production_agent_execution FOREIGN KEY (production_run_id) REFERENCES production_runs(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS episode_blueprints (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      production_run_id BIGINT UNSIGNED NOT NULL,
      project_id BIGINT UNSIGNED NOT NULL,
      episode_no INT UNSIGNED NOT NULL,
      version_no INT UNSIGNED NOT NULL DEFAULT 1,
      status VARCHAR(32) NOT NULL DEFAULT 'draft',
      blueprint_json LONGTEXT NOT NULL,
      quality_report_json LONGTEXT,
      approved_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_episode_blueprint_version (production_run_id, version_no),
      KEY idx_episode_blueprint_project (project_id, episode_no),
      CONSTRAINT fk_episode_blueprint_run FOREIGN KEY (production_run_id) REFERENCES production_runs(id) ON DELETE CASCADE,
      CONSTRAINT fk_episode_blueprint_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS production_emotion_beats (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      blueprint_id BIGINT UNSIGNED NOT NULL,
      beat_key VARCHAR(80) NOT NULL,
      phase VARCHAR(40) NOT NULL,
      label VARCHAR(200) NOT NULL,
      sequence_no INT UNSIGNED NOT NULL,
      duration_seconds INT UNSIGNED NOT NULL DEFAULT 1,
      emotion_start TEXT,
      emotion_process TEXT,
      emotion_end TEXT,
      action_start TEXT,
      action_process TEXT,
      action_end TEXT,
      dialogue_plan TEXT,
      sound_plan TEXT,
      continuity TEXT,
      scene_no INT UNSIGNED DEFAULT NULL,
      shot_count INT UNSIGNED NOT NULL DEFAULT 0,
      status VARCHAR(32) NOT NULL DEFAULT 'draft',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_production_emotion_beats_order (blueprint_id, sequence_no),
      CONSTRAINT fk_production_emotion_beat FOREIGN KEY (blueprint_id) REFERENCES episode_blueprints(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS asset_nodes (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      node_type VARCHAR(20) NOT NULL,
      ref_id BIGINT UNSIGNED DEFAULT NULL,
      label VARCHAR(200) NOT NULL,
      appearance_label VARCHAR(200) DEFAULT NULL,
      prompt_text TEXT,
      turnaround_prompt_text TEXT,
      negative_prompt TEXT,
      x DECIMAL(12,2) NOT NULL DEFAULT 0,
      y DECIMAL(12,2) NOT NULL DEFAULT 0,
      width INT UNSIGNED NOT NULL DEFAULT 220,
      height INT UNSIGNED NOT NULL DEFAULT 260,
      group_key VARCHAR(255) DEFAULT NULL,
      character_identity_lock_json LONGTEXT DEFAULT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_asset_nodes_project_id (project_id),
      KEY idx_asset_nodes_project_type (project_id, node_type),
      CONSTRAINT fk_asset_nodes_project_id FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS project_workflow_states (
      project_id BIGINT UNSIGNED NOT NULL,
      parsed_script_fingerprint CHAR(64) DEFAULT NULL,
      parsed_at DATETIME DEFAULT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (project_id),
      CONSTRAINT fk_project_workflow_state_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS asset_node_images (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      asset_node_id BIGINT UNSIGNED NOT NULL,
      version_no INT UNSIGNED NOT NULL DEFAULT 1,
      image_url TEXT NOT NULL,
      storage_key VARCHAR(500) DEFAULT NULL,
      thumbnail_url TEXT,
      prompt_snapshot TEXT,
      model_name VARCHAR(100) DEFAULT NULL,
      view_set_type VARCHAR(40) NOT NULL DEFAULT 'single',
      view_set_version INT UNSIGNED NOT NULL DEFAULT 1,
      view_index INT UNSIGNED DEFAULT NULL,
      view_key VARCHAR(40) DEFAULT NULL,
      view_label VARCHAR(80) DEFAULT NULL,
      source_image_id BIGINT UNSIGNED DEFAULT NULL,
      source_image_url TEXT,
      crop_json JSON DEFAULT NULL,
      character_identity_lock_json LONGTEXT DEFAULT NULL,
      identity_status VARCHAR(20) NOT NULL DEFAULT 'not_checked',
      identity_reason TEXT DEFAULT NULL,
      identity_similarity_score DECIMAL(5,2) DEFAULT NULL,
      wardrobe_consistency_score DECIMAL(5,2) DEFAULT NULL,
      vision_status VARCHAR(20) NOT NULL DEFAULT 'pending',
      vision_reason TEXT,
      vision_checked_at DATETIME DEFAULT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'candidate',
      confirmed_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_asset_node_images_node_id (asset_node_id),
      CONSTRAINT fk_asset_node_images_node_id FOREIGN KEY (asset_node_id) REFERENCES asset_nodes(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS character_images (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      character_id BIGINT UNSIGNED NOT NULL,
      version_no INT UNSIGNED NOT NULL DEFAULT 1,
      image_url VARCHAR(500) NOT NULL,
      storage_key VARCHAR(500) DEFAULT NULL,
      thumbnail_url VARCHAR(500) DEFAULT NULL,
      prompt_snapshot TEXT,
      model_name VARCHAR(100) DEFAULT NULL,
      view_set_type VARCHAR(40) NOT NULL DEFAULT 'single',
      status VARCHAR(20) NOT NULL DEFAULT 'candidate',
      confirmed_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_character_images_character_id (character_id),
      KEY idx_character_images_status (status),
      CONSTRAINT fk_character_images_character_id FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS image_assets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      storyboard_id BIGINT UNSIGNED NOT NULL,
      version_no INT UNSIGNED NOT NULL DEFAULT 1,
      image_url VARCHAR(500) NOT NULL,
      storage_key VARCHAR(500) DEFAULT NULL,
      thumbnail_url VARCHAR(500) DEFAULT NULL,
      prompt_snapshot TEXT,
      frame_role VARCHAR(20) NOT NULL DEFAULT 'primary',
      negative_prompt TEXT,
      character_snapshot JSON DEFAULT NULL,
      model_name VARCHAR(80) DEFAULT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'candidate',
      confirmed_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_image_assets_storyboard_id (storyboard_id),
      KEY idx_image_assets_frame_role (frame_role),
      KEY idx_image_assets_status (status),
      CONSTRAINT fk_image_assets_storyboard_id FOREIGN KEY (storyboard_id) REFERENCES storyboards(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS video_assets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      storyboard_id BIGINT UNSIGNED NOT NULL,
      image_asset_id BIGINT UNSIGNED DEFAULT NULL,
      version_no INT UNSIGNED NOT NULL DEFAULT 1,
      video_url TEXT NOT NULL,
      storage_key VARCHAR(500) DEFAULT NULL,
      end_frame_url TEXT DEFAULT NULL,
      end_frame_storage_key VARCHAR(500) DEFAULT NULL,
      thumbnail_url TEXT DEFAULT NULL,
      motion_mode VARCHAR(64) DEFAULT NULL,
      duration_seconds INT UNSIGNED DEFAULT NULL,
      model_name VARCHAR(100) DEFAULT NULL,
      audio_asset_id BIGINT UNSIGNED DEFAULT NULL,
      generation_job_id BIGINT UNSIGNED DEFAULT NULL,
      source_type VARCHAR(32) NOT NULL DEFAULT 'generated_video',
      status VARCHAR(20) NOT NULL DEFAULT 'candidate',
      confirmed_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_video_assets_storyboard_id (storyboard_id),
      KEY idx_video_assets_status (status),
      KEY idx_video_assets_audio_asset_id (audio_asset_id),
      KEY idx_video_assets_generation_job_id (generation_job_id),
      CONSTRAINT fk_video_assets_storyboard_id FOREIGN KEY (storyboard_id) REFERENCES storyboards(id) ON DELETE CASCADE,
      CONSTRAINT fk_video_assets_image_asset_id FOREIGN KEY (image_asset_id) REFERENCES image_assets(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS lip_sync_profiles (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      character_id BIGINT UNSIGNED NOT NULL,
      provider VARCHAR(40) NOT NULL,
      group_id VARCHAR(120) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_lip_sync_profiles_character_provider (character_id, provider),
      CONSTRAINT fk_lip_sync_profiles_character_id FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS lip_sync_assets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      character_id BIGINT UNSIGNED NOT NULL,
      image_asset_id BIGINT UNSIGNED NOT NULL,
      provider VARCHAR(40) NOT NULL,
      group_id VARCHAR(120) NOT NULL,
      asset_id VARCHAR(120) NOT NULL,
      asset_url VARCHAR(255) NOT NULL,
      source_url TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'processing',
      error_text TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_lip_sync_assets_image_provider (image_asset_id, provider),
      KEY idx_lip_sync_assets_character_id (character_id),
      CONSTRAINT fk_lip_sync_assets_character_id FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
      CONSTRAINT fk_lip_sync_assets_image_asset_id FOREIGN KEY (image_asset_id) REFERENCES image_assets(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS audio_assets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      track_type VARCHAR(32) NOT NULL,
      scene_id BIGINT UNSIGNED DEFAULT NULL,
      storyboard_id BIGINT UNSIGNED DEFAULT NULL,
      character_id BIGINT UNSIGNED DEFAULT NULL,
      start_offset_seconds DECIMAL(10,3) NOT NULL DEFAULT 0,
      version_no INT UNSIGNED NOT NULL DEFAULT 1,
      title VARCHAR(160) NOT NULL,
      audio_url TEXT NOT NULL,
      storage_key VARCHAR(500) DEFAULT NULL,
      duration_seconds INT UNSIGNED DEFAULT NULL,
      voice_name VARCHAR(100) DEFAULT NULL,
      model_name VARCHAR(100) DEFAULT NULL,
      voice_profile_key VARCHAR(80) DEFAULT NULL,
      voice_instructions TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'candidate',
      confirmed_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_audio_assets_project_id (project_id),
      KEY idx_audio_assets_track_type (track_type),
      KEY idx_audio_assets_storyboard_id (storyboard_id),
      KEY idx_audio_assets_status (status),
      CONSTRAINT fk_audio_assets_project_id FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      CONSTRAINT fk_audio_assets_scene_id FOREIGN KEY (scene_id) REFERENCES script_scenes(id) ON DELETE SET NULL,
      CONSTRAINT fk_audio_assets_storyboard_id FOREIGN KEY (storyboard_id) REFERENCES storyboards(id) ON DELETE SET NULL,
      CONSTRAINT fk_audio_assets_character_id FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS export_records (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'completed',
      video_url TEXT NOT NULL,
      storage_key VARCHAR(500) DEFAULT NULL,
      subtitle_storage_key VARCHAR(500) DEFAULT NULL,
      cover_url TEXT DEFAULT NULL,
      duration_seconds INT UNSIGNED DEFAULT NULL,
      config_json LONGTEXT,
      source_count INT UNSIGNED DEFAULT NULL,
      ready_count INT UNSIGNED DEFAULT NULL,
      missing_count INT UNSIGNED DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_export_records_project_id (project_id),
      KEY idx_export_records_status (status),
      CONSTRAINT fk_export_records_project_id FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS final_edit_drafts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      draft_json LONGTEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_final_edit_drafts_project_id (project_id),
      KEY idx_final_edit_drafts_project_id (project_id),
      CONSTRAINT fk_final_edit_drafts_project_id FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS task_runtime_states (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      task_key VARCHAR(80) NOT NULL,
      project_id BIGINT UNSIGNED NOT NULL,
      task_type VARCHAR(20) NOT NULL,
      source_id BIGINT UNSIGNED NOT NULL,
      runtime_status VARCHAR(20) NOT NULL DEFAULT 'success',
      progress_percent INT UNSIGNED DEFAULT 100,
      error_text TEXT DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_task_runtime_states_task_key (task_key),
      KEY idx_task_runtime_states_project_id (project_id),
      KEY idx_task_runtime_states_status (runtime_status),
      CONSTRAINT fk_task_runtime_states_project_id FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS model_settings (
      setting_key VARCHAR(80) NOT NULL,
      setting_value TEXT,
      updated_by BIGINT UNSIGNED DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (setting_key),
      KEY idx_model_settings_updated_by (updated_by)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS generation_jobs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      job_key VARCHAR(80) NOT NULL,
      project_id BIGINT UNSIGNED NOT NULL,
      job_type VARCHAR(32) NOT NULL,
      source_id BIGINT UNSIGNED NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'queued',
      progress_percent INT UNSIGNED NOT NULL DEFAULT 0,
      request_json LONGTEXT,
      result_json LONGTEXT,
      error_text TEXT DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_generation_jobs_job_key (job_key),
      KEY idx_generation_jobs_project_id (project_id),
      KEY idx_generation_jobs_status (status),
      CONSTRAINT fk_generation_jobs_project_id FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `
}

async function createDatabasePool() {
  // 先用管理员连接创建数据库，再创建真正指向项目库的连接池。
  // mysql2/promise 返回 Promise 风格 API，适合当前 async/await 代码。
  if (!/^[A-Za-z0-9_]+$/.test(DB_NAME)) {
    throw new Error(`数据库名不安全，请检查 DB_NAME：${DB_NAME}`)
  }

  const admin = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    multipleStatements: true,
  })

  try {
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    )
    await admin.query(`USE \`${DB_NAME}\`; ${getBootstrapSql()}`)
  } finally {
    await admin.end()
  }

  const pool = mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
    enableKeepAlive: true,
  })

  await ensureDemoUser(pool)
  if (appRuntimeRole.runsMigrations) await runLightMigrations(pool)
  return pool
}

/**
 * @description 轻量级字段迁移：给已存在的表补齐新列
 *              - MySQL 8 不支持 `ADD COLUMN IF NOT EXISTS`，所以包 try/catch
 *              - 失败时不阻塞启动（最坏情况是读不出来，路由会兜底返回 null）
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<void>}
 */
async function runLightMigrations(pool) {
  const tableColumns = [
    {
      table: 'script_scenes',
      column: 'episode_no',
      sql: 'ALTER TABLE script_scenes ADD COLUMN episode_no INT UNSIGNED NOT NULL DEFAULT 1 AFTER project_id',
    },
    {
      table: 'script_scenes',
      column: 'spatial_anchors_json',
      sql: 'ALTER TABLE script_scenes ADD COLUMN spatial_anchors_json LONGTEXT DEFAULT NULL AFTER content',
    },
    {
      table: 'asset_nodes',
      column: 'turnaround_prompt_text',
      sql: 'ALTER TABLE asset_nodes ADD COLUMN turnaround_prompt_text TEXT DEFAULT NULL AFTER prompt_text',
    },
    {
      table: 'asset_nodes',
      column: 'environment_prompt_text',
      sql: 'ALTER TABLE asset_nodes ADD COLUMN environment_prompt_text TEXT DEFAULT NULL AFTER turnaround_prompt_text',
    },
    {
      table: 'asset_nodes',
      column: 'character_identity_lock_json',
      sql: 'ALTER TABLE asset_nodes ADD COLUMN character_identity_lock_json LONGTEXT DEFAULT NULL AFTER group_key',
    },
    {
      table: 'asset_node_images',
      column: 'storage_key',
      sql: 'ALTER TABLE asset_node_images ADD COLUMN storage_key VARCHAR(500) DEFAULT NULL AFTER image_url',
    },
    {
      table: 'asset_node_images',
      column: 'view_set_type',
      sql: 'ALTER TABLE asset_node_images ADD COLUMN view_set_type VARCHAR(40) NOT NULL DEFAULT \'single\' AFTER model_name',
    },
    {
      table: 'asset_node_images',
      column: 'view_set_version',
      sql: 'ALTER TABLE asset_node_images ADD COLUMN view_set_version INT UNSIGNED NOT NULL DEFAULT 1 AFTER view_set_type',
    },
    {
      table: 'asset_node_images',
      column: 'view_index',
      sql: 'ALTER TABLE asset_node_images ADD COLUMN view_index INT UNSIGNED DEFAULT NULL AFTER view_set_version',
    },
    {
      table: 'asset_node_images',
      column: 'view_key',
      sql: 'ALTER TABLE asset_node_images ADD COLUMN view_key VARCHAR(40) DEFAULT NULL AFTER view_index',
    },
    {
      table: 'asset_node_images',
      column: 'view_label',
      sql: 'ALTER TABLE asset_node_images ADD COLUMN view_label VARCHAR(80) DEFAULT NULL AFTER view_key',
    },
    {
      table: 'asset_node_images',
      column: 'vision_status',
      sql: 'ALTER TABLE asset_node_images ADD COLUMN vision_status VARCHAR(20) NOT NULL DEFAULT \'pending\' AFTER view_label',
    },
    {
      table: 'asset_node_images',
      column: 'vision_reason',
      sql: 'ALTER TABLE asset_node_images ADD COLUMN vision_reason TEXT DEFAULT NULL AFTER vision_status',
    },
    {
      table: 'asset_node_images',
      column: 'vision_checked_at',
      sql: 'ALTER TABLE asset_node_images ADD COLUMN vision_checked_at DATETIME DEFAULT NULL AFTER vision_reason',
    },
    {
      table: 'asset_node_images',
      column: 'source_image_id',
      sql: 'ALTER TABLE asset_node_images ADD COLUMN source_image_id BIGINT UNSIGNED DEFAULT NULL AFTER view_label',
    },
    {
      table: 'asset_node_images',
      column: 'source_image_url',
      sql: 'ALTER TABLE asset_node_images ADD COLUMN source_image_url TEXT DEFAULT NULL AFTER source_image_id',
    },
    {
      table: 'asset_node_images',
      column: 'crop_json',
      sql: 'ALTER TABLE asset_node_images ADD COLUMN crop_json JSON DEFAULT NULL AFTER source_image_url',
    },
    {
      table: 'asset_node_images',
      column: 'character_identity_lock_json',
      sql: 'ALTER TABLE asset_node_images ADD COLUMN character_identity_lock_json LONGTEXT DEFAULT NULL AFTER crop_json',
    },
    {
      table: 'asset_node_images',
      column: 'identity_status',
      sql: "ALTER TABLE asset_node_images ADD COLUMN identity_status VARCHAR(20) NOT NULL DEFAULT 'not_checked' AFTER character_identity_lock_json",
    },
    {
      table: 'asset_node_images',
      column: 'identity_reason',
      sql: 'ALTER TABLE asset_node_images ADD COLUMN identity_reason TEXT DEFAULT NULL AFTER identity_status',
    },
    {
      table: 'asset_node_images',
      column: 'identity_similarity_score',
      sql: 'ALTER TABLE asset_node_images ADD COLUMN identity_similarity_score DECIMAL(5,2) DEFAULT NULL AFTER identity_reason',
    },
    {
      table: 'asset_node_images',
      column: 'wardrobe_consistency_score',
      sql: 'ALTER TABLE asset_node_images ADD COLUMN wardrobe_consistency_score DECIMAL(5,2) DEFAULT NULL AFTER identity_similarity_score',
    },
  ]
  for (const migration of tableColumns) {
    try {
      await pool.execute(migration.sql)
    } catch (error) {
      if (error?.errno && ![1060, 1061, 1146].includes(error.errno)) {
        console.warn(`[migration] ${migration.table}.${migration.column} skipped:`, error.message)
      }
    }
  }

  const migrations = [
    {
      table: 'script_scenes',
      column: 'uk_scenes_project_episode_no',
      sql: 'ALTER TABLE script_scenes ADD UNIQUE KEY uk_scenes_project_episode_no (project_id, episode_no, scene_no)',
    },
    {
      table: 'script_scenes',
      column: 'uk_scenes_project_no',
      sql: 'ALTER TABLE script_scenes DROP INDEX uk_scenes_project_no',
    },
    {
      table: 'asset_nodes',
      column: 'group_key',
      sql: 'ALTER TABLE asset_nodes MODIFY COLUMN group_key VARCHAR(255) DEFAULT NULL',
    },
    {
      table: 'agent_pipeline_executions',
      column: 'stage_index',
      sql: 'ALTER TABLE agent_pipeline_executions DROP INDEX uk_agent_pipeline_execution_stage',
    },
    {
      table: 'projects',
      column: 'visual_style',
      sql: 'ALTER TABLE projects MODIFY COLUMN visual_style TEXT',
    },
    {
      table: 'story_outlines',
      column: 'visual_style',
      sql: 'ALTER TABLE story_outlines ADD COLUMN visual_style TEXT',
    },
    {
      table: 'story_outlines',
      column: 'visual_style',
      sql: 'ALTER TABLE story_outlines MODIFY COLUMN visual_style TEXT',
    },
    {
      table: 'story_outlines',
      column: 'summary',
      sql: 'ALTER TABLE story_outlines ADD COLUMN summary TEXT AFTER premise',
    },
    {
      table: 'story_outlines',
      column: 'content',
      sql: 'ALTER TABLE story_outlines ADD COLUMN content LONGTEXT AFTER visual_style',
    },
    {
      table: 'storyboards',
      column: 'video_url',
      sql: 'ALTER TABLE storyboards ADD COLUMN video_url VARCHAR(500) DEFAULT NULL',
    },
    {
      table: 'storyboards',
      column: 'composition',
      sql: 'ALTER TABLE storyboards MODIFY COLUMN composition VARCHAR(255) DEFAULT NULL',
    },
    {
      table: 'storyboards',
      column: 'character_id',
      sql: 'ALTER TABLE storyboards ADD COLUMN character_id BIGINT UNSIGNED DEFAULT NULL',
    },
    {
      table: 'storyboards',
      column: 'asset_reference_json',
      sql: 'ALTER TABLE storyboards ADD COLUMN asset_reference_json LONGTEXT DEFAULT NULL AFTER end_visual_prompt',
    },
    {
      table: 'storyboards',
      column: 'character_id_index',
      sql: 'ALTER TABLE storyboards ADD KEY idx_storyboards_character_id (character_id)',
    },
    {
      table: 'characters',
      column: 'age_group',
      sql: 'ALTER TABLE characters ADD COLUMN age_group VARCHAR(32) DEFAULT NULL',
    },
    {
      table: 'characters',
      column: 'gender',
      sql: 'ALTER TABLE characters ADD COLUMN gender VARCHAR(20) DEFAULT NULL',
    },
    {
      table: 'characters',
      column: 'voice_style',
      sql: 'ALTER TABLE characters ADD COLUMN voice_style VARCHAR(160) DEFAULT NULL',
    },
    {
      table: 'characters',
      column: 'voice_profile_key',
      sql: 'ALTER TABLE characters ADD COLUMN voice_profile_key VARCHAR(80) DEFAULT NULL',
    },
    {
      table: 'characters',
      column: 'voice_design_json',
      sql: 'ALTER TABLE characters ADD COLUMN voice_design_json LONGTEXT DEFAULT NULL AFTER voice_locked',
    },
    {
      table: 'characters',
      column: 'voice_locked',
      sql: 'ALTER TABLE characters ADD COLUMN voice_locked TINYINT(1) NOT NULL DEFAULT 0',
    },
    {
      table: 'characters',
      column: 'voice_profile_key_index',
      sql: 'ALTER TABLE characters ADD KEY idx_characters_voice_profile_key (voice_profile_key)',
    },
    {
      table: 'characters',
      column: 'appearance_locked',
      sql: 'ALTER TABLE characters ADD COLUMN appearance_locked TINYINT(1) NOT NULL DEFAULT 0',
    },
    {
      table: 'characters',
      column: 'reference_image_storage_key',
      sql: 'ALTER TABLE characters ADD COLUMN reference_image_storage_key VARCHAR(500) DEFAULT NULL',
    },
    {
      table: 'characters',
      column: 'reference_audio_url',
      sql: 'ALTER TABLE characters ADD COLUMN reference_audio_url VARCHAR(500) DEFAULT NULL',
    },
    {
      table: 'characters',
      column: 'reference_audio_storage_key',
      sql: 'ALTER TABLE characters ADD COLUMN reference_audio_storage_key VARCHAR(500) DEFAULT NULL',
    },
    {
      table: 'character_images',
      column: 'storage_key',
      sql: 'ALTER TABLE character_images ADD COLUMN storage_key VARCHAR(500) DEFAULT NULL AFTER image_url',
    },
    {
      table: 'image_assets',
      column: 'character_snapshot',
      sql: 'ALTER TABLE image_assets ADD COLUMN character_snapshot JSON DEFAULT NULL AFTER negative_prompt',
    },
    {
      table: 'storyboards',
      column: 'start_visual_prompt',
      sql: 'ALTER TABLE storyboards ADD COLUMN start_visual_prompt TEXT AFTER visual_prompt',
    },
    {
      table: 'storyboards',
      column: 'end_visual_prompt',
      sql: 'ALTER TABLE storyboards ADD COLUMN end_visual_prompt TEXT AFTER start_visual_prompt',
    },
    {
      table: 'storyboards',
      column: 'end_image_url',
      sql: 'ALTER TABLE storyboards ADD COLUMN end_image_url VARCHAR(500) DEFAULT NULL AFTER image_url',
    },
    {
      table: 'image_assets',
      column: 'frame_role',
      sql: "ALTER TABLE image_assets ADD COLUMN frame_role VARCHAR(20) NOT NULL DEFAULT 'primary' AFTER prompt_snapshot",
    },
    {
      table: 'image_assets',
      column: 'frame_role_index',
      sql: 'ALTER TABLE image_assets ADD KEY idx_image_assets_frame_role (frame_role)',
    },
    {
      table: 'audio_assets',
      column: 'voice_profile_key',
      sql: 'ALTER TABLE audio_assets ADD COLUMN voice_profile_key VARCHAR(80) DEFAULT NULL',
    },
    {
      table: 'audio_assets',
      column: 'storyboard_id',
      sql: 'ALTER TABLE audio_assets ADD COLUMN storyboard_id BIGINT UNSIGNED DEFAULT NULL AFTER scene_id',
    },
    {
      table: 'audio_assets',
      column: 'storyboard_id_index',
      sql: 'ALTER TABLE audio_assets ADD KEY idx_audio_assets_storyboard_id (storyboard_id)',
    },
    {
      table: 'audio_assets',
      column: 'start_offset_seconds',
      sql: 'ALTER TABLE audio_assets ADD COLUMN start_offset_seconds DECIMAL(10,3) NOT NULL DEFAULT 0 AFTER version_no',
    },
    {
      table: 'audio_assets',
      column: 'duration_seconds_precision',
      sql: 'ALTER TABLE audio_assets MODIFY COLUMN duration_seconds DECIMAL(10,3) UNSIGNED DEFAULT NULL',
    },
    {
      table: 'audio_assets',
      column: 'voice_instructions',
      sql: 'ALTER TABLE audio_assets ADD COLUMN voice_instructions TEXT',
    },
    {
      table: 'video_assets',
      column: 'image_asset_id_nullable',
      sql: 'ALTER TABLE video_assets MODIFY COLUMN image_asset_id BIGINT UNSIGNED DEFAULT NULL',
    },
    {
      table: 'video_assets',
      column: 'storage_key',
      sql: 'ALTER TABLE video_assets ADD COLUMN storage_key VARCHAR(500) DEFAULT NULL AFTER video_url',
    },
    {
      table: 'audio_assets',
      column: 'storage_key',
      sql: 'ALTER TABLE audio_assets ADD COLUMN storage_key VARCHAR(500) DEFAULT NULL AFTER audio_url',
    },
    {
      table: 'export_records',
      column: 'storage_key',
      sql: 'ALTER TABLE export_records ADD COLUMN storage_key VARCHAR(500) DEFAULT NULL AFTER video_url',
    },
    {
      table: 'export_records',
      column: 'subtitle_storage_key',
      sql: 'ALTER TABLE export_records ADD COLUMN subtitle_storage_key VARCHAR(500) DEFAULT NULL AFTER storage_key',
    },
    {
      table: 'video_assets',
      column: 'audio_asset_id',
      sql: 'ALTER TABLE video_assets ADD COLUMN audio_asset_id BIGINT UNSIGNED DEFAULT NULL AFTER model_name',
    },
    {
      table: 'video_assets',
      column: 'generation_job_id',
      sql: 'ALTER TABLE video_assets ADD COLUMN generation_job_id BIGINT UNSIGNED DEFAULT NULL AFTER audio_asset_id',
    },
    {
      table: 'video_assets',
      column: 'source_type',
      sql: "ALTER TABLE video_assets ADD COLUMN source_type VARCHAR(32) NOT NULL DEFAULT 'generated_video' AFTER generation_job_id",
    },
    {
      table: 'video_assets',
      column: 'end_frame_url',
      sql: 'ALTER TABLE video_assets ADD COLUMN end_frame_url TEXT DEFAULT NULL AFTER storage_key',
    },
    {
      table: 'video_assets',
      column: 'end_frame_storage_key',
      sql: 'ALTER TABLE video_assets ADD COLUMN end_frame_storage_key VARCHAR(500) DEFAULT NULL AFTER end_frame_url',
    },
    {
      table: 'video_assets',
      column: 'audio_asset_id_index',
      sql: 'ALTER TABLE video_assets ADD KEY idx_video_assets_audio_asset_id (audio_asset_id)',
    },
    {
      table: 'video_assets',
      column: 'generation_job_id_index',
      sql: 'ALTER TABLE video_assets ADD KEY idx_video_assets_generation_job_id (generation_job_id)',
    },
    {
      table: 'video_assets',
      column: 'quality_report_json',
      sql: 'ALTER TABLE video_assets ADD COLUMN quality_report_json LONGTEXT DEFAULT NULL AFTER generation_job_id',
    },
    {
      table: 'production_runs',
      column: 'user_id',
      sql: 'ALTER TABLE production_runs ADD COLUMN user_id BIGINT UNSIGNED NOT NULL DEFAULT 1 AFTER project_id',
    },
    {
      table: 'production_stage_runs',
      column: 'stage_key',
      sql: "ALTER TABLE production_stage_runs ADD COLUMN stage_key VARCHAR(80) NOT NULL DEFAULT 'planning' AFTER production_run_id",
    },
    {
      table: 'production_stage_runs',
      column: 'sequence_no',
      sql: 'ALTER TABLE production_stage_runs ADD COLUMN sequence_no INT UNSIGNED NOT NULL DEFAULT 1 AFTER stage_key',
    },
    {
      table: 'production_stage_runs',
      column: 'agent_key',
      sql: "ALTER TABLE production_stage_runs ADD COLUMN agent_key VARCHAR(80) NOT NULL DEFAULT 'script-agent' AFTER sequence_no",
    },
    {
      table: 'production_stage_runs',
      column: 'status',
      sql: "ALTER TABLE production_stage_runs ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'blocked' AFTER agent_key",
    },
    {
      table: 'production_stage_runs',
      column: 'input_snapshot_json',
      sql: 'ALTER TABLE production_stage_runs ADD COLUMN input_snapshot_json LONGTEXT AFTER status',
    },
    {
      table: 'production_stage_runs',
      column: 'output_snapshot_json',
      sql: 'ALTER TABLE production_stage_runs ADD COLUMN output_snapshot_json LONGTEXT AFTER input_snapshot_json',
    },
    {
      table: 'production_stage_runs',
      column: 'error_text',
      sql: 'ALTER TABLE production_stage_runs ADD COLUMN error_text TEXT AFTER output_snapshot_json',
    },
    {
      table: 'production_stage_runs',
      column: 'started_at',
      sql: 'ALTER TABLE production_stage_runs ADD COLUMN started_at DATETIME DEFAULT NULL AFTER error_text',
    },
    {
      table: 'production_stage_runs',
      column: 'finished_at',
      sql: 'ALTER TABLE production_stage_runs ADD COLUMN finished_at DATETIME DEFAULT NULL AFTER started_at',
    },
    {
      table: 'production_checkpoints',
      column: 'checkpoint_key',
      sql: "ALTER TABLE production_checkpoints ADD COLUMN checkpoint_key VARCHAR(80) NOT NULL DEFAULT 'story-bible' AFTER production_run_id",
    },
    {
      table: 'production_checkpoints',
      column: 'stage_key',
      sql: "ALTER TABLE production_checkpoints ADD COLUMN stage_key VARCHAR(80) NOT NULL DEFAULT 'planning' AFTER checkpoint_key",
    },
    {
      table: 'production_checkpoints',
      column: 'status',
      sql: "ALTER TABLE production_checkpoints ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'blocked' AFTER stage_key",
    },
    {
      table: 'production_checkpoints',
      column: 'decision_note',
      sql: 'ALTER TABLE production_checkpoints ADD COLUMN decision_note TEXT AFTER status',
    },
    {
      table: 'production_checkpoints',
      column: 'reviewed_at',
      sql: 'ALTER TABLE production_checkpoints ADD COLUMN reviewed_at DATETIME DEFAULT NULL AFTER decision_note',
    },
    {
      table: 'production_agent_executions',
      column: 'stage_key',
      sql: "ALTER TABLE production_agent_executions ADD COLUMN stage_key VARCHAR(80) NOT NULL DEFAULT 'planning' AFTER production_run_id",
    },
    {
      table: 'production_agent_executions',
      column: 'agent_key',
      sql: "ALTER TABLE production_agent_executions ADD COLUMN agent_key VARCHAR(80) NOT NULL DEFAULT 'script-agent' AFTER stage_key",
    },
    {
      table: 'production_agent_executions',
      column: 'status',
      sql: "ALTER TABLE production_agent_executions ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'pending' AFTER agent_key",
    },
    {
      table: 'production_agent_executions',
      column: 'model_name',
      sql: 'ALTER TABLE production_agent_executions ADD COLUMN model_name VARCHAR(100) DEFAULT NULL AFTER status',
    },
    {
      table: 'production_agent_executions',
      column: 'output_json',
      sql: 'ALTER TABLE production_agent_executions ADD COLUMN output_json LONGTEXT AFTER model_name',
    },
    {
      table: 'production_agent_executions',
      column: 'error_text',
      sql: 'ALTER TABLE production_agent_executions ADD COLUMN error_text TEXT AFTER output_json',
    },
    {
      table: 'production_agent_executions',
      column: 'started_at',
      sql: 'ALTER TABLE production_agent_executions ADD COLUMN started_at DATETIME DEFAULT NULL AFTER error_text',
    },
    {
      table: 'production_agent_executions',
      column: 'finished_at',
      sql: 'ALTER TABLE production_agent_executions ADD COLUMN finished_at DATETIME DEFAULT NULL AFTER started_at',
    },
    {
      table: 'episode_blueprints',
      column: 'project_id',
      sql: 'ALTER TABLE episode_blueprints ADD COLUMN project_id BIGINT UNSIGNED NOT NULL DEFAULT 1 AFTER production_run_id',
    },
    {
      table: 'episode_blueprints',
      column: 'episode_no',
      sql: 'ALTER TABLE episode_blueprints ADD COLUMN episode_no INT UNSIGNED NOT NULL DEFAULT 1 AFTER project_id',
    },
    {
      table: 'episode_blueprints',
      column: 'version_no',
      sql: 'ALTER TABLE episode_blueprints ADD COLUMN version_no INT UNSIGNED NOT NULL DEFAULT 1 AFTER episode_no',
    },
    {
      table: 'episode_blueprints',
      column: 'status',
      sql: "ALTER TABLE episode_blueprints ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'draft' AFTER version_no",
    },
    {
      table: 'episode_blueprints',
      column: 'blueprint_json',
      sql: 'ALTER TABLE episode_blueprints ADD COLUMN blueprint_json LONGTEXT NOT NULL AFTER status',
    },
    {
      table: 'episode_blueprints',
      column: 'quality_report_json',
      sql: 'ALTER TABLE episode_blueprints ADD COLUMN quality_report_json LONGTEXT AFTER blueprint_json',
    },
    {
      table: 'episode_blueprints',
      column: 'approved_at',
      sql: 'ALTER TABLE episode_blueprints ADD COLUMN approved_at DATETIME DEFAULT NULL AFTER quality_report_json',
    },
    {
      table: 'production_emotion_beats',
      column: 'blueprint_id',
      sql: 'ALTER TABLE production_emotion_beats ADD COLUMN blueprint_id BIGINT UNSIGNED NOT NULL DEFAULT 1 AFTER id',
    },
  ]
  for (const m of migrations) {
    try {
      await pool.execute(m.sql)
    } catch (e) {
      // Duplicate / already-applied idempotent DDL 等情况都吞掉。
      // 1060 = Duplicate column name
      // 1091 = DROP INDEX/COLUMN target already absent
      if (e && e.errno && ![1060, 1061, 1091].includes(e.errno)) {
        // eslint-disable-next-line no-console
        console.warn(`[migration] ${m.table}.${m.column} skipped:`, e.message)
      }
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_profiles (
      profile_key VARCHAR(80) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      provider VARCHAR(40) NOT NULL,
      model_name VARCHAR(100) NOT NULL,
      voice_id VARCHAR(100) NOT NULL,
      gender VARCHAR(20) NOT NULL,
      age_groups VARCHAR(160) NOT NULL,
      style_tags VARCHAR(255) DEFAULT NULL,
      description TEXT,
      instructions TEXT,
      language_type VARCHAR(40) NOT NULL DEFAULT 'Chinese',
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      sort_order INT UNSIGNED NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (profile_key),
      KEY idx_voice_profiles_status (status),
      KEY idx_voice_profiles_sort_order (sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  for (const profile of VOICE_PROFILE_SEEDS) {
    await pool.execute(
      `INSERT INTO voice_profiles
        (profile_key, display_name, provider, model_name, voice_id, gender, age_groups,
         style_tags, description, instructions, language_type, status, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
       ON DUPLICATE KEY UPDATE
         display_name = VALUES(display_name),
         provider = VALUES(provider),
         model_name = VALUES(model_name),
         voice_id = VALUES(voice_id),
         gender = VALUES(gender),
         age_groups = VALUES(age_groups),
         style_tags = VALUES(style_tags),
         description = VALUES(description),
         instructions = VALUES(instructions),
         language_type = VALUES(language_type),
         sort_order = VALUES(sort_order),
         updated_at = NOW()`,
      [
        profile.profileKey,
        profile.displayName,
        profile.provider,
        profile.modelName,
        profile.voiceId,
        profile.gender,
        profile.ageGroups.join(','),
        profile.styleTags.join(','),
        profile.description,
        profile.instructions || null,
        profile.languageType,
        profile.sortOrder,
      ],
    )
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS character_images (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      character_id BIGINT UNSIGNED NOT NULL,
      version_no INT UNSIGNED NOT NULL DEFAULT 1,
      image_url VARCHAR(500) NOT NULL,
      thumbnail_url VARCHAR(500) DEFAULT NULL,
      prompt_snapshot TEXT,
      model_name VARCHAR(100) DEFAULT NULL,
      view_set_type VARCHAR(40) NOT NULL DEFAULT 'single',
      status VARCHAR(20) NOT NULL DEFAULT 'candidate',
      confirmed_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_character_images_character_id (character_id),
      KEY idx_character_images_status (status),
      CONSTRAINT fk_character_images_character_id FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lip_sync_profiles (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      character_id BIGINT UNSIGNED NOT NULL,
      provider VARCHAR(40) NOT NULL,
      group_id VARCHAR(120) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_lip_sync_profiles_character_provider (character_id, provider),
      CONSTRAINT fk_lip_sync_profiles_character_id FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lip_sync_assets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      character_id BIGINT UNSIGNED NOT NULL,
      image_asset_id BIGINT UNSIGNED NOT NULL,
      provider VARCHAR(40) NOT NULL,
      group_id VARCHAR(120) NOT NULL,
      asset_id VARCHAR(120) NOT NULL,
      asset_url VARCHAR(255) NOT NULL,
      source_url TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'processing',
      error_text TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_lip_sync_assets_image_provider (image_asset_id, provider),
      KEY idx_lip_sync_assets_character_id (character_id),
      CONSTRAINT fk_lip_sync_assets_character_id FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
      CONSTRAINT fk_lip_sync_assets_image_asset_id FOREIGN KEY (image_asset_id) REFERENCES image_assets(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.execute(`
    UPDATE storyboards s
    INNER JOIN script_scenes sc ON sc.id = s.scene_id
    INNER JOIN characters c ON c.project_id = sc.project_id AND c.name = s.character_name
    SET s.character_id = c.id
    WHERE s.character_id IS NULL
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audio_assets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      track_type VARCHAR(32) NOT NULL,
      scene_id BIGINT UNSIGNED DEFAULT NULL,
      storyboard_id BIGINT UNSIGNED DEFAULT NULL,
      character_id BIGINT UNSIGNED DEFAULT NULL,
      version_no INT UNSIGNED NOT NULL DEFAULT 1,
      start_offset_seconds DECIMAL(10,3) NOT NULL DEFAULT 0,
      title VARCHAR(160) NOT NULL,
      audio_url TEXT NOT NULL,
      storage_key VARCHAR(500) DEFAULT NULL,
      duration_seconds INT UNSIGNED DEFAULT NULL,
      voice_name VARCHAR(100) DEFAULT NULL,
      model_name VARCHAR(100) DEFAULT NULL,
      voice_profile_key VARCHAR(80) DEFAULT NULL,
      voice_instructions TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'candidate',
      confirmed_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_audio_assets_project_id (project_id),
      KEY idx_audio_assets_track_type (track_type),
      KEY idx_audio_assets_storyboard_id (storyboard_id),
      KEY idx_audio_assets_status (status),
      CONSTRAINT fk_audio_assets_project_id FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      CONSTRAINT fk_audio_assets_scene_id FOREIGN KEY (scene_id) REFERENCES script_scenes(id) ON DELETE SET NULL,
      CONSTRAINT fk_audio_assets_storyboard_id FOREIGN KEY (storyboard_id) REFERENCES storyboards(id) ON DELETE SET NULL,
      CONSTRAINT fk_audio_assets_character_id FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await repairMalformedAudioTitles(pool)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS export_records (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'completed',
      video_url TEXT NOT NULL,
      storage_key VARCHAR(500) DEFAULT NULL,
      subtitle_storage_key VARCHAR(500) DEFAULT NULL,
      cover_url TEXT DEFAULT NULL,
      duration_seconds INT UNSIGNED DEFAULT NULL,
      config_json LONGTEXT,
      source_count INT UNSIGNED DEFAULT NULL,
      ready_count INT UNSIGNED DEFAULT NULL,
      missing_count INT UNSIGNED DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_export_records_project_id (project_id),
      KEY idx_export_records_status (status),
      CONSTRAINT fk_export_records_project_id FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS final_edit_drafts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      draft_json LONGTEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_final_edit_drafts_project_id (project_id),
      KEY idx_final_edit_drafts_project_id (project_id),
      CONSTRAINT fk_final_edit_drafts_project_id FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_runtime_states (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      task_key VARCHAR(80) NOT NULL,
      project_id BIGINT UNSIGNED NOT NULL,
      task_type VARCHAR(20) NOT NULL,
      source_id BIGINT UNSIGNED NOT NULL,
      runtime_status VARCHAR(20) NOT NULL DEFAULT 'success',
      progress_percent INT UNSIGNED DEFAULT 100,
      error_text TEXT DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_task_runtime_states_task_key (task_key),
      KEY idx_task_runtime_states_project_id (project_id),
      KEY idx_task_runtime_states_status (runtime_status),
      CONSTRAINT fk_task_runtime_states_project_id FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS model_settings (
      setting_key VARCHAR(80) NOT NULL,
      setting_value TEXT,
      updated_by BIGINT UNSIGNED DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (setting_key),
      KEY idx_model_settings_updated_by (updated_by)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS generation_jobs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      job_key VARCHAR(80) NOT NULL,
      project_id BIGINT UNSIGNED NOT NULL,
      job_type VARCHAR(32) NOT NULL,
      source_id BIGINT UNSIGNED NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'queued',
      progress_percent INT UNSIGNED NOT NULL DEFAULT 0,
      request_json LONGTEXT,
      result_json LONGTEXT,
      error_text TEXT DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_generation_jobs_job_key (job_key),
      KEY idx_generation_jobs_project_id (project_id),
      KEY idx_generation_jobs_status (status),
      CONSTRAINT fk_generation_jobs_project_id FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
}

async function repairMalformedAudioTitles(pool) {
  const [rows] = await pool.query(
    `SELECT aa.id,
            aa.title,
            aa.track_type,
            sc.scene_no,
            sc.title AS scene_title,
            sb.shot_no,
            c.name AS character_name,
            p.name AS project_name
     FROM audio_assets aa
     INNER JOIN projects p ON p.id = aa.project_id
     LEFT JOIN script_scenes sc ON sc.id = aa.scene_id
     LEFT JOIN storyboards sb ON sb.id = aa.storyboard_id
     LEFT JOIN characters c ON c.id = aa.character_id
     WHERE aa.title LIKE '%?%'`,
  )

  let repairedCount = 0
  for (const row of rows) {
    if (!isMalformedAudioTitle(row.title)) continue
    const title = resolveAudioSourceTitle(row)
    await pool.execute('UPDATE audio_assets SET title = ? WHERE id = ?', [title, row.id])
    repairedCount += 1
  }

  if (repairedCount > 0) {
    console.log(`[migration] repaired ${repairedCount} malformed audio titles`)
  }
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
  })
  res.end(JSON.stringify(payload))
}

function success(res, data = {}, message = 'success') {
  json(res, 200, { code: 0, message, data })
}

function fail(res, code, message, statusCode = 400, extra = undefined) {
  json(res, statusCode, { code, message, data: extra || null })
}

function parseBody(req, maxLength = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = ''
    let settled = false

    req.on('data', (chunk) => {
      if (settled) return
      body += chunk
      if (body.length > maxLength) {
        settled = true
        reject(new Error('Request body too large'))
      }
    })

    req.on('end', () => {
      if (settled) return
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })

    req.on('error', reject)
  })
}

function normalizePhone(input) {
  return String(input || '').replace(/\D/g, '').slice(0, 11)
}

function hashPassword(password) {
  return createHash('sha256').update(password).digest('hex')
}

function createToken() {
  return randomUUID().replace(/-/g, '')
}

async function cleanupExpiredCodes() {
  await db.execute('DELETE FROM sms_codes WHERE expires_at <= NOW()')
}

function buildCodeRecord(phone, type) {
  return {
    phone,
    type,
    code: String(randomInt(100000, 1000000)),
    expiresAtSeconds: CODE_TTL_SECONDS,
  }
}

async function saveCodeRecord(record, provider) {
  await cleanupExpiredCodes()
  await db.execute(
    `INSERT INTO sms_codes (phone, code_type, code, provider, expires_at)
     VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [record.phone, record.type, record.code, provider || null, record.expiresAtSeconds],
  )
}

function buildAliyunSmsError(body) {
  const rawMessage = String(body?.message || '').trim()
  const requestId = body?.requestId || body?.model?.requestId || ''

  if (rawMessage === 'System Internal Error') {
    return `阿里云测试短信发送失败：请先在号码认证控制台绑定测试手机号，并确认短信认证套餐余额充足。${requestId ? ` requestId=${requestId}` : ''}`
  }

  if (rawMessage === 'check frequency failed') {
    return `阿里云发送过于频繁：同一手机号短时间内请求次数过多，请等待至少 60 秒后再试。${requestId ? ` requestId=${requestId}` : ''}`
  }

  if (rawMessage.includes('SignatureDoesNotMatch')) {
    return `阿里云密钥校验失败：当前 AccessKey ID 和 AccessKey Secret 不匹配，或 Secret 复制不完整。请重新复制控制台里的完整密钥。${requestId ? ` requestId=${requestId}` : ''}`
  }

  return rawMessage || '阿里云短信验证码发送失败'
}

function buildAliyunClientError(error) {
  const requestId = error?.requestId || error?.data?.RequestId || ''
  const code = error?.code || error?.data?.Code || ''
  const message = String(error?.message || error?.data?.Message || '').trim()

  if (message.includes('System Internal Error')) {
    return `阿里云测试短信发送失败：服务端返回系统内部错误。请优先确认当前账号下“短信认证参数配置”的赠送签名仍然有效，并在控制台先点一次“调用 API 操作来测试短信认证服务”。${requestId ? ` requestId=${requestId}` : ''}${code ? ` code=${code}` : ''}`
  }

  if (message.includes('check frequency failed')) {
    return `阿里云发送过于频繁：同一手机号短时间内请求次数过多，请等待至少 60 秒后再试。${requestId ? ` requestId=${requestId}` : ''}${code ? ` code=${code}` : ''}`
  }

  if (message.includes('SignatureDoesNotMatch')) {
    return `阿里云密钥校验失败：当前 AccessKey ID 和 AccessKey Secret 不匹配，或 Secret 复制不完整。请重新复制控制台里的完整密钥。${requestId ? ` requestId=${requestId}` : ''}`
  }

  return `${message || '阿里云短信验证码发送失败'}${requestId ? ` requestId=${requestId}` : ''}${code ? ` code=${code}` : ''}`
}

async function sendVerificationCode(phone, type, code) {
  if (smsRuntime.provider === 'mock') {
    console.log(`[mock-sms] type=${type} phone=${phone} code=${code} expiresIn=${CODE_TTL_SECONDS}s`)
    return {
      provider: 'mock',
      countdown: 60,
      expiresIn: CODE_TTL_SECONDS,
      devCode: code,
    }
  }

  if (smsRuntime.provider === 'aliyun') {
    if (!smsRuntime.ready || !smsRuntime.client) {
      throw new Error(`阿里云短信认证未配置完成：${smsRuntime.reason}`)
    }

    const requestData = {
      phoneNumber: phone,
      countryCode: '86',
      signName: smsRuntime.aliyun.signName,
      templateCode: smsRuntime.aliyun.templateCode,
      templateParam: buildAliyunTemplateParam(
        smsRuntime.aliyun.templateParamRaw,
        smsRuntime.aliyun.validTime,
        code,
      ),
      codeLength: smsRuntime.aliyun.codeLength,
      codeType: smsRuntime.aliyun.codeType,
      duplicatePolicy: smsRuntime.aliyun.duplicatePolicy,
      interval: smsRuntime.aliyun.interval,
      validTime: smsRuntime.aliyun.validTime,
      outId: `${type}:${phone}:${Date.now()}`,
    }

    if (smsRuntime.aliyun.schemeName) {
      requestData.schemeName = smsRuntime.aliyun.schemeName
    }

    const request = new SendSmsVerifyCodeRequest(requestData)
    let response
    try {
      response = await smsRuntime.client.sendSmsVerifyCode(request)
    } catch (error) {
      throw new Error(buildAliyunClientError(error))
    }
    const body = response?.body || response

    if (!body?.success || body?.code !== 'OK') {
      throw new Error(buildAliyunSmsError(body))
    }

    console.log(
      `[aliyun-pnvs] type=${type} phone=${phone} bizId=${body.model?.bizId || ''} requestId=${body.requestId || body.model?.requestId || ''}`,
    )

    return {
      provider: 'aliyun',
      countdown: smsRuntime.aliyun.interval,
      expiresIn: smsRuntime.aliyun.validTime,
    }
  }

  if (!smsRuntime.ready || !smsRuntime.client) {
    throw new Error(`腾讯云短信未配置完成：${smsRuntime.reason}`)
  }

  const response = await smsRuntime.client.SendSms({
    PhoneNumberSet: [`+86${phone}`],
    SmsSdkAppId: smsRuntime.tencent.sdkAppId,
    SignName: smsRuntime.tencent.signName,
    TemplateId: smsRuntime.tencent.templateId,
    TemplateParamSet: [code],
    SessionContext: type,
  })

  const sendStatus = response.SendStatusSet?.[0]
  if (!sendStatus || sendStatus.Code !== 'Ok') {
    throw new Error(sendStatus?.Message || '腾讯云短信发送失败')
  }

  console.log(`[tencent-sms] type=${type} phone=${phone} serialNo=${sendStatus.SerialNo}`)
  return {
    provider: 'tencent',
    countdown: 60,
    expiresIn: CODE_TTL_SECONDS,
  }
}

async function consumeCode(phone, type, code) {
  await cleanupExpiredCodes()
  const connection = await db.getConnection()

  try {
    await connection.beginTransaction()

    const [rows] = await connection.execute(
      `SELECT id, code, expires_at AS expiresAt, used_at AS usedAt
       FROM sms_codes
       WHERE phone = ? AND code_type = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1
       FOR UPDATE`,
      [phone, type],
    )

    const record = rows[0]

    if (!record) {
      await connection.rollback()
      return { ok: false, message: '验证码不存在或已过期' }
    }

    if (record.usedAt) {
      await connection.rollback()
      return { ok: false, message: '验证码已失效，请重新获取' }
    }

    if (new Date(record.expiresAt).getTime() <= Date.now()) {
      await connection.execute('DELETE FROM sms_codes WHERE id = ?', [record.id])
      await connection.commit()
      return { ok: false, message: '验证码已过期，请重新获取' }
    }

    if (record.code !== String(code || '')) {
      await connection.rollback()
      return { ok: false, message: '验证码错误' }
    }

    await connection.execute('UPDATE sms_codes SET used_at = NOW() WHERE id = ?', [record.id])
    await connection.commit()
    return { ok: true }
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

async function verifySmsCode(phone, type, code) {
  return consumeCode(phone, type, code)
}

function toSafeUser(user) {
  return {
    id: user.id,
    phone: user.phone,
    nickname: user.nickname,
    createdAt: user.createdAt,
  }
}

async function ensureDemoUser(pool) {
  await pool.execute(
    `INSERT IGNORE INTO users (phone, nickname, password_hash)
     VALUES (?, ?, ?)`,
    [DEMO_PHONE, DEMO_NICKNAME, hashPassword(DEMO_PASSWORD)],
  )
}

async function getUserCount() {
  const [rows] = await db.execute('SELECT COUNT(*) AS total FROM users')
  return Number(rows[0]?.total || 0)
}

function normalizeModelSettingValue(field, value) {
  if (field.type === 'boolean') return value === true || String(value).trim().toLowerCase() === 'true' ? 'true' : 'false'
  if (field.type === 'number') {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`${field.label} 必须是正整数`)
    }
    return String(parsed)
  }
  return String(value ?? '').trim()
}

function getModelSettingFallbackValues() {
  const aiConfig = getAiConfig()
  const frameConfig = getFrameConfig()
  const videoConfig = getVideoConfig()
  const lipSyncConfig = getLipSyncConfig()
  const audioConfig = getAudioConfig()

  return {
    AI_PROVIDER: aiConfig.provider,
    AI_BASE_URL: aiConfig.baseUrl,
    AI_API_KEY: aiConfig.apiKey,
    AI_MODEL: aiConfig.defaultModel,
    AI_MODEL_OUTLINE: aiConfig.outlineModel,
    AI_MODEL_SCRIPT: aiConfig.scriptModel,
    AI_MODEL_STORYBOARD: aiConfig.storyboardModel,
    AI_MODEL_CHARACTER: aiConfig.characterModel,
    AI_TIMEOUT_MS: String(aiConfig.timeoutMs),
    AI_LONG_TASK_TIMEOUT_MS: String(aiConfig.longTaskTimeoutMs),
    AI_FALLBACK_TO_MOCK: String(aiConfig.fallbackToMock),

    FRAME_PROVIDER: frameConfig.provider,
    FRAME_BASE_URL: frameConfig.baseUrl,
    FRAME_API_KEY: frameConfig.apiKey,
    ARK_API_KEY: process.env.ARK_API_KEY || '',
    VOLCENGINE_API_KEY: process.env.VOLCENGINE_API_KEY || '',
    BIGMODEL_API_KEY: process.env.BIGMODEL_API_KEY || '',
    FRAME_MODEL: frameConfig.defaultModel,
    FRAME_FALLBACK_MODELS: frameConfig.fallbackModels.join(','),
    FRAME_IMAGE_SIZE: frameConfig.imageSize,
    FRAME_IMAGE_RATIO: frameConfig.imageRatio,
    FRAME_FALLBACK_TO_MOCK: String(frameConfig.fallbackToMock),

    VIDEO_PROVIDER: videoConfig.provider,
    VIDEO_BASE_URL: videoConfig.baseUrl,
    VIDEO_API_KEY: videoConfig.apiKey,
    VIDEO_MODEL: videoConfig.defaultModel,
    VIDEO_SIZE: videoConfig.size,
    VIDEO_WATERMARK_ENABLED: String(videoConfig.watermarkEnabled),
    VIDEO_FALLBACK_TO_MOCK: String(videoConfig.fallbackToMock),
    VIDEO_CREATE_RATE_LIMIT_MAX_REQUESTS: String(videoConfig.createRateLimitMaxRequests),
    VIDEO_CREATE_RATE_LIMIT_WINDOW_MS: String(videoConfig.createRateLimitWindowMs),
    VIDEO_IMAGE_UPLOAD_BASE_URL: videoConfig.imageUploadBaseUrl,
    VIDEO_IMAGE_UPLOAD_API_KEY: videoConfig.imageUploadApiKey,
    LIP_SYNC_PROVIDER: lipSyncConfig.provider,
    LIP_SYNC_BASE_URL: lipSyncConfig.baseUrl,
    LIP_SYNC_MODEL: lipSyncConfig.model,
    LIP_SYNC_API_KEY: lipSyncConfig.apiKey,

    AUDIO_PROVIDER: audioConfig.provider,
    AUDIO_BASE_URL: audioConfig.baseUrl,
    DASHSCOPE_API_KEY: audioConfig.apiKey,
    AUDIO_MODEL: audioConfig.defaultModel,
    AUDIO_FALLBACK_MODEL: audioConfig.fallbackModel,
    AUDIO_VOICE: audioConfig.defaultVoice,
    AUDIO_LANGUAGE_TYPE: audioConfig.languageType,
    AUDIO_FALLBACK_TO_MOCK: String(audioConfig.fallbackToMock),
  }
}

async function getPersistedModelSettingMap(pool = db) {
  const [rows] = await pool.execute('SELECT setting_key, setting_value FROM model_settings')
  return new Map(rows.map((row) => [row.setting_key, row.setting_value ?? '']))
}

async function applyPersistedModelSettings(pool) {
  const envOverrides = new Set(
    String(process.env.MODEL_SETTINGS_ENV_OVERRIDES || '')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean),
  )
  try {
    const settings = await getPersistedModelSettingMap(pool)
    for (const [key, value] of settings) {
      if (envOverrides.has(key)) continue
      if (MODEL_SETTING_FIELD_MAP.has(key)) process.env[key] = String(value ?? '')
    }
  } catch (error) {
    console.warn('[model-settings] persisted settings skipped:', error?.message || error)
  }
}

async function buildModelSettingsPayload() {
  const persisted = await getPersistedModelSettingMap()
  const fallbacks = getModelSettingFallbackValues()
  const fields = MODEL_SETTING_FIELDS.map((field) => {
    const hasStoredValue = persisted.has(field.key)
    const effectiveValue = hasStoredValue
      ? String(persisted.get(field.key) ?? '')
      : String(fallbacks[field.key] ?? process.env[field.key] ?? '')
    const secretConfigured = field.type === 'secret' && Boolean(effectiveValue.trim())

    return {
      ...field,
      value: field.type === 'secret' ? '' : effectiveValue,
      persisted: hasStoredValue,
      secretConfigured,
      source: hasStoredValue ? 'database' : 'environment',
    }
  })

  const aiConfig = getAiConfig()
  const frameConfig = getFrameConfig()
  const videoConfig = getVideoConfig()
  const lipSyncConfig = getLipSyncConfig()
  const audioConfig = getAudioConfig()

  return {
    groups: MODEL_SETTING_GROUPS,
    fields,
    effective: {
      text: {
        provider: aiConfig.provider,
        defaultModel: aiConfig.defaultModel,
        outlineModel: aiConfig.outlineModel,
        scriptModel: aiConfig.scriptModel,
        storyboardModel: aiConfig.storyboardModel,
        characterModel: aiConfig.characterModel,
      },
      frame: {
        provider: frameConfig.provider,
        defaultModel: frameConfig.defaultModel,
        fallbackModels: frameConfig.fallbackModels,
        imageSize: frameConfig.imageSize,
        imageRatio: frameConfig.imageRatio,
      },
      video: {
        provider: videoConfig.provider,
        defaultModel: videoConfig.defaultModel,
        size: videoConfig.size,
        lipSyncProvider: lipSyncConfig.provider,
        lipSyncModel: lipSyncConfig.model,
      },
      audio: {
        provider: audioConfig.provider,
        defaultModel: audioConfig.defaultModel,
        fallbackModel: audioConfig.fallbackModel,
        defaultVoice: audioConfig.defaultVoice,
      },
    },
  }
}

async function saveModelSettings(settings, userId) {
  if (!Array.isArray(settings)) throw new Error('设置格式不正确')

  for (const item of settings) {
    const key = String(item?.key || '').trim()
    const field = MODEL_SETTING_FIELD_MAP.get(key)
    if (!field) continue

    if (field.type === 'secret' && !String(item.value || '').trim()) {
      continue
    }

    const value = normalizeModelSettingValue(field, item.value)
    await db.execute(
      `INSERT INTO model_settings (setting_key, setting_value, updated_by)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         setting_value = VALUES(setting_value),
         updated_by = VALUES(updated_by),
         updated_at = NOW()`,
      [key, value, userId || null],
    )
    process.env[key] = value
  }
}

async function findUserByPhone(phone) {
  const [rows] = await db.execute(
    `SELECT id, phone, nickname, password_hash AS passwordHash, created_at AS createdAt
     FROM users
     WHERE phone = ?
     LIMIT 1`,
    [phone],
  )
  return rows[0] || null
}

async function createUser(phone, nickname, password) {
  const [result] = await db.execute(
    `INSERT INTO users (phone, nickname, password_hash)
     VALUES (?, ?, ?)`,
    [phone, nickname, hashPassword(password)],
  )

  return {
    id: Number(result.insertId),
    phone,
    nickname,
    createdAt: new Date().toISOString(),
  }
}

async function updateUserPassword(userId, newPassword) {
  await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [
    hashPassword(newPassword),
    userId,
  ])
}

async function createSession(user) {
  const token = createToken()
  await db.execute(
    `INSERT INTO sessions (token, user_id, phone)
     VALUES (?, ?, ?)`,
    [token, user.id, user.phone],
  )
  return token
}

async function findUserByToken(token) {
  if (!token) return null
  const [rows] = await db.execute(
    `SELECT u.id, u.phone, u.nickname, u.created_at AS createdAt
     FROM sessions s
     INNER JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.revoked_at IS NULL
     LIMIT 1`,
    [token],
  )
  return rows[0] || null
}

function readAuthToken(req) {
  const header = req.headers['authorization'] || req.headers['Authorization']
  if (!header) return ''
  const raw = String(header).trim()
  if (raw.toLowerCase().startsWith('bearer ')) {
    return raw.slice(7).trim()
  }
  return raw
}

async function authenticate(req, res) {
  const token = readAuthToken(req)
  if (!token) {
    fail(res, 4010, '未登录或登录已过期', 401)
    return null
  }
  const user = await findUserByToken(token)
  if (!user) {
    fail(res, 4010, '登录已失效，请重新登录', 401)
    return null
  }
  return user
}

function normalizeAggregateCount(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

function buildProjectProgress(row) {
  const outlineCount = normalizeAggregateCount(row.outline_count)
  const sceneCount = normalizeAggregateCount(row.scene_count)
  const storyboardCount = normalizeAggregateCount(row.storyboard_count)
  const confirmedImageCount = normalizeAggregateCount(row.confirmed_image_count)
  const confirmedVideoCount = normalizeAggregateCount(row.confirmed_video_count)
  const confirmedAudioCount = normalizeAggregateCount(row.confirmed_audio_count)
  const hasCompletedExport = Boolean(row.latest_export_id)

  const outlineScore = outlineCount > 0 ? 15 : 0
  const sceneScore = sceneCount > 0 ? 15 : 0
  const storyboardScore = sceneCount > 0 ? Math.min(1, storyboardCount / sceneCount) * 20 : 0
  const imageScore = storyboardCount > 0 ? Math.min(1, confirmedImageCount / storyboardCount) * 15 : 0
  const videoScore = storyboardCount > 0 ? Math.min(1, confirmedVideoCount / storyboardCount) * 20 : 0
  const audioScore = confirmedAudioCount > 0 ? 10 : 0
  const exportScore = hasCompletedExport ? 5 : 0
  const percent = Math.max(
    0,
    Math.min(
      100,
      Math.round(outlineScore + sceneScore + storyboardScore + imageScore + videoScore + audioScore + exportScore),
    ),
  )

  let stage = '待创建总纲'
  if (hasCompletedExport) stage = '已导出成片'
  else if (confirmedVideoCount > 0) stage = '视频素材已就绪 · 待导出'
  else if (confirmedImageCount > 0) stage = '静帧素材制作中'
  else if (storyboardCount > 0) stage = '分镜制作中'
  else if (sceneCount > 0) stage = '剧本已就绪 · 待拆分镜'
  else if (outlineCount > 0) stage = '总纲已就绪 · 待拆场景'

  return {
    percent,
    stage,
    isComplete: percent >= 100,
    details: {
      outlineCount,
      sceneCount,
      storyboardCount,
      confirmedImageCount,
      confirmedVideoCount,
      confirmedAudioCount,
      completedExportCount: hasCompletedExport ? 1 : 0,
    },
  }
}

function projectRow(row) {
  const hasProgressAggregates = Object.prototype.hasOwnProperty.call(row, 'outline_count')
  const progress = buildProjectProgress(row)
  const result = {
    id: row.id,
    userId: row.user_id || row.userId,
    name: row.name,
    category: row.category,
    targetDuration: row.target_duration || row.targetDuration,
    narrativeVision: row.narrative_vision || row.narrativeVision,
    visualStyle: row.visual_style || row.visualStyle,
    aspectRatio: row.aspect_ratio || row.aspectRatio,
    status: row.status,
    createdAt: row.created_at || row.createdAt,
    updatedAt: row.updated_at || row.updatedAt,
    latestVideo: row.latest_export_id
      ? {
          exportId: Number(row.latest_export_id),
          videoUrl: row.latest_export_video_url || null,
          coverUrl: row.latest_export_cover_url || null,
          durationSeconds: Number(row.latest_export_duration_seconds) || null,
          createdAt: row.latest_export_created_at || null,
        }
      : null,
    coverUrl: row.latest_export_cover_url || row.latest_project_frame_url || null,
  }
  if (hasProgressAggregates) {
    result.progressPercent = progress.percent
    result.progressStage = progress.stage
    result.progressDetails = progress.details
    result.progressComplete = progress.isComplete
  }
  return result
}

function projectDeletionConfirmationName(project) {
  const name = String(project?.name || '').trim()
  return name || `未命名项目 PF-${String(project?.id || '').padStart(3, '0')}`
}

function decodeAudioDataUrl(value) {
  const match = String(value || '').match(/^data:(audio\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i)
  if (!match) throw new Error('参考音频格式无效')
  const mimeType = match[1].toLowerCase()
  const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
  if (!bytes.length || bytes.length > 15 * 1024 * 1024) {
    throw new Error('参考音频不能为空且不能超过 15MB')
  }
  return { mimeType, bytes }
}

function jsonArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function storyBibleRow(row) {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    versionNo: Number(row.version_no || 1),
    status: row.status || 'draft',
    title: row.title || '',
    logline: row.logline || '',
    audience: row.audience || '',
    emotionalPromise: row.emotional_promise || '',
    worldRules: jsonArray(row.world_rules_json),
    timeline: jsonArray(row.timeline_json),
    locations: jsonArray(row.locations_json),
    characters: jsonArray(row.characters_json),
    relationships: jsonArray(row.relationships_json),
    props: jsonArray(row.props_json),
    mainPlot: row.main_plot || '',
    subplots: jsonArray(row.subplots_json),
    foreshadowing: jsonArray(row.foreshadowing_json),
    lockedFacts: jsonArray(row.locked_facts_json),
    flexibleFacts: jsonArray(row.flexible_facts_json),
    visualSymbols: jsonArray(row.visual_symbols_json),
    qualityReport: row.quality_report_json ? JSON.parse(row.quality_report_json) : null,
    lockedAt: row.locked_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function seasonStructureRow(row) {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    storyBibleId: row.story_bible_id ? Number(row.story_bible_id) : null,
    versionNo: Number(row.version_no || 1),
    status: row.status || 'draft',
    seasonTheme: row.season_theme || '',
    coreConflict: row.core_conflict || '',
    structureType: row.structure_type || '',
    episodeCount: Number(row.episode_count || 1),
    episodes: jsonArray(row.episodes_json),
    foreshadowingPlan: jsonArray(row.foreshadowing_plan_json),
    characterArcs: jsonArray(row.character_arcs_json),
    qualityReport: row.quality_report_json ? JSON.parse(row.quality_report_json) : null,
    lockedAt: row.locked_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function scriptAgentActivityRow(row) {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    userId: Number(row.user_id),
    stageKey: row.stage_key || 'script',
    actionKey: row.action_key || '',
    agentKey: row.agent_key || 'script-agent',
    source: row.source || 'button',
    status: row.status || 'running',
    title: row.title || '',
    summary: row.summary || '',
    context: parseJsonObject(row.context_json),
    result: parseJsonObject(row.result_json),
    reaction: parseJsonObject(row.reaction_json),
    errorText: row.error_text || '',
    idempotencyKey: row.idempotency_key || null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function agentPipelineExecutionRow(row) {
  return {
    id: Number(row.id),
    pipelineRunId: Number(row.pipeline_run_id),
    stageKey: row.stage_key,
    agentKey: row.agent_key,
    status: row.status,
    attempt: Number(row.attempt || 1),
    idempotencyKey: row.idempotency_key,
    inputSnapshot: parseJsonObject(row.input_snapshot_json),
    outputSnapshot: parseJsonObject(row.output_snapshot_json),
    blockers: jsonArray(row.blockers_json),
    errorText: row.error_text || '',
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  }
}

function agentPipelineRunRow(row) {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    userId: Number(row.user_id),
    episodeNo: Number(row.episode_no || 1),
    status: row.status || 'queued',
    currentStage: row.current_stage || AGENT_PIPELINE_STAGES[0].key,
    inputSnapshot: parseJsonObject(row.input_snapshot_json),
    outputSnapshot: row.output_snapshot_json ? parseJsonObject(row.output_snapshot_json) : null,
    errorText: row.error_text || '',
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  }
}

function agentPipelineEventRow(row) {
  return {
    id: Number(row.id),
    pipelineRunId: Number(row.pipeline_run_id),
    executionId: row.execution_id == null ? null : Number(row.execution_id),
    stageKey: row.stage_key,
    agentKey: row.agent_key,
    attempt: Number(row.attempt || 1),
    status: row.status,
    payload: parseJsonObject(row.payload_json),
    createdAt: row.created_at || null,
  }
}

async function loadAgentPipelineView(runId, userId) {
  const [runRows] = await db.execute(
    `SELECT *
     FROM agent_pipeline_runs
     WHERE id = ? AND user_id = ?
     LIMIT 1`,
    [runId, userId],
  )
  if (!runRows[0]) return null
  const [executionRows] = await db.execute(
    `SELECT *
     FROM agent_pipeline_executions
     WHERE pipeline_run_id = ?
     ORDER BY id ASC`,
    [runId],
  )
  const [eventRows] = await db.execute(
    `SELECT *
     FROM agent_pipeline_events
     WHERE pipeline_run_id = ?
     ORDER BY id ASC`,
    [runId],
  )
  return {
    run: agentPipelineRunRow(runRows[0]),
    executions: executionRows.map(agentPipelineExecutionRow),
    events: eventRows.map(agentPipelineEventRow),
  }
}

function createDbAgentPipelineStore(pipelineRunId) {
  return {
    async findByIdempotencyKey(idempotencyKey) {
      const [rows] = await db.execute(
        `SELECT *
         FROM agent_pipeline_executions
         WHERE idempotency_key = ?
         LIMIT 1`,
        [idempotencyKey],
      )
      return rows[0] ? agentPipelineExecutionRow(rows[0]) : null
    },
    async createExecution(input) {
      const [result] = await db.execute(
      `INSERT INTO agent_pipeline_executions
          (pipeline_run_id, stage_key, agent_key, status, attempt, idempotency_key, input_snapshot_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          pipelineRunId,
          input.stageKey,
          input.agentKey,
          input.status || 'queued',
          Number(input.attempt || 1),
          input.idempotencyKey,
          JSON.stringify(input.inputSnapshot || {}),
        ],
      )
      const [rows] = await db.execute(
        `SELECT * FROM agent_pipeline_executions WHERE id = ? LIMIT 1`,
        [result.insertId],
      )
      return agentPipelineExecutionRow(rows[0])
    },
    async updateExecution(id, patch) {
      const updates = []
      const params = []
      const fields = [
        ['status', 'status'],
        ['attempt', 'attempt'],
        ['outputSnapshot', 'output_snapshot_json'],
        ['blockers', 'blockers_json'],
        ['errorText', 'error_text'],
        ['startedAt', 'started_at'],
        ['finishedAt', 'finished_at'],
      ]
      for (const [key, column] of fields) {
        if (patch[key] === undefined) continue
        updates.push(`${column} = ?`)
        if (key === 'outputSnapshot' || key === 'blockers') {
          params.push(JSON.stringify(patch[key] || (key === 'blockers' ? [] : {})))
        } else if (key === 'startedAt' || key === 'finishedAt') {
          params.push(normalizeMysqlDateTime(patch[key]))
        } else {
          params.push(patch[key] || null)
        }
      }
      if (updates.length) {
        params.push(id)
        await db.execute(
          `UPDATE agent_pipeline_executions SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`,
          params,
        )
      }
      const [rows] = await db.execute(
        `SELECT * FROM agent_pipeline_executions WHERE id = ? LIMIT 1`,
        [id],
      )
      return agentPipelineExecutionRow(rows[0])
    },
    async appendEvent(event) {
      const [result] = await db.execute(
        `INSERT INTO agent_pipeline_events
          (pipeline_run_id, execution_id, stage_key, agent_key, attempt, status, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          Number(event.pipelineRunId || pipelineRunId),
          event.executionId || null,
          event.stageKey,
          event.agentKey,
          Number(event.attempt || 1),
          event.status,
          JSON.stringify(event),
        ],
      )
      return { id: Number(result.insertId), ...event }
    },
  }
}

async function updateAgentPipelineRun(runId, patch = {}) {
  const updates = []
  const params = []
  for (const [key, column] of [
    ['status', 'status'],
    ['currentStage', 'current_stage'],
    ['outputSnapshot', 'output_snapshot_json'],
    ['errorText', 'error_text'],
  ]) {
    if (patch[key] === undefined) continue
    updates.push(`${column} = ?`)
    params.push(
      key === 'outputSnapshot'
        ? JSON.stringify(patch[key] || {})
        : patch[key] || null,
    )
  }
  if (!updates.length) return
  params.push(runId)
  await db.execute(
    `UPDATE agent_pipeline_runs SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`,
    params,
  )
}

function normalizeAgentPipelineInput(body = {}) {
  const episodeNo = Math.max(1, Math.min(50, parseId(body.episodeNo) || 1))
  const idempotencyKey = String(body.idempotencyKey || '').trim()
  if (!idempotencyKey) throw new Error('请提供 Agent Pipeline 幂等键')
  return {
    episodeNo,
    idempotencyKey,
    regenerate: body.regenerate === true,
  }
}

function normalizeAgentPipelineStageAction(body = {}) {
  const stageKey = String(body.stageKey || '').trim()
  const stage = getAgentPipelineStage(stageKey)
  if (!stage || stageKey === 'asset-parse' || stageKey === 'storyboard') {
    throw new Error('该阶段不能通过业务动作登记')
  }
  const idempotencyKey = String(body.idempotencyKey || '').trim()
  if (!idempotencyKey) throw new Error('请提供 Agent 阶段动作幂等键')
  return {
    stageKey,
    idempotencyKey,
    status: String(body.status || 'waiting_approval').trim(),
    inputSnapshot: body.inputSnapshot && typeof body.inputSnapshot === 'object' ? body.inputSnapshot : {},
    outputSnapshot: body.outputSnapshot && typeof body.outputSnapshot === 'object' ? body.outputSnapshot : {},
    blockers: Array.isArray(body.blockers) ? body.blockers : [],
    errorText: String(body.errorText || '').trim(),
  }
}

async function registerAgentPipelineStageAction(run, input) {
  const stage = getAgentPipelineStage(input.stageKey)
  const existing = await createDbAgentPipelineStore(run.id).findByIdempotencyKey(input.idempotencyKey)
  if (existing) return existing
  const store = createDbAgentPipelineStore(run.id)
  const executor = createAgentExecutor({
    registry: {
      get(key) {
        if (key !== stage.agentKey) return null
        return {
          key,
          execute: async () => ({
            status: input.status,
            outputSnapshot: input.outputSnapshot,
            blockers: input.blockers,
            errorText: input.errorText,
          }),
        }
      },
    },
    store,
  })
  const result = await executor.execute({
    projectId: run.projectId,
    episodeNo: run.episodeNo,
    pipelineId: String(run.id),
    pipelineRunId: run.id,
    stageKey: stage.key,
    agentKey: stage.agentKey,
    idempotencyKey: input.idempotencyKey,
    inputSnapshot: input.inputSnapshot,
  })
  await updateAgentPipelineRun(run.id, {
    status: result.status,
    currentStage: stage.key,
    outputSnapshot: {
      ...(run.outputSnapshot || {}),
      [stage.key]: result.outputSnapshot || {},
    },
    errorText: result.errorText || result.blockers?.map((item) => item.message).join('；') || '',
  })
  return result
}

async function acquireProjectAssetParserLock(projectId) {
  const connection = await db.getConnection()
  const lockName = `projectdream:asset-parser:${Number(projectId)}`
  try {
    const [rows] = await connection.execute(
      'SELECT GET_LOCK(?, 60) AS acquired',
      [lockName],
    )
    if (Number(rows[0]?.acquired) !== 1) {
      throw new Error('资产解析正在进行，等待项目锁超时；本次没有写入新的资产节点')
    }
    let released = false
    return {
      async release() {
        if (released) return
        released = true
        try {
          await connection.execute('SELECT RELEASE_LOCK(?) AS released', [lockName])
        } finally {
          connection.release()
        }
      },
    }
  } catch (error) {
    connection.release()
    throw error
  }
}

async function persistParsedCharacters(projectId, project, outline, sceneRows, generatedResult = null) {
  const [storyBibleRows] = await db.execute(
    `SELECT * FROM story_bibles WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
    [projectId],
  )
  const storyBible = storyBibleRows[0] ? storyBibleRow(storyBibleRows[0]) : null
  const aiResult = generatedResult || await aiGenerateCharacters({
    project: {
      name: project.name,
      category: project.category,
      visualStyle: project.visual_style,
      narrativeVision: project.narrative_vision,
    },
    outline,
    scenes: sceneRows,
    storyBible,
  })
  const safeCharacters = aiResult.characters
    .map((item, index) => ({
      name: String(item?.name || `角色 ${index + 1}`).trim(),
      roleTag: String(item?.role_tag || (index === 0 ? '主角' : '配角')).trim(),
      personality: String(item?.personality || '性格鲜明，行为动机与剧情目标一致。').trim(),
      appearance: String(item?.appearance || '具有清晰可辨的脸部、发型、体态与服装特征。').trim(),
      costume: normalizeCharacterCostume(item) || null,
      voiceSetting: String(item?.voice_setting || '').trim() || null,
      ageGroup: String(item?.age_group || '').trim() || null,
      gender: String(item?.gender || '').trim() || null,
      voiceStyle: String(item?.voice_style || '').trim() || null,
    }))
    .filter((item) => item.name)

  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    for (const item of safeCharacters) {
      const [existingRows] = await connection.execute(
        `SELECT id FROM characters WHERE project_id = ? AND name = ? ORDER BY id ASC LIMIT 1`,
        [projectId, item.name],
      )
      if (existingRows[0]) {
        await connection.execute(
          `UPDATE characters
           SET role_tag = COALESCE(NULLIF(?, ''), role_tag),
               personality = COALESCE(NULLIF(?, ''), personality),
               appearance = COALESCE(NULLIF(?, ''), appearance),
               costume = COALESCE(NULLIF(?, ''), costume),
               voice_setting = COALESCE(NULLIF(?, ''), voice_setting),
               age_group = COALESCE(NULLIF(?, ''), age_group),
               gender = COALESCE(NULLIF(?, ''), gender),
               voice_style = COALESCE(NULLIF(?, ''), voice_style),
               updated_at = NOW()
           WHERE id = ?`,
          [
            item.roleTag,
            item.personality,
            item.appearance,
            item.costume,
            item.voiceSetting,
            item.ageGroup,
            item.gender,
            item.voiceStyle,
            existingRows[0].id,
          ],
        )
      } else {
        await connection.execute(
          `INSERT INTO characters
            (project_id, name, role_tag, personality, appearance, voice_setting,
             costume, age_group, gender, voice_style, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
          [
            projectId,
            item.name,
            item.roleTag,
            item.personality,
            item.appearance,
            item.costume,
            item.voiceSetting,
            item.ageGroup,
            item.gender,
            item.voiceStyle,
          ],
        )
      }
    }
    await archiveStaleCharacterRecords(connection, projectId, safeCharacters)
    await repairNarrativeRoleCharacterRecords(connection, projectId, outline, sceneRows)
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }

  const [characterRows] = await db.execute(
    `SELECT * FROM characters WHERE project_id = ? AND status <> 'archived' ORDER BY id ASC`,
    [projectId],
  )
  const parserLock = await acquireProjectAssetParserLock(projectId)
  try {
  const desiredCharacterKeys = []
  const desiredSceneKeys = []
  const desiredPropKeys = []
  const sceneCharacterNames = characterRows.map((character) => character.name).filter(Boolean)
  for (const [index, character] of characterRows.entries()) {
    const characterScenes = sceneRows.filter((scene) => [
      scene.title,
      scene.summary,
      scene.content,
      scene.location,
    ].some((value) => String(value || '').includes(character.name)))
    const basePrompt = buildScriptCharacterPrompt({
      character,
      scenes: characterScenes,
      projectVisualStyle: project?.visual_style || '',
      projectCategory: project?.category || '',
    })
    const temporalStates = extractTemporalStates(characterScenes, character.name)
    const variants = temporalStates.length ? temporalStates : ['当前状态']
    for (const [variantIndex, stateLabel] of variants.entries()) {
      const variantPrompt = buildTemporalVariantPrompt(basePrompt.prompt, stateLabel)
      const groupKey = buildTemporalAssetGroupKey({
        nodeType: 'character',
        refId: character.id,
        promptText: variantPrompt,
      })
      const nodeLabel = variants.length > 1 ? `${character.name} · ${stateLabel}` : character.name
      desiredCharacterKeys.push({
        refId: character.id,
        groupKey,
      })
    await db.execute(
      `INSERT INTO asset_nodes
        (project_id, node_type, ref_id, label, appearance_label, prompt_text, turnaround_prompt_text,
         x, y, width, height, group_key, status)
       SELECT ?, 'character', ?, ?, ?, ?, ?, ?, ?, 220, 260, ?, 'active'
       WHERE NOT EXISTS (
         SELECT 1 FROM asset_nodes
         WHERE project_id = ? AND node_type = 'character' AND ref_id = ? AND group_key = ? AND status <> 'archived'
       )`,
      [
        projectId,
        character.id,
        nodeLabel,
        stateLabel,
        variantPrompt,
        basePrompt.turnaroundPrompt,
        80 + ((index + variantIndex) % 4) * 260,
        80 + Math.floor((index + variantIndex) / 4) * 320,
        groupKey,
        projectId,
        character.id,
        groupKey,
      ],
    )
    await db.execute(
      `UPDATE asset_nodes
       SET prompt_text = ?,
           turnaround_prompt_text = ?,
           updated_at = NOW()
       WHERE project_id = ? AND node_type = 'character' AND ref_id = ? AND group_key = ? AND status <> 'archived'`,
      [variantPrompt, basePrompt.turnaroundPrompt, projectId, character.id, groupKey],
    )
    }
  }
  for (const [index, scene] of sceneRows.entries()) {
    if (!String(scene.title || '').trim()) continue
    const scenePrompt = buildScriptScenePrompt({
      scene,
      projectVisualStyle: project?.visual_style || '',
      projectCategory: project?.category || '',
      characterNames: sceneCharacterNames,
    })
    const inferredLocation = inferSceneLocation(scene)
    const inferredTimeOfDay = inferSceneTimeOfDay(scene)
    // 场景状态只能来自场景标题、地点和明确时间字段。
    // 场景正文可能提到“父亲五年前的事故”，不能据此把当前空间归到过去时空。
    const sceneState = resolveTemporalState([
      scene.title,
      scene.location,
      scene.time_of_day,
    ].filter(Boolean).join(' '))
    const sceneLabel = buildSceneDisplayLabel(scene)
    const sceneGroupKey = buildTemporalAssetGroupKey({
      nodeType: 'scene',
      refId: scene.id,
      promptText: `${scenePrompt}\n本资产时空状态：${sceneState.label}`,
    })
    desiredSceneKeys.push({
      refId: scene.id,
      groupKey: sceneGroupKey,
    })
    await db.execute(
      `INSERT INTO asset_nodes
        (project_id, node_type, ref_id, label, appearance_label, prompt_text, x, y, width, height, group_key, status)
       SELECT ?, 'scene', ?, ?, ?, ?, ?, ?, 260, 220, ?, 'active'
       WHERE NOT EXISTS (
         SELECT 1 FROM asset_nodes
         WHERE project_id = ? AND node_type = 'scene' AND ref_id = ? AND group_key = ? AND status <> 'archived'
       )`,
      [
        projectId,
        scene.id,
        sceneLabel,
        [inferredLocation, inferredTimeOfDay].filter(Boolean).join(' · ') || sceneState.label,
        scenePrompt,
        80 + (index % 3) * 300,
        520 + Math.floor(index / 3) * 280,
        sceneGroupKey,
        projectId,
        scene.id,
        sceneGroupKey,
      ],
    )
    await db.execute(
      `UPDATE asset_nodes
       SET prompt_text = ?,
           environment_prompt_text = ?,
           appearance_label = ?,
           updated_at = NOW()
       WHERE project_id = ? AND node_type = 'scene' AND ref_id = ? AND group_key = ? AND status <> 'archived'`,
      [
        scenePrompt,
        buildSceneEnvironmentPrompt({
          scene,
          projectVisualStyle: project?.visual_style || '',
          projectCategory: project?.category || '',
          characterNames: sceneCharacterNames,
        }),
        [inferredLocation, inferredTimeOfDay].filter(Boolean).join(' · ') || null,
        projectId,
        scene.id,
        sceneGroupKey,
      ],
    )
  }
  // storyBible.props is the structured output of the story/asset Agent. Turn
  // it into real prop nodes so storyboard binding can resolve exact node IDs.
  const propAssets = normalizePropAssets(storyBible?.props || [])
  for (const [index, prop] of propAssets.entries()) {
    const groupKey = buildPropAssetGroupKey({ projectId, name: prop.name })
    desiredPropKeys.push({ refId: null, groupKey })
    await db.execute(
      `INSERT INTO asset_nodes
        (project_id, node_type, ref_id, label, appearance_label, prompt_text,
         x, y, width, height, group_key, status)
       SELECT ?, 'prop', NULL, ?, ?, ?, ?, ?, 220, 220, ?, 'active'
       WHERE NOT EXISTS (
         SELECT 1 FROM asset_nodes
         WHERE project_id = ? AND node_type = 'prop' AND group_key = ? AND status <> 'archived'
       )`,
      [
        projectId,
        prop.name,
        prop.purpose,
        prop.prompt,
        80 + (index % 4) * 260,
        1060 + Math.floor(index / 4) * 300,
        groupKey,
        projectId,
        groupKey,
      ],
    )
    await db.execute(
      `UPDATE asset_nodes
       SET label = ?, appearance_label = ?, prompt_text = ?, negative_prompt = ?, updated_at = NOW()
       WHERE project_id = ? AND node_type = 'prop' AND group_key = ? AND status <> 'archived'`,
      [
        prop.name,
        prop.purpose,
        prop.prompt,
        '人物、手持、完整场景、文字、水印、拼贴、重复道具、塑料感、错误结构、悬浮',
        projectId,
        groupKey,
      ],
    )
  }
  const [existingNodes] = await db.execute(
    `SELECT n.id, n.node_type, n.ref_id, n.group_key, n.status,
            (SELECT COUNT(*) FROM asset_node_images ai WHERE ai.asset_node_id = n.id) AS image_count
     FROM asset_nodes n
     WHERE n.project_id = ?`,
    [projectId],
  )
  const syncPlan = buildAssetParserSyncPlan({
    existingNodes,
    characterNodes: desiredCharacterKeys,
    sceneNodes: desiredSceneKeys,
    propNodes: desiredPropKeys,
  })
  if (syncPlan.archiveIds.length) {
    await db.execute(
      `UPDATE asset_nodes
       SET status = 'archived', updated_at = NOW()
       WHERE project_id = ? AND id IN (${syncPlan.archiveIds.map(() => '?').join(',')})`,
      [projectId, ...syncPlan.archiveIds],
    )
  }
  return {
    characterCount: characterRows.length,
    sceneCount: sceneRows.length,
    propCount: propAssets.length,
    assetNodeCount: desiredCharacterKeys.length + desiredSceneKeys.length + desiredPropKeys.length,
    archivedAssetNodeCount: syncPlan.archiveIds.length,
  }
  } finally {
    await parserLock.release()
  }
}

async function archiveStaleCharacterRecords(executor, projectId, currentCharacters) {
  const [existingRows] = await executor.execute(
    `SELECT id, name, status
     FROM characters
     WHERE project_id = ?`,
    [projectId],
  )
  const syncPlan = buildCharacterRecordSyncPlan({
    existingCharacters: existingRows,
    currentCharacters,
  })
  if (!syncPlan.archiveIds.length) return syncPlan
  await executor.execute(
    `UPDATE characters
     SET status = 'archived', updated_at = NOW()
     WHERE project_id = ? AND id IN (${syncPlan.archiveIds.map(() => '?').join(',')})`,
    [projectId, ...syncPlan.archiveIds],
  )
  return syncPlan
}

async function executeAssetParserAgent(context) {
  const [projectRows] = await db.execute(
    `SELECT * FROM projects WHERE id = ? LIMIT 1`,
    [context.projectId],
  )
  const project = projectRows[0]
  if (!project) {
    return { status: 'blocked', blockers: [{ code: 'project-missing', message: '项目不存在，无法解析资产' }] }
  }
  const [sceneRows] = await db.execute(
    `SELECT * FROM script_scenes
     WHERE project_id = ? AND (content IS NOT NULL AND TRIM(content) <> '')
     ORDER BY episode_no ASC, sort_order ASC, scene_no ASC, id ASC`,
    [context.projectId],
  )
  if (!sceneRows.length) {
    return {
      status: 'blocked',
      blockers: [{ code: 'script-required', message: '当前项目还没有可解析的剧本正文，请先完成剧本生成' }],
    }
  }
  const [allSceneRows] = await db.execute(
    `SELECT id, episode_no, scene_no, title, summary, content
     FROM script_scenes WHERE project_id = ?
     ORDER BY episode_no ASC, sort_order ASC, scene_no ASC, id ASC`,
    [context.projectId],
  )
  if (allSceneRows.some((scene) => !String(scene.content || '').trim())) {
    return { status: 'blocked', blockers: [{ code: 'script-incomplete', message: '仍有场景正文未生成或未保存，不能完成资产解析' }] }
  }
  const [outlineRows] = await db.execute(
    `SELECT * FROM story_outlines WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
    [context.projectId],
  )
  const result = await persistParsedCharacters(context.projectId, project, outlineRows[0] || null, sceneRows)
  await persistParsedScriptFingerprint(context.projectId)
  return {
    status: 'waiting_approval',
    outputSnapshot: {
      ...result,
      sourceSceneIds: sceneRows.map((scene) => Number(scene.id)),
      sourceScriptCount: sceneRows.length,
    },
    blockers: [{ code: 'asset-approval-required', message: '角色、场景已解析，请在资产管理中确认后继续生成分镜' }],
  }
}

async function executeStoryboardAgent(context) {
  const workflowGates = await getProjectWorkflowReadiness(Number(context.projectId))
  if (!workflowGates.storyboard.allowed) {
    return { status: 'blocked', blockers: [{ code: workflowGates.storyboard.code, message: workflowGates.storyboard.reason }] }
  }
  const sourceSceneIds = Array.isArray(context.inputSnapshot?.sourceSceneIds)
    ? context.inputSnapshot.sourceSceneIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)
    : []
  const sceneScope = sourceSceneIds.length
    ? `s.id IN (${sourceSceneIds.map(() => '?').join(', ')})`
    : 's.episode_no = ?'
  const sceneScopeParams = sourceSceneIds.length ? sourceSceneIds : [context.episodeNo]
  const [sceneRows] = await db.execute(
    `SELECT s.*, p.user_id AS ownerId, p.name AS projectName, p.category,
            p.narrative_vision, p.visual_style
     FROM script_scenes s
     INNER JOIN projects p ON p.id = s.project_id
     WHERE s.project_id = ? AND ${sceneScope}
       AND s.content IS NOT NULL AND TRIM(s.content) <> ''
     ORDER BY s.sort_order ASC, s.id ASC`,
    [context.projectId, ...sceneScopeParams],
  )
  if (!sceneRows.length) {
    return {
      status: 'blocked',
      blockers: [{ code: 'episode-script-required', message: `第 ${context.episodeNo} 集还没有可生成分镜的剧本正文` }],
    }
  }
  const [characterRows] = await db.execute(
    `SELECT c.id, c.name, c.role_tag, c.personality, c.appearance, c.voice_setting, c.age_group, c.gender,
            c.voice_profile_key, c.voice_locked, c.reference_image_url, c.status,
            COALESCE((SELECT MAX(ci.version_no) FROM character_images ci
                      WHERE ci.character_id = c.id AND ci.status = 'confirmed'), 1) AS asset_version,
            (SELECT ci.id FROM character_images ci
             WHERE ci.character_id = c.id AND ci.status = 'confirmed'
             ORDER BY ci.version_no DESC, ci.id DESC LIMIT 1) AS confirmed_image_id
     FROM characters c WHERE c.project_id = ? AND c.status <> 'archived' ORDER BY c.id ASC`,
    [context.projectId],
  )
  const [assetRows] = await db.execute(
    `SELECT an.id AS asset_node_id, an.node_type, an.ref_id, an.label,
            an.prompt_text AS asset_prompt,
            ai.id AS image_id, ai.version_no, ai.view_set_version, ai.view_index, ai.view_key,
            ai.view_set_type, ai.status, ai.vision_status
     FROM asset_nodes an
     LEFT JOIN asset_node_images ai
       ON ai.asset_node_id = an.id
      AND ai.status = 'confirmed'
      AND (ai.vision_status = 'passed'
           OR (an.node_type = 'scene' AND ai.vision_status = 'skipped'))
     WHERE an.project_id = ? AND an.status <> 'archived'
     ORDER BY an.id ASC, ai.id ASC`,
    [context.projectId],
  )
  let sceneCount = 0
  let shotCount = 0
  const storyboardIds = []
  const preparedScenes = []
  const memoryBySceneId = new Map()
  const allRagDocuments = []
  for (const scene of sceneRows) {
    const assetCatalog = buildStoryboardAssetCatalog(assetRows, scene.id)
    const projectKnowledgeChunks = buildProjectKnowledgeChunks({
      scene,
      characters: characterRows,
      assetCatalog,
    })
    const ragDocuments = buildRagDocuments({
      projectId: context.projectId,
      episodeNo: scene.episode_no || context.episodeNo,
      chunks: projectKnowledgeChunks,
    })
    memoryBySceneId.set(Number(scene.id), { assetCatalog })
    allRagDocuments.push(...ragDocuments)
  }
  const uniqueRagDocuments = [...new Map(
    allRagDocuments.map((document) => [
      JSON.stringify(document.metadata),
      document,
    ]),
  ).values()]
  const [episodeSceneCountRows] = await db.execute(
    `SELECT COUNT(*) AS total
     FROM script_scenes
     WHERE project_id = ? AND episode_no = ?
       AND content IS NOT NULL AND TRIM(content) <> ''`,
    [context.projectId, context.episodeNo],
  )
  const isCompleteEpisodeSnapshot = !sourceSceneIds.length
    || Number(episodeSceneCountRows[0]?.total || 0) === sceneRows.length
  const ragIndex = await indexRagDocuments(uniqueRagDocuments, {
    replaceScopes: isCompleteEpisodeSnapshot,
  })
  if (ragIndex.degraded) {
    console.warn('[rag] storyboard memory snapshot sync degraded', {
      projectId: context.projectId,
      episodeNo: context.episodeNo,
      errorCode: ragIndex.errorCode,
    })
  }
  for (const scene of sceneRows) {
    const assetCatalog = memoryBySceneId.get(Number(scene.id))?.assetCatalog || {
      scenes: [],
      props: [],
      tools: [],
    }
    const [existingRows] = await db.execute(
      `SELECT * FROM storyboards WHERE scene_id = ? ORDER BY sort_order ASC, id ASC`,
      [scene.id],
    )
    if (existingRows.length && !context.regenerate) {
      const boundShots = existingRows.map((shot) => ({
        shot,
        binding: bindStoryboardShotAssets({
          shot,
          sceneId: Number(scene.id),
          characters: characterRows,
          assetRows,
        }),
      }))
      const existingBlockers = boundShots.flatMap(({ binding }) => binding.blockers)
      if (existingBlockers.length) {
        const error = new Error(`分镜资产引用门禁未通过：${existingBlockers.join('；')}`)
        error.statusCode = 409
        throw error
      }
      preparedScenes.push({ scene, shots: boundShots })
      sceneCount += 1
      shotCount += existingRows.length
      storyboardIds.push(...existingRows.map((shot) => Number(shot.id)).filter((id) => id > 0))
      continue
    }
    const ragQuery = await queryRagDocuments({
      projectId: context.projectId,
      episodeId: scene.episode_no || context.episodeNo,
      query: [scene.title, scene.summary, scene.content].filter(Boolean).join(' '),
    })
    if (ragQuery.degraded) {
      console.warn('[rag] storyboard context degraded', {
        projectId: context.projectId,
        episodeNo: context.episodeNo,
        errorCode: ragQuery.errorCode,
      })
    }
    const aiResult = await aiGenerateStoryboards({
      sceneId: Number(scene.id),
      scene,
      scriptContent: scene.content,
      outline: null,
      project: {
        name: scene.projectName,
        visualStyle: scene.visual_style,
        category: scene.category,
        narrativeVision: scene.narrative_vision,
      },
      characters: characterRows,
      assetCatalog,
      ragContext: ragQuery.items,
    })
    const durationContract = validateStoryboardDurationContracts(aiResult.shots, { requireVisibleTimeline: true })
    if (!durationContract.passed) {
      const error = new Error(`分镜时长规划校验未通过：${durationContract.blockers.join('；')}`)
      error.statusCode = 422
      throw error
    }
    const boundShots = aiResult.shots.map((shot) => ({
      shot,
      binding: bindStoryboardShotAssets({
        shot,
        sceneId: Number(scene.id),
      characters: characterRows,
      assetRows,
      }),
    }))
    const blockers = boundShots.flatMap(({ binding }) => binding.blockers)
    if (blockers.length) {
      const error = new Error(`分镜资产引用门禁未通过：${blockers.join('；')}`)
      error.statusCode = 409
      throw error
    }
    preparedScenes.push({ scene, shots: boundShots })
    sceneCount += 1
    shotCount += aiResult.shots.length
  }

  if (shotCount === 0) return resolveStoryboardStageResult({ episodeNo: context.episodeNo, sceneCount })

  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    for (const prepared of preparedScenes) {
      await connection.execute(`DELETE FROM storyboards WHERE scene_id = ?`, [prepared.scene.id])
      for (let index = 0; index < prepared.shots.length; index += 1) {
        const { shot, binding } = prepared.shots[index]
        const reference = binding.assetReference
        const previousShot = prepared.shots[index - 1]?.shot || null
        const usesContinuity = shouldUseStoryboardContinuity({
          tools: shot.tools,
          prompt: [shot.visual_prompt, shot.start_visual_prompt].filter(Boolean).join('\n'),
          assetReference: reference,
        })
        reference.continuityFromShot = usesContinuity && previousShot
          ? String(previousShot.shot_no || '').trim() || null
          : null
        const [result] = await connection.execute(
          `INSERT INTO storyboards
            (scene_id, shot_no, shot_type, camera_angle, composition, duration_seconds,
             character_id, character_name, action_text, dialogue_text, visual_prompt,
             start_visual_prompt, end_visual_prompt, asset_reference_json, sort_order, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
          [
            prepared.scene.id,
            shot.shot_no,
            shot.shot_type,
            shot.camera_angle,
            shot.composition,
            normalizeStoryboardDurationSeconds(shot.duration_seconds),
            matchCharacterId(reference.characterName, characterRows),
            reference.characterName,
            shot.action_text,
            shot.dialogue_text,
             buildStoryboardMentionedPrompt(shot.visual_prompt, reference),
            shot.start_visual_prompt || null,
            shot.end_visual_prompt || null,
            JSON.stringify(reference),
            index,
          ],
        )
        storyboardIds.push(Number(result.insertId))
      }
      await connection.execute(
        `UPDATE script_scenes SET status = 'storyboard_ready', updated_at = NOW() WHERE id = ?`,
        [prepared.scene.id],
      )
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
  await db.execute(
    `UPDATE projects SET status = 'storyboarding', updated_at = NOW() WHERE id = ?`,
    [context.projectId],
  )
  const boundShotCount = preparedScenes.reduce((total, prepared) => total + prepared.shots.length, 0)
  const characterReferenceCount = preparedScenes.reduce(
    (total, prepared) => total + prepared.shots.filter(({ binding }) => Boolean(binding.assetReference.characterId)).length,
    0,
  )
  const sceneViewReferenceCount = preparedScenes.reduce(
    (total, prepared) => total + prepared.shots.filter(({ binding }) => Boolean(binding.assetReference.sceneViewKey)).length,
    0,
  )
  const stageResult = resolveStoryboardStageResult({ episodeNo: context.episodeNo, sceneCount, shotCount, storyboardIds })
  stageResult.outputSnapshot.boundShotCount = boundShotCount
  stageResult.outputSnapshot.characterReferenceCount = characterReferenceCount
  stageResult.outputSnapshot.sceneViewReferenceCount = sceneViewReferenceCount
  return stageResult
}

async function executeStoryAgent(context) {
  const [projectRows] = await db.execute(
    `SELECT * FROM projects WHERE id = ? LIMIT 1`,
    [context.projectId],
  )
  const project = projectRows[0]
  if (!project) {
    return { status: 'blocked', blockers: [{ code: 'project-missing', message: '项目不存在，无法生成故事设定' }] }
  }
  const idea = String(context.inputSnapshot?.idea || project.narrative_vision || '').trim()
  if (!idea) {
    return { status: 'blocked', blockers: [{ code: 'idea-required', message: '当前项目还没有创意，无法生成故事设定' }] }
  }
  const generated = await generateStoryBible(project, {
    idea,
    episodeCount: Math.max(1, Math.min(50, Number(context.inputSnapshot?.episodeCount || 1))),
  })
  const bible = normalizeStoryBibleInput(generated)
  const report = evaluateStoryBible(bible)
  const row = await persistStoryBible(context.projectId, bible, report, false)
  return {
    status: 'waiting_approval',
    outputSnapshot: {
      versionNo: Number(row.version_no),
      characterCount: bible.characters.length,
      locationCount: bible.locations.length,
      storyBibleId: Number(row.id),
    },
    blockers: [{ code: 'story-agent-approval-required', message: '故事设定已生成，请检查并确认后继续分集大纲' }],
  }
}

async function executeSeasonAgent(context) {
  const [projectRows] = await db.execute(
    `SELECT * FROM projects WHERE id = ? LIMIT 1`,
    [context.projectId],
  )
  const project = projectRows[0]
  const [bibleRows] = await db.execute(
    `SELECT * FROM story_bibles WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
    [context.projectId],
  )
  if (!project || !bibleRows[0]) {
    return { status: 'blocked', blockers: [{ code: 'story-bible-required', message: '请先生成并确认故事设定' }] }
  }
  const bible = storyBibleRow(bibleRows[0])
  const generated = await generateSeasonStructure(project, bible, {
    episodeCount: Math.max(1, Math.min(50, Number(context.inputSnapshot?.episodeCount || bible.episodeCount || 1))),
  })
  const season = normalizeSeasonStructureInput(generated)
  const report = evaluateSeasonStructure(season)
  const row = await persistSeasonStructure(
    context.projectId,
    Number(bibleRows[0].id),
    season,
    report,
    false,
  )
  return {
    status: 'waiting_approval',
    outputSnapshot: {
      versionNo: Number(row.version_no),
      episodeCount: season.episodes.length,
      seasonStructureId: Number(row.id),
    },
    blockers: [{ code: 'season-agent-approval-required', message: '分集大纲已生成，请检查每集冲突与结尾钩子' }],
  }
}

async function executeScriptAgent(context) {
  const [seasonRows] = await db.execute(
    `SELECT * FROM season_structures WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
    [context.projectId],
  )
  if (!seasonRows[0]) {
    return { status: 'blocked', blockers: [{ code: 'season-required', message: '请先生成并确认分集大纲' }] }
  }
  const season = jsonArray(seasonRows[0].episodes_json)
  const scenesSpec = seasonEpisodeSceneSpecs(season)
  const [existingScriptRows] = await db.execute(
    `SELECT episode_no, scene_no, title, summary, content, location, time_of_day,
            estimated_duration
     FROM script_scenes
     WHERE project_id = ?
     ORDER BY episode_no ASC, sort_order ASC, scene_no ASC, id ASC`,
    [context.projectId],
  )
  const extractedScriptScenes = extractSceneSpecsFromScriptScenes(existingScriptRows)
  const effectiveScenesSpec = extractedScriptScenes.length ? extractedScriptScenes : scenesSpec
  if (!effectiveScenesSpec.length) {
    return { status: 'blocked', blockers: [{ code: 'season-empty', message: '分集大纲没有可转换的场景，请先补充分集内容' }] }
  }
  const [existingRows] = await db.execute(
    `SELECT COUNT(*) AS total FROM script_scenes WHERE project_id = ?`,
    [context.projectId],
  )
  if (Number(existingRows[0]?.total || 0) > 0) {
    if (!context.inputSnapshot?.regenerate) {
      return { status: 'blocked', blockers: [{ code: 'script-exists', message: '项目已有剧本场景，重新生成前需要明确确认覆盖' }] }
    }
    return { status: 'blocked', blockers: [{ code: 'regenerate-guard', message: '为避免误删已有分镜，剧本覆盖重生成仍需走现有确认接口' }] }
  }
  const connection = await db.getConnection()
  const insertedIds = []
  try {
    await connection.beginTransaction()
    for (let index = 0; index < effectiveScenesSpec.length; index += 1) {
      const spec = effectiveScenesSpec[index]
      const [result] = await connection.execute(
        `INSERT INTO script_scenes
          (project_id, episode_no, outline_id, scene_no, title, summary, spatial_anchors_json, location, time_of_day,
           estimated_duration, sort_order, status)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
        [
          context.projectId,
          Number(spec.episode_no || spec.episodeNo || context.episodeNo || 1),
          spec.scene_no || index + 1,
          spec.title || `场景 ${index + 1}`,
          spec.summary || '',
          spec.spatial_anchors ? JSON.stringify(spec.spatial_anchors) : null,
          spec.location || null,
          spec.time_of_day || null,
          spec.estimated_duration || 120,
          index,
        ],
      )
      insertedIds.push(Number(result.insertId))
    }
    await connection.execute(
      `UPDATE projects SET status = 'scripting', updated_at = NOW() WHERE id = ?`,
      [context.projectId],
    )
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
  const [rows] = await db.execute(
    `SELECT * FROM script_scenes WHERE project_id = ? ORDER BY episode_no ASC, sort_order ASC, scene_no ASC, id ASC`,
    [context.projectId],
  )
  const generated = rows.map(sceneRow)
  return {
    status: 'waiting_approval',
    outputSnapshot: {
      sceneCount: generated.length,
      sceneIds: generated.map((scene) => Number(scene.id)),
    },
    blockers: [{ code: 'script-agent-approval-required', message: '剧本场景已生成，请检查后逐场生成正文' }],
  }
}

const agentRegistry = createAgentRegistry([
  {
    key: 'story-agent',
    label: '故事设定 Agent',
    description: '把创意整理为可确认的故事圣经',
    execute: executeStoryAgent,
  },
  {
    key: 'season-agent',
    label: '分集大纲 Agent',
    description: '把故事设定拆解为分集冲突和结尾钩子',
    execute: executeSeasonAgent,
  },
  {
    key: 'script-agent',
    label: '剧本正文 Agent',
    description: '把分集大纲生成可编辑的剧本场景列表',
    execute: executeScriptAgent,
  },
  {
    key: 'asset-parser-agent',
    label: '资产解析 Agent',
    description: '从确认版剧本提取角色、场景和资产节点',
    execute: executeAssetParserAgent,
  },
    {
      key: 'storyboard-agent',
      label: '分镜脚本 Agent',
      description: '读取剧本与资产上下文生成当前集分镜脚本',
      execute: executeStoryboardAgent,
    },
    {
      key: 'character-agent',
      label: '角色锁定 Agent',
      description: '登记完整角色资产板或兼容旧版三视图的确认阶段',
      execute: async (context) => {
        const [rows] = await db.execute(
          `SELECT COUNT(*) AS total,
                  SUM(CASE
                    WHEN EXISTS (
                      SELECT 1 FROM asset_node_images pack_image
                      WHERE pack_image.asset_node_id = an.id
                        AND pack_image.view_set_type = 'character-asset-pack'
                        AND pack_image.status = 'confirmed'
                        AND pack_image.vision_status = 'passed'
                    ) OR COALESCE(locked_views.confirmed_views, 0) >= 3
                    THEN 1 ELSE 0 END
                  ) AS locked,
                  SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM asset_node_images pack_image
                    WHERE pack_image.asset_node_id = an.id
                      AND pack_image.view_set_type = 'character-asset-pack'
                      AND pack_image.status = 'confirmed'
                      AND pack_image.vision_status = 'passed'
                  ) THEN 1 ELSE 0 END) AS asset_boards
           FROM asset_nodes an
           LEFT JOIN (
           SELECT asset_node_id, COUNT(DISTINCT view_key) AS confirmed_views
             FROM (
               SELECT ai.*,
                      ROW_NUMBER() OVER (
                        PARTITION BY ai.asset_node_id, ai.view_key
                        ORDER BY ai.view_set_version DESC, ai.id DESC
                      ) AS rn
               FROM asset_node_images ai
               WHERE ai.view_set_type = 'character-turnaround'
             ) latest_views
             WHERE latest_views.rn = 1
               AND latest_views.status = 'confirmed'
               AND latest_views.vision_status = 'passed'
             GROUP BY latest_views.asset_node_id
           ) locked_views ON locked_views.asset_node_id = an.id
           WHERE an.project_id = ? AND an.node_type = 'character' AND an.status <> 'archived'`,
          [context.projectId],
        )
        const total = Number(rows[0]?.total || 0)
        const locked = Number(rows[0]?.locked || 0)
        return {
          status: 'waiting_approval',
          outputSnapshot: { total, locked, assetBoards: Number(rows[0]?.asset_boards || 0) },
          blockers: [{
            code: 'character-lock-approval-required',
            message: total && locked < total ? '角色资产板或三视图尚未全部确认，请在资产画布中完成角色锁定' : '角色锁定结果已登记，请确认后继续',
          }],
        }
      },
    },
    {
      key: 'scene-agent',
      label: '场景锁定 Agent',
      description: '登记场景全景基准和九宫格空间锁定阶段',
      execute: async (context) => {
        const [rows] = await db.execute(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN COALESCE(locked_views.confirmed_views, 0) >= 9 THEN 1 ELSE 0 END) AS locked
           FROM asset_nodes an
           LEFT JOIN (
           SELECT asset_node_id, COUNT(DISTINCT view_key) AS confirmed_views
             FROM (
               SELECT ai.*,
                      ROW_NUMBER() OVER (
                        PARTITION BY ai.asset_node_id, ai.view_key
                        ORDER BY ai.view_set_version DESC, ai.id DESC
                      ) AS rn
               FROM asset_node_images ai
               WHERE ai.view_set_type = 'scene-nine-grid'
                 AND ai.status = 'confirmed'
                 AND ai.vision_status IN ('passed', 'skipped')
             ) latest_views
             WHERE latest_views.rn = 1
             GROUP BY latest_views.asset_node_id
           ) locked_views ON locked_views.asset_node_id = an.id
           WHERE an.project_id = ? AND an.node_type = 'scene' AND an.status <> 'archived'`,
          [context.projectId],
        )
        const total = Number(rows[0]?.total || 0)
        const locked = Number(rows[0]?.locked || 0)
        return {
          status: 'waiting_approval',
          outputSnapshot: { total, locked },
          blockers: [{
            code: 'scene-lock-approval-required',
            message: total && locked < total ? '场景九宫格尚未全部确认，请先确认全景并完成空间锁定' : '场景锁定结果已登记，请确认后继续',
          }],
        }
      },
    },
    {
      key: 'voice-agent',
      label: '音色绑定 Agent',
      description: '登记本集角色对白的音色绑定状态',
      execute: async (context) => {
        const [shotRows] = await db.execute(
          `SELECT s.character_name, s.dialogue_text
           FROM storyboards s
           INNER JOIN script_scenes sc ON sc.id = s.scene_id
           WHERE sc.project_id = ? AND sc.episode_no = ?
             AND s.dialogue_text IS NOT NULL AND TRIM(s.dialogue_text) <> ''`,
          [context.projectId, context.episodeNo],
        )
        const [characterRows] = await db.execute(
          `SELECT c.*, vp.profile_key AS active_voice_profile_key
           FROM characters c
           LEFT JOIN voice_profiles vp
             ON vp.profile_key = c.voice_profile_key AND vp.status = 'active'
           WHERE c.project_id = ? AND c.status <> 'archived'`,
          [context.projectId],
        )
        const characters = characterRows.map((row) => ({
          ...characterRow(row),
          voiceProfileKey: row.active_voice_profile_key || '',
        }))
        const speakers = getDialogueSpeakerNames(
          shotRows.map((row) => ({ characterName: row.character_name, dialogueText: row.dialogue_text })),
          characters.map((character) => character.name),
        )
        const characterByName = new Map(characters.map((character) => [character.name, character]))
        const bound = speakers.filter((name) =>
          isCharacterVoiceReady(characterByName.get(name)),
        ).length
        return {
          status: 'waiting_approval',
          outputSnapshot: { speakers: speakers.length, bound },
          blockers: [{
            code: 'voice-approval-required',
            message: speakers.length && bound < speakers.length ? '本集仍有对白角色未绑定有效音色，请在分镜创作页处理' : '本集对白角色音色均已绑定，请确认后继续',
          }],
        }
      },
    },
    {
      key: 'video-agent',
      label: '视频生成 Agent',
      description: '登记本集视频生成任务状态',
      execute: async (context) => {
        const [rows] = await db.execute(
          `SELECT COUNT(*) AS shots,
                  COUNT(DISTINCT CASE WHEN va.id IS NOT NULL THEN s.id END) AS generated
           FROM storyboards s
           INNER JOIN script_scenes sc ON sc.id = s.scene_id
           LEFT JOIN video_assets va ON va.storyboard_id = s.id AND va.status IN ('candidate', 'confirmed')
           WHERE sc.project_id = ? AND sc.episode_no = ?`,
          [context.projectId, context.episodeNo],
        )
        return {
          status: 'waiting_approval',
          outputSnapshot: { shots: Number(rows[0]?.shots || 0), generated: Number(rows[0]?.generated || 0) },
          blockers: [{ code: 'video-approval-required', message: '视频任务状态已登记，请在分镜创作页确认生成结果' }],
        }
      },
    },
    {
      key: 'quality-agent',
      label: '质检 Agent',
      description: '登记本集视频结果质检阶段',
      execute: async (context) => ({
        status: 'waiting_approval',
        outputSnapshot: { episodeNo: context.episodeNo, checked: false },
        blockers: [{ code: 'quality-approval-required', message: '请确认视频预览和质检结果后继续导出' }],
      }),
    },
    {
      key: 'delivery-agent',
      label: '交付 Agent',
      description: '登记本地导出交付阶段',
      execute: async (context) => ({
        status: 'waiting_approval',
        outputSnapshot: { episodeNo: context.episodeNo, exported: false },
        blockers: [{ code: 'delivery-approval-required', message: '请在本地导出页面完成导出后确认交付' }],
      }),
    },
])

async function executePipelineStage(run, stageKey, previousOutputs = {}) {
  const stage = getAgentPipelineStage(stageKey)
  if (!stage) throw new Error(`未知 Agent Pipeline 阶段：${stageKey}`)
  const store = createDbAgentPipelineStore(run.id)
  const executor = createAgentExecutor({ registry: agentRegistry, store })
  const result = await executor.execute({
    projectId: run.projectId,
    episodeNo: run.episodeNo,
    pipelineId: String(run.id),
    pipelineRunId: run.id,
    stageKey: stage.key,
    agentKey: stage.agentKey,
    idempotencyKey: `pipeline-${run.id}:${stage.key}`,
    inputSnapshot: {
      ...run.inputSnapshot,
      previousOutputs,
    },
    previousOutputs,
    regenerate: Boolean(run.inputSnapshot?.regenerate),
  })
  await updateAgentPipelineRun(run.id, {
    status: result.status,
    currentStage: result.status === 'completed'
      ? stageKey === 'asset-parse' ? 'storyboard' : 'completed'
      : stageKey,
    outputSnapshot: {
      ...run.outputSnapshot,
      [stage.key]: result.outputSnapshot || {},
    },
    errorText: result.errorText || result.blockers?.map((item) => item.message).join('；') || '',
  })
  return result
}

async function resumeQueuedAgentPipelines() {
  return drainQueuedAgentPipelines({
    db,
    execute: async (row) => {
      const run = agentPipelineRunRow(row)
      return executePipelineStage(run, run.currentStage, run.outputSnapshot || {})
    },
  })
}

function productionRunRow(row) {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    projectName: row.project_name || null,
    episodeNo: Number(row.episode_no || 1),
    platform: row.platform || '抖音',
    name: row.name || `第 ${Number(row.episode_no || 1)} 集黄金样片`,
    status: row.status || 'created',
    currentStage: row.current_stage || PRODUCTION_RUN_STAGES[0]?.key || '',
    currentCheckpoint: row.current_checkpoint || null,
    pilotMode: row.pilot_mode || 'two-scenes-golden-sample',
    pilotSceneCount: Number(row.pilot_scene_count || 2),
    budget: row.budget === null || row.budget === undefined ? null : Number(row.budget),
    candidatePolicy: parseJsonObject(row.candidate_policy_json),
    successMetrics: jsonArray(row.success_metrics_json),
    inputSnapshot: parseJsonObject(row.input_snapshot_json),
    outputSnapshot: row.output_snapshot_json ? parseJsonObject(row.output_snapshot_json) : null,
    failureCode: row.failure_code || null,
    failureText: row.failure_text || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function productionStageRow(row) {
  return {
    id: Number(row.id),
    stageKey: row.stage_key,
    sequenceNo: Number(row.sequence_no || 0),
    agentKey: row.agent_key,
    status: row.status,
    inputSnapshot: row.input_snapshot_json ? parseJsonObject(row.input_snapshot_json) : null,
    outputSnapshot: row.output_snapshot_json ? parseJsonObject(row.output_snapshot_json) : null,
    errorText: row.error_text || null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
  }
}

function productionCheckpointRow(row) {
  return {
    id: Number(row.id),
    checkpointKey: row.checkpoint_key,
    stageKey: row.stage_key,
    status: row.status,
    decisionNote: row.decision_note || null,
    reviewedAt: row.reviewed_at || null,
  }
}

function productionBlueprintRow(row, emotionBeats = []) {
  return {
    id: Number(row.id),
    productionRunId: Number(row.production_run_id),
    projectId: Number(row.project_id),
    episodeNo: Number(row.episode_no || 1),
    versionNo: Number(row.version_no || 1),
    status: row.status || 'draft',
    blueprint: parseJsonObject(row.blueprint_json),
    qualityReport: row.quality_report_json ? parseJsonObject(row.quality_report_json) : null,
    emotionBeats,
    approvedAt: row.approved_at || null,
  }
}

async function loadProductionRunView(runId, userId = null) {
  const ownerClause = userId === null ? '' : ' AND p.user_id = ?'
  const ownerParams = userId === null ? [runId] : [runId, userId]
  const [runRows] = await db.execute(
    `SELECT pr.*, p.name AS project_name
     FROM production_runs pr
     INNER JOIN projects p ON p.id = pr.project_id
     WHERE pr.id = ?${ownerClause} LIMIT 1`,
    ownerParams,
  )
  if (!runRows[0]) return null
  const run = productionRunRow(runRows[0])
  const [stageRows] = await db.execute(
    `SELECT * FROM production_stage_runs WHERE production_run_id = ? ORDER BY sequence_no ASC, id ASC`,
    [runId],
  )
  const [checkpointRows] = await db.execute(
    `SELECT * FROM production_checkpoints WHERE production_run_id = ? ORDER BY id ASC`,
    [runId],
  )
  const [executionRows] = await db.execute(
    `SELECT id, agent_key, status, model_name, output_json
     FROM production_agent_executions WHERE production_run_id = ? ORDER BY id ASC`,
    [runId],
  )
  const [blueprintRows] = await db.execute(
    `SELECT * FROM episode_blueprints
     WHERE production_run_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
    [runId],
  )
  let blueprint = null
  if (blueprintRows[0]) {
    const [beatRows] = await db.execute(
      `SELECT * FROM production_emotion_beats WHERE blueprint_id = ? ORDER BY sequence_no ASC, id ASC`,
      [blueprintRows[0].id],
    )
    blueprint = productionBlueprintRow(blueprintRows[0], beatRows.map((row) => ({
      id: row.beat_key,
      beatKey: row.beat_key,
      phase: row.phase,
      label: row.label,
      sequenceNo: Number(row.sequence_no || 0),
      durationSeconds: Number(row.duration_seconds || 0),
      emotionStart: row.emotion_start || '',
      emotionProcess: row.emotion_process || '',
      emotionEnd: row.emotion_end || '',
      actionStart: row.action_start || '',
      actionProcess: row.action_process || '',
      actionEnd: row.action_end || '',
      dialoguePlan: row.dialogue_plan || '',
      soundPlan: row.sound_plan || '',
      continuity: row.continuity || '',
      sceneNo: row.scene_no === null ? null : Number(row.scene_no),
      shotCount: Number(row.shot_count || 0),
      status: row.status || 'draft',
    })))
  }
  return {
    run,
    stages: stageRows.map(productionStageRow),
    checkpoints: checkpointRows.map(productionCheckpointRow),
    agentExecutions: executionRows.map((row) => ({
      id: Number(row.id),
      agentKey: row.agent_key,
      status: row.status,
      modelName: row.model_name || null,
      output: row.output_json ? parseJsonObject(row.output_json) : null,
    })),
    blueprint,
  }
}

async function loadProductionStorySources(projectId) {
  const [bibleRows] = await db.execute(
    `SELECT * FROM story_bibles WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
    [projectId],
  )
  const [seasonRows] = await db.execute(
    `SELECT * FROM season_structures WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
    [projectId],
  )
  return {
    bible: bibleRows[0] ? storyBibleRow(bibleRows[0]) : {},
    season: seasonRows[0] ? seasonStructureRow(seasonRows[0]) : {},
  }
}

async function loadProductionScriptSource(projectId, episodeNo) {
  const [rows] = await db.execute(
    `SELECT sb.id AS storyboard_id, ss.scene_no, ss.title AS scene_title,
            sb.shot_no, sb.shot_type, sb.duration_seconds, sb.action_text,
            sb.dialogue_text, sb.visual_prompt, sb.start_visual_prompt, sb.end_visual_prompt
     FROM storyboards sb
     INNER JOIN script_scenes ss ON ss.id = sb.scene_id
     WHERE ss.project_id = ? AND ss.episode_no = ?
     ORDER BY ss.episode_no ASC, ss.scene_no ASC, sb.sort_order ASC, sb.id ASC`,
    [projectId, episodeNo],
  )
  return buildProductionScriptSource(rows, { projectId, episodeNo })
}

async function persistProductionBlueprint({
  runId,
  projectId,
  episodeNo,
  blueprint,
  qualityReport,
  versionNo = null,
} = {}) {
  const resolvedVersion = versionNo || await db.execute(
    `SELECT COALESCE(MAX(version_no), 0) + 1 AS next_version
     FROM episode_blueprints WHERE production_run_id = ?`,
    [runId],
  ).then(([rows]) => Number(rows[0]?.next_version || 1))
  const [result] = await db.execute(
    `INSERT INTO episode_blueprints
      (production_run_id, project_id, episode_no, version_no, status, blueprint_json, quality_report_json)
     VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
    [runId, projectId, episodeNo, resolvedVersion, JSON.stringify(blueprint), JSON.stringify(qualityReport)],
  )
  const [rows] = await db.execute(`SELECT * FROM episode_blueprints WHERE id = ? LIMIT 1`, [result.insertId])
  return rows[0]
}

function storyBibleDbValues(bible) {
  return [
    bible.status || 'draft',
    bible.title || null,
    bible.logline || null,
    bible.audience || null,
    bible.emotionalPromise || null,
    JSON.stringify(bible.worldRules || []),
    JSON.stringify(bible.timeline || []),
    JSON.stringify(bible.locations || []),
    JSON.stringify(bible.characters || []),
    JSON.stringify(bible.relationships || []),
    JSON.stringify(bible.props || []),
    bible.mainPlot || null,
    JSON.stringify(bible.subplots || []),
    JSON.stringify(bible.foreshadowing || []),
    JSON.stringify(bible.lockedFacts || []),
    JSON.stringify(bible.flexibleFacts || []),
    JSON.stringify(bible.visualSymbols || []),
    JSON.stringify(bible.qualityReport || null),
    bible.lockedAt || null,
  ]
}

function seasonStructureDbValues(season) {
  return [
    season.status || 'draft',
    season.seasonTheme || null,
    season.coreConflict || null,
    season.structureType || null,
    Number(season.episodeCount || season.episodes?.length || 1),
    JSON.stringify(season.episodes || []),
    JSON.stringify(season.foreshadowingPlan || []),
    JSON.stringify(season.characterArcs || []),
    JSON.stringify(season.qualityReport || null),
    season.lockedAt || null,
  ]
}

async function persistStoryBible(projectId, bible, report, locked = false) {
  const [versionRows] = await db.execute(
    `SELECT COALESCE(MAX(version_no), 0) AS maxVersion FROM story_bibles WHERE project_id = ?`,
    [projectId],
  )
  const versionNo = Number(versionRows[0]?.maxVersion || 0) + 1
  const values = storyBibleDbValues({
    ...bible,
    status: locked ? 'locked' : 'draft',
    qualityReport: report,
    lockedAt: locked ? new Date() : null,
  })
  const [result] = await db.execute(
    `INSERT INTO story_bibles
      (project_id, version_no, status, title, logline, audience, emotional_promise,
       world_rules_json, timeline_json, locations_json, characters_json, relationships_json,
       props_json, main_plot, subplots_json, foreshadowing_json, locked_facts_json,
       flexible_facts_json, visual_symbols_json, quality_report_json, locked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [projectId, versionNo, ...values],
  )
  const [rows] = await db.execute(`SELECT * FROM story_bibles WHERE id = ?`, [result.insertId])
  return rows[0]
}

async function persistSeasonStructure(projectId, storyBibleId, season, report, locked = false) {
  const [versionRows] = await db.execute(
    `SELECT COALESCE(MAX(version_no), 0) AS maxVersion FROM season_structures WHERE project_id = ?`,
    [projectId],
  )
  const versionNo = Number(versionRows[0]?.maxVersion || 0) + 1
  const values = seasonStructureDbValues({
    ...season,
    status: locked ? 'locked' : 'draft',
    qualityReport: report,
    lockedAt: locked ? new Date() : null,
  })
  const [result] = await db.execute(
    `INSERT INTO season_structures
      (project_id, story_bible_id, version_no, status, season_theme, core_conflict,
       structure_type, episode_count, episodes_json, foreshadowing_plan_json,
       character_arcs_json, quality_report_json, locked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [projectId, storyBibleId, versionNo, ...values],
  )
  const [rows] = await db.execute(`SELECT * FROM season_structures WHERE id = ?`, [result.insertId])
  return rows[0]
}

function outlineRow(row) {
  let scenes = []
  let acts = []
  try {
    const raw = row.raw_json ? JSON.parse(row.raw_json) : {}
    scenes = Array.isArray(raw.scenes) ? raw.scenes : []
    acts = Array.isArray(raw.acts) ? raw.acts : []
  } catch {
    scenes = []
    acts = []
  }
  return {
    id: row.id,
    projectId: row.project_id || row.projectId,
    versionNo: row.version_no || row.versionNo,
    title: row.title,
    logline: row.logline,
    premise: row.premise,
    act1Text: row.act1_text || row.act1Text,
    act2Text: row.act2_text || row.act2Text,
    act3Text: row.act3_text || row.act3Text,
    // P3: 总纲阶段落定的视觉风格，作为后续场景拆解 / 分镜的视觉基线
    visualStyle: row.visual_style || row.visualStyle || null,
    acts,
    scenes,
    createdAt: row.created_at || row.createdAt,
  }
}

function sceneRow(row) {
  let spatialAnchors = row.spatial_anchors_json || row.spatial_anchors || null
  if (typeof spatialAnchors === 'string') {
    try {
      spatialAnchors = JSON.parse(spatialAnchors)
    } catch {
      spatialAnchors = null
    }
  }
  return {
    id: row.id,
    projectId: row.project_id || row.projectId,
    episodeNo: row.episode_no || row.episodeNo || 1,
    outlineId: row.outline_id || row.outlineId,
    sceneNo: row.scene_no || row.sceneNo,
    title: row.title,
    summary: row.summary,
    content: row.content,
    spatialAnchors,
    mood: row.mood,
    location: row.location,
    timeOfDay: row.time_of_day || row.timeOfDay,
    estimatedDuration: row.estimated_duration || row.estimatedDuration,
    sortOrder: row.sort_order || row.sortOrder,
    status: row.status,
    createdAt: row.created_at || row.createdAt,
    updatedAt: row.updated_at || row.updatedAt,
  }
}

function storyboardRow(row) {
  let assetReference = row.asset_reference_json || row.assetReference || null
  if (typeof assetReference === 'string') {
    try {
      assetReference = JSON.parse(assetReference)
    } catch {
      assetReference = null
    }
  }
  return {
    id: row.id,
    sceneId: row.scene_id || row.sceneId,
    shotNo: row.shot_no || row.shotNo,
    shotType: row.shot_type || row.shotType,
    cameraAngle: row.camera_angle || row.cameraAngle,
    composition: row.composition,
    durationSeconds: row.duration_seconds || row.durationSeconds,
    characterId: row.character_id || row.characterId || null,
    characterName: row.character_name || row.characterName,
    actionText: row.action_text || row.actionText,
    dialogueText: row.dialogue_text || row.dialogueText,
    visualPrompt: sanitizeStoryboardPrompt(row.visual_prompt || row.visualPrompt, {
      characterNames: [row.character_name || row.characterName],
    }),
    performance: assetReference?.performance || null,
    gazePlan: assetReference?.gazePlan || assetReference?.performance?.gazePlan || null,
    soundPlan: assetReference?.soundPlan || assetReference?.performance?.soundPlan || null,
    startVisualPrompt: row.start_visual_prompt || row.startVisualPrompt || '',
    endVisualPrompt: row.end_visual_prompt || row.endVisualPrompt || '',
    assetReference,
    imageUrl: row.image_url || row.imageUrl,
    endImageUrl: row.end_image_url || row.endImageUrl || '',
    videoUrl: normalizeGeneratedMediaUrl(row.video_url || row.videoUrl, PUBLIC_BASE_URL),
    sortOrder: row.sort_order || row.sortOrder,
    status: row.status,
    createdAt: row.created_at || row.createdAt,
    updatedAt: row.updated_at || row.updatedAt,
  }
}

function imageAssetRow(row) {
  let characterSnapshot = row.character_snapshot ?? row.characterSnapshot ?? null
  if (typeof characterSnapshot === 'string') {
    try {
      characterSnapshot = JSON.parse(characterSnapshot)
    } catch {
      characterSnapshot = null
    }
  }
  return {
    id: row.id,
    storyboardId: row.storyboard_id || row.storyboardId,
    versionNo: row.version_no || row.versionNo,
    frameRole: normalizeFrameRole(row.frame_role || row.frameRole),
    imageUrl: row.image_url || row.imageUrl,
    thumbnailUrl: row.thumbnail_url || row.thumbnailUrl,
    promptSnapshot: row.prompt_snapshot || row.promptSnapshot,
    negativePrompt: row.negative_prompt || row.negativePrompt,
    characterSnapshot,
    modelName: row.model_name || row.modelName,
    status: row.status,
    confirmedAt: row.confirmed_at || row.confirmedAt,
    createdAt: row.created_at || row.createdAt,
  }
}

function normalizeFrameRole(value) {
  const role = String(value || '').trim().toLowerCase()
  if (role === 'start' || role === 'end') return role
  return 'primary'
}

function frameRoleLabel(role) {
  const normalized = normalizeFrameRole(role)
  if (normalized === 'start') return '起始帧'
  if (normalized === 'end') return '结束帧'
  return '普通静帧'
}

function frameRolePromptFallback(shot, role) {
  const normalized = normalizeFrameRole(role)
  const base = String(shot.visual_prompt || shot.action_text || '').trim()
  if (normalized === 'start') {
    return [
      String(shot.start_visual_prompt || '').trim(),
      base,
      '起始帧：建立动作开始前的人物姿态、空间位置、镜头构图和光影氛围，为后续动作预留运动空间。',
    ].filter(Boolean).join('，')
  }
  if (normalized === 'end') {
    return [
      String(shot.end_visual_prompt || '').trim(),
      base,
      '结束帧：表现动作完成后的最终姿态、情绪变化和空间位置，保持同一角色外貌、服装、场景和光线连续。',
    ].filter(Boolean).join('，')
  }
  return base
}

function buildTwoKeyframeVideoPrompt({ prompt, shot, startImage, endImage }) {
  const parts = [
    String(prompt || startImage?.prompt_snapshot || shot.visual_prompt || '').trim(),
    '视频需从起始帧的构图和人物状态自然发展，不切镜头，不新增人物，角色外貌和服装保持一致。',
  ]
  const endPrompt = String(endImage?.prompt_snapshot || shot.end_visual_prompt || '').trim()
  if (endPrompt) {
    parts.push(`动作终点参考：${endPrompt}`)
  }
  if (endImage?.image_url) {
    parts.push('结束帧已确认，请让人物动作、表情和镜头运动朝结束帧描述靠近。')
  }
  return parts.filter(Boolean).join(' ')
}

function buildReferenceAudioPromptContext(voiceRows = [], referenceAudioUrls = []) {
  const rows = (Array.isArray(voiceRows) ? voiceRows : [])
    .filter((row) => row.voice_locked && resolveReferenceAudioUrl(row))
  const lines = rows.flatMap((row) => {
    const url = resolveReferenceAudioUrl(row)
    const index = referenceAudioUrls.indexOf(url)
    if (index < 0) return []
    return [`音色@${String(row.character_name || '当前角色').trim()} 使用 <Audio ${index + 1}>；对白文本必须逐字使用本镜已写入的台词；人物发声、停顿、重音、情绪和嘴型动作必须与对白时序严格同步，禁止无声说话、错配台词或口型滞后；官方 Agnes 将参考音频用于声音特征、节奏和情绪参考。`]
  })
  return lines.length
    ? `官方 Agnes 参考音频绑定：\n${lines.join('\n')}`
    : ''
}

function inferStorageKeyFromUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim())
    const pathname = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
    return parsed.hostname.includes('.cos.') && pathname ? pathname : ''
  } catch {
    return ''
  }
}

function resolveReferenceAudioUrl(row = {}) {
  const key = String(row.reference_audio_storage_key || row.referenceAudioStorageKey || '').trim()
    || inferStorageKeyFromUrl(row.reference_audio_url || row.referenceAudioUrl)
  if (key) {
    try {
      return objectStorage.createSignedUrl({
        key,
        expiresInSeconds: Math.max(
          900,
          Number(process.env.VIDEO_REFERENCE_AUDIO_SIGNED_URL_TTL_SECONDS) || 3600,
        ),
      })
    } catch {
      // Keep the historical URL for old/non-COS records.
    }
  }
  return String(row.reference_audio_url || row.referenceAudioUrl || '').trim()
}

function videoAssetRow(row) {
  const storageKey = row.storage_key || row.storageKey || null
  return {
    id: row.id,
    storyboardId: row.storyboard_id || row.storyboardId,
    imageAssetId: row.image_asset_id || row.imageAssetId,
    versionNo: row.version_no || row.versionNo,
    videoUrl: storageKey
      ? resolveObjectStorageUrl(storageKey, row.video_url || row.videoUrl)
      : normalizeGeneratedMediaUrl(row.video_url || row.videoUrl, PUBLIC_BASE_URL),
    storageKey,
    endFrameUrl: row.end_frame_storage_key
      ? resolveObjectStorageUrl(row.end_frame_storage_key, row.end_frame_url)
      : normalizeGeneratedMediaUrl(row.end_frame_url || row.endFrameUrl, PUBLIC_BASE_URL),
    endFrameStorageKey: row.end_frame_storage_key || row.endFrameStorageKey || null,
    thumbnailUrl: normalizeGeneratedMediaUrl(row.thumbnail_url || row.thumbnailUrl, PUBLIC_BASE_URL),
    motionMode: row.motion_mode || row.motionMode,
    durationSeconds: row.duration_seconds || row.durationSeconds,
    modelName: row.model_name || row.modelName,
    audioAssetId: row.audio_asset_id || row.audioAssetId || null,
    generationJobId: row.generation_job_id || row.generationJobId || null,
    qualityReport: safeJsonParse(row.quality_report_json || row.qualityReportJson, null),
    sourceType: row.source_type || row.sourceType || 'generated_video',
    status: row.status,
    confirmedAt: row.confirmed_at || row.confirmedAt,
    createdAt: row.created_at || row.createdAt,
  }
}

function audioAssetRow(row) {
  const storageKey = row.storage_key || row.storageKey || null
  return {
    id: row.id,
    projectId: row.project_id || row.projectId,
    trackType: row.track_type || row.trackType,
    sceneId: row.scene_id || row.sceneId || null,
    storyboardId: row.storyboard_id || row.storyboardId || null,
    shotNo: row.shot_no || row.storyboard_shot_no || row.shotNo || null,
    sceneNo: row.scene_no || row.sceneNo || null,
    sceneTitle: row.scene_title || row.sceneTitle || null,
    characterId: row.character_id || row.characterId || null,
    characterName: row.character_name || row.characterName || null,
    versionNo: row.version_no || row.versionNo,
    startOffsetSeconds: Number(row.start_offset_seconds ?? row.startOffsetSeconds ?? 0),
    title: resolveAudioSourceTitle(row),
    audioUrl: storageKey
      ? resolveObjectStorageUrl(storageKey, row.audio_url || row.audioUrl)
      : row.audio_url || row.audioUrl,
    storageKey,
    durationSeconds: row.duration_seconds || row.durationSeconds,
    voiceName: row.voice_name || row.voiceName,
    modelName: row.model_name || row.modelName,
    voiceProfileKey: row.voice_profile_key || row.voiceProfileKey || null,
    voiceInstructions: row.voice_instructions || row.voiceInstructions || null,
    status: row.status,
    confirmedAt: row.confirmed_at || row.confirmedAt,
    createdAt: row.created_at || row.createdAt,
  }
}

function exportRecordRow(row) {
  let config = null
  try {
    config = row.config_json ? JSON.parse(row.config_json) : null
  } catch {
    config = null
  }

  const storageKey = row.storage_key || row.storageKey || null
  const subtitleStorageKey = row.subtitle_storage_key || row.subtitleStorageKey || null
  if (config && subtitleStorageKey) {
    config.subtitleFile = resolveObjectStorageUrl(subtitleStorageKey, config.subtitleFile || null)
  }

  return {
    id: row.id,
    projectId: row.project_id || row.projectId,
    status: row.status,
    videoUrl: storageKey
      ? resolveObjectStorageUrl(storageKey, row.video_url || row.videoUrl)
      : row.video_url || row.videoUrl,
    storageKey,
    subtitleStorageKey,
    coverUrl: row.cover_url || row.coverUrl,
    durationSeconds: row.duration_seconds || row.durationSeconds,
    config,
    sourceCount: row.source_count || row.sourceCount || 0,
    readyCount: row.ready_count || row.readyCount || 0,
    missingCount: row.missing_count || row.missingCount || 0,
    createdAt: row.created_at || row.createdAt,
    updatedAt: row.updated_at || row.updatedAt,
  }
}

const FINAL_EDIT_AUDIO_TRACKS = ['dialogue', 'narration', 'music', 'sfx']

function clampVolume(value, fallback = 100) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(100, Math.round(n)))
}

function buildDefaultFinalEditAudioMix(audioTracks) {
  return Object.fromEntries(
    FINAL_EDIT_AUDIO_TRACKS.map((trackKey) => [
      trackKey,
      {
        enabled: Array.isArray(audioTracks?.[trackKey]) && audioTracks[trackKey].length > 0,
        volume: 100,
      },
    ]),
  )
}

function normalizeFinalEditDraft(rawDraft, context = {}) {
  const draft = parseJsonObject(rawDraft, {})
  const contextItems = Array.isArray(context.videoItems) ? context.videoItems : []
  const allowedStoryboardIds = new Set(
    contextItems
      .map((item) => parseId(item.storyboardId))
      .filter((storyboardId) => storyboardId > 0),
  )

  const seenStoryboardIds = new Set()
  const videoClips = []
  const rawVideoClips = Array.isArray(draft.videoClips) ? draft.videoClips : []
  for (const [index, item] of rawVideoClips.entries()) {
    const storyboardId = parseId(item?.storyboardId)
    if (!storyboardId) continue
    if (allowedStoryboardIds.size && !allowedStoryboardIds.has(storyboardId)) continue
    if (seenStoryboardIds.has(storyboardId)) continue
    seenStoryboardIds.add(storyboardId)
    const transitionType = ['cut', 'fade', 'dip', 'push'].includes(String(item?.transition?.type || '').trim().toLowerCase())
      ? String(item.transition.type).trim().toLowerCase()
      : 'cut'
    const sourceItem = contextItems.find((candidate) => parseId(candidate.storyboardId) === storyboardId)
    const sourceDuration = Math.max(
      0.25,
      Number(sourceItem?.sourceDurationSeconds || sourceItem?.durationSeconds || 4) || 4,
    )
    const trimStartSeconds = Math.max(
      0,
      Math.min(Number(item?.trimStartSeconds) || 0, Math.max(0, sourceDuration - 0.25)),
    )
    const trimEndSeconds = Math.max(
      trimStartSeconds + 0.25,
      Math.min(Number(item?.trimEndSeconds) || sourceDuration, sourceDuration),
    )
    videoClips.push({
      storyboardId,
      enabled: item?.enabled !== false,
      order: parseId(item?.order) || index + 1,
      videoAssetId: parseId(item?.videoAssetId) || null,
      trimStartSeconds: Number(trimStartSeconds.toFixed(3)),
      trimEndSeconds: Number(trimEndSeconds.toFixed(3)),
      transition: {
        type: transitionType,
        durationSeconds: transitionType === 'cut'
          ? 0
          : Number(Math.max(0.04, Math.min(2, Number(item?.transition?.durationSeconds) || 0.18)).toFixed(3)),
        manual: item?.transition?.manual === true,
      },
      transitionManual: item?.transition?.manual === true,
    })
  }

  const defaultAudioMix = buildDefaultFinalEditAudioMix(context.audioTracks)
  const rawAudioMix = parseJsonObject(draft.audioMix, {})
  const audioMix = Object.fromEntries(
    FINAL_EDIT_AUDIO_TRACKS.map((trackKey) => {
      const rawTrack = parseJsonObject(rawAudioMix[trackKey], {})
      const fallback = defaultAudioMix[trackKey]
      return [
        trackKey,
        {
          enabled: rawTrack.enabled !== undefined ? rawTrack.enabled !== false : fallback.enabled,
          volume: clampVolume(rawTrack.volume, fallback.volume),
        },
      ]
    }),
  )

  return {
    videoClips,
    audioMix,
  }
}

async function fetchFinalEditDraft(projectId) {
  const [rows] = await db.execute(
    `SELECT * FROM final_edit_drafts WHERE project_id = ? LIMIT 1`,
    [projectId],
  )
  return rows[0] || null
}

function buildFinalEditValidation(videoItems, audioTracks, audioMix, projectCompleteness) {
  const enabledVideoItems = videoItems.filter((item) => item.enabled !== false)
  const confirmedVideoCount = videoItems.filter((item) => item.sourceType === 'video' && Boolean(item.videoUrl)).length
  const availableAudioTrackCount = FINAL_EDIT_AUDIO_TRACKS.filter(
    (trackKey) => (audioTracks[trackKey] || []).length > 0,
  ).length
  const enabledAudioTrackCount = FINAL_EDIT_AUDIO_TRACKS.filter(
    (trackKey) => (audioTracks[trackKey] || []).length > 0 && audioMix[trackKey]?.enabled !== false,
  ).length

  const totalStoryboardCount = Number(projectCompleteness?.totalStoryboardCount || 0)
  const missingStoryboardSceneCount = Number(projectCompleteness?.missingStoryboardSceneCount || 0)
  const missingVideoCount = Math.max(totalStoryboardCount - confirmedVideoCount, 0)
  const blockingIssues = []
  const warningIssues = []

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
  }

  if (missingVideoCount > 0 && videoItems.length > 0) {
    warningIssues.push({
      code: 'mixed-media',
      message: `还有 ${missingVideoCount} 个分镜没有确认媒体，本次导出将使用已确认视频和静帧完成混合成片。`,
    })
  }

  if (videoItems.length > 0 && enabledVideoItems.length === 0) {
    blockingIssues.push({
      code: 'all-video-disabled',
      message: '当前所有视频片段都被禁用了，导出前至少保留一个启用片段。',
    })
  }

  if (availableAudioTrackCount === 0) {
    warningIssues.push({
      code: 'missing-audio',
      message: '当前还没有已确认音频，成片可先预览视频，但导出前建议先补齐音频主版本。',
    })
  } else if (enabledAudioTrackCount === 0) {
    warningIssues.push({
      code: 'all-audio-disabled',
      message: '当前所有音频轨都被关闭了，如需带音频导出，请至少开启一个轨道。',
    })
  }

  const enabledDurationSeconds = enabledVideoItems.reduce(
    (sum, item) => sum + (Number(item.durationSeconds) || 0),
    0,
  )

  return {
    canExport: blockingIssues.length === 0,
    enabledVideoCount: enabledVideoItems.length,
    enabledVideoDurationSeconds: enabledDurationSeconds,
    availableAudioTrackCount,
    enabledAudioTrackCount,
    totalStoryboardCount,
    confirmedVideoCount,
    missingVideoCount,
    missingStoryboardSceneCount,
    blockingIssues,
    warningIssues,
  }
}

function assetItemRow(row) {
  return {
    id: row.id,
    assetType: row.assetType,
    projectId: row.projectId,
    sceneId: row.sceneId || null,
    sceneNo: row.sceneNo || null,
    sceneTitle: row.sceneTitle || null,
    storyboardId: row.storyboardId || null,
    shotNo: row.shotNo || null,
    characterId: row.characterId || null,
    characterName: row.characterName || null,
    name: row.name,
    subtitle: row.subtitle || null,
    status: row.status,
    previewUrl: row.previewUrl || null,
    videoUrl: row.videoUrl || null,
    audioUrl: row.audioUrl || null,
    trackType: row.trackType || null,
    durationSeconds: row.durationSeconds || null,
    voiceName: row.voiceName || null,
    confirmedAt: row.confirmedAt || null,
    versionNo: row.versionNo || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  }
}

function projectTaskItemRow(row) {
  return {
    taskKey: row.taskKey,
    taskType: row.taskType,
    sourceId: row.sourceId,
    projectId: row.projectId,
    sceneId: row.sceneId || null,
    sceneNo: row.sceneNo || null,
    sceneTitle: row.sceneTitle || null,
    storyboardId: row.storyboardId || null,
    characterId: row.characterId || null,
    shotNo: row.shotNo || null,
    versionNo: row.versionNo || null,
    title: row.title,
    subtitle: row.subtitle || null,
    status: row.status,
    previewUrl: row.previewUrl || null,
    fileUrl: row.fileUrl || null,
    detailText: row.detailText || null,
    runtimeStatus: row.runtimeStatus || null,
    progressPercent: row.progressPercent ?? null,
    runtimeMessage: row.runtimeMessage || null,
    errorText: row.errorText || null,
    canRetry: Boolean(row.canRetry),
    canCancel: Boolean(row.canCancel),
    confirmedAt: row.confirmedAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  }
}

function normalizeTaskText(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || /^\?+$/.test(text)) {
    return ''
  }
  return text
}

function normalizeRuntimeStatus(value) {
  const status = String(value || '')
    .trim()
    .toLowerCase()
  return ['queued', 'running', 'success', 'failed', 'canceled'].includes(status) ? status : ''
}

function clampPercent(value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(100, Math.round(n)))
}

function parseTaskKey(taskKey) {
  const match = String(taskKey || '')
    .trim()
    .match(/^(image|video|audio|export)-(\d+)$/)
  if (!match) return null
  return {
    taskKey: match[0],
    taskType: match[1],
    sourceId: Number(match[2]),
  }
}

function baseTaskRuntimeSnapshot(item) {
  if (item.status === 'archived') {
    return {
      runtimeStatus: 'canceled',
      progressPercent: 100,
      runtimeMessage: '该任务候选已归档，可在需要时重新发起。',
      errorText: null,
    }
  }

  if (!item.fileUrl) {
    return {
      runtimeStatus: 'failed',
      progressPercent: 100,
      runtimeMessage: '任务结果不可用，请检查来源模块后重试。',
      errorText: '当前记录缺少可用输出文件。',
    }
  }

  if (item.status === 'confirmed') {
    return {
      runtimeStatus: 'success',
      progressPercent: 100,
      runtimeMessage: '任务已完成，当前结果已被确认为主版本。',
      errorText: null,
    }
  }

  if (item.status === 'completed') {
    return {
      runtimeStatus: 'success',
      progressPercent: 100,
      runtimeMessage: '任务已完成，当前结果可直接用于后续交付。',
      errorText: null,
    }
  }

  return {
    runtimeStatus: 'success',
    progressPercent: 100,
    runtimeMessage: '任务已完成，当前保留的是候选结果。',
    errorText: null,
  }
}

function resolveRuntimeStateSnapshot(runtimeRow, fallbackSnapshot) {
  if (!runtimeRow) {
    return {
      ...fallbackSnapshot,
      updatedAt: null,
    }
  }

  const baseUpdatedAt = runtimeRow.updated_at || runtimeRow.created_at || null
  const updatedAtMs = baseUpdatedAt ? new Date(baseUpdatedAt).getTime() : 0
  const elapsedMs = updatedAtMs > 0 ? Date.now() - updatedAtMs : 0
  const runtimeStatus = normalizeRuntimeStatus(runtimeRow.runtime_status) || fallbackSnapshot.runtimeStatus
  const progressPercent = clampPercent(runtimeRow.progress_percent, fallbackSnapshot.progressPercent)
  const errorText = normalizeTaskText(runtimeRow.error_text) || null

  if (runtimeStatus === 'queued') {
    if (elapsedMs >= 10000) {
      return {
        runtimeStatus: 'success',
        progressPercent: 100,
        runtimeMessage: 'Mock 重试流程已完成，当前继续指向该任务最近一次可用结果。',
        errorText: null,
        updatedAt: baseUpdatedAt,
      }
    }

    if (elapsedMs >= 4000) {
      const progress = 35 + Math.min(55, Math.floor((elapsedMs - 4000) / 120))
      return {
        runtimeStatus: 'running',
        progressPercent: clampPercent(progress, 45),
        runtimeMessage: '任务正在执行中，系统正在模拟生成过程。',
        errorText: null,
        updatedAt: baseUpdatedAt,
      }
    }

    return {
      runtimeStatus: 'queued',
      progressPercent: Math.max(8, progressPercent || 10),
      runtimeMessage: '任务已进入队列，等待开始执行。',
      errorText: null,
      updatedAt: baseUpdatedAt,
    }
  }

  if (runtimeStatus === 'running') {
    if (elapsedMs >= 8000) {
      return {
        runtimeStatus: 'success',
        progressPercent: 100,
        runtimeMessage: 'Mock 任务已完成，当前继续指向该任务最近一次可用结果。',
        errorText: null,
        updatedAt: baseUpdatedAt,
      }
    }

    const progress = Math.max(progressPercent || 45, 45 + Math.min(45, Math.floor(elapsedMs / 140)))
    return {
      runtimeStatus: 'running',
      progressPercent: clampPercent(progress, 55),
      runtimeMessage: '任务执行中，可以在结束前取消本次模拟运行。',
      errorText: null,
      updatedAt: baseUpdatedAt,
    }
  }

  if (runtimeStatus === 'failed') {
    return {
      runtimeStatus: 'failed',
      progressPercent: 100,
      runtimeMessage: '任务执行失败，可以查看原因后重试。',
      errorText: errorText || fallbackSnapshot.errorText || '任务执行失败，请稍后重试。',
      updatedAt: baseUpdatedAt,
    }
  }

  if (runtimeStatus === 'canceled') {
    return {
      runtimeStatus: 'canceled',
      progressPercent: clampPercent(progressPercent, 100),
      runtimeMessage: '任务已取消，当前保留原有结果记录。',
      errorText: null,
      updatedAt: baseUpdatedAt,
    }
  }

  return {
    runtimeStatus: 'success',
    progressPercent: 100,
    runtimeMessage: fallbackSnapshot.runtimeMessage,
    errorText: null,
    updatedAt: baseUpdatedAt,
  }
}

function decorateProjectTaskItem(item, runtimeRow) {
  const fallbackSnapshot = baseTaskRuntimeSnapshot(item)
  const runtimeSnapshot = resolveRuntimeStateSnapshot(runtimeRow, fallbackSnapshot)
  const runtimeStatus = runtimeSnapshot.runtimeStatus || fallbackSnapshot.runtimeStatus
  const canCancel = runtimeStatus === 'queued' || runtimeStatus === 'running'

  return projectTaskItemRow({
    ...item,
    runtimeStatus,
    progressPercent: runtimeSnapshot.progressPercent,
    runtimeMessage: runtimeSnapshot.runtimeMessage,
    errorText: runtimeSnapshot.errorText,
    canRetry: !canCancel,
    canCancel,
    updatedAt: runtimeSnapshot.updatedAt || item.updatedAt || item.confirmedAt || item.createdAt || null,
  })
}

async function fetchTaskRuntimeRows(projectId) {
  const [rows] = await db.execute(
    `SELECT *
     FROM task_runtime_states
     WHERE project_id = ?`,
    [projectId],
  )
  return rows
}

async function fetchTaskOwnerRecord(taskType, sourceId, userId) {
  if (taskType === 'image') {
    const [rows] = await db.execute(
      `SELECT ia.id,
              ia.storyboard_id,
              sc.project_id,
              p.user_id AS owner_id
       FROM image_assets ia
       INNER JOIN storyboards s ON s.id = ia.storyboard_id
       INNER JOIN script_scenes sc ON sc.id = s.scene_id
       INNER JOIN projects p ON p.id = sc.project_id
       WHERE ia.id = ?
       LIMIT 1`,
      [sourceId],
    )
    const row = rows[0] || null
    return row && row.owner_id === userId ? row : null
  }

  if (taskType === 'video') {
    const [rows] = await db.execute(
      `SELECT va.id,
              va.storyboard_id,
              sc.project_id,
              p.user_id AS owner_id
       FROM video_assets va
       INNER JOIN storyboards s ON s.id = va.storyboard_id
       INNER JOIN script_scenes sc ON sc.id = s.scene_id
       INNER JOIN projects p ON p.id = sc.project_id
       WHERE va.id = ?
       LIMIT 1`,
      [sourceId],
    )
    const row = rows[0] || null
    return row && row.owner_id === userId ? row : null
  }

  if (taskType === 'audio') {
    const [rows] = await db.execute(
      `SELECT aa.id,
              aa.project_id,
              p.user_id AS owner_id
       FROM audio_assets aa
       INNER JOIN projects p ON p.id = aa.project_id
       WHERE aa.id = ?
       LIMIT 1`,
      [sourceId],
    )
    const row = rows[0] || null
    return row && row.owner_id === userId ? row : null
  }

  if (taskType === 'export') {
    const [rows] = await db.execute(
      `SELECT er.id,
              er.project_id,
              p.user_id AS owner_id
       FROM export_records er
       INNER JOIN projects p ON p.id = er.project_id
       WHERE er.id = ?
       LIMIT 1`,
      [sourceId],
    )
    const row = rows[0] || null
    return row && row.owner_id === userId ? row : null
  }

  return null
}

/**
 * @description 角色行序列化（与前端 CharacterDTO 字段对齐，snake_case → camelCase）
 * @param {object} row 数据库行
 * @returns {object} 角色 DTO
 */
function characterRow(row) {
  return {
    id: row.id,
    projectId: row.project_id || row.projectId,
    name: row.name,
    roleTag: row.role_tag || row.roleTag,
    personality: row.personality,
    appearance: row.appearance,
    voiceSetting: row.voice_setting || row.voiceSetting,
    ageGroup: row.age_group || row.ageGroup || null,
    gender: row.gender || null,
    voiceStyle: row.voice_style || row.voiceStyle || null,
    voiceProfileKey: row.voice_profile_key || row.voiceProfileKey || null,
    voiceLocked: Boolean(row.voice_locked ?? row.voiceLocked),
    voiceDesign: safeJsonParse(row.voice_design_json || row.voiceDesignJson, null),
    referenceImageUrl: row.reference_image_url || row.referenceImageUrl,
    referenceAudioUrl: resolveReferenceAudioUrl(row) || null,
    status: row.status,
    createdAt: row.created_at || row.createdAt,
    updatedAt: row.updated_at || row.updatedAt,
  }
}

async function listActiveVoiceProfiles(executor = db) {
  const [rows] = await executor.execute(
    `SELECT * FROM voice_profiles
     WHERE status = 'active'
     ORDER BY sort_order ASC, profile_key ASC`,
  )
  return rows.map(voiceProfileRow)
}

async function findActiveVoiceProfile(profileKey, executor = db) {
  const normalizedKey = String(profileKey || '').trim()
  if (!normalizedKey) return null
  const [rows] = await executor.execute(
    `SELECT * FROM voice_profiles
     WHERE profile_key = ? AND status = 'active'
     LIMIT 1`,
    [normalizedKey],
  )
  return rows[0] ? voiceProfileRow(rows[0]) : null
}

function characterVoiceCastRow(row, profiles) {
  const character = characterRow(row)
  const recommendation = recommendVoiceProfiles(row, profiles, 3)
  const selectedProfile = profiles.find(
    (profile) => profile.profileKey === character.voiceProfileKey,
  ) || null
  return {
    character,
    traits: recommendation.traits,
    selectedProfile,
    recommendations: recommendation.items,
    ready: isCharacterVoiceReady({
      ...character,
      voiceProfileKey: selectedProfile?.profileKey || '',
    }, selectedProfile),
  }
}

function buildRenameRecord(row, fields, sourceNames, newName, options = {}) {
  const values = {}
  let occurrences = 0
  let changed = false
  let invalidStructuredField = false

  for (const field of fields) {
    const transformed = options.jsonFields?.has(field)
      ? transformCharacterNamesJson(row[field], sourceNames, newName)
      : transformCharacterNames(row[field], sourceNames, newName)
    values[field] = transformed.value
    occurrences += transformed.occurrences
    changed ||= transformed.changed
    if ('valid' in transformed && !transformed.valid) invalidStructuredField = true
  }

  if (options.forceValues) {
    for (const [field, value] of Object.entries(options.forceValues)) {
      const currentValue = Object.prototype.hasOwnProperty.call(values, field)
        ? values[field]
        : row[field]
      if (currentValue !== value) changed = true
      values[field] = value
    }
  }

  return {
    id: Number(row.id),
    values,
    occurrences,
    changed,
    invalidStructuredField,
    bindCharacterId: Boolean(options.bindCharacterId),
    characterId: options.characterId == null ? null : Number(options.characterId),
  }
}

function summarizeRenameRecords(records) {
  const changedRecords = records.filter((record) => record.changed)
  return {
    records: changedRecords.length,
    occurrences: changedRecords.reduce((total, record) => total + record.occurrences, 0),
  }
}

async function buildCharacterRenamePlan(executor, character, newName) {
  const oldName = String(character.name || '').trim()
  const projectId = Number(character.project_id)
  const [projectRows] = await executor.execute(
    `SELECT id, narrative_vision FROM projects WHERE id = ? LIMIT 1`,
    [projectId],
  )
  const [outlineRows] = await executor.execute(
    `SELECT id, title, logline, premise, act1_text, act2_text, act3_text, raw_json
     FROM story_outlines
     WHERE project_id = ?
     ORDER BY version_no DESC, id DESC
     LIMIT 1`,
    [projectId],
  )
  const [sceneRows] = await executor.execute(
    `SELECT id, title, summary, content
     FROM script_scenes
     WHERE project_id = ?
     ORDER BY sort_order ASC, scene_no ASC, id ASC`,
    [projectId],
  )
  const [storyboardRows] = await executor.execute(
    `SELECT s.id, s.character_id, s.character_name, s.action_text, s.dialogue_text, s.visual_prompt
     FROM storyboards s
     INNER JOIN script_scenes sc ON sc.id = s.scene_id
     WHERE sc.project_id = ?
     ORDER BY s.id ASC`,
    [projectId],
  )
  const [projectCharacterRows] = await executor.execute(
    `SELECT id, name FROM characters WHERE project_id = ? ORDER BY id ASC`,
    [projectId],
  )
  const relatedSpeakerNames = extractRelatedSpeakerNames(
    sceneRows.flatMap((row) => [row.title, row.summary, row.content]),
    oldName,
    projectCharacterRows
      .filter((row) => Number(row.id) !== Number(character.id))
      .map((row) => row.name),
  )
  const sourceNames = [...new Set([
    oldName,
    ...storyboardRows
      .filter((row) => Number(row.character_id) === Number(character.id))
      .map((row) => String(row.character_name || '').trim()),
    ...relatedSpeakerNames,
  ].filter((name) => name && name !== newName))]
  const [mediaRows] = await executor.execute(
    `SELECT
       (SELECT COUNT(*) FROM character_images WHERE character_id = ?) AS character_images,
       (SELECT COUNT(*) FROM audio_assets WHERE character_id = ?) AS audio_assets,
       (SELECT COUNT(*)
          FROM image_assets ia
          INNER JOIN storyboards s ON s.id = ia.storyboard_id
          WHERE s.character_id = ?) AS image_assets,
       (SELECT COUNT(*)
          FROM video_assets va
          INNER JOIN storyboards s ON s.id = va.storyboard_id
          WHERE s.character_id = ?) AS video_assets`,
    [character.id, character.id, character.id, character.id],
  )

  const projectRecords = projectRows.map((row) =>
    buildRenameRecord(row, ['narrative_vision'], sourceNames, newName),
  )
  const outlineRecords = outlineRows.map((row) =>
    buildRenameRecord(
      row,
      ['title', 'logline', 'premise', 'act1_text', 'act2_text', 'act3_text', 'raw_json'],
      sourceNames,
      newName,
      { jsonFields: new Set(['raw_json']) },
    ),
  )
  const sceneRecords = sceneRows.map((row) =>
    buildRenameRecord(row, ['title', 'summary', 'content'], sourceNames, newName),
  )
  const storyboardRecords = storyboardRows.map((row) => {
    const isBoundCharacter = Number(row.character_id) === Number(character.id)
    const isLegacyNameMatch =
      !row.character_id && sourceNames.includes(String(row.character_name || '').trim())
    const record = buildRenameRecord(
      row,
      ['action_text', 'dialogue_text', 'visual_prompt'],
      sourceNames,
      newName,
      {
        forceValues: {
          character_name: isBoundCharacter || isLegacyNameMatch ? newName : row.character_name,
        },
        bindCharacterId: isLegacyNameMatch,
        characterId: row.character_id,
      },
    )
    if (
      (isBoundCharacter || isLegacyNameMatch) &&
      transformCharacterNames(row.character_name, sourceNames, newName).occurrences > 0
    ) {
      record.occurrences += 1
    }
    return record
  })

  const sections = {
    project: summarizeRenameRecords(projectRecords),
    outline: summarizeRenameRecords(outlineRecords),
    scenes: summarizeRenameRecords(sceneRecords),
    storyboards: summarizeRenameRecords(storyboardRecords),
  }
  const sectionValues = Object.values(sections)
  const media = mediaRows[0] || {}

  return {
    oldName,
    newName,
    sourceNames,
    projectId,
    records: {
      project: projectRecords.filter((record) => record.changed),
      outline: outlineRecords.filter((record) => record.changed),
      scenes: sceneRecords.filter((record) => record.changed),
      storyboards: storyboardRecords.filter((record) => record.changed),
    },
    impact: {
      characterId: Number(character.id),
      oldName,
      newName,
      sourceNames,
      totalRecords: sectionValues.reduce((total, section) => total + section.records, 0),
      totalOccurrences: sectionValues.reduce((total, section) => total + section.occurrences, 0),
      sections,
      historicalMedia: {
        characterImages: Number(media.character_images || 0),
        imageAssets: Number(media.image_assets || 0),
        videoAssets: Number(media.video_assets || 0),
        audioAssets: Number(media.audio_assets || 0),
      },
      warnings: {
        invalidOutlineJson: outlineRecords.some((record) => record.invalidStructuredField),
      },
    },
  }
}

async function applyCharacterRenamePlan(connection, plan, characterId) {
  for (const record of plan.records.project) {
    await connection.execute(
      `UPDATE projects SET narrative_vision = ?, updated_at = NOW() WHERE id = ?`,
      [record.values.narrative_vision, record.id],
    )
  }

  for (const record of plan.records.outline) {
    await connection.execute(
      `UPDATE story_outlines
       SET title = ?, logline = ?, premise = ?, act1_text = ?, act2_text = ?, act3_text = ?, raw_json = ?
       WHERE id = ?`,
      [
        record.values.title,
        record.values.logline,
        record.values.premise,
        record.values.act1_text,
        record.values.act2_text,
        record.values.act3_text,
        record.values.raw_json,
        record.id,
      ],
    )
  }

  for (const record of plan.records.scenes) {
    await connection.execute(
      `UPDATE script_scenes
       SET title = ?, summary = ?, content = ?, updated_at = NOW()
       WHERE id = ?`,
      [record.values.title, record.values.summary, record.values.content, record.id],
    )
  }

  for (const record of plan.records.storyboards) {
    await connection.execute(
      `UPDATE storyboards
       SET character_id = ?, character_name = ?, action_text = ?, dialogue_text = ?,
           visual_prompt = ?, updated_at = NOW()
      WHERE id = ?`,
      [
        record.bindCharacterId ? characterId : record.characterId,
        record.values.character_name,
        record.values.action_text,
        record.values.dialogue_text,
        record.values.visual_prompt,
        record.id,
      ],
    )
  }
}

function resolveObjectStorageUrl(storageKey, fallback = null) {
  if (!storageKey) return fallback
  try {
    return objectStorage.createSignedUrl({ key: storageKey })
  } catch {
    return fallback
  }
}

function isNarrativeRoleOnlyName(value) {
  return /^(?:主角|男主角|女主角|男主|女主|第一主角|核心人物|主人公)$/u.test(
    String(value || '').trim(),
  )
}

function inferProtagonistCharacterName(outline, scenes = []) {
  const source = [
    outline?.premise,
    outline?.logline,
    outline?.raw_json,
    ...scenes.flatMap((scene) => [scene?.title, scene?.summary, scene?.content]),
  ].filter(Boolean).join('\n')
  return source.match(/(?:主角|主人公|男主角|女主角)[^。\n：:]{0,12}[：:是为叫，、]?\s*([\u4e00-\u9fa5]{2,8})/u)?.[1]?.trim()
    || source.match(/(?:程序员|合规专员|收到死者邮件的)[，,：:、\s]*([\u4e00-\u9fa5]{2,8})/u)?.[1]?.trim()
    || null
}

async function repairNarrativeRoleCharacterRecords(executor, projectId, outline, sceneRows) {
  const protagonistName = inferProtagonistCharacterName(outline, sceneRows)
  if (!protagonistName) return null
  const [roleRows] = await executor.execute(
    `SELECT id FROM characters
     WHERE project_id = ? AND status <> 'archived' AND name IN ('主角', '男主角', '女主角', '男主', '女主')
     ORDER BY id ASC`,
    [projectId],
  )
  if (!roleRows.length) return null
  const [realRows] = await executor.execute(
    `SELECT id FROM characters
     WHERE project_id = ? AND name = ? AND status <> 'archived'
     ORDER BY id ASC LIMIT 1`,
    [projectId, protagonistName],
  )
  const targetId = Number(realRows[0]?.id || 0)
  if (!targetId) return null
  for (const roleRow of roleRows) {
    const roleId = Number(roleRow.id)
    if (roleId === targetId) continue
    await executor.execute(`UPDATE storyboards SET character_id = ?, character_name = ? WHERE character_id = ?`, [
      targetId,
      protagonistName,
      roleId,
    ])
    await executor.execute(`UPDATE asset_nodes SET ref_id = ?, label = ?, group_key = CONCAT('character-', ?) WHERE ref_id = ? AND node_type = 'character'`, [
      targetId,
      protagonistName,
      targetId,
      roleId,
    ])
    await executor.execute(`UPDATE audio_assets SET character_id = ? WHERE character_id = ?`, [targetId, roleId])
    await executor.execute(`UPDATE characters SET status = 'archived', updated_at = NOW() WHERE id = ?`, [roleId])
  }
  return { targetId, protagonistName, repairedCount: roleRows.length }
}

function characterImageRow(row) {
  const imageUrl = row.storage_key
    ? resolveObjectStorageUrl(row.storage_key, row.image_url || row.imageUrl)
    : row.image_url || row.imageUrl
  const thumbnailUrl = row.storage_key
    ? resolveObjectStorageUrl(row.storage_key, row.thumbnail_url || row.thumbnailUrl || imageUrl)
    : row.thumbnail_url || row.thumbnailUrl
  return {
    id: row.id,
    characterId: row.character_id || row.characterId,
    versionNo: row.version_no || row.versionNo,
    imageUrl,
    thumbnailUrl,
    storageKey: row.storage_key || row.storageKey || null,
    promptSnapshot: row.prompt_snapshot || row.promptSnapshot,
    modelName: row.model_name || row.modelName,
    status: row.status,
    confirmedAt: row.confirmed_at || row.confirmedAt,
    createdAt: row.created_at || row.createdAt,
  }
}

function withResolvedAssetNodeImageUrls(row) {
  const imageUrl = row.storage_key
    ? resolveObjectStorageUrl(row.storage_key, row.image_url)
    : row.image_url
  // 历史记录可能保存了已经过期的模型缩略图。优先使用持久化对象，
  // 没有 storage_key 时才保留旧字段，兼容过去的外部图片记录。
  const thumbnailUrl = row.storage_key
    ? resolveObjectStorageUrl(row.storage_key, row.thumbnail_url || row.image_url || imageUrl)
    : row.thumbnail_url || row.image_url
  return { ...row, image_url: imageUrl, thumbnail_url: thumbnailUrl }
}

function hasDurableAssetNodeImage(row) {
  if (!row?.storage_key) return Boolean(row?.image_url || row?.thumbnail_url)
  if (objectStorage.provider !== 'local') return true
  try {
    return Boolean(objectStorage.resolveLocalPath(row.storage_key))
  } catch {
    return false
  }
}

function assetNodeImageDto(row) {
  const resolved = withResolvedAssetNodeImageUrls(row)
  return assetNodeImageRow({
    ...resolved,
    vision_status: row.vision_status ?? row.visionStatus ?? 'pending',
    vision_reason: row.vision_reason ?? row.visionReason ?? null,
    vision_checked_at: row.vision_checked_at ?? row.visionCheckedAt ?? null,
    // 不把已知不存在的本地对象继续暴露给前端，前端会显示“待重新生成”。
    image_url: hasDurableAssetNodeImage(row) ? resolved.image_url : null,
    thumbnail_url: hasDurableAssetNodeImage(row) ? resolved.thumbnail_url : null,
  })
}

async function fetchAssetNodeForUser(nodeId, userId) {
  const [rows] = await db.execute(
    `SELECT n.*, p.user_id AS ownerId, p.visual_style AS project_visual_style,
            p.category AS project_category
     FROM asset_nodes n
     INNER JOIN projects p ON p.id = n.project_id
     WHERE n.id = ? AND n.status <> 'archived' LIMIT 1`,
    [nodeId],
  )
  const node = rows[0]
  if (!node || Number(node.ownerId) !== Number(userId)) return null

  if (node.node_type === 'scene' && !node.ref_id) {
    const [sceneRows] = await db.execute(
      `SELECT id, scene_no, title, summary, content, location, time_of_day
       FROM script_scenes
       WHERE project_id = ?
       ORDER BY episode_no ASC, scene_no ASC, id ASC`,
      [node.project_id],
    )
    const matchedScene = findSceneNodeMatch(node, sceneRows)
    if (matchedScene) {
      const promptText = buildScriptScenePrompt({
        scene: matchedScene,
        projectVisualStyle: node.project_visual_style || '',
        projectCategory: node.project_category || '',
      })
      await db.execute(
        `UPDATE asset_nodes
         SET ref_id = ?, prompt_text = ?, appearance_label = COALESCE(NULLIF(appearance_label, ''), ?),
             updated_at = NOW()
         WHERE id = ?`,
        [
          matchedScene.id,
          promptText,
          [matchedScene.location, matchedScene.time_of_day].filter(Boolean).join(' · ') || null,
          node.id,
        ],
      )
      node.ref_id = Number(matchedScene.id)
      node.prompt_text = promptText
      node.appearance_label = node.appearance_label
        || [matchedScene.location, matchedScene.time_of_day].filter(Boolean).join(' · ')
        || null
    }
  }

  if (
    node.node_type === 'scene'
    && node.ref_id
    && (!String(node.prompt_text || '').trim()
      || String(node.prompt_text || '').trim() === '场景空间结构待补充：请描述地点、时代、建筑结构、主要物件位置、门窗方向、光线方向和剧情功能。')
  ) {
    const [sceneRows] = await db.execute(
      `SELECT id, scene_no, title, summary, content, location, time_of_day
       FROM script_scenes
       WHERE id = ? AND project_id = ? LIMIT 1`,
      [node.ref_id, node.project_id],
    )
    if (sceneRows[0]) {
      const [projectRows] = await db.execute(
        `SELECT visual_style, category FROM projects WHERE id = ? LIMIT 1`,
        [node.project_id],
      )
      const promptText = buildScriptScenePrompt({
        scene: sceneRows[0],
        projectVisualStyle: projectRows[0]?.visual_style || '',
        projectCategory: projectRows[0]?.category || '',
      })
      await db.execute(
        `UPDATE asset_nodes SET prompt_text = ?, updated_at = NOW() WHERE id = ?`,
        [promptText, node.id],
      )
      node.prompt_text = promptText
    }
  }

  let character = null
  if (node.node_type === 'character' && node.ref_id) {
    const [characterRows] = await db.execute(
      `SELECT id, name, role_tag, personality, appearance, costume, age_group, gender,
              appearance_locked, reference_image_url, reference_image_storage_key
       FROM characters
       WHERE id = ? AND project_id = ? AND status <> 'archived' LIMIT 1`,
      [node.ref_id, node.project_id],
    )
    character = characterRows[0] || null
  }
  return { node, character }
}

async function ensureSceneSpatialAnchors(scene) {
  return resolveSceneSpaceManifest({
    scene,
    extract: extractSceneSpaceAnchorsWithAgent,
    persist: async (manifest) => {
      await db.execute(
        `UPDATE script_scenes SET spatial_anchors_json = ?, updated_at = NOW() WHERE id = ?`,
        [JSON.stringify(manifest), scene.id],
      )
    },
  })
}

async function enqueueAssetNodeImageJob(userId, nodeId, body = {}) {
  const resolved = await fetchAssetNodeForUser(nodeId, userId)
  if (!resolved) return null
  const { node, character } = resolved
  let effectivePromptText = String(node.prompt_text || '').trim()
  let sceneSpatialAnchors = null
  let projectCharacterNames = []
  if (node.node_type === 'scene' && node.ref_id && !effectivePromptText) {
    const [projectRows] = await db.execute(
      `SELECT visual_style, category FROM projects WHERE id = ? LIMIT 1`,
      [node.project_id],
    )
    const [characterRows] = await db.execute(
      `SELECT name FROM characters WHERE project_id = ? AND status <> 'archived'`,
      [node.project_id],
    )
    projectCharacterNames = characterRows.map((row) => row.name).filter(Boolean)
    const [sceneRows] = await db.execute(
      `SELECT id, scene_no, title, summary, content, spatial_anchors_json, location, time_of_day
       FROM script_scenes WHERE id = ? AND project_id = ? LIMIT 1`,
      [node.ref_id, node.project_id],
    )
    if (sceneRows[0]) {
      effectivePromptText = buildScriptScenePrompt({
        scene: sceneRows[0],
        projectVisualStyle: projectRows[0]?.visual_style || '',
        projectCategory: projectRows[0]?.category || '',
        characterNames: projectCharacterNames,
      })
      await db.execute(
        `UPDATE asset_nodes SET prompt_text = ?, updated_at = NOW() WHERE id = ?`,
        [effectivePromptText, nodeId],
      )
      node.prompt_text = effectivePromptText
    }
  }
  if (node.node_type === 'scene' && node.ref_id) {
    const [projectRows] = await db.execute(
      `SELECT visual_style, category FROM projects WHERE id = ? LIMIT 1`,
      [node.project_id],
    )
    const [sceneRows] = await db.execute(
      `SELECT id, scene_no, title, summary, content, spatial_anchors_json, location, time_of_day
       FROM script_scenes WHERE id = ? AND project_id = ? LIMIT 1`,
      [node.ref_id, node.project_id],
    )
    if (!projectCharacterNames.length) {
      const [characterRows] = await db.execute(
        `SELECT name FROM characters WHERE project_id = ? AND status <> 'archived'`,
        [node.project_id],
      )
      projectCharacterNames = characterRows.map((row) => row.name).filter(Boolean)
    }
    if (sceneRows[0]) {
      const manifest = await ensureSceneSpatialAnchors(sceneRows[0])
      sceneSpatialAnchors = manifest
      sceneRows[0].spatial_anchors = manifest
      const environmentPromptText = buildSceneEnvironmentPrompt({
        scene: sceneRows[0],
        projectVisualStyle: projectRows[0]?.visual_style || '',
        projectCategory: projectRows[0]?.category || '',
        characterNames: projectCharacterNames,
      })
      // 每次全景生成都从当前绑定场景刷新环境层，避免沿用旧版混入人物动作的提示词。
      await db.execute(
        `UPDATE asset_nodes SET environment_prompt_text = ?, updated_at = NOW() WHERE id = ?`,
        [environmentPromptText, nodeId],
      )
      node.environment_prompt_text = environmentPromptText
    }
  }
  const frameConfig = getFrameConfig()
  const requestedViewType = String(body.viewType || '').trim()
  if (node.node_type === 'character'
    && !['', 'single', 'character-asset-pack'].includes(requestedViewType)) {
    const error = new Error('角色资产统一生成完整资产板；独立脸部特写和三视图链路已停用')
    error.statusCode = 409
    error.code = 'CHARACTER_ASSET_PACK_REQUIRED'
    throw error
  }
  if (['prop', 'material'].includes(String(node.node_type))
    && requestedViewType === 'prop-turnaround') {
    const error = new Error('道具资产统一使用完整单图；独立多视图链路已停用')
    error.statusCode = 409
    error.code = 'PROP_SINGLE_IMAGE_REQUIRED'
    throw error
  }
  const assetPackEnabled = node.node_type === 'character'
    && ['character-asset-pack', 'single', ''].includes(requestedViewType)
  const requestedAssetPackModel = assetPackEnabled
    ? String(body.modelName || frameConfig.assetPackModel || frameConfig.defaultModel).trim()
    : ''
  const [versionRows] = await db.execute(
    `SELECT COALESCE(MAX(version_no), 0) AS maxVersion
     FROM asset_node_images WHERE asset_node_id = ?`,
    [nodeId],
  )
  const versionNo = Number(versionRows[0]?.maxVersion || 0) + 1
  const promptNode = {
    ...node,
    promptText: resolveAssetNodeGenerationPrompt({
      node: {
        ...node,
        promptText: effectivePromptText,
      },
       requestedViewType: requestedViewType || 'single',
      promptOverride: body.prompt,
    }),
  }
  const requestedViewKey = String(body.viewKey || '').trim()
  const sceneAngle = getSceneNineGridAngles().find((angle) => angle.key === requestedViewKey)
  if (requestedViewType === 'scene-nine-grid' && requestedViewKey && !sceneAngle) {
    const error = new Error(`无效的场景九宫格视角：${requestedViewKey}`)
    error.statusCode = 400
    throw error
  }
  let referenceImageUrl = String(body.referenceImageUrl || '').trim()
  let baseReferenceImageUrl = ''
  let baseReferenceStorageKey = ''
  let baseReferenceImageId = null
  let panoramaImageId = null
  let panoramaImageUrl = ''
  let panoramaStorageKey = ''
  let identityLockSnapshot = parseCharacterIdentityLock(node.character_identity_lock_json)
  let identityReferenceImageIds = []
  let identityReferenceImageUrls = []
  let identityReferenceStorageKeys = []
  if (['character-turnaround', 'character-face-closeup'].includes(requestedViewType) && node.node_type === 'character') {
    const [imageRows] = await db.execute(
      `SELECT * FROM asset_node_images
       WHERE asset_node_id = ?
       ORDER BY id DESC`,
      [nodeId],
    )
    const existingImages = imageRows.map(assetNodeImageDto)
    const gate = validateCharacterViewGeneration({
      nodeType: node.node_type,
      viewType: requestedViewType,
      images: existingImages,
    })
    if (!gate.ready) {
      const error = new Error(gate.message)
      error.statusCode = 409
      error.code = gate.code
      throw error
    }
    const baseImage = getCharacterBaseReferenceImage(existingImages)
    baseReferenceImageId = Number(baseImage?.id) || null
    baseReferenceImageUrl = String(baseImage?.imageUrl || baseImage?.thumbnailUrl || '').trim()
    baseReferenceStorageKey = String(baseImage?.storageKey || '').trim()
    const referenceSet = resolveCharacterReferenceSet(existingImages)
    identityReferenceImageIds = referenceSet.imageIds
    identityReferenceImageUrls = referenceSet.imageUrls
    identityReferenceStorageKeys = referenceSet.storageKeys
    identityLockSnapshot = identityLockSnapshot || buildCharacterIdentityLockSnapshot({
      character: character || { id: node.ref_id, name: node.label },
      baseImage,
      referenceSet,
    })
  }
  if (requestedViewType === 'prop-turnaround' && ['prop', 'material'].includes(node.node_type)) {
    const [imageRows] = await db.execute(
      `SELECT * FROM asset_node_images WHERE asset_node_id = ? ORDER BY id DESC`,
      [nodeId],
    )
    const existingImages = imageRows.map(assetNodeImageDto)
    const baseImage = existingImages.find((image) =>
      image.viewSetType === 'single' && image.status === 'confirmed' && image.visionStatus === 'passed',
    )
    if (!baseImage) {
      const error = new Error('请先生成并确认道具基础图，再生成道具多视角')
      error.statusCode = 409
      error.code = 'PROP_BASE_IMAGE_REQUIRED'
      throw error
    }
    baseReferenceImageUrl = String(baseImage.imageUrl || baseImage.thumbnailUrl || '').trim()
    baseReferenceStorageKey = String(baseImage.storageKey || '').trim()
  }
  let sceneReferenceStorageKey = ''
  if (requestedViewType === 'scene-nine-grid' && node.node_type === 'scene') {
    const explicitPanoramaId = parseId(body.referenceImageId)
    const panoramaQuery = explicitPanoramaId
      ? `SELECT id, storage_key, image_url
         FROM asset_node_images
         WHERE id = ? AND asset_node_id = ? AND view_set_type = 'single'
           AND status IN ('candidate', 'confirmed')
           AND (vision_status IN ('passed', 'skipped') OR vision_status IS NULL)
         LIMIT 1`
      : `SELECT id, storage_key, image_url
         FROM asset_node_images
         WHERE asset_node_id = ? AND view_set_type = 'single' AND status = 'confirmed'
           AND (vision_status IN ('passed', 'skipped') OR vision_status IS NULL)
         ORDER BY id DESC LIMIT 1`
    const [panoramaRows] = await db.execute(
      panoramaQuery,
      explicitPanoramaId ? [explicitPanoramaId, nodeId] : [nodeId],
    )
    if (explicitPanoramaId && !panoramaRows[0]) {
      const error = new Error('指定的场景全景母图不存在、未通过视觉检查或不属于当前节点')
      error.statusCode = 409
      error.code = 'SCENE_PANORAMA_REFERENCE_INVALID'
      throw error
    }
    panoramaImageId = Number(panoramaRows[0]?.id) || null
    sceneReferenceStorageKey = String(panoramaRows[0]?.storage_key || '').trim()
    panoramaStorageKey = sceneReferenceStorageKey
    panoramaImageUrl = String(panoramaRows[0]?.image_url || '').trim()
    referenceImageUrl = referenceImageUrl || panoramaImageUrl
    if (!panoramaImageId) {
      const error = new Error('请先确认场景全景基准图，再生成九个独立场景视角')
      error.statusCode = 409
      error.code = 'SCENE_PANORAMA_REQUIRED'
      throw error
    }
    if (!requestedViewKey) {
      const [existingViewRows] = await db.execute(
        `SELECT MAX(view_count) AS view_count
         FROM (
           SELECT view_set_version, COUNT(DISTINCT view_key) AS view_count
           FROM asset_node_images
           WHERE asset_node_id = ? AND view_set_type = 'scene-nine-grid'
             AND view_key IS NOT NULL AND source_image_id = ?
             AND status IN ('candidate', 'confirmed')
             AND vision_status IN ('passed', 'skipped')
           GROUP BY view_set_version
         ) AS complete_batches`,
        [nodeId, panoramaImageId],
      )
      if (Number(existingViewRows[0]?.view_count || 0) >= 9) {
        const error = new Error('九宫格九个独立视角已生成；请在对应视角卡片中单独重试，不要重复生成整组')
        error.statusCode = 409
        error.code = 'SCENE_NINE_GRID_ALREADY_GENERATED'
        throw error
      }
    }
  }
  const requestedCharacterViewKeys = requestedViewType === 'character-turnaround'
    ? (Array.isArray(body.viewKeys) && body.viewKeys.length
        ? body.viewKeys
        : ['front', 'side', 'back'])
      .map((key) => String(key || '').trim())
      .filter((key, index, keys) => ['front', 'side', 'back'].includes(key) && keys.indexOf(key) === index)
    : []
  const isCharacterTurnaroundBatch = requestedViewType === 'character-turnaround' && !requestedViewKey
  // character-asset-pack is the batch board contract, not a camera view.
  // It has its own generation prompt below and must not fall through the
  // single-view prompt builder, whose unsupported-view fallback has no base.
  const viewPrompt = requestedViewType
    && !['single', 'character-asset-pack'].includes(requestedViewType)
    && !isCharacterTurnaroundBatch
    ? buildAssetNodeViewPrompt({
        node: promptNode,
        character,
        projectVisualStyle: node.project_visual_style,
        appearanceLocked: Boolean(character?.appearance_locked),
        viewType: requestedViewType,
        viewKey: String(body.viewKey || '').trim(),
        referenceImageUrl,
        baseReferenceImageUrl,
      })
    : null
  const sceneAnglePrompt = requestedViewType === 'scene-nine-grid' && requestedViewKey && sceneAngle
    ? buildSceneNineGridAnglePrompt({
        angle: requestedViewKey,
        panorama: panoramaImageUrl || panoramaStorageKey,
        spatialAnchors: sceneSpatialAnchors,
      })
    : null
  const generationPrompt = assetPackEnabled
    ? buildCharacterAssetPackPrompt({
        character: character || { name: node.label },
        projectVisualStyle: node.project_visual_style,
      }) + `\n角色节点原始约束（只补充外貌事实，不改变资产板布局）：\n${String(effectivePromptText || '').trim()}`
    : sceneAnglePrompt || viewPrompt?.prompt || buildAssetNodeGenerationPrompt({
    node: promptNode,
    character,
    projectVisualStyle: node.project_visual_style,
    appearanceLocked: Boolean(character?.appearance_locked),
  })
  const identityPrompt = ['character-turnaround', 'character-face-closeup'].includes(requestedViewType)
    && node.node_type === 'character'
    ? buildCharacterIdentityLockPrompt(
      identityLockSnapshot || {},
      viewPrompt?.viewLabel || requestedViewKey,
    )
    : ''
  const effectiveGenerationPrompt = [generationPrompt, identityPrompt].filter(Boolean).join('\n')
  if (!effectiveGenerationPrompt) {
    const error = new Error('请先填写提示词：角色节点可以只靠身份约束生成，场景和道具节点必须写提示词')
    error.statusCode = 400
    throw error
  }
  const promptSnapshot = buildAssetNodePromptSnapshot({
    node: promptNode,
    character,
    projectVisualStyle: node.project_visual_style,
    appearanceLocked: Boolean(character?.appearance_locked),
  })
  return createGenerationJob({
    projectId: Number(node.project_id),
    jobType: 'asset_node_image',
    sourceId: nodeId,
    request: {
      projectId: Number(node.project_id),
      assetNodeId: nodeId,
      nodeType: node.node_type,
      label: node.label,
      versionNo,
      candidateCount: viewPrompt?.candidateCount || Math.max(1, Math.min(3, parseId(body.candidateCount) || 1)),
      imageRatio: assetPackEnabled
        ? '16:9'
        : requestedViewType === 'character-face-closeup'
        ? '1:1'
        : node.node_type === 'character' ? '9:16' : null,
      // The requested view set is the durable worker contract. In particular,
      // a scene-nine-grid batch has no viewKey and therefore no viewPrompt;
      // it must not fall back to generating another panorama.
      viewType: requestedViewType || 'single',
      viewIndex: sceneAngle?.index || viewPrompt?.viewIndex || null,
      viewKey: sceneAngle?.key || viewPrompt?.viewKey || null,
      viewLabel: sceneAngle?.label || viewPrompt?.viewLabel || null,
      modelName: requestedAssetPackModel || String(body.modelName || frameConfig.defaultModel).trim(),
      qualityAttempts: ['character-turnaround', 'character-face-closeup'].includes(requestedViewType)
        ? characterDerivedQualityAttempts(body.qualityAttempts, 3)
        : requestedViewType === 'scene-nine-grid'
          ? sceneNineGridQualityAttempts(body.qualityAttempts, 5)
        : 1,
      prompt: effectiveGenerationPrompt,
      sceneSpatialAnchors,
      panoramaImageId,
      panoramaImageUrl,
      panoramaStorageKey,
      // 三视图是纯白背景的角色资产单图，禁止继承节点上的剧情负面词，
      // 避免把场景/风格上下文重新混入角色视角生成。
      negativePrompt: viewPrompt || isCharacterTurnaroundBatch
        ? ['character-turnaround', 'character-face-closeup'].includes(requestedViewType)
          ? buildCharacterViewNegativePrompt(requestedViewKey, {
              noFace: node.node_type === 'character'
                && /正脸不呈现|不直接露脸|不出现正脸|脸部.*不可见/u.test(
                  [character?.appearance, character?.costume, node.prompt_text].filter(Boolean).join('\n'),
                ),
            })
          : [
              '场景背景以外的人物主体',
              '多人',
              '拼贴',
              '文字',
              '水印',
            ].join('，')
        : String(node.negative_prompt || '').trim(),
      // 保存真正发给图片模型的视图提示词；三视图/脸部特写不能只落库基础节点提示词。
      promptSnapshot: effectiveGenerationPrompt,
      baseReferenceImageUrl,
      baseReferenceStorageKey,
      deterministicFaceCrop: requestedViewType === 'character-face-closeup',
      assetPackEnabled,
      sourceImageId: ['character-turnaround', 'character-face-closeup'].includes(requestedViewType)
        ? baseReferenceImageId
        : null,
      viewBatch: isCharacterTurnaroundBatch
        ? requestedCharacterViewKeys.map((viewKey) => buildAssetNodeViewPrompt({
            node: promptNode,
            character,
            projectVisualStyle: node.project_visual_style,
            appearanceLocked: Boolean(character?.appearance_locked),
            viewType: 'character-turnaround',
            viewKey,
            referenceImageUrl,
            baseReferenceImageUrl,
          }))
        : null,
      identityLockSnapshot,
      identityReferenceImageIds,
      identityReferenceImageStorageKeys: identityReferenceStorageKeys,
      referenceImageUrls: identityReferenceImageUrls.length
        ? identityReferenceImageUrls
        : viewPrompt?.referenceImageUrls
        || (baseReferenceImageUrl ? [baseReferenceImageUrl] : null)
        || resolveCharacterReferenceImageUrls(
          character?.reference_image_url ? [character.reference_image_url] : [],
        ),
      referenceImageStorageKeys: [
        ...identityReferenceStorageKeys,
        ...(baseReferenceStorageKey ? [baseReferenceStorageKey] : []),
        ...(sceneReferenceStorageKey ? [sceneReferenceStorageKey] : []),
      ].filter((key, index, values) => values.indexOf(key) === index),
    },
  })
}

function seasonEpisodeSceneSpecs(episodes = []) {
  return episodes.map((episode, index) => ({
    episode_no: index + 1,
    scene_no: index + 1,
    title: episode.title || `第 ${index + 1} 集`,
    summary: [
      episode.logline,
      episode.openingHook ? `开场钩子：${episode.openingHook}` : '',
      episode.goal ? `本集目标：${episode.goal}` : '',
      episode.coreConflict ? `核心冲突：${episode.coreConflict}` : '',
      episode.protagonistChoice ? `主角选择：${episode.protagonistChoice}` : '',
      episode.irreversibleChange ? `不可逆变化：${episode.irreversibleChange}` : '',
      episode.endingHook ? `结尾钩子：${episode.endingHook}` : '',
    ].filter(Boolean).join('\n'),
    location: null,
    time_of_day: null,
    estimated_duration: 120,
  }))
}

function matchCharacterId(characterName, characters) {
  const normalized = String(characterName || '').trim().toLocaleLowerCase('zh-CN')
  if (!normalized) return null
  const exact = characters.find(
    (item) => String(item.name || '').trim().toLocaleLowerCase('zh-CN') === normalized,
  )
  if (exact) return Number(exact.id) || null
  const partial = characters.find((item) => {
    const name = String(item.name || '').trim().toLocaleLowerCase('zh-CN')
    return name && (normalized.includes(name) || name.includes(normalized))
  })
  return partial ? Number(partial.id) || null : null
}

function parseId(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function imageMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (extension === '.webp') return 'image/webp'
  return 'image/jpeg'
}

async function persistGeneratedImageCandidate({
  projectId,
  ownerType,
  ownerId,
  versionNo,
  candidateNo,
  filePath,
}) {
  if (!filePath || !(await fileExists(filePath))) return { storageKey: null }

  const bytes = await readFile(filePath)
  if (!bytes.length) throw new Error('生成图片文件为空')
  const extension = path.extname(filePath).toLowerCase() || '.jpg'
  let storageKey
  if (ownerType === 'character') {
    storageKey = buildCharacterImageStorageKey({
      projectId,
      characterId: ownerId,
      versionNo,
      candidateNo,
      extension,
    })
  } else if (ownerType === 'asset_node') {
    storageKey = buildAssetNodeImageStorageKey({
      projectId,
      assetNodeId: ownerId,
      versionNo,
      candidateNo,
      extension,
    })
  } else if (ownerType === 'storyboard') {
    storageKey = buildGeneratedFrameStorageKey({
      projectId,
      storyboardId: ownerId,
      versionNo,
      candidateNo,
      extension,
    })
  } else {
    throw new Error(`unsupported generated image owner type: ${ownerType}`)
  }
  const stored = await objectStorage.putObject({
    key: storageKey,
    bytes,
    contentType: imageMimeType(filePath),
  })
  return { storageKey, imageUrl: stored.url }
}

async function materializeSceneNineGridCrops({
  sourcePath,
  assetNodeId,
  versionNo,
  sourceImageId,
  sourceImageUrl,
}) {
  if (!sourcePath || !(await fileExists(sourcePath))) {
    throw new Error('九宫格供应商未返回可读取的母图文件，无法建立九个独立场景视角')
  }

  const source = {
    sourceImageId: Number(sourceImageId) || null,
    sourceImageUrl: String(sourceImageUrl || '').trim() || null,
    viewSetVersion: Number(versionNo) || 1,
    status: 'candidate',
  }
  const descriptors = buildSceneNineGridViewDescriptors(source)
  const cropRoot = path.join(
    GENERATED_FRAME_DIR,
    `asset-node-${Number(assetNodeId)}-v${Number(versionNo)}-nine-grid`,
  )
  await mkdir(cropRoot, { recursive: true })

  const files = []
  for (const descriptor of descriptors) {
    const outputPath = path.join(cropRoot, `${descriptor.viewIndex}-${descriptor.viewKey}.png`)
    await runExternalCommand(FFMPEG_BIN, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      sourcePath,
      '-vf',
      buildSceneNineGridCropFilter(descriptor.viewKey),
      '-frames:v',
      '1',
      '-c:v',
      'png',
      outputPath,
    ])
    if (!(await fileExists(outputPath))) {
      throw new Error(`九宫格 ${descriptor.viewLabel} 视角裁剪后没有产出图片`)
    }
    files.push({ descriptor, filePath: outputPath })
  }
  return files
}

async function materializeCharacterAssetPackCrops({ sourcePath, assetNodeId, versionNo }) {
  if (!sourcePath || !(await fileExists(sourcePath))) {
    throw new Error('角色资产板没有可读取的母图文件，无法拆分角色资产')
  }
  const cropRoot = path.join(
    GENERATED_FRAME_DIR,
    `asset-node-${Number(assetNodeId)}-v${Number(versionNo)}-character-pack`,
  )
  await mkdir(cropRoot, { recursive: true })
  const files = []
  for (const descriptor of buildCharacterAssetPackDescriptors()) {
    const viewKey = descriptor.viewKey || 'base'
    const outputPath = path.join(cropRoot, `${descriptor.viewIndex}-${viewKey}.png`)
    await runExternalCommand(FFMPEG_BIN, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      sourcePath,
      '-vf',
      buildCharacterAssetPackCropFilter(descriptor.viewKey || ''),
      '-frames:v',
      '1',
      '-c:v',
      'png',
      outputPath,
    ])
    if (!(await fileExists(outputPath))) throw new Error(`角色资产板 ${descriptor.viewLabel} 拆分失败`)
    files.push({ descriptor, filePath: outputPath })
  }
  return files
}

function buildMockImageUrl(storyboardId, index, versionNo) {
  return `${PUBLIC_BASE_URL}/mock/image/${storyboardId}/${versionNo}/${index + 1}.svg`
}

const PUBLIC_MOCK_ASSET_IMAGE_PATH = path.join(process.cwd(), 'public', 'images', 'login-hero-clean.png')

async function readMockAssetImageBytes() {
  try {
    const bytes = await readFile(PUBLIC_MOCK_ASSET_IMAGE_PATH)
    if (bytes.length) return bytes
  } catch {
    // Fall through to the existing mock SVG route if the optional placeholder is unavailable.
  }
  return null
}

async function materializeMockCharacterAssetPackBoard({ assetNodeId, versionNo }) {
  const bytes = await readMockAssetImageBytes()
  if (!bytes) throw new Error('本地 mock 资产板占位图不存在，无法拆分角色资产板')
  const outputDir = path.join(
    GENERATED_FRAME_DIR,
    `asset-node-${Number(assetNodeId)}-v${Number(versionNo)}-character-pack`,
  )
  await mkdir(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, 'mock-character-asset-pack-board.png')
  if (!(await fileExists(outputPath))) await writeFile(outputPath, bytes)
  return outputPath
}

function buildMockThumbnailUrl(fullUrl) {
  return fullUrl
}

function buildGeneratedFramePublicBaseUrl() {
  return `${PUBLIC_BASE_URL}/generated/frame`
}

function buildGeneratedAudioPublicBaseUrl() {
  return `${PUBLIC_BASE_URL}/generated/audio`
}

function buildRequestGeneratedAudioBaseUrl(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
  const host = forwardedHost || String(req.headers.host || '').trim()
  if (host) {
    const protocol = forwardedProto || (req.socket.encrypted ? 'https' : 'http')
    return `${protocol}://${host}/generated/audio`
  }
  return '/generated/audio'
}

function buildGeneratedVideoPublicBaseUrl() {
  return `${PUBLIC_BASE_URL}/generated/video`
}

function buildGeneratedExportPublicBaseUrl() {
  return `${PUBLIC_BASE_URL}/generated/export`
}

function buildMockImageSvg(storyboardId, versionNo, candidateNo) {
  const title = `SHOT ${storyboardId}`
  const subtitle = `Version ${versionNo} / Candidate ${candidateNo}`
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="576" viewBox="0 0 1024 576">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#191813" />
      <stop offset="55%" stop-color="#2b241d" />
      <stop offset="100%" stop-color="#0f0f0d" />
    </linearGradient>
    <linearGradient id="shine" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.15" />
      <stop offset="100%" stop-color="#f59e0b" stop-opacity="0" />
    </linearGradient>
  </defs>
  <rect width="1024" height="576" fill="url(#bg)" />
  <rect x="28" y="28" width="968" height="520" rx="18" fill="none" stroke="#8d6f4a" stroke-width="2" />
  <rect x="28" y="28" width="968" height="140" fill="url(#shine)" />
  <circle cx="862" cy="146" r="120" fill="#f59e0b" fill-opacity="0.07" />
  <circle cx="194" cy="416" r="164" fill="#f59e0b" fill-opacity="0.05" />
  <text x="72" y="122" fill="#f7efe5" font-size="54" font-family="Georgia, serif" font-weight="700">${title}</text>
  <text x="74" y="176" fill="#f0b56f" font-size="24" font-family="Arial, sans-serif" letter-spacing="3">${subtitle}</text>
  <text x="74" y="458" fill="#cbb59b" font-size="18" font-family="Arial, sans-serif">Mock frame asset generated by local ProjectDream server</text>
  <text x="74" y="492" fill="#9a8876" font-size="16" font-family="Arial, sans-serif">This placeholder keeps the image module testable without any external image service.</text>
  <rect x="74" y="232" width="292" height="10" rx="5" fill="#8d6f4a" fill-opacity="0.55" />
  <rect x="74" y="256" width="404" height="10" rx="5" fill="#8d6f4a" fill-opacity="0.38" />
  <rect x="74" y="280" width="356" height="10" rx="5" fill="#8d6f4a" fill-opacity="0.3" />
</svg>`
}

function buildMockVideoUrl(storyboardId, index, versionNo) {
  const base = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'
  const params = new URLSearchParams({
    shot: String(storyboardId),
    candidate: String(index + 1),
    version: String(versionNo),
  })
  return `${base}?${params.toString()}`
}

function buildMockVideoThumbnailUrl(imageUrl) {
  return imageUrl || null
}

function buildMockAudioUrl(projectId, trackType, versionNo, candidateNo, source = {}) {
  const sceneId = parseId(source.sceneId) || 0
  const characterId = parseId(source.characterId) || 0
  return `${PUBLIC_BASE_URL}/mock/audio/${projectId}/${sceneId}/${characterId}/${versionNo}/${trackType}/${candidateNo}.wav`
}

function normalizeAudioTrackType(value) {
  const trackType = String(value || '')
    .trim()
    .toLowerCase()
  return ['dialogue', 'narration', 'music', 'sfx'].includes(trackType) ? trackType : ''
}

function buildMockAudioBuffer(trackType, candidateNo, versionNo, sourceSeed = 0) {
  const sampleRate = 22050
  const durationSeconds = 3
  const totalSamples = sampleRate * durationSeconds
  const bitsPerSample = 16
  const numChannels = 1
  const blockAlign = (numChannels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = totalSamples * blockAlign
  const buffer = Buffer.alloc(44 + dataSize)
  const trackBase = {
    dialogue: 220,
    narration: 180,
    music: 330,
    sfx: 440,
  }[trackType] || 260
  const frequency = trackBase + candidateNo * 28 + versionNo * 6 + (sourceSeed % 41)

  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(numChannels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  for (let i = 0; i < totalSamples; i += 1) {
    const t = i / sampleRate
    const envelope = Math.min(1, t * 4, (durationSeconds - t) * 4)
    const pulse = trackType === 'music' ? 0.65 : trackType === 'sfx' ? 0.85 : 0.45
    const value = Math.sin(2 * Math.PI * frequency * t) * envelope * pulse
    buffer.writeInt16LE(Math.round(value * 32767), 44 + i * 2)
  }

  return buffer
}

function buildMockExportUrl(projectId, exportId) {
  const base = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'
  const params = new URLSearchParams({
    project: String(projectId),
    export: String(exportId || 0),
  })
  return `${base}?${params.toString()}`
}

async function fetchProjectForUser(projectId, userId) {
  const [rows] = await db.execute(
    `SELECT * FROM projects WHERE id = ? AND user_id = ? LIMIT 1`,
    [projectId, userId],
  )
  return rows[0] || null
}

async function loadScriptAgentActivity(activityId, projectId, userId) {
  const [rows] = await db.execute(
    `SELECT *
     FROM script_agent_activities
     WHERE id = ? AND project_id = ? AND user_id = ?
     LIMIT 1`,
    [activityId, projectId, userId],
  )
  return rows[0] || null
}

async function listScriptAgentActivities(projectId, userId, limit = 40) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 40))
  const [rows] = await db.execute(
    `SELECT *
     FROM script_agent_activities
     WHERE project_id = ? AND user_id = ?
     ORDER BY id DESC
     LIMIT ${safeLimit}`,
    [projectId, userId],
  )
  return rows.map(scriptAgentActivityRow)
}

async function fetchProjectById(projectId) {
  const [rows] = await db.execute(`SELECT * FROM projects WHERE id = ? LIMIT 1`, [projectId])
  return rows[0] || null
}

async function getProjectWorkflowReadiness(projectId) {
  const [scenes] = await db.execute(
    `SELECT id, episode_no, scene_no, title, summary, content
     FROM script_scenes WHERE project_id = ?
     ORDER BY episode_no ASC, sort_order ASC, scene_no ASC, id ASC`,
    [projectId],
  )
  const [stateRows] = await db.execute(
    `SELECT parsed_script_fingerprint FROM project_workflow_states WHERE project_id = ? LIMIT 1`,
    [projectId],
  )
  const [characters] = await db.execute(
    `SELECT id FROM characters WHERE project_id = ? AND status <> 'archived'`,
    [projectId],
  )
  const [assetRows] = await db.execute(
    `SELECT n.id, n.node_type, n.ref_id, n.group_key, n.label,
            MAX(CASE WHEN ai.status = 'confirmed'
                      AND ai.image_url NOT LIKE '%/mock-assets/%'
                      AND (ai.model_name IS NULL OR ai.model_name NOT LIKE 'mock-%')
                      AND (ai.vision_status = 'passed'
                           OR (n.node_type = 'scene' AND ai.vision_status = 'skipped')
                           OR ai.vision_status IS NULL OR ai.vision_status = '')
                     THEN 1 ELSE 0 END) AS has_confirmed_image
     FROM asset_nodes n
     LEFT JOIN asset_node_images ai ON ai.asset_node_id = n.id
     WHERE n.project_id = ? AND n.status <> 'archived'
     GROUP BY n.id, n.node_type, n.ref_id, n.group_key, n.label`,
    [projectId],
  )
  const activeNodes = assetRows.map((row) => ({
    nodeType: String(row.node_type || ''),
    refId: row.ref_id == null ? null : Number(row.ref_id),
    groupKey: String(row.group_key || ''),
    label: String(row.label || ''),
    state: Number(row.has_confirmed_image) === 1 ? 'confirmed' : 'pending',
  }))
  const requiredCharacters = characters.map((character) => {
    const nodes = activeNodes.filter((node) => node.nodeType === 'character' && node.refId === Number(character.id))
    if (!nodes.length) return { nodeType: 'character', refId: Number(character.id), exists: false, state: 'missing' }
    return nodes.map((node) => ({ ...node, exists: true }))
  }).flat()
  const requiredScenes = scenes.map((scene) => {
    const node = activeNodes.find((item) => item.nodeType === 'scene'
      && Number(findSceneNodeMatch(item, scenes)?.id) === Number(scene.id))
    if (!node) return { nodeType: 'scene', refId: Number(scene.id), exists: false, state: 'missing' }
    return { ...node, exists: true }
  })
  const gates = evaluateCreativeWorkflowGates({
    scenes,
    parsedFingerprint: stateRows[0]?.parsed_script_fingerprint || '',
    requiredAssets: [...requiredCharacters, ...requiredScenes, ...activeNodes.filter((node) => ['prop', 'tool', 'material'].includes(node.nodeType)).map((node) => ({ ...node, exists: true }))],
  })
  return gates
}

async function persistParsedScriptFingerprint(projectId) {
  const [scenes] = await db.execute(
    `SELECT id, episode_no, scene_no, title, summary, content
     FROM script_scenes WHERE project_id = ?
     ORDER BY episode_no ASC, sort_order ASC, scene_no ASC, id ASC`,
    [projectId],
  )
  if (!scenes.length || scenes.some((scene) => !String(scene.content || '').trim())) {
    const error = new Error('所有场景正文必须先生成并保存，才能完成剧本解析。')
    error.statusCode = 409
    throw error
  }
  const [characters] = await db.execute(
    `SELECT id FROM characters WHERE project_id = ? AND status <> 'archived'`,
    [projectId],
  )
  const [nodes] = await db.execute(
    `SELECT node_type, ref_id, group_key, label FROM asset_nodes
     WHERE project_id = ? AND status <> 'archived'`,
    [projectId],
  )
  const missingCharacter = characters.some((character) => !nodes.some((node) =>
    node.node_type === 'character' && Number(node.ref_id) === Number(character.id),
  ))
  const missingScene = scenes.some((scene) => !nodes.some((node) =>
    node.node_type === 'scene' && Number(findSceneNodeMatch(node, [scene])?.id) === Number(scene.id),
  ))
  if (missingCharacter || missingScene) {
    const error = new Error('剧本解析结果不完整，请重新执行角色与场景解析。')
    error.statusCode = 409
    throw error
  }
  const fingerprint = createScriptFingerprint(scenes)
  await db.execute(
    `INSERT INTO project_workflow_states (project_id, parsed_script_fingerprint, parsed_at)
     VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE parsed_script_fingerprint = VALUES(parsed_script_fingerprint), parsed_at = NOW()`,
    [projectId, fingerprint],
  )
}

async function buildExportPackage(projectId, { episodeNo = null } = {}) {
  const scopedEpisodeNo = parseId(episodeNo) || 0
  const episodeFilter = scopedEpisodeNo ? ' AND sc.episode_no = ?' : ''
  const [rows] = await db.execute(
    `SELECT sc.id AS scene_id,
            sc.episode_no,
            sc.scene_no,
            sc.title AS scene_title,
            s.id AS storyboard_id,
            s.shot_no,
            s.shot_type,
            s.dialogue_text,
            s.duration_seconds AS storyboard_duration_seconds,
            s.image_url,
            s.video_url,
            cva.id AS confirmed_video_asset_id,
            cva.video_url AS confirmed_video_url,
            cva.thumbnail_url AS confirmed_thumbnail_url,
            cva.duration_seconds AS confirmed_video_duration_seconds
     FROM script_scenes sc
     LEFT JOIN storyboards s ON s.scene_id = sc.id
     LEFT JOIN (
       SELECT va.id,
              va.storyboard_id,
              va.video_url,
              va.thumbnail_url,
              va.duration_seconds
       FROM video_assets va
       INNER JOIN (
         SELECT storyboard_id, MAX(id) AS latest_id
         FROM video_assets
         WHERE status = 'confirmed'
         GROUP BY storyboard_id
       ) latest_confirmed ON latest_confirmed.latest_id = va.id
     ) cva ON cva.storyboard_id = s.id
     WHERE sc.project_id = ?
       ${episodeFilter}
     ORDER BY sc.scene_no ASC, s.sort_order ASC, s.id ASC`,
    scopedEpisodeNo ? [projectId, scopedEpisodeNo] : [projectId],
  )

  const rawVideoItems = rows
    .filter((row) => row.storyboard_id)
    .map((row) => {
      const durationSeconds =
        Number.isFinite(Number(row.confirmed_video_duration_seconds)) &&
        Number(row.confirmed_video_duration_seconds) > 0
          ? Number(row.confirmed_video_duration_seconds)
          : Number.isFinite(Number(row.storyboard_duration_seconds)) &&
              Number(row.storyboard_duration_seconds) > 0
            ? Number(row.storyboard_duration_seconds)
            : 4
      return {
        storyboardId: row.storyboard_id,
        durationSeconds,
      }
    })

  const draftRow = await fetchFinalEditDraft(projectId)
  const normalizedDraft = normalizeFinalEditDraftPayload(selectFinalEditDraftForEpisode(draftRow?.draft_json, scopedEpisodeNo), {
    videoItems: rawVideoItems,
    audioTracks: null,
  })
  const draftVideoMap = new Map(
    normalizedDraft.videoClips.map((item, index) => [
      item.storyboardId,
      {
        enabled: item.enabled !== false,
        order: parseId(item.order) || index + 1,
        videoAssetId: parseId(item.videoAssetId) || null,
        trimStartSeconds: item.trimStartSeconds,
        trimEndSeconds: item.trimEndSeconds,
        transition: item.transition,
        transitionManual: item.transitionManual === true,
      },
    ]),
  )

  const incompleteScenes = rows
    .filter((row) => !row.storyboard_id)
    .map((row) => ({
      sceneId: row.scene_id,
      sceneNo: row.scene_no,
      sceneTitle: row.scene_title,
    }))
  const totalShots = rows.filter((row) => row.storyboard_id).length
  const confirmedShots = rows.filter((row) => row.storyboard_id && row.confirmed_video_asset_id).length
  const items = []
  let readyShots = 0
  let totalDurationSeconds = 0
  let coverUrl = null

  for (const row of rows) {
    if (!row.storyboard_id) continue

    const draftItem = draftVideoMap.get(row.storyboard_id)
    if (draftItem && draftItem.enabled === false) {
      continue
    }

    const durationSeconds =
      Number.isFinite(Number(row.confirmed_video_duration_seconds)) &&
      Number(row.confirmed_video_duration_seconds) > 0
        ? Number(row.confirmed_video_duration_seconds)
        : Number.isFinite(Number(row.storyboard_duration_seconds)) &&
            Number(row.storyboard_duration_seconds) > 0
          ? Number(row.storyboard_duration_seconds)
        : 4
    const exportStatus = row.confirmed_video_asset_id
      ? 'ready'
      : row.image_url
        ? 'static-ready'
        : 'missing-video'

    if (exportStatus === 'ready' || exportStatus === 'static-ready') {
      readyShots += 1
      totalDurationSeconds += durationSeconds
      if (!coverUrl && row.image_url) {
        coverUrl = row.image_url
      }
    }

    items.push({
      sceneId: row.scene_id,
      episodeNo: Number(row.episode_no || 1),
      sceneNo: row.scene_no,
      sceneTitle: row.scene_title,
      storyboardId: row.storyboard_id,
      shotNo: row.shot_no,
      shotType: row.shot_type,
      dialogueText: row.dialogue_text || null,
      durationSeconds,
      imageUrl: row.image_url || null,
      videoUrl: row.confirmed_video_url || row.video_url || null,
      exportStatus,
      order: draftItem ? draftItem.order : totalShots,
    })
  }

  items.sort((a, b) => {
    if ((a.order || 0) !== (b.order || 0)) return (a.order || 0) - (b.order || 0)
    if (a.sceneNo !== b.sceneNo) return a.sceneNo - b.sceneNo
    return a.storyboardId - b.storyboardId
  })

  if (!coverUrl) {
    coverUrl = items.find((item) => item.imageUrl)?.imageUrl || null
  }

  const missingStoryboardSceneCount = incompleteScenes.length
  const missingVideoCount = Math.max(totalShots - confirmedShots, 0)
  const blockingIssues = []
  if (missingStoryboardSceneCount > 0) {
    blockingIssues.push({
      code: 'missing-storyboards',
      message: `还有 ${missingStoryboardSceneCount} 个场景尚未生成分镜，请先完成场景拆镜。`,
    })
  }
  if (readyShots === 0) {
    blockingIssues.push({
      code: 'all-video-disabled',
      message: '当前所有视频片段都被禁用了，导出前至少保留一个启用片段。',
    })
  }
  if (scopedEpisodeNo && totalShots === 0) {
    blockingIssues.push({
      code: 'episode-storyboard-manifest-empty',
      message: `第 ${scopedEpisodeNo} 集还没有已保存的分镜，不能生成整集成片。`,
    })
  }
  if (scopedEpisodeNo && missingVideoCount > 0) {
    blockingIssues.push({
      code: 'episode-missing-confirmed-videos',
      message: `第 ${scopedEpisodeNo} 集还有 ${missingVideoCount} 个分镜缺少已确认视频，整集成片已阻止。`,
    })
  }

  return {
    projectId,
    episodeNo: scopedEpisodeNo || null,
    coverUrl,
    totalShots,
    readyShots,
    confirmedShots,
    missingShots: missingVideoCount,
    missingStoryboardScenes: missingStoryboardSceneCount,
    incompleteScenes,
    canExport: blockingIssues.length === 0,
    blockingIssues,
    totalDurationSeconds,
    items,
  }
}

function queueExportJob(exportId) {
  const id = Number(exportId || 0)
  if (!id || activeExportJobs.has(id)) return
  const promise = Promise.resolve()
    .then(() => processExportJob(id))
    .catch((error) => console.error(`[export-job:${id}] unhandled failure`, error))
    .finally(() => activeExportJobs.delete(id))
  activeExportJobs.set(id, promise)
}

async function processExportJob(exportId) {
  // 导出任务的完整执行流程：
  // 1. 读取导出配置和最终剪辑草稿
  // 2. 计算对白/旁白可能撑开的镜头时长
  // 3. 按每个场景限制真实视频数量，其余镜头用静帧转成视频
  // 4. 调 FFmpeg 混合视频、音频和字幕
  // 5. 更新 export_records，供前端轮询和播放
  const [rows] = await db.execute(`SELECT * FROM export_records WHERE id = ? LIMIT 1`, [exportId])
  const record = rows[0]
  if (!record || ['completed', 'failed'].includes(record.status)) return
  let config = {}
  try {
    config = record.config_json ? JSON.parse(record.config_json) : {}
  } catch {
    config = {}
  }

  await db.execute(
    `UPDATE export_records SET status = 'running', updated_at = NOW() WHERE id = ?`,
    [exportId],
  )
  try {
    const project = await fetchProjectById(Number(record.project_id))
    if (!project) throw new Error('project not found for export')
    const requestedEpisode = normalizeEpisodeExportRequest({ episodeNo: config.episodeNo }).episodeNo
    const finalEditPayload = await buildProjectFinalEdit(project, { episodeNo: requestedEpisode })
    const speechDurationByStoryboard = new Map()
    for (const trackKey of ['dialogue', 'narration']) {
      for (const item of finalEditPayload.audioTracks?.[trackKey] || []) {
        const storyboardId = Number(item.storyboardId) || 0
        const audioDuration = Number(item.durationSeconds) || 0
        if (!storyboardId || !audioDuration) continue
        const requiredDuration = resolveRequiredSpeechDuration(item)
        speechDurationByStoryboard.set(
          storyboardId,
          Math.max(speechDurationByStoryboard.get(storyboardId) || 0, requiredDuration),
        )
      }
    }
    let selectedClips
    try {
      selectedClips = selectExportClips(
        finalEditPayload.videoTrack.items,
        config.finalEditDraft || {},
        {
          episodeNo: requestedEpisode,
          storyboardIds: requestedEpisode ? finalEditPayload.summary.storyboardIds : undefined,
        },
      )
    } catch (error) {
      if (!requestedEpisode) throw error
      const message = error instanceof Error ? error.message : '整集分镜素材不完整'
      const missingIds = [...new Set(
        (Array.isArray(error?.storyboardIds) ? error.storyboardIds : [])
          .map((id) => Number(id))
          .filter((id) => id > 0),
      )]
      const issueShots = missingIds.map((storyboardId) => ({
        storyboardId,
        code: 'missing-confirmed-video',
        message: `分镜 ${storyboardId} 缺少已确认视频`,
      }))
      const cinematicQualityReport = evaluateCinematicQuality({
        plan: { planVersion: 'cinematic-edit-plan-v1', sourceCandidatePreserved: true, clips: [] },
        sources: finalEditPayload.videoTrack.items,
        rendered: {
          outputExists: false,
          durationSeconds: 0,
          blockingIssues: [{ code: error?.code || 'episode-source-selection-blocked', message }],
          issueShots,
        },
      })
      const blockedConfig = {
        ...config,
        episodeNo: requestedEpisode,
        pipeline: 'cinematic-final-edit-v1',
        cinematicQualityReport,
      }
      await db.execute(
        `UPDATE export_records SET status = 'blocked', config_json = ?, updated_at = NOW() WHERE id = ?`,
        [JSON.stringify(blockedConfig), exportId],
      )
      return
    }
    const sourceClips = selectedClips
      .map((item) => ({
        ...item,
        durationSeconds: config.episodeNo
          ? Number(item.durationSeconds) || 0
          : Math.max(
              Number(item.durationSeconds) || 0,
              speechDurationByStoryboard.get(Number(item.storyboardId)) || 0,
            ),
      }))
    const draftClipByStoryboardId = new Map(
      (Array.isArray(config.finalEditDraft?.videoClips) ? config.finalEditDraft.videoClips : [])
        .map((item) => [Number(item?.storyboardId), item])
        .filter(([storyboardId]) => storyboardId > 0),
    )
    const cinematicPlanSources = sourceClips.map((item) => {
      const draftItem = draftClipByStoryboardId.get(Number(item.storyboardId))
      return {
        ...item,
        videoAssetId: Number(item.videoAssetId || item.id || 0) || null,
        ...(draftItem
          ? {
              trimStartSeconds: draftItem.trimStartSeconds,
              trimEndSeconds: draftItem.trimEndSeconds,
              transition: draftItem.transition,
            }
          : {}),
      }
    })
    const cinematicEditPlan = buildCinematicEditPlan({
      sources: cinematicPlanSources,
      mode: draftClipByStoryboardId.size ? 'automatic-with-user-edits' : 'automatic',
    })
    const cinematicPlanValidation = validateCinematicEditPlan({
      plan: cinematicEditPlan,
      sources: cinematicPlanSources,
    })
    if (!cinematicPlanValidation.passed) {
      const qualityReport = evaluateCinematicQuality({
        plan: cinematicEditPlan,
        sources: cinematicPlanSources,
        rendered: {
          outputExists: false,
          durationSeconds: 0,
          blockingIssues: cinematicPlanValidation.blockers,
          issueShots: [],
        },
      })
      await db.execute(
        `UPDATE export_records SET status = 'blocked', config_json = ?, updated_at = NOW() WHERE id = ?`,
        [JSON.stringify({
          ...config,
          pipeline: 'cinematic-final-edit-v1',
          cinematicEditPlan,
          cinematicQualityReport: qualityReport,
        }), exportId],
      )
      return
    }
    const plannedClipByStoryboardId = new Map(
      cinematicEditPlan.clips.map((clip) => [Number(clip.storyboardId), clip]),
    )
    const plannedSourceClips = sourceClips.map((item) => {
      const planClip = plannedClipByStoryboardId.get(Number(item.storyboardId))
      if (!planClip) return item
      return {
        ...item,
        trimStartSeconds: planClip.trimStartSeconds,
        trimEndSeconds: planClip.trimEndSeconds,
        durationSeconds: Number(Math.max(0.25, planClip.trimEndSeconds - planClip.trimStartSeconds).toFixed(3)),
        transition: planClip.transition,
      }
    })
    const hybridVideoPerScene = Math.max(
      1,
      Math.min(6, Number(config.hybridVideoPerScene) || Number(config.hybridVideoLimit) || 4),
    )
    const realVideoByScene = new Map()
    let realVideoCount = 0
    const clips = plannedSourceClips.map((item) => {
      const sceneKey = Number(item.sceneId) || Number(item.sceneNo) || 'unknown'
      const sceneRealVideoCount = realVideoByScene.get(sceneKey) || 0
      if (item.sourceType === 'video' && item.videoUrl && sceneRealVideoCount < hybridVideoPerScene) {
        realVideoByScene.set(sceneKey, sceneRealVideoCount + 1)
        realVideoCount += 1
        return item
      }
      if (item.imageUrl) return { ...item, sourceType: 'static', videoUrl: null }
      return item
    })
    if (!clips.length) throw new Error('no enabled mixed-media clips')
    const episodeExportPolicy = resolveEpisodeExportPolicy({ episodeNo: requestedEpisode }) || {}
    const renderConfig = { ...config, ...episodeExportPolicy }
    const rendered = await renderHybridExport({
      exportId,
      projectId: Number(record.project_id),
      config: renderConfig,
      clips,
      audioTracks: finalEditPayload.audioTracks,
      editPlan: cinematicEditPlan,
    })
    const expectedEpisodeAudio = requestedEpisode
      && (config.preserveSourceAudio === true || Object.entries(finalEditPayload.audioTracks || {}).some(([trackKey, items]) =>
        config.finalEditDraft?.audioMix?.[trackKey]?.enabled !== false
        && Array.isArray(items)
        && items.some((item) => item?.audioUrl),
      ))
    const finalInspection = await inspectVideoCandidateFile({
      filePath: rendered.finalPath,
      expected: { durationSeconds: rendered.durationSeconds, requiresAudio: expectedEpisodeAudio },
      ffprobeBin: FFPROBE_BIN,
      ffmpegBin: FFMPEG_BIN,
    })
    const renderedIssueShots = (rendered.skipped || [])
      .filter((item) => Number(item?.storyboardId) > 0)
      .map((item) => ({
        storyboardId: Number(item.storyboardId),
        code: 'rendered-shot-skipped',
        message: `分镜 ${item.storyboardId} 未进入成片：${item.reason || '渲染失败'}`,
      }))
    const audioRenderIssues = resolveCinematicAudioRenderIssues({ skipped: rendered.skipped })
    const inspectionIssues = resolveCinematicInspectionIssues({
      inspection: finalInspection,
      requiresAudio: expectedEpisodeAudio,
    })
    const cinematicQualityReport = evaluateCinematicQuality({
      plan: cinematicEditPlan,
      sources: clips,
      rendered: {
        outputExists: await fileExists(rendered.finalPath),
        durationSeconds: rendered.durationSeconds,
        blockingIssues: [...inspectionIssues.blockers, ...audioRenderIssues.blockers],
        warnings: inspectionIssues.warnings,
        issueShots: [...renderedIssueShots, ...audioRenderIssues.issueShots],
      },
    })
    const exportStorageKey = buildExportStorageKey({
      projectId: Number(record.project_id),
      exportId,
      extension: '.mp4',
    })
    const subtitleStorageKey = buildExportStorageKey({
      projectId: Number(record.project_id),
      exportId,
      extension: '.srt',
    })
    const [storedExport, storedSubtitles] = await Promise.all([
      objectStorage.putObject({
        key: exportStorageKey,
        bytes: await readFile(rendered.finalPath),
        contentType: 'video/mp4',
      }),
      rendered.subtitlePath
        ? objectStorage.putObject({
            key: subtitleStorageKey,
            bytes: await readFile(rendered.subtitlePath),
            contentType: 'application/x-subrip; charset=utf-8',
          })
        : Promise.resolve(null),
    ])
    const videoUrl = storedExport.url
    const coverCandidate = clips[0]?.thumbnailUrl || clips[0]?.imageUrl || record.cover_url || null
    const coverUrl = coverCandidate && !/\.(?:mp4|mov|webm|tiff?)(?:$|\?)/i.test(String(coverCandidate))
      ? coverCandidate
      : null
    const resultConfig = {
      ...renderConfig,
      pipeline: 'hybrid-mvp',
      strictStoryboardAudio: config.strictStoryboardAudio !== false,
      sourceClipCount: clips.length,
      realVideoCount,
      hybridVideoPerScene,
      realVideoByScene: Object.fromEntries(realVideoByScene),
      staticFrameCount: clips.filter((clip) => clip.sourceType === 'static').length,
      boundAudioCount: rendered.boundAudioCount,
      skippedLegacyAudioCount: rendered.skippedLegacyAudioCount,
      skipped: rendered.skipped,
      subtitleFile: storedSubtitles?.url || null,
      subtitleStorageKey: storedSubtitles?.key || null,
      subtitleGenerated: Boolean(storedSubtitles),
      boundaryEvidence: rendered.boundaryEvidence || [],
      sourceAudioPreserved: rendered.sourceAudioPreserved === true,
      cinematicEditPlan,
      cinematicQualityReport,
      technicalQuality: {
        status: cinematicQualityReport.passed ? 'passed' : 'failed',
        automaticPassed: cinematicQualityReport.passed,
        inspectedMedia: finalInspection.metrics || null,
        blockingIssues: cinematicQualityReport.blockers,
      },
    }
    const exportStatus = resolveCinematicExportStatus(cinematicQualityReport)
    await db.execute(
      `UPDATE export_records
       SET status = ?, video_url = ?, storage_key = ?, subtitle_storage_key = ?, cover_url = ?, duration_seconds = ?, config_json = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        exportStatus,
        videoUrl,
        storedExport.key,
        storedSubtitles?.key || null,
        coverUrl,
        rendered.durationSeconds,
        JSON.stringify(resultConfig),
        exportId,
      ],
    )
  } catch (error) {
    const message = sanitizeProviderError(error)
    const failedShotId = Number(message.match(/分镜\s*(\d+)/)?.[1]) || null
    const requestedEpisode = parseId(config.episodeNo) || 0
    const cinematicQualityReport = requestedEpisode
      ? evaluateCinematicQuality({
          plan: config.cinematicEditPlan || {
            planVersion: 'cinematic-edit-plan-v1',
            sourceCandidatePreserved: true,
            clips: [],
          },
          sources: [],
          rendered: {
            outputExists: false,
            durationSeconds: 0,
            blockingIssues: [{
              code: 'episode-render-failed',
              message: `第 ${requestedEpisode} 集成片渲染未完成：${message}`,
            }],
            issueShots: failedShotId
              ? [{
                  storyboardId: failedShotId,
                  code: 'episode-render-failed',
                  message: `分镜 ${failedShotId} 渲染失败：${message}`,
                }]
              : [],
          },
        })
      : null
    const failureConfig = {
      ...config,
      pipeline: 'cinematic-final-edit-v1',
      error: message,
      ...(cinematicQualityReport ? { cinematicQualityReport } : {}),
    }
    await db.execute(
      `UPDATE export_records SET status = ?, config_json = ?, updated_at = NOW() WHERE id = ?`,
      [requestedEpisode ? 'blocked' : 'failed', JSON.stringify(failureConfig), exportId],
    )
    console.error(`[export-job:${exportId}] ${message}`)
  }
}

async function resumeExportJobs() {
  // 服务重启后恢复 queued/running 的导出记录。
  try {
    const [rows] = await db.execute(
      `SELECT id FROM export_records WHERE status IN ('queued', 'running') ORDER BY id ASC`,
    )
    for (const row of rows) queueExportJob(Number(row.id))
  } catch (error) {
    console.error('[export-job] resume failed', error)
  }
}

async function buildProjectAssets(projectId) {
  const [characterRows] = await db.execute(
    `SELECT *
     FROM characters
     WHERE project_id = ? AND status <> 'archived'
     ORDER BY updated_at DESC, id DESC`,
    [projectId],
  )

  const [imageRows] = await db.execute(
    `SELECT ia.*,
            sc.project_id,
            sc.id AS scene_id,
            sc.scene_no,
            sc.title AS scene_title,
            s.id AS storyboard_id,
            s.shot_no
     FROM image_assets ia
     INNER JOIN storyboards s ON s.id = ia.storyboard_id
     INNER JOIN script_scenes sc ON sc.id = s.scene_id
     WHERE sc.project_id = ? AND ia.status <> 'archived'
     ORDER BY ia.created_at DESC, ia.id DESC`,
    [projectId],
  )

  const [videoRows] = await db.execute(
    `SELECT va.*,
            sc.project_id,
            sc.id AS scene_id,
            sc.scene_no,
            sc.title AS scene_title,
            s.id AS storyboard_id,
            s.shot_no
     FROM video_assets va
     INNER JOIN storyboards s ON s.id = va.storyboard_id
     INNER JOIN script_scenes sc ON sc.id = s.scene_id
     WHERE sc.project_id = ? AND va.status <> 'archived'
     ORDER BY va.created_at DESC, va.id DESC`,
    [projectId],
  )

  const [audioRows] = await db.execute(
    `SELECT aa.*,
            sc.scene_no,
            sc.title AS scene_title,
            sb.shot_no,
            c.name AS character_name
     FROM audio_assets aa
     LEFT JOIN script_scenes sc ON sc.id = aa.scene_id
     LEFT JOIN storyboards sb ON sb.id = aa.storyboard_id
     LEFT JOIN characters c ON c.id = aa.character_id
     WHERE aa.project_id = ? AND aa.status <> 'archived'
     ORDER BY aa.created_at DESC, aa.id DESC`,
    [projectId],
  )

  const items = []

  for (const row of characterRows) {
    items.push(
      assetItemRow({
        id: row.id,
        assetType: 'character',
        projectId,
        characterId: row.id,
        name: row.name,
        subtitle: row.role_tag || '角色资产',
        status: row.status || 'draft',
        previewUrl: row.reference_image_url || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    )
  }

  for (const row of imageRows) {
    items.push(
      assetItemRow({
        id: row.id,
        assetType: 'image',
        projectId: row.project_id,
        sceneId: row.scene_id,
        sceneNo: row.scene_no,
        sceneTitle: row.scene_title,
        storyboardId: row.storyboard_id,
        shotNo: row.shot_no,
        name: `Scene ${row.scene_no} / ${row.shot_no || `Shot ${row.storyboard_id}`}`,
        subtitle: row.status === 'confirmed' ? '已确认静帧' : '候选静帧',
        status: row.status,
        previewUrl: row.thumbnail_url || row.image_url || null,
        versionNo: row.version_no,
        createdAt: row.created_at,
      }),
    )
  }

  for (const row of videoRows) {
    items.push(
      assetItemRow({
        id: row.id,
        assetType: 'video',
        projectId: row.project_id,
        sceneId: row.scene_id,
        sceneNo: row.scene_no,
        sceneTitle: row.scene_title,
        storyboardId: row.storyboard_id,
        shotNo: row.shot_no,
        name: `Scene ${row.scene_no} / ${row.shot_no || `Shot ${row.storyboard_id}`}`,
        subtitle: row.status === 'confirmed' ? '已确认视频' : '候选视频',
        status: row.status,
        previewUrl: row.thumbnail_url || null,
        videoUrl: row.video_url || null,
        versionNo: row.version_no,
        createdAt: row.created_at,
      }),
    )
  }

  for (const row of audioRows) {
    const sceneLabel = row.scene_no ? `Scene ${String(row.scene_no).padStart(2, '0')}` : 'Project'
    const sourceLabel = row.character_name
      ? `${sceneLabel} / ${row.character_name}`
      : row.scene_title || sceneLabel
    items.push(
      assetItemRow({
        id: row.id,
        assetType: 'audio',
        projectId: row.project_id,
        sceneId: row.scene_id || null,
        sceneNo: row.scene_no || null,
        sceneTitle: row.scene_title || null,
        storyboardId: null,
        shotNo: null,
        characterId: row.character_id || null,
        characterName: row.character_name || null,
        name: resolveAudioSourceTitle(row),
        subtitle: row.status === 'confirmed' ? `已确认音频 / ${sourceLabel}` : `候选音频 / ${sourceLabel}`,
        status: row.status,
        previewUrl: null,
        audioUrl: row.audio_url || null,
        trackType: row.track_type || null,
        durationSeconds: row.duration_seconds || null,
        voiceName: row.voice_name || null,
        confirmedAt: row.confirmed_at || null,
        versionNo: row.version_no,
        createdAt: row.created_at,
      }),
    )
  }

  const summary = {
    totalCount: items.length,
    characterCount: items.filter((item) => item.assetType === 'character').length,
    imageCount: items.filter((item) => item.assetType === 'image').length,
    videoCount: items.filter((item) => item.assetType === 'video').length,
    audioCount: items.filter((item) => item.assetType === 'audio').length,
    confirmedImageCount: items.filter(
      (item) => item.assetType === 'image' && item.status === 'confirmed',
    ).length,
    confirmedVideoCount: items.filter(
      (item) => item.assetType === 'video' && item.status === 'confirmed',
    ).length,
    confirmedAudioCount: items.filter(
      (item) => item.assetType === 'audio' && item.status === 'confirmed',
    ).length,
  }

  return {
    projectId,
    summary,
    items,
  }
}

async function buildProjectTasks(projectId) {
  const [imageRows] = await db.execute(
    `SELECT ia.*,
            sc.id AS scene_id,
            sc.scene_no,
            sc.title AS scene_title,
            s.id AS storyboard_id,
            s.shot_no,
            s.shot_type
     FROM image_assets ia
     INNER JOIN storyboards s ON s.id = ia.storyboard_id
     INNER JOIN script_scenes sc ON sc.id = s.scene_id
     WHERE sc.project_id = ?
     ORDER BY ia.created_at DESC, ia.id DESC`,
    [projectId],
  )

  const [videoRows] = await db.execute(
    `SELECT va.*,
            sc.id AS scene_id,
            sc.scene_no,
            sc.title AS scene_title,
            s.id AS storyboard_id,
            s.shot_no,
            s.shot_type
     FROM video_assets va
     INNER JOIN storyboards s ON s.id = va.storyboard_id
     INNER JOIN script_scenes sc ON sc.id = s.scene_id
     WHERE sc.project_id = ?
     ORDER BY va.created_at DESC, va.id DESC`,
    [projectId],
  )

  const [audioRows] = await db.execute(
    `SELECT aa.*,
            sc.scene_no,
            sc.title AS scene_title,
            sb.shot_no,
            c.name AS character_name
     FROM audio_assets aa
     LEFT JOIN script_scenes sc ON sc.id = aa.scene_id
     LEFT JOIN storyboards sb ON sb.id = aa.storyboard_id
     LEFT JOIN characters c ON c.id = aa.character_id
     WHERE aa.project_id = ?
     ORDER BY aa.created_at DESC, aa.id DESC`,
    [projectId],
  )

  const [exportRows] = await db.execute(
    `SELECT *
     FROM export_records
     WHERE project_id = ?
     ORDER BY created_at DESC, id DESC`,
    [projectId],
  )

  const [generationJobRows] = await db.execute(
    `SELECT gj.*,
            s.scene_id,
            sc.scene_no,
            sc.title AS scene_title,
            s.shot_no,
            c.name AS character_name,
            an.label AS asset_node_label,
            an.node_type AS asset_node_type
     FROM generation_jobs gj
     LEFT JOIN storyboards s ON gj.job_type IN ('frame_image', 'video_image', 'lip_sync') AND s.id = gj.source_id
     LEFT JOIN script_scenes sc ON sc.id = s.scene_id
     LEFT JOIN characters c ON gj.job_type = 'character_image' AND c.id = gj.source_id
     LEFT JOIN asset_nodes an ON gj.job_type = 'asset_node_image' AND an.id = gj.source_id
     WHERE gj.project_id = ?
     ORDER BY gj.created_at DESC, gj.id DESC`,
    [projectId],
  )

  const items = []

  for (const row of imageRows) {
    items.push(
      projectTaskItemRow({
        taskKey: `image-${row.id}`,
        taskType: 'image',
        sourceId: row.id,
        projectId,
        sceneId: row.scene_id,
        sceneNo: row.scene_no,
        sceneTitle: row.scene_title,
        storyboardId: row.storyboard_id,
        shotNo: row.shot_no,
        versionNo: row.version_no,
        title: `Scene ${String(row.scene_no || 0).padStart(2, '0')} · ${row.shot_no || 'SHOT'} 静帧 V${row.version_no || 1}`,
        subtitle: row.status === 'confirmed' ? '已确认静帧' : '候选静帧',
        status: row.status || 'candidate',
        previewUrl: row.thumbnail_url || row.image_url,
        fileUrl: row.image_url,
        detailText: row.model_name
          ? `模型：${row.model_name}${row.prompt_snapshot ? ' · 已保存提示词快照' : ''}`
          : row.prompt_snapshot
            ? '已保存提示词快照'
            : '静帧生成记录',
        confirmedAt: row.confirmed_at || null,
        createdAt: row.created_at,
      }),
    )
  }

  for (const row of videoRows) {
    const durationText =
      Number.isFinite(Number(row.duration_seconds)) && Number(row.duration_seconds) > 0
        ? `${Number(row.duration_seconds)}s`
        : '时长未设置'
    items.push(
      projectTaskItemRow({
        taskKey: `video-${row.id}`,
        taskType: 'video',
        sourceId: row.id,
        projectId,
        sceneId: row.scene_id,
        sceneNo: row.scene_no,
        sceneTitle: row.scene_title,
        storyboardId: row.storyboard_id,
        shotNo: row.shot_no,
        versionNo: row.version_no,
        title: `Scene ${String(row.scene_no || 0).padStart(2, '0')} · ${row.shot_no || 'SHOT'} 视频 V${row.version_no || 1}`,
        subtitle: row.status === 'confirmed' ? '已确认视频' : '候选视频',
        status: row.status || 'candidate',
        previewUrl: row.thumbnail_url,
        fileUrl: row.video_url,
        detailText: `${row.motion_mode || '未指定运动模式'} · ${durationText}${row.model_name ? ` · 模型：${row.model_name}` : ''}`,
        confirmedAt: row.confirmed_at || null,
        createdAt: row.created_at,
      }),
    )
  }

  for (const row of audioRows) {
    const sceneLabel = row.scene_no ? `Scene ${String(row.scene_no).padStart(2, '0')}` : '项目级'
    const durationText =
      Number.isFinite(Number(row.duration_seconds)) && Number(row.duration_seconds) > 0
        ? `${Number(row.duration_seconds)}s`
        : '时长未设置'
    const voiceName = normalizeTaskText(row.voice_name)
    const characterName = normalizeTaskText(row.character_name)
    items.push(
      projectTaskItemRow({
        taskKey: `audio-${row.id}`,
        taskType: 'audio',
        sourceId: row.id,
        projectId,
        sceneId: row.scene_id || null,
        sceneNo: row.scene_no || null,
        sceneTitle: row.scene_title || null,
        storyboardId: null,
        shotNo: null,
        versionNo: row.version_no,
        title: `${resolveAudioSourceTitle(row)} V${row.version_no || 1}`,
        subtitle: row.status === 'confirmed' ? '已确认音轨' : '候选音轨',
        status: row.status || 'candidate',
        previewUrl: null,
        fileUrl: row.audio_url,
        detailText: `${sceneLabel} · ${row.track_type || 'audio'}${voiceName ? ` · ${voiceName}` : ''}${characterName ? ` · 角色：${characterName}` : ''} · ${durationText}${row.model_name ? ` · 模型：${row.model_name}` : ''}`,
        confirmedAt: row.confirmed_at || null,
        createdAt: row.created_at,
      }),
    )
  }

  for (const row of exportRows) {
    items.push(
      projectTaskItemRow({
        taskKey: `export-${row.id}`,
        taskType: 'export',
        sourceId: row.id,
        projectId,
        sceneId: null,
        sceneNo: null,
        sceneTitle: null,
        storyboardId: null,
        shotNo: null,
        versionNo: null,
        title: `导出任务 #${row.id}`,
        subtitle: row.status === 'completed' ? '导出完成' : row.status || '导出记录',
        status: row.status || 'completed',
        previewUrl: row.cover_url || null,
        fileUrl: row.video_url || null,
        detailText: `就绪分镜 ${row.ready_count || 0}/${row.source_count || 0} · 缺失 ${row.missing_count || 0}${row.duration_seconds ? ` · 成片 ${row.duration_seconds}s` : ''}`,
        confirmedAt: null,
        createdAt: row.created_at,
      }),
    )
  }

  items.sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0
    if (bTime !== aTime) return bTime - aTime
    return b.sourceId - a.sourceId
  })

  const summary = {
    totalCount: items.length,
    imageCount: items.filter((item) => item.taskType === 'image').length,
    videoCount: items.filter((item) => item.taskType === 'video').length,
    audioCount: items.filter((item) => item.taskType === 'audio').length,
    exportCount: items.filter((item) => item.taskType === 'export').length,
    confirmedCount: items.filter((item) => item.status === 'confirmed').length,
    candidateCount: items.filter((item) => item.status === 'candidate').length,
    completedCount: items.filter((item) => item.status === 'completed').length,
  }

  return {
    projectId,
    summary,
    items,
  }
}

async function buildProjectTasksV2(projectId) {
  const [imageRows] = await db.execute(
    `SELECT ia.*,
            sc.id AS scene_id,
            sc.scene_no,
            sc.title AS scene_title,
            s.id AS storyboard_id,
            s.shot_no
     FROM image_assets ia
     INNER JOIN storyboards s ON s.id = ia.storyboard_id
     INNER JOIN script_scenes sc ON sc.id = s.scene_id
     WHERE sc.project_id = ?
     ORDER BY ia.created_at DESC, ia.id DESC`,
    [projectId],
  )

  const [videoRows] = await db.execute(
    `SELECT va.*,
            sc.id AS scene_id,
            sc.scene_no,
            sc.title AS scene_title,
            s.id AS storyboard_id,
            s.shot_no
     FROM video_assets va
     INNER JOIN storyboards s ON s.id = va.storyboard_id
     INNER JOIN script_scenes sc ON sc.id = s.scene_id
     WHERE sc.project_id = ?
     ORDER BY va.created_at DESC, va.id DESC`,
    [projectId],
  )

  const [audioRows] = await db.execute(
    `SELECT aa.*,
            sc.scene_no,
            sc.title AS scene_title,
            sb.shot_no,
            c.name AS character_name
     FROM audio_assets aa
     LEFT JOIN script_scenes sc ON sc.id = aa.scene_id
     LEFT JOIN storyboards sb ON sb.id = aa.storyboard_id
     LEFT JOIN characters c ON c.id = aa.character_id
     WHERE aa.project_id = ?
     ORDER BY aa.created_at DESC, aa.id DESC`,
    [projectId],
  )

  const [exportRows] = await db.execute(
    `SELECT *
     FROM export_records
     WHERE project_id = ?
     ORDER BY created_at DESC, id DESC`,
    [projectId],
  )

  const [generationJobRows] = await db.execute(
    `SELECT gj.*,
            s.scene_id,
            sc.scene_no,
            sc.title AS scene_title,
            s.shot_no,
            c.name AS character_name,
            an.label AS asset_node_label,
            an.node_type AS asset_node_type
     FROM generation_jobs gj
     LEFT JOIN storyboards s ON gj.job_type IN ('frame_image', 'video_image', 'lip_sync') AND s.id = gj.source_id
     LEFT JOIN script_scenes sc ON sc.id = s.scene_id
     LEFT JOIN characters c ON gj.job_type = 'character_image' AND c.id = gj.source_id
     LEFT JOIN asset_nodes an ON gj.job_type = 'asset_node_image' AND an.id = gj.source_id
     WHERE gj.project_id = ?
     ORDER BY gj.created_at DESC, gj.id DESC`,
    [projectId],
  )

  const runtimeRows = await fetchTaskRuntimeRows(projectId)
  const runtimeMap = new Map(runtimeRows.map((row) => [row.task_key, row]))
  const rawItems = []

  for (const row of generationJobRows) {
    const isCharacter = row.job_type === 'character_image'
    const isAssetNode = row.job_type === 'asset_node_image'
    const isLipSync = row.job_type === 'lip_sync'
    const isVideoGeneration = row.job_type === 'video_image'
    const isVideoTask = isLipSync || isVideoGeneration
    const jobResult = safeJsonParse(row.result_json, null)
    const firstResult = isLipSync ? jobResult?.item || null : jobResult?.items?.[0] || null
    rawItems.push({
      taskKey: `generation-${row.id}`,
      taskType: isVideoTask ? 'video' : 'image',
      sourceId: Number(row.id),
      projectId,
      sceneId: row.scene_id || null,
      sceneNo: row.scene_no || null,
      sceneTitle: row.scene_title || null,
      storyboardId: isCharacter || isAssetNode ? null : Number(row.source_id),
      characterId: isCharacter ? Number(row.source_id) : null,
      assetNodeId: isAssetNode ? Number(row.source_id) : null,
      shotNo: row.shot_no || null,
      versionNo: null,
      title: isCharacter
        ? `${row.character_name || '角色'} 定妆图生成`
        : isAssetNode
          ? `${row.asset_node_label || '资产节点'} 形象生成`
        : isLipSync
          ? `Scene ${String(row.scene_no || 0).padStart(2, '0')} / ${row.shot_no || 'SHOT'} 对白口型同步`
          : isVideoGeneration
            ? `Scene ${String(row.scene_no || 0).padStart(2, '0')} / ${row.shot_no || 'SHOT'} 视频生成`
            : `Scene ${String(row.scene_no || 0).padStart(2, '0')} / ${row.shot_no || 'SHOT'} 静帧生成`,
      subtitle: row.status === 'success' ? '生成完成' : row.status === 'failed' ? '生成失败' : '后台处理中',
      status: row.status === 'success' ? 'completed' : row.status,
      previewUrl: normalizeGeneratedMediaUrl(
        firstResult?.thumbnailUrl || firstResult?.imageUrl || null,
        PUBLIC_BASE_URL,
      ),
      fileUrl: normalizeGeneratedMediaUrl(
        firstResult?.videoUrl || firstResult?.imageUrl || null,
        PUBLIC_BASE_URL,
      ),
      detailText: isCharacter
        ? '角色定妆图生成任务'
        : isAssetNode
          ? `资产画布${row.asset_node_type === 'character' ? '角色形象' : '节点图片'}生成任务`
        : isLipSync
          ? '中文对白驱动口型视频'
          : isVideoGeneration
            ? '分镜动作视频生成并持久化任务'
            : '分镜静帧生成任务',
      runtimeStatus: row.status,
      progressPercent: Number(row.progress_percent || 0),
      runtimeMessage:
        row.status === 'queued'
          ? '生成任务正在排队'
          : row.status === 'running'
            ? isLipSync
              ? '正在同步中文对白与人物口型'
              : isVideoGeneration
                ? '正在生成并下载动作视频'
                : '正在调用图片生成模型'
            : row.status === 'success'
              ? isLipSync
                ? '口型视频已生成并保存到本地'
                : isVideoGeneration
                  ? '动作视频已生成并保存到本地'
                  : '图片候选已生成'
              : isLipSync
                ? '口型同步失败'
                : isVideoGeneration
                  ? '动作视频生成失败'
                  : '图片生成失败',
      errorText: row.error_text || null,
      canRetry: row.status === 'failed' || row.status === 'canceled',
      canCancel: false,
      confirmedAt: null,
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
    })
  }

  for (const row of imageRows) {
    rawItems.push({
      taskKey: `image-${row.id}`,
      taskType: 'image',
      sourceId: row.id,
      projectId,
      sceneId: row.scene_id,
      sceneNo: row.scene_no,
      sceneTitle: row.scene_title,
      storyboardId: row.storyboard_id,
      shotNo: row.shot_no,
      versionNo: row.version_no,
      title: `Scene ${String(row.scene_no || 0).padStart(2, '0')} / ${row.shot_no || 'SHOT'} 静帧 V${row.version_no || 1}`,
      subtitle: row.status === 'confirmed' ? '已确认静帧' : '候选静帧',
      status: row.status || 'candidate',
      previewUrl: row.thumbnail_url || row.image_url || null,
      fileUrl: row.image_url || null,
      detailText: row.model_name
        ? `模型：${row.model_name}${row.prompt_snapshot ? ' / 已保存提示词快照' : ''}`
        : row.prompt_snapshot
          ? '已保存提示词快照'
          : '静帧生成记录',
      confirmedAt: row.confirmed_at || null,
      createdAt: row.created_at,
      updatedAt: row.confirmed_at || row.created_at,
    })
  }

  for (const row of videoRows) {
    const durationText =
      Number.isFinite(Number(row.duration_seconds)) && Number(row.duration_seconds) > 0
        ? `${Number(row.duration_seconds)}s`
        : '时长未设置'
    rawItems.push({
      taskKey: `video-${row.id}`,
      taskType: 'video',
      sourceId: row.id,
      projectId,
      sceneId: row.scene_id,
      sceneNo: row.scene_no,
      sceneTitle: row.scene_title,
      storyboardId: row.storyboard_id,
      shotNo: row.shot_no,
      versionNo: row.version_no,
      title: `Scene ${String(row.scene_no || 0).padStart(2, '0')} / ${row.shot_no || 'SHOT'} 视频 V${row.version_no || 1}`,
      subtitle: row.status === 'confirmed' ? '已确认视频' : '候选视频',
      status: row.status || 'candidate',
      previewUrl: row.thumbnail_url || null,
      fileUrl: row.video_url || null,
      detailText: `${row.motion_mode || '未指定运动模式'} / ${durationText}${row.model_name ? ` / 模型：${row.model_name}` : ''}`,
      confirmedAt: row.confirmed_at || null,
      createdAt: row.created_at,
      updatedAt: row.confirmed_at || row.created_at,
    })
  }

  for (const row of audioRows) {
    const sceneLabel = row.scene_no ? `Scene ${String(row.scene_no).padStart(2, '0')}` : '项目级'
    const durationText =
      Number.isFinite(Number(row.duration_seconds)) && Number(row.duration_seconds) > 0
        ? `${Number(row.duration_seconds)}s`
        : '时长未设置'
    const voiceName = normalizeTaskText(row.voice_name)
    const characterName = normalizeTaskText(row.character_name)
    rawItems.push({
      taskKey: `audio-${row.id}`,
      taskType: 'audio',
      sourceId: row.id,
      projectId,
      sceneId: row.scene_id || null,
      sceneNo: row.scene_no || null,
      sceneTitle: row.scene_title || null,
      storyboardId: null,
      shotNo: null,
      versionNo: row.version_no,
      title: `${resolveAudioSourceTitle(row)} V${row.version_no || 1}`,
      subtitle: row.status === 'confirmed' ? '已确认音轨' : row.status === 'archived' ? '已归档音轨' : '候选音轨',
      status: row.status || 'candidate',
      previewUrl: null,
      fileUrl: row.audio_url || null,
      detailText: `${sceneLabel} / ${row.track_type || 'audio'}${voiceName ? ` / ${voiceName}` : ''}${characterName ? ` / 角色：${characterName}` : ''} / ${durationText}${row.model_name ? ` / 模型：${row.model_name}` : ''}`,
      confirmedAt: row.confirmed_at || null,
      createdAt: row.created_at,
      updatedAt: row.confirmed_at || row.created_at,
    })
  }

  for (const row of exportRows) {
    rawItems.push({
      taskKey: `export-${row.id}`,
      taskType: 'export',
      sourceId: row.id,
      projectId,
      sceneId: null,
      sceneNo: null,
      sceneTitle: null,
      storyboardId: null,
      shotNo: null,
      versionNo: null,
      title: `导出任务 #${row.id}`,
      subtitle: row.status === 'completed' ? '导出完成' : row.status || '导出记录',
      status: row.status || 'completed',
      previewUrl: row.cover_url || null,
      fileUrl: row.video_url || null,
      detailText: `就绪分镜 ${row.ready_count || 0}/${row.source_count || 0} / 缺失 ${row.missing_count || 0}${row.duration_seconds ? ` / 成片 ${row.duration_seconds}s` : ''}`,
      confirmedAt: null,
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
    })
  }

  const items = rawItems.map((item) =>
    item.taskKey.startsWith('generation-')
      ? projectTaskItemRow(item)
      : decorateProjectTaskItem(item, runtimeMap.get(item.taskKey)),
  )

  items.sort((a, b) => {
    const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : new Date(a.createdAt || 0).getTime()
    const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : new Date(b.createdAt || 0).getTime()
    if (bTime !== aTime) return bTime - aTime
    return b.sourceId - a.sourceId
  })

  const summary = {
    totalCount: items.length,
    imageCount: items.filter((item) => item.taskType === 'image').length,
    videoCount: items.filter((item) => item.taskType === 'video').length,
    audioCount: items.filter((item) => item.taskType === 'audio').length,
    exportCount: items.filter((item) => item.taskType === 'export').length,
    confirmedCount: items.filter((item) => item.status === 'confirmed').length,
    candidateCount: items.filter((item) => item.status === 'candidate').length,
    completedCount: items.filter((item) => item.status === 'completed').length,
    queuedCount: items.filter((item) => item.runtimeStatus === 'queued').length,
    runningCount: items.filter((item) => item.runtimeStatus === 'running').length,
    successCount: items.filter((item) => item.runtimeStatus === 'success').length,
    failedCount: items.filter((item) => item.runtimeStatus === 'failed').length,
    canceledCount: items.filter((item) => item.runtimeStatus === 'canceled').length,
  }

  return {
    projectId,
    summary,
    items,
  }
}

async function buildProjectFinalEdit(project, { episodeNo = null } = {}) {
  const projectId = Number(project.id)
  const scopedEpisodeNo = parseId(episodeNo) || 0
  const episodeFilter = scopedEpisodeNo ? ' AND sc.episode_no = ?' : ''
  const [completenessRows] = await db.execute(
    `SELECT COUNT(s.id) AS total_storyboard_count,
            SUM(CASE WHEN s.id IS NULL THEN 1 ELSE 0 END) AS missing_storyboard_scene_count
     FROM script_scenes sc
     LEFT JOIN storyboards s ON s.scene_id = sc.id
     WHERE sc.project_id = ? ${episodeFilter}`,
    scopedEpisodeNo ? [projectId, scopedEpisodeNo] : [projectId],
  )
  const projectCompleteness = {
    totalStoryboardCount: Number(completenessRows[0]?.total_storyboard_count || 0),
    missingStoryboardSceneCount: Number(completenessRows[0]?.missing_storyboard_scene_count || 0),
  }
  const [manifestRows] = await db.execute(
    `SELECT s.id AS storyboard_id
     FROM script_scenes sc
     INNER JOIN storyboards s ON s.scene_id = sc.id
     WHERE sc.project_id = ? ${episodeFilter}
     ORDER BY sc.episode_no ASC, sc.scene_no ASC, s.sort_order ASC, s.id ASC`,
    scopedEpisodeNo ? [projectId, scopedEpisodeNo] : [projectId],
  )
  const [videoRows] = await db.execute(
    `SELECT sc.id AS scene_id,
            sc.episode_no,
            sc.scene_no,
            sc.title AS scene_title,
            s.id AS storyboard_id,
            s.shot_no,
            s.shot_type,
            s.dialogue_text,
            s.duration_seconds AS storyboard_duration_seconds,
            s.sort_order,
            va.id AS video_asset_id,
            va.video_url,
            va.storage_key AS video_storage_key,
            va.thumbnail_url,
            va.duration_seconds AS video_duration_seconds,
            va.version_no AS video_version_no,
            va.confirmed_at AS video_confirmed_at,
            ia.id AS image_asset_id,
            ia.image_url AS confirmed_image_url,
            ia.storage_key AS image_storage_key,
            ia.thumbnail_url AS confirmed_image_thumbnail_url
     FROM script_scenes sc
     INNER JOIN storyboards s ON s.scene_id = sc.id
     LEFT JOIN (
       SELECT v1.*
       FROM video_assets v1
       INNER JOIN (
         SELECT storyboard_id, MAX(id) AS latest_id
         FROM video_assets
         WHERE status = 'confirmed'
         GROUP BY storyboard_id
       ) latest_confirmed ON latest_confirmed.latest_id = v1.id
     ) va ON va.storyboard_id = s.id
     LEFT JOIN (
       SELECT i1.*
       FROM image_assets i1
       INNER JOIN (
         SELECT storyboard_id, MAX(id) AS latest_id
         FROM image_assets
         WHERE status = 'confirmed'
         GROUP BY storyboard_id
       ) latest_confirmed_images ON latest_confirmed_images.latest_id = i1.id
     ) ia ON ia.storyboard_id = s.id
     WHERE sc.project_id = ? ${episodeFilter}
       AND (va.id IS NOT NULL OR ia.id IS NOT NULL OR ? = 1)
     ORDER BY sc.scene_no ASC, s.sort_order ASC, s.id ASC`,
    scopedEpisodeNo ? [projectId, scopedEpisodeNo, 1] : [projectId, 0],
  )

  const [audioRows] = await db.execute(
    `SELECT aa.*,
            sc.episode_no,
            sb.shot_no AS storyboard_shot_no,
            sb.duration_seconds AS storyboard_duration_seconds,
            sc.scene_no,
            sc.title AS scene_title,
            c.name AS character_name
     FROM audio_assets aa
     LEFT JOIN storyboards sb ON sb.id = aa.storyboard_id
     LEFT JOIN script_scenes sc ON sc.id = aa.scene_id
     LEFT JOIN characters c ON c.id = aa.character_id
     WHERE aa.project_id = ? AND aa.status = 'confirmed'
       AND (? = 0 OR sc.episode_no = ? OR (aa.scene_id IS NULL AND aa.storyboard_id IS NULL))
     ORDER BY CASE aa.track_type
                WHEN 'dialogue' THEN 1
                WHEN 'narration' THEN 2
                WHEN 'music' THEN 3
                WHEN 'sfx' THEN 4
                ELSE 99
              END ASC,
              aa.scene_id ASC,
              aa.id ASC`,
    [projectId, scopedEpisodeNo, scopedEpisodeNo],
  )

  const audioTracks = {
    dialogue: [],
    narration: [],
    music: [],
    sfx: [],
  }

  let totalSourceDurationSeconds = 0
  const videoItems = []
  for (const row of videoRows) {
    const durationSeconds =
      Number.isFinite(Number(row.video_duration_seconds)) && Number(row.video_duration_seconds) > 0
        ? Number(row.video_duration_seconds)
        : Number.isFinite(Number(row.storyboard_duration_seconds)) &&
            Number(row.storyboard_duration_seconds) > 0
          ? Number(row.storyboard_duration_seconds)
        : 4
    totalSourceDurationSeconds += durationSeconds
    const imageUrl = row.image_storage_key
      ? resolveObjectStorageUrl(row.image_storage_key, row.confirmed_image_url || row.image_url)
      : row.confirmed_image_url || row.image_url || null
    const hasVideo = Boolean(row.video_asset_id && row.video_url)
    videoItems.push({
      storyboardId: row.storyboard_id,
      sceneId: row.scene_id,
      episodeNo: Number(row.episode_no || 1),
      sceneNo: row.scene_no,
      sceneTitle: row.scene_title,
      shotNo: row.shot_no,
      shotType: row.shot_type,
      dialogueText: row.dialogue_text || null,
      durationSeconds,
      sourceDurationSeconds: durationSeconds,
      videoAssetId: row.video_asset_id ? Number(row.video_asset_id) : null,
      sourceType: hasVideo ? 'video' : 'static',
      videoUrl: hasVideo
        ? row.video_storage_key
          ? resolveObjectStorageUrl(row.video_storage_key, row.video_url)
          : normalizeGeneratedMediaUrl(row.video_url, PUBLIC_BASE_URL)
        : null,
      imageUrl,
      thumbnailUrl: row.video_storage_key
        ? resolveObjectStorageUrl(row.video_storage_key, row.thumbnail_url || row.video_url)
        : row.thumbnail_url || row.confirmed_image_thumbnail_url || imageUrl || null,
      versionNo: row.video_version_no || 1,
      confirmedAt: row.video_confirmed_at || null,
      sortOrder: row.sort_order || 0,
      enabled: true,
      order: videoItems.length + 1,
    })
  }

  for (const rawRow of audioRows) {
    const row = await ensureAudioAssetStorage(rawRow)
    const item = {
      id: row.id,
      projectId: row.project_id,
      episodeNo: Number(row.episode_no || 0) || null,
      trackType: row.track_type,
      sceneId: row.scene_id || null,
      storyboardId: row.storyboard_id || null,
      shotNo: row.storyboard_shot_no || null,
      characterId: row.character_id || null,
      versionNo: row.version_no || 1,
      title: resolveAudioSourceTitle({ ...row, project_name: project.name }),
      audioUrl: row.storage_key
        ? resolveObjectStorageUrl(row.storage_key, row.audio_url)
        : row.audio_url,
      durationSeconds:
        Number.isFinite(Number(row.duration_seconds)) && Number(row.duration_seconds) > 0
          ? Number(row.duration_seconds)
          : null,
      startOffsetSeconds: Number(row.start_offset_seconds || 0),
      voiceName: normalizeTaskText(row.voice_name) || null,
      modelName: row.model_name || null,
      confirmedAt: row.confirmed_at || null,
      createdAt: row.created_at,
    }
    if (audioTracks[row.track_type]) {
      audioTracks[row.track_type].push(item)
    }
  }

  const draftRow = await fetchFinalEditDraft(projectId)
  const selectedDraft = selectFinalEditDraftForEpisode(draftRow?.draft_json, scopedEpisodeNo)
  const normalizedDraft = normalizeFinalEditDraftPayload(selectedDraft, {
    videoItems,
    audioTracks,
  })

  const timelineVideoItems = applyFinalEditDraftToVideoItems(videoItems, normalizedDraft)
  videoItems.splice(0, videoItems.length, ...timelineVideoItems)
  Object.assign(audioTracks, applyFinalEditDraftToAudioTracks(audioTracks, normalizedDraft))

  const validation = buildFinalEditValidation(
    videoItems,
    audioTracks,
    normalizedDraft.audioMix,
    projectCompleteness,
  )
  const confirmedAudioCount = Object.values(audioTracks).reduce((sum, items) => sum + items.length, 0)

  return {
    projectId,
    projectName: project.name,
    videoTrack: {
      items: videoItems,
      totalCount: videoItems.length,
      totalDurationSeconds: totalSourceDurationSeconds,
      enabledCount: validation.enabledVideoCount,
      enabledDurationSeconds: validation.enabledVideoDurationSeconds,
    },
    audioTracks,
    audioMix: normalizedDraft.audioMix,
    draft: {
      videoClips: videoItems.map((item) => ({
        clipId: item.clipId || null,
        storyboardId: item.storyboardId,
        enabled: item.enabled !== false,
        order: item.order,
        videoAssetId: item.videoAssetId || null,
        trimStartSeconds: item.trimStartSeconds,
        trimEndSeconds: item.trimEndSeconds,
        transition: item.transition || { type: 'cut', durationSeconds: 0 },
        transitionManual: item.transitionManual === true,
      })),
      audioMix: normalizedDraft.audioMix,
      audioClips: normalizedDraft.audioClips,
      subtitleCues: normalizedDraft.subtitleCues,
      beatMarkers: normalizedDraft.beatMarkers,
      emotionCurve: normalizedDraft.emotionCurve,
      versionHistory: normalizedDraft.versionHistory,
      updatedAt: draftRow?.updated_at || null,
    },
    overlayClips: normalizedDraft.overlayClips,
    validation,
    summary: {
      confirmedVideoCount: validation.confirmedVideoCount,
      confirmedAudioCount,
      hasVideo: videoItems.some((item) => (item.sourceType === 'video' && item.videoUrl) || item.imageUrl),
      hasAudio: confirmedAudioCount > 0,
      totalDurationSeconds: validation.enabledVideoDurationSeconds,
      sourceDurationSeconds: totalSourceDurationSeconds,
      enabledAudioTrackCount: validation.enabledAudioTrackCount,
      availableAudioTrackCount: validation.availableAudioTrackCount,
      totalStoryboardCount: validation.totalStoryboardCount,
      missingVideoCount: validation.missingVideoCount,
      missingStoryboardSceneCount: validation.missingStoryboardSceneCount,
      storyboardIds: manifestRows.map((row) => Number(row.storyboard_id)).filter((id) => id > 0),
      episodeNo: scopedEpisodeNo || null,
    },
  }
}

// HTTP 请求总入口。
// 前面先处理本地媒体文件和健康检查，后面再按 /api/... 路径分发业务接口。
// 每个业务分支通常遵循：解析参数 -> authenticate -> 查库/调用服务 -> success/fail。
const server = createServer(async (req, res) => {
  if (!req.url || !req.method) {
    fail(res, 5000, 'invalid request', 500)
    return
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    })
    res.end()
    return
  }

  const url = new URL(req.url, `http://localhost:${PORT}`)
  const pathname = url.pathname

  try {
    const mockImageMatch = pathname.match(/^\/mock\/image\/(\d+)\/(\d+)\/(\d+)\.svg$/)
    if (req.method === 'GET' && mockImageMatch) {
      const storyboardId = Number(mockImageMatch[1]) || 0
      const versionNo = Number(mockImageMatch[2]) || 0
      const candidateNo = Number(mockImageMatch[3]) || 0
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Content-Type': 'image/svg+xml; charset=utf-8',
      })
      res.end(buildMockImageSvg(storyboardId, versionNo, candidateNo))
      return
    }

    const mockAssetImageMatch = pathname.match(
      /^\/mock-assets\/project-(\d+)\/node-(\d+)\/v(\d+)-(\d+)\.png$/,
    )
    if (req.method === 'GET' && mockAssetImageMatch) {
      const bytes = await readMockAssetImageBytes()
      if (!bytes) {
        fail(res, 4040, 'mock asset image not found', 404)
        return
      }
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
        'Content-Length': bytes.length,
        'Content-Type': 'image/png',
        'X-ProjectDream-Mock-Asset': 'true',
      })
      res.end(bytes)
      return
    }

    const generatedFrameMatch = pathname.match(/^\/generated\/frame\/([a-zA-Z0-9._-]+)$/)
    if (req.method === 'GET' && generatedFrameMatch) {
      const fileName = generatedFrameMatch[1]
      const filePath = path.join(GENERATED_FRAME_DIR, fileName)
      const extension = path.extname(fileName).toLowerCase()
      const contentType =
        extension === '.png'
          ? 'image/png'
          : extension === '.webp'
            ? 'image/webp'
            : 'image/jpeg'

      try {
        const bytes = await readFile(filePath)
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Content-Type': contentType,
        })
        res.end(bytes)
      } catch {
        fail(res, 4040, 'generated frame not found', 404)
      }
      return
    }

    const generatedAudioMatch = pathname.match(/^\/generated\/audio\/([a-zA-Z0-9._-]+)$/)
    if (req.method === 'GET' && generatedAudioMatch) {
      const fileName = generatedAudioMatch[1]
      const filePath = path.join(GENERATED_AUDIO_DIR, fileName)
      const extension = path.extname(fileName).toLowerCase()
      const contentType =
        extension === '.mp3'
          ? 'audio/mpeg'
          : extension === '.ogg'
            ? 'audio/ogg'
            : extension === '.m4a'
              ? 'audio/mp4'
              : 'audio/wav'

      try {
        const bytes = await readFile(filePath)
        const rangeHeader = String(req.headers.range || '')
        const rangeMatch = rangeHeader.match(/^bytes=(\d*)-(\d*)$/)
        if (rangeMatch) {
          const suffixLength = !rangeMatch[1] && rangeMatch[2] ? Number(rangeMatch[2]) : 0
          const start = suffixLength > 0 ? Math.max(0, bytes.length - suffixLength) : Number(rangeMatch[1] || 0)
          const end = suffixLength > 0 ? bytes.length - 1 : Number(rangeMatch[2] || bytes.length - 1)
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= bytes.length) {
            res.writeHead(416, {
              'Access-Control-Allow-Origin': '*',
              'Content-Range': `bytes */${bytes.length}`,
            })
            res.end()
            return
          }

          const finalEnd = Math.min(end, bytes.length - 1)
          const chunk = bytes.subarray(start, finalEnd + 1)
          res.writeHead(206, {
            'Access-Control-Allow-Origin': '*',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Content-Length': chunk.length,
            'Content-Range': `bytes ${start}-${finalEnd}/${bytes.length}`,
            'Content-Type': contentType,
          })
          res.end(chunk)
          return
        }

        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Content-Length': bytes.length,
          'Content-Type': contentType,
        })
        res.end(bytes)
      } catch {
        fail(res, 4040, 'generated audio not found', 404)
      }
      return
    }

    const generatedVideoMatch = pathname.match(/^\/generated\/video\/([a-zA-Z0-9._-]+)$/)
    if (req.method === 'GET' && generatedVideoMatch) {
      const fileName = generatedVideoMatch[1]
      const filePath = path.join(GENERATED_VIDEO_DIR, fileName)
      try {
        const bytes = await readFile(filePath)
        const rangeHeader = String(req.headers.range || '')
        const rangeMatch = rangeHeader.match(/^bytes=(\d*)-(\d*)$/)
        if (rangeMatch) {
          const suffixLength = !rangeMatch[1] && rangeMatch[2] ? Number(rangeMatch[2]) : 0
          const start = suffixLength > 0 ? Math.max(0, bytes.length - suffixLength) : Number(rangeMatch[1] || 0)
          const end = suffixLength > 0 ? bytes.length - 1 : Number(rangeMatch[2] || bytes.length - 1)
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= bytes.length) {
            res.writeHead(416, {
              'Access-Control-Allow-Origin': '*',
              'Content-Range': `bytes */${bytes.length}`,
            })
            res.end()
            return
          }
          const finalEnd = Math.min(end, bytes.length - 1)
          const chunk = bytes.subarray(start, finalEnd + 1)
          res.writeHead(206, {
            'Access-Control-Allow-Origin': '*',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Content-Length': chunk.length,
            'Content-Range': `bytes ${start}-${finalEnd}/${bytes.length}`,
            'Content-Type': 'video/mp4',
          })
          res.end(chunk)
          return
        }
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Content-Length': bytes.length,
          'Content-Type': 'video/mp4',
        })
        res.end(bytes)
      } catch {
        fail(res, 4040, 'generated video not found', 404)
      }
      return
    }

    const mockAudioMatchV2 = pathname.match(
      /^\/mock\/audio\/(\d+)\/(\d+)\/(\d+)\/(\d+)\/([a-z-]+)\/(\d+)\.wav$/,
    )
    const mockAudioMatchV1 = pathname.match(/^\/mock\/audio\/(\d+)\/(\d+)\/([a-z-]+)\/(\d+)\.wav$/)
    const generatedExportMatch = pathname.match(/^\/generated\/export\/(\d+)(?:\/([a-zA-Z0-9._-]+))?$/)
    if (req.method === 'GET' && generatedExportMatch) {
      const exportId = generatedExportMatch[1]
      const fileName = generatedExportMatch[2] || `export-${exportId}.mp4`
      const filePath = path.join(GENERATED_EXPORT_DIR, generatedExportMatch[2] ? exportId : '', fileName)
      const extension = path.extname(fileName).toLowerCase()
      const contentType = extension === '.srt' ? 'application/x-subrip; charset=utf-8' : 'video/mp4'
      try {
        const bytes = await readFile(filePath)
        const rangeHeader = String(req.headers.range || '')
        const rangeMatch = rangeHeader.match(/^bytes=(\d*)-(\d*)$/)
        if (rangeMatch && extension !== '.srt') {
          const suffixLength = !rangeMatch[1] && rangeMatch[2] ? Number(rangeMatch[2]) : 0
          const start = suffixLength > 0 ? Math.max(0, bytes.length - suffixLength) : Number(rangeMatch[1] || 0)
          const end = suffixLength > 0 ? bytes.length - 1 : Number(rangeMatch[2] || bytes.length - 1)
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= bytes.length) {
            res.writeHead(416, { 'Access-Control-Allow-Origin': '*', 'Content-Range': `bytes */${bytes.length}` })
            res.end()
            return
          }
          const finalEnd = Math.min(end, bytes.length - 1)
          const chunk = bytes.subarray(start, finalEnd + 1)
          res.writeHead(206, {
            'Access-Control-Allow-Origin': '*',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Content-Length': chunk.length,
            'Content-Range': `bytes ${start}-${finalEnd}/${bytes.length}`,
            'Content-Type': contentType,
          })
          res.end(chunk)
          return
        }
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Accept-Ranges': extension === '.srt' ? 'none' : 'bytes',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Content-Length': bytes.length,
          'Content-Type': contentType,
        })
        res.end(bytes)
      } catch {
        fail(res, 4040, 'generated export not found', 404)
      }
      return
    }

    if (req.method === 'GET' && (mockAudioMatchV2 || mockAudioMatchV1)) {
      const sceneId = mockAudioMatchV2 ? Number(mockAudioMatchV2[2]) || 0 : 0
      const characterId = mockAudioMatchV2 ? Number(mockAudioMatchV2[3]) || 0 : 0
      const versionNo = mockAudioMatchV2
        ? Number(mockAudioMatchV2[4]) || 1
        : Number(mockAudioMatchV1?.[2]) || 1
      const trackType = String(
        mockAudioMatchV2 ? mockAudioMatchV2[5] || 'dialogue' : mockAudioMatchV1?.[3] || 'dialogue',
      )
      const candidateNo = mockAudioMatchV2
        ? Number(mockAudioMatchV2[6]) || 1
        : Number(mockAudioMatchV1?.[4]) || 1
      const sourceSeed = sceneId * 17 + characterId * 29
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Content-Type': 'audio/wav',
      })
      res.end(buildMockAudioBuffer(trackType, candidateNo, versionNo, sourceSeed))
      return
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      success(res, {
        status: 'ok',
        serverStartedAt: process.env.PROJECTDREAM_SERVER_STARTED_AT || null,
        port: PORT,
        publicBaseUrl: PUBLIC_BASE_URL,
        objectStorageProvider: objectStorage.provider,
        objectStoragePublicBaseUrl: objectStorage.publicBaseUrl,
        smsProvider: smsRuntime.provider,
        smsReady: smsRuntime.ready,
        smsReason: smsRuntime.reason,
        dbName: DB_NAME,
        userCount: await getUserCount(),
      })
      return
    }

    if (pathname === '/api/model-settings') {
      const user = await authenticate(req, res)
      if (!user) return

      if (req.method === 'GET') {
        success(res, await buildModelSettingsPayload())
        return
      }

      if (req.method === 'PUT') {
        const body = await parseBody(req)
        try {
          await saveModelSettings(body.settings, user.id)
        } catch (error) {
          fail(res, 4001, error instanceof Error ? error.message : '模型设置保存失败')
          return
        }
        success(res, await buildModelSettingsPayload(), '模型设置已保存')
        return
      }
    }

    if (req.method === 'GET' && pathname === '/api/auth/check-phone') {
      const phone = normalizePhone(url.searchParams.get('phone'))
      if (!/^1\d{10}$/.test(phone)) {
        fail(res, 4001, '手机号格式不正确')
        return
      }

      success(res, { exists: Boolean(await findUserByPhone(phone)) })
      return
    }

    if (req.method === 'GET' && pathname === '/api/auth/captcha') {
      const phone = normalizePhone(url.searchParams.get('phone') || '')
      const ip = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '')
        .split(',')[0].trim()
      success(res, captchaStore.createChallenge({ ip, phone }))
      return
    }

    if (req.method === 'POST' && pathname === '/api/auth/captcha/verify') {
      const body = await parseBody(req)
      const ip = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '')
        .split(',')[0].trim()
      const result = captchaStore.verify({
        challenge: body.challenge,
        position: body.position,
        phone: normalizePhone(body.phone || ''),
        ip,
      })
      if (!result.ok) {
        fail(res, 4010, result.message, 409)
        return
      }
      success(res, { captchaToken: result.verificationToken }, '滑块验证通过')
      return
    }

    if (req.method === 'POST' && pathname === '/api/auth/send-code') {
      const body = await parseBody(req)
      const phone = normalizePhone(body.phone)
      const typeRaw = String(body.type || 'login')
      const type = typeRaw === 'register' || typeRaw === 'reset' ? typeRaw : 'login'

      if (!/^1\d{10}$/.test(phone)) {
        fail(res, 4001, '手机号格式不正确')
        return
      }

      if (!captchaStore.consumeVerificationToken(body.captchaToken)) {
        fail(res, 4009, '请先完成滑块验证，验证结果已失效或已使用', 409)
        return
      }

      const existingUser = await findUserByPhone(phone)
      if (type === 'register' && existingUser) {
        fail(res, 4002, '该手机号已注册')
        return
      }

      if ((type === 'login' || type === 'reset') && !existingUser) {
        fail(res, 4004, '该手机号尚未注册')
        return
      }

      const record = buildCodeRecord(phone, type)
      const sendResult = await sendVerificationCode(phone, type, record.code)
      record.expiresAtSeconds = sendResult.expiresIn || CODE_TTL_SECONDS
      await saveCodeRecord(record, sendResult.provider)

      success(
        res,
        {
          countdown: sendResult.countdown,
          expiresIn: sendResult.expiresIn,
          devCode: sendResult.devCode,
          provider: sendResult.provider,
        },
        '验证码已发送',
      )
      return
    }

    if (req.method === 'POST' && pathname === '/api/auth/login-password') {
      const body = await parseBody(req)
      const phone = normalizePhone(body.phone)
      const password = String(body.password || '')

      if (!/^1\d{10}$/.test(phone)) {
        fail(res, 4001, '手机号格式不正确')
        return
      }

      if (password.length < 6) {
        fail(res, 4007, '密码至少需要 6 位')
        return
      }

      const user = await findUserByPhone(phone)
      if (!user) {
        fail(res, 4004, '该手机号尚未注册')
        return
      }

      if (!user.passwordHash || user.passwordHash !== hashPassword(password)) {
        fail(res, 4008, '账号或密码不正确')
        return
      }

      const token = await createSession(user)
      success(res, { token, user: toSafeUser(user) }, '登录成功')
      return
    }

    if (req.method === 'POST' && pathname === '/api/auth/reset-password') {
      const body = await parseBody(req)
      const phone = normalizePhone(body.phone)
      const code = String(body.code || '')
      const newPassword = String(body.newPassword || '')

      if (!/^1\d{10}$/.test(phone)) {
        fail(res, 4001, '手机号格式不正确')
        return
      }

      if (!/^\d{4,8}$/.test(code)) {
        fail(res, 4003, '验证码格式不正确')
        return
      }

      if (newPassword.length < 6) {
        fail(res, 4007, '新密码至少需要 6 位')
        return
      }

      const user = await findUserByPhone(phone)
      if (!user) {
        fail(res, 4004, '该手机号尚未注册')
        return
      }

      const codeCheck = await verifySmsCode(phone, 'reset', code)
      if (!codeCheck.ok) {
        fail(res, 4005, codeCheck.message)
        return
      }

      await updateUserPassword(user.id, newPassword)
      success(res, { success: true }, '密码重置成功')
      return
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const body = await parseBody(req)
      const phone = normalizePhone(body.phone)
      const code = String(body.code || '')

      if (!/^1\d{10}$/.test(phone)) {
        fail(res, 4001, '手机号格式不正确')
        return
      }

      if (!/^\d{4,8}$/.test(code)) {
        fail(res, 4003, '验证码格式不正确')
        return
      }

      const user = await findUserByPhone(phone)
      if (!user) {
        fail(res, 4004, '该手机号尚未注册')
        return
      }

      const codeCheck = await verifySmsCode(phone, 'login', code)
      if (!codeCheck.ok) {
        fail(res, 4005, codeCheck.message)
        return
      }

      const token = await createSession(user)
      success(res, { token, user: toSafeUser(user) }, '登录成功')
      return
    }

    if (req.method === 'POST' && pathname === '/api/auth/register') {
      const body = await parseBody(req)
      const phone = normalizePhone(body.phone)
      const code = String(body.code || '')
      const nickname = String(body.nickname || '').trim()
      const password = String(body.password || '')

      if (!/^1\d{10}$/.test(phone)) {
        fail(res, 4001, '手机号格式不正确')
        return
      }

      if (await findUserByPhone(phone)) {
        fail(res, 4002, '该手机号已注册')
        return
      }

      if (!/^\d{4,8}$/.test(code)) {
        fail(res, 4003, '验证码格式不正确')
        return
      }

      if (nickname.length < 2) {
        fail(res, 4006, '昵称至少需要 2 个字符')
        return
      }

      if (password.length < 6) {
        fail(res, 4007, '密码至少需要 6 位')
        return
      }

      const codeCheck = await verifySmsCode(phone, 'register', code)
      if (!codeCheck.ok) {
        fail(res, 4005, codeCheck.message)
        return
      }

      const user = await createUser(phone, nickname, password)
      const token = await createSession(user)
      success(res, { token, user: toSafeUser(user) }, '注册成功')
      return
    }

    // ========== 项目 / 总纲 / 场景 / 剧本 / 分镜 业务接口 ==========

    if (pathname === '/api/projects' || pathname === '/api/projects/') {
      const user = await authenticate(req, res)
      if (!user) return

      if (req.method === 'GET') {
        const [rows] = await db.execute(
          `SELECT p.*,
                  COALESCE(outlines.outline_count, 0) AS outline_count,
                  COALESCE(scenes.scene_count, 0) AS scene_count,
                  COALESCE(storyboards.storyboard_count, 0) AS storyboard_count,
                  COALESCE(images.confirmed_image_count, 0) AS confirmed_image_count,
                  COALESCE(videos.confirmed_video_count, 0) AS confirmed_video_count,
                  COALESCE(audio.confirmed_audio_count, 0) AS confirmed_audio_count,
                  exports.latest_export_id,
                  exports.latest_export_video_url,
                  exports.latest_export_cover_url,
                  exports.latest_export_duration_seconds,
                  exports.latest_export_created_at,
                  (SELECT COALESCE(ia.thumbnail_url, ia.image_url)
                   FROM image_assets ia
                   INNER JOIN storyboards sb ON sb.id = ia.storyboard_id
                   INNER JOIN script_scenes sc ON sc.id = sb.scene_id
                   WHERE sc.project_id = p.id AND ia.status = 'confirmed'
                     AND (ia.thumbnail_url IS NOT NULL OR ia.image_url IS NOT NULL)
                   ORDER BY ia.confirmed_at DESC, ia.id DESC
                   LIMIT 1) AS latest_project_frame_url
           FROM projects p
           LEFT JOIN (
             SELECT project_id, COUNT(*) AS outline_count
             FROM story_outlines
             GROUP BY project_id
           ) outlines ON outlines.project_id = p.id
           LEFT JOIN (
             SELECT project_id, COUNT(*) AS scene_count
             FROM script_scenes
             GROUP BY project_id
           ) scenes ON scenes.project_id = p.id
           LEFT JOIN (
             SELECT sc.project_id, COUNT(*) AS storyboard_count
             FROM storyboards sb
             INNER JOIN script_scenes sc ON sc.id = sb.scene_id
             GROUP BY sc.project_id
           ) storyboards ON storyboards.project_id = p.id
           LEFT JOIN (
             SELECT sc.project_id, COUNT(*) AS confirmed_image_count
             FROM image_assets ia
             INNER JOIN storyboards sb ON sb.id = ia.storyboard_id
             INNER JOIN script_scenes sc ON sc.id = sb.scene_id
             WHERE ia.status = 'confirmed'
             GROUP BY sc.project_id
           ) images ON images.project_id = p.id
           LEFT JOIN (
             SELECT sc.project_id, COUNT(*) AS confirmed_video_count
             FROM video_assets va
             INNER JOIN storyboards sb ON sb.id = va.storyboard_id
             INNER JOIN script_scenes sc ON sc.id = sb.scene_id
             WHERE va.status = 'confirmed'
             GROUP BY sc.project_id
           ) videos ON videos.project_id = p.id
           LEFT JOIN (
             SELECT project_id, COUNT(*) AS confirmed_audio_count
             FROM audio_assets
             WHERE status = 'confirmed'
             GROUP BY project_id
           ) audio ON audio.project_id = p.id
           LEFT JOIN (
             SELECT latest.project_id,
                    latest.id AS latest_export_id,
                    latest.video_url AS latest_export_video_url,
                    latest.cover_url AS latest_export_cover_url,
                    latest.duration_seconds AS latest_export_duration_seconds,
                    latest.created_at AS latest_export_created_at
             FROM export_records latest
             INNER JOIN (
               SELECT project_id, MAX(id) AS latest_id
               FROM export_records
               WHERE status = 'completed'
               GROUP BY project_id
             ) latest_completed ON latest_completed.latest_id = latest.id
           ) exports ON exports.project_id = p.id
           WHERE p.user_id = ?
           ORDER BY p.created_at DESC, p.id DESC`,
          [user.id],
        )
        success(res, { items: rows.map(projectRow) })
        return
      }

      if (req.method === 'POST') {
        const body = await parseBody(req)
        const name = String(body.name || '').trim()
        if (!name) {
          fail(res, 4001, '项目名不能为空')
          return
        }
        const [result] = await db.execute(
          `INSERT INTO projects
             (user_id, name, category, target_duration, narrative_vision, visual_style, aspect_ratio, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
          [
            user.id,
            name,
            body.category ? String(body.category) : null,
            parseId(body.targetDuration) || null,
            body.narrativeVision ? String(body.narrativeVision) : null,
            body.visualStyle ? String(body.visualStyle) : null,
            body.aspectRatio ? String(body.aspectRatio) : null,
          ],
        )
        const projectId = Number(result.insertId)
        const [rows] = await db.execute(`SELECT * FROM projects WHERE id = ?`, [projectId])
        success(res, projectRow(rows[0]), '项目创建成功')
        return
      }
    }

    const projectExportPackageMatch = pathname.match(/^\/api\/projects\/(\d+)\/export-package$/)
    if (projectExportPackageMatch && req.method === 'GET') {
      const user = await authenticate(req, res)
      if (!user) return

      const projectId = parseId(projectExportPackageMatch[1])
      const project = await fetchProjectForUser(projectId, user.id)
      if (!project) {
        fail(res, 4004, '项目不存在或无权访问', 404)
        return
      }

      let episodeRequest
      try {
        episodeRequest = normalizeEpisodeExportRequest({ episodeNo: url.searchParams.get('episodeNo') || undefined })
      } catch (error) {
        fail(res, 4001, error instanceof Error ? error.message : '无效的 episodeNo', 400)
        return
      }
      const exportPackage = await buildExportPackage(projectId, episodeRequest)
      success(res, exportPackage)
      return
    }

    const projectAssetsMatch = pathname.match(/^\/api\/projects\/(\d+)\/assets$/)
    if (projectAssetsMatch && req.method === 'GET') {
      const user = await authenticate(req, res)
      if (!user) return

      const projectId = parseId(projectAssetsMatch[1])
      const project = await fetchProjectForUser(projectId, user.id)
      if (!project) {
        fail(res, 4004, '项目不存在或无权访问', 404)
        return
      }

      const payload = await buildProjectAssets(projectId)
      success(res, payload)
      return
    }

    const projectAssetArchiveMatch = pathname.match(/^\/api\/project-assets\/(character|image|video|audio)\/(\d+)\/archive$/)
    if (projectAssetArchiveMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return

      const assetType = normalizeProjectAssetType(projectAssetArchiveMatch[1])
      const assetId = parseId(projectAssetArchiveMatch[2])
      if (!assetType || !assetId) {
        fail(res, 4001, '无效的项目资产参数', 400)
        return
      }

      const assetQueries = {
        character: `
          SELECT c.id, c.status, p.user_id AS ownerId
          FROM characters c
          INNER JOIN projects p ON p.id = c.project_id
          WHERE c.id = ? LIMIT 1`,
        image: `
          SELECT ia.id, ia.status, p.user_id AS ownerId
          FROM image_assets ia
          INNER JOIN storyboards sb ON sb.id = ia.storyboard_id
          INNER JOIN script_scenes sc ON sc.id = sb.scene_id
          INNER JOIN projects p ON p.id = sc.project_id
          WHERE ia.id = ? LIMIT 1`,
        video: `
          SELECT va.id, va.status, p.user_id AS ownerId
          FROM video_assets va
          INNER JOIN storyboards sb ON sb.id = va.storyboard_id
          INNER JOIN script_scenes sc ON sc.id = sb.scene_id
          INNER JOIN projects p ON p.id = sc.project_id
          WHERE va.id = ? LIMIT 1`,
        audio: `
          SELECT aa.id, aa.status, p.user_id AS ownerId
          FROM audio_assets aa
          INNER JOIN projects p ON p.id = aa.project_id
          WHERE aa.id = ? LIMIT 1`,
      }
      const [rows] = await db.execute(assetQueries[assetType], [assetId])
      const asset = rows[0]
      if (!asset || Number(asset.ownerId) !== Number(user.id)) {
        fail(res, 4004, '项目资产不存在或无权访问', 404)
        return
      }

      const policy = canArchiveProjectAsset({ assetType, status: asset.status })
      if (!policy.allowed) {
        const messages = {
          already_archived: '项目资产已经归档',
          confirmed: '已确认或定稿资产不能直接归档',
          finalized: '已确认或定稿资产不能直接归档',
          done: '已完成资产不允许直接归档',
        }
        fail(res, 4001, messages[policy.reason] || '当前资产不允许归档', 400)
        return
      }

      const tableByType = {
        character: 'characters',
        image: 'image_assets',
        video: 'video_assets',
        audio: 'audio_assets',
      }
      await db.execute(
        `UPDATE ${tableByType[assetType]} SET status = 'archived' WHERE id = ?`,
        [assetId],
      )
      success(res, { id: assetId, assetType, status: 'archived' }, '项目资产已归档')
      return
    }

    const agentPipelineStartMatch = pathname.match(/^\/api\/projects\/(\d+)\/agent-pipeline\/start$/)
    const agentPipelineListMatch = pathname.match(/^\/api\/projects\/(\d+)\/agent-pipeline$/)
    if (agentPipelineStartMatch || agentPipelineListMatch) {
      const user = await authenticate(req, res)
      if (!user) return
      const projectId = parseId(agentPipelineStartMatch?.[1] || agentPipelineListMatch?.[1])
      const project = await fetchProjectForUser(projectId, user.id)
      if (!project) {
        fail(res, 4004, '项目不存在或无权访问', 404)
        return
      }

      if (agentPipelineListMatch && req.method === 'GET') {
        const [rows] = await db.execute(
          `SELECT * FROM agent_pipeline_runs
           WHERE project_id = ? AND user_id = ?
           ORDER BY updated_at DESC, id DESC`,
          [projectId, user.id],
        )
        const items = []
        for (const row of rows) {
          const view = await loadAgentPipelineView(Number(row.id), user.id)
          if (view) items.push(view)
        }
        success(res, { items })
        return
      }

      if (agentPipelineStartMatch && req.method === 'POST') {
        let input
        try {
          input = normalizeAgentPipelineInput(await parseBody(req))
        } catch (error) {
          fail(res, 4001, error instanceof Error ? error.message : 'Agent Pipeline 参数无效')
          return
        }

        const [existingRows] = await db.execute(
          `SELECT id FROM agent_pipeline_runs
           WHERE project_id = ? AND user_id = ? AND idempotency_key = ?
           LIMIT 1`,
          [projectId, user.id, input.idempotencyKey],
        )
        if (existingRows[0]) {
          success(res, await loadAgentPipelineView(Number(existingRows[0].id), user.id), 'Agent Pipeline 已存在')
          return
        }

        const [sceneRows] = await db.execute(
          `SELECT id, scene_no, title, content
           FROM script_scenes
           WHERE project_id = ? AND episode_no = ?
           ORDER BY sort_order ASC, id ASC`,
          [projectId, input.episodeNo],
        )
        if (!sceneRows.some((scene) => String(scene.content || '').trim())) {
          fail(res, 4001, `第 ${input.episodeNo} 集还没有剧本正文，请先完成剧本生成`)
          return
        }

        const [result] = await db.execute(
          `INSERT INTO agent_pipeline_runs
            (project_id, user_id, episode_no, status, current_stage, input_snapshot_json, idempotency_key)
           VALUES (?, ?, ?, 'queued', 'asset-parse', ?, ?)`,
          [
            projectId,
            user.id,
            input.episodeNo,
            JSON.stringify({
              projectId,
              episodeNo: input.episodeNo,
              regenerate: input.regenerate,
              sourceSceneIds: sceneRows.map((scene) => Number(scene.id)),
            }),
            input.idempotencyKey,
          ],
        )
        const runId = Number(result.insertId)
        const run = agentPipelineRunRow({
          id: runId,
          project_id: projectId,
          user_id: user.id,
          episode_no: input.episodeNo,
          status: 'queued',
          current_stage: AGENT_PIPELINE_STAGES[0].key,
          input_snapshot_json: JSON.stringify({
            projectId,
            episodeNo: input.episodeNo,
            regenerate: input.regenerate,
            sourceSceneIds: sceneRows.map((scene) => Number(scene.id)),
          }),
          idempotency_key: input.idempotencyKey,
        })
        try {
          await executePipelineStage(run, 'asset-parse', {})
        } catch (error) {
          await updateAgentPipelineRun(runId, {
            status: 'retryable_failed',
            currentStage: 'asset-parse',
            errorText: error instanceof Error ? error.message : '资产解析 Agent 执行失败',
          })
        }
        success(res, await loadAgentPipelineView(runId, user.id), '资产解析 Agent 已执行')
        return
      }
    }

    const agentPipelineDetailMatch = pathname.match(/^\/api\/agent-pipelines\/(\d+)$/)
    const agentPipelineActionMatch = pathname.match(/^\/api\/agent-pipelines\/(\d+)\/stage-actions$/)
    const agentPipelineDecisionMatch = pathname.match(/^\/api\/agent-pipelines\/(\d+)\/stages\/([^/]+)\/decision$/)
    if (agentPipelineDetailMatch || agentPipelineActionMatch || agentPipelineDecisionMatch) {
      const user = await authenticate(req, res)
      if (!user) return
      const runId = parseId(
        agentPipelineDetailMatch?.[1] ||
        agentPipelineActionMatch?.[1] ||
        agentPipelineDecisionMatch?.[1],
      )
      const view = await loadAgentPipelineView(runId, user.id)
      if (!view) {
        fail(res, 4004, 'Agent Pipeline 不存在或无权访问', 404)
        return
      }
      if (agentPipelineDetailMatch && req.method === 'GET') {
        success(res, view)
        return
      }
      if (agentPipelineActionMatch && req.method === 'POST') {
        let input
        try {
          input = normalizeAgentPipelineStageAction(await parseBody(req))
        } catch (error) {
          fail(res, 4001, error instanceof Error ? error.message : 'Agent 阶段动作参数无效')
          return
        }
        const run = view.run
        if (!['completed', 'waiting_approval', 'running'].includes(run.status) && run.status !== 'paused') {
          fail(res, 4090, '当前 Pipeline 不允许登记业务动作', 409)
          return
        }
        try {
          const result = await registerAgentPipelineStageAction(run, input)
          success(res, await loadAgentPipelineView(runId, user.id), `${getAgentPipelineStage(input.stageKey).label} 已登记`)
        } catch (error) {
          fail(res, 4011, error instanceof Error ? error.message : 'Agent 阶段动作登记失败', 400)
        }
        return
      }
      if (agentPipelineDecisionMatch && req.method === 'POST') {
        const stageKey = decodeURIComponent(agentPipelineDecisionMatch[2])
        const body = await parseBody(req)
        const decision = String(body.decision || '').trim()
        if (!['approve', 'reject'].includes(decision)) {
          fail(res, 4001, 'Agent 检查点决定无效')
          return
        }
        const stageExecution = view.executions.find((item) => item.stageKey === stageKey)
        if (!stageExecution || stageExecution.status !== 'waiting_approval') {
          fail(res, 4001, '当前 Agent 阶段还没有可审批的结果')
          return
        }
        if (decision === 'reject') {
          await updateAgentPipelineRun(runId, {
            status: 'paused',
            currentStage: stageKey,
            errorText: String(body.note || '').trim() || '人工检查点未通过',
          })
          success(res, await loadAgentPipelineView(runId, user.id), 'Agent Pipeline 已暂停')
          return
        }

        const run = view.run
        const nextStage = getNextAgentPipelineStageForKeys(stageKey, SCRIPTING_PIPELINE_STAGE_KEYS)
        if (!nextStage) {
          if (stageKey !== 'storyboard') {
            await updateAgentPipelineRun(runId, {
              status: 'paused',
              currentStage: stageKey,
              errorText: '当前阶段已确认，但后续阶段需要由对应业务页面的真实操作触发',
            })
            success(res, await loadAgentPipelineView(runId, user.id), '当前阶段已确认')
            return
          }
          await updateAgentPipelineRun(runId, {
            status: 'completed',
            currentStage: 'storyboard',
            errorText: '',
          })
          success(res, await loadAgentPipelineView(runId, user.id), '剧本链已完成，请进入分镜创作页')
          return
        }

        const nextOutputs = {
          ...(run.outputSnapshot || {}),
          [stageKey]: stageExecution.outputSnapshot || {},
        }
        await updateAgentPipelineRun(runId, {
          status: 'running',
          currentStage: nextStage.key,
          outputSnapshot: nextOutputs,
          errorText: '',
        })
        // 人工确认只是一次持久化决策，不能让浏览器连接继续等待后续模型调用。
        // 例如“场景锁定 -> 分镜”会调用文本模型；同步等待会被反向代理判为 502，
        // 从而出现“已确认”与“请求失败”同时显示的假失败。
        void executePipelineStage(
          { ...run, status: 'running', currentStage: nextStage.key, outputSnapshot: nextOutputs },
          nextStage.key,
          nextOutputs,
        ).catch(async (error) => {
          try {
            await updateAgentPipelineRun(runId, {
              status: 'retryable_failed',
              currentStage: nextStage.key,
              errorText: error instanceof Error ? error.message : `${nextStage.label} Agent 执行失败`,
            })
          } catch (persistError) {
            console.error('[agent-pipeline] failed to persist async stage failure', persistError)
          }
        })
        success(
          res,
          await loadAgentPipelineView(runId, user.id),
          `${getAgentPipelineStage(stageKey)?.label || stageKey} 已确认，${nextStage.label} Agent 已启动，状态将在后台更新`,
        )
        return
      }
    }

    const storageMatch = pathname.match(/^\/storage\/(.+)$/)
    if (req.method === 'GET' && storageMatch && ['local', 'cos'].includes(objectStorage.provider)) {
      try {
        const key = decodeURIComponent(storageMatch[1])
        const object = await objectStorage.getObject(key)
        if (!object) {
          fail(res, 4040, 'stored object not found', 404)
          return
        }
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Content-Length': object.bytes.length,
          'Content-Type': object.contentType || 'application/octet-stream',
        })
        res.end(object.bytes)
      } catch {
        fail(res, 4040, 'stored object not found', 404)
      }
      return
    }

    const scriptAgentActivitiesMatch = pathname.match(/^\/api\/projects\/(\d+)\/script-agent\/activities$/)
    if (scriptAgentActivitiesMatch) {
      const user = await authenticate(req, res)
      if (!user) return

      const projectId = parseId(scriptAgentActivitiesMatch[1])
      const project = await fetchProjectForUser(projectId, user.id)
      if (!project) {
        fail(res, 4004, '项目不存在或无权访问', 404)
        return
      }

      if (req.method === 'GET') {
        success(res, { items: await listScriptAgentActivities(projectId, user.id, url.searchParams.get('limit')) })
        return
      }

      if (req.method !== 'POST') {
        fail(res, 4050, 'Script Agent 活动只支持读取和写入', 405)
        return
      }

      const body = await parseBody(req)
      const phase = String(body.phase || 'start').trim()
      if (!['start', 'complete', 'fail', 'blocked'].includes(phase)) {
        fail(res, 4001, '无效的 Script Agent 活动阶段')
        return
      }

      if (phase === 'start') {
        let input
        try {
          input = buildScriptAgentActivityPayload({
            ...body,
            status: 'running',
          })
        } catch (error) {
          fail(res, 4001, error instanceof Error ? error.message : 'Script Agent 活动参数无效')
          return
        }

        if (input.idempotencyKey) {
          const [existingRows] = await db.execute(
            `SELECT *
             FROM script_agent_activities
             WHERE project_id = ? AND idempotency_key = ?
             LIMIT 1`,
            [projectId, input.idempotencyKey],
          )
          if (existingRows[0]) {
            const item = scriptAgentActivityRow(existingRows[0])
            success(res, { item, reaction: item.reaction }, 'Script Agent 活动已存在')
            return
          }
        }

        try {
          const [result] = await db.execute(
            `INSERT INTO script_agent_activities
              (project_id, user_id, stage_key, action_key, agent_key, source, status,
               title, summary, context_json, result_json, reaction_json, idempotency_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              projectId,
              user.id,
              input.stageKey,
              input.actionKey,
              input.agentKey,
              input.source,
              input.status,
              input.title,
              input.summary || null,
              JSON.stringify(input.context),
              JSON.stringify(input.result),
              JSON.stringify(input.reaction),
              input.idempotencyKey || null,
            ],
          )
          const row = await loadScriptAgentActivity(Number(result.insertId), projectId, user.id)
          const item = scriptAgentActivityRow(row)
          success(res, { item, reaction: item.reaction }, 'Script Agent 已开始执行')
        } catch (error) {
          if (error?.code === 'ER_DUP_ENTRY' && input.idempotencyKey) {
            const [existingRows] = await db.execute(
              `SELECT *
               FROM script_agent_activities
               WHERE project_id = ? AND idempotency_key = ?
               LIMIT 1`,
              [projectId, input.idempotencyKey],
            )
            if (existingRows[0]) {
              const item = scriptAgentActivityRow(existingRows[0])
              success(res, { item, reaction: item.reaction }, 'Script Agent 活动已存在')
              return
            }
          }
          throw error
        }
        return
      }

      const activityId = parseId(body.activityId)
      const existing = await loadScriptAgentActivity(activityId, projectId, user.id)
      if (!existing) {
        fail(res, 4004, 'Script Agent 活动不存在或无权访问', 404)
        return
      }

      const status = phase === 'complete' ? 'completed' : phase === 'blocked' ? 'blocked' : 'failed'
      let input
      try {
        input = buildScriptAgentActivityPayload({
          actionKey: existing.action_key,
          agentKey: existing.agent_key,
          stageKey: existing.stage_key,
          source: existing.source,
          status,
          title: body.title || existing.title,
          summary: body.summary || '',
          context: body.context || parseJsonObject(existing.context_json),
          result: body.result || {},
          errorText: body.errorText || '',
        })
      } catch (error) {
        fail(res, 4001, error instanceof Error ? error.message : 'Script Agent 活动参数无效')
        return
      }

      await db.execute(
        `UPDATE script_agent_activities
         SET status = ?, title = ?, summary = ?, context_json = ?, result_json = ?,
             reaction_json = ?, error_text = ?, finished_at = CURRENT_TIMESTAMP
         WHERE id = ? AND project_id = ? AND user_id = ?`,
        [
          input.status,
          input.title,
          input.summary || null,
          JSON.stringify(input.context),
          JSON.stringify(input.result),
          JSON.stringify(input.reaction),
          input.errorText || null,
          activityId,
          projectId,
          user.id,
        ],
      )
      const row = await loadScriptAgentActivity(activityId, projectId, user.id)
      const item = scriptAgentActivityRow(row)
      success(res, { item, reaction: item.reaction }, 'Script Agent 活动已更新')
      return
    }

    const storyQualityMatch = pathname.match(
      /^\/api\/projects\/(\d+)\/(story-bible|season-structure)(?:\/(evaluate|lock|generate))?$/,
    )
    if (storyQualityMatch) {
      const user = await authenticate(req, res)
      if (!user) return
      const projectId = parseId(storyQualityMatch[1])
      const resource = storyQualityMatch[2]
      const action = storyQualityMatch[3] || ''
      const project = await fetchProjectForUser(projectId, user.id)
      if (!project) {
        fail(res, 4004, '项目不存在或无权访问', 404)
        return
      }

      const isBible = resource === 'story-bible'
      if (req.method === 'GET' && !action) {
        const table = isBible ? 'story_bibles' : 'season_structures'
        const [rows] = await db.execute(
          `SELECT * FROM ${table} WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
          [projectId],
        )
        success(res, rows[0] ? (isBible ? storyBibleRow(rows[0]) : seasonStructureRow(rows[0])) : null)
        return
      }

      const body = await parseBody(req)
      if (req.method === 'POST' && action === 'generate' && isBible) {
        const idea = String(body.idea || '').trim()
        if (!idea) {
          fail(res, 4001, '请先写下你的创意，再生成故事设定')
          return
        }
        try {
          const generated = await generateStoryBible(project, {
            idea,
            episodeCount: Math.max(1, Math.min(50, parseId(body.episodeCount) || 1)),
          })
          const bible = normalizeStoryBibleInput(generated)
          const report = evaluateStoryBible(bible)
          const row = await persistStoryBible(projectId, bible, report, false)
          success(res, { item: storyBibleRow(row), report }, '故事设定已生成')
        } catch (error) {
          fail(res, 5020, error instanceof Error ? error.message : '故事设定生成失败', 502)
        }
        return
      }

      if (req.method === 'POST' && action === 'generate' && !isBible) {
        const [bibleRows] = await db.execute(
          `SELECT * FROM story_bibles WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
          [projectId],
        )
        if (!bibleRows[0]) {
          fail(res, 4001, '请先生成并保存故事设定')
          return
        }
        try {
          const generated = await generateSeasonStructure(project, storyBibleRow(bibleRows[0]), {
            episodeCount: Math.max(1, Math.min(50, parseId(body.episodeCount) || 1)),
          })
          const season = normalizeSeasonStructureInput(generated)
          const report = evaluateSeasonStructure(season)
          const row = await persistSeasonStructure(
            projectId,
            Number(bibleRows[0].id),
            season,
            report,
            false,
          )
          success(res, { item: seasonStructureRow(row), report }, '分集大纲已生成')
        } catch (error) {
          fail(res, 5020, error instanceof Error ? error.message : '分集大纲生成失败', 502)
        }
        return
      }

      if (req.method === 'PUT' || (req.method === 'POST' && ['evaluate', 'lock'].includes(action))) {
        if (isBible) {
          const bible = normalizeStoryBibleInput(body)
          const report = evaluateStoryBible(bible)
          const row = await persistStoryBible(projectId, bible, report, action === 'lock')
          success(res, { item: storyBibleRow(row), report }, action === 'lock' ? '故事设定已确认' : '故事设定已保存')
        } else {
          const season = normalizeSeasonStructureInput(body)
          const report = evaluateSeasonStructure(season)
          const [bibleRows] = await db.execute(
            `SELECT id FROM story_bibles WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
            [projectId],
          )
          const row = await persistSeasonStructure(projectId, bibleRows[0]?.id || null, season, report, action === 'lock')
          success(res, { item: seasonStructureRow(row), report }, action === 'lock' ? '分集大纲已确认' : '分集大纲已保存')
        }
        return
      }
    }

    const productionRunsMatch = pathname.match(/^\/api\/projects\/(\d+)\/production-runs$/)
    if (productionRunsMatch) {
      const user = await authenticate(req, res)
      if (!user) return
      const projectId = parseId(productionRunsMatch[1])
      const project = await fetchProjectForUser(projectId, user.id)
      if (!project) {
        fail(res, 4004, '项目不存在或无权访问', 404)
        return
      }
      if (req.method === 'GET') {
        const [rows] = await db.execute(
          `SELECT pr.*, p.name AS project_name
           FROM production_runs pr INNER JOIN projects p ON p.id = pr.project_id
           WHERE pr.project_id = ? ORDER BY pr.updated_at DESC, pr.id DESC`,
          [projectId],
        )
        success(res, { items: rows.map(productionRunRow) })
        return
      }
      if (req.method === 'POST') {
        const body = await parseBody(req)
        const input = normalizeProductionRunInput({ ...body, projectId })
        const idempotencyKey = String(body.idempotencyKey || '').trim() || null
        if (idempotencyKey) {
          const [existing] = await db.execute(
            `SELECT id FROM production_runs WHERE project_id = ? AND idempotency_key = ? LIMIT 1`,
            [projectId, idempotencyKey],
          )
          if (existing[0]) {
            success(res, await loadProductionRunView(Number(existing[0].id), user.id), 'ProductionRun 已存在')
            return
          }
        }
        const { bible, season } = await loadProductionStorySources(projectId)
        const episode = Array.isArray(season.episodes)
          ? season.episodes.find((item) => Number(item?.episodeNo || item?.episode_no) === input.episodeNo) ||
            season.episodes[input.episodeNo - 1] ||
            {}
          : {}
        const sourceScript = await loadProductionScriptSource(projectId, input.episodeNo)
        const blueprint = buildEpisodeBlueprint({
          projectId,
          episodeNo: input.episodeNo,
          episode,
          bible,
          platform: input.platform,
          candidatePolicy: input.candidatePolicy,
          sourceScript: sourceScript,
        })
        const qualityReport = evaluateEpisodeBlueprint(blueprint)
        const seed = buildProductionRunSeed({ ...input, blueprint })
        const connection = await db.getConnection()
        let runId = 0
        try {
          await connection.beginTransaction()
          const [runResult] = await connection.execute(
            `INSERT INTO production_runs
              (project_id, user_id, episode_no, platform, name, status, current_stage, current_checkpoint,
               pilot_mode, pilot_scene_count, budget, candidate_policy_json, success_metrics_json,
               input_snapshot_json, output_snapshot_json, idempotency_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              projectId, user.id, input.episodeNo, input.platform,
              `${project.name || '项目'} · 第 ${input.episodeNo} 集黄金样片`,
              seed.run.status, seed.run.currentStage, seed.run.currentCheckpoint,
              seed.run.pilotMode, seed.run.pilotSceneCount, seed.run.budget,
              JSON.stringify(seed.run.candidatePolicy), JSON.stringify(seed.run.successMetrics),
              JSON.stringify(seed.run.inputSnapshot), JSON.stringify({ blueprint }), idempotencyKey,
            ],
          )
          runId = Number(runResult.insertId)
          for (const stage of seed.stages) {
            await connection.execute(
              `INSERT INTO production_stage_runs
                (production_run_id, stage_key, sequence_no, agent_key, status, input_snapshot_json)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [runId, stage.stageKey, stage.sequenceNo, stage.agentKey, stage.status,
                stage.inputSnapshot ? JSON.stringify(stage.inputSnapshot) : null],
            )
          }
          for (const checkpoint of seed.checkpoints) {
            await connection.execute(
              `INSERT INTO production_checkpoints
                (production_run_id, checkpoint_key, stage_key, status, decision_note)
               VALUES (?, ?, ?, ?, ?)`,
              [runId, checkpoint.checkpointKey, checkpoint.stageKey, checkpoint.status, checkpoint.decisionNote],
            )
          }
          await connection.execute(
            `INSERT INTO production_agent_executions
              (production_run_id, stage_key, agent_key, status) VALUES (?, ?, ?, 'pending')`,
            [runId, seed.stages[0].stageKey, seed.stages[0].agentKey],
          )
          await connection.execute(
            `INSERT INTO episode_blueprints
              (production_run_id, project_id, episode_no, version_no, status, blueprint_json, quality_report_json)
             VALUES (?, ?, ?, 1, 'draft', ?, ?)`,
            [runId, projectId, input.episodeNo, JSON.stringify(blueprint), JSON.stringify(qualityReport)],
          )
          await connection.commit()
        } catch (error) {
          await connection.rollback()
          if (error?.code === 'ER_DUP_ENTRY' && idempotencyKey) {
            const [existing] = await db.execute(
              `SELECT id FROM production_runs WHERE project_id = ? AND idempotency_key = ? LIMIT 1`,
              [projectId, idempotencyKey],
            )
            if (existing[0]) {
              success(res, await loadProductionRunView(Number(existing[0].id), user.id), 'ProductionRun 已存在')
              return
            }
          }
          throw error
        } finally {
          connection.release()
        }
        success(res, await loadProductionRunView(runId, user.id), 'ProductionRun 已创建')
        return
      }
    }

    const productionRunDetailMatch = pathname.match(/^\/api\/production-runs\/(\d+)$/)
    const productionBlueprintMatch = pathname.match(/^\/api\/production-runs\/(\d+)\/blueprint$/)
    const productionCheckpointMatch = pathname.match(/^\/api\/production-runs\/(\d+)\/checkpoints\/([^/]+)\/decision$/)
    const productionStageCompletionMatch = pathname.match(/^\/api\/production-runs\/(\d+)\/stages\/([^/]+)\/complete$/)
    if (productionRunDetailMatch || productionBlueprintMatch || productionCheckpointMatch || productionStageCompletionMatch) {
      const user = await authenticate(req, res)
      if (!user) return
      const runId = parseId(
        productionRunDetailMatch?.[1] || productionBlueprintMatch?.[1] ||
        productionCheckpointMatch?.[1] || productionStageCompletionMatch?.[1],
      )
      const view = await loadProductionRunView(runId, user.id)
      if (!view) {
        fail(res, 4004, '生产运行不存在或无权访问', 404)
        return
      }
      if (productionRunDetailMatch && req.method === 'GET') {
        success(res, view)
        return
      }
      if (productionBlueprintMatch && req.method === 'PUT') {
        const body = await parseBody(req)
        const blueprint = body.blueprint && typeof body.blueprint === 'object' ? body.blueprint : {}
        const report = evaluateEpisodeBlueprint(blueprint)
        const [versions] = await db.execute(
          `SELECT COALESCE(MAX(version_no), 0) AS max_version FROM episode_blueprints WHERE production_run_id = ?`,
          [runId],
        )
        const versionNo = Number(versions[0]?.max_version || 0) + 1
        const [result] = await db.execute(
          `INSERT INTO episode_blueprints
            (production_run_id, project_id, episode_no, version_no, status, blueprint_json, quality_report_json)
           VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
          [runId, view.run.projectId, view.run.episodeNo, versionNo, JSON.stringify(blueprint), JSON.stringify(report)],
        )
        await db.execute(
          `UPDATE production_runs SET output_snapshot_json = ?, updated_at = NOW() WHERE id = ?`,
          [JSON.stringify({ blueprint }), runId],
        )
        const [rows] = await db.execute(`SELECT * FROM episode_blueprints WHERE id = ? LIMIT 1`, [result.insertId])
        success(res, { blueprint: productionBlueprintRow(rows[0], []), report }, '单集蓝图已保存')
        return
      }
      if (productionCheckpointMatch && req.method === 'POST') {
        const checkpointKey = decodeURIComponent(productionCheckpointMatch[2])
        const body = await parseBody(req)
        const decision = String(body.decision || '').trim()
        if (!['approve', 'reject'].includes(decision)) {
          fail(res, 4001, '检查点决定无效', 400)
          return
        }
        const checkpoint = view.checkpoints.find((item) => item.checkpointKey === checkpointKey)
        if (!checkpoint || checkpoint.status !== 'pending') {
          fail(res, 4001, '当前检查点不可审批，请先完成前置阶段', 400)
          return
        }
        if (checkpointKey === 'blueprint' && !view.blueprint?.qualityReport?.canApprove) {
          fail(res, 4001, '单集蓝图尚未通过质量门禁，不能审批进入生成', 400)
          return
        }
        const stageIndex = PRODUCTION_RUN_STAGES.findIndex((item) => item.key === view.run.currentStage)
        const nextStage = PRODUCTION_RUN_STAGES[stageIndex + 1] || null
        const connection = await db.getConnection()
        try {
          await connection.beginTransaction()
          await connection.execute(
            `UPDATE production_checkpoints SET status = ?, decision_note = ?, reviewed_at = NOW()
             WHERE id = ?`,
            [decision === 'approve' ? 'approved' : 'rejected', String(body.note || '').trim() || null, checkpoint.id],
          )
          if (decision === 'reject') {
            await connection.execute(
              `UPDATE production_runs SET status = 'paused', failure_code = 'checkpoint-rejected',
               failure_text = ?, updated_at = NOW() WHERE id = ?`,
              [String(body.note || '').trim() || '检查点被拒绝', runId],
            )
          } else if (nextStage) {
            await connection.execute(
              `UPDATE production_stage_runs SET status = 'completed', finished_at = NOW()
               WHERE production_run_id = ? AND stage_key = ?`,
              [runId, view.run.currentStage],
            )
            await connection.execute(
              `UPDATE production_stage_runs SET status = ?, started_at = NOW()
               WHERE production_run_id = ? AND stage_key = ?`,
              [nextStage.checkpointKey ? 'waiting_approval' : 'ready', runId, nextStage.key],
            )
            if (nextStage.checkpointKey) {
              await connection.execute(
                `UPDATE production_checkpoints SET status = 'pending'
                 WHERE production_run_id = ? AND checkpoint_key = ?`,
                [runId, nextStage.checkpointKey],
              )
            }
            await connection.execute(
              `UPDATE production_runs SET status = ?, current_stage = ?, current_checkpoint = ?,
               failure_code = NULL, failure_text = NULL, updated_at = NOW() WHERE id = ?`,
              [nextStage.checkpointKey ? 'waiting_approval' : 'running', nextStage.key, nextStage.checkpointKey || null, runId],
            )
          } else {
            await connection.execute(
              `UPDATE production_runs SET status = 'completed', current_checkpoint = NULL, updated_at = NOW()
               WHERE id = ?`,
              [runId],
            )
          }
          await connection.commit()
        } catch (error) {
          await connection.rollback()
          throw error
        } finally {
          connection.release()
        }
        success(res, await loadProductionRunView(runId, user.id), decision === 'approve' ? '检查点已批准' : '检查点已拒绝')
        return
      }
      if (productionStageCompletionMatch && req.method === 'POST') {
        const body = await parseBody(req)
        const transition = buildProductionStageCompletionTransition({
          run: view.run,
          stages: view.stages,
          checkpoints: view.checkpoints,
          completedStageKey: decodeURIComponent(productionStageCompletionMatch[2]),
          outputSnapshot: body.outputSnapshot || {},
        })
        if (!transition?.run || !Array.isArray(transition.stageUpdates)) {
          fail(res, 4001, '当前阶段不可完成', 400)
          return
        }
        const connection = await db.getConnection()
        try {
          await connection.beginTransaction()
          for (const update of transition.stageUpdates) {
            await connection.execute(
              `UPDATE production_stage_runs SET status = ?, output_snapshot_json = ?,
               finished_at = CASE WHEN ? = 'completed' THEN NOW() ELSE finished_at END
               WHERE production_run_id = ? AND stage_key = ?`,
              [update.status, update.outputSnapshot ? JSON.stringify(update.outputSnapshot) : null,
                update.status, runId, update.stageKey],
            )
          }
          for (const update of transition.checkpointUpdates) {
            await connection.execute(
              `UPDATE production_checkpoints SET status = ? WHERE production_run_id = ? AND checkpoint_key = ?`,
              [update.status, runId, update.checkpointKey],
            )
          }
          await connection.execute(
            `UPDATE production_runs SET status = ?, current_stage = ?, current_checkpoint = ?, updated_at = NOW()
             WHERE id = ?`,
            [transition.run.status, transition.run.currentStage, transition.run.currentCheckpoint, runId],
          )
          await connection.commit()
        } catch (error) {
          await connection.rollback()
          throw error
        } finally {
          connection.release()
        }
        success(res, await loadProductionRunView(runId, user.id), '当前生产阶段已完成')
        return
      }
    }

    const workflowReadinessMatch = pathname.match(/^\/api\/projects\/(\d+)\/workflow-readiness(\/parse-complete)?$/)
    if (workflowReadinessMatch) {
      const user = await authenticate(req, res)
      if (!user) return
      const projectId = parseId(workflowReadinessMatch[1])
      if (!(await fetchProjectForUser(projectId, user.id))) {
        fail(res, 4004, '项目不存在或无权访问', 404)
        return
      }
      if (workflowReadinessMatch[2] && req.method === 'POST') {
        try {
          await persistParsedScriptFingerprint(projectId)
        } catch (error) {
          fail(res, 4004, error instanceof Error ? error.message : '剧本尚未完成', error?.statusCode || 409)
          return
        }
        success(res, await getProjectWorkflowReadiness(projectId), '当前剧本解析状态已确认')
        return
      }
      if (req.method !== 'GET' || workflowReadinessMatch[2]) {
        fail(res, 4001, '不支持的项目流程状态操作', 405)
        return
      }
      success(res, await getProjectWorkflowReadiness(projectId), '项目流程门禁已读取')
      return
    }

    const assetCanvasMatch = pathname.match(/^\/api\/projects\/(\d+)\/asset-canvas$/)
    if (assetCanvasMatch && req.method === 'GET') {
      const user = await authenticate(req, res)
      if (!user) return
      const projectId = parseId(assetCanvasMatch[1])
      if (!(await fetchProjectForUser(projectId, user.id))) {
        fail(res, 4004, '项目不存在或无权访问', 404)
        return
      }
      const [nodes] = await db.execute(
        `SELECT n.*,
                (SELECT COUNT(*) FROM asset_node_images ai WHERE ai.asset_node_id = n.id) AS image_count
         FROM asset_nodes n
         WHERE n.project_id = ? AND n.status <> 'archived' ORDER BY n.id ASC`,
        [projectId],
      )
      // 兼容旧版解析留下的重复场景节点：旧节点的 label 含有“场景：/时间未明确”，
      // 且没有隔离的环境提示词；保留同一剧本场景的新节点和全部图片记录，归档旧壳。
      const legacySceneIds = nodes
        .filter((node) => node.node_type === 'scene'
          && node.ref_id
          && !String(node.environment_prompt_text || '').trim()
          && /场景：|时间未明确/u.test(String(node.label || node.appearance_label || '')))
        .map((node) => Number(node.id))
        .filter(Number.isSafeInteger)
      if (legacySceneIds.length) {
        await db.execute(
          `UPDATE asset_nodes SET status = 'archived', updated_at = NOW()
           WHERE project_id = ? AND id IN (${legacySceneIds.map(() => '?').join(',')})`,
          [projectId, ...legacySceneIds],
        )
        for (let index = nodes.length - 1; index >= 0; index -= 1) {
          if (legacySceneIds.includes(Number(nodes[index].id))) nodes.splice(index, 1)
        }
      }
      const duplicatePlan = buildActiveAssetNodeDedupPlan(nodes)
      if (duplicatePlan.archiveIds.length) {
        await db.execute(
          `UPDATE asset_nodes SET status = 'archived', updated_at = NOW()
           WHERE project_id = ? AND id IN (${duplicatePlan.archiveIds.map(() => '?').join(',')})`,
          [projectId, ...duplicatePlan.archiveIds],
        )
        for (let index = nodes.length - 1; index >= 0; index -= 1) {
          if (duplicatePlan.archiveIds.includes(Number(nodes[index].id))) nodes.splice(index, 1)
        }
      }
      const project = await fetchProjectById(projectId)
      const [sceneRows] = await db.execute(
        `SELECT id, scene_no, title, summary, content, spatial_anchors_json, location, time_of_day
         FROM script_scenes
         WHERE project_id = ?
         ORDER BY episode_no ASC, scene_no ASC, id ASC`,
        [projectId],
      )
      const [characterRows] = await db.execute(
        `SELECT * FROM characters WHERE project_id = ? AND status <> 'archived' ORDER BY id ASC`,
        [projectId],
      )
      // 场景提示词属于剧本解析结果的派生快照。即使旧节点已经有 ref_id，
      // 也必须在每次读取画布时重新绑定并刷新，避免 Agent 提示词升级后旧快照永久滞留。
      const sceneNodes = nodes.filter((node) => node.node_type === 'scene')
      const propLikeNodeIds = nodes
        .filter((node) => ['prop', 'material'].includes(String(node.node_type || '')))
        .map((node) => Number(node.id))
        .filter(Number.isSafeInteger)
      if (propLikeNodeIds.length) {
        const [passedPropRows] = await db.execute(
          `SELECT id FROM asset_node_images
           WHERE asset_node_id IN (${propLikeNodeIds.map(() => '?').join(',')})
             AND view_set_type = 'single' AND status = 'candidate' AND vision_status = 'passed'`,
          propLikeNodeIds,
        )
        for (const image of passedPropRows) await autoAdoptSingleAsset(image.id)
      }
      for (const node of nodes.filter((item) => item.node_type === 'character' && item.ref_id)) {
        const character = characterRows.find((item) => Number(item.id) === Number(node.ref_id))
        if (!character) continue
        const characterScenes = sceneRows.filter((scene) => [
          scene.title,
          scene.summary,
          scene.content,
          scene.location,
        ].some((value) => String(value || '').includes(character.name)))
        const generated = buildScriptCharacterPrompt({
          character,
          scenes: characterScenes,
          projectVisualStyle: project?.visual_style || '',
          projectCategory: project?.category || '',
        })
        const noFaceConstraintRequired = !requiresCharacterFaceReference(
          character,
          ...characterScenes.map((scene) => scene.content),
        )
        const stalePrompt = !String(node.prompt_text || '').trim()
          || /固定服装与随身物件：由 Agent 根据剧本场景、时代、身份和动作自动整理/u.test(String(node.prompt_text || ''))
          || (noFaceConstraintRequired && !/本角色在剧情中明确不直接露脸/u.test(String(node.prompt_text || '')))
          || isLegacyCharacterPrompt(node.prompt_text)
        const staleTurnaround = !String(node.turnaround_prompt_text || '').trim()
          || (noFaceConstraintRequired && !/该角色剧情约束为不直接露脸/u.test(String(node.turnaround_prompt_text || '')))
        if (!stalePrompt && !staleTurnaround) continue
        await db.execute(
          `UPDATE asset_nodes
           SET prompt_text = CASE WHEN ? THEN ? ELSE prompt_text END,
               turnaround_prompt_text = CASE WHEN ? THEN ? ELSE turnaround_prompt_text END,
               negative_prompt = CASE WHEN (negative_prompt IS NULL OR negative_prompt = '') THEN ? ELSE negative_prompt END,
               updated_at = NOW()
           WHERE id = ?`,
          [
            stalePrompt,
            generated.prompt,
            staleTurnaround,
            generated.turnaroundPrompt,
            generated.negativePrompt,
            node.id,
          ],
        )
        if (stalePrompt) node.prompt_text = generated.prompt
        if (staleTurnaround) node.turnaround_prompt_text = generated.turnaroundPrompt
        if (!String(node.negative_prompt || '').trim()) node.negative_prompt = generated.negativePrompt
      }
      if (sceneNodes.length) {
        for (const node of sceneNodes) {
          const matchedScene = findSceneNodeMatch(node, sceneRows)
          if (!matchedScene) continue
          const promptText = buildScriptScenePrompt({
            scene: matchedScene,
            projectVisualStyle: project?.visual_style || '',
            projectCategory: project?.category || '',
            characterNames: characterRows.map((character) => character.name).filter(Boolean),
          })
          const environmentPromptText = buildSceneEnvironmentPrompt({
            scene: matchedScene,
            projectVisualStyle: project?.visual_style || '',
            projectCategory: project?.category || '',
            characterNames: characterRows.map((character) => character.name).filter(Boolean),
          })
          const expectedGroupKey = `scene:${matchedScene.id}:default`
          const staleSceneLink = Number(node.ref_id || 0) !== Number(matchedScene.id)
            || String(node.group_key || '') !== expectedGroupKey
          const refreshedLabel = buildSceneDisplayLabel(matchedScene)
          const refreshedAppearanceLabel = [inferSceneLocation(matchedScene), inferSceneTimeOfDay(matchedScene)]
            .filter(Boolean)
            .join(' · ') || null
          await db.execute(
            `UPDATE asset_nodes
             SET ref_id = ?, prompt_text = ?, environment_prompt_text = ?,
                 label = CASE
                   WHEN ? OR label IS NULL OR label = '' OR label = ? OR label LIKE '%死后三天%' OR label LIKE '%场景：%'
                   THEN ? ELSE label END,
                 group_key = CASE WHEN ? THEN ? ELSE group_key END,
                 appearance_label = CASE
                   WHEN appearance_label IS NULL OR appearance_label = '' OR appearance_label LIKE '%未明确%'
                   THEN ? ELSE appearance_label END,
                 updated_at = NOW()
             WHERE id = ?`,
            [
              matchedScene.id,
              promptText,
              environmentPromptText,
              staleSceneLink,
              matchedScene.title,
              refreshedLabel,
              staleSceneLink,
              expectedGroupKey,
              refreshedAppearanceLabel,
              node.id,
            ],
          )
          node.ref_id = Number(matchedScene.id)
          node.prompt_text = promptText
          node.environment_prompt_text = environmentPromptText
          if (staleSceneLink || !String(node.label || '').trim() || node.label === matchedScene.title || /死后三天|场景：/u.test(String(node.label || ''))) {
            node.label = refreshedLabel
          }
          if (staleSceneLink) node.group_key = expectedGroupKey
          node.appearance_label = node.appearance_label
            || refreshedAppearanceLabel
            || null
        }
      }
      let images = []
      if (nodes.length) {
        const placeholders = nodes.map(() => '?').join(', ')
        const [rows] = await db.execute(
          `SELECT * FROM asset_node_images WHERE asset_node_id IN (${placeholders}) ORDER BY id ASC`,
          nodes.map((node) => node.id),
        )
        images = rows
      }
      const canvasView = buildAssetCanvasView({
        projectId,
        nodes,
        images: images.map(assetNodeImageDto),
      })
      success(res, canvasView)
      return
    }

    const projectAssetNodeCreateMatch = pathname.match(/^\/api\/projects\/(\d+)\/asset-nodes$/)
    if (projectAssetNodeCreateMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return
      const projectId = parseId(projectAssetNodeCreateMatch[1])
      if (!(await fetchProjectForUser(projectId, user.id))) {
        fail(res, 4004, '项目不存在或无权访问', 404)
        return
      }
      const body = await parseBody(req)
      const nodeType = normalizeAssetNodeType(body.nodeType)
      if (!nodeType) {
        fail(res, 4001, '无效的节点类型，只支持 character / scene / prop / material')
        return
      }
      let refId = null
      let label = String(body.label || '').trim()
      let character = null
      let scene = null
      if (nodeType === 'character' && body.refId != null) {
        const [characterRows] = await db.execute(
          `SELECT * FROM characters
           WHERE id = ? AND project_id = ? AND status <> 'archived' LIMIT 1`,
          [parseId(body.refId), projectId],
        )
        if (!characterRows[0]) {
          fail(res, 4004, '角色不存在或不属于该项目', 404)
          return
        }
        character = characterRows[0]
        refId = Number(character.id)
        if (!label) label = String(character.name || '').trim()
      }
      if (nodeType === 'scene' && body.refId != null) {
        const [sceneRows] = await db.execute(
          `SELECT id, scene_no, title, summary, content, location, time_of_day
           FROM script_scenes
           WHERE id = ? AND project_id = ? LIMIT 1`,
          [parseId(body.refId), projectId],
        )
        if (!sceneRows[0]) {
          fail(res, 4004, '关联场景不存在或不属于该项目', 404)
          return
        }
        scene = sceneRows[0]
        refId = Number(scene.id)
        if (!label) label = buildSceneDisplayLabel(scene)
      }
      if (!label) {
        fail(res, 4001, '请填写节点名称')
        return
      }
      let promptText = body.promptText != null ? String(body.promptText) : null
      let turnaroundPromptText = body.turnaroundPromptText != null
        ? String(body.turnaroundPromptText)
        : null
      let environmentPromptText = body.environmentPromptText != null
        ? String(body.environmentPromptText)
        : null
      let negativePrompt = body.negativePrompt != null ? String(body.negativePrompt) : null
      if ((nodeType === 'character' || nodeType === 'scene') && promptText == null) {
        const [projectRows] = await db.execute(
          `SELECT visual_style, category FROM projects WHERE id = ? LIMIT 1`,
          [projectId],
        )
        const [sceneRows] = await db.execute(
          `SELECT episode_no, scene_no, title, summary, content, location, time_of_day
           FROM script_scenes WHERE project_id = ? ORDER BY episode_no ASC, scene_no ASC, id ASC`,
          [projectId],
        )
        if (nodeType === 'character' && character) {
          const generated = buildScriptCharacterPrompt({
            character,
            scenes: sceneRows,
            projectVisualStyle: projectRows[0]?.visual_style || '',
            projectCategory: projectRows[0]?.category || '',
          })
          promptText = generated.prompt
          if (turnaroundPromptText == null) turnaroundPromptText = generated.turnaroundPrompt
          if (negativePrompt == null) negativePrompt = generated.negativePrompt
        } else if (nodeType === 'scene' && scene) {
          promptText = buildScriptScenePrompt({
            scene,
            projectVisualStyle: projectRows[0]?.visual_style || '',
            projectCategory: projectRows[0]?.category || '',
          })
          environmentPromptText = buildSceneEnvironmentPrompt({
            scene,
            projectVisualStyle: projectRows[0]?.visual_style || '',
            projectCategory: projectRows[0]?.category || '',
          })
        }
      }
      const layout = normalizeAssetNodeLayout(body)
      const [result] = await db.execute(
        `INSERT INTO asset_nodes
          (project_id, node_type, ref_id, label, appearance_label, prompt_text, turnaround_prompt_text,
           environment_prompt_text, negative_prompt,
           x, y, width, height, group_key, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [
          projectId,
          nodeType,
          refId,
          label,
          body.appearanceLabel != null ? String(body.appearanceLabel).trim() || null : null,
          promptText,
          turnaroundPromptText,
          environmentPromptText,
          negativePrompt,
          layout.x,
          layout.y,
          layout.width,
          layout.height,
          body.groupKey != null ? normalizeAssetGroupKey(String(body.groupKey).trim()) || null : null,
        ],
      )
      const [rows] = await db.execute('SELECT * FROM asset_nodes WHERE id = ? LIMIT 1', [result.insertId])
      success(res, buildAssetCanvasView({ projectId, nodes: rows }).nodes[0], '画布节点已创建')
      return
    }

    const assetNodeMatch = pathname.match(/^\/api\/asset-nodes\/(\d+)$/)
    const assetNodeRelinkSceneMatch = pathname.match(/^\/api\/asset-nodes\/(\d+)\/relink-scene$/)
    const assetNodeHydratePromptMatch = pathname.match(/^\/api\/asset-nodes\/(\d+)\/hydrate-prompt$/)
    if (assetNodeRelinkSceneMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return
      const nodeId = parseId(assetNodeRelinkSceneMatch[1])
      const resolved = await fetchAssetNodeForUser(nodeId, user.id)
      if (!resolved) {
        fail(res, 4004, '画布节点不存在或无权访问', 404)
        return
      }
      if (resolved.node.node_type !== 'scene') {
        fail(res, 4001, '只有场景节点可以重新关联剧本场景', 400)
        return
      }
      const body = await parseBody(req)
      const [sceneRows] = await db.execute(
        `SELECT id, scene_no, title, summary, content, location, time_of_day
         FROM script_scenes WHERE project_id = ? ORDER BY episode_no ASC, scene_no ASC, id ASC`,
        [resolved.node.project_id],
      )
      const scene = chooseSceneForRelink({
        requestedSceneId: body.sceneId,
        requestedLabel: body.label || body.location,
        scenes: sceneRows,
      })
      if (!scene) {
        fail(res, 4004, '没有找到可关联的剧本场景，请提供有效 sceneId 或场景名称', 404)
        return
      }
      const [projectRows] = await db.execute(
        `SELECT visual_style, category FROM projects WHERE id = ? LIMIT 1`,
        [resolved.node.project_id],
      )
      const promptText = buildScriptScenePrompt({
        scene,
        projectVisualStyle: projectRows[0]?.visual_style || '',
        projectCategory: projectRows[0]?.category || '',
      })
      const environmentPromptText = buildSceneEnvironmentPrompt({
        scene,
        projectVisualStyle: projectRows[0]?.visual_style || '',
        projectCategory: projectRows[0]?.category || '',
      })
      await db.execute(
        `UPDATE asset_nodes
         SET ref_id = ?, label = ?, group_key = ?, prompt_text = ?,
             environment_prompt_text = ?, appearance_label = ?, updated_at = NOW()
         WHERE id = ?`,
        [
          scene.id,
          buildSceneDisplayLabel(scene),
          `scene:${scene.id}:default`,
          promptText,
          environmentPromptText,
          [scene.location, scene.time_of_day].filter(Boolean).join(' · ') || null,
          nodeId,
        ],
      )
      const [rows] = await db.execute('SELECT * FROM asset_nodes WHERE id = ? LIMIT 1', [nodeId])
      const [images] = await db.execute(
        'SELECT * FROM asset_node_images WHERE asset_node_id = ? ORDER BY id ASC',
        [nodeId],
      )
      success(
        res,
        buildAssetCanvasView({
          projectId: Number(resolved.node.project_id),
          nodes: rows,
          images: images.map(assetNodeImageDto),
        }).nodes[0],
        '场景节点已重新关联并刷新提示词',
      )
      return
    }
    if (assetNodeHydratePromptMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return
      const nodeId = parseId(assetNodeHydratePromptMatch[1])
      const resolved = await fetchAssetNodeForUser(nodeId, user.id)
      if (!resolved) {
        fail(res, 4004, '画布节点不存在或无权访问', 404)
        return
      }
      if (!['scene', 'character'].includes(resolved.node.node_type) || !resolved.node.ref_id) {
        fail(res, 4001, '只有关联剧本场景或角色的节点可以自动补齐提示词', 400)
        return
      }
      const [projectRows] = await db.execute(
        `SELECT visual_style, category FROM projects WHERE id = ? LIMIT 1`,
        [resolved.node.project_id],
      )
      let promptText = ''
      let environmentPromptText = null
      let turnaroundPromptText = null
      let negativePrompt = null
      if (resolved.node.node_type === 'scene') {
        const [sceneRows] = await db.execute(
        `SELECT id, scene_no, title, summary, content, spatial_anchors_json, location, time_of_day
           FROM script_scenes WHERE id = ? AND project_id = ? LIMIT 1`,
          [resolved.node.ref_id, resolved.node.project_id],
        )
        if (!sceneRows[0]) {
          fail(res, 4004, '关联剧本场景不存在', 404)
          return
        }
        promptText = buildScriptScenePrompt({
          scene: sceneRows[0],
          projectVisualStyle: projectRows[0]?.visual_style || '',
          projectCategory: projectRows[0]?.category || '',
        })
        environmentPromptText = buildSceneEnvironmentPrompt({
          scene: sceneRows[0],
          projectVisualStyle: projectRows[0]?.visual_style || '',
          projectCategory: projectRows[0]?.category || '',
        })
      } else {
        const [characterRows] = await db.execute(
          `SELECT * FROM characters WHERE id = ? AND project_id = ? AND status <> 'archived' LIMIT 1`,
          [resolved.node.ref_id, resolved.node.project_id],
        )
        if (!characterRows[0]) {
          fail(res, 4004, '关联剧本角色不存在', 404)
          return
        }
        const [sceneRows] = await db.execute(
          `SELECT episode_no, scene_no, title, summary, content, location, time_of_day
           FROM script_scenes WHERE project_id = ? ORDER BY episode_no ASC, scene_no ASC, id ASC`,
          [resolved.node.project_id],
        )
        const generated = buildScriptCharacterPrompt({
          character: characterRows[0],
          scenes: sceneRows,
          projectVisualStyle: projectRows[0]?.visual_style || '',
          projectCategory: projectRows[0]?.category || '',
        })
        promptText = generated.prompt
        turnaroundPromptText = generated.turnaroundPrompt
        negativePrompt = generated.negativePrompt
      }
      await db.execute(
        `UPDATE asset_nodes
         SET prompt_text = ?, turnaround_prompt_text = COALESCE(?, turnaround_prompt_text),
             environment_prompt_text = COALESCE(?, environment_prompt_text),
             negative_prompt = COALESCE(?, negative_prompt), updated_at = NOW()
         WHERE id = ?`,
        [promptText, turnaroundPromptText, environmentPromptText, negativePrompt, nodeId],
      )
      const [rows] = await db.execute('SELECT * FROM asset_nodes WHERE id = ? LIMIT 1', [nodeId])
      const [images] = await db.execute(
        'SELECT * FROM asset_node_images WHERE asset_node_id = ? ORDER BY id ASC',
        [nodeId],
      )
      success(
        res,
        buildAssetCanvasView({
          projectId: Number(resolved.node.project_id),
          nodes: rows,
          images: images.map(assetNodeImageDto),
        }).nodes[0],
        `${resolved.node.node_type === 'scene' ? '场景' : '角色'}详细提示词已补齐并保存`,
      )
      return
    }
    if (assetNodeMatch && req.method === 'PATCH') {
      const user = await authenticate(req, res)
      if (!user) return
      const nodeId = parseId(assetNodeMatch[1])
      const resolved = await fetchAssetNodeForUser(nodeId, user.id)
      if (!resolved) {
        fail(res, 4004, '画布节点不存在或无权访问', 404)
        return
      }
      const body = await parseBody(req)
      const updates = []
      const params = []
      for (const [key, column] of [
        ['label', 'label'],
        ['appearanceLabel', 'appearance_label'],
        ['promptText', 'prompt_text'],
        ['turnaroundPromptText', 'turnaround_prompt_text'],
        ['environmentPromptText', 'environment_prompt_text'],
        ['negativePrompt', 'negative_prompt'],
        ['groupKey', 'group_key'],
      ]) {
        if (body[key] === undefined) continue
        const value = body[key] == null ? '' : String(body[key]).trim()
        if (key === 'label' && !value) {
          fail(res, 4001, '节点名称不能为空')
          return
        }
        updates.push(`${column} = ?`)
        params.push(key === 'appearanceLabel' || key === 'groupKey' ? value || null : value)
      }
      if (['x', 'y', 'width', 'height'].some((key) => body[key] !== undefined)) {
        const layout = normalizeAssetNodeLayout({
          x: body.x ?? resolved.node.x,
          y: body.y ?? resolved.node.y,
          width: body.width ?? resolved.node.width,
          height: body.height ?? resolved.node.height,
        })
        updates.push('x = ?', 'y = ?', 'width = ?', 'height = ?')
        params.push(layout.x, layout.y, layout.width, layout.height)
      }
      if (!updates.length) {
        fail(res, 4001, '没有可更新的字段')
        return
      }
      params.push(nodeId)
      await db.execute(`UPDATE asset_nodes SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, params)
      const [rows] = await db.execute('SELECT * FROM asset_nodes WHERE id = ? LIMIT 1', [nodeId])
      const [images] = await db.execute(
        'SELECT * FROM asset_node_images WHERE asset_node_id = ? ORDER BY id ASC',
        [nodeId],
      )
      success(
        res,
        buildAssetCanvasView({
          projectId: Number(resolved.node.project_id),
          nodes: rows,
          images,
        }).nodes[0],
        '画布节点已更新',
      )
      return
    }
    if (assetNodeMatch && req.method === 'DELETE') {
      const user = await authenticate(req, res)
      if (!user) return
      const nodeId = parseId(assetNodeMatch[1])
      const resolved = await fetchAssetNodeForUser(nodeId, user.id)
      if (!resolved) {
        fail(res, 4004, '画布节点不存在或无权访问', 404)
        return
      }
      await db.execute(
        `UPDATE asset_nodes SET status = 'archived', updated_at = NOW() WHERE id = ?`,
        [nodeId],
      )
      success(res, { success: true }, '画布节点已移除')
      return
    }

    const assetNodeImagesMatch = pathname.match(/^\/api\/asset-nodes\/(\d+)\/images$/)
    if (assetNodeImagesMatch && req.method === 'GET') {
      const user = await authenticate(req, res)
      if (!user) return
      const nodeId = parseId(assetNodeImagesMatch[1])
      if (!(await fetchAssetNodeForUser(nodeId, user.id))) {
        fail(res, 4004, '画布节点不存在或无权访问', 404)
        return
      }
      const [rows] = await db.execute(
        'SELECT * FROM asset_node_images WHERE asset_node_id = ? ORDER BY id ASC',
        [nodeId],
      )
      success(res, { items: rows.map(assetNodeImageDto) })
      return
    }
    const assetNodeGenerateMatch = pathname.match(/^\/api\/asset-nodes\/(\d+)\/images\/generate$/)
    if (assetNodeGenerateMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return
      const nodeId = parseId(assetNodeGenerateMatch[1])
      try {
        const job = await enqueueAssetNodeImageJob(user.id, nodeId, await parseBody(req))
        if (!job) {
          fail(res, 4004, '画布节点不存在或无权访问', 404)
          return
        }
        success(res, job, '画布节点形象生成任务已提交')
      } catch (error) {
        fail(res, 4011, error instanceof Error ? error.message : '画布节点形象任务提交失败', error?.statusCode || 400)
      }
      return
    }
    const assetNodeImageConfirmMatch = pathname.match(/^\/api\/asset-node-images\/(\d+)\/confirm$/)
    if (assetNodeImageConfirmMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return
      const imageId = parseId(assetNodeImageConfirmMatch[1])
      const [rows] = await db.execute(
        `SELECT ai.*, n.project_id, n.node_type, n.ref_id, n.label, n.status AS node_status, p.user_id AS ownerId
         FROM asset_node_images ai
         INNER JOIN asset_nodes n ON n.id = ai.asset_node_id
         INNER JOIN projects p ON p.id = n.project_id
         WHERE ai.id = ? LIMIT 1`,
        [imageId],
      )
      const image = rows[0]
      if (!image || Number(image.ownerId) !== Number(user.id) || image.node_status === 'archived') {
        fail(res, 4004, '画布节点形象不存在或无权访问', 404)
        return
      }
      const legacyCharacterBoard = image.node_type === 'character' && isCharacterAssetPackRow(image)
      if (image.node_type === 'character'
        && image.view_set_type !== 'character-asset-pack'
        && !legacyCharacterBoard) {
        fail(res, 4004, '角色资产板通过整体视觉检查后会自动采用，无需单独确认旧版拆分图片', 409)
        return
      }
      if (image.status === 'superseded') {
        fail(res, 4004, '该图片已被新资产替代，不能重新检查', 409)
        return
      }
      if (legacyCharacterBoard) {
        await db.execute(
          `UPDATE asset_node_images
           SET view_set_type = 'character-asset-pack', view_key = NULL,
               view_index = NULL, view_label = '角色资产板'
           WHERE id = ?`,
          [imageId],
        )
        image.view_set_type = 'character-asset-pack'
        image.view_key = null
        image.view_index = null
        image.view_label = '角色资产板'
      }
      const confirmationGate = validateCharacterTurnaroundConfirmation({
        viewType: image.view_set_type,
        viewKey: image.view_key,
        imageStatus: image.status,
        visionStatus: image.vision_status,
        imageUrl: image.image_url,
        modelName: image.model_name,
        identityStatus: image.identity_status,
        identityReason: image.identity_reason,
      })
      const assetPackGate = validateCharacterAssetPackConfirmation({
        viewType: image.view_set_type,
        imageStatus: image.status,
        visionStatus: image.vision_status,
        imageUrl: image.image_url,
        modelName: image.model_name,
      })
      const faceCloseupGate = validateCharacterFaceCloseupConfirmation({
        viewType: image.view_set_type,
        viewKey: image.view_key,
        imageStatus: image.status,
        visionStatus: image.vision_status,
        imageUrl: image.image_url,
        modelName: image.model_name,
        identityStatus: image.identity_status,
        identityReason: image.identity_reason,
      })
      const propGate = validatePropTurnaroundConfirmation({
        nodeType: image.node_type,
        viewType: image.view_set_type,
        viewKey: image.view_key,
        imageStatus: image.status,
        visionStatus: image.vision_status,
        imageUrl: image.image_url,
        modelName: image.model_name,
      })
      const selectedConfirmationGate = !assetPackGate.ready
        ? assetPackGate
        : !confirmationGate.ready
        ? confirmationGate
        : !faceCloseupGate.ready ? faceCloseupGate : propGate
      if (!selectedConfirmationGate.ready) {
        fail(res, 4004, selectedConfirmationGate.message, 409)
        return
      }
      const baseAssetGate = validateAssetImageConfirmation({
        nodeType: image.node_type,
        viewType: image.view_set_type,
        imageStatus: image.status,
        visionStatus: image.vision_status,
        imageUrl: image.image_url,
        modelName: image.model_name,
      })
      if (!baseAssetGate.ready) {
        fail(res, 4004, baseAssetGate.message, 409)
        return
      }
      if (image.view_set_type === 'scene-nine-grid') {
        const sceneGate = validateSceneNineGridViewConfirmation({
          viewKey: image.view_key || (image.node_type === 'character' && image.view_set_type === 'single' ? 'front' : null),
          crop: safeJsonParse(image.crop_json, null),
          sourceImageId: image.source_image_id,
          imageStatus: image.status,
          visionStatus: image.vision_status,
          imageUrl: image.image_url,
          modelName: image.model_name,
        })
        if (!sceneGate.ready) {
          fail(res, 4004, sceneGate.message, 409)
          return
        }
      }
      if (image.node_type === 'character') {
        const [characterRows] = await db.execute(
          `SELECT id, name, appearance, costume, costume_description
           FROM characters WHERE id = ? AND project_id = ? LIMIT 1`,
          [Number(image.ref_id) || 0, Number(image.project_id)],
        )
        const [referenceRows] = await db.execute(
          `SELECT * FROM asset_node_images WHERE asset_node_id = ? AND id <> ?
           ORDER BY id DESC`,
          [image.asset_node_id, imageId],
        )
        const referenceSet = resolveCharacterReferenceSet([
          { ...image, status: 'confirmed' },
          ...referenceRows,
        ])
        const identitySnapshot = buildCharacterIdentityLockSnapshot({
          character: characterRows[0] || { id: image.ref_id, name: image.label },
          baseImage: { ...image, status: 'confirmed' },
          referenceSet,
        })
        await db.execute(
          `UPDATE asset_nodes SET character_identity_lock_json = ?, updated_at = NOW() WHERE id = ?`,
          [JSON.stringify(identitySnapshot), image.asset_node_id],
        )
        await db.execute(
          `UPDATE asset_node_images SET character_identity_lock_json = ? WHERE id = ?`,
          [JSON.stringify(identitySnapshot), imageId],
        )
      }
      if (image.view_set_type === 'single' && ['character', 'scene'].includes(image.node_type)) {
        await db.execute(
          `UPDATE asset_node_images
           SET status = 'superseded'
           WHERE asset_node_id = ? AND view_set_type = 'single'
             AND status = 'confirmed' AND id <> ?`,
          [image.asset_node_id, imageId],
        )
        if (image.node_type === 'scene') {
          await db.execute(
            `UPDATE asset_node_images
             SET status = 'superseded'
             WHERE asset_node_id = ? AND view_set_type = 'scene-nine-grid'
               AND (source_image_id IS NULL OR source_image_id <> ?)
               AND status IN ('candidate', 'confirmed')`,
            [image.asset_node_id, imageId],
          )
        }
      }
      if (image.node_type === 'character' && image.view_set_type === 'character-asset-pack') {
        await db.execute(
          `UPDATE asset_node_images
           SET status = 'superseded'
           WHERE asset_node_id = ?
             AND view_set_type IN (${CHARACTER_PACK_LEGACY_TYPES})
             AND id <> ?
             AND status IN ('candidate', 'confirmed')`,
          [image.asset_node_id, imageId],
        )
      }
      if (image.view_set_type === 'scene-nine-grid') {
        await db.execute(
          `UPDATE asset_node_images
           SET status = 'superseded'
           WHERE asset_node_id = ? AND view_set_type = 'scene-nine-grid'
             AND view_key = ? AND id <> ? AND status IN ('candidate', 'confirmed')`,
          [image.asset_node_id, image.view_key, imageId],
        )
      }
      if (image.view_set_type === 'character-turnaround') {
        // A retry stays independent until this request explicitly adopts it.
        // Only then is the prior confirmed/candidate version of the same angle
        // superseded; other angles and other temporal groups remain untouched.
        await db.execute(
          `UPDATE asset_node_images
           SET status = 'superseded'
           WHERE asset_node_id = ? AND view_set_type = 'character-turnaround'
             AND view_key = ? AND id <> ? AND status IN ('candidate', 'confirmed')`,
          [image.asset_node_id, image.view_key, imageId],
        )
      }
      if (image.view_set_type === 'character-face-closeup') {
        await db.execute(
          `UPDATE asset_node_images
           SET status = 'superseded'
           WHERE asset_node_id = ? AND view_set_type = 'character-face-closeup'
             AND view_key = ? AND id <> ? AND status IN ('candidate', 'confirmed')`,
          [image.asset_node_id, image.view_key, imageId],
        )
      }
      if (image.view_set_type === 'prop-turnaround') {
        await db.execute(
          `UPDATE asset_node_images
           SET status = 'superseded'
           WHERE asset_node_id = ? AND view_set_type = 'prop-turnaround'
             AND view_key = ? AND id <> ? AND status IN ('candidate', 'confirmed')`,
          [image.asset_node_id, image.view_key, imageId],
        )
      }
      await db.execute(
        `UPDATE asset_node_images SET status = 'confirmed', confirmed_at = NOW() WHERE id = ?`,
        [imageId],
      )
      const [updatedRows] = await db.execute(
        'SELECT * FROM asset_node_images WHERE id = ? LIMIT 1',
        [imageId],
      )
      success(res, assetNodeImageDto(updatedRows[0]), '形象已采用')
      return
    }
    const assetNodeImageVisionCheckMatch = pathname.match(/^\/api\/asset-node-images\/(\d+)\/vision-check$/)
    if (assetNodeImageVisionCheckMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return
      const imageId = parseId(assetNodeImageVisionCheckMatch[1])
      const [rows] = await db.execute(
         `SELECT ai.*, n.project_id, n.node_type, n.ref_id, n.label, n.status AS node_status, p.user_id AS ownerId
         FROM asset_node_images ai
         INNER JOIN asset_nodes n ON n.id = ai.asset_node_id
         INNER JOIN projects p ON p.id = n.project_id
         WHERE ai.id = ? LIMIT 1`,
        [imageId],
      )
      const image = rows[0]
      if (!image || Number(image.ownerId) !== Number(user.id) || image.node_status === 'archived') {
        fail(res, 4004, '画布节点形象不存在或无权访问', 404)
        return
      }
      if (image.status === 'superseded') {
        fail(res, 4004, '该图片已被新资产替代，不能重新检查', 409)
        return
      }
      if (image.node_type === 'scene' && !isSceneVisionCheckEnabled()) {
        await db.execute(
          `UPDATE asset_node_images
           SET vision_status = 'skipped',
               vision_reason = '未运行视觉检查；结果需由用户按全景基准人工确认',
               vision_checked_at = NULL,
               identity_status = 'not_checked'
           WHERE id = ?`,
          [imageId],
        )
        const [updatedRows] = await db.execute(
          'SELECT * FROM asset_node_images WHERE id = ? LIMIT 1',
          [imageId],
        )
        success(res, assetNodeImageDto(updatedRows[0]), '场景视觉检查未运行，请按全景基准人工确认')
        return
      }
      const currentStored = image.storage_key ? await objectStorage.getObject(image.storage_key) : null
      let sourceStored = null
      let sourceImageUrl = null
      if (image.view_set_type === 'scene-nine-grid' && image.source_image_id) {
        const [sourceRows] = await db.execute(
          'SELECT storage_key, image_url FROM asset_node_images WHERE id = ? LIMIT 1',
          [image.source_image_id],
        )
        sourceImageUrl = sourceRows[0]?.image_url || null
        if (sourceRows[0]?.storage_key) {
          sourceStored = await objectStorage.getObject(sourceRows[0].storage_key)
        }
      }
      let identityReferenceUrls = []
      let identityReferenceBytes = []
      let identityChecked = false
      if (image.node_type === 'character'
        && ['character-turnaround', 'character-face-closeup'].includes(image.view_set_type)) {
        identityChecked = true
        const [referenceRows] = await db.execute(
          `SELECT * FROM asset_node_images
           WHERE asset_node_id = ? AND id <> ? ORDER BY id DESC`,
          [image.asset_node_id, imageId],
        )
        const referenceSet = resolveCharacterReferenceSet(referenceRows)
        identityReferenceUrls = referenceSet.imageUrls
        for (const storageKey of referenceSet.storageKeys) {
          const stored = await objectStorage.getObject(storageKey)
          if (stored?.bytes?.length) identityReferenceBytes.push(stored.bytes)
        }
      }
      let vision
      try {
        vision = await inspectAssetImage({
          imageUrl: currentStored ? null : image.image_url,
          imageBytes: currentStored?.bytes || null,
          referenceImageUrl: sourceStored ? null : sourceImageUrl,
        referenceImageBytes: sourceStored?.bytes || null,
        referenceImageUrls: identityReferenceBytes.length ? [] : identityReferenceUrls,
        referenceImageBytesList: identityReferenceBytes,
        viewKey: image.view_key || (image.node_type === 'character' && image.view_set_type === 'single' ? 'front' : null),
        scene: image.node_type === 'scene',
        assetPack: image.view_set_type === 'character-asset-pack' || isCharacterAssetPackRow(image),
        nodeType: image.node_type,
        identityLock: identityChecked,
          noFace: image.node_type === 'character'
            && /不露脸|正脸不呈现|不直接露脸|不出现正脸|脸部.*不可见/u.test(String(image.prompt_snapshot || '')),
        })
      } catch (error) {
        vision = {
          passed: false,
          reason: `视觉检查无法读取已生成图片：${error instanceof Error ? error.message : '未知错误'}`,
        }
      }
      await db.execute(
        `UPDATE asset_node_images
         SET vision_status = ?, vision_reason = ?, vision_checked_at = NOW(),
             status = IF(status = 'failed', 'candidate', status),
             identity_status = ?, identity_reason = ?,
             identity_similarity_score = ?, wardrobe_consistency_score = ?
         WHERE id = ?`,
        [
          vision.pending ? 'pending' : vision.passed ? 'passed' : 'failed',
          vision.reason || null,
          identityChecked ? (vision.pending ? 'pending' : vision.passed ? 'passed' : 'failed') : 'not_checked',
          identityChecked ? vision.reason || null : null,
          identityChecked ? vision.identitySimilarityScore : null,
          identityChecked ? vision.wardrobeConsistencyScore : null,
          imageId,
        ],
      )
      if (vision.passed) {
        if (image.node_type === 'character'
          && (image.view_set_type === 'character-asset-pack' || isCharacterAssetPackRow(image))) {
          await autoAdoptAssetPack(image.asset_node_id, [imageId])
        } else if (['prop', 'material'].includes(String(image.node_type))
          && image.view_set_type === 'single') {
          await autoAdoptSingleAsset(imageId)
        }
      }
      const [updatedRows] = await db.execute(
        'SELECT * FROM asset_node_images WHERE id = ? LIMIT 1',
        [imageId],
      )
      success(res, assetNodeImageDto(updatedRows[0]), '视角视觉检查已更新')
      return
    }

    const projectTasksMatch = pathname.match(/^\/api\/projects\/(\d+)\/tasks$/)
    if (projectTasksMatch && req.method === 'GET') {
      const user = await authenticate(req, res)
      if (!user) return

      const projectId = parseId(projectTasksMatch[1])
      const project = await fetchProjectForUser(projectId, user.id)
      if (!project) {
        fail(res, 4004, '项目不存在或无权访问', 404)
        return
      }

      const payload = await buildProjectTasksV2(projectId)
      success(res, payload)
      return
    }

    const generationJobMatch = pathname.match(/^\/api\/generation-jobs\/(\d+)$/)
    if (generationJobMatch && req.method === 'GET') {
      const user = await authenticate(req, res)
      if (!user) return

      const jobId = parseId(generationJobMatch[1])
      const [rows] = await db.execute(
        `SELECT gj.*, p.user_id AS ownerId
         FROM generation_jobs gj
         INNER JOIN projects p ON p.id = gj.project_id
         WHERE gj.id = ? LIMIT 1`,
        [jobId],
      )
      const row = rows[0]
      if (!row || row.ownerId !== user.id) {
        fail(res, 4004, '生成任务不存在或无权访问', 404)
        return
      }
      success(res, generationJobRow(row))
      return
    }

    const projectTaskActionMatch = pathname.match(
      /^\/api\/project-tasks\/((?:image|video|audio|export)-\d+)\/(retry|cancel)$/,
    )

    const generationTaskActionMatch = pathname.match(
      /^\/api\/project-tasks\/generation-(\d+)\/(retry|cancel)$/,
    )
    if (generationTaskActionMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return

      const jobId = parseId(generationTaskActionMatch[1])
      const action = generationTaskActionMatch[2]
      const [rows] = await db.execute(
        `SELECT gj.*, p.user_id AS ownerId
         FROM generation_jobs gj
         INNER JOIN projects p ON p.id = gj.project_id
         WHERE gj.id = ? LIMIT 1`,
        [jobId],
      )
      const job = rows[0]
      if (!job || job.ownerId !== user.id) {
        fail(res, 4004, '生成任务不存在或无权访问', 404)
        return
      }
      if (action === 'cancel') {
        fail(res, 4001, '当前供应商请求不支持安全取消，请等待本轮完成', 409)
        return
      }
      if (!['failed', 'canceled'].includes(job.status)) {
        fail(res, 4001, '只有失败或已取消的生成任务可以重试', 409)
        return
      }
      let retryRequest = safeJsonParse(job.request_json, {})
      retryRequest = await repairVideoRetryReferences(job, retryRequest)
      // Reuse pending tasks and completed URLs to avoid duplicate provider
      // charges. Only terminally failed provider tasks are replaced.
      retryRequest.providerTasks = Array.isArray(retryRequest.providerTasks)
        ? retryRequest.providerTasks.filter((task) => {
            const status = String(task?.status || '').trim().toLowerCase()
            const hasCompletedUrl = /^https?:\/\//i.test(String(task?.videoUrl || '').trim())
            return String(task?.videoId || '').trim() && status !== 'failed'
              && (status !== 'succeeded' || hasCompletedUrl)
          })
        : []
      delete retryRequest.providerTaskId
      if (!retryRequest.providerTasks.length) delete retryRequest.providerReferenceImages
      await updateGenerationJob(jobId, {
        status: 'queued',
        progress_percent: 0,
        result_json: null,
        error_text: null,
        request_json: JSON.stringify(retryRequest),
      })
      queueGenerationJob(jobId)
      const updated = await fetchGenerationJob(jobId)
      const isVideoGenerationJob = ['video_image', 'lip_sync'].includes(job.job_type)
      success(res, projectTaskItemRow({
        taskKey: `generation-${jobId}`,
        taskType: isVideoGenerationJob ? 'video' : 'image',
        sourceId: jobId,
        projectId: Number(job.project_id),
        title:
          job.job_type === 'lip_sync'
            ? '对白口型同步任务'
            : job.job_type === 'video_image'
              ? '动作视频生成任务'
              : '图片生成任务',
        status: 'queued',
        runtimeStatus: 'queued',
        progressPercent: 0,
        runtimeMessage: '生成任务已重新加入队列',
        canRetry: false,
        canCancel: false,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
      }), '生成任务已重新加入队列')
      return
    }

    if (projectTaskActionMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return

      const taskMeta = parseTaskKey(projectTaskActionMatch[1])
      const action = projectTaskActionMatch[2]
      if (!taskMeta) {
        fail(res, 4001, '无效的 taskKey', 400)
        return
      }

      const ownerRecord = await fetchTaskOwnerRecord(taskMeta.taskType, taskMeta.sourceId, user.id)
      if (!ownerRecord) {
        fail(res, 4004, '任务不存在或无权访问', 404)
        return
      }

      const projectId = Number(ownerRecord.project_id || 0)
      if (!projectId) {
        fail(res, 4001, '任务缺少项目上下文', 400)
        return
      }

      const currentPayload = await buildProjectTasksV2(projectId)
      const currentTask = currentPayload.items.find((item) => item.taskKey === taskMeta.taskKey)
      if (!currentTask) {
        fail(res, 4004, '任务不存在', 404)
        return
      }

      if (action === 'retry') {
        await db.execute(
          `INSERT INTO task_runtime_states
             (task_key, project_id, task_type, source_id, runtime_status, progress_percent, error_text)
           VALUES (?, ?, ?, ?, 'queued', 0, NULL)
           ON DUPLICATE KEY UPDATE
             runtime_status = VALUES(runtime_status),
             progress_percent = VALUES(progress_percent),
             error_text = NULL,
             updated_at = NOW()`,
          [taskMeta.taskKey, projectId, taskMeta.taskType, taskMeta.sourceId],
        )

        const payload = await buildProjectTasksV2(projectId)
        const task = payload.items.find((item) => item.taskKey === taskMeta.taskKey) || null
        success(res, task, '任务已重新加入队列（Mock）')
        return
      }

      if (!currentTask.canCancel) {
        fail(res, 4001, '当前任务不处于可取消状态', 400)
        return
      }

      await db.execute(
        `INSERT INTO task_runtime_states
           (task_key, project_id, task_type, source_id, runtime_status, progress_percent, error_text)
         VALUES (?, ?, ?, ?, 'canceled', ?, NULL)
         ON DUPLICATE KEY UPDATE
           runtime_status = VALUES(runtime_status),
           progress_percent = VALUES(progress_percent),
           error_text = NULL,
           updated_at = NOW()`,
        [
          taskMeta.taskKey,
          projectId,
          taskMeta.taskType,
          taskMeta.sourceId,
          clampPercent(currentTask.progressPercent, 0),
        ],
      )

      const payload = await buildProjectTasksV2(projectId)
      const task = payload.items.find((item) => item.taskKey === taskMeta.taskKey) || null
      success(res, task, '任务已取消（Mock）')
      return
    }

    const projectFinalEditMatch = pathname.match(/^\/api\/projects\/(\d+)\/final-edit$/)
    if (projectFinalEditMatch && req.method === 'GET') {
      const user = await authenticate(req, res)
      if (!user) return

      const projectId = parseId(projectFinalEditMatch[1])
      const project = await fetchProjectForUser(projectId, user.id)
      if (!project) {
        fail(res, 4004, '项目不存在或无权访问', 404)
        return
      }

      let episodeNo
      try {
        episodeNo = normalizeEpisodeExportRequest({
          episodeNo: url.searchParams.get('episodeNo') || undefined,
        }).episodeNo
      } catch (error) {
        fail(res, 4001, error instanceof Error ? error.message : '无效的 episodeNo', 400)
        return
      }
      const payload = await buildProjectFinalEdit(project, { episodeNo })
      success(res, payload)
      return
    }

    const projectFinalEditDraftMatch = pathname.match(/^\/api\/projects\/(\d+)\/final-edit-draft$/)
    if (projectFinalEditDraftMatch && req.method === 'PUT') {
      const user = await authenticate(req, res)
      if (!user) return

      const projectId = parseId(projectFinalEditDraftMatch[1])
      const project = await fetchProjectForUser(projectId, user.id)
      if (!project) {
        fail(res, 4004, '项目不存在或无权访问', 404)
        return
      }

      const body = await parseBody(req)
      let episodeNo
      try {
        episodeNo = normalizeEpisodeExportRequest({
          episodeNo: url.searchParams.get('episodeNo') || undefined,
        }).episodeNo
      } catch (error) {
        fail(res, 4001, error instanceof Error ? error.message : '无效的 episodeNo', 400)
        return
      }
      const currentFinalEdit = await buildProjectFinalEdit(project, { episodeNo })
      const normalizedDraft = normalizeFinalEditDraftPayload(body, {
        videoItems: currentFinalEdit.videoTrack.items,
        audioTracks: currentFinalEdit.audioTracks,
      })

      const storedDraftRow = await fetchFinalEditDraft(projectId)
      const persistedDraft = saveFinalEditDraftForEpisode(
        storedDraftRow?.draft_json,
        episodeNo,
        normalizedDraft,
      )
      await db.execute(
        `INSERT INTO final_edit_drafts (project_id, draft_json)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE
           draft_json = VALUES(draft_json),
           updated_at = NOW()`,
        [projectId, JSON.stringify(persistedDraft)],
      )

      const payload = await buildProjectFinalEdit(project, { episodeNo })
      success(res, payload, '成片编辑草稿已保存')
      return
    }

    const projectAudioMatch = pathname.match(/^\/api\/projects\/(\d+)\/audio(\/generate)?$/)
    if (projectAudioMatch) {
      const user = await authenticate(req, res)
      if (!user) return

      const projectId = parseId(projectAudioMatch[1])
      const isGenerate = Boolean(projectAudioMatch[2])
      const project = await fetchProjectForUser(projectId, user.id)
      if (!project) {
        fail(res, 4004, '项目不存在或无权访问', 404)
        return
      }

      if (req.method === 'GET' && !isGenerate) {
        const [rows] = await db.execute(
          `SELECT aa.*,
                  sc.scene_no,
                  sc.title AS scene_title,
                  sb.shot_no,
                  c.name AS character_name
           FROM audio_assets aa
           LEFT JOIN script_scenes sc ON sc.id = aa.scene_id
           LEFT JOIN storyboards sb ON sb.id = aa.storyboard_id
           LEFT JOIN characters c ON c.id = aa.character_id
           WHERE aa.project_id = ?
           ORDER BY CASE aa.track_type
                      WHEN 'dialogue' THEN 1
                      WHEN 'narration' THEN 2
                      WHEN 'music' THEN 3
                      WHEN 'sfx' THEN 4
                      ELSE 99
                    END ASC,
                    aa.scene_id ASC,
                    aa.character_id ASC,
                    aa.version_no DESC,
                    aa.id DESC`,
          [projectId],
        )
        success(res, { items: rows.map(audioAssetRow) })
        return
      }

      if (req.method === 'POST' && isGenerate) {
        let body = {}
        try {
          body = await parseBody(req)
        } catch {
          body = {}
        }

        const trackType = normalizeAudioTrackType(body.trackType)
        if (!trackType) {
          fail(res, 4001, 'trackType 只允许 dialogue / narration / music / sfx', 400)
          return
        }

        const audioConfig = getAudioConfig()
        if (!isMockAudioProvider(audioConfig) && !['dialogue', 'narration'].includes(trackType)) {
          fail(res, 4001, 'qwen3-tts-flash only supports dialogue and narration tracks', 400)
          return
        }

        const candidateCount = Math.max(1, Math.min(3, parseId(body.candidateCount) || 1))
        let requestedSceneId = parseId(body.sceneId) || 0
        const requestedStoryboardId = parseId(body.storyboardId) || 0
        const requestedCharacterId = parseId(body.characterId) || 0

        let scene = null
        let storyboard = null
        if (requestedStoryboardId) {
          const [storyboardRows] = await db.execute(
            `SELECT s.id, s.scene_id, s.shot_no, s.duration_seconds, s.dialogue_text
             FROM storyboards s
             INNER JOIN script_scenes sc ON sc.id = s.scene_id
             WHERE s.id = ? AND sc.project_id = ?
             LIMIT 1`,
            [requestedStoryboardId, projectId],
          )
          storyboard = storyboardRows[0] || null
          if (!storyboard) {
            fail(res, 4004, 'storyboardId 不属于当前项目', 404)
            return
          }
          if (requestedSceneId && Number(storyboard.scene_id) !== requestedSceneId) {
            fail(res, 4001, 'storyboardId 与 sceneId 不匹配', 400)
            return
          }
          requestedSceneId = Number(storyboard.scene_id)
        }
        if (requestedSceneId) {
          const [sceneRows] = await db.execute(
            `SELECT id, scene_no, title, summary, content
             FROM script_scenes
             WHERE id = ? AND project_id = ?
             LIMIT 1`,
            [requestedSceneId, projectId],
          )
          scene = sceneRows[0] || null
          if (!scene) {
            fail(res, 4004, 'sceneId 不属于当前项目', 404)
            return
          }
        }

        let character = null
        if (requestedCharacterId) {
          const [characterRows] = await db.execute(
            `SELECT id, name, voice_setting, voice_profile_key, voice_locked, voice_design_json,
                    age_group, gender, voice_style, appearance, personality, role_tag
             FROM characters
             WHERE id = ? AND project_id = ?
             LIMIT 1`,
            [requestedCharacterId, projectId],
          )
          character = characterRows[0] || null
          if (!character) {
            fail(res, 4004, 'characterId 不属于当前项目', 404)
            return
          }
        }
        if (trackType === 'dialogue' && !character) {
          fail(res, 4001, '对白轨必须选择角色', 400)
          return
        }

        let voiceProfile = null
        if (trackType === 'dialogue') {
          if (!character.voice_profile_key || !character.voice_locked) {
            const customVoiceDesign = safeJsonParse(character.voice_design_json, null)
            const hasCustomVoice = Boolean(
              character.voice_locked
              && character.voice_setting
              && customVoiceDesign?.provider === 'qwen'
              && customVoiceDesign?.voiceId === character.voice_setting
              && customVoiceDesign?.targetModel,
            )
            if (!hasCustomVoice) {
              fail(res, 4010, `角色“${character.name}”还没有确认并锁定音色，请先完成角色音色管理`, 409)
              return
            }
          }
          const characterVoiceDesign = safeJsonParse(character.voice_design_json, null)
          const isCustomDesignedVoice = Boolean(
            characterVoiceDesign?.provider === 'qwen'
            && characterVoiceDesign?.voiceId === character.voice_setting
            && characterVoiceDesign?.targetModel,
          )
          if (isCustomDesignedVoice) {
            voiceProfile = {
              profileKey: character.voice_profile_key || null,
              voiceId: character.voice_setting,
              modelName: characterVoiceDesign.targetModel,
              instructions: '',
              languageType: 'Chinese',
            }
          } else if (!character.voice_profile_key || !character.voice_locked) {
            fail(res, 4010, `角色“${character.name}”还没有确认并锁定音色，请先完成角色音色管理`, 409)
            return
          } else {
            voiceProfile = await findActiveVoiceProfile(character.voice_profile_key)
            if (!voiceProfile) {
              fail(res, 4010, `角色“${character.name}”绑定的音色已停用，请重新选择`, 409)
              return
            }
          }
        } else if (trackType === 'narration' && body.voiceProfileKey) {
          voiceProfile = await findActiveVoiceProfile(body.voiceProfileKey)
          if (!voiceProfile) {
            fail(res, 4001, '旁白音色方案不存在或已停用', 400)
            return
          }
        }

        const durationInput = parseId(body.durationSeconds)
        const durationSeconds =
          durationInput > 0
            ? durationInput
            : storyboard && parseId(storyboard.duration_seconds) > 0
              ? parseId(storyboard.duration_seconds)
            : trackType === 'music'
              ? 18
              : trackType === 'sfx'
                ? 8
                : 12
        const modelName = voiceProfile?.modelName || (body.modelName
          ? String(body.modelName).trim()
          : isMockAudioProvider(audioConfig)
            ? 'mock-audio-v2'
            : audioConfig.defaultModel)
        const voiceName =
          trackType === 'music' || trackType === 'sfx'
            ? null
            : voiceProfile?.voiceId
              ? voiceProfile.voiceId
              : body.voiceName
                ? String(body.voiceName).trim()
                : character?.voice_setting || audioConfig.defaultVoice
        const sourceSceneId = scene?.id || null
        const sourceCharacterId =
          trackType === 'music' || trackType === 'sfx' ? null : character?.id || null
        const rawSourceText = String(
          body.text ||
            (trackType === 'dialogue'
              ? storyboard?.dialogue_text || ''
              : scene?.summary || scene?.content || ''),
        ).trim()
        const sourceText = trackType === 'dialogue'
          ? extractSpokenDialogue(rawSourceText, character?.name)
          : rawSourceText
        if (!isMockAudioProvider(audioConfig) && !sourceText) {
          fail(res, 4001, 'Speech synthesis text is required', 400)
          return
        }
        const storedVoiceDesign = safeJsonParse(character?.voice_design_json, null)
        const sceneContext = [
          scene?.title,
          scene?.summary,
          scene?.content,
        ].filter(Boolean).join('，')
        const agentVoiceInstructions = storedVoiceDesign
          ? buildVoicePerformanceInstructions({
            design: storedVoiceDesign,
            characterName: character?.name,
            sceneContext,
            dialogueText: sourceText,
          })
          : ''
        const voiceInstructions = [
          voiceProfile?.instructions,
          character?.voice_style,
          agentVoiceInstructions,
        ].filter(Boolean).join('；') || null
        const title = buildAudioSourceTitle({
          trackType,
          sceneNo: scene?.scene_no || null,
          sceneTitle: scene?.title || null,
          shotNo: storyboard?.shot_no || null,
          characterName: sourceCharacterId ? character?.name || null : null,
          projectName: project.name,
          customTitle: body.title,
        })

        const [versionRows] = await db.execute(
          `SELECT COALESCE(MAX(version_no), 0) AS maxVersion
           FROM audio_assets
           WHERE project_id = ?
             AND track_type = ?
             AND (scene_id <=> ?)
             AND (character_id <=> ?)`,
          [projectId, trackType, sourceSceneId, sourceCharacterId],
        )
        const nextVersion = Number(versionRows[0]?.maxVersion || 0) + 1

        let candidates
        if (isMockAudioProvider(audioConfig)) {
          candidates = Array.from({ length: candidateCount }, (_, index) => ({
            audioUrl: buildMockAudioUrl(projectId, trackType, nextVersion, index + 1, {
              sceneId: sourceSceneId,
              characterId: sourceCharacterId,
            }),
            durationSeconds,
            voiceName,
            modelName,
            voiceProfileKey: voiceProfile?.profileKey || null,
            voiceInstructions,
          }))
        } else {
          try {
            candidates = await generateAudioCandidates({
              projectId,
              trackType,
              versionNo: nextVersion,
              text: sourceText,
              voiceName,
              modelName,
              instructions: voiceInstructions,
              publicBaseUrl: buildGeneratedAudioPublicBaseUrl(),
              outputDir: GENERATED_AUDIO_DIR,
              candidateCount,
              allowModelFallback: !(
                trackType === 'dialogue'
                && character?.voice_setting === voiceProfile?.voiceId
                && safeJsonParse(character?.voice_design_json, null)?.provider === 'qwen'
              ),
            })
          } catch (audioError) {
            console.error('[audio] real provider failed', audioError)
            if (!audioConfig.fallbackToMock) {
              const providerDetail = String(audioError?.message || 'unknown provider error')
                .replace(/sk-[A-Za-z0-9._-]+/g, '[redacted]')
                .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
                .slice(0, 300)
              fail(res, 5020, `真实音频生成服务暂时不可用：${providerDetail}`, 502)
              return
            }
            console.warn('[audio] fallback to mock')
            candidates = Array.from({ length: candidateCount }, (_, index) => ({
              audioUrl: buildMockAudioUrl(projectId, trackType, nextVersion, index + 1, {
                sceneId: sourceSceneId,
                characterId: sourceCharacterId,
              }),
              durationSeconds,
              voiceName,
              modelName: 'mock-audio-v2',
              voiceProfileKey: voiceProfile?.profileKey || null,
              voiceInstructions,
            }))
          }
        }

        const insertedIds = []
        for (const candidate of candidates) {
          const [result] = await db.execute(
            `INSERT INTO audio_assets
               (project_id, track_type, scene_id, storyboard_id, character_id, version_no,
               start_offset_seconds, title, audio_url, storage_key, duration_seconds, voice_name, model_name, voice_profile_key,
               voice_instructions, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate')`,
            [
              projectId,
              trackType,
              sourceSceneId,
              storyboard?.id || null,
              sourceCharacterId,
              nextVersion,
              Math.max(0, Number(body.startOffsetSeconds) || 0),
              title,
              candidate.audioUrl,
              null,
              candidate.durationSeconds || durationSeconds,
              candidate.voiceName || voiceName,
              candidate.modelName || modelName,
              candidate.voiceProfileKey || voiceProfile?.profileKey || null,
              candidate.voiceInstructions || voiceInstructions,
            ],
          )
          const audioId = Number(result.insertId)
          if (candidate.filePath) {
            await ensureAudioAssetStorage({
              id: audioId,
              project_id: projectId,
              audio_url: candidate.audioUrl,
              filePath: candidate.filePath,
            })
          }
          insertedIds.push(audioId)
        }

        const placeholders = insertedIds.map(() => '?').join(', ')
        const [rows] = await db.execute(
          `SELECT aa.*,
                  sc.scene_no,
                  sc.title AS scene_title,
                  sb.shot_no,
                  c.name AS character_name
           FROM audio_assets aa
           LEFT JOIN script_scenes sc ON sc.id = aa.scene_id
           LEFT JOIN storyboards sb ON sb.id = aa.storyboard_id
           LEFT JOIN characters c ON c.id = aa.character_id
           WHERE aa.id IN (${placeholders})
           ORDER BY aa.version_no DESC, aa.id ASC`,
          insertedIds,
        )
        success(res, { items: rows.map(audioAssetRow) }, '音频候选轨道已生成')
        return
      }
    }

    const projectExportsMatch = pathname.match(/^\/api\/projects\/(\d+)\/exports$/)
    if (projectExportsMatch) {
      const user = await authenticate(req, res)
      if (!user) return

      const projectId = parseId(projectExportsMatch[1])
      const project = await fetchProjectForUser(projectId, user.id)
      if (!project) {
        fail(res, 4004, '项目不存在或无权访问', 404)
        return
      }

      if (req.method === 'GET') {
        const [rows] = await db.execute(
          `SELECT * FROM export_records
           WHERE project_id = ?
           ORDER BY id DESC`,
          [projectId],
        )
        success(res, { items: rows.map(exportRecordRow) })
        return
      }

      if (req.method === 'POST') {
        let body = {}
        try {
          body = await parseBody(req)
        } catch {
          body = {}
        }

        let episodeRequest
        try {
          episodeRequest = normalizeEpisodeExportRequest(body)
        } catch (error) {
          fail(res, 4001, error instanceof Error ? error.message : '无效的 episodeNo', 400)
          return
        }
        const exportPackage = await buildExportPackage(projectId, episodeRequest)
        if (episodeRequest.episodeNo
          ? (!exportPackage.canExport || exportPackage.missingShots > 0)
          : (!exportPackage.canExport && exportPackage.readyShots <= 0)) {
          const blockingMessage =
            exportPackage.blockingIssues[0]?.message ||
            (episodeRequest.episodeNo
              ? `第 ${episodeRequest.episodeNo} 集尚未完成全部确认视频，无法生成整集成片`
              : null) ||
            (exportPackage.readyShots <= 0
              ? '当前项目还没有已确认视频，无法导出'
              : '当前项目素材尚未补齐，无法导出')
          fail(res, 4001, blockingMessage, 400)
          return
        }

        const finalEditPayload = await buildProjectFinalEdit(project, { episodeNo: episodeRequest.episodeNo })
        if (episodeRequest.episodeNo && finalEditPayload.validation.missingVideoCount > 0) {
          fail(res, 4001, `第 ${episodeRequest.episodeNo} 集还有 ${finalEditPayload.validation.missingVideoCount} 个分镜缺少已确认视频`, 409)
          return
        }
        if (!finalEditPayload.validation.canExport) {
          const blockingMessage =
            finalEditPayload.validation.blockingIssues[0]?.message ||
            '当前成片编辑草稿不可用，无法导出'
          fail(res, 4001, blockingMessage, 400)
          return
        }

        const config = {
          format: body.format ? String(body.format).trim() : 'H.264 / MP4',
          resolution: body.resolution ? String(body.resolution).trim() : '1920 x 1080 (FHD)',
          frameRate: parseId(body.frameRate) || 24,
          burnSubtitle: Boolean(body.burnSubtitle),
          hybridVideoPerScene: Math.max(1, Math.min(6, parseId(body.hybridVideoPerScene) || 4)),
          strictStoryboardAudio: body.strictStoryboardAudio !== false,
          ...(episodeRequest.episodeNo ? { episodeNo: episodeRequest.episodeNo } : {}),
          preserveSourceAudio: episodeRequest.preserveSourceAudio,
          finalEditDraft: finalEditPayload.draft,
          finalEditSummary: {
            enabledVideoCount: finalEditPayload.validation.enabledVideoCount,
            enabledVideoDurationSeconds: finalEditPayload.validation.enabledVideoDurationSeconds,
            enabledAudioTrackCount: finalEditPayload.validation.enabledAudioTrackCount,
          },
        }

        const initialUrl = 'pending://hybrid-export'
        const [result] = await db.execute(
          `INSERT INTO export_records
            (project_id, status, video_url, cover_url, duration_seconds, config_json,
             source_count, ready_count, missing_count)
           VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
          [
            projectId,
            initialUrl,
            exportPackage.coverUrl,
            null,
            JSON.stringify(config),
            exportPackage.totalShots,
            exportPackage.readyShots,
            exportPackage.missingShots,
          ],
        )

        const exportId = Number(result.insertId)
        queueExportJob(exportId)

        const [rows] = await db.execute(
          `SELECT * FROM export_records WHERE id = ? LIMIT 1`,
          [exportId],
        )
        success(res, exportRecordRow(rows[0]), '导出任务已生成')
        return
      }
    }

    const projectDeletionMatch = pathname.match(/^\/api\/projects\/(\d+)$/)
    if (projectDeletionMatch && req.method === 'DELETE') {
      const user = await authenticate(req, res)
      if (!user) return

      const projectId = parseId(projectDeletionMatch[1])
      const project = await fetchProjectForUser(projectId, user.id)
      if (!project) {
        fail(res, 4004, '项目不存在或无权访问', 404)
        return
      }

      let body = {}
      try {
        body = await parseBody(req)
      } catch {
        fail(res, 4001, '删除确认信息格式无效')
        return
      }

      const confirmName = String(body.confirmName || '').trim()
      const expectedName = projectDeletionConfirmationName(project)
      if (!confirmName) {
        fail(res, 4001, `请输入项目名称“${expectedName}”以确认删除`)
        return
      }
      if (confirmName !== expectedName) {
        fail(res, 4090, '项目名称不匹配，请输入页面显示的完整项目名称', 409)
        return
      }

      const connection = await db.getConnection()
      try {
        await connection.beginTransaction()
        const [result] = await connection.execute(
          `DELETE FROM projects WHERE id = ? AND user_id = ?`,
          [projectId, user.id],
        )
        if (!result.affectedRows) {
          await connection.rollback()
          fail(res, 4004, '项目不存在或无权访问', 404)
          return
        }
        await connection.commit()
      } catch (error) {
        await connection.rollback()
        throw error
      } finally {
        connection.release()
      }

      success(res, { id: projectId }, '项目已永久删除')
      return
    }

    const projectMatch = pathname.match(/^\/api\/projects\/(\d+)(\/(outline|scenes)(\/.*)?)?$/)
    if (projectMatch) {
      const user = await authenticate(req, res)
      if (!user) return

      const projectId = parseId(projectMatch[1])
      const project = await fetchProjectForUser(projectId, user.id)
      if (!project) {
        fail(res, 4004, '项目不存在或无权访问', 404)
        return
      }

      const sub = projectMatch[3]
      const tail = projectMatch[4] || ''

      if (!sub) {
        if (req.method === 'GET') {
          success(res, projectRow(project))
          return
        }
        if (req.method === 'PATCH') {
          const normalized = normalizeProjectUpdateInput(await parseBody(req))
          if (normalized.error) {
            fail(res, 4001, normalized.error)
            return
          }
          const assignments = normalized.updates.map((item) => `${item.column} = ?`).join(', ')
          await db.execute(
            `UPDATE projects SET ${assignments}, updated_at = NOW() WHERE id = ? AND user_id = ?`,
            [...normalized.updates.map((item) => item.value), projectId, user.id],
          )
          const [rows] = await db.execute(`SELECT * FROM projects WHERE id = ? LIMIT 1`, [projectId])
          success(res, projectRow(rows[0]), '项目设置已保存')
          return
        }
      }

      if (sub === 'outline') {
        if (req.method === 'GET') {
          const [rows] = await db.execute(
            `SELECT * FROM story_outlines WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
            [projectId],
          )
          if (!rows[0]) {
            success(res, null)
            return
          }
          success(res, outlineRow(rows[0]))
          return
        }
      }

      if (sub === 'outline' && req.method === 'POST' && tail.startsWith('/generate')) {
        const [modernScriptRows] = await db.execute(
          `SELECT COUNT(*) AS total
           FROM script_scenes sc
           INNER JOIN season_structures ss ON ss.project_id = sc.project_id
           WHERE sc.project_id = ?`,
          [projectId],
        )
        if (Number(modernScriptRows[0]?.total || 0) > 0) {
          fail(res, 4090, '此项目已有分集剧本，旧版总纲重生成已拦截，避免删除剧本与分镜', 409)
          return
        }
        const aiOutline = await aiGenerateOutline({
          id: project.id,
          name: project.name,
          category: project.category,
          narrativeVision: project.narrative_vision,
          visualStyle: project.visual_style,
          targetDuration: project.target_duration,
        })

        // 计算新版本号
        const [versionRows] = await db.execute(
          `SELECT COALESCE(MAX(version_no), 0) AS maxVersion FROM story_outlines WHERE project_id = ?`,
          [projectId],
        )
        const nextVersion = Number(versionRows[0]?.maxVersion || 0) + 1

        // P1: 重新生成总纲前，先清空该项目下所有旧场景与分镜
        //   - storyboards 有 ON DELETE CASCADE 外键，scenes 删除会级联清理
        //   - 用事务保证删除 + 插入总纲 + 更新项目状态 三步原子
        const conn = await db.getConnection()
        let insertedId = 0
        try {
          await conn.beginTransaction()

          await conn.execute(`DELETE FROM script_scenes WHERE project_id = ?`, [projectId])

          const [result] = await conn.execute(
            `INSERT INTO story_outlines
               (project_id, version_no, title, logline, premise,
                act1_text, act2_text, act3_text, visual_style, raw_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              projectId,
              nextVersion,
              aiOutline.title,
              aiOutline.logline,
              aiOutline.premise,
              aiOutline.acts?.[0]?.summary || '',
              aiOutline.acts?.[1]?.summary || '',
              aiOutline.acts?.[2]?.summary || '',
              aiOutline.visual_style || aiOutline.visualStyle || project.visual_style || null,
              JSON.stringify({ acts: aiOutline.acts, scenes: aiOutline.scenes }),
            ],
          )
          insertedId = Number(result.insertId)

          await conn.execute(
            `UPDATE projects SET status = 'outlined', updated_at = NOW() WHERE id = ?`,
            [projectId],
          )

          await conn.commit()
        } catch (txErr) {
          await conn.rollback()
          throw txErr
        } finally {
          conn.release()
        }

        const [rows] = await db.execute(`SELECT * FROM story_outlines WHERE id = ?`, [insertedId])
        success(res, outlineRow(rows[0]), '总纲已生成')
        return
      }

      if (sub === 'scenes' && req.method === 'GET') {
        const [rows] = await db.execute(
          `SELECT * FROM script_scenes WHERE project_id = ? ORDER BY episode_no ASC, sort_order ASC, scene_no ASC, id ASC`,
          [projectId],
        )
        success(res, { items: rows.map(sceneRow) })
        return
      }

      if (sub === 'scenes' && req.method === 'POST' && tail.startsWith('/generate')) {
        // 新工作台以故事圣经 + 分集结构为来源；旧总纲接口继续兼容历史项目。
        const [seasonRows] = await db.execute(
          `SELECT * FROM season_structures
           WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
          [projectId],
        )
        const season = seasonRows[0]
        let outline = null
        let scenesSpec = season ? seasonEpisodeSceneSpecs(jsonArray(season.episodes_json)) : []

        // 正文场景是空间解析的权威来源。分集摘要只有一集级别的叙事信息，
        // 不能拿来替代公寓、电脑工作区、视频内办公室等实际空间。
        const [scriptSceneRows] = await db.execute(
          `SELECT episode_no, scene_no, title, summary, content, location, time_of_day,
                  estimated_duration
           FROM script_scenes
           WHERE project_id = ?
           ORDER BY episode_no ASC, sort_order ASC, scene_no ASC, id ASC`,
          [projectId],
        )
        const extractedScriptScenes = extractSceneSpecsFromScriptScenes(scriptSceneRows)
        if (extractedScriptScenes.length) {
          scenesSpec = extractedScriptScenes
        }

        if (!scenesSpec.length) {
          const [outlineRows] = await db.execute(
            `SELECT * FROM story_outlines WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
            [projectId],
          )
          outline = outlineRows[0]
          try {
            scenesSpec = outline?.raw_json ? JSON.parse(outline.raw_json).scenes || [] : []
          } catch {
            scenesSpec = []
          }
        }

        // 读取最新总纲
        if (!scenesSpec.length) {
          fail(res, 4001, '请先生成并保存分集大纲')
          return
        }
        // 重新生成会删除现有场景、剧本和分镜，必须由前端显式确认。
        const [existingSceneRows] = await db.execute(
          `SELECT COUNT(*) AS total FROM script_scenes WHERE project_id = ?`,
          [projectId],
        )
        if (Number(existingSceneRows[0]?.total || 0) > 0 && String(req.headers['x-confirm-regenerate'] || '') !== 'true') {
          fail(res, 4090, '项目已有场景，重新生成会覆盖剧本与分镜，请确认后再试', 409)
          return
        }
        // 清空旧场景（保持幂等）
        const [existingScenes] = await db.execute(
          `SELECT COUNT(*) AS total FROM script_scenes WHERE project_id = ?`,
          [projectId],
        )
        if (Number(existingScenes[0]?.total || 0) > 0) {
          fail(res, 4090, '项目已有场景，旧版总纲不能覆盖现有剧本与分镜', 409)
          return
        }

        const connection = await db.getConnection()
        const insertedIds = []
        try {
          await connection.beginTransaction()
          for (let i = 0; i < scenesSpec.length; i += 1) {
            const spec = scenesSpec[i]
            const [insertResult] = await connection.execute(
              `INSERT INTO script_scenes
                 (project_id, episode_no, outline_id, scene_no, title, summary, location, time_of_day,
                  estimated_duration, sort_order, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
              [
                projectId,
                Number(spec.episode_no || spec.episodeNo || 1),
                outline?.id || null,
                spec.scene_no || i + 1,
                spec.title || `场景 ${i + 1}`,
                spec.summary || '',
                spec.location || null,
                spec.time_of_day || null,
                spec.estimated_duration || 120,
                i,
              ],
            )
            insertedIds.push(Number(insertResult.insertId))
          }
          await connection.commit()
        } catch (e) {
          await connection.rollback()
          throw e
        } finally {
          connection.release()
        }

        await db.execute(
          `UPDATE projects SET status = 'scripting', updated_at = NOW() WHERE id = ?`,
          [projectId],
        )

        const [rows] = await db.execute(
          `SELECT * FROM script_scenes WHERE project_id = ? ORDER BY episode_no ASC, sort_order ASC, scene_no ASC, id ASC`,
          [projectId],
        )
        success(res, { items: rows.map(sceneRow) }, '场景列表已生成')
        return
      }

      if (sub === 'scenes' && req.method === 'POST' && tail.startsWith('/extract')) {
        const body = await parseBody(req)
        let scriptText = String(body.scriptText || body.content || '').trim()
        if (!scriptText) {
          const [sourceSceneRows] = await db.execute(
            `SELECT episode_no, scene_no, title, summary, content
             FROM script_scenes
             WHERE project_id = ?
             ORDER BY episode_no ASC, sort_order ASC, scene_no ASC, id ASC`,
            [projectId],
          )
          scriptText = sourceSceneRows
            .map((item) => [
              `【第${item.episode_no || '?'}集·第${item.scene_no || '?'}场｜${item.title || '未命名场景'}】`,
              item.summary,
              item.content,
            ].filter(Boolean).join('\n'))
            .join('\n\n')
            .trim()
        }
        if (!scriptText) {
          fail(res, 4001, '请先提供完整剧本文本，场景解析 Agent 才能识别空间切换')
          return
        }
        const sceneSpecs = await extractScenesWithAgent({
          projectName: project.name,
          scriptText,
        })
        const [existingRows] = await db.execute(
          `SELECT COUNT(*) AS total FROM script_scenes WHERE project_id = ?`,
          [projectId],
        )
        if (Number(existingRows[0]?.total || 0) > 0
          && String(req.headers['x-confirm-regenerate'] || '') !== 'true') {
          fail(res, 4090, '项目已有场景，重新解析会覆盖剧本与分镜，请确认后再试', 409)
          return
        }
        const connection = await db.getConnection()
        try {
          await connection.beginTransaction()
          await connection.execute(`DELETE FROM script_scenes WHERE project_id = ?`, [projectId])
          for (let index = 0; index < sceneSpecs.length; index += 1) {
            const spec = sceneSpecs[index]
            await connection.execute(
              `INSERT INTO script_scenes
                (project_id, episode_no, outline_id, scene_no, title, summary, content, spatial_anchors_json, location,
                 time_of_day, estimated_duration, sort_order, status)
               VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
              [
                projectId,
                Number(spec.episode_no || spec.episodeNo || 1),
                spec.scene_no || index + 1,
                spec.title,
                spec.summary,
                spec.content,
                JSON.stringify(spec.spatial_anchors),
                spec.location,
                spec.time_of_day,
                spec.estimated_duration,
                index,
              ],
            )
          }
          await connection.execute(
            `UPDATE projects SET status = 'scripting', updated_at = NOW() WHERE id = ?`,
            [projectId],
          )
          await connection.commit()
        } catch (error) {
          await connection.rollback()
          throw error
        } finally {
          connection.release()
        }
        const [rows] = await db.execute(
          `SELECT * FROM script_scenes WHERE project_id = ? ORDER BY episode_no ASC, sort_order ASC, scene_no ASC, id ASC`,
          [projectId],
        )
        success(res, { items: rows.map(sceneRow) }, '场景解析 Agent 已完成')
        return
      }
    }

    // 单场景剧本：生成 / 保存
    const sceneScriptMatch = pathname.match(/^\/api\/scenes\/(\d+)\/script(\/generate)?$/)
    if (sceneScriptMatch) {
      const user = await authenticate(req, res)
      if (!user) return

      const sceneId = parseId(sceneScriptMatch[1])
      const isGenerate = Boolean(sceneScriptMatch[2])

      const [sceneRows] = await db.execute(
        `SELECT s.*, p.user_id AS ownerId, p.name AS projectName, p.category, p.narrative_vision, p.visual_style
         FROM script_scenes s
         INNER JOIN projects p ON p.id = s.project_id
         WHERE s.id = ? LIMIT 1`,
        [sceneId],
      )
      const scene = sceneRows[0]
      if (!scene || scene.ownerId !== user.id) {
        fail(res, 4004, '场景不存在或无权访问', 404)
        return
      }

      if (req.method === 'POST' && isGenerate) {
        const [bibleRows] = await db.execute(
          `SELECT * FROM story_bibles WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
          [scene.project_id],
        )
        const [seasonRows] = await db.execute(
          `SELECT * FROM season_structures WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
          [scene.project_id],
        )
        const [outlineRows] = await db.execute(
          `SELECT * FROM story_outlines WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
          [scene.project_id],
        )
        const outline = outlineRows[0] || null
        const bible = bibleRows[0] ? storyBibleRow(bibleRows[0]) : null
        const season = seasonRows[0] ? seasonStructureRow(seasonRows[0]) : null
        const aiScript = await aiGenerateSceneScript({
          scene,
          outline: outline
            ? {
                ...outline,
                title: outline.title,
              }
            : null,
          storyBible: bible,
          seasonStructure: season,
          project: {
            name: scene.projectName,
            category: scene.category,
            visualStyle: scene.visual_style,
            narrativeVision: scene.narrative_vision,
          },
        })

        await db.execute(
          `UPDATE script_scenes
           SET title = ?, summary = ?, content = ?, mood = ?, location = ?,
               time_of_day = ?, estimated_duration = ?, status = 'generated', updated_at = NOW()
           WHERE id = ?`,
          [
            aiScript.title,
            aiScript.summary,
            aiScript.content,
            aiScript.mood,
            aiScript.location,
            aiScript.time_of_day,
            aiScript.estimated_duration,
            sceneId,
          ],
        )

        const [rows] = await db.execute(`SELECT * FROM script_scenes WHERE id = ?`, [sceneId])
        success(res, sceneRow(rows[0]), '剧本已生成')
        return
      }

      if (req.method === 'PUT') {
        const body = await parseBody(req)
        const content = body.content != null ? String(body.content) : scene.content
        const mood = body.mood != null ? String(body.mood) : scene.mood
        const title = body.title != null ? String(body.title) : scene.title
        await db.execute(
          `UPDATE script_scenes SET content = ?, mood = ?, title = ?, status = 'revised', updated_at = NOW() WHERE id = ?`,
          [content, mood, title, sceneId],
        )
        const [rows] = await db.execute(`SELECT * FROM script_scenes WHERE id = ?`, [sceneId])
        success(res, sceneRow(rows[0]), '剧本已保存')
        return
      }
    }

    // 单场景剧本获取 + 场景基础信息更新（场景拆解页保存）
    const sceneDetailMatch = pathname.match(/^\/api\/scenes\/(\d+)$/)
    if (sceneDetailMatch && (req.method === 'GET' || req.method === 'PUT')) {
      const user = await authenticate(req, res)
      if (!user) return

      const sceneId = parseId(sceneDetailMatch[1])
      const [rows] = await db.execute(
        `SELECT s.*, p.user_id AS ownerId
         FROM script_scenes s
         INNER JOIN projects p ON p.id = s.project_id
         WHERE s.id = ? LIMIT 1`,
        [sceneId],
      )
      const scene = rows[0]
      if (!scene || scene.ownerId !== user.id) {
        fail(res, 4004, '场景不存在或无权访问', 404)
        return
      }

      if (req.method === 'GET') {
        success(res, sceneRow(scene))
        return
      }

      // PUT：白名单字段局部更新
      //   - 字段映射：camelCase（前端入参） → snake_case（DB 列）
      //   - 仅当请求体里显式传了字段才更新，未传保持原值
      //   - 数值类型（estimatedDuration）必须为正整数，否则忽略
      //     parseId 对 0 / 负数 / NaN / undefined / 非数字字符串统一返回 0
      //     必须用 `<= 0` 兜底，否则非法值会写进 estimated_duration = 0
      //   - status 字段不在白名单：避免前端误改
      const SCENE_PUT_FIELDS = {
        title: 'title',
        summary: 'summary',
        location: 'location',
        timeOfDay: 'time_of_day',
        estimatedDuration: 'estimated_duration',
      }
      const body = await parseBody(req)
      const sets = []
      const params = []
      for (const [apiKey, col] of Object.entries(SCENE_PUT_FIELDS)) {
        if (!Object.prototype.hasOwnProperty.call(body, apiKey)) continue
        const raw = body[apiKey]
        if (apiKey === 'estimatedDuration') {
          const n = parseId(raw)
          if (n <= 0) continue
          sets.push(`${col} = ?`)
          params.push(n)
        } else if (raw === null || raw === '') {
          sets.push(`${col} = NULL`)
        } else {
          sets.push(`${col} = ?`)
          params.push(String(raw))
        }
      }
      if (sets.length === 0) {
        // 没有任何可识别字段：直接返回当前对象，避免空 UPDATE 报错
        success(res, sceneRow(scene), '场景无变更')
        return
      }
      params.push(sceneId)
      await db.execute(
        `UPDATE script_scenes SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`,
        params,
      )
      const [updatedRows] = await db.execute(`SELECT * FROM script_scenes WHERE id = ?`, [sceneId])
      success(res, sceneRow(updatedRows[0]), '场景已保存')
      return
    }

    // 场景分镜：生成 / 列表
    const sceneStoryboardMatch = pathname.match(/^\/api\/scenes\/(\d+)\/storyboards(\/generate)?$/)
    if (sceneStoryboardMatch) {
      const user = await authenticate(req, res)
      if (!user) return

      const sceneId = parseId(sceneStoryboardMatch[1])
      const isGenerate = Boolean(sceneStoryboardMatch[2])

      const [sceneRows] = await db.execute(
        `SELECT s.*, p.user_id AS ownerId, p.name AS projectName, p.category, p.narrative_vision, p.visual_style
         FROM script_scenes s
         INNER JOIN projects p ON p.id = s.project_id
         WHERE s.id = ? LIMIT 1`,
        [sceneId],
      )
      const scene = sceneRows[0]
      if (!scene || scene.ownerId !== user.id) {
        fail(res, 4004, '场景不存在或无权访问', 404)
        return
      }

      if (req.method === 'POST' && isGenerate) {
        // P2: scene.content 是生成分镜的硬前提（前后端双重校验）
        //    空剧本不允许走 AI 流程，由后端在 route 入口直接 400 兜底
        //    不再依赖 AI service 内部 "scene.content || scene.summary" 之类的回退
        if (!scene.content || !String(scene.content).trim()) {
          fail(res, 4004, '场景没有剧本内容，请先在单场剧本模块生成或编辑剧本', 400)
          return
        }

        const workflowGates = await getProjectWorkflowReadiness(Number(scene.project_id))
        if (!workflowGates.storyboard.allowed) {
          fail(res, 4011, workflowGates.storyboard.reason, 409, { workflowGate: workflowGates.storyboard })
          return
        }

        const [outlineRows] = await db.execute(
          `SELECT * FROM story_outlines WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
          [scene.project_id],
        )
        const outline = outlineRows[0]
        const [projectCharacterRows] = await db.execute(
          `SELECT c.id, c.name, c.role_tag, c.personality, c.appearance, c.voice_setting, c.age_group, c.gender,
                  c.voice_profile_key, c.voice_locked, c.reference_image_url, c.status,
                  COALESCE((SELECT MAX(ci.version_no) FROM character_images ci
                            WHERE ci.character_id = c.id AND ci.status = 'confirmed'), 1) AS asset_version,
                  (SELECT ci.id FROM character_images ci
                   WHERE ci.character_id = c.id AND ci.status = 'confirmed'
                   ORDER BY ci.version_no DESC, ci.id DESC LIMIT 1) AS confirmed_image_id
           FROM characters c WHERE c.project_id = ? ORDER BY c.id ASC`,
          [scene.project_id],
        )
        const sceneText = [scene.title, scene.summary, scene.content]
          .filter(Boolean)
          .join('\n')
        // 分镜 Agent 只能看到本场正文明确出现的角色；整季角色档案仍保留在
        // 项目库中，但不能让后续场景人物因为总纲或“提及”混入当前镜头。
        const sceneCharacterRows = projectCharacterRows.filter((character) =>
          sceneText.includes(String(character.name || '').trim()),
        )

        const [storyboardAssetRows] = await db.execute(
          `SELECT an.id AS asset_node_id, an.node_type, an.ref_id, an.label,
                  an.prompt_text AS asset_prompt,
                  ai.id AS image_id, ai.version_no, ai.view_set_version, ai.view_index, ai.view_key,
                  ai.view_set_type, ai.status, ai.vision_status
           FROM asset_nodes an
           LEFT JOIN asset_node_images ai
             ON ai.asset_node_id = an.id
            AND ai.status = 'confirmed'
              AND (ai.vision_status = 'passed'
                   OR (an.node_type = 'scene' AND ai.vision_status = 'skipped'))
           WHERE an.project_id = ? AND an.status <> 'archived'
           ORDER BY an.id ASC, ai.id ASC`,
          [scene.project_id],
        )

        const assetCatalog = buildStoryboardAssetCatalog(storyboardAssetRows, sceneId)
        const projectKnowledgeChunks = buildProjectKnowledgeChunks({
          scene,
          characters: sceneCharacterRows,
          assetCatalog,
        })
        const ragDocuments = buildRagDocuments({
          projectId: scene.project_id,
          episodeNo: scene.episode_no,
          chunks: projectKnowledgeChunks,
        })
        const ragIndex = await indexRagDocuments(ragDocuments)
        if (ragIndex.degraded) {
          console.warn('[rag] single-scene memory sync degraded', {
            projectId: scene.project_id,
            episodeNo: scene.episode_no,
            errorCode: ragIndex.errorCode,
          })
        }
        const ragQuery = await queryRagDocuments({
          projectId: scene.project_id,
          episodeId: scene.episode_no,
          query: [scene.title, scene.summary, scene.content].filter(Boolean).join(' '),
        })
        if (ragQuery.degraded) {
          console.warn('[rag] single-scene context degraded', {
            projectId: scene.project_id,
            episodeNo: scene.episode_no,
            errorCode: ragQuery.errorCode,
          })
        }

        const aiResult = await aiGenerateStoryboards({
          sceneId,
          scene,
          scriptContent: scene.content,
          outline: outline
            ? {
                ...outline,
                title: outline.title,
                premise: outline.premise,
              }
            : null,
          project: {
            name: scene.projectName,
            visualStyle: scene.visual_style,
            category: scene.category,
            narrativeVision: scene.narrative_vision,
          },
          characters: sceneCharacterRows,
          assetCatalog,
          ragContext: ragQuery.items,
        })

        const durationContract = validateStoryboardDurationContracts(aiResult.shots, { requireVisibleTimeline: true })
        if (!durationContract.passed) {
          const error = new Error(`分镜时长规划校验未通过：${durationContract.blockers.join('；')}`)
          error.statusCode = 422
          throw error
        }

        // P1: DELETE + INSERT + UPDATE 整体进事务
        //    任何一步失败全部回滚，旧分镜完整保留；不允许"半套新分镜 + 状态已切"的状态出现
        //    conn 在 finally 里 release，避免连接泄漏
        const conn = await db.getConnection()
        try {
          await conn.beginTransaction()

          await conn.execute(`DELETE FROM storyboards WHERE scene_id = ?`, [sceneId])

          const [assetNodeRows] = await conn.execute(
            `SELECT an.id, an.node_type, an.ref_id, an.label,
                    ai.id AS image_id, ai.version_no, ai.view_set_version, ai.view_index, ai.view_key,
                    ai.view_set_type, ai.status, ai.vision_status
             FROM asset_nodes an
             LEFT JOIN asset_node_images ai
               ON ai.asset_node_id = an.id
              AND ai.status = 'confirmed'
              AND (ai.vision_status = 'passed' OR ai.vision_status IS NULL
                   OR (an.node_type = 'scene' AND ai.vision_status = 'skipped'))
             WHERE an.project_id = ? AND an.status <> 'archived'
             ORDER BY an.id ASC, ai.id ASC`,
            [scene.project_id],
          )
          const characterAssetRows = assetNodeRows.filter((row) => row.node_type === 'character')
          const sceneAssetRows = assetNodeRows.filter((row) => row.node_type === 'scene')
          const findCharacterAsset = (names = []) =>
            characterAssetRows.find((row) =>
              names.some((name) => String(name || '').trim() === String(row.label || '').trim())
              || names.some((name) => Number(row.ref_id) > 0 && projectCharacterRows.some(
                (character) => Number(character.id) === Number(row.ref_id)
                  && String(character.name).trim() === String(name || '').trim(),
              )),
            )
          const sceneAsset = sceneAssetRows.find((row) => Number(row.ref_id) === Number(sceneId))

          for (let i = 0; i < aiResult.shots.length; i += 1) {
            const shot = aiResult.shots[i]
            const characterName = String(shot.character_name || '').trim()
            const sceneAssetNames = Array.isArray(shot.scene_assets) ? shot.scene_assets : []
            const propAssetNames = Array.isArray(shot.prop_assets) ? shot.prop_assets : []
            const characterAssetNames = Array.isArray(shot.character_assets) && shot.character_assets.length
              ? shot.character_assets
              : characterName ? [characterName] : []
            const character = projectCharacterRows.find((item) =>
              characterAssetNames.some((name) => String(name).trim() === String(item.name).trim()),
            )
            const characterAsset = findCharacterAsset(characterAssetNames)
            const characterAssetPackRow = characterAsset
              ? assetNodeRows.find((row) =>
                assetNodeRowId(row) === assetNodeRowId(characterAsset)
                && row.view_set_type === 'character-asset-pack'
                && row.status === 'confirmed'
                && (!row.vision_status || row.vision_status === 'passed'),
              )
              : null
            const characterTurnaroundRows = characterAsset
              ? assetNodeRows.filter((row) =>
                assetNodeRowId(row) === assetNodeRowId(characterAsset)
                && row.view_set_type === 'character-turnaround'
                && ['front', 'side', 'back'].includes(String(row.view_key || '')),
              )
              : []
            const characterBaseRow = characterAsset
              ? assetNodeRows.find((row) =>
                assetNodeRowId(row) === assetNodeRowId(characterAsset)
                && ['single', 'character-asset-pack'].includes(String(row.view_set_type || ''))
                && !String(row.view_key || '').trim()
                && row.status === 'confirmed'
                && (!row.vision_status || row.vision_status === 'passed'),
              )
              : null
            const characterFaceRow = characterAsset
              ? assetNodeRows.find((row) =>
                assetNodeRowId(row) === assetNodeRowId(characterAsset)
                && ((row.view_set_type === 'character-face-closeup' && String(row.view_key || '') === 'face')
                  || row.view_set_type === 'character-asset-pack')
                && row.status === 'confirmed'
                && (!row.vision_status || row.vision_status === 'passed'),
              )
              : null
            const characterFaceRequired = !characterAssetPackRow && requiresCharacterFaceReference(
              character,
              scene.content,
              shot.visual_prompt,
              shot.action_text,
            )
            const characterViewKeys = characterAssetPackRow
              ? ['front', 'side', 'back']
              : [...new Set(characterTurnaroundRows.map((row) => row.view_key))]
            const requiredCharacterViews = characterName
              ? ['front', 'side', 'back']
              : []
            const missingCharacterViews = requiredCharacterViews.filter((key) => !characterViewKeys.includes(key))
            const sceneViewKey = String(shot.scene_view_key || '').trim()
            const scenePanorama = sceneAsset
              ? sceneAssetRows.find((row) =>
                assetNodeRowId(row) === assetNodeRowId(sceneAsset)
                && row.view_set_type === 'single'
                && !String(row.view_key || '').trim()
                && row.status === 'confirmed'
                && (!row.vision_status || row.vision_status === 'passed' || row.vision_status === 'skipped'),
              )
              : null
            const sceneView = sceneAssetRows.find((row) =>
              assetNodeRowId(row) === assetNodeRowId(sceneAsset)
              && row.view_set_type === 'scene-nine-grid'
              && String(row.view_key || '') === sceneViewKey,
            )
            const propRows = propAssetNames.map((name) => assetNodeRows.find((row) =>
              ['prop', 'tool', 'material'].includes(String(row.node_type || ''))
              && String(row.label || '').trim() === String(name || '').trim()
              && row.status === 'confirmed'
              && (!row.vision_status || row.vision_status === 'passed'),
            )).filter(Boolean)
            const missingProps = propAssetNames.filter((name) => !propRows.some((row) => String(row.label || '').trim() === String(name || '').trim()))
            const tools = Array.isArray(shot.tools) ? shot.tools.map((item) => String(item || '').trim()).filter(Boolean) : []
            const performance = normalizeStoryboardPerformance(shot)
            const direction = validateStoryboardDirectionContract(shot)
            const blockers = []
            blockers.push(...direction.blockers.map((message) => `镜头 ${shot.shot_no}：${message}`))
            if (characterName && !character) {
              blockers.push(`镜头 ${shot.shot_no} 引用了不存在的角色「${characterName}」`)
            }
            if (characterName && !characterAsset) {
              blockers.push(`镜头 ${shot.shot_no} 的角色「${characterName}」没有绑定角色资产`)
            }
            if (characterName && !characterAssetPackRow) {
              blockers.push(`镜头 ${shot.shot_no} 的角色「${characterName}」没有已采用的完整角色资产板，请在资产页等待五区视觉检查通过`)
            }
            if (!sceneAsset || !scenePanorama) {
              blockers.push(`镜头 ${shot.shot_no} 没有绑定当前场景全景资产`)
            }
            for (const name of missingProps) blockers.push(`镜头 ${shot.shot_no} 引用的道具「${name}」没有已确认道具资产`)
            if (blockers.length) {
              const error = new Error(`分镜资产引用门禁未通过：${blockers.join('；')}`)
              error.statusCode = 409
              throw error
            }
            const assetReference = {
              schemaVersion: 1,
              source: 'storyboard-agent',
              characterId: assetNodeRowId(characterAsset),
              characterVersionNo: characterAssetPackRow?.version_no || characterAsset?.version_no || null,
              characterViewSetVersion: characterAssetPackRow?.view_set_version
                || characterAssetPackRow?.version_no
                || null,
              characterViewKeys: ['front', 'side', 'back'],
              characterBaseImageId: characterAssetPackRow?.image_id || characterAssetPackRow?.id || null,
              characterBaseVersionNo: characterAssetPackRow?.version_no || null,
              characterFaceImageId: characterAssetPackRow?.image_id || characterAssetPackRow?.id || null,
              characterFaceVersionNo: characterAssetPackRow?.version_no || null,
              characterAssetPackImageId: characterAssetPackRow?.image_id || null,
              characterAssetPackVersionNo: characterAssetPackRow?.version_no || null,
              characterFaceRequired,
              characterName: character?.name || characterName || null,
              sceneAssetId: assetNodeRowId(sceneAsset),
              scenePanoramaVersion: scenePanorama?.version_no || sceneAsset?.version_no || null,
              scenePanoramaImageId: scenePanorama?.image_id || scenePanorama?.id || null,
              sceneViewSetVersion: sceneAsset?.view_set_version || null,
              sceneAssetNames: [...new Set([...sceneAssetNames, String(sceneAsset?.label || '').trim()].filter(Boolean))],
              sceneViewKey: sceneViewKey || null,
              sceneViewIndex: sceneView?.view_index || null,
              propAssetNames,
              propAssetIds: propRows.map(assetNodeRowId).filter(Boolean),
              propImageIds: propRows.map((row) => Number(row.image_id)).filter(Boolean),
              propAssetRefs: propRows.map((row) => ({
                assetNodeId: assetNodeRowId(row),
                imageId: Number(row.image_id) || null,
                name: String(row.label || '').trim(),
                versionNo: Number(row.version_no) || null,
              })),
              tools,
              emotionalChange: performance.emotionChange,
              gazePlan: direction.gaze,
              soundPlan: direction.sound,
              performance,
              startState: shot.start_state || '',
              endState: shot.end_state || '',
              startVisualPrompt: shot.start_visual_prompt || '',
              endVisualPrompt: shot.end_visual_prompt || '',
            }
            await conn.execute(
              `INSERT INTO storyboards
            (scene_id, shot_no, shot_type, camera_angle, composition, duration_seconds,
             character_id, character_name, action_text, dialogue_text, visual_prompt,
             start_visual_prompt, end_visual_prompt, asset_reference_json, sort_order, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
              [
                sceneId,
                shot.shot_no,
                shot.shot_type,
                shot.camera_angle,
                shot.composition,
                normalizeStoryboardDurationSeconds(shot.duration_seconds),
                matchCharacterId(shot.character_name, projectCharacterRows),
                shot.character_name,
                shot.action_text,
                shot.dialogue_text,
                buildStoryboardMentionedPrompt(shot.visual_prompt, assetReference),
                shot.start_visual_prompt || null,
                shot.end_visual_prompt || null,
                JSON.stringify(assetReference),
                i,
              ],
            )
          }

          await conn.execute(
            `UPDATE script_scenes SET status = 'storyboard_ready', updated_at = NOW() WHERE id = ?`,
            [sceneId],
          )
          await conn.execute(
            `UPDATE projects SET status = 'storyboarding', updated_at = NOW() WHERE id = ?`,
            [scene.project_id],
          )

          await conn.commit()
        } catch (txErr) {
          await conn.rollback()
          throw txErr
        } finally {
          conn.release()
        }

        const [rows] = await db.execute(
          `SELECT * FROM storyboards WHERE scene_id = ? ORDER BY sort_order ASC, id ASC`,
          [sceneId],
        )
        success(res, { items: rows.map(storyboardRow) }, '分镜已生成')
        return
      }

      if (req.method === 'GET') {
        const [rows] = await db.execute(
          `SELECT s.*, COALESCE(c.name, s.character_name) AS character_name
           FROM storyboards s
           LEFT JOIN characters c ON c.id = s.character_id
           WHERE s.scene_id = ?
           ORDER BY s.sort_order ASC, s.id ASC`,
          [sceneId],
        )
        success(res, { items: rows.map(storyboardRow) })
        return
      }
    }

    const storyboardFramePromptRewriteMatch = pathname.match(/^\/api\/storyboards\/(\d+)\/frame-prompt\/rewrite$/)
    if (storyboardFramePromptRewriteMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return

      const storyboardId = parseId(storyboardFramePromptRewriteMatch[1])
      if (!storyboardId) {
        fail(res, 4001, '无效的 storyboardId', 400)
        return
      }

      await parseBody(req)
      const context = await buildFramePromptRewriteContext(user.id, storyboardId)
      if (!context) {
        fail(res, 4004, '分镜不存在或无权访问', 404)
        return
      }

      const result = await rewriteFrameVisualPrompt(context)
      success(res, {
        visualPrompt: result.visualPrompt,
        notes: result.notes || '',
        frameCharacterContext: context.frameCharacterContext,
      }, '视觉提示词已重写')
      return
    }

    // 单分镜：详情 / 修改 / 状态
    const storyboardMatch = pathname.match(/^\/api\/storyboards\/(\d+)(\/(reorder))?$/)
    if (storyboardMatch) {
      const user = await authenticate(req, res)
      if (!user) return

      const storyboardId = parseId(storyboardMatch[1])

      // 校验归属
      const [ownRows] = await db.execute(
        `SELECT s.*,
                COALESCE(c.name, s.character_name) AS character_name,
                sc.project_id,
                p.user_id AS ownerId
         FROM storyboards s
         INNER JOIN script_scenes sc ON sc.id = s.scene_id
         INNER JOIN projects p ON p.id = sc.project_id
         LEFT JOIN characters c ON c.id = s.character_id
         WHERE s.id = ? LIMIT 1`,
        [storyboardId],
      )
      const shot = ownRows[0]
      if (!shot || shot.ownerId !== user.id) {
        fail(res, 4004, '分镜不存在或无权访问', 404)
        return
      }

      if (req.method === 'GET') {
        const [characterRows] = await db.execute(
          `SELECT id, name, role_tag, personality, appearance, age_group, gender,
                  reference_image_url, status
           FROM characters
           WHERE project_id = ? AND status <> 'archived'
           ORDER BY id ASC`,
          [shot.project_id],
        )
        success(res, {
          ...storyboardRow(shot),
          frameCharacterContext: resolveFrameCharacterContext(shot, characterRows),
        })
        return
      }

      if (req.method === 'PUT') {
        const body = await parseBody(req)
        let selectedCharacter = null
        let resolvedCharacterId
        if (body.characterId !== undefined) {
          resolvedCharacterId = body.characterId === null ? null : parseId(body.characterId)
          if (body.characterId !== null && !resolvedCharacterId) {
            fail(res, 4001, '无效的 characterId', 400)
            return
          }
          if (resolvedCharacterId) {
            const [characterRows] = await db.execute(
              `SELECT id, name FROM characters WHERE id = ? AND project_id = ? LIMIT 1`,
              [resolvedCharacterId, shot.project_id],
            )
            selectedCharacter = characterRows[0] || null
            if (!selectedCharacter) {
              fail(res, 4004, '角色不存在或不属于当前项目', 404)
              return
            }
          }
        } else if (body.characterName !== undefined) {
          const [characterRows] = await db.execute(
            `SELECT id, name FROM characters WHERE project_id = ? AND name = ? ORDER BY id ASC LIMIT 1`,
            [shot.project_id, String(body.characterName || '').trim()],
          )
          selectedCharacter = characterRows[0] || null
          resolvedCharacterId = selectedCharacter ? Number(selectedCharacter.id) : null
        }
        const allowed = {
          shotType: body.shotType,
          cameraAngle: body.cameraAngle,
          composition: body.composition,
          durationSeconds: body.durationSeconds === undefined
            ? undefined
            : normalizeStoryboardDurationSeconds(body.durationSeconds, shot.duration_seconds),
          characterId: resolvedCharacterId,
          characterName:
            body.characterName !== undefined ? body.characterName : selectedCharacter?.name,
          actionText: body.actionText,
          dialogueText: body.dialogueText,
          visualPrompt: body.videoPrompt !== undefined ? undefined : body.visualPrompt,
          videoPrompt: body.videoPrompt,
          startVisualPrompt: body.startVisualPrompt,
          endVisualPrompt: body.endVisualPrompt,
          imageUrl: body.imageUrl,
          endImageUrl: body.endImageUrl,
          status: body.status,
        }
        const directionWasEdited = body.gazePlan !== undefined
          || body.gaze_plan !== undefined
          || body.soundPlan !== undefined
          || body.sound_plan !== undefined
        let updatedAssetReference = null
        if (directionWasEdited) {
          const currentReference = parseJsonObject(shot.asset_reference_json || shot.assetReference) || {}
          const direction = validateStoryboardDirectionContract({
            ...shot,
            ...body,
            gazePlan: body.gazePlan ?? body.gaze_plan ?? currentReference.gazePlan ?? currentReference.performance?.gazePlan,
            soundPlan: body.soundPlan ?? body.sound_plan ?? currentReference.soundPlan ?? currentReference.performance?.soundPlan,
          })
          if (!direction.passed) {
            fail(res, 4001, `视线/声音执行计划未通过校验：${direction.blockers.join('；')}`, 422)
            return
          }
          updatedAssetReference = {
            ...currentReference,
            gazePlan: direction.gaze,
            soundPlan: direction.sound,
            performance: {
              ...(currentReference.performance || {}),
              gazePlan: direction.gaze,
              soundPlan: direction.sound,
            },
          }
        }
        const sets = []
        const params = []
        for (const [key, value] of Object.entries(allowed)) {
          if (value === undefined) continue
          const column = {
            shotType: 'shot_type',
            cameraAngle: 'camera_angle',
            composition: 'composition',
            durationSeconds: 'duration_seconds',
            characterId: 'character_id',
            characterName: 'character_name',
            actionText: 'action_text',
            dialogueText: 'dialogue_text',
            visualPrompt: 'visual_prompt',
            videoPrompt: 'visual_prompt',
            startVisualPrompt: 'start_visual_prompt',
            endVisualPrompt: 'end_visual_prompt',
            imageUrl: 'image_url',
            endImageUrl: 'end_image_url',
            status: 'status',
          }[key]
          sets.push(`${column} = ?`)
          params.push(value)
        }
        if (updatedAssetReference) {
          sets.push('asset_reference_json = ?')
          params.push(JSON.stringify(updatedAssetReference))
        }
        if (sets.length) {
          params.push(storyboardId)
          await db.execute(
            `UPDATE storyboards SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`,
            params,
          )
        }
        const [rows] = await db.execute(
          `SELECT s.*, p.user_id AS ownerId
           FROM storyboards s
           INNER JOIN script_scenes sc ON sc.id = s.scene_id
           INNER JOIN projects p ON p.id = sc.project_id
           WHERE s.id = ? LIMIT 1`,
          [storyboardId],
        )
        success(res, storyboardRow(rows[0]), '分镜已保存')
        return
      }
    }

    const storyboardKeyframeOptimizeMatch = pathname.match(/^\/api\/storyboards\/(\d+)\/keyframes\/optimize$/)
    if (storyboardKeyframeOptimizeMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return
      const storyboardId = parseId(storyboardKeyframeOptimizeMatch[1])
      if (!storyboardId) {
        fail(res, 4001, '无效的 storyboardId', 400)
        return
      }
      try {
        const result = await optimizeStoryboardKeyframes(user.id, storyboardId)
        if (!result) {
          fail(res, 4004, '分镜不存在或无权访问', 404)
          return
        }
        success(res, result, '两帧提示词已优化')
      } catch (error) {
        fail(res, 4011, error instanceof Error ? error.message : '两帧提示词优化失败', error?.statusCode || 400)
      }
      return
    }

    const storyboardContinuityMatch = pathname.match(/^\/api\/storyboards\/(\d+)\/continuity\/start-frame$/)
    if (storyboardContinuityMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return
      const storyboardId = parseId(storyboardContinuityMatch[1])
      if (!storyboardId) {
        fail(res, 4001, '无效的 storyboardId', 400)
        return
      }
      try {
        const result = await copyPreviousFrameToStoryboard(user.id, storyboardId)
        if (!result) {
          fail(res, 4004, '分镜不存在或无权访问', 404)
          return
        }
        success(res, result, '已承接上一镜头')
      } catch (error) {
        fail(res, 4011, error instanceof Error ? error.message : '承接上一镜头失败', error?.statusCode || 400)
      }
      return
    }

    const storyboardSplitMatch = pathname.match(/^\/api\/storyboards\/(\d+)\/split$/)
    if (storyboardSplitMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return
      const storyboardId = parseId(storyboardSplitMatch[1])
      if (!storyboardId) {
        fail(res, 4001, '无效的 storyboardId', 400)
        return
      }
      try {
        const result = await splitStoryboardIntoSubShots(user.id, storyboardId)
        if (!result) {
          fail(res, 4004, '分镜不存在或无权访问', 404)
          return
        }
        success(res, result, '子分镜已拆分')
      } catch (error) {
        fail(res, 4011, error instanceof Error ? error.message : 'AI 拆分子分镜失败', error?.statusCode || 400)
      }
      return
    }

    const storyboardDialogueSplitMatch = pathname.match(/^\/api\/storyboards\/(\d+)\/dialogue\/split$/)
    if (storyboardDialogueSplitMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return
      const storyboardId = parseId(storyboardDialogueSplitMatch[1])
      if (!storyboardId) {
        fail(res, 4001, '无效的 storyboardId', 400)
        return
      }
      try {
        const result = await splitStoryboardDialogueTurns(user.id, storyboardId)
        if (!result) {
          fail(res, 4004, '分镜不存在或无权访问', 404)
          return
        }
        success(res, result, '多人对白已拆分为可做口型的短分镜')
      } catch (error) {
        fail(res, 4011, error instanceof Error ? error.message : 'AI 拆分多人对白失败', error?.statusCode || 400)
      }
      return
    }

    // 分镜重排序：批量修改 sort_order
    if (pathname === '/api/storyboards/reorder' && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return

      const body = await parseBody(req)
      const orders = Array.isArray(body.orders) ? body.orders : []
      if (!orders.length) {
        fail(res, 4001, '缺少排序数据')
        return
      }
      for (const item of orders) {
        const id = parseId(item.id)
        const order = parseId(item.sortOrder)
        if (!id) continue
        await db.execute(
          `UPDATE storyboards s
           INNER JOIN script_scenes sc ON sc.id = s.scene_id
           INNER JOIN projects p ON p.id = sc.project_id
           SET s.sort_order = ?
           WHERE s.id = ? AND p.user_id = ?`,
          [order, id, user.id],
        )
      }
      success(res, { success: true }, '排序已更新')
      return
    }

    // 角色库：项目下的角色列表（GET） / 新建（POST）
    const unusedProjectCharactersMatch = pathname.match(/^\/api\/projects\/(\d+)\/characters$/)
    const shotImagesMatch = pathname.match(/^\/api\/shots\/(\d+)\/images(\/generate)?$/)
    if (shotImagesMatch) {
      const user = await authenticate(req, res)
      if (!user) return

      const shotId = parseId(shotImagesMatch[1])
      const isGenerate = Boolean(shotImagesMatch[2])
      if (!shotId) {
        fail(res, 4001, '无效的 shotId', 400)
        return
      }

      const [shotRows] = await db.execute(
        `SELECT s.*, sc.project_id, p.visual_style AS project_visual_style,
                p.user_id AS ownerId
         FROM storyboards s
         INNER JOIN script_scenes sc ON sc.id = s.scene_id
         INNER JOIN projects p ON p.id = sc.project_id
         WHERE s.id = ? LIMIT 1`,
        [shotId],
      )
      const shot = shotRows[0]
      if (!shot || shot.ownerId !== user.id) {
        fail(res, 4004, '分镜不存在或无权访问', 404)
        return
      }

      if (isGenerate && req.method === 'POST') {
        let body = {}
        try {
          body = await parseBody(req)
        } catch {
          body = {}
        }
        try {
          const job = await enqueueFrameImageJob(user.id, shotId, body)
          if (!job) {
            fail(res, 4004, '分镜不存在或无权访问', 404)
            return
          }
          success(res, job, '静帧生成任务已提交')
        } catch (error) {
          fail(res, 4011, error instanceof Error ? error.message : '静帧生成任务提交失败', error?.statusCode || 400)
        }
        return

        /* legacy synchronous generation path retained temporarily */
        const frameRole = normalizeFrameRole(body.frameRole)
        const promptOverride = body.prompt ? String(body.prompt).trim() : ''
        const negativePrompt = body.negativePrompt ? String(body.negativePrompt).trim() : ''
        const candidateCount = Math.max(1, Math.min(3, parseId(body.candidateCount) || 1))
        const frameConfig = getFrameConfig()
        const modelName = body.modelName ? String(body.modelName).trim() : frameConfig.defaultModel
        const [projectCharacterRows] = await db.execute(
          `SELECT id, name, role_tag, personality, appearance, age_group, gender,
                  reference_image_url, status
           FROM characters
           WHERE project_id = ? AND status <> 'archived'
           ORDER BY id ASC`,
          [shot.project_id],
        )
        const frameCharacterContext = resolveFrameCharacterContext(shot, projectCharacterRows)
        if (!frameCharacterContext.ready) {
          fail(res, 4011, frameCharacterContext.blockers[0] || '分镜角色信息不完整，无法保证画面一致性', 409)
          return
        }
        const consistencyPrompt = buildFrameConsistencyPrompt({
          prompt: promptOverride || frameRolePromptFallback(shot, frameRole),
          negativePrompt,
          storyboard: shot,
          context: frameCharacterContext,
          projectVisualStyle: shot.project_visual_style,
        })
        const promptSnapshot = consistencyPrompt.prompt
        const effectiveNegativePrompt = consistencyPrompt.negativePrompt
        const characterSnapshot = createFrameCharacterSnapshot(frameCharacterContext)
        const serializedCharacterSnapshot = JSON.stringify(characterSnapshot)

        const [versionRows] = await db.execute(
          `SELECT COALESCE(MAX(version_no), 0) AS maxVersion
           FROM image_assets WHERE storyboard_id = ?`,
          [shotId],
        )
        const nextVersion = Number(versionRows[0]?.maxVersion || 0) + 1

        let candidates
        if (isMockFrameProvider(frameConfig)) {
          candidates = Array.from({ length: candidateCount }, (_, i) => {
            const fullUrl = buildMockImageUrl(shotId, i, nextVersion)
            return {
              imageUrl: fullUrl,
              thumbnailUrl: buildMockThumbnailUrl(fullUrl),
              promptSnapshot,
              negativePrompt: effectiveNegativePrompt || null,
              characterSnapshot,
              modelName,
            }
          })
        } else {
          try {
            candidates = await generateFrameCandidates({
              storyboardId: shotId,
              versionNo: nextVersion,
              prompt: promptSnapshot,
              negativePrompt: effectiveNegativePrompt,
              modelName,
              publicBaseUrl: buildGeneratedFramePublicBaseUrl(),
              outputDir: GENERATED_FRAME_DIR,
              candidateCount,
              referenceImageUrls: consistencyPrompt.referenceImageUrls,
            })
          } catch (frameError) {
            console.error('[frame] real provider failed', frameError)
            if (!frameConfig.fallbackToMock) {
              const providerDetail = String(frameError?.message || 'unknown provider error')
                .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
                .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
                .slice(0, 300)
              fail(res, 5020, `真实静帧服务暂时不可用：${providerDetail}`, 502)
              return
            }
            console.warn('[frame] fallback to mock')
            candidates = Array.from({ length: candidateCount }, (_, i) => {
              const fullUrl = buildMockImageUrl(shotId, i, nextVersion)
              return {
                imageUrl: fullUrl,
                thumbnailUrl: buildMockThumbnailUrl(fullUrl),
                promptSnapshot,
                negativePrompt: effectiveNegativePrompt || null,
                characterSnapshot,
                modelName: 'mock-frame-v1',
              }
            })
          }
        }

        const insertedIds = []
        for (const candidate of candidates) {
          const [result] = await db.execute(
            `INSERT INTO image_assets
              (storyboard_id, version_no, image_url, thumbnail_url,
               prompt_snapshot, frame_role, negative_prompt, character_snapshot, model_name, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate')`,
            [
              shotId,
              nextVersion,
              candidate.imageUrl,
              candidate.thumbnailUrl,
              candidate.promptSnapshot || null,
              frameRole,
              candidate.negativePrompt || null,
              candidate.characterSnapshot
                ? JSON.stringify(candidate.characterSnapshot)
                : serializedCharacterSnapshot,
              candidate.modelName || modelName,
            ],
          )
          insertedIds.push(Number(result.insertId))
        }

        const placeholders = insertedIds.map(() => '?').join(', ')
        const [rows] = await db.execute(
          `SELECT * FROM image_assets WHERE id IN (${placeholders})
           ORDER BY version_no DESC, id ASC`,
          insertedIds,
        )
        success(res, { items: rows.map(imageAssetRow) }, '静帧已生成')
        return
      }

      if (!isGenerate && req.method === 'GET') {
        const [rows] = await db.execute(
          `SELECT * FROM image_assets
           WHERE storyboard_id = ?
           ORDER BY version_no DESC, id DESC`,
          [shotId],
        )
        success(res, { items: rows.map(imageAssetRow) })
        return
      }
    }

    const imageConfirmMatch = pathname.match(/^\/api\/images\/(\d+)\/confirm$/)
    if (imageConfirmMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return

      const imageId = parseId(imageConfirmMatch[1])
      if (!imageId) {
        fail(res, 4001, '无效的 imageId', 400)
        return
      }

      const [ownRows] = await db.execute(
        `SELECT ia.id, ia.storyboard_id, ia.image_url, ia.frame_role, p.user_id AS ownerId
         FROM image_assets ia
         INNER JOIN storyboards s ON s.id = ia.storyboard_id
         INNER JOIN script_scenes sc ON sc.id = s.scene_id
         INNER JOIN projects p ON p.id = sc.project_id
         WHERE ia.id = ? LIMIT 1`,
        [imageId],
      )
      const img = ownRows[0]
      if (!img || img.ownerId !== user.id) {
        fail(res, 4004, '静帧不存在或无权访问', 404)
        return
      }

      const conn = await db.getConnection()
      try {
        await conn.beginTransaction()
        const frameRole = normalizeFrameRole(img.frame_role)
        await conn.execute(
          `UPDATE image_assets SET status = 'candidate', confirmed_at = NULL
           WHERE storyboard_id = ? AND frame_role = ? AND id <> ?`,
          [img.storyboard_id, frameRole, imageId],
        )
        await conn.execute(
          `UPDATE image_assets SET status = 'confirmed', confirmed_at = NOW()
           WHERE id = ?`,
          [imageId],
        )
        if (frameRole === 'end') {
          await conn.execute(
            `UPDATE storyboards SET end_image_url = ?, updated_at = NOW() WHERE id = ?`,
            [img.image_url, img.storyboard_id],
          )
        } else {
          await conn.execute(
            `UPDATE storyboards SET image_url = ?, updated_at = NOW() WHERE id = ?`,
            [img.image_url, img.storyboard_id],
          )
        }
        await conn.commit()
      } catch (e) {
        await conn.rollback()
        throw e
      } finally {
        conn.release()
      }

      const [rows] = await db.execute(`SELECT * FROM image_assets WHERE id = ? LIMIT 1`, [imageId])
      success(res, imageAssetRow(rows[0]), '静帧已确认')
      return
    }

    const storyboardVideosMatch = pathname.match(/^\/api\/storyboards\/(\d+)\/videos(\/generate)?$/)

    const storyboardLipSyncMatch = pathname.match(
      /^\/api\/storyboards\/(\d+)\/lip-sync\/generate$/,
    )
    if (storyboardLipSyncMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return

      const storyboardId = parseId(storyboardLipSyncMatch[1])
      if (!storyboardId) {
        fail(res, 4001, '无效的 storyboardId', 400)
        return
      }
      let body = {}
      try {
        body = await parseBody(req)
      } catch {
        body = {}
      }
      try {
        const job = await enqueueLipSyncJob(user.id, storyboardId, body)
        if (!job) {
          fail(res, 4004, '分镜不存在或无权访问', 404)
          return
        }
        success(res, job, '口型同步任务已加入后台队列')
      } catch (error) {
        fail(
          res,
          4011,
          error instanceof Error ? error.message : '口型同步任务提交失败',
          error?.statusCode || 400,
        )
      }
      return
    }

    if (storyboardVideosMatch) {
      const user = await authenticate(req, res)
      if (!user) return

      const storyboardId = parseId(storyboardVideosMatch[1])
      const isGenerate = Boolean(storyboardVideosMatch[2])
      if (!storyboardId) {
        fail(res, 4001, '无效的 storyboardId', 400)
        return
      }

      const [shotRows] = await db.execute(
        `SELECT s.id, s.scene_id, s.action_text, s.visual_prompt, s.start_visual_prompt,
                s.end_visual_prompt, p.user_id AS ownerId
         FROM storyboards s
         INNER JOIN script_scenes sc ON sc.id = s.scene_id
         INNER JOIN projects p ON p.id = sc.project_id
         WHERE s.id = ? LIMIT 1`,
        [storyboardId],
      )
      const shot = shotRows[0]
      if (!shot || shot.ownerId !== user.id) {
        fail(res, 4004, '分镜不存在或无权访问', 404)
        return
      }

      if (req.method === 'POST' && isGenerate) {
        let body = {}
        try {
          body = await parseBody(req)
        } catch {
          body = {}
        }

        try {
          const job = await enqueueStoryboardVideoJob(user.id, storyboardId, body)
          if (!job) {
            fail(res, 4004, '分镜不存在或无权访问', 404)
            return
          }
          success(res, job, '视频生成任务已加入后台队列')
        } catch (error) {
          fail(
            res,
            4011,
            error instanceof Error ? error.message : '视频生成任务提交失败',
            error?.statusCode || 400,
            error?.qualityReport ? { qualityReport: error.qualityReport } : undefined,
          )
        }
        return

        /* legacy synchronous generation path retained temporarily */

        const [confirmedRows] = await db.execute(
          `SELECT * FROM image_assets
           WHERE storyboard_id = ? AND status = 'confirmed'
           ORDER BY CASE frame_role WHEN 'start' THEN 0 WHEN 'primary' THEN 1 ELSE 2 END ASC,
             confirmed_at DESC, id DESC`,
          [storyboardId],
        )
        const confirmedImage = confirmedRows.find((item) => normalizeFrameRole(item.frame_role) !== 'end')
          || confirmedRows[0]
        if (!confirmedImage) {
          fail(res, 4001, '请先确认静帧后再生成视频', 400)
          return
        }
        const confirmedEndImage =
          confirmedRows.find((item) => normalizeFrameRole(item.frame_role) === 'end') || null

        const motionMode = body.motionMode ? String(body.motionMode).trim() : 'PAN'
        const promptOverride = body.prompt ? String(body.prompt).trim() : ''
        const durationSeconds = parseId(body.durationSeconds) || 4
        const candidateCount = Math.max(1, Math.min(3, parseId(body.candidateCount) || 3))
        const videoConfig = getVideoConfig()
        const modelName = body.modelName ? String(body.modelName).trim() : videoConfig.defaultModel

        const [versionRows] = await db.execute(
          `SELECT COALESCE(MAX(version_no), 0) AS maxVersion
           FROM video_assets WHERE storyboard_id = ?`,
          [storyboardId],
        )
        const nextVersion = Number(versionRows[0]?.maxVersion || 0) + 1

        let candidates
        if (isMockVideoProvider(videoConfig)) {
          candidates = Array.from({ length: candidateCount }, (_, i) => ({
            videoUrl: buildMockVideoUrl(storyboardId, i, nextVersion),
            thumbnailUrl: buildMockVideoThumbnailUrl(confirmedImage.image_url),
            motionMode,
            durationSeconds,
            modelName,
          }))
        } else {
          try {
            candidates = await generateVideoCandidates({
              imageUrl: confirmedImage.image_url,
              prompt: buildTwoKeyframeVideoPrompt({
                prompt: promptOverride,
                shot,
                startImage: confirmedImage,
                endImage: confirmedEndImage,
              }),
              motionMode,
              durationSeconds,
              modelName,
              candidateCount,
            })
          } catch (videoError) {
            console.error('[video] real provider failed', videoError)
            if (!videoConfig.fallbackToMock) {
              const providerDetail = String(videoError?.message || 'unknown provider error')
                .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
                .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
                .slice(0, 300)
              const errorPrefix = providerDetail.startsWith('Video source image upload failed:')
                ? '视频源图公网中转失败'
                : '真实视频生成服务暂时不可用'
              fail(res, 5020, `${errorPrefix}：${providerDetail}`, 502)
              return
            }
            console.warn('[video] fallback to mock')
            candidates = Array.from({ length: candidateCount }, (_, i) => ({
              videoUrl: buildMockVideoUrl(storyboardId, i, nextVersion),
              thumbnailUrl: buildMockVideoThumbnailUrl(confirmedImage.image_url),
              motionMode,
              durationSeconds,
              modelName: 'mock-video-v1',
            }))
          }
        }

        const insertedIds = []
        for (const candidate of candidates) {
          const [result] = await db.execute(
            `INSERT INTO video_assets
              (storyboard_id, image_asset_id, version_no, video_url, thumbnail_url,
               motion_mode, duration_seconds, model_name, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'candidate')`,
            [
              storyboardId,
              confirmedImage.id,
              nextVersion,
              candidate.videoUrl,
              candidate.thumbnailUrl || null,
              candidate.motionMode || motionMode || null,
              candidate.durationSeconds || durationSeconds,
              candidate.modelName || modelName,
            ],
          )
          insertedIds.push(Number(result.insertId))
        }

        const placeholders = insertedIds.map(() => '?').join(', ')
        const [rows] = await db.execute(
          `SELECT * FROM video_assets WHERE id IN (${placeholders})
           ORDER BY version_no DESC, id ASC`,
          insertedIds,
        )
        success(res, { items: rows.map(videoAssetRow) }, '候选视频已生成')
        return
      }

      if (req.method === 'GET' && !isGenerate) {
        const [rows] = await db.execute(
          `SELECT * FROM video_assets
           WHERE storyboard_id = ?
           ORDER BY version_no DESC, id DESC`,
          [storyboardId],
        )
        success(res, { items: rows.map(videoAssetRow) })
        return
      }
    }

    const subtitleCleanupMatch = pathname.match(/^\/api\/videos\/(\d+)\/subtitles\/remove$/)
    if (subtitleCleanupMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return
      const videoId = parseId(subtitleCleanupMatch[1])
      const [rows] = await db.execute(
        `SELECT va.*, s.scene_id, sc.project_id, p.user_id AS ownerId
         FROM video_assets va
         INNER JOIN storyboards s ON s.id = va.storyboard_id
         INNER JOIN script_scenes sc ON sc.id = s.scene_id
         INNER JOIN projects p ON p.id = sc.project_id
         WHERE va.id = ? LIMIT 1`,
        [videoId],
      )
      const video = rows[0]
      if (!video || Number(video.ownerId) !== Number(user.id)) {
        fail(res, 4004, '视频不存在或无权访问', 404)
        return
      }
      const job = await createGenerationJob({
        projectId: Number(video.project_id),
        jobType: 'subtitle_cleanup',
        sourceId: videoId,
        request: {
          projectId: Number(video.project_id),
          storyboardId: Number(video.storyboard_id),
          sourceVideoId: videoId,
          sourceStorageKey: video.storage_key || null,
          sourceVideoUrl: video.video_url,
          thumbnailUrl: video.thumbnail_url,
          durationSeconds: video.duration_seconds,
          modelName: video.model_name,
        },
      })
      success(res, job, '字幕清理任务已加入后台队列')
      return
    }

    const videoConfirmMatch = pathname.match(/^\/api\/videos\/(\d+)\/confirm$/)
    if (videoConfirmMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return

      const videoId = parseId(videoConfirmMatch[1])
      if (!videoId) {
        fail(res, 4001, '无效的 videoId', 400)
        return
      }

      const [ownRows] = await db.execute(
        `SELECT va.id, va.storyboard_id, va.version_no, va.video_url, va.storage_key,
                va.quality_report_json, p.user_id AS ownerId
         FROM video_assets va
         INNER JOIN storyboards s ON s.id = va.storyboard_id
         INNER JOIN script_scenes sc ON sc.id = s.scene_id
         INNER JOIN projects p ON p.id = sc.project_id
         WHERE va.id = ? LIMIT 1`,
        [videoId],
      )
      const video = ownRows[0]
      if (!video || video.ownerId !== user.id) {
        fail(res, 4004, '视频不存在或无权访问', 404)
        return
      }

      const confirmationEligibility = inspectVideoConfirmationEligibility({
        qualityReport: safeJsonParse(video.quality_report_json, null),
      })
      if (!confirmationEligibility.passed) {
        fail(res, 4094, confirmationEligibility.summary, 409)
        return
      }

      let confirmedVideoUrl = normalizeGeneratedMediaUrl(video.video_url, PUBLIC_BASE_URL)
      if (confirmedVideoUrl !== video.video_url) {
        await db.execute(
          `UPDATE video_assets SET video_url = ? WHERE id = ?`,
          [confirmedVideoUrl, videoId],
        )
      }
      const existingLocalPath = localGeneratedPathFromUrl(confirmedVideoUrl)
      let confirmationSource
      try {
        confirmationSource = resolveVideoConfirmationSource({
          storageKey: video.storage_key,
          videoUrl: confirmedVideoUrl,
          localPath: existingLocalPath,
          createSignedUrl: ({ key }) => objectStorage.createSignedUrl({ key }),
        })
      } catch {
        fail(res, 4093, '视频已存入对象存储，但播放链接刷新失败；请稍后重试确认', 409)
        return
      }
      confirmedVideoUrl = confirmationSource.videoUrl
      if (existingLocalPath) {
        if (!(await fileExists(existingLocalPath))) {
          fail(res, 4091, '该本地视频文件已丢失，请重新生成后再确认', 409)
          return
        }
      } else if (confirmationSource.shouldPersist) {
        try {
          const persisted = await persistGeneratedVideo({
            storyboardId: Number(video.storyboard_id),
            versionNo: Number(video.version_no || 1),
            candidateNo: Number(video.id),
            sourceUrl: confirmedVideoUrl,
          })
          confirmedVideoUrl = persisted.videoUrl
        } catch {
          fail(res, 4092, '该旧视频临时链接已过期，无法设为最终版本；请选择本地版本或重新生成', 409)
          return
        }
      }

      const conn = await db.getConnection()
      const reviewedReport = safeJsonParse(video.quality_report_json, null)
      if (reviewedReport) {
        reviewedReport.semanticStatus = 'accepted_by_user'
        reviewedReport.reviewedAt = new Date().toISOString()
      }
      try {
        await conn.beginTransaction()
        if (confirmedVideoUrl !== video.video_url) {
          const [urlUpdate] = await conn.execute(
            `UPDATE video_assets SET video_url = ? WHERE id = ? AND video_url = ?`,
            [confirmedVideoUrl, videoId, video.video_url],
          )
          if (Number(urlUpdate.affectedRows || 0) !== 1) {
            throw new Error('视频记录在确认期间已发生变化，请刷新后重试')
          }
        }
        await conn.execute(
          `UPDATE video_assets
           SET status = CASE WHEN status = 'confirmed' THEN 'archived' ELSE status END,
               confirmed_at = NULL
           WHERE storyboard_id = ? AND id <> ?`,
          [video.storyboard_id, videoId],
        )
        await conn.execute(
          `UPDATE video_assets SET status = 'confirmed', confirmed_at = NOW(), quality_report_json = COALESCE(?, quality_report_json)
           WHERE id = ?`,
          [reviewedReport ? JSON.stringify(reviewedReport) : null, videoId],
        )
        await conn.execute(
          `UPDATE storyboards SET video_url = ?, updated_at = NOW() WHERE id = ?`,
          [confirmedVideoUrl, video.storyboard_id],
        )
        await conn.commit()
      } catch (e) {
        await conn.rollback()
        throw e
      } finally {
        conn.release()
      }

      const [rows] = await db.execute(`SELECT * FROM video_assets WHERE id = ? LIMIT 1`, [videoId])
      success(res, videoAssetRow(rows[0]), '最终视频已确认')
      return
    }

    const audioConfirmMatch = pathname.match(/^\/api\/audio-assets\/(\d+)\/confirm$/)
    if (audioConfirmMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return

      const audioId = parseId(audioConfirmMatch[1])
      if (!audioId) {
        fail(res, 4001, '无效的 audioId', 400)
        return
      }

      const [ownRows] = await db.execute(
        `SELECT aa.id, aa.project_id, aa.track_type, aa.scene_id, aa.storyboard_id, aa.character_id, aa.status,
                p.user_id AS ownerId
         FROM audio_assets aa
         INNER JOIN projects p ON p.id = aa.project_id
         WHERE aa.id = ? LIMIT 1`,
        [audioId],
      )
      const audio = ownRows[0]
      if (!audio || audio.ownerId !== user.id) {
        fail(res, 4004, '音频资产不存在或无权访问', 404)
        return
      }

      const conn = await db.getConnection()
      try {
        await conn.beginTransaction()
        await conn.execute(
          `UPDATE audio_assets
           SET status = 'candidate', confirmed_at = NULL
           WHERE project_id = ?
             AND track_type = ?
             AND (scene_id <=> ?)
             AND (storyboard_id <=> ?)
             AND (character_id <=> ?)
             AND id <> ?
             AND status = 'confirmed'`,
          [
            audio.project_id,
            audio.track_type,
            audio.scene_id || null,
            audio.storyboard_id || null,
            audio.character_id || null,
            audioId,
          ],
        )
        await conn.execute(
          `UPDATE audio_assets
           SET status = 'confirmed', confirmed_at = NOW()
           WHERE id = ?`,
          [audioId],
        )
        await conn.commit()
      } catch (e) {
        await conn.rollback()
        throw e
      } finally {
        conn.release()
      }

      const [rows] = await db.execute(
        `SELECT aa.*,
                sc.scene_no,
                sc.title AS scene_title,
                sb.shot_no,
                c.name AS character_name
         FROM audio_assets aa
         LEFT JOIN script_scenes sc ON sc.id = aa.scene_id
         LEFT JOIN storyboards sb ON sb.id = aa.storyboard_id
         LEFT JOIN characters c ON c.id = aa.character_id
         WHERE aa.id = ?
         LIMIT 1`,
        [audioId],
      )
      success(res, audioAssetRow(rows[0]), '音频轨道已确认')
      return
    }

    const audioArchiveMatch = pathname.match(/^\/api\/audio-assets\/(\d+)\/archive$/)
    if (audioArchiveMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return

      const audioId = parseId(audioArchiveMatch[1])
      if (!audioId) {
        fail(res, 4001, '无效的 audioId', 400)
        return
      }

      const [ownRows] = await db.execute(
        `SELECT aa.id, aa.status, p.user_id AS ownerId
         FROM audio_assets aa
         INNER JOIN projects p ON p.id = aa.project_id
         WHERE aa.id = ? LIMIT 1`,
        [audioId],
      )
      const audio = ownRows[0]
      if (!audio || audio.ownerId !== user.id) {
        fail(res, 4004, '音频资产不存在或无权访问', 404)
        return
      }
      if (audio.status === 'confirmed') {
        fail(res, 4001, '已确认主版本不允许直接归档', 400)
        return
      }

      await db.execute(
        `UPDATE audio_assets
         SET status = 'archived'
         WHERE id = ?`,
        [audioId],
      )

      const [rows] = await db.execute(
        `SELECT aa.*,
                sc.scene_no,
                sc.title AS scene_title,
                sb.shot_no,
                c.name AS character_name
         FROM audio_assets aa
         LEFT JOIN script_scenes sc ON sc.id = aa.scene_id
         LEFT JOIN storyboards sb ON sb.id = aa.storyboard_id
         LEFT JOIN characters c ON c.id = aa.character_id
         WHERE aa.id = ?
         LIMIT 1`,
        [audioId],
      )
      success(res, audioAssetRow(rows[0]), '音频候选已归档')
      return
    }

    const audioPlacementMatch = pathname.match(/^\/api\/audio-assets\/(\d+)$/)
    if (audioPlacementMatch && req.method === 'PUT') {
      const user = await authenticate(req, res)
      if (!user) return

      const audioId = parseId(audioPlacementMatch[1])
      const body = await parseBody(req)
      const [audioRows] = await db.execute(
        `SELECT aa.id, aa.project_id, aa.scene_id, aa.storyboard_id,
                p.user_id AS ownerId
         FROM audio_assets aa
         INNER JOIN projects p ON p.id = aa.project_id
         WHERE aa.id = ? LIMIT 1`,
        [audioId],
      )
      const audio = audioRows[0]
      if (!audio || audio.ownerId !== user.id) {
        fail(res, 4004, '音频资产不存在或无权访问', 404)
        return
      }

      let storyboardId = audio.storyboard_id || null
      let sceneId = audio.scene_id || null
      if (body.storyboardId !== undefined) {
        storyboardId = parseId(body.storyboardId) || null
        if (storyboardId) {
          const [storyboardRows] = await db.execute(
            `SELECT s.id, s.scene_id
             FROM storyboards s
             INNER JOIN script_scenes sc ON sc.id = s.scene_id
             WHERE s.id = ? AND sc.project_id = ? LIMIT 1`,
            [storyboardId, audio.project_id],
          )
          if (!storyboardRows[0]) {
            fail(res, 4004, '分镜不存在或不属于当前项目', 404)
            return
          }
          sceneId = storyboardRows[0].scene_id
        }
      }

      const startOffsetSeconds =
        body.startOffsetSeconds === undefined
          ? null
          : Math.max(0, Math.min(60, Number(body.startOffsetSeconds) || 0))
      const sets = ['storyboard_id = ?', 'scene_id = ?']
      const params = [storyboardId, sceneId]
      if (startOffsetSeconds !== null) {
        sets.push('start_offset_seconds = ?')
        params.push(startOffsetSeconds)
      }
      params.push(audioId)
      await db.execute(`UPDATE audio_assets SET ${sets.join(', ')} WHERE id = ?`, params)

      const [rows] = await db.execute(
        `SELECT aa.*,
                sc.scene_no,
                sc.title AS scene_title,
                sb.shot_no,
                c.name AS character_name
         FROM audio_assets aa
         LEFT JOIN script_scenes sc ON sc.id = aa.scene_id
         LEFT JOIN storyboards sb ON sb.id = aa.storyboard_id
         LEFT JOIN characters c ON c.id = aa.character_id
         WHERE aa.id = ? LIMIT 1`,
        [audioId],
      )
      success(res, audioAssetRow(rows[0]), '音频时间线定位已保存')
      return
    }

    const exportDetailMatch = pathname.match(/^\/api\/exports\/(\d+)$/)
    if (exportDetailMatch && req.method === 'GET') {
      const user = await authenticate(req, res)
      if (!user) return

      const exportId = parseId(exportDetailMatch[1])
      if (!exportId) {
        fail(res, 4001, '无效的 exportId', 400)
        return
      }

      const [ownRows] = await db.execute(
        `SELECT er.*, p.user_id AS ownerId
         FROM export_records er
         INNER JOIN projects p ON p.id = er.project_id
         WHERE er.id = ? LIMIT 1`,
        [exportId],
      )
      const record = ownRows[0]
      if (!record || record.ownerId !== user.id) {
        fail(res, 4004, '导出记录不存在或无权访问', 404)
        return
      }

      success(res, exportRecordRow(record))
      return
    }

    if (pathname === '/api/voice-profiles' && req.method === 'GET') {
      const user = await authenticate(req, res)
      if (!user) return
      const profiles = await listActiveVoiceProfiles()
      success(res, {
        items: profiles,
        ageGroups: CHARACTER_AGE_GROUPS,
        genders: CHARACTER_GENDERS,
      })
      return
    }

    const projectVoiceCastMatch = pathname.match(/^\/api\/projects\/(\d+)\/voice-cast$/)
    if (projectVoiceCastMatch && req.method === 'GET') {
      const user = await authenticate(req, res)
      if (!user) return
      const projectId = parseId(projectVoiceCastMatch[1])
      const project = await fetchProjectForUser(projectId, user.id)
      if (!project) {
        fail(res, 4004, '项目不存在或无权访问', 404)
        return
      }
      const [characterRows] = await db.execute(
        `SELECT * FROM characters WHERE project_id = ? AND status <> 'archived' ORDER BY id ASC`,
        [projectId],
      )
      const profiles = await listActiveVoiceProfiles()
      success(res, {
        items: characterRows.map((row) => characterVoiceCastRow(row, profiles)),
      })
      return
    }

    const characterVoiceManagementMatch = pathname.match(
      /^\/api\/characters\/(\d+)\/(voice-recommendations|voice-binding|reference-audio)$/,
    )
    if (characterVoiceManagementMatch) {
      const user = await authenticate(req, res)
      if (!user) return
      const characterId = parseId(characterVoiceManagementMatch[1])
      const action = characterVoiceManagementMatch[2]
      const [ownRows] = await db.execute(
        `SELECT c.*, p.user_id AS ownerId
         FROM characters c
         INNER JOIN projects p ON p.id = c.project_id
         WHERE c.id = ? AND c.status <> 'archived' LIMIT 1`,
        [characterId],
      )
      const ch = ownRows[0]
      if (!ch || ch.ownerId !== user.id) {
        fail(res, 4004, '角色不存在或无权访问', 404)
        return
      }

      if (action === 'voice-recommendations' && req.method === 'GET') {
        const profiles = await listActiveVoiceProfiles()
        const recommendation = recommendVoiceProfiles(ch, profiles, 3)
        success(res, {
          character: characterRow(ch),
          traits: recommendation.traits,
          selectedProfile:
            profiles.find((profile) => profile.profileKey === ch.voice_profile_key) || null,
          items: recommendation.items,
        })
        return
      }

      if (action === 'voice-binding' && req.method === 'PUT') {
        const body = await parseBody(req)
        const profile = await findActiveVoiceProfile(body.voiceProfileKey)
        if (!profile) {
          fail(res, 4001, '请选择有效且可用的音色方案', 400)
          return
        }
        const requestedAgeGroup = body.ageGroup == null
          ? null
          : normalizeCharacterAgeGroup(body.ageGroup)
        const requestedGender = body.gender == null
          ? null
          : normalizeCharacterGender(body.gender)
        if (body.ageGroup != null && !requestedAgeGroup) {
          fail(res, 4001, '角色年龄段无效', 400)
          return
        }
        if (body.gender != null && !requestedGender) {
          fail(res, 4001, '角色声线性别无效', 400)
          return
        }
        const inferred = inferCharacterVoiceTraits(ch)
        const ageGroup = requestedAgeGroup || normalizeCharacterAgeGroup(ch.age_group) || inferred.ageGroup
        const gender = requestedGender || normalizeCharacterGender(ch.gender) || inferred.gender
        const voiceResolution = resolveCharacterVoiceProfile({
          character: { ...ch, gender, age_group: ageGroup },
          profiles: [profile],
          requestedProfileKey: profile.profileKey,
        })
        if (voiceResolution.error) {
          fail(res, 4001, voiceResolution.error, 400)
          return
        }
        const voiceStyle = String(body.voiceStyle ?? ch.voice_style ?? '').trim().slice(0, 160) || null
        const voiceLocked = body.locked !== false
        await db.execute(
          `UPDATE characters
           SET age_group = ?, gender = ?, voice_style = ?, voice_profile_key = ?,
               voice_setting = ?, voice_design_json = NULL, voice_locked = ?, updated_at = NOW()
           WHERE id = ?`,
          [
            ageGroup,
            gender,
            voiceStyle,
            profile.profileKey,
            profile.voiceId,
            voiceLocked ? 1 : 0,
            characterId,
          ],
        )
        const [rows] = await db.execute(`SELECT * FROM characters WHERE id = ? LIMIT 1`, [characterId])
        success(res, {
          character: characterRow(rows[0]),
          selectedProfile: profile,
          traits: inferCharacterVoiceTraits(rows[0]),
        }, voiceLocked ? '角色音色已确认并锁定' : '角色音色方案已保存')
        return
      }

      if (action === 'reference-audio' && req.method === 'PUT') {
        const body = await parseBody(req, 22_000_000)
        const { mimeType, bytes } = decodeAudioDataUrl(body.dataBase64)
        const extension = mimeType.split('/')[1].replace('mpeg', 'mp3').replace('x-wav', 'wav')
        const storageKey = `projects/${ch.project_id}/characters/${characterId}/voice-reference.${extension}`
        const stored = await objectStorage.putObject({
          key: storageKey,
          bytes,
          contentType: mimeType,
        })
        await db.execute(
          `UPDATE characters SET reference_audio_url = ?, reference_audio_storage_key = ?, voice_locked = 1, updated_at = NOW() WHERE id = ?`,
          [stored.url, stored.key, characterId],
        )
        const [rows] = await db.execute(`SELECT * FROM characters WHERE id = ? LIMIT 1`, [characterId])
        success(res, { character: characterRow(rows[0]) }, '参考音频已保存')
        return
      }
    }

    const projectCharactersMatch = pathname.match(/^\/api\/projects\/(\d+)\/characters(\/generate)?$/)
    if (projectCharactersMatch) {
      const user = await authenticate(req, res)
      if (!user) return

      const projectId = parseId(projectCharactersMatch[1])
      if (!projectId) {
        fail(res, 4001, '无效的 projectId', 400)
        return
      }
      // 校验项目归属当前用户
      const [ownRows] = await db.execute(
        `SELECT * FROM projects WHERE id = ? AND user_id = ? LIMIT 1`,
        [projectId, user.id],
      )
      const project = ownRows[0]
      if (!project) {
        fail(res, 4004, '项目不存在或无权访问', 404)
        return
      }

      const isGenerate = Boolean(projectCharactersMatch[2])
      if (req.method === 'POST' && isGenerate) {
        const [outlineRows] = await db.execute(
          `SELECT * FROM story_outlines WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
          [projectId],
        )
        const [sceneRows] = await db.execute(
          `SELECT * FROM script_scenes WHERE project_id = ? ORDER BY sort_order ASC, scene_no ASC, id ASC`,
          [projectId],
        )
        const [storyBibleRows] = await db.execute(
          `SELECT * FROM story_bibles WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
          [projectId],
        )
        const storyBible = storyBibleRows[0] ? storyBibleRow(storyBibleRows[0]) : null
        if (!outlineRows[0] && !sceneRows.some((scene) => String(scene.content || scene.summary || '').trim())) {
          fail(res, 4004, '项目还没有总纲或剧本内容，请先生成故事总纲或单场剧本', 400)
          return
        }

        const aiResult = await aiGenerateCharacters({
          project: {
            name: project.name,
            category: project.category,
            visualStyle: project.visual_style,
            narrativeVision: project.narrative_vision,
          },
          outline: outlineRows[0] || null,
          scenes: sceneRows,
          storyBible,
        })
        if (!aiResult.characters.length) {
          fail(res, 5001, 'AI 没有识别出有效角色，请检查总纲和剧本内容', 502)
          return
        }

        const toSqlNullableText = (value, fallback = null) => {
          if (value === undefined || value === null) return fallback
          const text = String(value).trim()
          return text || fallback
        }
        const normalizeCharacterPayload = (item, index) => ({
          name: toSqlNullableText(item?.name, `角色 ${index + 1}`),
          roleTag: toSqlNullableText(item?.role_tag, index === 0 ? '主角' : '配角'),
          personality: toSqlNullableText(
            item?.personality,
            '性格鲜明，行为动机与剧情目标一致。',
          ),
          appearance: toSqlNullableText(
            item?.appearance,
            '具有清晰可辨的脸部、发型、体态与服装特征。',
          ),
          costume: toSqlNullableText(normalizeCharacterCostume(item), null),
          voiceSetting: toSqlNullableText(item?.voice_setting, null),
          ageGroup: toSqlNullableText(item?.age_group, null),
          gender: toSqlNullableText(item?.gender, null),
          voiceStyle: toSqlNullableText(item?.voice_style, null),
        })
        const safeCharacters = aiResult.characters
          .map((item, index) => normalizeCharacterPayload(item, index))
          .filter((item) => Boolean(item.name))

        const conn = await db.getConnection()
        try {
          await conn.beginTransaction()
          for (const item of safeCharacters) {
            const [existingRows] = await conn.execute(
              `SELECT id FROM characters WHERE project_id = ? AND name = ? ORDER BY id ASC LIMIT 1`,
              [projectId, item.name],
            )
            const existingId = Number(existingRows[0]?.id || 0)
            if (existingId) {
              await conn.execute(
                `UPDATE characters
                 SET role_tag = COALESCE(NULLIF(role_tag, ''), ?),
                     personality = COALESCE(NULLIF(personality, ''), ?),
                     appearance = COALESCE(NULLIF(appearance, ''), ?),
                     costume = COALESCE(NULLIF(costume, ''), ?),
                     voice_setting = COALESCE(NULLIF(voice_setting, ''), ?),
                     age_group = COALESCE(NULLIF(age_group, ''), ?),
                     -- Character extraction is the authoritative script-derived source.
                     -- Persist its normalized gender so an earlier bad parse cannot keep
                     -- poisoning the asset prompt after a re-parse.
                     gender = COALESCE(NULLIF(?, ''), gender),
                     voice_style = COALESCE(NULLIF(voice_style, ''), ?),
                     updated_at = NOW()
                 WHERE id = ?`,
                [
                  item.roleTag,
                  item.personality,
                  item.appearance,
                  item.costume,
                  item.voiceSetting,
                  item.ageGroup,
                  item.gender,
                  item.voiceStyle,
                  existingId,
                ],
              )
            } else {
              await conn.execute(
                `INSERT INTO characters
                  (project_id, name, role_tag, personality, appearance, costume, voice_setting,
                   age_group, gender, voice_style, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
                [
                  projectId,
                  item.name,
                  item.roleTag,
                  item.personality,
                  item.appearance,
                  item.costume,
                  item.voiceSetting,
                  item.ageGroup,
                  item.gender,
                  item.voiceStyle,
                ],
              )
            }
          }
          await archiveStaleCharacterRecords(conn, projectId, safeCharacters)
          await repairNarrativeRoleCharacterRecords(conn, projectId, outlineRows[0] || null, sceneRows)
          await conn.commit()
        } catch (error) {
          await conn.rollback()
          throw error
        } finally {
          conn.release()
        }

        await persistParsedCharacters(
          projectId,
          project,
          outlineRows[0] || null,
          sceneRows,
          aiResult,
        )

        await db.execute(
          `UPDATE storyboards s
           INNER JOIN script_scenes sc ON sc.id = s.scene_id
           INNER JOIN characters c ON c.project_id = sc.project_id AND c.name = s.character_name
           SET s.character_id = c.id
           WHERE sc.project_id = ? AND s.character_id IS NULL`,
          [projectId],
        )
        const [rows] = await db.execute(
          `SELECT * FROM characters WHERE project_id = ? AND status <> 'archived' ORDER BY id ASC`,
          [projectId],
        )
        success(res, { items: rows.map(characterRow) }, '角色档案已生成')
        return
      }

      if (req.method === 'GET' && !isGenerate) {
        const [rows] = await db.execute(
          `SELECT * FROM characters WHERE project_id = ? AND status <> 'archived' ORDER BY id ASC`,
          [projectId],
        )
        success(res, { items: rows.map(characterRow) })
        return
      }

      if (req.method === 'POST' && !isGenerate) {
        const body = await parseBody(req)
        const name = String(body.name || '').trim()
        if (!name) {
          fail(res, 4001, '角色名不能为空', 400)
          return
        }
        if (name.length > 200) {
          fail(res, 4001, '角色名不能超过 200 个字符', 400)
          return
        }
        const [duplicateRows] = await db.execute(
          `SELECT id FROM characters WHERE project_id = ? AND name = ? AND status <> 'archived' LIMIT 1`,
          [projectId, name],
        )
        if (duplicateRows[0]) {
          fail(res, 4009, '当前项目已经存在同名角色', 409)
          return
        }
        const ageGroup = body.ageGroup == null ? null : normalizeCharacterAgeGroup(body.ageGroup)
        const gender = body.gender == null ? null : normalizeCharacterGender(body.gender)
        if (body.ageGroup != null && !ageGroup) {
          fail(res, 4001, '角色年龄段无效', 400)
          return
        }
        if (body.gender != null && !gender) {
          fail(res, 4001, '角色声线性别无效', 400)
          return
        }
        const [result] = await db.execute(
          `INSERT INTO characters
            (project_id, name, role_tag, personality, appearance, voice_setting,
             age_group, gender, voice_style, reference_image_url, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            projectId,
            name,
            body.roleTag ? String(body.roleTag).trim() : null,
            body.personality != null ? String(body.personality) : null,
            body.appearance != null ? String(body.appearance) : null,
            body.voiceSetting != null ? String(body.voiceSetting) : null,
            ageGroup,
            gender,
            String(body.voiceStyle || '').trim().slice(0, 160) || null,
            body.referenceImageUrl != null ? String(body.referenceImageUrl) : null,
            'draft',
          ],
        )
        const newId = Number(result.insertId)
        const [rows] = await db.execute(
          `SELECT * FROM characters WHERE id = ? LIMIT 1`,
          [newId],
        )
        success(res, characterRow(rows[0]), '角色已创建')
        return
      }
    }

    const characterImageConfirmMatch = pathname.match(/^\/api\/character-images\/(\d+)\/confirm$/)
    if (characterImageConfirmMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return

      const imageId = parseId(characterImageConfirmMatch[1])
      const [ownRows] = await db.execute(
        `SELECT ci.*, c.project_id, p.user_id AS ownerId
         FROM character_images ci
         INNER JOIN characters c ON c.id = ci.character_id
         INNER JOIN projects p ON p.id = c.project_id
         WHERE ci.id = ? AND c.status <> 'archived' LIMIT 1`,
        [imageId],
      )
      const image = ownRows[0]
      if (!image || image.ownerId !== user.id) {
        fail(res, 4004, '角色定妆图不存在或无权访问', 404)
        return
      }

      const conn = await db.getConnection()
      try {
        await conn.beginTransaction()
        await conn.execute(
          `UPDATE character_images
           SET status = 'candidate', confirmed_at = NULL
           WHERE character_id = ? AND status = 'confirmed'`,
          [image.character_id],
        )
        await conn.execute(
          `UPDATE character_images SET status = 'confirmed', confirmed_at = NOW() WHERE id = ?`,
          [imageId],
        )
        await conn.execute(
          `UPDATE characters
           SET reference_image_url = ?, reference_image_storage_key = ?, status = 'finalized', updated_at = NOW()
           WHERE id = ?`,
          [image.image_url, image.storage_key || null, image.character_id],
        )
        await conn.commit()
      } catch (error) {
        await conn.rollback()
        throw error
      } finally {
        conn.release()
      }
      const [rows] = await db.execute(`SELECT * FROM character_images WHERE id = ? LIMIT 1`, [imageId])
      success(res, characterImageRow(rows[0]), '角色定妆图已确认')
      return
    }

    const characterRenamePreviewMatch = pathname.match(
      /^\/api\/characters\/(\d+)\/rename-preview$/,
    )
    if (characterRenamePreviewMatch && req.method === 'POST') {
      const user = await authenticate(req, res)
      if (!user) return

      const characterId = parseId(characterRenamePreviewMatch[1])
      const body = await parseBody(req)
      const newName = String(body.name || '').trim()
      if (!characterId || !newName) {
        fail(res, 4001, '角色名不能为空', 400)
        return
      }
      if (newName.length > 200) {
        fail(res, 4001, '角色名不能超过 200 个字符', 400)
        return
      }

      const [ownRows] = await db.execute(
        `SELECT c.*, p.user_id AS ownerId
         FROM characters c
         INNER JOIN projects p ON p.id = c.project_id
         WHERE c.id = ? AND c.status <> 'archived' LIMIT 1`,
        [characterId],
      )
      const ch = ownRows[0]
      if (!ch || ch.ownerId !== user.id) {
        fail(res, 4004, '角色不存在或无权访问', 404)
        return
      }

      const [duplicateRows] = await db.execute(
        `SELECT id FROM characters WHERE project_id = ? AND name = ? AND id <> ? AND status <> 'archived' LIMIT 1`,
        [ch.project_id, newName, characterId],
      )
      if (duplicateRows[0]) {
        fail(res, 4009, '当前项目已经存在同名角色，请使用其他名字', 409)
        return
      }

      const plan = await buildCharacterRenamePlan(db, ch, newName)
      success(res, plan.impact)
      return
    }

    const characterFeatureMatch = pathname.match(
      /^\/api\/characters\/(\d+)\/(generate-profile|images(?:\/generate)?|voice-preview)$/,
    )
    if (characterFeatureMatch) {
      const user = await authenticate(req, res)
      if (!user) return

      const characterId = parseId(characterFeatureMatch[1])
      const feature = characterFeatureMatch[2]
      const [ownRows] = await db.execute(
        `SELECT c.*, p.user_id AS ownerId, p.name AS project_name, p.category AS project_category,
                p.narrative_vision AS project_narrative_vision, p.visual_style AS project_visual_style
         FROM characters c
         INNER JOIN projects p ON p.id = c.project_id
         WHERE c.id = ? AND c.status <> 'archived' LIMIT 1`,
        [characterId],
      )
      const ch = ownRows[0]
      if (!ch || ch.ownerId !== user.id) {
        fail(res, 4004, '角色不存在或无权访问', 404)
        return
      }

      if (feature === 'generate-profile' && req.method === 'POST') {
        const [sceneRows] = await db.execute(
          `SELECT * FROM script_scenes WHERE project_id = ? ORDER BY sort_order ASC, scene_no ASC, id ASC`,
          [ch.project_id],
        )
        const profile = await aiGenerateCharacterProfile({
          character: ch,
          project: {
            name: ch.project_name,
            category: ch.project_category,
            visualStyle: ch.project_visual_style,
            narrativeVision: ch.project_narrative_vision,
          },
          scenes: sceneRows,
        })
        await db.execute(
          `UPDATE characters
           SET role_tag = ?, personality = ?, appearance = ?, age_group = ?, gender = ?,
               voice_style = ?, voice_locked = 0, updated_at = NOW()
           WHERE id = ?`,
          [
            profile.role_tag,
            profile.personality,
            profile.appearance,
            profile.age_group,
            profile.gender,
            profile.voice_style,
            characterId,
          ],
        )
        const [rows] = await db.execute(`SELECT * FROM characters WHERE id = ? LIMIT 1`, [characterId])
        success(res, characterRow(rows[0]), '角色档案已补全')
        return
      }

      if (feature === 'images' && req.method === 'GET') {
        const [rows] = await db.execute(
          `SELECT * FROM character_images WHERE character_id = ? ORDER BY version_no DESC, id ASC`,
          [characterId],
        )
        success(res, { items: rows.map(characterImageRow) })
        return
      }

      if (feature === 'images/generate' && req.method === 'POST') {
        const body = await parseBody(req)
        try {
          const job = await enqueueCharacterImageJob(user.id, characterId, body)
          if (!job) {
            fail(res, 4004, '角色不存在或无权访问', 404)
            return
          }
          success(res, job, '角色定妆图生成任务已提交')
        } catch (error) {
          fail(res, 4011, error instanceof Error ? error.message : '角色定妆图任务提交失败', error?.statusCode || 400)
        }
        return

        /* legacy synchronous generation path retained temporarily */
        if (!String(ch.appearance || '').trim()) {
          fail(res, 4004, '角色缺少外观设定，请先填写或使用 AI 补全角色档案', 400)
          return
        }
        const frameConfig = getFrameConfig()
        const candidateCount = Math.max(1, Math.min(3, parseId(body.candidateCount) || 1))
        const modelName = String(body.modelName || frameConfig.defaultModel).trim()
        const [versionRows] = await db.execute(
          `SELECT COALESCE(MAX(version_no), 0) AS maxVersion
           FROM character_images WHERE character_id = ?`,
          [characterId],
        )
        const nextVersion = Number(versionRows[0]?.maxVersion || 0) + 1
        const promptSnapshot = [
          String(body.prompt || '').trim(),
          ch.name,
          ch.role_tag,
          ch.personality,
          ch.appearance,
          ch.project_visual_style,
        ].filter(Boolean).join('，')

        let candidates
        if (isMockFrameProvider(frameConfig)) {
          candidates = Array.from({ length: candidateCount }, (_, index) => {
            const imageUrl = buildMockImageUrl(900000000 + characterId, index, nextVersion)
            return {
              imageUrl,
              thumbnailUrl: imageUrl,
              promptSnapshot,
              modelName: 'mock-frame-v1',
            }
          })
        } else {
          try {
            candidates = await generateCharacterImageCandidates({
              characterId,
              versionNo: nextVersion,
              character: {
                name: ch.name,
                roleTag: ch.role_tag,
                personality: ch.personality,
                appearance: ch.appearance,
              },
              projectVisualStyle: ch.project_visual_style,
              prompt: body.prompt,
              modelName,
              publicBaseUrl: buildGeneratedFramePublicBaseUrl(),
              outputDir: GENERATED_FRAME_DIR,
              candidateCount,
              referenceImageUrls: resolveCharacterReferenceImageUrls(
                ch.reference_image_url ? [ch.reference_image_url] : [],
              ),
            })
          } catch (frameError) {
            console.error('[character-image] real provider failed', frameError)
            const providerDetail = String(frameError?.message || 'unknown provider error')
              .replace(/sk-[A-Za-z0-9._-]+/g, '[redacted]')
              .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
              .slice(0, 300)
            fail(res, 5020, `角色定妆图生成失败：${providerDetail}`, 502)
            return
          }
        }

        const insertedIds = []
        for (const candidate of candidates) {
          const [result] = await db.execute(
            `INSERT INTO character_images
              (character_id, version_no, image_url, thumbnail_url, prompt_snapshot, model_name, status)
             VALUES (?, ?, ?, ?, ?, ?, 'candidate')`,
            [
              characterId,
              nextVersion,
              candidate.imageUrl,
              candidate.thumbnailUrl,
              candidate.promptSnapshot || promptSnapshot,
              candidate.modelName || modelName,
            ],
          )
          insertedIds.push(Number(result.insertId))
        }
        const placeholders = insertedIds.map(() => '?').join(', ')
        const [rows] = await db.execute(
          `SELECT * FROM character_images WHERE id IN (${placeholders}) ORDER BY id ASC`,
          insertedIds,
        )
        success(res, { items: rows.map(characterImageRow) }, '角色定妆图候选已生成')
        return
      }

      if (feature === 'voice-preview' && req.method === 'POST') {
        const body = await parseBody(req)
        const audioConfig = getAudioConfig()
        const isVoiceDesignRequest = body.voiceAgent === true
        let voiceDesign = body.voiceDesign && typeof body.voiceDesign === 'object'
          ? normalizeVoiceDesign(body.voiceDesign)
          : null
        const persistedVoiceDesign = safeJsonParse(ch.voice_design_json, null)
        const lockedCustomVoiceDesign = ch.voice_locked
          ? resolvePersistedCustomVoiceDesign(ch, ch.voice_setting)
          : null
        if (!voiceDesign && lockedCustomVoiceDesign && !isVoiceDesignRequest) {
          voiceDesign = lockedCustomVoiceDesign
        }
        const isCustomVoiceCandidateBinding = Boolean(
          body.bindReferenceAudio === true
          && String(body.voiceId || '')
          && resolvePersistedCustomVoiceDesign(ch, body.voiceId),
        )
        if (isCustomVoiceCandidateBinding) voiceDesign = persistedVoiceDesign
        let customVoice = null
        let voiceSceneTitle = ''
        let voiceSceneContext = ''
        if (isVoiceDesignRequest) {
          if (isMockAudioProvider(audioConfig)) {
            fail(res, 5030, '当前音频服务处于模拟模式，无法创建真实角色音色；请切换到 DashScope 音频服务', 503)
            return
          }
          const [sceneRows] = await db.execute(
            `SELECT scene_no, title, summary, content, mood, location, time_of_day
             FROM script_scenes
             WHERE project_id = ?
             ORDER BY sort_order ASC, scene_no ASC, id ASC`,
            [ch.project_id],
          )
          const previewScene = sceneRows[0] || {}
          voiceSceneTitle = String(previewScene.title || '').trim()
          voiceSceneContext = [previewScene.location, previewScene.time_of_day, previewScene.summary, previewScene.mood]
            .filter(Boolean).join('，')
          voiceDesign = await aiGenerateVoiceDesign({
            project: {
              name: ch.project_name,
              category: ch.project_category,
              visualStyle: ch.project_visual_style,
              narrativeVision: ch.project_narrative_vision,
            },
            character: ch,
            scenes: sceneRows,
            sampleText: body.text,
          })
          const genderLabel = ch.gender === 'male' ? '男性' : ch.gender === 'female' ? '女性' : '中性'
          voiceDesign.ageAndGender = `${genderLabel}声线；设计必须符合角色已确定的性别与年龄感`
          const voicePrompt = [voiceDesign.ageAndGender, voiceDesign.timbre, voiceDesign.summary,
            voiceDesign.performanceInstructions, voiceDesign.rhythm].filter(Boolean).join('；').slice(0, 500)
          let previewText = String(body.text || voiceDesign.sampleText || '').trim()
          if (previewText.length < 15) {
            previewText = `${previewText}${previewText ? '。' : ''}我给过你机会，现在把你知道的都说出来。`
          }
          if (previewText.length > 200) previewText = previewText.slice(0, 200)
          customVoice = await createQwenDesignedVoice({
            apiKey: audioConfig.apiKey,
            targetModel: audioConfig.voiceDesignModel,
            voicePrompt,
            previewText,
            prefix: `char${characterId}`,
          })
          voiceDesign = {
            ...voiceDesign,
            provider: 'qwen',
            model: 'voice-enrollment',
            voiceId: customVoice.voiceId,
            targetModel: customVoice.targetModel,
            status: 'ready',
            requestId: customVoice.requestId,
            voicePrompt,
            generationSource: voiceDesign.generationSource || 'agent',
          }
          await db.execute(
            `UPDATE characters
             SET voice_design_json = ?, voice_setting = ?, voice_profile_key = NULL,
                 voice_locked = 0, updated_at = NOW()
             WHERE id = ?`,
            [JSON.stringify(voiceDesign), customVoice.voiceId, characterId],
          )
        }
        const voiceResolution = resolveCharacterVoiceProfile({
          character: ch,
          profiles: await listActiveVoiceProfiles(),
          requestedProfileKey: isVoiceDesignRequest || isCustomVoiceCandidateBinding
            ? ''
            : body.voiceProfileKey || ch.voice_profile_key || '',
        })
        if (!isVoiceDesignRequest && !isCustomVoiceCandidateBinding && voiceResolution.error) {
          fail(res, 4001, voiceResolution.error, 400)
          return
        }
        const voiceProfile = voiceResolution.profile
        const text = isVoiceDesignRequest
          ? buildVoicePreviewText({
            characterName: ch.name,
            sampleText: body.text || voiceDesign?.sampleText,
            sceneTitle: voiceSceneTitle,
          })
          : String(body.text || voiceDesign?.sampleText || `我是${ch.name}。故事已经开始，我会做出自己的选择。`).trim()
        const voiceName = String(
          customVoice?.voiceId
            || (isCustomVoiceCandidateBinding ? persistedVoiceDesign.voiceId : '')
            || lockedCustomVoiceDesign?.voiceId
            || voiceProfile?.voiceId
            || '',
        ).trim()
        const modelName = String(
          customVoice?.targetModel || (isCustomVoiceCandidateBinding ? persistedVoiceDesign.targetModel : '')
            || lockedCustomVoiceDesign?.targetModel
            || voiceProfile?.modelName || body.modelName || audioConfig.defaultModel,
        ).trim()
        const instructions = [
          voiceProfile?.instructions,
          ch.voice_style,
          String(body.voiceStyle || '').trim(),
          voiceDesign
            ? buildVoicePerformanceInstructions({
              design: voiceDesign,
              characterName: ch.name,
              sceneContext: voiceSceneContext,
              dialogueText: body.text || voiceDesign.sampleText,
            })
            : '',
        ].filter(Boolean).join('；') || null
        if (isMockAudioProvider(audioConfig)) {
          if (isVoiceDesignRequest) {
            fail(res, 5020, '当前音频服务处于模拟模式，不能创建真实自定义音色；请配置 DashScope 音频服务后重试', 503)
            return
          }
          success(res, {
            audioUrl: buildMockAudioUrl(ch.project_id, 'voice-preview', 1, 1, { characterId }),
            durationSeconds: 4,
            voiceName,
            modelName: 'mock-audio-v2',
            voiceProfileKey: voiceProfile?.profileKey || null,
            voiceProfileName: voiceProfile?.displayName || null,
            voiceProfileGender: voiceProfile?.gender || null,
            voiceDesign,
            referenceAudioBound: false,
          }, '音色试听已生成')
          return
        }
        try {
          let candidate
          const previewAudioUrl = String(body.previewAudioUrl || '').trim()
          if (customVoice) {
            const bytes = Buffer.from(customVoice.previewAudioData.replace(/^data:audio\/[^;]+;base64,/i, ''), 'base64')
            if (!bytes.length) throw new Error('Qwen voice design returned an empty preview audio file')
            const fileName = `audio-${ch.project_id}-voice-preview-${characterId}-${Date.now()}-${randomUUID().slice(0, 8)}.wav`
            const filePath = path.join(GENERATED_AUDIO_DIR, fileName)
            await mkdir(GENERATED_AUDIO_DIR, { recursive: true })
            await writeFile(filePath, bytes)
            candidate = {
              audioUrl: `${buildRequestGeneratedAudioBaseUrl(req)}/${fileName}`,
              filePath,
              durationSeconds: null,
              voiceName,
              modelName,
              voiceProfileKey: null,
              voiceInstructions: instructions,
            }
          } else if (body.bindReferenceAudio === true && previewAudioUrl) {
            const parsedPreviewUrl = new URL(previewAudioUrl, 'http://local-preview')
            const fileName = path.basename(parsedPreviewUrl.pathname)
            const isLocalGeneratedAudio = parsedPreviewUrl.pathname.startsWith('/generated/audio/')
              && fileName === parsedPreviewUrl.pathname.split('/').pop()
              && /^[A-Za-z0-9._-]+$/.test(fileName)
            const filePath = path.join(GENERATED_AUDIO_DIR, fileName)
            if (isCustomVoiceCandidateBinding && (!fileName || fileName.includes('..'))) {
              fail(res, 4001, '自定义音色候选试听地址无效，请重新生成试听', 400)
              return
            }
            if (!isLocalGeneratedAudio || !(await fileExists(filePath))) {
              fail(res, 4001, '试听音频已失效，请重新生成声音 Agent 试听', 400)
              return
            }
            candidate = {
              audioUrl: previewAudioUrl,
              filePath,
              durationSeconds: null,
              voiceName,
              modelName,
              voiceProfileKey: voiceProfile?.profileKey || null,
              voiceInstructions: instructions,
            }
          } else {
            ;[candidate] = await generateAudioCandidates({
              projectId: ch.project_id,
              trackType: 'voice-preview',
              versionNo: Math.floor(Date.now() / 1000),
              text,
              voiceName,
              modelName,
              instructions,
              publicBaseUrl: buildRequestGeneratedAudioBaseUrl(req),
              outputDir: GENERATED_AUDIO_DIR,
              candidateCount: 1,
              allowModelFallback: !voiceDesign?.voiceId,
            })
          }
          let referenceAudioUrl = null
          if (body.bindReferenceAudio === true && candidate.filePath) {
            const bytes = await readFile(candidate.filePath)
            const extension = path.extname(candidate.filePath).toLowerCase() || '.wav'
            const stored = await objectStorage.putObject({
              key: `projects/${ch.project_id}/characters/${characterId}/voice-agent-reference-${Date.now()}${extension}`,
              bytes,
              contentType: extension === '.mp3' ? 'audio/mpeg' : 'audio/wav',
            })
            referenceAudioUrl = stored.url
            if (!voiceDesign) {
              fail(res, 4001, '声音 Agent 设计已失效，请重新生成试听后再确认绑定', 409)
              return
            }
            const isCustomVoiceBinding = isCustomVoiceCandidateBinding
              && voiceDesign?.provider === 'qwen'
              && String(body.voiceId || '') === String(voiceDesign.voiceId || '')
              && String(voiceDesign.targetModel || '') === modelName
            if (isCustomVoiceBinding) {
              await db.execute(
                `UPDATE characters
                 SET reference_audio_url = ?, reference_audio_storage_key = ?,
                     voice_design_json = ?, voice_profile_key = NULL, voice_setting = ?,
                     voice_style = ?, voice_locked = 1, updated_at = NOW()
                 WHERE id = ?`,
                [
                  referenceAudioUrl,
                  stored.key,
                  JSON.stringify(voiceDesign),
                  voiceDesign.voiceId,
                  String(body.voiceStyle || ch.voice_style || '').trim().slice(0, 160) || null,
                  characterId,
                ],
              )
            } else {
              await db.execute(
              `UPDATE characters
               SET reference_audio_url = ?, reference_audio_storage_key = ?,
                   voice_design_json = ?, voice_profile_key = ?, voice_setting = ?,
                   voice_style = ?, voice_locked = 1, updated_at = NOW()
               WHERE id = ?`,
              [
                referenceAudioUrl,
                stored.key,
                JSON.stringify(voiceDesign),
                voiceProfile.profileKey,
                voiceProfile.voiceId,
                String(body.voiceStyle || ch.voice_style || '').trim().slice(0, 160) || null,
                characterId,
              ],
              )
            }
          }
          const [updatedCharacterRows] = referenceAudioUrl || customVoice
            ? await db.execute('SELECT * FROM characters WHERE id = ? LIMIT 1', [characterId])
            : [null]
          success(res, {
            ...candidate,
            voiceProfileKey: voiceProfile?.profileKey || null,
            voiceProfileName: voiceProfile?.displayName || null,
            voiceProfileGender: voiceProfile?.gender || null,
            voiceDesign,
            voiceId: customVoice?.voiceId || voiceDesign?.voiceId || voiceProfile?.voiceId || null,
            referenceAudioUrl,
            referenceAudioBound: Boolean(referenceAudioUrl),
            character: updatedCharacterRows?.[0] ? characterRow(updatedCharacterRows[0]) : null,
          }, '音色试听已生成')
        } catch (audioError) {
          const providerDetail = String(audioError?.message || 'unknown provider error')
            .replace(/sk-[A-Za-z0-9._-]+/g, '[redacted]')
            .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
            .slice(0, 300)
          fail(res, 5020, `音色试听生成失败：${providerDetail}`, 502)
        }
        return
      }
    }

    // 角色库：单角色详情（GET） / 更新（PUT）
    const characterMatch = pathname.match(/^\/api\/characters\/(\d+)$/)
    if (characterMatch) {
      const user = await authenticate(req, res)
      if (!user) return

      const characterId = parseId(characterMatch[1])
      if (!characterId) {
        fail(res, 4001, '无效的 characterId', 400)
        return
      }

      // 校验归属
      const [ownRows] = await db.execute(
        `SELECT c.*, p.user_id AS ownerId
         FROM characters c
         INNER JOIN projects p ON p.id = c.project_id
         WHERE c.id = ? AND c.status <> 'archived' LIMIT 1`,
        [characterId],
      )
      const ch = ownRows[0]
      if (!ch || ch.ownerId !== user.id) {
        fail(res, 4004, '角色不存在或无权访问', 404)
        return
      }

      if (req.method === 'GET') {
        success(res, characterRow(ch))
        return
      }

      if (req.method === 'DELETE') {
        await db.execute(
          `UPDATE characters
           SET status = 'archived', voice_locked = 0, updated_at = NOW()
           WHERE id = ?`,
          [characterId],
        )
        success(res, { success: true }, '角色已删除')
        return
      }

      if (req.method === 'PUT') {
        const body = await parseBody(req)
        const requestedName = body.name === undefined ? String(ch.name || '').trim() : String(body.name || '').trim()
        if (!requestedName) {
          fail(res, 4001, '角色名不能为空', 400)
          return
        }
        if (requestedName.length > 200) {
          fail(res, 4001, '角色名不能超过 200 个字符', 400)
          return
        }
        const isRename = requestedName !== String(ch.name || '').trim()
        if (isRename && typeof body.syncNameReferences !== 'boolean') {
          fail(res, 4001, '修改角色名时必须明确是否同步项目文本', 400)
          return
        }

        const ageGroup = body.ageGroup === undefined
          ? undefined
          : body.ageGroup === null || body.ageGroup === ''
            ? null
            : normalizeCharacterAgeGroup(body.ageGroup)
        const gender = body.gender === undefined
          ? undefined
          : body.gender === null || body.gender === ''
            ? null
            : normalizeCharacterGender(body.gender)
        if (body.ageGroup !== undefined && body.ageGroup !== null && body.ageGroup !== '' && !ageGroup) {
          fail(res, 4001, '角色年龄段无效', 400)
          return
        }
        if (body.gender !== undefined && body.gender !== null && body.gender !== '' && !gender) {
          fail(res, 4001, '角色声线性别无效', 400)
          return
        }
        const voiceStyle = body.voiceStyle === undefined
          ? undefined
          : String(body.voiceStyle || '').trim().slice(0, 160) || null
        const voiceTraitsChanged =
          (ageGroup !== undefined && ageGroup !== (ch.age_group || null)) ||
          (gender !== undefined && gender !== (ch.gender || null)) ||
          (voiceStyle !== undefined && voiceStyle !== (ch.voice_style || null))

        const allowed = {
          name: body.name === undefined ? undefined : requestedName,
          roleTag: body.roleTag,
          personality: body.personality,
          appearance: body.appearance,
          voiceSetting: body.voiceSetting,
          ageGroup,
          gender,
          voiceStyle,
          voiceLocked: voiceTraitsChanged ? 0 : undefined,
          referenceImageUrl: body.referenceImageUrl,
          status: body.status,
        }
        const connection = await db.getConnection()
        let renamePlan = null
        try {
          await connection.beginTransaction()
          const [lockedRows] = await connection.execute(
            `SELECT c.*, p.user_id AS ownerId
             FROM characters c
             INNER JOIN projects p ON p.id = c.project_id
             WHERE c.id = ? AND c.status <> 'archived' LIMIT 1 FOR UPDATE`,
            [characterId],
          )
          const lockedCharacter = lockedRows[0]
          if (!lockedCharacter || lockedCharacter.ownerId !== user.id) {
            throw new Error('角色不存在或无权访问')
          }

          if (isRename) {
            const [duplicateRows] = await connection.execute(
              `SELECT id FROM characters
               WHERE project_id = ? AND name = ? AND id <> ?
               LIMIT 1`,
              [lockedCharacter.project_id, requestedName, characterId],
            )
            if (duplicateRows[0]) {
              const duplicateError = new Error('当前项目已经存在同名角色，请使用其他名字')
              duplicateError.code = 'CHARACTER_NAME_CONFLICT'
              throw duplicateError
            }
          }
          if (body.syncNameReferences) {
            renamePlan = await buildCharacterRenamePlan(connection, lockedCharacter, requestedName)
          }

          const sets = []
          const params = []
          for (const [key, value] of Object.entries(allowed)) {
            if (value === undefined) continue
            const column = {
              name: 'name',
              roleTag: 'role_tag',
              personality: 'personality',
              appearance: 'appearance',
              voiceSetting: 'voice_setting',
              ageGroup: 'age_group',
              gender: 'gender',
              voiceStyle: 'voice_style',
              voiceLocked: 'voice_locked',
              referenceImageUrl: 'reference_image_url',
              status: 'status',
            }[key]
            sets.push(`${column} = ?`)
            params.push(value === null ? null : value)
          }
          if (sets.length) {
            params.push(characterId)
            await connection.execute(
              `UPDATE characters SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`,
              params,
            )
          }
          if (renamePlan) {
            await applyCharacterRenamePlan(connection, renamePlan, characterId)
          }
          await connection.commit()
        } catch (error) {
          await connection.rollback()
          if (error?.code === 'CHARACTER_NAME_CONFLICT') {
            fail(res, 4009, error.message, 409)
            return
          }
          throw error
        } finally {
          connection.release()
        }

        const [rows] = await db.execute(
          `SELECT * FROM characters WHERE id = ? LIMIT 1`,
          [characterId],
        )
        success(
          res,
          characterRow(rows[0]),
          renamePlan ? '角色名及项目文本已同步更新' : '角色已保存',
        )
        return
      }
    }

    fail(res, 4040, '接口不存在', 404)
  } catch (error) {
    console.error('[auth-server]', error)
    fail(res, 5001, error instanceof Error ? error.message : 'server error', 500)
  }
})

const isWorkerRuntime = appRuntimeRole.role === 'worker'

if (isWorkerRuntime) {
  console.log('[worker] Worker runtime started; HTTP server disabled.')
  void recoverGenerationJobs().catch((error) => console.error('[worker] generation recovery failed', error))
  void recoverInterruptedAgentPipelines(db)
    .then(resumeQueuedAgentPipelines)
    .catch((error) => console.error('[worker] agent pipeline recovery failed', error))
  void resumeExportJobs().catch((error) => console.error('[worker] export recovery failed', error))
} else {
  server.on('error', (error) => {
    if (error?.code === 'EADDRINUSE') {
      console.error(
        `[auth-server] 端口 ${PORT} 已被占用，当前实例不会启动。请先停止占用该端口的旧 Node 进程，或设置 PORT 使用其他端口。`,
      )
      process.exit(1)
      return
    }
    console.error('[auth-server] 无法启动 HTTP 服务', error)
    process.exitCode = 1
  })

  server.listen(PORT, () => {
    process.env.PROJECTDREAM_SERVER_STARTED_AT = new Date().toISOString()
    console.log(`Auth server is running at http://localhost:${PORT}`)
    console.log(`Database: mysql://${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}`)
    console.log(`SMS provider: ${smsRuntime.provider}`)
    console.log(`SMS ready: ${smsRuntime.ready} (${smsRuntime.reason})`)
    console.log(`Demo account: ${DEMO_PHONE}`)
    void recoverGenerationJobs().catch((error) => console.error('[auth-server] generation recovery failed', error))
    void resumeExportJobs().catch((error) => console.error('[auth-server] export recovery failed', error))
  })
}

const queuedGenerationJobSweep = setInterval(() => void resumeQueuedGenerationJobs(), 15000)
queuedGenerationJobSweep.unref()

if (isWorkerRuntime) {
  const pipelineQueueSweep = setInterval(() => {
    void resumeQueuedAgentPipelines().catch((error) => console.error('[worker] agent pipeline queue scan failed', error))
  }, appRuntimeRole.queuePollIntervalMs)
  pipelineQueueSweep.unref()

  startExportQueueSweep({
    sweep: resumeExportJobs,
    intervalMs: appRuntimeRole.queuePollIntervalMs,
    onError: (error) => console.error('[worker] export queue scan failed', error),
  })
}
