// FastAPI-Only 迁移第六阶段：存量媒体迁移的公共基地址回退值由 Node API 切换为 FastAPI（默认 8000）。
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'

import {
  buildMediaMigrationPlan,
  mediaContentTypeForExtension,
  summarizeMediaMigrationPlans,
} from '../server/services/media-migration.mjs'
import { createObjectStorageFromEnv } from '../server/services/object-storage.mjs'
import {
  downloadAndValidateRemoteMedia,
  parseRemoteMediaAllowedHosts,
  remoteMediaMaxBytes,
} from '../server/services/remote-media-recovery.mjs'

const RUNTIME_ROOT = path.join(process.cwd(), '.codex-runtime')
const MIGRATION_REPORT_DIR = path.join(RUNTIME_ROOT, 'migration-reports')
const DEFAULT_ROOTS = {
  frame: path.join(RUNTIME_ROOT, 'generated-frames'),
  audio: path.join(RUNTIME_ROOT, 'generated-audio'),
  audioLibrary: path.join(RUNTIME_ROOT, 'audio-library'),
  video: path.join(RUNTIME_ROOT, 'generated-videos'),
  export: path.join(RUNTIME_ROOT, 'exports'),
}

function parseProjectIds() {
  const option = process.argv.find((item) => item.startsWith('--projects='))
  if (!option) return null
  const values = option
    .slice('--projects='.length)
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isSafeInteger(item) && item > 0)
  return [...new Set(values)]
}

function projectFilter(column, projectIds) {
  if (!projectIds?.length) return { sql: '', params: [] }
  return {
    sql: ` WHERE ${column} IN (${projectIds.map(() => '?').join(', ')})`,
    params: projectIds,
  }
}

function makePool() {
  return mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'projectdream',
    waitForConnections: true,
    connectionLimit: 3,
  })
}

function remoteMigrationOptions() {
  return {
    allowedHosts: parseRemoteMediaAllowedHosts(process.env.REMOTE_MEDIA_ALLOWED_HOSTS),
    maxBytes: remoteMediaMaxBytes(process.env.REMOTE_MEDIA_MAX_BYTES),
    timeoutMs: remoteMediaMaxBytes(process.env.REMOTE_MEDIA_DOWNLOAD_TIMEOUT_MS, 180000),
    now: Math.floor(Date.now() / 1000),
  }
}

async function loadRecords(db, projectIds) {
  const records = []

  const imageFilter = projectFilter('sc.project_id', projectIds)
  const [imageRows] = await db.execute(
    `SELECT ia.id, ia.storyboard_id, ia.version_no, ia.image_url, ia.storage_key,
            sc.project_id
     FROM image_assets ia
     INNER JOIN storyboards s ON s.id = ia.storyboard_id
     INNER JOIN script_scenes sc ON sc.id = s.scene_id
     ${imageFilter.sql}
     ORDER BY sc.project_id ASC, ia.id ASC`,
    imageFilter.params,
  )
  records.push(
    ...imageRows.map((row) => ({
      type: 'image_asset',
      id: Number(row.id),
      projectId: Number(row.project_id),
      storyboardId: Number(row.storyboard_id),
      versionNo: Number(row.version_no),
      url: row.image_url,
      storageKey: row.storage_key,
    })),
  )

  const characterImageFilter = projectFilter('c.project_id', projectIds)
  const [characterImageRows] = await db.execute(
    `SELECT ci.id, ci.character_id, ci.version_no, ci.image_url, ci.storage_key,
            c.project_id
     FROM character_images ci
     INNER JOIN characters c ON c.id = ci.character_id
     ${characterImageFilter.sql}
     ORDER BY c.project_id ASC, ci.id ASC`,
    characterImageFilter.params,
  )
  const characterImageRecords = characterImageRows.map((row) => ({
    type: 'character_image',
    id: Number(row.id),
    projectId: Number(row.project_id),
    characterId: Number(row.character_id),
    versionNo: Number(row.version_no),
    url: row.image_url,
    storageKey: row.storage_key,
  }))
  records.push(...characterImageRecords)

  const characterFilter = projectFilter('c.project_id', projectIds)
  const [characterRows] = await db.execute(
    `SELECT c.id, c.project_id, c.reference_image_url, c.reference_image_storage_key
     FROM characters c
     ${characterFilter.sql}
     ORDER BY c.project_id ASC, c.id ASC`,
    characterFilter.params,
  )

  const characterImagePlans = buildMediaMigrationPlan({
    roots: DEFAULT_ROOTS,
    records: characterImageRecords,
  })
  const characterImagePlanByUrl = new Map()
  for (const plan of characterImagePlans) {
    if (!plan.sourceUrl || !plan.storageKey) continue
    if (!characterImagePlanByUrl.has(`${plan.projectId}:${plan.sourceUrl}`)) {
      characterImagePlanByUrl.set(`${plan.projectId}:${plan.sourceUrl}`, plan)
    }
  }
  records.push(
    ...characterRows
      .filter((row) => String(row.reference_image_url || '').trim())
      .map((row) => {
        const projectId = Number(row.project_id)
        const sourceUrl = String(row.reference_image_url || '').trim()
        const linkedPlan = characterImagePlanByUrl.get(`${projectId}:${sourceUrl}`)
        return {
          type: 'character_reference',
          id: Number(row.id),
          projectId,
          characterId: Number(row.id),
          url: sourceUrl,
          storageKey: row.reference_image_storage_key,
          preferredStorageKey: linkedPlan?.storageKey || null,
        }
      }),
  )

  const audioFilter = projectFilter('aa.project_id', projectIds)
  const [audioRows] = await db.execute(
    `SELECT aa.id, aa.project_id, aa.track_type, aa.version_no, aa.audio_url, aa.storage_key
     FROM audio_assets aa
     ${audioFilter.sql}
     ORDER BY aa.project_id ASC, aa.id ASC`,
    audioFilter.params,
  )
  records.push(
    ...audioRows.map((row) => ({
      type: 'audio_asset',
      id: Number(row.id),
      projectId: Number(row.project_id),
      trackType: row.track_type,
      versionNo: Number(row.version_no),
      url: row.audio_url,
      storageKey: row.storage_key,
    })),
  )

  const audioLibraryFilter = projectFilter('ala.project_id', projectIds)
  const [audioLibraryRows] = await db.execute(
    `SELECT ala.id, ala.project_id, ala.audio_url, ala.storage_key
     FROM audio_library_assets ala
     ${audioLibraryFilter.sql}
     ORDER BY ala.project_id ASC, ala.id ASC`,
    audioLibraryFilter.params,
  )
  records.push(
    ...audioLibraryRows.map((row) => ({
      type: 'audio_library_asset',
      id: Number(row.id),
      projectId: Number(row.project_id),
      url: row.audio_url,
      storageKey: row.storage_key,
    })),
  )

  const videoFilter = projectFilter('sc.project_id', projectIds)
  const [videoRows] = await db.execute(
    `SELECT va.id, va.storyboard_id, va.version_no, va.video_url, va.storage_key,
            va.source_type, sc.project_id
     FROM video_assets va
     INNER JOIN storyboards s ON s.id = va.storyboard_id
     INNER JOIN script_scenes sc ON sc.id = s.scene_id
     ${videoFilter.sql}
     ORDER BY sc.project_id ASC, va.id ASC`,
    videoFilter.params,
  )
  records.push(
    ...videoRows.map((row) => ({
      type: 'video_asset',
      id: Number(row.id),
      projectId: Number(row.project_id),
      storyboardId: Number(row.storyboard_id),
      versionNo: Number(row.version_no),
      sourceType: row.source_type,
      url: row.video_url,
      storageKey: row.storage_key,
    })),
  )

  const exportFilter = projectFilter('er.project_id', projectIds)
  const [exportRows] = await db.execute(
    `SELECT er.id, er.project_id, er.video_url, er.storage_key
     FROM export_records er
     ${exportFilter.sql}
     ORDER BY er.project_id ASC, er.id ASC`,
    exportFilter.params,
  )
  records.push(
    ...exportRows.map((row) => ({
      type: 'export_record',
      id: Number(row.id),
      projectId: Number(row.project_id),
      url: row.video_url,
      storageKey: row.storage_key,
    })),
  )

  return records
}

async function fileSize(sourcePath) {
  try {
    const info = await stat(sourcePath)
    return info.isFile() && info.size > 0 ? info.size : 0
  } catch {
    return 0
  }
}

async function annotateLocalSourceStatus(plans) {
  const annotated = []
  for (const plan of plans) {
    if (!['migrate', 'link'].includes(plan.action) || !plan.sourcePath) {
      annotated.push(plan)
      continue
    }
    const size = await fileSize(plan.sourcePath)
    if (plan.action === 'migrate' && !size) {
      annotated.push({
        ...plan,
        action: 'unresolved',
        reason: 'missing-local-file',
      })
      continue
    }
    annotated.push({
      ...plan,
      sourceSizeBytes: size || null,
    })
  }
  return annotated
}

function updateStatement(plan) {
  const tableByType = {
    image_asset: 'image_assets',
    character_image: 'character_images',
    audio_asset: 'audio_assets',
    audio_library_asset: 'audio_library_assets',
    video_asset: 'video_assets',
    export_record: 'export_records',
  }
  if (plan.type === 'character_reference') {
    return {
      sql: `UPDATE characters
            SET reference_image_storage_key = ?
            WHERE id = ? AND (reference_image_storage_key IS NULL OR reference_image_storage_key = '')`,
      params: [plan.storageKey, plan.id],
    }
  }
  const table = tableByType[plan.type]
  if (!table) throw new Error(`unsupported media migration update type: ${plan.type}`)
  return {
    sql: `UPDATE ${table}
          SET storage_key = ?
          WHERE id = ? AND (storage_key IS NULL OR storage_key = '')`,
    params: [plan.storageKey, plan.id],
  }
}

async function updateStorageKey(db, plan) {
  const statement = updateStatement(plan)
  const [result] = await db.execute(statement.sql, statement.params)
  return Number(result.affectedRows || 0) === 1
}

async function applyPlans(db, plans, objectStorage, remoteOptions) {
  const reportPlans = []
  const storedKeys = new Map()

  for (const plan of plans.filter((item) => ['migrate', 'remote-download'].includes(item.action))) {
    try {
      let bytes
      let validation = null
      if (plan.action === 'remote-download') {
        const downloaded = await downloadAndValidateRemoteMedia({
          url: plan.sourceUrl,
          allowedHosts: remoteOptions.allowedHosts,
          now: Math.floor(Date.now() / 1000),
          maxBytes: remoteOptions.maxBytes,
          timeoutMs: remoteOptions.timeoutMs,
        })
        bytes = downloaded.bytes
        validation = downloaded.validation
      } else {
        bytes = await readFile(plan.sourcePath)
        if (!bytes.length) throw new Error('missing-local-file')
      }
      let object = storedKeys.get(plan.storageKey)
      if (!object) {
        object = await objectStorage.putObject({
          key: plan.storageKey,
          bytes,
          contentType: validation?.contentType || mediaContentTypeForExtension(plan.extension),
        })
        const verified = await objectStorage.headObject(plan.storageKey)
        if (!verified || verified.etag !== object.etag || verified.size !== bytes.length) {
          throw new Error('object-verification-failed')
        }
        storedKeys.set(plan.storageKey, object)
      }
      const updated = await updateStorageKey(db, plan)
      reportPlans.push({
        ...plan,
        result: updated
          ? plan.action === 'remote-download'
            ? 'remote-downloaded'
            : 'migrated'
          : 'already-updated-or-race',
        etag: object.etag,
        validatedSizeBytes: validation?.sizeBytes || null,
        validatedContentType: validation?.contentType || null,
      })
    } catch (error) {
      reportPlans.push({
        ...plan,
        action: 'unresolved',
        reason: error instanceof Error ? error.message : 'migration-failed',
        result: 'failed',
      })
    }
  }

  for (const plan of plans.filter((item) => item.action === 'link')) {
    try {
      const existing = await objectStorage.headObject(plan.storageKey)
      if (!existing) throw new Error('linked-storage-object-missing')
      const updated = await updateStorageKey(db, plan)
      reportPlans.push({
        ...plan,
        result: updated ? 'linked' : 'already-updated-or-race',
      })
    } catch (error) {
      reportPlans.push({
        ...plan,
        action: 'unresolved',
        reason: error instanceof Error ? error.message : 'link-failed',
        result: 'failed',
      })
    }
  }

  return reportPlans
}

async function writeReport(report, projectIds) {
  await mkdir(MIGRATION_REPORT_DIR, { recursive: true })
  const projectLabel = projectIds?.length ? projectIds.join('-') : 'all'
  const modeLabel = report.mode === 'apply' ? 'apply' : 'dry-run'
  const timeLabel = String(report.generatedAt || new Date().toISOString())
    .replace(/[^0-9]/g, '')
    .slice(0, 17)
  const reportPath = path.join(
    MIGRATION_REPORT_DIR,
    `legacy-media-${projectLabel}-${modeLabel}-${timeLabel}-${process.pid}.json`,
  )
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return reportPath
}

async function main() {
  const apply = process.argv.includes('--apply')
  const projectIds = parseProjectIds()
  const remoteOptions = remoteMigrationOptions()
  const db = makePool()
  const objectStorage = createObjectStorageFromEnv({
    ...process.env,
    OBJECT_STORAGE_PUBLIC_BASE_URL:
      process.env.OBJECT_STORAGE_PUBLIC_BASE_URL ||
      `${process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:8000'}/storage`,
  })

  try {
    const records = await loadRecords(db, projectIds)
    const plans = await annotateLocalSourceStatus(
      buildMediaMigrationPlan({
        roots: DEFAULT_ROOTS,
        records,
        remote: remoteOptions,
      }),
    )
    const report = {
      mode: apply ? 'apply' : 'dry-run',
      projectIds,
      generatedAt: new Date().toISOString(),
      summary: summarizeMediaMigrationPlans(plans),
      plans,
    }

    if (apply) {
      const applied = await applyPlans(db, plans, objectStorage, remoteOptions)
      report.appliedSummary = summarizeMediaMigrationPlans(applied)
      report.appliedPlans = applied
    }

    report.reportPath = await writeReport(report, projectIds)
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await db.end()
  }
}

await main()
