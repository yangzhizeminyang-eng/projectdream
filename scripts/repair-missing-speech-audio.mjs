// FastAPI-Only 迁移第六阶段：语音修复脚本的公共媒体基地址由 Node API 切换为 FastAPI（默认 8000，PUBLIC_BASE_URL 可覆盖）。
import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'

import { extractSpokenDialogue } from '../server/services/audio-dialogue.mjs'
import {
  buildGeneratedAudioStorageKey,
  generateAudioCandidates,
  getAudioConfig,
  isMockAudioProvider,
} from '../server/services/audio.mjs'
import { createObjectStorageFromEnv } from '../server/services/object-storage.mjs'
import {
  buildMissingSpeechAudioRepairPlan,
  normalizeMissingSpeechAudioRepairArgs,
} from '../server/services/speech-audio-repair.mjs'

const GENERATED_AUDIO_DIR = path.join(process.cwd(), '.codex-runtime', 'generated', 'audio')
const AUDIO_LIBRARY_DIR = path.join(process.cwd(), '.codex-runtime', 'audio-library')
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '')
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg'

function sanitizeError(error) {
  let message = String(error?.message || error || 'missing speech audio repair failed')
  for (const key of [
    'AUDIO_API_KEY',
    'DASHSCOPE_API_KEY',
    'COS_SECRET_ID',
    'COS_SECRET_KEY',
  ]) {
    const secret = String(process.env[key] || '').trim()
    if (secret) message = message.replaceAll(secret, '[REDACTED]')
  }
  return message.replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]').slice(0, 1200)
}

function audioMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.mp3') return 'audio/mpeg'
  if (extension === '.m4a' || extension === '.mp4') return 'audio/mp4'
  if (extension === '.ogg' || extension === '.opus') return 'audio/ogg'
  if (extension === '.flac') return 'audio/flac'
  if (extension === '.webm') return 'audio/webm'
  return 'audio/wav'
}

function runExternalCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`))
    })
  })
}

async function inspectAudioSignal(filePath) {
  const { stderr } = await runExternalCommand(FFMPEG_BIN, [
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
  const loudnessMatch = stderr.match(/"input_i"\s*:\s*"([^"]+)"/)
  const inputLoudness = String(loudnessMatch?.[1] || '').trim().toLowerCase()
  if (inputLoudness === '-inf') return 'silent'
  return Number.isFinite(Number(inputLoudness)) ? 'measurable' : 'unknown'
}

function fileNameFromUrl(value) {
  try {
    return path.basename(new URL(String(value || '')).pathname)
  } catch {
    return ''
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function probeLegacyFile(audioUrl) {
  const fileName = fileNameFromUrl(audioUrl)
  if (!fileName) return { found: false }
  const candidates = [
    path.join(GENERATED_AUDIO_DIR, fileName),
    path.join(AUDIO_LIBRARY_DIR, fileName),
  ]
  for (const filePath of candidates) {
    if (await fileExists(filePath)) {
      return { found: true, fileName }
    }
  }
  return { found: false, fileName }
}

async function probeStorageObject(storage, key) {
  if (!key) return { status: 'missing' }
  const head = await storage.headObject(key)
  if (!head) return { status: 'missing' }
  return {
    status: 'present',
    size: Number(head.size || 0),
    contentType: String(head.contentType || ''),
  }
}

async function loadSourceAudio(db, { projectId, audioId }) {
  const [rows] = await db.execute(
    `SELECT aa.*,
            p.name AS project_name,
            sb.dialogue_text,
            sb.shot_no,
            sc.summary AS scene_summary,
            sc.content AS scene_content,
            sc.scene_no,
            sc.title AS scene_title,
            c.name AS character_name
     FROM audio_assets aa
     INNER JOIN projects p ON p.id = aa.project_id
     LEFT JOIN storyboards sb ON sb.id = aa.storyboard_id
     LEFT JOIN script_scenes sc ON sc.id = aa.scene_id
     LEFT JOIN characters c ON c.id = aa.character_id
     WHERE aa.id = ? AND aa.project_id = ?
     LIMIT 1`,
    [audioId, projectId],
  )
  const row = rows[0]
  if (!row) throw new Error('source audio asset not found')
  const rawSpeechText =
    row.track_type === 'dialogue'
      ? row.dialogue_text || ''
      : row.scene_summary || row.scene_content || ''
  const speechText =
    row.track_type === 'dialogue'
      ? extractSpokenDialogue(rawSpeechText, row.character_name)
      : String(rawSpeechText || '').trim()
  return {
    row,
    sourceAudio: {
      id: Number(row.id),
      projectId: Number(row.project_id),
      trackType: row.track_type,
      status: row.status,
      storyboardId: Number(row.storyboard_id || 0) || null,
      title: row.title,
      speechText,
      voiceName: row.voice_name,
      modelName: row.model_name,
    },
  }
}

async function persistCandidate(storage, { projectId, trackType, versionNo, candidate }) {
  const bytes = await readFile(candidate.filePath)
  if (!bytes.length) throw new Error('generated audio file is empty')
  const extension = path.extname(candidate.filePath).toLowerCase() || '.wav'
  const storageKey = buildGeneratedAudioStorageKey({
    projectId,
    trackType,
    versionNo,
    candidateNo: 1,
    extension,
  })
  await storage.putObject({
    key: storageKey,
    bytes,
    contentType: audioMimeType(candidate.filePath),
  })
  return storageKey
}

async function main() {
  const args = normalizeMissingSpeechAudioRepairArgs(process.argv.slice(2))
  const audioConfig = getAudioConfig()
  const storage = createObjectStorageFromEnv(process.env)
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'projectdream',
  })

  try {
    const { row, sourceAudio } = await loadSourceAudio(db, args)
    const storageProbe = await probeStorageObject(storage, row.storage_key)
    const legacyProbe = await probeLegacyFile(row.audio_url)
    const plan = buildMissingSpeechAudioRepairPlan({
      sourceAudio,
      storageProbe,
      legacyProbe,
      runtime: {
        provider: audioConfig.provider,
        mock: isMockAudioProvider(audioConfig),
        ready: Boolean(audioConfig.apiKey),
      },
    })
    if (!args.apply || !plan.canApply) {
      console.log(JSON.stringify({ mode: 'dry-run', plan, storageProbe, legacyProbe }, null, 2))
      if (args.apply && !plan.canApply) process.exitCode = 1
      return
    }

    const [versionRows] = await db.execute(
      `SELECT COALESCE(MAX(version_no), 0) AS maxVersion
       FROM audio_assets
       WHERE project_id = ?
         AND track_type = ?
         AND (scene_id <=> ?)
         AND (character_id <=> ?)`,
      [row.project_id, row.track_type, row.scene_id || null, row.character_id || null],
    )
    const nextVersion = Number(versionRows[0]?.maxVersion || 0) + 1
    const [candidate] = await generateAudioCandidates({
      projectId: Number(row.project_id),
      trackType: row.track_type,
      versionNo: nextVersion,
      text: plan.speechText,
      voiceName: row.voice_name,
      modelName: row.model_name,
      instructions: row.voice_instructions,
      publicBaseUrl: `${PUBLIC_BASE_URL}/generated/audio`,
      outputDir: GENERATED_AUDIO_DIR,
      candidateCount: 1,
    })
    const audioSignal = await inspectAudioSignal(candidate.filePath)
    if (audioSignal !== 'measurable') {
      throw new Error(`generated speech audio is not measurable: ${audioSignal}`)
    }
    const storageKey = await persistCandidate(storage, {
      projectId: Number(row.project_id),
      trackType: row.track_type,
      versionNo: nextVersion,
      candidate,
    })
    const stored = await storage.headObject(storageKey)
    if (!stored || Number(stored.size || 0) <= 0) {
      throw new Error('generated speech audio object verification failed')
    }

    await db.beginTransaction()
    try {
      await db.execute(
        `UPDATE audio_assets
         SET status = 'candidate', confirmed_at = NULL
         WHERE project_id = ?
           AND track_type = ?
           AND (scene_id <=> ?)
           AND (storyboard_id <=> ?)
           AND (character_id <=> ?)
           AND status = 'confirmed'`,
        [
          row.project_id,
          row.track_type,
          row.scene_id || null,
          row.storyboard_id || null,
          row.character_id || null,
        ],
      )
      const [result] = await db.execute(
        `INSERT INTO audio_assets
           (project_id, track_type, scene_id, storyboard_id, character_id, version_no,
            start_offset_seconds, title, audio_url, storage_key, duration_seconds,
            voice_name, model_name, voice_profile_key, voice_instructions,
            character_version_no, character_snapshot, status, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', NOW())`,
        [
          row.project_id,
          row.track_type,
          row.scene_id || null,
          row.storyboard_id || null,
          row.character_id || null,
          nextVersion,
          Number(row.start_offset_seconds || 0),
          row.title,
          candidate.audioUrl,
          storageKey,
          candidate.durationSeconds || row.duration_seconds || null,
          candidate.voiceName || row.voice_name,
          candidate.modelName || row.model_name,
          row.voice_profile_key || null,
          candidate.voiceInstructions || row.voice_instructions || null,
          row.character_version_no || null,
          row.character_snapshot || null,
        ],
      )
      await db.commit()
      console.log(JSON.stringify({
        mode: 'apply',
        action: plan.action,
        oldAudioId: Number(row.id),
        newAudioId: Number(result.insertId),
        projectId: Number(row.project_id),
        storyboardId: Number(row.storyboard_id),
        trackType: row.track_type,
        voiceName: candidate.voiceName || row.voice_name,
        modelName: candidate.modelName || row.model_name,
        durationSeconds: candidate.durationSeconds || null,
        audioSignal,
        objectVerified: true,
      }, null, 2))
    } catch (error) {
      await db.rollback()
      throw error
    }
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(sanitizeError(error))
  process.exitCode = 1
})
