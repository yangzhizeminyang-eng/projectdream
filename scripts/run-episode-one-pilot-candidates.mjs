// FastAPI-Only 迁移第六阶段：试播候选脚本默认上游由 Node API 切换为 FastAPI（默认 8000，环境变量可覆盖）。
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'

import {
  buildPilotCandidatePlan,
  normalizePilotCandidatePolicy,
  validatePilotCandidatePlan,
} from '../server/services/pilot-candidate-plan.mjs'
import {
  buildPilotGenerationPlan,
  validatePilotGenerationPlan,
} from '../server/services/pilot-generation-plan.mjs'
import { selectReusablePilotCandidates } from '../server/services/pilot-candidate-idempotency.mjs'
import { buildPilotAudioGenerationRequest } from '../server/services/pilot-audio-request.mjs'
import { buildNarrationVoiceLockSnapshot } from '../server/services/voice-lock-policy.mjs'

const DEFAULT_PROJECT_ID = 12
const API_ORIGIN = process.env.PROJECTDREAM_API_ORIGIN || 'http://127.0.0.1:8000'
const API_BASE = `${API_ORIGIN}/api`
const CURRENT_PRODUCTION_BATCH = 'episode-one-v2-continuity'
const POLL_INTERVAL_MS = 3000
const JOB_TIMEOUT_MS = 30 * 60 * 1000

const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 2,
}

function fail(message) {
  throw new Error(message)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseArgs(args = []) {
  const valueFor = (name, fallback = '') => {
    const arg = args.find((item) => item.startsWith(`${name}=`))
    return arg ? arg.slice(name.length + 1).trim() : fallback
  }
  const sceneValue = valueFor('--scenes')
  return {
    projectId: Number(valueFor('--project-id', DEFAULT_PROJECT_ID)) || DEFAULT_PROJECT_ID,
    runId: Number(valueFor('--run-id', '0')) || 0,
    phase: valueFor('--phase', 'images'),
    sceneKeys: sceneValue
      ? [...new Set(sceneValue.split(',').map((item) => item.trim()).filter(Boolean))]
      : undefined,
    dryRun: args.includes('--dry-run'),
    advanceRun: args.includes('--advance-run'),
    completeStage: args.includes('--complete-stage'),
  }
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value
  try {
    return JSON.parse(String(value || ''))
  } catch {
    return fallback
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
    fail(`${options.method || 'GET'} ${pathname} failed: ${body?.message || `HTTP ${response.status}`}`)
  }
  return body.data
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
  const deadline = Date.now() + JOB_TIMEOUT_MS
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
          note: '项目负责人确认进入第 1 集两场景黄金样片验证。',
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
          note: '单集蓝图已包含情绪段、完整声音约束和六/五/四倒计时规则。',
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
            planVersion: 'pilot-emotion-design-v1',
            sceneKeys: ['scene-one-broadcast-awakening', 'scene-two-memory-hit'],
          },
          note: '两场景情绪段与声音落点已锁定，进入候选生成。',
        }),
      },
    )
  }
  return current
}

function cleanDialogueText(value) {
  return String(value || '')
    .replace(/^[^：:]+(?:（[^）]*）)?\s*[：:]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function speakerNameFor(job) {
  if (job.dialogueText.includes('苏岚')) return '苏岚'
  if (job.dialogueText.includes('周衡')) return '周衡'
  if (job.dialogueText.includes('林夏')) return '林夏'
  return job.characterName || ''
}

async function updateCandidateStageSnapshot(db, runId, phase, results) {
  const snapshot = {
    phase,
    mode: 'candidate-only',
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

async function loadLatestCandidateAssets(db, table, storyboardId, modelName, filters = {}) {
  const conditions = ['storyboard_id = ?', "status = 'candidate'"]
  const values = [storyboardId]
  if (modelName) {
    conditions.push('model_name = ?')
    values.push(modelName)
  }
  if (filters.productionBatch) {
    conditions.push('production_batch = ?')
    values.push(filters.productionBatch)
  }
  if (filters.imageAssetId) {
    conditions.push('image_asset_id = ?')
    values.push(filters.imageAssetId)
  }
  if (filters.characterId) {
    conditions.push('character_id = ?')
    values.push(filters.characterId)
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

async function generateImageCandidates(token, db, job) {
  const existingRows = await loadLatestCandidateAssets(
    db,
    'image_assets',
    job.storyboardId,
    job.image.modelName,
  )
  const existing = selectReusablePilotCandidates(existingRows, {
    candidateCount: job.image.candidateCount,
    modelName: job.image.modelName,
  })
  if (existing.enough) {
    return {
      reused: true,
      items: existing.items,
    }
  }
  const response = await apiRequest(token, `/shots/${job.storyboardId}/images/generate`, {
    method: 'POST',
    body: JSON.stringify({
      modelName: job.image.modelName,
      frameRole: job.image.frameRole,
      candidateCount: Math.max(1, job.image.candidateCount - existing.matchedCount),
      negativePrompt: '换脸，改变服装，改变发型，多余人物，文字水印，字幕，黑边，血腥，肢体伤害',
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

async function generateAudioCandidates(token, db, projectId, job) {
  const text = cleanDialogueText(job.dialogueText)
  if (!text || !job.audio) return null
  const audioRequest = buildPilotAudioGenerationRequest({
    storyboardId: job.storyboardId,
    audioCharacterId: job.audioCharacterId,
    text,
    durationSeconds: job.durationSeconds,
    candidateCount: job.audio.candidateCount,
  })
  const existingRows = await loadLatestCandidateAssets(
    db,
    'audio_assets',
    job.storyboardId,
    audioRequest.modelName,
    {
      productionBatch: CURRENT_PRODUCTION_BATCH,
      characterId: audioRequest.characterId,
    },
  )
  const expectedVoiceLockSnapshot =
    audioRequest.trackType === 'narration'
      ? buildNarrationVoiceLockSnapshot({
          characterName: audioRequest.characterName || '苏岚',
          voiceProfile: {
            profileKey: audioRequest.voiceProfileKey,
            voiceId: audioRequest.voiceName,
            modelName: audioRequest.modelName,
            languageType: audioRequest.languageType,
          },
          languageType: audioRequest.languageType,
        })
      : { version: 'voice-lock-v1', locked: true }
  const existing = selectReusablePilotCandidates(existingRows, {
    candidateCount: job.audio.candidateCount,
    productionBatch: CURRENT_PRODUCTION_BATCH,
    modelName: audioRequest.modelName,
    characterId: audioRequest.characterId,
    requireVoiceLockSnapshot: true,
    voiceLockSnapshot: expectedVoiceLockSnapshot,
  })
  if (existing.enough) {
    return {
      reused: true,
      items: existing.items,
      speaker: speakerNameFor(job),
      text,
    }
  }
  const response = await apiRequest(token, `/projects/${projectId}/audio/generate`, {
    method: 'POST',
    body: JSON.stringify({
      ...audioRequest,
      candidateCount: Math.max(1, audioRequest.candidateCount - existing.matchedCount),
    }),
  })
  return {
    items: [
      ...existing.items,
      ...(Array.isArray(response) ? response : response?.items || []),
    ],
    speaker: speakerNameFor(job),
    text,
    reusedCount: existing.matchedCount,
  }
}

async function generateVideoCandidates(token, db, job) {
  const imageId = await loadConfirmedImage(db, job.storyboardId)
  if (!imageId) {
    fail(`镜头 ${job.shotKey} 尚未确认新静帧，不能生成视频候选`)
  }
  const existingRows = await loadLatestCandidateAssets(
    db,
    'video_assets',
    job.storyboardId,
    job.video.modelName,
    {
      productionBatch: CURRENT_PRODUCTION_BATCH,
      imageAssetId: imageId,
    },
  )
  const existing = selectReusablePilotCandidates(existingRows, {
    candidateCount: job.video.candidateCount,
    productionBatch: CURRENT_PRODUCTION_BATCH,
    modelName: job.video.modelName,
    imageAssetId: imageId,
  })
  if (existing.enough) {
    return {
      reused: true,
      imageId,
      items: existing.items,
    }
  }
  const response = await apiRequest(token, `/storyboards/${job.storyboardId}/videos/generate`, {
    method: 'POST',
    body: JSON.stringify({
      modelName: job.video.modelName,
      motionMode: 'PAN',
      durationSeconds: Math.max(1, Math.min(8, Number(job.durationSeconds) || 5)),
      candidateCount: Math.max(1, job.video.candidateCount - existing.matchedCount),
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

async function generateLipSyncCandidate(token, db, job) {
  if (!job.dialogueText || Number(job.characterId) !== 18) return null
  const [audioRows] = await db.execute(
    `SELECT id
     FROM audio_assets
     WHERE storyboard_id = ? AND track_type = 'dialogue' AND status = 'confirmed'
       AND character_id = ?
     ORDER BY confirmed_at DESC, id DESC
     LIMIT 1`,
    [job.storyboardId, Number(job.characterId)],
  )
  if (!audioRows[0]) fail(`镜头 ${job.shotKey} 尚未确认林夏对白音频，不能生成口型候选`)
  const response = await apiRequest(token, `/storyboards/${job.storyboardId}/lip-sync/generate`, {
    method: 'POST',
    body: JSON.stringify({ autoConfirm: false }),
  })
  await runControlledWorker(Number(response.id))
  const completed = await waitForJob(token, Number(response.id))
  return {
    jobId: Number(response.id),
    audioId: Number(audioRows[0].id),
    item: completed.result?.item || completed.result?.items?.[0] || null,
  }
}

async function saveReport(phase, runId, report) {
  const filePath = path.join(tmpdir(), `projectdream-pilot-run-${runId}-${phase}.json`)
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
        `ProductionRun #${detail.run.id} 当前为 ${detail.run.currentStage}/${detail.run.currentCheckpoint || 'no-checkpoint'}，` +
        '请先完成市场验证、蓝图和情绪设计；需要自动推进时加 --advance-run。',
      )
    }

    const candidatePlan = buildPilotCandidatePlan({
      sceneKeys: options.sceneKeys,
      candidatePolicy: normalizePilotCandidatePolicy(detail.run.candidatePolicy),
    })
    const candidateReport = validatePilotCandidatePlan(candidatePlan)
    if (!candidateReport.valid) fail(`候选计划无效：${candidateReport.errors.join('；')}`)

    const generationPlan = buildPilotGenerationPlan({ candidatePlan })
    const generationReport = validatePilotGenerationPlan(generationPlan)
    if (!generationReport.valid) fail(`生成计划无效：${generationReport.errors.join('；')}`)

    const baseReport = {
      projectId: options.projectId,
      runId: detail.run.id,
      phase: options.phase,
      sceneKeys: candidatePlan.sceneKeys,
      candidateSummary: candidateReport.summary,
      generationPlan: generationPlan.jobs.map((job) => ({
        shotKey: job.shotKey,
        storyboardId: job.storyboardId,
        imageCandidates: job.image.candidateCount,
        videoCandidates: job.video.candidateCount,
        audioCandidates: job.audio?.candidateCount || 0,
        autoConfirm: false,
      })),
      mode: 'candidate-only',
    }
    if (options.dryRun) {
      const reportPath = await saveReport(options.phase, detail.run.id, baseReport)
      console.log(JSON.stringify({ ...baseReport, reportPath }, null, 2))
      return
    }

    const results = []
    for (const job of generationPlan.jobs) {
      let result = { shotKey: job.shotKey, storyboardId: job.storyboardId }
      if (options.phase === 'images') {
        result.image = await generateImageCandidates(token, db, job)
      } else if (options.phase === 'audio') {
        result.audio = await generateAudioCandidates(token, db, options.projectId, job)
      } else if (options.phase === 'videos') {
        result.video = await generateVideoCandidates(token, db, job)
      } else if (options.phase === 'lipsync') {
        result.lipSync = await generateLipSyncCandidate(token, db, job)
      } else {
        fail(`不支持的 phase：${options.phase}。请使用 images、audio、videos 或 lipsync`)
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
            note: '候选资产已生成，等待人工或 Agent 筛选；未自动确认任何候选。',
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
