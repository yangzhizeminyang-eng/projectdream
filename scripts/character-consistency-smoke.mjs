// FastAPI-Only 迁移第六阶段：冒烟脚本默认上游由 Node API 切换为 FastAPI（默认 8000，环境变量可覆盖）。
import { pathToFileURL } from 'node:url'

function normalizeApiBaseUrl(value) {
  return String(value || 'http://127.0.0.1:8000/api').trim().replace(/\/+$/, '')
}

export function assertSmokeResponse(response, label) {
  if (!response || Number(response.status) < 200 || Number(response.status) >= 300) {
    const message = String(response?.body?.message || '请求失败')
    throw new Error(`${label}: HTTP ${response?.status || 'unknown'} (${message})`)
  }
  if (response.body?.code !== 0) {
    throw new Error(`${label}: API code ${response.body?.code ?? 'unknown'} (${response.body?.message || '请求失败'})`)
  }
  return response.body
}

export function summarizeCharacterConsistencyResponse(projectId, payload) {
  const report = payload?.report || {}
  const summary = report.summary || {}
  return {
    projectId: Number(projectId),
    ready: Boolean(report.ready),
    totalCharacters: Number(summary.totalCharacters || 0),
    readyCharacters: Number(summary.readyCharacters || 0),
    blockedCharacters: Number(summary.blockedCharacters || 0),
    versionCount: Array.isArray(payload?.versions) ? payload.versions.length : 0,
    regressionSampleCount: Array.isArray(payload?.samples) ? payload.samples.length : 0,
    blockerCount: Array.isArray(report.blockers) ? report.blockers.length : 0,
    warningCount: Array.isArray(report.warnings) ? report.warnings.length : 0,
  }
}

export function isMainModule(moduleUrl, executablePath) {
  return Boolean(executablePath) && moduleUrl === pathToFileURL(executablePath).href
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  })
  let body = null
  try {
    body = await response.json()
  } catch {
    body = { message: '响应不是 JSON' }
  }
  return { status: response.status, body }
}

async function login(apiBaseUrl, phone, password) {
  const response = await requestJson(`${apiBaseUrl}/auth/login-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  })
  const payload = assertSmokeResponse(response, '演示账号登录')
  const token = String(payload.data?.token || '').trim()
  if (!token) throw new Error('演示账号登录: 响应缺少 token')
  return token
}

function assertConsistencyPayload(projectId, payload) {
  if (!payload?.report || !Array.isArray(payload.characters) || !Array.isArray(payload.versions)) {
    throw new Error(`项目 #${projectId} 一致性报告缺少 report / characters / versions`)
  }
  if (typeof payload.report.ready !== 'boolean') {
    throw new Error(`项目 #${projectId} 一致性报告缺少 ready 状态`)
  }
  const reportTotal = Number(payload.report.summary?.totalCharacters || 0)
  if (reportTotal !== payload.characters.length) {
    throw new Error(
      `项目 #${projectId} 一致性报告角色数不一致：report=${reportTotal}, characters=${payload.characters.length}`,
    )
  }
  if (payload.characters.length && payload.versions.length < payload.characters.length) {
    throw new Error(`项目 #${projectId} 至少有一个角色缺少初始角色版本`)
  }
}

export async function runCharacterConsistencySmoke(options = {}) {
  const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl || process.env.SMOKE_API_BASE_URL)
  const phone = String(options.phone || process.env.SMOKE_PHONE || '13912345678').trim()
  const password = String(options.password || process.env.SMOKE_PASSWORD || '123456').trim()

  const anonymous = await requestJson(`${apiBaseUrl}/projects/1/character-consistency`)
  if (anonymous.status !== 401) {
    throw new Error(`未登录一致性接口门禁异常：预期 HTTP 401，实际 HTTP ${anonymous.status}`)
  }

  const token = await login(apiBaseUrl, phone, password)
  const authorization = { Authorization: `Bearer ${token}` }
  const projectsPayload = assertSmokeResponse(
    await requestJson(`${apiBaseUrl}/projects`, { headers: authorization }),
    '项目列表',
  )
  const projects = Array.isArray(projectsPayload.data?.items) ? projectsPayload.data.items : []
  const reports = []

  for (const project of projects) {
    const projectId = Number(project?.id)
    if (!projectId) continue
    const payload = assertSmokeResponse(
      await requestJson(`${apiBaseUrl}/projects/${projectId}/character-consistency`, {
        headers: authorization,
      }),
      `项目 #${projectId} 一致性报告`,
    ).data
    assertConsistencyPayload(projectId, payload)
    reports.push(summarizeCharacterConsistencyResponse(projectId, payload))
  }

  return {
    apiBaseUrl,
    projectCount: reports.length,
    reports,
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runCharacterConsistencySmoke()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2))
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    })
}
