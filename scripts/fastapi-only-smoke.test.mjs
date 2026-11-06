// FastAPI-Only 交付物一致性修复 · Task 2（fix-fastapi-only-handover）：fastapi-only-smoke.mjs 自身单测。
//
// 运行：node --test scripts/fastapi-only-smoke.test.mjs
//
// 以 node:http 起临时假服务器模拟 FastAPI 网关与 SPA fallback 形状，对冒烟脚本
// 双目标模式自测：
//   · 公网黑盒（默认）：不直连 /health /ready（经 Nginx 会命中 SPA fallback），
//     改以 4040/4010 收口 envelope 逐字段断言；probe 对 200+text/html 标记
//     isJson:false → 形状判定 FAIL，杜绝「SPA HTML 被判健康」假阳性；
//   · 容器内 readiness（--exec-compose）：exec 命令构造 dry-run 断言（注入 fake
//     exec，不真跑 docker）+ exec 输出 JSON 形状 PASS/FAIL 判定；
//   · 登录态链路：临时项目 SMOKE-<短uuid> 唯一命名，成功/失败路径（含抛异常）
//     finally 清理，删除失败仅告警不中断；删除只针对本次创建的 project id。
// 全部网络/子进程交互均 mock/stub（假服务器或注入 exec），单测不触达真实 docker。
// 本机无运行中的 api 服务（Docker engine 异常），真实环境冒烟列待云端。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseComposeServices, probe, shapeOk, buildExecComposeCommand, runSmoke, usage } from './fastapi-only-smoke.mjs'

const CLI_PATH = fileURLToPath(new URL('./fastapi-only-smoke.mjs', import.meta.url))

/**
 * 启动模拟 FastAPI 网关的临时假服务器。
 * @param {{ failReady?: boolean, wrongFallback?: boolean, spaFallback?: boolean,
 *           driftedAuth?: boolean, failProjectDetail?: boolean, failDelete?: boolean }} [options] 故障注入项。
 * @returns {Promise<{ baseUrl: string, close: () => Promise<void>, createdProjects: {id: number, name: string}[], deletedProjectIds: Set<number> }>}
 *   服务器句柄（createdProjects/deletedProjectIds 供临时项目清理断言）。
 */
async function startFakeGateway(options = {}) {
  const closedProjectIds = new Set()
  const createdProjects = []
  const deletedProjectIds = new Set()
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://localhost')
    const send = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    // 真实 /health 形状（main.py L2635）：非 envelope，{status,service,config}。
    if (url.pathname === '/health') return send(200, { status: 'ok', service: 'ProjectDream API' })
    if (url.pathname === '/ready') {
      return options.failReady
        ? send(503, { status: 'not_ready', checks: { mysql: false } })
        : send(200, { status: 'ready', checks: { mysql: true } })
    }
    if (url.pathname === '/api/definitely-not-a-route') {
      // spaFallback 注入：模拟 Nginx 配置漂移时 SPA fallback 截胡 /api 路径（200 + HTML）。
      if (options.spaFallback) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return response.end('<!doctype html><html><body>SPA</body></html>')
      }
      return send(404, { code: options.wrongFallback ? 5000 : 4040, message: '接口不存在', data: null })
    }
    if (url.pathname === '/api/projects/1/audio/generate' && request.method === 'POST') {
      return send(401, { code: 4010, message: '未登录或登录已过期', data: null })
    }
    if (url.pathname === '/api/projects' && request.method === 'GET') {
      const auth = String(request.headers.authorization || '')
      if (!auth.startsWith('Bearer ')) {
        // driftedAuth 注入：code 正确但 message/data 字段漂移，验证逐字段形状校验。
        return options.driftedAuth
          ? send(401, { code: 4010, message: '掉包文案', data: 'extra' })
          : send(401, { code: 4010, message: '未登录或登录已过期', data: null })
      }
      return send(200, { code: 0, message: 'success', data: { items: [] } })
    }
    if (url.pathname === '/api/auth/login-password' && request.method === 'POST') {
      let raw = ''
      request.on('data', (chunk) => {
        raw += chunk
      })
      return request.on('end', () => {
        const payload = JSON.parse(raw || '{}')
        if (payload.phone === '13912345678' && payload.password === '123456') {
          return send(200, { code: 0, message: '登录成功', data: { token: 'fake-token', user: { id: 1 } } })
        }
        return send(400, { code: 4011, message: '手机号或密码错误', data: null })
      })
    }
    if (url.pathname === '/api/projects' && request.method === 'POST') {
      let raw = ''
      request.on('data', (chunk) => {
        raw += chunk
      })
      return request.on('end', () => {
        const payload = JSON.parse(raw || '{}')
        const record = { id: 42, name: payload.name }
        createdProjects.push(record)
        return send(200, { code: 0, message: '项目创建成功', data: record })
      })
    }
    const detailMatch = url.pathname.match(/^\/api\/projects\/(\d+)$/)
    if (detailMatch) {
      const projectId = Number(detailMatch[1])
      if (request.method === 'GET') {
        if (!request.headers.authorization) return send(401, { code: 4010, message: '未登录', data: null })
        if (options.failProjectDetail) return send(500, { code: 5001, message: '模拟详情故障', data: null })
        if (closedProjectIds.has(projectId)) return send(404, { code: 4004, message: '项目不存在或无权访问', data: null })
        return send(200, { code: 0, message: 'success', data: { id: projectId } })
      }
      if (request.method === 'DELETE') {
        // 删除调用即使失败也登记（deletedProjectIds 断言「删除被调用」，与结果无关）。
        deletedProjectIds.add(projectId)
        if (options.failDelete) return send(500, { code: 5001, message: '模拟删除故障', data: null })
        closedProjectIds.add(projectId)
        return send(200, { code: 0, message: '项目已删除', data: { success: true } })
      }
    }
    return send(404, { code: 4040, message: '接口不存在', data: null })
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
    createdProjects,
    deletedProjectIds,
  }
}

/**
 * 启动恒返回 200 + text/html 的假 SPA 服务器（模拟 Nginx SPA fallback）。
 * @returns {Promise<{ baseUrl: string, close: () => Promise<void> }>} 服务器句柄。
 */
async function startHtmlServer() {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html><body>SPA</body></html>')
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((resolveClose) => server.close(resolveClose)) }
}

/**
 * 写入一次性 compose fixture。
 * @param {string} content - compose 文件内容。
 * @returns {string} compose 文件路径。
 */
function makeComposeFixture(content) {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-compose-'))
  const file = join(dir, 'docker-compose.yml')
  writeFileSync(file, content)
  return file
}

// --exec-compose 输出 mock 行（与真实 python 片段 print 的 JSON 行同形）。
const EXEC_HEALTH_OK = JSON.stringify({ path: 'http://127.0.0.1:8000/health', http: 200, body: { status: 'ok', service: 'ProjectDream API' } })
const EXEC_READY_OK = JSON.stringify({ path: 'http://127.0.0.1:8000/ready', http: 200, body: { status: 'ready', checks: { mysql: true } } })
const EXEC_READY_NOT_READY = JSON.stringify({ path: 'http://127.0.0.1:8000/ready', http: 503, body: { status: 'not_ready', checks: { mysql: false } } })

test('parseComposeServices extracts top-level service names', () => {
  const services = parseComposeServices(
    ['services:', '  mysql:', '    image: mysql:8.0.39', '  api:', '  worker-node:', '', 'volumes:', '  mysql_data:', '    name: x'].join('\n'),
  )
  assert.deepEqual(services, ['mysql', 'api', 'worker-node'])
})

test('probe flags 200 + text/html SPA fallback as non-JSON so shape checks fail', async () => {
  const spa = await startHtmlServer()
  const gateway = await startFakeGateway()
  try {
    // SPA fallback：HTTP 层 ok，但 Content-Type/解析均非 JSON → isJson:false、body 保留原文。
    const html = await probe(spa.baseUrl, '/health')
    assert.equal(html.ok, true)
    assert.equal(html.status, 200)
    assert.equal(html.isJson, false)
    assert.match(html.contentType, /text\/html/)
    assert.equal(html.body, '<!doctype html><html><body>SPA</body></html>')
    assert.equal(shapeOk(html, (body) => body.status === 'ok'), false, '形状判定必须 FAIL（SPA HTML 假阳性防护）')

    // 对照组：JSON 响应 isJson:true 且形状谓词可判定。
    const json = await probe(gateway.baseUrl, '/ready')
    assert.equal(json.isJson, true)
    assert.match(json.contentType, /application\/json/)
    assert.equal(shapeOk(json, (body) => body.status === 'ready'), true)
  } finally {
    await spa.close()
    await gateway.close()
  }
})

test('smoke passes against a healthy fake gateway (public mode, exit 0, chain SKIP without credentials)', async () => {
  const gateway = await startFakeGateway()
  try {
    const lines = []
    const { code, steps } = await runSmoke({
      baseUrl: gateway.baseUrl,
      log: (line) => lines.push(line),
    })
    assert.equal(code, 0)
    const byName = Object.fromEntries(steps.map((step) => [step.name, step.status]))
    // 公网黑盒：/health /ready 直连步骤不执行（宿主不可达且经 Nginx 命中 SPA fallback）。
    assert.equal(byName['GET /health'], undefined)
    assert.equal(byName['GET /ready'], undefined)
    assert.equal(byName['4040 收口抽查（GET /api/definitely-not-a-route）'], 'PASS')
    assert.equal(byName['TTS 原生路由鉴权（POST /api/projects/1/audio/generate）'], 'PASS')
    assert.equal(byName['鉴权 401 形状（GET /api/projects 未登录）'], 'PASS')
    assert.equal(byName['最小生成链路（登录 → 建项目 → 详情 → 删除 → 复查 404）'], 'SKIP')
    assert.ok(lines.some((line) => line.includes('公网黑盒')), '输出须注明公网黑盒模式')
    assert.ok(lines.some((line) => line.includes('SKIP') && line.includes('SMOKE_DEMO_PHONE')), 'SKIP 须明确输出原因')
  } finally {
    await gateway.close()
  }
})

test('public smoke CLI exits cleanly after fetch probes', async () => {
  const gateway = await startFakeGateway()
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_PATH, '--base-url', gateway.baseUrl, '--public'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('error', reject)
      child.on('close', (code, signal) => resolve({ code, signal, stderr }))
    })

    assert.equal(result.code, 0, `CLI should exit 0, stderr: ${result.stderr}`)
    assert.equal(result.signal, null)
    assert.doesNotMatch(result.stderr, /Assertion failed|UV_HANDLE_CLOSING/)
  } finally {
    await gateway.close()
  }
})

test('smoke fails with exit 1 when container /ready is not_ready (--exec-compose)', async () => {
  const calls = []
  const exec = (command, args) => {
    calls.push([command, ...args].join(' '))
    return { status: 0, stdout: [EXEC_HEALTH_OK, EXEC_READY_NOT_READY].join('\n'), stderr: '' }
  }
  const { code, steps } = await runSmoke({ execCompose: true, exec, log: () => {} })
  assert.equal(code, 1)
  assert.equal(steps.find((step) => step.name.startsWith('GET /ready')).status, 'FAIL')
  assert.equal(steps.find((step) => step.name.startsWith('GET /health')).status, 'PASS')
  // dry-run 命令构造断言：不真跑 docker，仅校验 exec 命令串内容。
  const commandLine = calls[0]
  for (const needle of ['docker compose', 'exec -T api', 'python -c', 'urllib.request.urlopen', 'http://127.0.0.1:8000/ready']) {
    assert.ok(commandLine.includes(needle), `exec 命令串须包含 ${needle}`)
  }
})

test('--exec-compose parses exec JSON output and passes with 容器内 readiness labeling', async () => {
  const exec = () => ({ status: 0, stdout: [EXEC_HEALTH_OK, EXEC_READY_OK].join('\n'), stderr: '' })
  const lines = []
  const { code, steps } = await runSmoke({ execCompose: true, exec, log: (line) => lines.push(line) })
  assert.equal(code, 0)
  const byName = Object.fromEntries(steps.map((step) => [step.name, step.status]))
  assert.equal(byName['GET /health（容器内 readiness）'], 'PASS')
  assert.equal(byName['GET /ready（容器内 readiness）'], 'PASS')
  assert.ok(lines.some((line) => line.includes('容器内 readiness')), '输出须标注容器内 readiness 模式')
})

test('--exec-compose passes --compose-file/--env-file through to the docker compose command', async () => {
  const calls = []
  const exec = (command, args) => {
    calls.push([command, ...args].join(' '))
    return { status: 0, stdout: [EXEC_HEALTH_OK, EXEC_READY_OK].join('\n'), stderr: '' }
  }
  await runSmoke({ execCompose: true, composeFile: '/tmp/docker-compose.yml', envFile: '/tmp/.env.production', exec, log: () => {} })
  assert.match(
    calls[0],
    /docker compose -f \/tmp\/docker-compose\.yml --env-file \/tmp\/\.env\.production exec -T api/,
    'compose 文件与环境文件须透传给 docker compose',
  )
  // 无透传项时构造裸命令（compose 默认读取 cwd 的 docker-compose.yml）。
  const bare = buildExecComposeCommand()
  assert.match(bare.commandLine, /^docker compose exec -T api/)
})

test('--exec-compose fails when exec output is not parseable JSON', async () => {
  const exec = () => ({ status: 0, stdout: 'spam output without json', stderr: '' })
  const { code, steps } = await runSmoke({ execCompose: true, exec, log: () => {} })
  assert.equal(code, 1)
  assert.equal(steps.find((step) => step.name.startsWith('GET /ready')).status, 'FAIL')
  assert.equal(steps.find((step) => step.name.startsWith('GET /health')).status, 'FAIL')
})

test('smoke fails when the fallback collector drifts away from 4040', async () => {
  const gateway = await startFakeGateway({ wrongFallback: true })
  try {
    const { code, steps } = await runSmoke({ baseUrl: gateway.baseUrl, log: () => {} })
    assert.equal(code, 1)
    assert.equal(steps.find((step) => step.name.startsWith('4040 收口抽查')).status, 'FAIL')
  } finally {
    await gateway.close()
  }
})

test('public mode fails closed when SPA fallback hijacks the 4040 probe path', async () => {
  const gateway = await startFakeGateway({ spaFallback: true })
  try {
    const { code, steps } = await runSmoke({ baseUrl: gateway.baseUrl, log: () => {} })
    assert.equal(code, 1)
    const step = steps.find((item) => item.name.startsWith('4040 收口抽查'))
    assert.equal(step.status, 'FAIL')
    assert.match(step.detail, /非 JSON/, 'FAIL 明细须指出响应非 JSON（SPA HTML 不再假阳性）')
  } finally {
    await gateway.close()
  }
})

test('public mode rejects drifted 4010 envelope field-by-field', async () => {
  const gateway = await startFakeGateway({ driftedAuth: true })
  try {
    const { code, steps } = await runSmoke({ baseUrl: gateway.baseUrl, log: () => {} })
    assert.equal(code, 1)
    assert.equal(steps.find((step) => step.name.startsWith('鉴权 401 形状')).status, 'FAIL')
  } finally {
    await gateway.close()
  }
})

test('minimal generation chain runs end-to-end with demo credentials and cleans up exactly the created project', async () => {
  const gateway = await startFakeGateway()
  try {
    const { code, steps } = await runSmoke({
      baseUrl: gateway.baseUrl,
      demoPhone: '13912345678',
      demoPassword: '123456',
      log: () => {},
    })
    assert.equal(code, 0)
    const chain = steps.find((step) => step.name.startsWith('最小生成链路'))
    assert.equal(chain.status, 'PASS')
    assert.match(chain.detail, /404（无痕）/)
    // 临时项目唯一命名（SMOKE- + 短 uuid）且删除只针对本次创建的 project id。
    assert.equal(gateway.createdProjects.length, 1)
    const [created] = gateway.createdProjects
    assert.match(created.name, /^SMOKE-[0-9a-f]{8}$/)
    assert.deepEqual([...gateway.deletedProjectIds], [created.id])
  } finally {
    await gateway.close()
  }
})

test('temp project is still deleted when a later chain step fails (finally cleanup)', async () => {
  const gateway = await startFakeGateway({ failProjectDetail: true })
  try {
    const { code } = await runSmoke({
      baseUrl: gateway.baseUrl,
      demoPhone: '13912345678',
      demoPassword: '123456',
      log: () => {},
    })
    assert.equal(code, 1)
    assert.equal(gateway.createdProjects.length, 1)
    assert.ok(
      gateway.deletedProjectIds.has(gateway.createdProjects[0].id),
      '失败路径也须删除本次创建的临时项目（finally 清理）',
    )
  } finally {
    await gateway.close()
  }
})

test('delete failure only warns without crashing the chain step', async () => {
  const gateway = await startFakeGateway({ failDelete: true })
  try {
    const lines = []
    const { code, steps } = await runSmoke({
      baseUrl: gateway.baseUrl,
      demoPhone: '13912345678',
      demoPassword: '123456',
      log: (line) => lines.push(line),
    })
    assert.equal(code, 1)
    assert.ok(gateway.deletedProjectIds.has(gateway.createdProjects[0].id), '删除调用须已发出')
    assert.ok(lines.some((line) => line.includes('清理失败')), '删除失败须输出告警')
    const chain = steps.find((step) => step.name.startsWith('最小生成链路'))
    assert.equal(chain.status, 'FAIL')
  } finally {
    await gateway.close()
  }
})

test('--check-compose asserts compose has no backend service with 静态结构检查 labeling and null-file skip', async () => {
  const gateway = await startFakeGateway()
  const clean = makeComposeFixture('services:\n  mysql:\n  api:\n  worker-node:\n  rag:\n  frontend:\n')
  const legacy = makeComposeFixture('services:\n  backend:\n  api:\n')
  try {
    const cleanResult = await runSmoke({
      baseUrl: gateway.baseUrl,
      composeFile: clean,
      checkCompose: true,
      log: () => {},
    })
    assert.equal(cleanResult.code, 0)
    const cleanStep = cleanResult.steps.find((step) => step.name.startsWith('--check-compose'))
    assert.equal(cleanStep.status, 'PASS')
    assert.match(`${cleanStep.name} ${cleanStep.detail}`, /静态结构检查/, '输出须标注「静态结构检查」')

    const legacyResult = await runSmoke({
      baseUrl: gateway.baseUrl,
      composeFile: legacy,
      checkCompose: true,
      log: () => {},
    })
    assert.equal(legacyResult.code, 1)
    assert.equal(legacyResult.steps.find((step) => step.name.startsWith('--check-compose')).status, 'FAIL')

    // composeFile=null：跳过并明确输出原因。
    const skipped = await runSmoke({ baseUrl: gateway.baseUrl, composeFile: null, checkCompose: true, log: () => {} })
    const skipStep = skipped.steps.find((step) => step.name.startsWith('--check-compose'))
    assert.equal(skipStep.status, 'SKIP')
    assert.match(skipStep.detail, /未提供 compose 文件，跳过/)
  } finally {
    await gateway.close()
    rmSync(clean, { force: true })
    rmSync(legacy, { force: true })
  }
})

test('usage text documents every flag including dual-target mode', () => {
  const text = usage()
  for (const flag of [
    '--base-url',
    '--check-compose',
    '--compose-file',
    '--env-file',
    '--exec-compose',
    '--public',
    '--demo-phone',
    '--demo-password',
    '--help',
  ]) {
    assert.ok(text.includes(flag), `用法缺少 ${flag}`)
  }
})
