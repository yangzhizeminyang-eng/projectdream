// FastAPI-Only 迁移 · Task 2（fix-fastapi-only-handover）：FastAPI-Only 运行环境冒烟脚本（双目标模式）。
//
// 用法：
//   node scripts/fastapi-only-smoke.mjs [--public] [--check-compose] [--base-url <url>]
//                                       [--demo-phone <..>] [--demo-password <..>]
//   node scripts/fastapi-only-smoke.mjs --exec-compose [--compose-file <path>] [--env-file <path>]
//                                      [--check-compose] [--demo-phone <..>] [--demo-password <..>]
//   node scripts/fastapi-only-smoke.mjs --help
//
// 两种运行目标（双模式，任一 FAIL 退出码 1，SKIP 不影响）：
//   · 公网黑盒（默认 / --public）：对目标基址不做 /health /ready 直连探针——compose 中
//     api 仅 expose 8000 未发布宿主端口，且经 Nginx 访问非 /api 路径会命中 SPA fallback
//     返回 200 + text/html（假阳性源头）。改用 FastAPI 专有收口 envelope 逐字段断言：
//     4040 兜底（未知 /api 路径）、4010 鉴权（TTS 原生路由与通用受保护 API），
//     以证明流量确实打到 FastAPI 而非 SPA 静态回退；未登录探测不会触发生成。
//   · 容器内 readiness（--exec-compose）：经 `docker compose exec -T api python -c ...`
//     用镜像内标准库 urllib（python:3.12-slim 无 curl）探容器内 127.0.0.1:8000 的
//     /health 与 /ready，解决宿主机直连不可达问题。
// 假阳性防护：probe 解析 Content-Type 并标记 isJson（JSON 判定失败时 body 保留原文），
// 各步骤形状校验均要求 isJson —— SPA HTML 即使 HTTP 200 也判 FAIL。
// 登录态链路：仅创建唯一命名（SMOKE-<短uuid>）的临时项目，成功/失败路径（含抛异常）
// 均在 finally 尽力删除；删除失败仅告警不中断，既有项目数据零改动。
// [--check-compose] 为静态结构检查（仅解析 compose YAML 文本断言无 backend: 服务），
// 不执行任何 docker 命令。
//
// 本脚本零第三方依赖（node:http 全局 fetch + node:child_process spawnSync + 文本解析
// compose）。真实环境冒烟属云端部署项；本机无运行中的 api 服务时，脚本逻辑由
// scripts/fastapi-only-smoke.test.mjs 以临时 node:http 假服务器 + 注入 exec 自测。

import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_BASE_URL = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8000'
const DEFAULT_COMPOSE_FILE = join(REPO_ROOT, 'docker-compose.yml')
// 容器内 api 基址（api 容器内自探用；compose 仅 expose 8000）。
const CONTAINER_API_BASE_URL = 'http://127.0.0.1:8000'

/**
 * 解析 docker-compose.yml 顶层 services 段的一级服务名（无 yaml 依赖的缩进解析）。
 * @param {string} text - compose 文件全文。
 * @returns {string[]} 服务名列表（保持文件顺序）。
 */
export function parseComposeServices(text) {
  const lines = text.split(/\r?\n/)
  const services = []
  let inServices = false
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true
      continue
    }
    if (!inServices) continue
    if (/^[A-Za-z_]/.test(line)) break // 离开 services: 顶层块（volumes:/networks: 等）。
    const match = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
    if (match) services.push(match[1])
  }
  return services
}

/**
 * 单个冒烟步骤的 HTTP 探测（带 Content-Type/JSON 形状标记，SPA HTML 假阳性防护）。
 * @param {string} baseUrl - 目标基址。
 * @param {string} path - 请求路径。
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, timeoutMs?: number }} [options]
 *   请求选项（timeoutMs 默认 8000）。
 * @returns {Promise<{ ok: boolean, status: number, body: object|string|null, contentType: string, isJson: boolean, error?: string }>}
 *   探测结果：body 为「Content-Type 含 application/json 且可解析」的 JSON 时 isJson=true
 *   并解析为对象；否则 isJson=false 且 body 保留响应原文。网络异常时 ok=false、status=0。
 */
export async function probe(baseUrl, path, options = {}) {
  const { method = 'GET', headers = {}, body, timeoutMs = 8000 } = options
  try {
    const response = await fetch(new URL(path, baseUrl).toString(), {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    const contentType = (response.headers.get('content-type') || '').toLowerCase()
    let parsed = text
    let isJson = false
    try {
      parsed = JSON.parse(text)
      // 双重判定：可解析 + 服务端声明 application/json（防 text/html 恰好含 JSON 字面量）。
      isJson = contentType.includes('application/json')
    } catch {
      // 非 JSON 响应保留原文，isJson 保持 false（SPA HTML 假阳性防护）。
    }
    return { ok: response.ok, status: response.status, body: parsed, contentType, isJson }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      contentType: '',
      isJson: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * JSON 形状判定：探测结果必须是 FastAPI JSON 响应（isJson）且满足附加谓词。
 * 注意：本函数只做「JSON 形状」判定，HTTP 状态码由各步骤自行校验——
 * 因为收口 envelope（4040/4010）本身即 4xx 响应。
 * @param {{ isJson?: boolean, body?: unknown }} result - probe 返回值。
 * @param {(body: object) => boolean} [predicate] - 附加形状谓词（缺省仅要求 JSON 对象）。
 * @returns {boolean} isJson 为 true、body 为对象且谓词（如给出）通过时 true。
 */
export function shapeOk(result, predicate) {
  if (!result || result.isJson !== true) return false
  if (!result.body || typeof result.body !== 'object') return false
  return predicate ? predicate(result.body) === true : true
}

/**
 * 构造容器内 readiness 的 python 探测片段（python:3.12-slim 无 curl，仅标准库 urllib）。
 * 对 /health 与 /ready 各输出一行 JSON：{"path","http","body"|"error"}（HTTPError 时
 * 仍读取响应体以供形状判定，如 /ready 的 503 not_ready）。
 * @param {string} containerBaseUrl - 容器内 api 基址。
 * @returns {string} python -c 脚本全文（含换行）。
 */
function buildContainerPythonSnippet(containerBaseUrl) {
  const urls = ['/health', '/ready'].map((path) => JSON.stringify(`${containerBaseUrl}${path}`)).join(',')
  return [
    'import json,urllib.request,urllib.error',
    `for url in (${urls}):`,
    '    try:',
    '        with urllib.request.urlopen(url, timeout=8) as resp:',
    '            print(json.dumps({"path": url, "http": resp.status, "body": json.loads(resp.read().decode())}))',
    '    except urllib.error.HTTPError as exc:',
    '        body = None',
    '        try:',
    '            body = json.loads(exc.read().decode())',
    '        except Exception:',
    '            body = None',
    '        print(json.dumps({"path": url, "http": exc.code, "body": body}))',
    '    except Exception as exc:',
    '        print(json.dumps({"path": url, "http": 0, "error": str(exc)}))',
  ].join('\n')
}

/**
 * 构造容器内 readiness 的 exec 命令（docker compose exec -T api python -c ...）。
 * @param {{ composeFile?: string|null, envFile?: string|null, containerBaseUrl?: string }} [options]
 *   composeFile 透传 -f（null 省略，compose 默认读 cwd 的 docker-compose.yml）；
 *   envFile 透传 --env-file；containerBaseUrl 为容器内 api 基址。
 * @returns {{ command: string, args: string[], commandLine: string }} 命令名、参数数组
 *   （供 spawnSync 使用，避免 shell 引号问题）与可展示的命令串。
 */
export function buildExecComposeCommand(options = {}) {
  const { composeFile = null, envFile = null, containerBaseUrl = CONTAINER_API_BASE_URL } = options
  const args = ['compose']
  if (composeFile) args.push('-f', composeFile)
  if (envFile) args.push('--env-file', envFile)
  args.push('exec', '-T', 'api', 'python', '-c', buildContainerPythonSnippet(containerBaseUrl))
  return { command: 'docker', args, commandLine: `docker ${args.join(' ')}` }
}

/**
 * 执行容器内 readiness 探测并解析输出。
 * @param {{ composeFile: string|null, envFile: string|null, containerBaseUrl: string, exec?: Function|null }} options
 *   exec 为可注入的执行器（单测 stub；签名 (command, args) => {status, stdout, stderr}），
 *   缺省使用 node:child_process spawnSync（30s 超时）。
 * @returns {{ status: number, items: Record<string, {http?: number, body?: object, error?: string}>, stderr: string }}
 *   进程退出码、按 path 索引的探测项（无法解析的行忽略）与 stderr 摘录。
 */
function runExecCompose({ composeFile, envFile, containerBaseUrl, exec }) {
  const { command, args } = buildExecComposeCommand({ composeFile, envFile, containerBaseUrl })
  const outcome = exec
    ? exec(command, args)
    : spawnSync(command, args, { encoding: 'utf8', timeout: 30000 })
  const items = {}
  const stdout = typeof outcome.stdout === 'string' ? outcome.stdout : ''
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const item = JSON.parse(trimmed)
      if (item && typeof item.path === 'string') items[item.path] = item
    } catch {
      // 非 JSON 行忽略（docker/compose 偶发噪音输出）。
    }
  }
  return { status: typeof outcome.status === 'number' ? outcome.status : -1, items, stderr: String(outcome.stderr || '') }
}

/**
 * 执行完整冒烟（步骤序列 + 汇总）。
 * @param {{ baseUrl?: string, composeFile?: string|null, checkCompose?: boolean,
 *           execCompose?: boolean, envFile?: string|null, containerBaseUrl?: string,
 *           exec?: Function|null,
 *           demoPhone?: string, demoPassword?: string, log?: (line: string) => void }} [options]
 *   冒烟配置：execCompose=true 走容器内 readiness（exec 可注入单测 stub）；否则公网黑盒。
 *   log 缺省为 console.log。
 * @returns {Promise<{ code: number, steps: { name: string, status: 'PASS'|'SKIP'|'FAIL', detail: string }[] }>}
 *   退出码与步骤明细。
 */
export async function runSmoke(options = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    composeFile = DEFAULT_COMPOSE_FILE,
    checkCompose = false,
    execCompose = false,
    envFile = null,
    containerBaseUrl = CONTAINER_API_BASE_URL,
    exec = null,
    demoPhone = process.env.SMOKE_DEMO_PHONE || '',
    demoPassword = process.env.SMOKE_DEMO_PASSWORD || '',
    log = (line) => console.log(line),
  } = options
  const steps = []
  const record = (name, status, detail) => {
    steps.push({ name, status, detail })
    log(`[${status}] ${name} — ${detail}`)
  }
  // 探测项的描述文本：JSON 用其形状，非 JSON（SPA HTML 等）显式标注 Content-Type。
  const describeBody = (result) =>
    result.isJson ? JSON.stringify(result.body) : `非 JSON（${result.contentType || '未知 Content-Type'}）`

  const modeLabel = execCompose
    ? `容器内 readiness（--exec-compose，经 docker compose exec api 探 ${containerBaseUrl}）`
    : '公网黑盒（默认/--public，不直连 /health /ready，以 4040/4010 收口形状验证）'
  log(`FastAPI-Only 冒烟：${modeLabel} · 目标 ${baseUrl}（--check-compose=${checkCompose ? 'on' : 'off'}）`)

  if (execCompose) {
    // 容器内 readiness：/health /ready 在 api 容器内自探（宿主机直连不可达）。
    const execProbe = runExecCompose({ composeFile, envFile, containerBaseUrl, exec })
    const healthItem = execProbe.items[`${containerBaseUrl}/health`]
    const healthOk =
      execProbe.status === 0 && healthItem && healthItem.http === 200 && healthItem.body && healthItem.body.status === 'ok'
    record(
      'GET /health（容器内 readiness）',
      healthOk ? 'PASS' : 'FAIL',
      healthOk
        ? `HTTP ${healthItem.http} status=ok（容器内 ${containerBaseUrl}/health）`
        : `执行退出码 ${execProbe.status}；${healthItem ? JSON.stringify(healthItem) : execProbe.stderr.slice(0, 200) || '无输出'}`,
    )
    const readyItem = execProbe.items[`${containerBaseUrl}/ready`]
    const readyOk =
      execProbe.status === 0 && readyItem && readyItem.http === 200 && readyItem.body && readyItem.body.status === 'ready'
    record(
      'GET /ready（容器内 readiness）',
      readyOk ? 'PASS' : 'FAIL',
      readyOk
        ? `checks=${JSON.stringify(readyItem.body?.checks)}（容器内 ${containerBaseUrl}/ready）`
        : `执行退出码 ${execProbe.status}；${readyItem ? JSON.stringify(readyItem) : execProbe.stderr.slice(0, 200) || '无输出'}`,
    )
  } else {
    // 1) 4040 收口抽查（公网黑盒主证据：SPA fallback 的 200 HTML 在此判 FAIL）。
    const fallback = await probe(baseUrl, '/api/definitely-not-a-route')
    const fallbackOk =
      fallback.status === 404 &&
      shapeOk(fallback, (body) => body.code === 4040 && body.message === '接口不存在' && body.data === null)
    record(
      '4040 收口抽查（GET /api/definitely-not-a-route）',
      fallbackOk ? 'PASS' : 'FAIL',
      fallbackOk
        ? 'HTTP 404 + code 4040「接口不存在」+ data=null（FastAPI JSON 形状）'
        : `HTTP ${fallback.status} ${describeBody(fallback)}${fallback.error ? ` ${fallback.error}` : ''}`,
    )

    // 2) TTS 原生路由鉴权抽查：不带凭据应在鉴权层返回 401，不触发生成或供应商计费。
    const ttsUnauthorized = await probe(baseUrl, '/api/projects/1/audio/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const ttsUnauthorizedOk =
      ttsUnauthorized.status === 401 &&
      shapeOk(ttsUnauthorized, (body) => body.code === 4010 && body.message === '未登录或登录已过期' && body.data === null)
    record(
      'TTS 原生路由鉴权（POST /api/projects/1/audio/generate）',
      ttsUnauthorizedOk ? 'PASS' : 'FAIL',
      ttsUnauthorizedOk
        ? 'HTTP 401 + code 4010（未登录即被鉴权拦截；未触发音频生成）'
        : `HTTP ${ttsUnauthorized.status} ${describeBody(ttsUnauthorized)}${ttsUnauthorized.error ? ` ${ttsUnauthorized.error}` : ''}`,
    )

    // 3) 鉴权 401 形状（未登录访问受保护资源，逐字段：code/message/data）。
    const unauthorized = await probe(baseUrl, '/api/projects')
    const unauthorizedOk =
      unauthorized.status === 401 &&
      shapeOk(
        unauthorized,
        (body) => body.code === 4010 && body.message === '未登录或登录已过期' && body.data === null,
      )
    record(
      '鉴权 401 形状（GET /api/projects 未登录）',
      unauthorizedOk ? 'PASS' : 'FAIL',
      unauthorizedOk
        ? 'HTTP 401 + code 4010「未登录或登录已过期」+ data=null（FastAPI JSON 形状）'
        : `HTTP ${unauthorized.status} ${describeBody(unauthorized)}${unauthorized.error ? ` ${unauthorized.error}` : ''}`,
    )
  }

  // --check-compose：编排层无 backend 服务（静态结构检查，仅解析 YAML 文本）。
  if (checkCompose) {
    if (!composeFile) {
      record('--check-compose 编排断言（静态结构检查）', 'SKIP', '未提供 compose 文件，跳过静态结构检查')
    } else if (!existsSync(composeFile)) {
      record(
        '--check-compose 编排断言（静态结构检查）',
        'FAIL',
        `compose 文件不存在：${composeFile}（静态结构检查仅解析 YAML 文本，不做 docker 访问）`,
      )
    } else {
      const services = parseComposeServices(readFileSync(composeFile, 'utf8'))
      const hasBackend = services.includes('backend')
      record(
        '--check-compose 编排断言（静态结构检查）',
        hasBackend ? 'FAIL' : 'PASS',
        hasBackend
          ? 'services 中仍存在 backend: 服务定义'
          : `静态结构检查通过（仅解析 YAML 文本，不做 docker 访问）：services=${services.join('/')}`,
      )
    }
  }

  // 最小生成链路（mock 口径，登录态可选）：未配凭据 SKIP。
  if (!demoPhone || !demoPassword) {
    record(
      '最小生成链路（登录 → 建项目 → 详情 → 删除 → 复查 404）',
      'SKIP',
      '未配置 SMOKE_DEMO_PHONE/SMOKE_DEMO_PASSWORD（--demo-phone/--demo-password），跳过登录态链路',
    )
  } else {
    // 临时项目唯一命名（SMOKE- + 短 uuid），try/finally 保证成功/失败路径（含抛异常）均清理。
    const projectName = `SMOKE-${randomUUID().slice(0, 8)}`
    let auth = null
    let projectId = null
    let createdName = projectName
    let detailStatus = 0
    let removedStatus = 0
    let goneStatus = 0
    let failureDetail = ''
    try {
      const login = await probe(baseUrl, '/api/auth/login-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: demoPhone, password: demoPassword }),
      })
      const token = login.ok && login.body && login.body.data && login.body.data.token
      if (!token) {
        failureDetail = `登录失败：HTTP ${login.status} ${JSON.stringify(login.body)}`
      } else {
        auth = { authorization: `Bearer ${token}` }
        const created = await probe(baseUrl, '/api/projects', {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ name: projectName, category: '冒烟' }),
        })
        projectId = created.ok && created.body && created.body.data && created.body.data.id
        if (!projectId) {
          failureDetail = `建项目失败：HTTP ${created.status} ${JSON.stringify(created.body)}`
        } else {
          createdName = (created.body.data && created.body.data.name) || projectName
          const detail = await probe(baseUrl, `/api/projects/${projectId}`, { headers: auth })
          detailStatus = detail.status
          if (detailStatus !== 200) failureDetail = `详情读取失败：HTTP ${detailStatus}`
        }
      }
    } finally {
      if (projectId && auth) {
        const removed = await probe(baseUrl, `/api/projects/${projectId}`, {
          method: 'DELETE',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ confirmName: createdName }),
        })
        const gone = await probe(baseUrl, `/api/projects/${projectId}`, { headers: auth })
        removedStatus = removed.status
        goneStatus = gone.status
        if (!removed.ok) {
          // 删除失败仅告警不中断脚本；链路仍因「未达成无痕」判 FAIL。
          log(
            `[WARN] 临时项目清理失败（仅告警，不中断脚本）：#${projectId}（${projectName}）HTTP ${removed.status} ${JSON.stringify(removed.body)}`,
          )
        }
      }
    }
    const chainOk = !failureDetail && detailStatus === 200 && removedStatus === 200 && goneStatus === 404
    record(
      '最小生成链路（登录 → 建项目 → 详情 → 删除 → 复查 404）',
      chainOk ? 'PASS' : 'FAIL',
      chainOk
        ? `登录 → 建项目 #${projectId}（${projectName}）→ 详情 200 → confirmName 删除 → 复查 404（无痕）`
        : failureDetail || `详情=${detailStatus} 删除=${removedStatus} 复查=${goneStatus}`,
    )
  }

  const failed = steps.some((step) => step.status === 'FAIL')
  const passed = steps.filter((step) => step.status === 'PASS').length
  const skipped = steps.filter((step) => step.status === 'SKIP').length
  log(`冒烟汇总：PASS ${passed} / SKIP ${skipped} / FAIL ${steps.length - passed - skipped} → 退出码 ${failed ? 1 : 0}`)
  return { code: failed ? 1 : 0, steps }
}

/**
 * 输出用法说明。
 * @returns {string} 用法文本。
 */
export function usage() {
  return [
    '用法：node scripts/fastapi-only-smoke.mjs [选项]',
    '',
    '两种运行目标（双模式）：',
    '  公网黑盒（默认 / --public）        不直连 /health /ready（api 未发布宿主端口，且经 Nginx',
    '                       访问会命中 SPA fallback 200 + text/html）；改用 FastAPI',
    '                       专有收口形状（4040/4010 envelope 逐字段）证明流量打到',
    '                       FastAPI，杜绝 SPA HTML 假阳性。',
    '  容器内 readiness（--exec-compose）  经 docker compose exec -T api 用镜像内 python',
    '                       urllib 探容器内 http://127.0.0.1:8000/health 与 /ready。',
    '',
    '失败退出码 1，SKIP 不影响退出码。',
    '',
    '选项：',
    '  --base-url <url>        公网模式目标基址（默认 env SMOKE_BASE_URL 或 http://127.0.0.1:8000）',
    '  --public                显式声明公网黑盒模式（缺省即公网黑盒）',
    '  --exec-compose          容器内 readiness 模式：docker compose exec api python -c urllib 探 /health /ready',
    '  --compose-file <path>   compose 文件路径（--exec-compose 透传 -f；--check-compose 静态解析；',
    '                          默认 <仓库根>/docker-compose.yml）',
    '  --env-file <path>       docker compose --env-file 透传（默认 env SMOKE_ENV_FILE）',
    '  --check-compose         静态结构检查：解析 compose 文件断言无 backend: 服务（不执行 docker 命令）',
    '  --demo-phone <phone>    最小生成链路登录手机号（默认 env SMOKE_DEMO_PHONE）',
    '  --demo-password <pwd>   登录口令（默认 env SMOKE_DEMO_PASSWORD）',
    '  --help                  显示本说明',
  ].join('\n')
}

// 主入口（被单测 import 时不执行）。
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) {
    console.log(usage())
    process.exit(0)
  }
  const readOption = (flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 && argv[index + 1] ? argv[index + 1] : undefined
  }
  const result = await runSmoke({
    baseUrl: readOption('--base-url') || DEFAULT_BASE_URL,
    composeFile: readOption('--compose-file') || DEFAULT_COMPOSE_FILE,
    envFile: readOption('--env-file') || process.env.SMOKE_ENV_FILE || null,
    execCompose: argv.includes('--exec-compose'),
    checkCompose: argv.includes('--check-compose'),
    demoPhone: readOption('--demo-phone') || process.env.SMOKE_DEMO_PHONE || '',
    demoPassword: readOption('--demo-password') || process.env.SMOKE_DEMO_PASSWORD || '',
  })
  process.exitCode = result.code
}
