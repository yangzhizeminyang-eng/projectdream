// FastAPI-Only 迁移第六阶段：试播集脚本默认上游由 Node API 切换为 FastAPI（默认 8000，环境变量可覆盖）。
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'

import {
  buildDeadBossGenerationPlan,
  buildDeadBossPilotCandidatePlan,
  validateDeadBossPilotCandidatePlan,
} from './dead-boss-episode-one-pilot-plan.mjs'
import { DEAD_BOSS_SHOTS } from './dead-boss-episode-one-plan.mjs'
import { buildPilotAudioGenerationRequest } from '../server/services/pilot-audio-request.mjs'
import { selectReusablePilotCandidates } from '../server/services/pilot-candidate-idempotency.mjs'
import { buildVoiceLockSnapshot } from '../server/services/voice-lock-policy.mjs'

const DEFAULT_PROJECT_ID = 28
const DEFAULT_RUN_ID = 4
const API_ORIGIN = process.env.PROJECTDREAM_API_ORIGIN || 'http://127.0.0.1:8000'
const API_BASE = `${API_ORIGIN}/api`
const PRODUCTION_BATCH = 'dead-boss-episode-one-v1'
const POLL_INTERVAL_MS = 3000
const JOB_TIMEOUT_MS = 45 * 60 * 1000

const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 2,
}

const SPEAKER_NAMES = {
  'tang-ning': '唐宁',
  'zhao-heng': '赵衡',
  'zhao-qiming': '赵启明',
}

function fail(message) {
  throw new Error(message)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function text(value) {
  return String(value ?? '').trim()
}

function parseArgs(args = []) {
  const valueFor = (name, fallback = '') => {
    const arg = args.find((item) => item.startsWith(`${name}=`))
    return arg ? arg.slice(name.length + 1).trim() : fallback
  }
  const shotsValue = valueFor('--shots')

  return {
    projectId: Number(valueFor('--project-id', String(DEFAULT_PROJECT_ID))) || DEFAULT_PROJECT_ID,
    runId: Number(valueFor('--run-id', String(DEFAULT_RUN_ID))) || DEFAULT_RUN_ID,
    phase: valueFor('--phase', 'images'),
    shotKeys: shotsValue
      ? [...new Set(shotsValue.split(',').map((item) => item.trim()).filter(Boolean))]
      : undefined,
    dryRun: args.includes('--dry-run'),
    advanceRun: args.includes('--advance-run'),
    completeStage: args.includes('--complete-stage'),
    refresh: args.includes('--refresh'),
  }
}

function dbConnection() {
  return mysql.createConnection(dbConfig)
}

async function getAuthToken(db, projectId) {
  const [rows] = await db.execute(
    `SELECT token
     FROM sessions
     WHERE user_id = (SELECT user_id FROM projects WHERE id = ? LIMIT 1)
       AND revoked_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [projectId],
  )
  if (!rows[0]?.token) fail(`项目 ${projectId} 没有可用登录会话，请先在本地页面登录`)
  return rows[0].token
}

async function apiRequest(token, pathname, options = {}) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.code) {
    fail(`${options.method || 'GET'} ${pathname} 失败：${body?.message || `HTTP ${response.status}`}`)
  }
  return body.data
}

async function loadEpisodeContext(db, projectId, { allowPartial = false } = {}) {
  const [storyboardRows] = await db.execute(
    `SELECT sb.id, sb.shot_no, sb.character_id, sb.character_name
     FROM storyboards sb
     INNER JOIN script_scenes sc ON sc.id = sb.scene_id
     WHERE sc.project_id = ?
     ORDER BY sc.scene_no, sb.sort_order, sb.id`,
    [projectId],
  )
  if (!allowPartial && storyboardRows.length !== 9) {
    fail(`项目 ${projectId} 当前不是《死去的老板给我发邮件》第1集的 9 镜头版本，实际为 ${storyboardRows.length} 个`)
  }
  if (allowPartial && storyboardRows.length === 0) {
    fail(`项目 ${projectId} 当前没有可用分镜，无法执行局部候选生成`)
  }

  const storyboardIds = {}
  for (const row of storyboardRows) storyboardIds[`shot-${row.shot_no}`] = Number(row.id)

  const [characterRows] = await db.execute(
    `SELECT id, name, voice_profile_key, voice_setting, voice_style, voice_locked
     FROM characters
     WHERE project_id = ? AND status <> 'archived'
     ORDER BY id ASC`,
    [projectId],
  )
  const characterIds = {}
  const characterRowsByName = new Map()
  for (const row of characterRows) characterRowsByName.set(text(row.name), row)
  for (const [key, name] of Object.entries(SPEAKER_NAMES)) {
    const row = characterRowsByName.get(name)
    if (!row) fail(`项目 ${projectId} 缺少角色：${name}`)
    characterIds[key] = Number(row.id)
  }

  return {
    storyboardRows,
    storyboardIds,
    characterRows,
    characterIds,
  }
}

function buildStoryboardIdMap(storyboardRows) {
  const map = {}
  for (const row of storyboardRows) {
    const sourceShot = DEAD_BOSS_SHOTS.find(
      (shot) => String(shot.shotNo) === String(row.shot_no),
    )
    if (sourceShot) map[sourceShot.key] = Number(row.id)
  }
  return map
}

async function runControlledWorker(jobId) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--env-file=.env.local', '--env-file-if-exists=.env.production', 'scripts/run-worker.mjs'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          APP_RUNTIME_ROLE: 'worker',
          GENERATION_WORKER_CONCURRENCY: '1',
          GENERATION_WORKER_MAX_JOBS: '1',
          GENERATION_WORKER_ONLY_JOB_ID: String(jobId),
          EXPORT_WORKER_ONLY_EXPORT_ID: '',
        },
        stdio: 'inherit',
        windowsHide: true,
      },
    )
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`worker for job #${jobId} exited with code ${code}`))
    })
  })
}

async function waitForJob(token, jobId) {
  const deadline = Date.now() + Math.min(JOB_TIMEOUT_MS, 5 * 60 * 1000)
  while (Date.now() < deadline) {
    const job = await apiRequest(token, `/generation-jobs/${jobId}`)
    if (job.status === 'success') return job
    if (job.status === 'failed' || job.status === 'canceled') {
      fail(`generation_job #${jobId} ${job.status}: ${job.errorText || job.lastErrorCode || 'unknown error'}`)
    }
    await sleep(POLL_INTERVAL_MS)
  }
  fail(`generation_job #${jobId} polling timed out`)
}

async function loadRun(db, token, projectId, requestedRunId) {
  if (requestedRunId > 0) return apiRequest(token, `/production-runs/${requestedRunId}`)
  const [rows] = await db.execute(
    `SELECT id
     FROM production_runs
     WHERE project_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [projectId],
  )
  if (!rows[0]?.id) fail(`项目 ${projectId} 没有 ProductionRun`)
  return apiRequest(token, `/production-runs/${Number(rows[0].id)}`)
}

async function advanceRunToCandidateGeneration(token, detail) {
  let current = detail
  if (
    current.run.currentCheckpoint === 'market-validation' &&
    current.run.status === 'waiting_approval'
  ) {
    current = await apiRequest(
      token,
      `/production-runs/${current.run.id}/checkpoints/market-validation/decision`,
      {
        method: 'POST',
        body: JSON.stringify({
          decision: 'approve',
          note: '项目负责人确认按原创《死去的老板给我发邮件》第1集进入两场景样片生产。',
        }),
      },
    )
  }
  if (current.run.currentCheckpoint === 'blueprint' && current.run.status === 'waiting_approval') {
    current = await apiRequest(
      token,
      `/production-runs/${current.run.id}/checkpoints/blueprint/decision`,
      {
        method: 'POST',
        body: JSON.stringify({
          decision: 'approve',
          note: '第1集 9 镜头蓝图、角色快照、逐句声线和连续性契约已锁定。',
        }),
      },
    )
  }
  if (current.run.currentStage === 'emotion-design' && !current.run.currentCheckpoint) {
    current = await apiRequest(
      token,
      `/production-runs/${current.run.id}/stages/emotion-design/complete`,
      {
        method: 'POST',
        body: JSON.stringify({
          outputSnapshot: {
            planVersion: PRODUCTION_BATCH,
            sceneKeys: ['dead-boss-scene-1', 'dead-boss-scene-2'],
            shotCount: 9,
            audioSegmentCount: 10,
          },
          note: '第1集两场景情绪段、镜头主动作、起止状态和声线锁定已完成，进入候选生成。',
        }),
      },
    )
  }
  return current
}

async function updateCandidateStageSnapshot(db, runId, phase, results) {
  const snapshot = {
    phase,
    mode: 'candidate-only',
    productionBatch: PRODUCTION_BATCH,
    updatedAt: new Date().toISOString(),
    results,
  }
  await db.execute(
    `UPDATE production_stage_runs
     SET status = 'running', output_snapshot_json = ?, started_at = COALESCE(started_at, NOW()), updated_at = NOW()
     WHERE production_run_id = ? AND stage_key = 'candidate-generation'`,
    [JSON.stringify(snapshot), runId],
  )
  const [executionRows] = await db.execute(
    `SELECT ae.id
     FROM production_agent_executions ae
     INNER JOIN production_stage_runs ps ON ps.id = ae.stage_run_id
     WHERE ps.production_run_id = ? AND ps.stage_key = 'candidate-generation'
     ORDER BY ae.id DESC
     LIMIT 1`,
    [runId],
  )
  if (!executionRows[0]?.id) return
  await db.execute(
    `UPDATE production_agent_executions
     SET status = 'running', output_json = ?, started_at = COALESCE(started_at, NOW()), updated_at = NOW()
     WHERE id = ?`,
    [JSON.stringify(snapshot), Number(executionRows[0].id)],
  )
}

async function loadCandidateRows(db, table, storyboardId, filters = {}) {
  const conditions = ['storyboard_id = ?', "status = 'candidate'"]
  const values = [storyboardId]
  for (const [column, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue
    conditions.push(`${column} = ?`)
    values.push(value)
  }
  const [rows] = await db.execute(
    `SELECT *
     FROM ${table}
     WHERE ${conditions.join(' AND ')}
     ORDER BY version_no DESC, id ASC`,
    values,
  )
  return rows
}

async function generateImageCandidates(token, db, job, { refresh = false } = {}) {
  const existingRows = await loadCandidateRows(db, 'image_assets', job.storyboardId, {
    model_name: job.image.modelName,
  })
  const existing = refresh
    ? { items: [], matchedCount: 0, enough: false }
    : selectReusablePilotCandidates(existingRows, {
      candidateCount: job.image.candidateCount,
      modelName: job.image.modelName,
    })
  if (existing.enough) return { reused: true, items: existing.items }

  const response = await apiRequest(token, `/shots/${job.storyboardId}/images/generate`, {
    method: 'POST',
    body: JSON.stringify({
      modelName: job.image.modelName,
      frameRole: job.image.frameRole,
      candidateCount: Math.max(1, job.image.candidateCount - existing.matchedCount),
      negativePrompt:
        '改变脸型，改变发型，改变服装，多余人物，多余道具，英文对白，英文字幕，随机文字，水印，黑边，血腥，肢体伤害',
    }),
  })
  await runControlledWorker(Number(response.id))
  const completed = await waitForJob(token, Number(response.id))
  return {
    jobId: Number(response.id),
    items: [...existing.items, ...(completed.result?.items || [])],
    reusedCount: existing.matchedCount,
  }
}

function parseSnapshot(value) {
  if (value && typeof value === 'object') return value
  try {
    return JSON.parse(String(value || ''))
  } catch {
    return null
  }
}

async function generateAudioCandidate(token, db, projectId, job) {
  const textValue = text(job.text)
  const audioRequest = buildPilotAudioGenerationRequest({
    storyboardId: job.storyboardId,
    audioCharacterId: job.characterId,
    text: textValue,
    durationSeconds: job.durationSeconds,
    candidateCount: job.candidateCount,
  })
  const existingRows = await loadCandidateRows(db, 'audio_assets', job.storyboardId, {
    production_batch: PRODUCTION_BATCH,
    character_id: audioRequest.characterId,
  })
  const existing = selectReusablePilotCandidates(existingRows, {
    candidateCount: job.candidateCount,
    productionBatch: PRODUCTION_BATCH,
    characterId: audioRequest.characterId,
    requireVoiceLockSnapshot: true,
    voiceLockSnapshot: { locked: true },
  })
  if (existing.enough) {
    return {
      reused: true,
      items: existing.items,
      speaker: SPEAKER_NAMES[job.speakerKey],
      text: textValue,
    }
  }

  const response = await apiRequest(token, `/projects/${projectId}/audio/generate`, {
    method: 'POST',
    body: JSON.stringify({
      ...audioRequest,
      candidateCount: Math.max(1, job.candidateCount - existing.matchedCount),
      productionBatch: PRODUCTION_BATCH,
      title: `《死去的老板给我发邮件》第1集 · ${job.shotNo} · ${SPEAKER_NAMES[job.speakerKey]}`,
    }),
  })
  const items = Array.isArray(response) ? response : response?.items || []
  return {
    items: [...existing.items, ...items],
    speaker: SPEAKER_NAMES[job.speakerKey],
    text: textValue,
    reusedCount: existing.matchedCount,
    voiceLockSnapshots: items.map((item) => parseSnapshot(item.voiceLockSnapshot || item.voice_lock_snapshot_json)),
  }
}

async function loadConfirmedImage(db, storyboardId) {
  const [rows] = await db.execute(
    `SELECT id
     FROM image_assets
     WHERE storyboard_id = ? AND status = 'confirmed'
     ORDER BY confirmed_at DESC, id DESC
     LIMIT 1`,
    [storyboardId],
  )
  return rows[0] ? Number(rows[0].id) : 0
}

async function generateVideoCandidates(token, db, job) {
  const imageId = await loadConfirmedImage(db, job.storyboardId)
  if (!imageId) {
    fail(`镜头 ${job.shotKey} 尚未人工确认新静帧，不能生成视频候选`)
  }
  const existingRows = await loadCandidateRows(db, 'video_assets', job.storyboardId, {
    production_batch: PRODUCTION_BATCH,
    image_asset_id: imageId,
    model_name: job.video.modelName,
  })
  const existing = selectReusablePilotCandidates(existingRows, {
    candidateCount: job.video.candidateCount,
    productionBatch: PRODUCTION_BATCH,
    imageAssetId: imageId,
    modelName: job.video.modelName,
  })
  if (existing.enough) return { reused: true, imageId, items: existing.items }

  const response = await apiRequest(token, `/storyboards/${job.storyboardId}/videos/generate`, {
    method: 'POST',
    body: JSON.stringify({
      modelName: job.video.modelName,
      motionMode: 'PAN',
      durationSeconds: Math.max(1, Math.min(12, Number(job.durationSeconds) || 5)),
      candidateCount: Math.max(1, job.video.candidateCount - existing.matchedCount),
      productionBatch: PRODUCTION_BATCH,
      autoConfirm: false,
    }),
  })
  await runControlledWorker(Number(response.id))
  const completed = await waitForJob(token, Number(response.id))
  return {
    jobId: Number(response.id),
    imageId,
    items: [...existing.items, ...(completed.result?.items || [])],
    reusedCount: existing.matchedCount,
  }
}

async function saveReport(phase, runId, report) {
  const filePath = path.join(tmpdir(), `projectdream-dead-boss-pilot-${runId}-${phase}.json`)
  await writeFile(filePath, JSON.stringify(report, null, 2), 'utf8')
  return filePath
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const db = await dbConnection()
  try {
    const token = await getAuthToken(db, options.projectId)
    let detail = await loadRun(db, token, options.projectId, options.runId)
    if (options.advanceRun && !options.dryRun) {
      detail = await advanceRunToCandidateGeneration(token, detail)
    }
    if (
      !options.dryRun &&
      (detail.run.currentStage !== 'candidate-generation' || detail.run.currentCheckpoint)
    ) {
      fail(
        `ProductionRun #${detail.run.id} 当前为 ${detail.run.currentStage}/${detail.run.currentCheckpoint || 'no-checkpoint'}；` +
          '请先完成市场验证、蓝图和情绪设计，或加 --advance-run。',
      )
    }

    const context = await loadEpisodeContext(db, options.projectId, {
      allowPartial: Boolean(options.shotKeys),
    })
    const plan = buildDeadBossPilotCandidatePlan({
      storyboardIds: buildStoryboardIdMap(context.storyboardRows),
      characterIds: context.characterIds,
      candidatePolicy: detail.run.candidatePolicy,
      productionBatch: PRODUCTION_BATCH,
    })
    if (options.shotKeys) {
      plan.shots = plan.shots.filter((shot) => options.shotKeys.includes(shot.shotKey))
      plan.audioSegments = plan.audioSegments.filter((segment) => options.shotKeys.includes(segment.shotKey))
    }
    const candidateReport = validateDeadBossPilotCandidatePlan(plan, {
      allowPartial: Boolean(options.shotKeys),
    })
    if (!candidateReport.valid) fail(`候选计划无效：${candidateReport.errors.join('；')}`)

    const generationPlan = buildDeadBossGenerationPlan({ candidatePlan: plan })
    const baseReport = {
      projectId: options.projectId,
      runId: detail.run.id,
      phase: options.phase,
      productionBatch: PRODUCTION_BATCH,
      sceneKeys: plan.sceneKeys,
      candidateSummary: candidateReport.summary,
      generationPlan: {
        jobs: generationPlan.jobs.map((job) => ({
          shotKey: job.shotKey,
          storyboardId: job.storyboardId,
          imageCandidates: job.image.candidateCount,
          videoCandidates: job.video.candidateCount,
          autoConfirm: false,
        })),
        audioJobs: generationPlan.audioJobs.map((job) => ({
          key: job.key,
          shotKey: job.shotKey,
          storyboardId: job.storyboardId,
          speaker: SPEAKER_NAMES[job.speakerKey],
          text: job.text,
          audioCandidates: job.candidateCount,
          autoConfirm: false,
        })),
      },
      mode: 'candidate-only',
    }

    if (options.dryRun) {
      const reportPath = await saveReport(options.phase, detail.run.id, baseReport)
      console.log(JSON.stringify({ ...baseReport, reportPath }, null, 2))
      return
    }

    const results = []
    const workItems =
      options.phase === 'audio'
        ? generationPlan.audioJobs
        : generationPlan.jobs
    for (const job of workItems) {
      let result = { key: job.key || job.shotKey, shotKey: job.shotKey, storyboardId: job.storyboardId }
      try {
        if (options.phase === 'images') {
          result.image = await generateImageCandidates(token, db, job, { refresh: options.refresh })
        } else if (options.phase === 'audio') {
          result.audio = await generateAudioCandidate(token, db, options.projectId, job)
        } else if (options.phase === 'videos') {
          result.video = await generateVideoCandidates(token, db, job)
        } else {
          fail(`不支持的 phase：${options.phase}。请使用 images、audio 或 videos`)
        }
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error)
        console.error(JSON.stringify({ ...result, status: 'failed' }))
      }
      results.push(result)
      await updateCandidateStageSnapshot(db, detail.run.id, options.phase, results)
      console.log(JSON.stringify(result))
    }

    const report = { ...baseReport, results }
    if (options.completeStage) {
      const completed = await apiRequest(
        token,
        `/production-runs/${detail.run.id}/stages/candidate-generation/complete`,
        {
          method: 'POST',
          body: JSON.stringify({
            outputSnapshot: report,
            note: '第1集候选资产已生成，仍等待人工或 Agent 筛选；任何候选均未自动确认。',
          }),
        },
      )
      report.nextRun = completed.run
    }
    const reportPath = await saveReport(options.phase, detail.run.id, report)
    console.log(JSON.stringify({ ...report, reportPath }, null, 2))
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
