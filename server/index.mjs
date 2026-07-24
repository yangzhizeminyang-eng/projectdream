import { createHash, randomInt, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { URL } from 'node:url'
import mysql from 'mysql2/promise'
import tencentcloud from 'tencentcloud-sdk-nodejs'

import { generateOutline as aiGenerateOutline } from './services/ai/outline.mjs'
import { getAiConfig } from './services/ai/config.mjs'
import { generateStructuredJson } from './services/ai/provider.mjs'
import { rewriteFrameVisualPrompt } from './services/ai/frame-prompt.mjs'
import { generateSceneScript as aiGenerateSceneScript } from './services/ai/script.mjs'
import { generateStoryboards as aiGenerateStoryboards } from './services/ai/storyboard.mjs'
import {
  generateCharacters as aiGenerateCharacters,
  generateCharacterProfile as aiGenerateCharacterProfile,
} from './services/ai/characters.mjs'
import {
  generateCharacterImageCandidates,
  generateFrameCandidates,
  assertFrameReferenceImageSupport,
  getFrameConfig,
  isMockFrameProvider,
} from './services/frame.mjs'
import {
  buildFrameConsistencyPrompt,
  createFrameCharacterSnapshot,
  resolveFrameCharacterContext,
} from './services/frame-character-consistency.mjs'
import {
  generateVideoCandidates,
  getVideoConfig,
  isMockVideoProvider,
  resolveVideoImageInput,
} from './services/video.mjs'
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
  waitForLipSyncVideoTask,
  waitForPrivateAvatarAsset,
} from './services/lip-sync.mjs'
import { generateAudioCandidates, getAudioConfig, isMockAudioProvider } from './services/audio.mjs'
import { extractSpokenDialogue } from './services/audio-dialogue.mjs'
import {
  buildAudioSourceTitle,
  isMalformedAudioTitle,
  resolveAudioSourceTitle,
} from './services/audio-title.mjs'
import { buildMediaCompleteness } from './services/export-validation.mjs'
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
  normalizeCharacterAgeGroup,
  normalizeCharacterGender,
  recommendVoiceProfiles,
  voiceProfileRow,
} from './services/voice-profiles.mjs'

const require = createRequire(import.meta.url)
const Dypnsapi20170525 = require('@alicloud/dypnsapi20170525')
const OpenApi = require('@alicloud/openapi-client')
const { SendSmsVerifyCodeRequest } = require('@alicloud/dypnsapi20170525')

const PORT = Number(process.env.PORT || 3001)
const CODE_TTL_SECONDS = 5 * 60
const DEFAULT_ALIYUN_SIGN_NAME = '恒创联众'
const LEGACY_ALIYUN_SIGN_NAME_ALIASES = new Set(['鎭掑垱鑱斾紬', '\u93ad\u6391\u57b1\u9471\u65be\u7d2c'])

const DB_HOST = process.env.DB_HOST || '127.0.0.1'
const DB_PORT = Number(process.env.DB_PORT || 3306)
const DB_USER = process.env.DB_USER || 'root'
const DB_PASSWORD = process.env.DB_PASSWORD || ''
const DB_NAME = process.env.DB_NAME || 'projectdream'
const DEMO_PHONE = '13912345678'
const DEMO_NICKNAME = '测试用户'
const DEMO_PASSWORD = '123456'
const GENERATED_FRAME_DIR = path.join(process.cwd(), '.codex-runtime', 'generated-frames')
const GENERATED_AUDIO_DIR = path.join(process.cwd(), '.codex-runtime', 'generated-audio')
const GENERATED_VIDEO_DIR = path.join(process.cwd(), '.codex-runtime', 'generated-videos')
const GENERATED_EXPORT_DIR = path.join(process.cwd(), '.codex-runtime', 'exports')
const FFMPEG_BIN = String(process.env.FFMPEG_BIN || 'ffmpeg').trim() || 'ffmpeg'
const FFPROBE_BIN = String(process.env.FFPROBE_BIN || 'ffprobe').trim() || 'ffprobe'

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
  { key: 'AI_FALLBACK_TO_MOCK', group: 'text', label: '文本失败回退 mock', type: 'boolean' },

  { key: 'FRAME_PROVIDER', group: 'frame', label: '图片服务商', type: 'select', options: ['bigmodel', 'zhipu', 'toapi', 'agnes', 'trae-url', 'mock'] },
  { key: 'FRAME_BASE_URL', group: 'frame', label: '图片接口地址', type: 'text' },
  { key: 'FRAME_API_KEY', group: 'frame', label: '图片接口密钥', type: 'secret' },
  { key: 'BIGMODEL_API_KEY', group: 'frame', label: '智谱接口密钥', type: 'secret' },
  { key: 'FRAME_MODEL', group: 'frame', label: '静帧默认模型', type: 'text' },
  { key: 'FRAME_FALLBACK_MODELS', group: 'frame', label: '静帧备用模型链', type: 'text' },
  { key: 'FRAME_IMAGE_SIZE', group: 'frame', label: '静帧尺寸', type: 'text' },
  { key: 'FRAME_IMAGE_RATIO', group: 'frame', label: '静帧比例', type: 'select', options: ['16:9', '9:16', '1:1'] },
  { key: 'FRAME_FALLBACK_TO_MOCK', group: 'frame', label: '图片失败回退 mock', type: 'boolean' },

  { key: 'VIDEO_PROVIDER', group: 'video', label: '视频服务商', type: 'select', options: ['bigmodel', 'zhipu', 'agnes', 'mock'] },
  { key: 'VIDEO_BASE_URL', group: 'video', label: '视频接口地址', type: 'text' },
  { key: 'VIDEO_API_KEY', group: 'video', label: '视频接口密钥', type: 'secret' },
  { key: 'VIDEO_MODEL', group: 'video', label: '图生视频模型', type: 'text' },
  { key: 'VIDEO_SIZE', group: 'video', label: '视频尺寸', type: 'text' },
  { key: 'VIDEO_WATERMARK_ENABLED', group: 'video', label: '供应商水印', type: 'boolean' },
  { key: 'VIDEO_FALLBACK_TO_MOCK', group: 'video', label: '视频失败回退 mock', type: 'boolean' },
  { key: 'VIDEO_IMAGE_UPLOAD_BASE_URL', group: 'video', label: '源图上传接口地址', type: 'text' },
  { key: 'VIDEO_IMAGE_UPLOAD_API_KEY', group: 'video', label: '源图上传接口密钥', type: 'secret' },
  { key: 'LIP_SYNC_PROVIDER', group: 'video', label: '口型服务商', type: 'select', options: ['dashscope', 'toapi', 'seedance', 'mock'] },
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
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return null
  const pathname = decodeURIComponent(parsed.pathname)
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

async function persistSilentLipSyncVideo({ storyboardId, versionNo, sourceUrl }) {
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
  return {
    outputPath,
    videoUrl: `${buildGeneratedVideoPublicBaseUrl()}/${path.basename(outputPath)}`,
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

async function renderHybridExport({ exportId, projectId, config, clips, audioTracks }) {
  const exportDir = path.join(GENERATED_EXPORT_DIR, String(exportId))
  const sourceDir = path.join(exportDir, 'sources')
  const clipDir = path.join(exportDir, 'clips')
  await mkdir(sourceDir, { recursive: true })
  await mkdir(clipDir, { recursive: true })

  const resolution = exportResolution(config.resolution)
  const frameRate = Math.max(1, Number(config.frameRate) || 24)
  const renderedClips = []
  const renderedClipItems = []
  const skipped = []
  for (const [index, clip] of clips.entries()) {
    const duration = Math.max(1, Number(clip.durationSeconds) || 5)
    const baseName = `clip-${String(index + 1).padStart(3, '0')}`
    const outputPath = path.join(clipDir, `${baseName}.mp4`)
    try {
      if (clip.sourceType === 'video' && clip.videoUrl) {
        const sourcePath = path.join(sourceDir, `${baseName}.mp4`)
        await downloadMediaToFile(clip.videoUrl, sourcePath)
        await runExternalCommand(FFMPEG_BIN, [
          '-y', '-i', sourcePath, '-t', String(duration),
          '-vf', `scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=decrease,pad=${resolution.width}:${resolution.height}:(ow-iw)/2:(oh-ih)/2,tpad=stop_mode=clone:stop_duration=${duration},format=yuv420p`,
          '-r', String(frameRate), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', outputPath,
        ])
      } else if (clip.imageUrl) {
        const sourcePath = path.join(sourceDir, `${baseName}.png`)
        await downloadMediaToFile(clip.imageUrl, sourcePath)
        await runExternalCommand(FFMPEG_BIN, [
          '-y', '-loop', '1', '-i', sourcePath, '-t', String(duration),
          '-vf', `scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=decrease,pad=${resolution.width}:${resolution.height}:(ow-iw)/2:(oh-ih)/2,zoompan=z='min(zoom+0.0008,1.08)':d=${Math.max(1, Math.round(duration * frameRate))}:s=${resolution.width}x${resolution.height}:fps=${frameRate},format=yuv420p`,
          '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', outputPath,
        ])
      } else {
        skipped.push({ storyboardId: clip.storyboardId, reason: 'missing-video-and-image' })
        continue
      }
      renderedClips.push(outputPath)
      renderedClipItems.push(clip)
    } catch (error) {
      skipped.push({ storyboardId: clip.storyboardId, reason: error instanceof Error ? error.message : 'render failed' })
    }
  }
  if (!renderedClips.length) throw new Error('no usable video or static frame clips')

  const concatPath = path.join(exportDir, 'concat.txt')
  await writeFile(concatPath, renderedClips.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join('\n'))
  const baseVideoPath = path.join(exportDir, 'video-base.mp4')
  await runExternalCommand(FFMPEG_BIN, [
    '-y', '-f', 'concat', '-safe', '0', '-i', concatPath,
    '-c', 'copy', '-movflags', '+faststart', baseVideoPath,
  ])

  const timeline = buildMediaTimeline(renderedClipItems)
  const subtitleText = buildSubtitleText(renderedClipItems, timeline)
  const subtitlePath = path.join(exportDir, 'subtitles.srt')
  await writeFile(subtitlePath, subtitleText || '1\n00:00:00,000 --> 00:00:01,000\n\n')
  const duration = timeline.durationSeconds

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
  // A silent bed keeps the output stream valid when no music or SFX exists.
  // Do not synthesize a test tone: it is audible as low-frequency noise in the opening.
  const silenceIndex = audioFiles.length + 1
  inputs.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${duration}`)
  filterParts.push(`[${silenceIndex}:a]atrim=0:${duration}[silence]`)
  audioLabels.push('[silence]')
  filterParts.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0,aresample=async=1:first_pts=0,apad,atrim=0:${duration}[mixed]`)
  if (config.burnSubtitle !== false && subtitleText) {
    filterParts.push(`[0:v]subtitles='${ffmpegPath(subtitlePath)}':force_style='FontName=Microsoft YaHei,FontSize=22,Outline=2,Alignment=2'[subbed]`)
  }
  const videoMap = config.burnSubtitle !== false && subtitleText ? '[subbed]' : '0:v'
  try {
    await runExternalCommand(FFMPEG_BIN, [
      ...inputs, '-filter_complex', filterParts.join(';'), '-map', videoMap, '-map', '[mixed]',
      '-t', String(duration), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', finalPath,
    ])
  } catch (error) {
    if (config.burnSubtitle !== false && subtitleText) {
      await runExternalCommand(FFMPEG_BIN, [
        ...inputs, '-filter_complex', filterParts.filter((part) => !part.startsWith('[0:v]subtitles')).join(';'), '-map', '0:v', '-map', '[mixed]',
        '-t', String(duration), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', finalPath,
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
  const [activeRows] = await db.execute(
    `SELECT * FROM generation_jobs
     WHERE project_id = ? AND job_type = ? AND source_id = ? AND status IN ('queued', 'running')
     ORDER BY id DESC LIMIT 1`,
    [projectId, jobType, sourceId],
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
    [jobKey, projectId, jobType, sourceId, JSON.stringify(request || {})],
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
  for (const candidate of candidates) {
    const [result] = await db.execute(
      `INSERT INTO character_images
        (character_id, version_no, image_url, thumbnail_url, prompt_snapshot, model_name, status)
       VALUES (?, ?, ?, ?, ?, ?, 'candidate')`,
      [
        request.characterId,
        request.versionNo,
        candidate.imageUrl,
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
  if (config.provider === 'dashscope') {
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
        (storyboard_id, image_asset_id, version_no, video_url, thumbnail_url,
         motion_mode, duration_seconds, model_name, audio_asset_id, generation_job_id,
         source_type, status, confirmed_at)
       VALUES (?, ?, ?, ?, ?, 'LIP_SYNC', ?, ?, ?, ?, 'lip_sync', ?, ${status === 'confirmed' ? 'NOW()' : 'NULL'})`,
      [
        request.storyboardId,
        request.imageAssetId,
        request.versionNo,
        persisted.videoUrl,
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
    } else if (row.job_type === 'lip_sync') {
      result = await processLipSyncGenerationJob(jobId, request)
    } else {
      throw new Error(`Unsupported generation job type: ${row.job_type}`)
    }
    await updateGenerationJob(jobId, {
      status: 'success',
      progress_percent: 100,
      result_json: JSON.stringify(result),
      error_text: null,
    })
  } catch (error) {
    const errorText = sanitizeProviderError(error)
    console.error(`[generation-job:${jobId}] failed`, errorText)
    await updateGenerationJob(jobId, {
      status: 'failed',
      progress_percent: 100,
      error_text: errorText,
    })
  }
}

async function recoverGenerationJobs() {
  await db.execute(
    `UPDATE generation_jobs SET status = 'queued', progress_percent = 0, updated_at = NOW()
     WHERE status = 'running'`,
  )
  const [rows] = await db.execute(
    `SELECT id FROM generation_jobs WHERE status = 'queued' ORDER BY id ASC`,
  )
  for (const row of rows) queueGenerationJob(Number(row.id))
}

async function enqueueFrameImageJob(userId, shotId, body = {}) {
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

  const [characterRows] = await db.execute(
    `SELECT id, name, role_tag, personality, appearance, age_group, gender,
            reference_image_url, status
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
    }))
    .filter((item) => item.actionText || item.visualPrompt)
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
    const increment = subShots.length - 1
    await conn.execute(
      `UPDATE storyboards
       SET sort_order = sort_order + ?
       WHERE scene_id = ? AND sort_order > ?`,
      [increment, shot.scene_id, shot.sort_order],
    )
    const first = subShots[0]
    await conn.execute(
      `UPDATE storyboards
       SET shot_type = ?, camera_angle = ?, composition = ?, duration_seconds = ?,
           action_text = ?, dialogue_text = ?, visual_prompt = ?,
           start_visual_prompt = ?, end_visual_prompt = ?,
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
        shot.image_url || null,
        storyboardId,
      ],
    )
    const baseShotNo = String(shot.shot_no || 'S').slice(0, 5)
    for (let index = 1; index < subShots.length; index += 1) {
      const item = subShots[index]
      await conn.execute(
        `INSERT INTO storyboards
          (scene_id, shot_no, shot_type, camera_angle, composition, duration_seconds,
           character_id, character_name, action_text, dialogue_text, visual_prompt,
           start_visual_prompt, end_visual_prompt, sort_order, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
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
    const increment = subShots.length - 1
    await conn.execute(
      `UPDATE storyboards
       SET sort_order = sort_order + ?
       WHERE scene_id = ? AND sort_order > ?`,
      [increment, shot.scene_id, shot.sort_order],
    )
    const first = subShots[0]
    await conn.execute(
      `UPDATE storyboards
       SET shot_type = ?, camera_angle = ?, composition = ?, duration_seconds = ?,
           character_id = ?, character_name = ?,
           action_text = ?, dialogue_text = ?, visual_prompt = ?,
           start_visual_prompt = ?, end_visual_prompt = ?,
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
        shot.image_url || null,
        storyboardId,
      ],
    )
    const baseShotNo = String(shot.shot_no || 'S').slice(0, 5)
    for (let index = 1; index < subShots.length; index += 1) {
      const item = subShots[index]
      await conn.execute(
        `INSERT INTO storyboards
          (scene_id, shot_no, shot_type, camera_angle, composition, duration_seconds,
           character_id, character_name, action_text, dialogue_text, visual_prompt,
           start_visual_prompt, end_visual_prompt, sort_order, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
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
     WHERE c.id = ? LIMIT 1`,
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
      referenceImageUrls: character.reference_image_url ? [character.reference_image_url] : [],
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

  const [imageRows] = await db.execute(
    `SELECT * FROM image_assets
     WHERE storyboard_id = ? AND status = 'confirmed'
     ORDER BY confirmed_at DESC, id DESC LIMIT 1`,
    [storyboardId],
  )
  const image = imageRows[0]
  if (!image) {
    const error = new Error('请先确认当前分镜静帧，再生成口型视频')
    error.statusCode = 409
    throw error
  }

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
  const audio = audioRows[0]
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

  const [versionRows] = await db.execute(
    `SELECT COALESCE(MAX(version_no), 0) AS maxVersion
     FROM video_assets WHERE storyboard_id = ?`,
    [storyboardId],
  )
  const characterName = shot.resolved_character_name || shot.character_name || '人物'
  const lipSyncConfig = getLipSyncConfig()
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
      imageAssetId: Number(image.id),
      imageUrl: image.image_url,
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
      outline_id BIGINT UNSIGNED DEFAULT NULL,
      scene_no INT UNSIGNED NOT NULL,
      title VARCHAR(200) DEFAULT NULL,
      summary TEXT,
      content LONGTEXT,
      mood VARCHAR(200) DEFAULT NULL,
      location VARCHAR(200) DEFAULT NULL,
      time_of_day VARCHAR(40) DEFAULT NULL,
      estimated_duration INT UNSIGNED DEFAULT NULL,
      sort_order INT UNSIGNED NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_scenes_project_no (project_id, scene_no),
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
      reference_image_url VARCHAR(500) DEFAULT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_characters_project_id (project_id),
      KEY idx_characters_status (status),
      KEY idx_characters_voice_profile_key (voice_profile_key),
      CONSTRAINT fk_characters_project_id FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS character_images (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      character_id BIGINT UNSIGNED NOT NULL,
      version_no INT UNSIGNED NOT NULL DEFAULT 1,
      image_url VARCHAR(500) NOT NULL,
      thumbnail_url VARCHAR(500) DEFAULT NULL,
      prompt_snapshot TEXT,
      model_name VARCHAR(100) DEFAULT NULL,
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
      image_asset_id BIGINT UNSIGNED NOT NULL,
      version_no INT UNSIGNED NOT NULL DEFAULT 1,
      video_url TEXT NOT NULL,
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
  await runLightMigrations(pool)
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
  const migrations = [
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
      column: 'voice_locked',
      sql: 'ALTER TABLE characters ADD COLUMN voice_locked TINYINT(1) NOT NULL DEFAULT 0',
    },
    {
      table: 'characters',
      column: 'voice_profile_key_index',
      sql: 'ALTER TABLE characters ADD KEY idx_characters_voice_profile_key (voice_profile_key)',
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
      column: 'audio_asset_id_index',
      sql: 'ALTER TABLE video_assets ADD KEY idx_video_assets_audio_asset_id (audio_asset_id)',
    },
    {
      table: 'video_assets',
      column: 'generation_job_id_index',
      sql: 'ALTER TABLE video_assets ADD KEY idx_video_assets_generation_job_id (generation_job_id)',
    },
  ]
  for (const m of migrations) {
    try {
      await pool.execute(m.sql)
    } catch (e) {
      // Duplicate column / table missing 等情况都吞掉
      // 1060 = Duplicate column name
      if (e && e.errno && ![1060, 1061].includes(e.errno)) {
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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
  })
  res.end(JSON.stringify(payload))
}

function success(res, data = {}, message = 'success') {
  json(res, 200, { code: 0, message, data })
}

function fail(res, code, message, statusCode = 400) {
  json(res, statusCode, { code, message, data: null })
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''

    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1_000_000) {
        reject(new Error('Request body too large'))
      }
    })

    req.on('end', () => {
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
    AI_FALLBACK_TO_MOCK: String(aiConfig.fallbackToMock),

    FRAME_PROVIDER: frameConfig.provider,
    FRAME_BASE_URL: frameConfig.baseUrl,
    FRAME_API_KEY: frameConfig.apiKey,
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
  try {
    const settings = await getPersistedModelSettingMap(pool)
    for (const [key, value] of settings) {
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
          durationSeconds: Number(row.latest_export_duration_seconds) || null,
          createdAt: row.latest_export_created_at || null,
        }
      : null,
  }
  if (hasProgressAggregates) {
    result.progressPercent = progress.percent
    result.progressStage = progress.stage
    result.progressDetails = progress.details
    result.progressComplete = progress.isComplete
  }
  return result
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
  return {
    id: row.id,
    projectId: row.project_id || row.projectId,
    outlineId: row.outline_id || row.outlineId,
    sceneNo: row.scene_no || row.sceneNo,
    title: row.title,
    summary: row.summary,
    content: row.content,
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
    visualPrompt: row.visual_prompt || row.visualPrompt,
    startVisualPrompt: row.start_visual_prompt || row.startVisualPrompt || '',
    endVisualPrompt: row.end_visual_prompt || row.endVisualPrompt || '',
    imageUrl: row.image_url || row.imageUrl,
    endImageUrl: row.end_image_url || row.endImageUrl || '',
    videoUrl: row.video_url || row.videoUrl,
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

function videoAssetRow(row) {
  return {
    id: row.id,
    storyboardId: row.storyboard_id || row.storyboardId,
    imageAssetId: row.image_asset_id || row.imageAssetId,
    versionNo: row.version_no || row.versionNo,
    videoUrl: row.video_url || row.videoUrl,
    thumbnailUrl: row.thumbnail_url || row.thumbnailUrl,
    motionMode: row.motion_mode || row.motionMode,
    durationSeconds: row.duration_seconds || row.durationSeconds,
    modelName: row.model_name || row.modelName,
    audioAssetId: row.audio_asset_id || row.audioAssetId || null,
    generationJobId: row.generation_job_id || row.generationJobId || null,
    sourceType: row.source_type || row.sourceType || 'generated_video',
    status: row.status,
    confirmedAt: row.confirmed_at || row.confirmedAt,
    createdAt: row.created_at || row.createdAt,
  }
}

function audioAssetRow(row) {
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
    audioUrl: row.audio_url || row.audioUrl,
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

  return {
    id: row.id,
    projectId: row.project_id || row.projectId,
    status: row.status,
    videoUrl: row.video_url || row.videoUrl,
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

function parseJsonObject(value, fallback = {}) {
  if (!value) return fallback
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

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
    videoClips.push({
      storyboardId,
      enabled: item?.enabled !== false,
      order: parseId(item?.order) || index + 1,
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
  const availableAudioTrackCount = FINAL_EDIT_AUDIO_TRACKS.filter(
    (trackKey) => (audioTracks[trackKey] || []).length > 0,
  ).length
  const enabledAudioTrackCount = FINAL_EDIT_AUDIO_TRACKS.filter(
    (trackKey) => (audioTracks[trackKey] || []).length > 0 && audioMix[trackKey]?.enabled !== false,
  ).length

  const totalStoryboardCount = Number(projectCompleteness?.totalStoryboardCount || 0)
  const missingStoryboardSceneCount = Number(projectCompleteness?.missingStoryboardSceneCount || 0)
  const missingVideoCount = Math.max(totalStoryboardCount - videoItems.length, 0)
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
    confirmedVideoCount: videoItems.length,
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
    referenceImageUrl: row.reference_image_url || row.referenceImageUrl,
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
    ready: Boolean(character.voiceLocked && selectedProfile),
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

function characterImageRow(row) {
  return {
    id: row.id,
    characterId: row.character_id || row.characterId,
    versionNo: row.version_no || row.versionNo,
    imageUrl: row.image_url || row.imageUrl,
    thumbnailUrl: row.thumbnail_url || row.thumbnailUrl,
    promptSnapshot: row.prompt_snapshot || row.promptSnapshot,
    modelName: row.model_name || row.modelName,
    status: row.status,
    confirmedAt: row.confirmed_at || row.confirmedAt,
    createdAt: row.created_at || row.createdAt,
  }
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

function buildMockImageUrl(storyboardId, index, versionNo) {
  return `http://127.0.0.1:${PORT}/mock/image/${storyboardId}/${versionNo}/${index + 1}.svg`
}

function buildMockThumbnailUrl(fullUrl) {
  return fullUrl
}

function buildGeneratedFramePublicBaseUrl() {
  return `http://127.0.0.1:${PORT}/generated/frame`
}

function buildGeneratedAudioPublicBaseUrl() {
  return `http://127.0.0.1:${PORT}/generated/audio`
}

function buildGeneratedVideoPublicBaseUrl() {
  return `http://127.0.0.1:${PORT}/generated/video`
}

function buildGeneratedExportPublicBaseUrl() {
  return `http://127.0.0.1:${PORT}/generated/export`
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
  return `http://127.0.0.1:${PORT}/mock/audio/${projectId}/${sceneId}/${characterId}/${versionNo}/${trackType}/${candidateNo}.wav`
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

async function fetchProjectById(projectId) {
  const [rows] = await db.execute(`SELECT * FROM projects WHERE id = ? LIMIT 1`, [projectId])
  return rows[0] || null
}

async function buildExportPackage(projectId) {
  const [rows] = await db.execute(
    `SELECT sc.id AS scene_id,
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
     ORDER BY sc.scene_no ASC, s.sort_order ASC, s.id ASC`,
    [projectId],
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
  const normalizedDraft = normalizeFinalEditDraft(draftRow?.draft_json, {
    videoItems: rawVideoItems,
    audioTracks: null,
  })
  const draftVideoMap = new Map(
    normalizedDraft.videoClips.map((item, index) => [
      item.storyboardId,
      {
        enabled: item.enabled !== false,
        order: parseId(item.order) || index + 1,
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

  return {
    projectId,
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
    const finalEditPayload = await buildProjectFinalEdit(project)
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
    const sourceClips = finalEditPayload.videoTrack.items
      .filter((item) => item.enabled !== false)
      .map((item) => ({
        ...item,
        durationSeconds: Math.max(
          Number(item.durationSeconds) || 0,
          speechDurationByStoryboard.get(Number(item.storyboardId)) || 0,
        ),
      }))
    const hybridVideoPerScene = Math.max(
      1,
      Math.min(6, Number(config.hybridVideoPerScene) || Number(config.hybridVideoLimit) || 4),
    )
    const realVideoByScene = new Map()
    let realVideoCount = 0
    const clips = sourceClips.map((item) => {
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
    const rendered = await renderHybridExport({
      exportId,
      projectId: Number(record.project_id),
      config,
      clips,
      audioTracks: finalEditPayload.audioTracks,
    })
    const videoUrl = `${buildGeneratedExportPublicBaseUrl()}/${exportId}`
    const coverUrl = clips[0]?.thumbnailUrl || clips[0]?.imageUrl || record.cover_url || null
    const resultConfig = {
      ...config,
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
      subtitleFile: `${buildGeneratedExportPublicBaseUrl()}/${exportId}/subtitles.srt`,
    }
    await db.execute(
      `UPDATE export_records
       SET status = 'completed', video_url = ?, cover_url = ?, duration_seconds = ?, config_json = ?, updated_at = NOW()
       WHERE id = ?`,
      [videoUrl, coverUrl, rendered.durationSeconds, JSON.stringify(resultConfig), exportId],
    )
  } catch (error) {
    const message = sanitizeProviderError(error)
    await db.execute(
      `UPDATE export_records SET status = 'failed', config_json = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify({ ...config, pipeline: 'hybrid-mvp', error: message }), exportId],
    )
    console.error(`[export-job:${exportId}] ${message}`)
  }
}

async function resumeExportJobs() {
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
     WHERE project_id = ?
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
     WHERE sc.project_id = ?
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
            c.name AS character_name
     FROM generation_jobs gj
     LEFT JOIN storyboards s ON gj.job_type IN ('frame_image', 'lip_sync') AND s.id = gj.source_id
     LEFT JOIN script_scenes sc ON sc.id = s.scene_id
     LEFT JOIN characters c ON gj.job_type = 'character_image' AND c.id = gj.source_id
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
            c.name AS character_name
     FROM generation_jobs gj
     LEFT JOIN storyboards s ON gj.job_type IN ('frame_image', 'lip_sync') AND s.id = gj.source_id
     LEFT JOIN script_scenes sc ON sc.id = s.scene_id
     LEFT JOIN characters c ON gj.job_type = 'character_image' AND c.id = gj.source_id
     WHERE gj.project_id = ?
     ORDER BY gj.created_at DESC, gj.id DESC`,
    [projectId],
  )

  const runtimeRows = await fetchTaskRuntimeRows(projectId)
  const runtimeMap = new Map(runtimeRows.map((row) => [row.task_key, row]))
  const rawItems = []

  for (const row of generationJobRows) {
    const isCharacter = row.job_type === 'character_image'
    const isLipSync = row.job_type === 'lip_sync'
    const jobResult = safeJsonParse(row.result_json, null)
    const firstResult = isLipSync ? jobResult?.item || null : jobResult?.items?.[0] || null
    rawItems.push({
      taskKey: `generation-${row.id}`,
      taskType: isLipSync ? 'video' : 'image',
      sourceId: Number(row.id),
      projectId,
      sceneId: row.scene_id || null,
      sceneNo: row.scene_no || null,
      sceneTitle: row.scene_title || null,
      storyboardId: isCharacter ? null : Number(row.source_id),
      characterId: isCharacter ? Number(row.source_id) : null,
      shotNo: row.shot_no || null,
      versionNo: null,
      title: isCharacter
        ? `${row.character_name || '角色'} 定妆图生成`
        : isLipSync
          ? `Scene ${String(row.scene_no || 0).padStart(2, '0')} / ${row.shot_no || 'SHOT'} 对白口型同步`
          : `Scene ${String(row.scene_no || 0).padStart(2, '0')} / ${row.shot_no || 'SHOT'} 静帧生成`,
      subtitle: row.status === 'success' ? '生成完成' : row.status === 'failed' ? '生成失败' : '后台处理中',
      status: row.status === 'success' ? 'completed' : row.status,
      previewUrl: firstResult?.thumbnailUrl || firstResult?.imageUrl || null,
      fileUrl: firstResult?.videoUrl || firstResult?.imageUrl || null,
      detailText: isCharacter ? '角色定妆图生成任务' : isLipSync ? '中文对白驱动口型视频' : '分镜静帧生成任务',
      runtimeStatus: row.status,
      progressPercent: Number(row.progress_percent || 0),
      runtimeMessage:
        row.status === 'queued'
          ? '生成任务正在排队'
          : row.status === 'running'
            ? isLipSync ? '正在同步中文对白与人物口型' : '正在调用图片生成模型'
            : row.status === 'success'
              ? isLipSync ? '口型视频已生成并保存到本地' : '图片候选已生成'
              : isLipSync ? '口型同步失败' : '图片生成失败',
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

async function buildProjectFinalEdit(project) {
  const projectId = Number(project.id)
  const [completenessRows] = await db.execute(
    `SELECT COUNT(s.id) AS total_storyboard_count,
            SUM(CASE WHEN s.id IS NULL THEN 1 ELSE 0 END) AS missing_storyboard_scene_count
     FROM script_scenes sc
     LEFT JOIN storyboards s ON s.scene_id = sc.id
     WHERE sc.project_id = ?`,
    [projectId],
  )
  const projectCompleteness = {
    totalStoryboardCount: Number(completenessRows[0]?.total_storyboard_count || 0),
    missingStoryboardSceneCount: Number(completenessRows[0]?.missing_storyboard_scene_count || 0),
  }
  const [videoRows] = await db.execute(
    `SELECT sc.id AS scene_id,
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
            va.thumbnail_url,
            va.duration_seconds AS video_duration_seconds,
            va.version_no AS video_version_no,
            va.confirmed_at AS video_confirmed_at,
            ia.id AS image_asset_id,
            ia.image_url AS confirmed_image_url,
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
     WHERE sc.project_id = ?
       AND (va.id IS NOT NULL OR ia.id IS NOT NULL)
     ORDER BY sc.scene_no ASC, s.sort_order ASC, s.id ASC`,
    [projectId],
  )

  const [audioRows] = await db.execute(
    `SELECT aa.*,
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
     ORDER BY CASE aa.track_type
                WHEN 'dialogue' THEN 1
                WHEN 'narration' THEN 2
                WHEN 'music' THEN 3
                WHEN 'sfx' THEN 4
                ELSE 99
              END ASC,
              aa.scene_id ASC,
              aa.id ASC`,
    [projectId],
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
    const imageUrl = row.confirmed_image_url || row.image_url || null
    const hasVideo = Boolean(row.video_asset_id && row.video_url)
    videoItems.push({
      storyboardId: row.storyboard_id,
      sceneId: row.scene_id,
      sceneNo: row.scene_no,
      sceneTitle: row.scene_title,
      shotNo: row.shot_no,
      shotType: row.shot_type,
      dialogueText: row.dialogue_text || null,
      durationSeconds,
      sourceType: hasVideo ? 'video' : 'static',
      videoUrl: hasVideo ? row.video_url : null,
      imageUrl,
      thumbnailUrl: row.thumbnail_url || row.confirmed_image_thumbnail_url || imageUrl || null,
      versionNo: row.video_version_no || 1,
      confirmedAt: row.video_confirmed_at || null,
      sortOrder: row.sort_order || 0,
      enabled: true,
      order: videoItems.length + 1,
    })
  }

  for (const row of audioRows) {
    const item = {
      id: row.id,
      projectId: row.project_id,
      trackType: row.track_type,
      sceneId: row.scene_id || null,
      storyboardId: row.storyboard_id || null,
      shotNo: row.storyboard_shot_no || null,
      characterId: row.character_id || null,
      versionNo: row.version_no || 1,
      title: resolveAudioSourceTitle({ ...row, project_name: project.name }),
      audioUrl: row.audio_url,
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
  const normalizedDraft = normalizeFinalEditDraft(draftRow?.draft_json, {
    videoItems,
    audioTracks,
  })

  const draftVideoMap = new Map(
    normalizedDraft.videoClips.map((item, index) => [
      item.storyboardId,
      {
        enabled: item.enabled !== false,
        order: parseId(item.order) || index + 1,
      },
    ]),
  )
  const hasDraftVideoClips = draftVideoMap.size > 0
  const nextFallbackOrder = draftVideoMap.size + 1
  videoItems.forEach((item, index) => {
    const draftItem = draftVideoMap.get(item.storyboardId)
    item.enabled = draftItem ? draftItem.enabled !== false : !hasDraftVideoClips
    item.order = draftItem ? draftItem.order : nextFallbackOrder + index
  })
  videoItems.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order
    if (a.sceneNo !== b.sceneNo) return a.sceneNo - b.sceneNo
    if ((a.sortOrder || 0) !== (b.sortOrder || 0)) return (a.sortOrder || 0) - (b.sortOrder || 0)
    return a.storyboardId - b.storyboardId
  })
  videoItems.forEach((item, index) => {
    item.order = index + 1
  })

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
        storyboardId: item.storyboardId,
        enabled: item.enabled !== false,
        order: item.order,
      })),
      audioMix: normalizedDraft.audioMix,
      updatedAt: draftRow?.updated_at || null,
    },
    validation,
    summary: {
      confirmedVideoCount: videoItems.length,
      confirmedAudioCount,
      hasVideo: videoItems.length > 0,
      hasAudio: confirmedAudioCount > 0,
      totalDurationSeconds: validation.enabledVideoDurationSeconds,
      sourceDurationSeconds: totalSourceDurationSeconds,
      enabledAudioTrackCount: validation.enabledAudioTrackCount,
      availableAudioTrackCount: validation.availableAudioTrackCount,
      totalStoryboardCount: validation.totalStoryboardCount,
      missingVideoCount: validation.missingVideoCount,
      missingStoryboardSceneCount: validation.missingStoryboardSceneCount,
    },
  }
}

const server = createServer(async (req, res) => {
  if (!req.url || !req.method) {
    fail(res, 5000, 'invalid request', 500)
    return
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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

    if (req.method === 'POST' && pathname === '/api/auth/send-code') {
      const body = await parseBody(req)
      const phone = normalizePhone(body.phone)
      const typeRaw = String(body.type || 'login')
      const type = typeRaw === 'register' || typeRaw === 'reset' ? typeRaw : 'login'

      if (!/^1\d{10}$/.test(phone)) {
        fail(res, 4001, '手机号格式不正确')
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
                  exports.latest_export_duration_seconds,
                  exports.latest_export_created_at
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

      const exportPackage = await buildExportPackage(projectId)
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
      await updateGenerationJob(jobId, {
        status: 'queued',
        progress_percent: 0,
        result_json: null,
        error_text: null,
      })
      queueGenerationJob(jobId)
      const updated = await fetchGenerationJob(jobId)
      success(res, projectTaskItemRow({
        taskKey: `generation-${jobId}`,
        taskType: job.job_type === 'lip_sync' ? 'video' : 'image',
        sourceId: jobId,
        projectId: Number(job.project_id),
        title: job.job_type === 'lip_sync' ? '对白口型同步任务' : '图片生成任务',
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

      const payload = await buildProjectFinalEdit(project)
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
      const currentFinalEdit = await buildProjectFinalEdit(project)
      const normalizedDraft = normalizeFinalEditDraft(body, {
        videoItems: currentFinalEdit.videoTrack.items,
        audioTracks: currentFinalEdit.audioTracks,
      })

      await db.execute(
        `INSERT INTO final_edit_drafts (project_id, draft_json)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE
           draft_json = VALUES(draft_json),
           updated_at = NOW()`,
        [projectId, JSON.stringify(normalizedDraft)],
      )

      const payload = await buildProjectFinalEdit(project)
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
            `SELECT id, name, voice_setting, voice_profile_key, voice_locked,
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
            fail(res, 4010, `角色“${character.name}”还没有确认并锁定音色，请先完成角色音色管理`, 409)
            return
          }
          voiceProfile = await findActiveVoiceProfile(character.voice_profile_key)
          if (!voiceProfile) {
            fail(res, 4010, `角色“${character.name}”绑定的音色已停用，请重新选择`, 409)
            return
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
        const voiceInstructions = voiceProfile?.instructions || null
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
               start_offset_seconds, title, audio_url, duration_seconds, voice_name, model_name, voice_profile_key,
               voice_instructions, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate')`,
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
              candidate.durationSeconds || durationSeconds,
              candidate.voiceName || voiceName,
              candidate.modelName || modelName,
              candidate.voiceProfileKey || voiceProfile?.profileKey || null,
              candidate.voiceInstructions || voiceInstructions,
            ],
          )
          insertedIds.push(Number(result.insertId))
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

        const exportPackage = await buildExportPackage(projectId)
        if (!exportPackage.canExport && exportPackage.readyShots <= 0) {
          const blockingMessage =
            exportPackage.blockingIssues[0]?.message ||
            (exportPackage.readyShots <= 0
              ? '当前项目还没有已确认视频，无法导出'
              : '当前项目素材尚未补齐，无法导出')
          fail(res, 4001, blockingMessage, 400)
          return
        }

        const finalEditPayload = await buildProjectFinalEdit(project)
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
          `SELECT * FROM script_scenes WHERE project_id = ? ORDER BY scene_no ASC, id ASC`,
          [projectId],
        )
        success(res, { items: rows.map(sceneRow) })
        return
      }

      if (sub === 'scenes' && req.method === 'POST' && tail.startsWith('/generate')) {
        // 读取最新总纲
        const [outlineRows] = await db.execute(
          `SELECT * FROM story_outlines WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
          [projectId],
        )
        const outline = outlineRows[0]
        if (!outline) {
          fail(res, 4001, '请先生成总纲')
          return
        }

        let scenesSpec = []
        try {
          scenesSpec = outline.raw_json ? JSON.parse(outline.raw_json).scenes || [] : []
        } catch {
          scenesSpec = []
        }

        if (!scenesSpec.length) {
          fail(res, 4001, '总纲中没有可用场景')
          return
        }

        // 清空旧场景（保持幂等）
        await db.execute(`DELETE FROM script_scenes WHERE project_id = ?`, [projectId])

        const connection = await db.getConnection()
        const insertedIds = []
        try {
          await connection.beginTransaction()
          for (let i = 0; i < scenesSpec.length; i += 1) {
            const spec = scenesSpec[i]
            const [insertResult] = await connection.execute(
              `INSERT INTO script_scenes
                 (project_id, outline_id, scene_no, title, summary, location, time_of_day,
                  estimated_duration, sort_order, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
              [
                projectId,
                outline.id,
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
          `SELECT * FROM script_scenes WHERE project_id = ? ORDER BY scene_no ASC`,
          [projectId],
        )
        success(res, { items: rows.map(sceneRow) }, '场景列表已生成')
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
        const [outlineRows] = await db.execute(
          `SELECT * FROM story_outlines WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
          [scene.project_id],
        )
        const outline = outlineRows[0]
        const aiScript = await aiGenerateSceneScript({
          scene,
          outline: outline
            ? {
                ...outline,
                title: outline.title,
              }
            : null,
          project: {
            name: scene.projectName,
            category: scene.category,
            visualStyle: scene.visual_style,
            narrativeVision: scene.narrative_vision,
          },
        })

        await db.execute(
          `UPDATE script_scenes
           SET content = ?, mood = ?, status = 'generated', updated_at = NOW()
           WHERE id = ?`,
          [aiScript.content, aiScript.mood, sceneId],
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

        const [outlineRows] = await db.execute(
          `SELECT * FROM story_outlines WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
          [scene.project_id],
        )
        const outline = outlineRows[0]
        const [projectCharacterRows] = await db.execute(
          `SELECT id, name, role_tag, personality, appearance, voice_setting, age_group, gender,
                  reference_image_url, status
           FROM characters WHERE project_id = ? ORDER BY id ASC`,
          [scene.project_id],
        )

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
          characters: projectCharacterRows,
        })

        // P1: DELETE + INSERT + UPDATE 整体进事务
        //    任何一步失败全部回滚，旧分镜完整保留；不允许"半套新分镜 + 状态已切"的状态出现
        //    conn 在 finally 里 release，避免连接泄漏
        const conn = await db.getConnection()
        try {
          await conn.beginTransaction()

          await conn.execute(`DELETE FROM storyboards WHERE scene_id = ?`, [sceneId])

          for (let i = 0; i < aiResult.shots.length; i += 1) {
            const shot = aiResult.shots[i]
            await conn.execute(
              `INSERT INTO storyboards
                 (scene_id, shot_no, shot_type, camera_angle, composition, duration_seconds,
                  character_id, character_name, action_text, dialogue_text, visual_prompt, sort_order, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
              [
                sceneId,
                shot.shot_no,
                shot.shot_type,
                shot.camera_angle,
                shot.composition,
                shot.duration_seconds,
                matchCharacterId(shot.character_name, projectCharacterRows),
                shot.character_name,
                shot.action_text,
                shot.dialogue_text,
                shot.visual_prompt,
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
        `SELECT s.id, s.scene_id, s.shot_no, s.shot_type, s.camera_angle, s.composition,
                s.duration_seconds, s.character_id,
                COALESCE(c.name, s.character_name) AS character_name,
                s.action_text, s.dialogue_text,
                s.visual_prompt, s.image_url, s.video_url, s.sort_order, s.status,
                s.created_at, s.updated_at,
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
          durationSeconds: parseId(body.durationSeconds) || null,
          characterId: resolvedCharacterId,
          characterName:
            body.characterName !== undefined ? body.characterName : selectedCharacter?.name,
          actionText: body.actionText,
          dialogueText: body.dialogueText,
          visualPrompt: body.visualPrompt,
          startVisualPrompt: body.startVisualPrompt,
          endVisualPrompt: body.endVisualPrompt,
          imageUrl: body.imageUrl,
          endImageUrl: body.endImageUrl,
          status: body.status,
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
            startVisualPrompt: 'start_visual_prompt',
            endVisualPrompt: 'end_visual_prompt',
            imageUrl: 'image_url',
            endImageUrl: 'end_image_url',
            status: 'status',
          }[key]
          sets.push(`${column} = ?`)
          params.push(value)
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
        `SELECT va.id, va.storyboard_id, va.video_url, p.user_id AS ownerId
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

      const conn = await db.getConnection()
      try {
        await conn.beginTransaction()
        await conn.execute(
          `UPDATE video_assets
           SET status = CASE WHEN status = 'confirmed' THEN 'archived' ELSE status END,
               confirmed_at = NULL
           WHERE storyboard_id = ? AND id <> ?`,
          [video.storyboard_id, videoId],
        )
        await conn.execute(
          `UPDATE video_assets SET status = 'confirmed', confirmed_at = NOW()
           WHERE id = ?`,
          [videoId],
        )
        await conn.execute(
          `UPDATE storyboards SET video_url = ?, updated_at = NOW() WHERE id = ?`,
          [video.video_url, video.storyboard_id],
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
        `SELECT * FROM characters WHERE project_id = ? ORDER BY id ASC`,
        [projectId],
      )
      const profiles = await listActiveVoiceProfiles()
      success(res, {
        items: characterRows.map((row) => characterVoiceCastRow(row, profiles)),
      })
      return
    }

    const characterVoiceManagementMatch = pathname.match(
      /^\/api\/characters\/(\d+)\/(voice-recommendations|voice-binding)$/,
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
         WHERE c.id = ? LIMIT 1`,
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
        const voiceStyle = String(body.voiceStyle ?? ch.voice_style ?? '').trim().slice(0, 160) || null
        const voiceLocked = body.locked !== false
        await db.execute(
          `UPDATE characters
           SET age_group = ?, gender = ?, voice_style = ?, voice_profile_key = ?,
               voice_setting = ?, voice_locked = ?, updated_at = NOW()
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
        })
        if (!aiResult.characters.length) {
          fail(res, 5001, 'AI 没有识别出有效角色，请检查总纲和剧本内容', 502)
          return
        }

        const conn = await db.getConnection()
        try {
          await conn.beginTransaction()
          for (const item of aiResult.characters) {
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
                     voice_setting = COALESCE(NULLIF(voice_setting, ''), ?),
                     age_group = COALESCE(NULLIF(age_group, ''), ?),
                     gender = COALESCE(NULLIF(gender, ''), ?),
                     voice_style = COALESCE(NULLIF(voice_style, ''), ?),
                     updated_at = NOW()
                 WHERE id = ?`,
                [
                  item.role_tag,
                  item.personality,
                  item.appearance,
                  item.voice_setting,
                  item.age_group,
                  item.gender,
                  item.voice_style,
                  existingId,
                ],
              )
            } else {
              await conn.execute(
                `INSERT INTO characters
                  (project_id, name, role_tag, personality, appearance, voice_setting,
                   age_group, gender, voice_style, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
                [
                  projectId,
                  item.name,
                  item.role_tag,
                  item.personality,
                  item.appearance,
                  item.voice_setting,
                  item.age_group,
                  item.gender,
                  item.voice_style,
                ],
              )
            }
          }
          await conn.commit()
        } catch (error) {
          await conn.rollback()
          throw error
        } finally {
          conn.release()
        }

        await db.execute(
          `UPDATE storyboards s
           INNER JOIN script_scenes sc ON sc.id = s.scene_id
           INNER JOIN characters c ON c.project_id = sc.project_id AND c.name = s.character_name
           SET s.character_id = c.id
           WHERE sc.project_id = ? AND s.character_id IS NULL`,
          [projectId],
        )
        const [rows] = await db.execute(
          `SELECT * FROM characters WHERE project_id = ? ORDER BY id ASC`,
          [projectId],
        )
        success(res, { items: rows.map(characterRow) }, '角色档案已生成')
        return
      }

      if (req.method === 'GET' && !isGenerate) {
        const [rows] = await db.execute(
          `SELECT * FROM characters WHERE project_id = ? ORDER BY id ASC`,
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
          `SELECT id FROM characters WHERE project_id = ? AND name = ? LIMIT 1`,
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
         WHERE ci.id = ? LIMIT 1`,
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
           SET reference_image_url = ?, status = 'finalized', updated_at = NOW()
           WHERE id = ?`,
          [image.image_url, image.character_id],
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
         WHERE c.id = ? LIMIT 1`,
        [characterId],
      )
      const ch = ownRows[0]
      if (!ch || ch.ownerId !== user.id) {
        fail(res, 4004, '角色不存在或无权访问', 404)
        return
      }

      const [duplicateRows] = await db.execute(
        `SELECT id FROM characters WHERE project_id = ? AND name = ? AND id <> ? LIMIT 1`,
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
         WHERE c.id = ? LIMIT 1`,
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
              referenceImageUrls: ch.reference_image_url ? [ch.reference_image_url] : [],
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
        const text = String(body.text || `我是${ch.name}。故事已经开始，我会做出自己的选择。`).trim()
        const requestedProfileKey = String(body.voiceProfileKey || ch.voice_profile_key || '').trim()
        const voiceProfile = requestedProfileKey
          ? await findActiveVoiceProfile(requestedProfileKey)
          : null
        if (requestedProfileKey && !voiceProfile) {
          fail(res, 4001, '试听音色方案不存在或已停用', 400)
          return
        }
        const voiceName = String(
          voiceProfile?.voiceId || body.voiceName || ch.voice_setting || audioConfig.defaultVoice,
        ).trim()
        const modelName = String(
          voiceProfile?.modelName || body.modelName || audioConfig.defaultModel,
        ).trim()
        const instructions = voiceProfile?.instructions || null
        if (isMockAudioProvider(audioConfig)) {
          success(res, {
            audioUrl: buildMockAudioUrl(ch.project_id, 'voice-preview', 1, 1, { characterId }),
            durationSeconds: 4,
            voiceName,
            modelName: 'mock-audio-v2',
            voiceProfileKey: voiceProfile?.profileKey || null,
            voiceProfileName: voiceProfile?.displayName || null,
          }, '音色试听已生成')
          return
        }
        try {
          const [candidate] = await generateAudioCandidates({
            projectId: ch.project_id,
            trackType: 'voice-preview',
            versionNo: Math.floor(Date.now() / 1000),
            text,
            voiceName,
            modelName,
            instructions,
            publicBaseUrl: buildGeneratedAudioPublicBaseUrl(),
            outputDir: GENERATED_AUDIO_DIR,
            candidateCount: 1,
          })
          success(res, {
            ...candidate,
            voiceProfileKey: voiceProfile?.profileKey || null,
            voiceProfileName: voiceProfile?.displayName || null,
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
         WHERE c.id = ? LIMIT 1`,
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
             WHERE c.id = ? LIMIT 1 FOR UPDATE`,
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

server.listen(PORT, () => {
  console.log(`Auth server is running at http://localhost:${PORT}`)
  console.log(`Database: mysql://${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}`)
  console.log(`SMS provider: ${smsRuntime.provider}`)
  console.log(`SMS ready: ${smsRuntime.ready} (${smsRuntime.reason})`)
  console.log(`Demo account: ${DEMO_PHONE}`)
})

await recoverGenerationJobs()
await resumeExportJobs()
