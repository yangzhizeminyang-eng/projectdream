import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

import { buildExportStorageKey } from '../server/services/media-storage-keys.mjs'
import { createObjectStorageFromEnv } from '../server/services/object-storage.mjs'
import {
  buildSubtitleCuesFromAudioTracks,
  buildSubtitleForceStyle,
} from '../server/services/subtitle-cues.mjs'
import {
  MARKET_QUALITY_BENCHMARK_VERSION,
  evaluateMarketQuality,
  parseSrtCues,
} from '../server/services/market-quality-benchmark.mjs'
import { buildMarketQualityAuditSummary } from '../server/services/market-quality-audit.mjs'
import { hasCompleteAudioHumanEvidence } from '../server/services/final-quality-review.mjs'

const FFMPEG_BIN = String(process.env.FFMPEG_BIN || 'ffmpeg').trim() || 'ffmpeg'
const FFPROBE_BIN = String(process.env.FFPROBE_BIN || 'ffprobe').trim() || 'ffprobe'
const RUNTIME_DIR = path.join(process.cwd(), '.codex-runtime', 'market-quality-audit')
const REPORT_DIR = path.join(process.cwd(), '.codex-runtime', 'market-quality-reports')

function readOption(name) {
  const prefix = `--${name}=`
  const option = process.argv.find((argument) => argument.startsWith(prefix))
  return option ? option.slice(prefix.length) : null
}

function positiveInteger(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parseJsonObject(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function sanitizeError(error) {
  return String(error?.message || error || 'unknown audit failure')
    .replace(/sk-[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .slice(0, 1600)
}

function runExternalCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
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
      reject(new Error(`${command} exited with ${code}: ${stderr.slice(-1200)}`))
    })
  })
}

function parseFrameRate(value) {
  const [numerator, denominator] = String(value || '')
    .split('/')
    .map((item) => Number(item))
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
    ? numerator / denominator
    : 0
}

function finiteNumber(value, fallback = null) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseStoredJson(value, fallback = null) {
  if (value && typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function hasPersistentLetterboxBars(edgeLuma = {}) {
  const top = finiteNumber(edgeLuma.top)
  const middle = finiteNumber(edgeLuma.middle)
  const bottom = finiteNumber(edgeLuma.bottom)
  if (![top, middle, bottom].every(Number.isFinite)) return false
  const borderAverage = (top + bottom) / 2
  return borderAverage <= 20 && middle >= 30 && borderAverage / middle <= 0.55
}

async function inspectVerticalEdgeLuma(filePath, media = {}) {
  const width = Math.max(0, Math.floor(Number(media.width) || 0))
  const height = Math.max(0, Math.floor(Number(media.height) || 0))
  if (!width || !height) return null

  const cropHeight = Math.max(2, Math.floor(height * 0.15 / 2) * 2)
  const middleY = Math.max(0, Math.floor((height - cropHeight) / 2 / 2) * 2)
  const sampleSecond = Math.max(0, Math.min((Number(media.durationSeconds) || 0) / 2, 2.5))
  const regions = {
    top: 0,
    middle: middleY,
    bottom: Math.max(0, height - cropHeight),
  }
  const values = {}

  for (const [name, y] of Object.entries(regions)) {
    const { stderr } = await runExternalCommand(FFMPEG_BIN, [
      '-hide_banner',
      '-nostats',
      '-ss',
      sampleSecond.toFixed(3),
      '-i',
      filePath,
      '-vf',
      `crop=${width}:${cropHeight}:0:${y},signalstats,metadata=print`,
      '-frames:v',
      '1',
      '-an',
      '-f',
      'null',
      '-',
    ])
    const value = Number(stderr.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/)?.[1])
    if (!Number.isFinite(value)) return null
    values[name] = Number(value.toFixed(3))
  }

  return values
}

async function inspectFreezeRisk(filePath) {
  const { stderr } = await runExternalCommand(FFMPEG_BIN, [
    '-hide_banner',
    '-nostats',
    '-i',
    filePath,
    '-vf',
    'freezedetect=n=-60dB:d=0.8',
    '-an',
    '-f',
    'null',
    '-',
  ])
  const durations = [...String(stderr).matchAll(/freeze_duration:\s*([\d.]+)/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite)
  return durations.some((duration) => duration >= 0.8)
}

async function inspectDroppedFrameRisk(filePath, media = {}) {
  const { stdout } = await runExternalCommand(FFPROBE_BIN, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_frames',
    '-show_entries',
    'frame=best_effort_timestamp_time,pkt_duration_time',
    '-of',
    'json',
    filePath,
  ])
  const payload = parseStoredJson(stdout, {}) || {}
  const frames = Array.isArray(payload.frames) ? payload.frames : []
  const frameRate = Number(media.frameRate) || 0
  const durationSeconds = Number(media.durationSeconds) || 0
  if (!frames.length || frameRate <= 0 || durationSeconds <= 0) return false

  const timestamps = frames
    .map((frame) => Number(frame.best_effort_timestamp_time))
    .filter(Number.isFinite)
  const expectedFrameCount = Math.max(1, Math.round(durationSeconds * frameRate))
  if (timestamps.length < Math.floor(expectedFrameCount * 0.98)) return true

  const maxGap = 1.75 / frameRate
  for (let index = 1; index < timestamps.length; index += 1) {
    const delta = timestamps[index] - timestamps[index - 1]
    if (delta < -0.001 || delta > maxGap) return true
  }
  return false
}

async function inspectFrameIntegrity(filePath, media) {
  try {
    const edgeLuma = await inspectVerticalEdgeLuma(filePath, media)
    const [freezeDetected, droppedFrameRisk] = await Promise.all([
      inspectFreezeRisk(filePath),
      inspectDroppedFrameRisk(filePath, media),
    ])
    return {
      edgeLuma,
      blackBarDetected: hasPersistentLetterboxBars(edgeLuma || {}),
      freezeDetected,
      droppedFrameRisk,
      measurable: true,
    }
  } catch (error) {
    return {
      edgeLuma: null,
      blackBarDetected: false,
      freezeDetected: false,
      droppedFrameRisk: false,
      measurable: false,
      error: sanitizeError(error),
    }
  }
}

function buildTimeline(clips = []) {
  const entries = new Map()
  let cursor = 0
  for (const clip of Array.isArray(clips) ? clips : []) {
    const storyboardId = Number(clip?.storyboardId || clip?.storyboard_id) || 0
    const durationSeconds = Number(clip?.durationSeconds || clip?.duration_seconds) || 0
    if (!storyboardId || durationSeconds <= 0) continue
    entries.set(storyboardId, {
      startSeconds: cursor,
      endSeconds: cursor + durationSeconds,
      durationSeconds,
    })
    cursor += durationSeconds
  }
  return { entries, durationSeconds: cursor }
}

export function buildExportClips({ row, config, context, media }) {
  const storyboardRows = Array.isArray(context?.storyboards) ? context.storyboards : []
  const byId = new Map(storyboardRows.map((item) => [Number(item.id), item]))
  const recoveryStoryboardId = Number(config?.recoveryFinalEdit?.storyboardId) || 0
  const recoveryVideoAssetId = Number(config?.recoveryFinalEdit?.videoId) || 0
  if (recoveryStoryboardId) {
    const storyboard = byId.get(recoveryStoryboardId)
    return storyboard
      ? [{
          videoAssetId: recoveryVideoAssetId || null,
          storyboardId: recoveryStoryboardId,
          durationSeconds: Number(media?.durationSeconds) || Number(storyboard.duration_seconds) || 0,
          dialogueText: storyboard.dialogue_text || '',
          sourceType: 'video',
        }]
      : []
  }

  const singleVideoStoryboardId = Number(config?.singleVideoFinalEdit?.storyboardId) || 0
  const singleVideoAssetId = Number(config?.singleVideoFinalEdit?.videoId) || 0
  if (singleVideoStoryboardId) {
    const storyboard = byId.get(singleVideoStoryboardId)
    return storyboard
      ? [{
          videoAssetId: singleVideoAssetId || null,
          storyboardId: singleVideoStoryboardId,
          durationSeconds: Number(media?.durationSeconds) || Number(storyboard.duration_seconds) || 0,
          dialogueText: storyboard.dialogue_text || '',
          sourceType: 'video',
        }]
      : []
  }

  const draftClips = Array.isArray(config?.finalEditDraft?.videoClips)
    ? config.finalEditDraft.videoClips
    : []
  return draftClips
    .filter((clip) => clip?.enabled !== false)
    .map((clip) => {
      const storyboardId = Number(clip?.storyboardId || clip?.storyboard_id) || 0
      const storyboard = byId.get(storyboardId)
      return {
        videoAssetId: Number(clip?.videoAssetId || clip?.video_asset_id) || null,
        storyboardId,
        durationSeconds: Number(storyboard?.duration_seconds) || 0,
        dialogueText: storyboard?.dialogue_text || '',
        sourceType: 'video',
      }
    })
    .filter((clip) => clip.storyboardId && clip.durationSeconds > 0)
}

function normalizeAudioTrackRows(audioTracks = {}) {
  return Object.fromEntries(
    ['dialogue', 'narration'].map((trackType) => [
      trackType,
      (Array.isArray(audioTracks?.[trackType]) ? audioTracks[trackType] : []).map((item) => ({
        ...item,
        id: item?.id,
        trackType: item?.trackType ?? item?.track_type ?? trackType,
        storyboardId: item?.storyboardId ?? item?.storyboard_id,
        characterName: item?.characterName ?? item?.character_name ?? '',
        startOffsetSeconds: item?.startOffsetSeconds ?? item?.start_offset_seconds,
        durationSeconds: item?.durationSeconds ?? item?.duration_seconds,
      })),
    ]),
  )
}

export function buildExpectedSubtitleCues({
  clips = [],
  audioTracks = {},
  rawCues = null,
  speechSyncOffsetSeconds = 0,
} = {}) {
  const timeline = buildTimeline(clips)
  const hasRawCues = Array.isArray(rawCues)
  const normalizedAudioTracks = normalizeAudioTrackRows(audioTracks)
  const cues = hasRawCues
    ? rawCues
    : buildSubtitleCuesFromAudioTracks(clips, normalizedAudioTracks)
  const dialogueCueIds = new Set(
    normalizedAudioTracks.dialogue.map((item) => `audio-${Number(item?.id) || 0}`),
  )
  const syncOffset = hasRawCues
    ? 0
    : Number.isFinite(Number(speechSyncOffsetSeconds))
      ? Number(speechSyncOffsetSeconds)
      : 0
  return cues
    .filter((cue) => cue?.enabled !== false)
    .map((cue) => {
      const entry = timeline.entries.get(Number(cue?.storyboardId) || 0)
      if (!entry) return null
      const cueOffset = dialogueCueIds.has(String(cue?.cueId || '')) ? syncOffset : 0
      const startSeconds = entry.startSeconds + Math.max(
        0,
        (Number(cue.startOffsetSeconds) || 0) + cueOffset,
      )
      const endSeconds = Math.min(
        entry.endSeconds,
        startSeconds + Math.max(0.25, Number(cue.durationSeconds) || entry.durationSeconds),
      )
      const text = String(cue?.text || '').trim()
      return text && endSeconds > startSeconds
        ? {
            startSeconds: Number(startSeconds.toFixed(3)),
            endSeconds: Number(endSeconds.toFixed(3)),
            text,
          }
        : null
    })
    .filter(Boolean)
}

function stripSubtitleSpeakerLabel(value) {
  return String(value || '')
    .replace(
      /^[^：:\n]{1,40}?\s*(?:[（(][^）)\n]{0,80}[）)])?\s*[：:]\s*/,
      '',
    )
    .trim()
}

export function normalizeExpectedSubtitleCuesForBurnIn(cues = []) {
  return (Array.isArray(cues) ? cues : []).map((cue) => ({
    ...cue,
    text: stripSubtitleSpeakerLabel(cue?.text),
  }))
}

export function buildCharacterAuditInput({
  storyboards = [],
  videoAssets = [],
  baselines = [],
  videoAssetIds = null,
  storyboardIds = null,
} = {}) {
  const selectedVideoAssetIds = videoAssetIds instanceof Set
    ? videoAssetIds
    : Array.isArray(videoAssetIds)
      ? new Set(videoAssetIds.map((value) => Number(value)).filter(Boolean))
      : null
  const selectedStoryboardIds = storyboardIds instanceof Set
    ? storyboardIds
    : Array.isArray(storyboardIds)
      ? new Set(storyboardIds.map((value) => Number(value)).filter(Boolean))
      : null
  const baselineById = new Map(
    baselines.map((baseline) => [Number(baseline?.characterId || baseline?.character_id), baseline]),
  )
  const clips = []
  for (const asset of Array.isArray(videoAssets) ? videoAssets : []) {
    const videoAssetId = Number(asset?.videoAssetId || asset?.video_asset_id || asset?.id) || 0
    if (selectedVideoAssetIds && !selectedVideoAssetIds.has(videoAssetId)) continue
    const storyboardId = Number(asset?.storyboardId || asset?.storyboard_id) || 0
    if (selectedStoryboardIds && !selectedStoryboardIds.has(storyboardId)) continue
    const storyboard = storyboards.find((item) => Number(item?.id) === storyboardId)
    const videoEvidence = parseStoredJson(asset?.character_evidence_json, {}) || {}
    const snapshot = videoEvidence.characterSnapshot && typeof videoEvidence.characterSnapshot === 'object'
      ? videoEvidence.characterSnapshot
      : parseStoredJson(asset?.image_character_snapshot, {}) || {}
    const characters = Array.isArray(snapshot.characters) ? snapshot.characters : []
    const characterId = Number(
      storyboard?.character_id ||
        snapshot.primaryCharacterId ||
        characters.find((item) => item?.isPrimary)?.characterId ||
        characters[0]?.characterId,
    ) || 0
    if (!storyboardId || !characterId) continue
    const snapshotCharacter = characters.find(
      (item) => Number(item?.characterId) === characterId,
    )
    clips.push({
      videoAssetId,
      storyboardId,
      characterId,
      characterVersionNo:
        Number(
          snapshotCharacter?.characterVersionNo ||
            snapshotCharacter?.character_version_no ||
            snapshotCharacter?.versionNo ||
            snapshotCharacter?.version_no,
        ) || null,
    })
  }
  return {
    mode: 'metadata-baseline',
    clips,
    baselines: [...baselineById.values()].map((baseline) => ({
      characterId: Number(baseline.characterId || baseline.character_id),
      versionNo: Number(baseline.versionNo || baseline.version_no),
      appearance: String(baseline.appearance || '').trim(),
      costume: String(baseline.costume || '').trim(),
      referenceImageUrl: String(baseline.referenceImageUrl || baseline.reference_image_url || '').trim(),
    })),
  }
}

export function buildExportCharacterAuditInput({
  clips = [],
  storyboards = [],
  videoAssets = [],
  baselines = [],
} = {}) {
  const selectedClips = Array.isArray(clips) ? clips : []
  return buildCharacterAuditInput({
    storyboards,
    videoAssets,
    baselines,
    videoAssetIds: selectedClips
      .map((clip) => Number(clip?.videoAssetId) || 0)
      .filter(Boolean),
    storyboardIds: selectedClips
      .map((clip) => Number(clip?.storyboardId) || 0)
      .filter(Boolean),
  })
}

export function buildPacingAuditInput({ clips = [], totalDurationSeconds = 0 } = {}) {
  return {
    clips: (Array.isArray(clips) ? clips : []).map((clip) => ({
      storyboardId: Number(clip?.storyboardId || clip?.storyboard_id) || null,
      durationSeconds: Number(clip?.durationSeconds || clip?.duration_seconds) || 0,
      sourceType: String(clip?.sourceType || clip?.source_type || 'video'),
    })),
    totalDurationSeconds: Number(totalDurationSeconds) || 0,
  }
}

async function probeMedia(filePath) {
  const { stdout } = await runExternalCommand(FFPROBE_BIN, [
    '-v',
    'error',
    '-show_entries',
    'format=format_name,duration:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels',
    '-of',
    'json',
    filePath,
  ])
  const payload = parseJsonObject(stdout, {})
  const streams = Array.isArray(payload.streams) ? payload.streams : []
  const video = streams.find((stream) => stream.codec_type === 'video') || {}
  const audio = streams.find((stream) => stream.codec_type === 'audio') || {}
  return {
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    frameRate: parseFrameRate(video.r_frame_rate),
    durationSeconds: Number(payload.format?.duration) || 0,
    videoCodec: String(video.codec_name || '').trim().toLowerCase(),
    audioCodec: String(audio.codec_name || '').trim().toLowerCase(),
    audioSampleRate: Number(audio.sample_rate) || 0,
    audioChannels: Number(audio.channels) || 0,
    formatName: String(payload.format?.format_name || '').trim().toLowerCase(),
  }
}

function parseLoudnormJson(stderr) {
  const matches = String(stderr || '').match(/\{[\s\S]*\}/g) || []
  for (const candidate of matches.reverse()) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && parsed.input_i !== undefined) {
        return parsed
      }
    } catch {
      // FFmpeg may emit more than one diagnostic object; keep looking.
    }
  }
  return null
}

async function inspectAudio(filePath, durationSeconds) {
  try {
    const loudnessResult = await runExternalCommand(FFMPEG_BIN, [
      '-hide_banner',
      '-nostats',
      '-i',
      filePath,
      '-map',
      '0:a:0',
      '-af',
      'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
      '-f',
      'null',
      '-',
    ])
    const loudness = parseLoudnormJson(loudnessResult.stderr)
    const volumeResult = await runExternalCommand(FFMPEG_BIN, [
      '-hide_banner',
      '-nostats',
      '-i',
      filePath,
      '-map',
      '0:a:0',
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-',
    ])
    const meanVolume = Number(volumeResult.stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/)?.[1])
    const maxVolume = Number(volumeResult.stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/)?.[1])
    const clippedSamples = Number.isFinite(maxVolume) && maxVolume >= -0.1 ? 1 : 0
    const silenceResult = await runExternalCommand(FFMPEG_BIN, [
      '-hide_banner',
      '-nostats',
      '-i',
      filePath,
      '-map',
      '0:a:0',
      '-af',
      'silencedetect=n=-45dB:d=0.05',
      '-f',
      'null',
      '-',
    ])
    const silenceStarts = [...silenceResult.stderr.matchAll(/silence_start:\s*([\d.]+)/g)]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite)
    const silenceEnds = [...silenceResult.stderr.matchAll(/silence_end:\s*([\d.]+)/g)]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite)
    const silenceSegments = silenceStarts.map((start, index) => ({
      start,
      end: Math.min(
        Math.max(start, silenceEnds[index] ?? durationSeconds),
        durationSeconds,
      ),
    }))
    const activeSegments = []
    let cursor = 0
    for (const silence of silenceSegments) {
      if (silence.start > cursor) activeSegments.push({ start: cursor, end: silence.start })
      cursor = Math.max(cursor, silence.end)
    }
    if (cursor < durationSeconds) activeSegments.push({ start: cursor, end: durationSeconds })
    const activeDuration = activeSegments.reduce(
      (total, segment) => total + Math.max(0, segment.end - segment.start),
      0,
    )

    const integratedLufs = Number(loudness?.input_i)
    const truePeakDbtp = Number(loudness?.input_tp)
    return {
      measurable: Number.isFinite(integratedLufs) && Number.isFinite(truePeakDbtp),
      integratedLufs: Number.isFinite(integratedLufs) ? integratedLufs : null,
      truePeakDbtp: Number.isFinite(truePeakDbtp) ? truePeakDbtp : null,
      loudnessRange: Number(loudness?.input_lra),
      meanVolume: Number.isFinite(meanVolume) ? meanVolume : null,
      maxVolume: Number.isFinite(maxVolume) ? maxVolume : null,
      clippedSamples,
      speechCoverageRatio:
        durationSeconds > 0 ? Math.min(1, activeDuration / durationSeconds) : 0,
      activeSegments,
      measurementNotes: [
        '响度和峰值来自 FFmpeg 机器测量。',
        'clippedSamples 是 max_volume 接近 0dB 的风险代理，不等于耳朵听感。',
        'activeSegments 是全混音静音检测，不等于对白识别。',
      ],
    }
  } catch (error) {
    return {
      measurable: false,
      integratedLufs: null,
      truePeakDbtp: null,
      clippedSamples: 0,
      speechCoverageRatio: 0,
      activeSegments: [],
      error: sanitizeError(error),
    }
  }
}

function intervalOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart))
}

function buildCueAlignment(cues, activeSegments) {
  return cues.map((cue) => {
    const duration = Math.max(0.001, cue.endSeconds - cue.startSeconds)
    const nearest = activeSegments.reduce((best, segment) => {
      if (!best) return segment
      return Math.abs(segment.start - cue.startSeconds) < Math.abs(best.start - cue.startSeconds)
        ? segment
        : best
    }, null)
    const overlapSeconds = activeSegments.reduce(
      (total, segment) =>
        total + intervalOverlap(cue.startSeconds, cue.endSeconds, segment.start, segment.end),
      0,
    )
    return {
      cueIndex: cue.index,
      onsetErrorSeconds: nearest
        ? Number(Math.abs(nearest.start - cue.startSeconds).toFixed(3))
        : null,
      overlapRatio: Number(Math.min(1, overlapSeconds / duration).toFixed(3)),
    }
  })
}

function parseSubtitleStyle() {
  const style = buildSubtitleForceStyle()
  return {
    fontSize: Number(style.match(/FontSize=(\d+)/i)?.[1]) || null,
    marginV: Number(style.match(/MarginV=(\d+)/i)?.[1]) || null,
  }
}

function maxShotDuration(config) {
  const clips = Array.isArray(config.finalEditDraft?.videoClips)
    ? config.finalEditDraft.videoClips
    : []
  const durations = clips
    .map((clip) => Number(clip?.durationSeconds))
    .filter((value) => Number.isFinite(value) && value > 0)
  return durations.length ? Math.max(...durations) : null
}

function platformEvidenceConfigured(config) {
  const compliance = parseJsonObject(config.releaseCompliance, {})
  const disclosure = parseJsonObject(compliance.aiDisclosure, {})
  const platforms = Array.isArray(compliance.platforms) && compliance.platforms.length
    ? compliance.platforms
    : ['hongguo', 'douyin']
  const evidence = Array.isArray(disclosure.platformEvidence)
    ? disclosure.platformEvidence
    : []
  const byPlatform = new Map(
    evidence.map((item) => [String(item?.platform || '').trim(), item]),
  )
  const complete = disclosure.disclosureConfirmed === true &&
    Boolean(String(disclosure.label || '').trim()) &&
    platforms.every((platform) => {
      const item = byPlatform.get(String(platform))
      return item?.aiLabelReviewed === true &&
        item?.copyrightFieldsReviewed === true &&
        Boolean(String(item?.ruleReviewNote || '').trim())
    })
  return {
    aiDisclosureConfigured: complete,
    copyrightEvidenceConfigured: complete,
    platforms,
    evidenceCount: evidence.length,
  }
}

function humanReviewBlockers(qualityRow) {
  const checklist = parseJsonObject(qualityRow?.review_checklist_json, {})
  const hasHumanListening =
    qualityRow?.review_decision === 'approved' &&
    hasCompleteAudioHumanEvidence(checklist)
  return hasHumanListening
    ? []
    : [{
        code: 'human-listening-required',
        message: '完整播放后的真人听感、响度、爆音/失真和对白同步仍未形成可验证批准证据。',
      }]
}

async function inspectExport({ row, qualityRow, storage, context }) {
  const exportId = Number(row.id)
  const projectId = Number(row.project_id)
  const storageKey = String(row.storage_key || '').trim() ||
    (row.status === 'completed'
      ? buildExportStorageKey({ projectId, exportId })
      : null)
  const item = {
    exportId,
    projectId,
    status: row.status,
    storageKey,
    storageReadable: false,
    audit: null,
    qualityReport: qualityRow
      ? {
          id: Number(qualityRow.id),
          automaticPassed: Boolean(qualityRow.automatic_passed),
          reviewDecision: qualityRow.review_decision || null,
        }
      : null,
  }
  if (!storageKey) {
    item.error = '导出记录没有可用 storage_key'
    return item
  }

  const object = await storage.getObject(storageKey)
  if (!object || !object.bytes?.length) {
    item.error = '对象存储中找不到可读取的成片对象'
    return item
  }

  item.storageReadable = true
  const baseName = `project-${projectId}-export-${exportId}`
  const videoPath = path.join(RUNTIME_DIR, `${baseName}.mp4`)
  await writeFile(videoPath, object.bytes)
  const media = await probeMedia(videoPath)
  const frameIntegrity = await inspectFrameIntegrity(videoPath, media)
  Object.assign(media, frameIntegrity)
  const audio = await inspectAudio(videoPath, media.durationSeconds)
  const subtitleKey = buildExportStorageKey({
    projectId,
    exportId,
    extension: '.srt',
  })
  const subtitleObject = await storage.getObject(subtitleKey)
  const subtitleText = subtitleObject?.bytes
    ? subtitleObject.bytes.toString('utf8')
    : ''
  const cues = parseSrtCues(subtitleText)
  const config = parseJsonObject(row.config_json, {})
  const clips = buildExportClips({ row, config, context, media })
  const audioTracks = {
    dialogue: (context.audioAssets || []).filter((item) => item.track_type === 'dialogue'),
    narration: (context.audioAssets || []).filter((item) => item.track_type === 'narration'),
  }
  const expectedCues = normalizeExpectedSubtitleCuesForBurnIn(buildExpectedSubtitleCues({
    clips,
    audioTracks,
    rawCues: config?.finalEditDraft?.subtitleCues || null,
    speechSyncOffsetSeconds: config.speechSyncOffsetSeconds,
  }))
  const characterInput = buildExportCharacterAuditInput({
    clips,
    storyboards: context.storyboards,
    videoAssets: context.videoAssets,
    baselines: context.baselines,
  })
  const pacing = buildPacingAuditInput({
    clips,
    totalDurationSeconds: media.durationSeconds,
  })
  const platform = platformEvidenceConfigured(config)
  const subtitleStyle = parseSubtitleStyle()
  const audit = evaluateMarketQuality({
    media,
    audio,
    subtitle: {
      cues,
      expectedCues,
      ...subtitleStyle,
      hasSpeech: Number(config.boundAudioCount || 0) > 0,
    },
    sync: {
      cueAlignment: buildCueAlignment(cues, audio.activeSegments),
    },
    hook: {
      firstSpeechStartSeconds: audio.activeSegments[0]?.start ?? null,
      maxShotDurationSeconds: pacing.clips.reduce(
        (max, clip) => Math.max(max, Number(clip.durationSeconds) || 0),
        0,
      ) || maxShotDuration(config),
    },
    platform,
    characters: characterInput,
    pacing,
  })
  const humanBlockers = humanReviewBlockers(qualityRow)
  item.media = media
  item.audio = audio
  item.subtitle = {
    storageReadable: Boolean(subtitleObject?.bytes?.length),
    key: subtitleKey,
    cueCount: cues.length,
    expectedCueCount: expectedCues.length,
  }
  item.audit = {
    ...audit,
    humanBlockers,
    releaseEligible: false,
    disclaimer:
      '机器代理审计不替代真人完整播放、耳朵听感、平台审核或收入数据。',
  }
  return item
}

async function loadAuditProjectContext(db, projectId) {
  const [storyboards] = await db.execute(
    `SELECT s.id, s.character_id, s.character_name, s.dialogue_text, s.duration_seconds
     FROM storyboards s
     INNER JOIN script_scenes sc ON sc.id = s.scene_id
     WHERE sc.project_id = ?
     ORDER BY s.id ASC`,
    [projectId],
  )
  const [videoAssets] = await db.execute(
    `SELECT va.id, va.storyboard_id, s.character_id,
            va.character_evidence_json,
            ia.character_snapshot AS image_character_snapshot
     FROM video_assets va
     INNER JOIN storyboards s ON s.id = va.storyboard_id
     INNER JOIN script_scenes sc ON sc.id = s.scene_id
     LEFT JOIN image_assets ia ON ia.id = va.image_asset_id
     WHERE sc.project_id = ?
     ORDER BY va.id ASC`,
    [projectId],
  )
  const [baselines] = await db.execute(
    `SELECT c.id AS character_id,
            c.appearance,
            COALESCE(c.costume, JSON_UNQUOTE(JSON_EXTRACT(cv.snapshot_json, '$.costume'))) AS costume,
            c.reference_image_url,
            cv.version_no
     FROM characters c
     LEFT JOIN character_versions cv
       ON cv.character_id = c.id AND cv.status = 'active'
     WHERE c.project_id = ? AND c.status <> 'archived'
     ORDER BY c.id ASC, cv.version_no DESC`,
    [projectId],
  )
  const [audioAssets] = await db.execute(
    `SELECT aa.id, aa.track_type, aa.storyboard_id, aa.duration_seconds,
            aa.start_offset_seconds, c.name AS character_name
     FROM audio_assets aa
     LEFT JOIN characters c ON c.id = aa.character_id
     WHERE aa.project_id = ? AND aa.status = 'confirmed'
     ORDER BY aa.id ASC`,
    [projectId],
  )
  return { storyboards, videoAssets, baselines, audioAssets }
}

function parseArguments() {
  const projectId = positiveInteger(readOption('project-id'))
  if (!projectId) throw new Error('--project-id is required, for example --project-id=12')
  const limit = Math.min(50, Math.max(1, positiveInteger(readOption('limit'), 10)))
  const requiredSampleCount = Math.min(
    50,
    Math.max(1, positiveInteger(readOption('required-sample-count'), 10)),
  )
  return { projectId, limit, requiredSampleCount }
}

async function main() {
  const { projectId, limit, requiredSampleCount } = parseArguments()
  const storage = createObjectStorageFromEnv(process.env)
  const db = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 2,
  })

  try {
    await mkdir(RUNTIME_DIR, { recursive: true })
    await mkdir(REPORT_DIR, { recursive: true })
    const [rows] = await db.execute(
      `SELECT *
       FROM export_records
       WHERE project_id = ?
         AND status IN ('completed', 'failed')
       ORDER BY id DESC
       LIMIT ${limit}`,
      [projectId],
    )
    const exportIds = rows.map((row) => Number(row.id)).filter(Boolean)
    let qualityRows = []
    if (exportIds.length) {
      const placeholders = exportIds.map(() => '?').join(',')
      const [loadedQualityRows] = await db.execute(
        `SELECT *
         FROM final_quality_reports
         WHERE project_id = ?
           AND export_id IN (${placeholders})
         ORDER BY updated_at DESC, id DESC`,
        [projectId, ...exportIds],
      )
      qualityRows = loadedQualityRows
    }
    const qualityByExportId = new Map(
      qualityRows.map((row) => [Number(row.export_id), row]),
    )
    const context = await loadAuditProjectContext(db, projectId)
    const items = []
    for (const row of rows) {
      try {
        items.push(await inspectExport({
          row,
          qualityRow: qualityByExportId.get(Number(row.id)) || null,
          storage,
          context,
        }))
      } catch (error) {
        items.push({
          exportId: Number(row.id),
          projectId,
          status: row.status,
          storageKey: row.storage_key || null,
          storageReadable: false,
          audit: null,
          error: sanitizeError(error),
        })
      }
    }
    const summary = buildMarketQualityAuditSummary({
      projectId,
      requiredSampleCount,
      items,
    })
    const report = {
      benchmarkVersion: MARKET_QUALITY_BENCHMARK_VERSION,
      generatedAt: new Date().toISOString(),
      mode: 'read-only',
      projectId,
      limit,
      requiredSampleCount,
      selectedStatuses: ['completed', 'failed'],
      summary,
      items,
    }
    const stamp = report.generatedAt.replace(/\D/g, '').slice(0, 17)
    const reportPath = path.join(
      REPORT_DIR,
      `market-quality-project-${projectId}-${stamp}-${process.pid}.json`,
    )
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify({
      projectId,
      selectedCount: rows.length,
      auditableSampleCount: summary.auditableSampleCount,
      proxyPassedCount: summary.proxyPassedCount,
      technicalProxyPassedCount: summary.technicalProxyPassedCount,
      missingSampleCount: summary.missingSampleCount,
      tenSampleReadiness: summary.tenSampleReadiness,
      reportPath,
    }, null, 2))
  } finally {
    await db.end()
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((error) => {
    console.error(sanitizeError(error))
    process.exitCode = 1
  })
}
