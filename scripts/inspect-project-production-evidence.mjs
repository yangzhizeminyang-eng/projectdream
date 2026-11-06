import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'

const projectId = Number(process.argv.find((item) => item.startsWith('--project-id='))?.split('=', 2)[1] || 12)
const limit = Number(process.argv.find((item) => item.startsWith('--limit='))?.split('=', 2)[1] || 10)
const outputDir = path.join(process.cwd(), '.codex-runtime', 'production-evidence')

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function number(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function dbConfig() {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 2,
  }
}

async function main() {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error('--project-id must be positive')
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('--limit must be positive')

  const db = mysql.createPool(dbConfig())
  try {
    const [exports] = await db.execute(
      `SELECT id, status, storage_key, duration_seconds, config_json, updated_at
       FROM export_records
       WHERE project_id = ? AND status IN ('completed', 'failed')
       ORDER BY id DESC
       LIMIT ${limit}`,
      [projectId],
    )
    const [storyboards] = await db.execute(
      `SELECT sb.id, sb.scene_id, sb.shot_no, sb.character_id, sb.character_name,
              sb.dialogue_text, sb.duration_seconds
       FROM storyboards sb
       INNER JOIN script_scenes sc ON sc.id = sb.scene_id
       WHERE sc.project_id = ?
       ORDER BY sb.id ASC`,
      [projectId],
    )
    const [videos] = await db.execute(
      `SELECT va.id, va.storyboard_id, va.image_asset_id, va.version_no, va.status,
              va.storage_key, va.source_type, va.generation_job_id,
              va.character_evidence_json, ia.character_snapshot AS image_character_snapshot
       FROM video_assets va
       INNER JOIN storyboards sb ON sb.id = va.storyboard_id
       INNER JOIN script_scenes sc ON sc.id = sb.scene_id
       LEFT JOIN image_assets ia ON ia.id = va.image_asset_id
       WHERE sc.project_id = ?
       ORDER BY va.id ASC`,
      [projectId],
    )
    const [characters] = await db.execute(
      `SELECT c.id, c.name, c.status, c.reference_image_url, c.reference_image_storage_key,
              cv.version_no AS active_version_no, cv.status AS version_status,
              cv.snapshot_json AS active_version_snapshot
       FROM characters c
       LEFT JOIN character_versions cv
         ON cv.character_id = c.id AND cv.status = 'active'
       WHERE c.project_id = ? AND c.status <> 'archived'
       ORDER BY c.id ASC, cv.version_no DESC`,
      [projectId],
    )
    const [audio] = await db.execute(
      `SELECT id, storyboard_id, track_type, status, duration_seconds,
              start_offset_seconds, character_id, character_version_no,
              storage_key
       FROM audio_assets
       WHERE project_id = ?
       ORDER BY id ASC`,
      [projectId],
    )

    const storyboardById = new Map(storyboards.map((row) => [Number(row.id), row]))
    const videosByStoryboard = new Map()
    for (const row of videos) {
      const key = Number(row.storyboard_id)
      const list = videosByStoryboard.get(key) || []
      list.push(row)
      videosByStoryboard.set(key, list)
    }
    const audioByStoryboard = new Map()
    for (const row of audio) {
      const key = Number(row.storyboard_id)
      const list = audioByStoryboard.get(key) || []
      list.push(row)
      audioByStoryboard.set(key, list)
    }

    const items = exports.map((row) => {
      const config = parseJson(row.config_json)
      const recovery = config.recoveryFinalEdit && typeof config.recoveryFinalEdit === 'object'
        ? config.recoveryFinalEdit
        : null
      const draftClips = Array.isArray(config.finalEditDraft?.videoClips)
        ? config.finalEditDraft.videoClips.filter((clip) => clip?.enabled !== false)
        : []
      const storyboardIds = recovery?.storyboardId
        ? [number(recovery.storyboardId)]
        : draftClips.map((clip) => number(clip.storyboardId)).filter(Boolean)
      const clipEvidence = storyboardIds.map((storyboardId) => {
        const storyboard = storyboardById.get(storyboardId) || null
        const clipVideoId = recovery?.videoId
          ? number(recovery.videoId)
          : number(draftClips.find((clip) => number(clip.storyboardId) === storyboardId)?.videoAssetId)
        const candidates = (videosByStoryboard.get(storyboardId) || [])
          .filter((video) => !clipVideoId || Number(video.id) === clipVideoId)
        return {
          storyboardId,
          storyboard: storyboard
            ? {
                shotNo: storyboard.shot_no,
                characterId: number(storyboard.character_id),
                characterName: storyboard.character_name,
                durationSeconds: Number(storyboard.duration_seconds) || 0,
                hasDialogue: Boolean(String(storyboard.dialogue_text || '').trim()),
              }
            : null,
          requestedVideoAssetId: clipVideoId,
          videos: candidates.map((video) => {
            const evidence = parseJson(video.character_evidence_json)
            const imageSnapshot = parseJson(video.image_character_snapshot)
            const snapshot = evidence.characterSnapshot || imageSnapshot || null
            const snapshotCharacters = Array.isArray(snapshot?.characters) ? snapshot.characters : []
            return {
              id: Number(video.id),
              versionNo: Number(video.version_no) || null,
              status: video.status,
              sourceType: video.source_type,
              storageKey: video.storage_key || null,
              generationJobId: number(video.generation_job_id),
              characterEvidencePresent: Boolean(video.character_evidence_json),
              characterEvidenceVersion: evidence.version || evidence.evidenceVersion || null,
              snapshotCharacterVersions: snapshotCharacters.map((character) => ({
                characterId: number(character.characterId || character.character_id),
                characterVersionNo: number(character.characterVersionNo || character.character_version_no || character.versionNo || character.version_no),
              })),
            }
          }),
          audio: (audioByStoryboard.get(storyboardId) || []).map((track) => ({
            id: Number(track.id),
            trackType: track.track_type,
            status: track.status,
            durationSeconds: Number(track.duration_seconds) || 0,
            startOffsetSeconds: Number(track.start_offset_seconds) || 0,
            characterId: number(track.character_id),
            characterVersionNo: number(track.character_version_no),
            storageKey: track.storage_key || null,
          })),
        }
      })
      return {
        exportId: Number(row.id),
        status: row.status,
        storageKey: row.storage_key || null,
        durationSeconds: Number(row.duration_seconds) || 0,
        updatedAt: row.updated_at,
        pipeline: config.pipeline || null,
        recoveryFinalEdit: recovery
          ? {
              videoId: number(recovery.videoId),
              storyboardId: number(recovery.storyboardId),
              planId: recovery.planId || null,
            }
          : null,
        clipEvidence,
      }
    })

    const report = {
      generatedAt: new Date().toISOString(),
      mode: 'read-only',
      projectId,
      exportCount: items.length,
      items,
      characters: characters.map((character) => ({
        id: Number(character.id),
        name: character.name,
        status: character.status,
        referenceImageUrlPresent: Boolean(String(character.reference_image_url || '').trim()),
        referenceImageStorageKeyPresent: Boolean(String(character.reference_image_storage_key || '').trim()),
        activeVersionNo: number(character.active_version_no),
        activeVersionStatus: character.version_status || null,
      })),
    }
    await mkdir(outputDir, { recursive: true })
    const stamp = report.generatedAt.replace(/\D/g, '').slice(0, 17)
    const reportPath = path.join(outputDir, `project-${projectId}-${stamp}-${process.pid}.json`)
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify({
      projectId,
      exportCount: items.length,
      exports: items.map((item) => ({
        exportId: item.exportId,
        pipeline: item.pipeline,
        recoveryVideoId: item.recoveryFinalEdit?.videoId || null,
        storyboardIds: item.clipEvidence.map((clip) => clip.storyboardId),
        videoEvidenceCounts: item.clipEvidence.map((clip) => clip.videos.filter((video) => video.characterEvidencePresent).length),
      })),
      characterBaselines: report.characters,
      reportPath,
    }, null, 2))
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(String(error?.message || error))
  process.exitCode = 1
})
