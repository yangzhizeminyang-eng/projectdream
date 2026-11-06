// FastAPI-Only 迁移第八阶段 · Task 8.1：assert-fastapi-only.mjs 自身单测。
//
// 运行：node --test scripts/assert-fastapi-only.test.mjs
//
// 对门禁脚本本身做单元测试：在临时 fixture 目录构造违例/豁免/结构规则场景，
// 验证七类禁用项的命中、EXEMPT_LINES 豁免同步解析、关键范围文件缺失防护与
// 退出码语义（0 = 全绿，1 = 违规或防护错误）。全部离线（临时目录，不触真实仓库）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseExemptLines, runChecks, scanFile, collectScanFiles } from './assert-fastapi-only.mjs'

/**
 * 构造一次性临时仓库 fixture（用完即删）。
 * @param {Record<string, string>} files - 相对路径 → 文件内容。
 * @returns {string} 临时仓库根目录。
 */
function makeFixtureRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'fastapi-only-guard-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, ...rel.split('/'))
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

/**
 * 写入最小合法骨架（关键范围文件防呆所需 + 空 EXEMPT 解析源）。
 * @param {Record<string, string>} extra - 追加文件。
 * @returns {string} 临时仓库根目录。
 */
function makeSkeleton(extra = {}) {
  return makeFixtureRepo({
    'docker-compose.yml': 'services:\n  api:\n    healthcheck:\n      test: ["CMD-SHELL", "python -c \\"import urllib.request; urllib.request.urlopen(\'http://127.0.0.1:8000/ready\', timeout=3)\\""]\n',
    'nginx.conf': 'server {\n  location /api/ {\n    proxy_pass http://api:8000;\n  }\n}\n',
    '.env.example': 'API_PORT=8000\n',
    '.env.production.example': 'API_PORT=8000\n',
    'api-service/Dockerfile': 'FROM python:3.12-slim\nCMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]\n',
    'api-service/app/main.py': 'def create_app():\n    return None\n',
    'api-service/tests/test_no_node_dependencies.py': 'EXEMPT_LINES = frozenset()\n',
    'scripts/deploy-production.sh': '#!/usr/bin/env bash\n',
    'Dockerfile.worker': 'FROM node:22-alpine\nCMD ["node", "server/index.mjs"]\n',
    'Dockerfile.frontend': 'FROM node:22-alpine AS build\nRUN npm run build\n',
    ...extra,
  })
}

test('parseExemptLines parses triplets and python escapes', () => {
  const source = [
    'EXEMPT_LINES: frozenset[tuple[str, int, str]] = frozenset(',
    '    {',
    '        ("scripts/run-worker.mjs", 5, "await import(\'../server/index.mjs\')"),',
    '        ("scripts/worker-healthcheck.test.mjs", 5, "function createFs({ cmdline = \'node\\\\u0000server/index.mjs\\\\u0000\', failPidRead = false } = {}) {"),',
    '    }',
    ')',
  ].join('\n')
  const parsed = parseExemptLines(source)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.lines.size, 2)
  assert.ok(parsed.lines.has("scripts/run-worker.mjs:5:await import('../server/index.mjs')"))
  // Python 字面量 \\u0000 求值后为字面反斜杠 + u0000，与实际文件内容对齐。
  assert.ok([...parsed.lines][1].includes('\\u0000server/index.mjs\\u0000'))
})

test('parseExemptLines reports drift when the registry is missing or empty', () => {
  assert.equal(parseExemptLines('X = 1').ok, false)
  assert.equal(parseExemptLines('EXEMPT_LINES = frozenset(\n    {\n    }\n)').ok, false)
})

test('line scan hits every banned category with file:line:content', () => {
  const root = makeSkeleton()
  const hits = scanFile(
    root,
    'api-service/app/main.py',
    new Set(),
  )
  // 骨架 main.py 无禁用词 → 零命中（防误报基线）。
  assert.deepEqual(hits, [])
  const dirty = makeSkeleton({ 'api-service/app/legacy.py': 'UP = os.environ["NODE_UPSTREAM_URL"]  # proxy_api\nFLAG = "API_NATIVE_PROJECTS"\nGO = "http://backend:3001"\nLEGACY = "server/index.mjs"\n' })
  const violations = scanFile(dirty, 'api-service/app/legacy.py', new Set())
  const categories = new Set(violations.map((v) => v.category))
  assert.ok(categories.has('1.Node-HTTP-API-引用'))
  assert.ok(categories.has('4.API_NATIVE-flag-残留'))
  assert.ok(categories.has('2.3001-端口引用'))
  assert.ok(categories.has('5.server-index-mjs-生产链路引用'))
  assert.equal(violations[0].rel, 'api-service/app/legacy.py')
  assert.equal(violations[0].line, 1)
  assert.ok(violations[0].content.includes('NODE_UPSTREAM_URL'))
  rmSync(dirty, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

test('exempt lines from pytest registry suppress matched rows only', () => {
  const root = makeSkeleton()
  const content = 'A = "server/index.mjs"\nB = "server/index.mjs"\n'
  writeFileSync(join(root, 'api-service', 'app', 'main.py'), content)
  const exempt = new Set(['api-service/app/main.py:1:A = "server/index.mjs"'])
  const hits = scanFile(root, 'api-service/app/main.py', exempt)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].line, 2, '未豁免的同类行仍须命中')
  rmSync(root, { recursive: true, force: true })
})

test('worker entry exemptions cover compose command and Dockerfile.worker CMD', () => {
  const root = makeSkeleton({
    'docker-compose.yml': 'services:\n  worker-node:\n    command: ["node", "server/index.mjs"]\n  api:\n    healthcheck: {}\n',
    'Dockerfile.worker': 'FROM node:22-alpine\nCMD ["node", "server/index.mjs"]\n',
  })
  const { code, violations } = runChecks(root, { exemptLines: new Set() })
  const workerEntry = violations.filter((v) => v.rel === 'docker-compose.yml' || v.rel === 'Dockerfile.worker')
  assert.deepEqual(workerEntry, [], 'Worker 执行体入口行应被结构豁免')
  assert.equal(code, 0)
  rmSync(root, { recursive: true, force: true })
})

test('structural rule 6 fails on Dockerfile.backend and compose backend service', () => {
  const root = makeSkeleton({
    'Dockerfile.backend': 'CMD ["node", "server/index.mjs"]\n',
    'docker-compose.yml': 'services:\n  backend:\n    image: node:22\n  api:\n    healthcheck: {}\n',
  })
  const { code, violations } = runChecks(root, { exemptLines: new Set() })
  assert.equal(code, 1)
  assert.ok(violations.some((v) => v.category === '6.Dockerfile.backend-应已改名'))
  assert.ok(violations.some((v) => v.category === '6.compose-backend-服务定义'))
  rmSync(root, { recursive: true, force: true })
})

test('structural rule 7 fails when the API image is node-based', () => {
  const root = makeSkeleton({
    'api-service/Dockerfile': 'FROM node:22-alpine\nRUN apt-get install -y nodejs\nCMD ["npm", "start"]\n',
  })
  const { code, violations } = runChecks(root, { exemptLines: new Set() })
  assert.equal(code, 1)
  const reasons = violations.filter((v) => v.category.startsWith('7.')).map((v) => v.category)
  assert.ok(reasons.some((c) => c.includes('FROM node 基础镜像')))
  assert.ok(reasons.some((c) => c.includes('nodejs 安装命令')))
  rmSync(root, { recursive: true, force: true })
})

test('missing required scope files fail closed with drift-guard errors', () => {
  const root = makeSkeleton()
  rmSync(join(root, 'nginx.conf'))
  const { code, errors } = runChecks(root, { exemptLines: new Set() })
  assert.equal(code, 1)
  assert.ok(errors.some((message) => message.includes('nginx.conf')))
  rmSync(root, { recursive: true, force: true })
})

test('missing pytest exempt source fails closed (exempt sync guard)', () => {
  const root = makeSkeleton()
  rmSync(join(root, 'api-service', 'tests', 'test_no_node_dependencies.py'))
  const { code, errors } = runChecks(root)
  assert.equal(code, 1)
  assert.ok(errors.some((message) => message.includes('EXEMPT_LINES') || message.includes('豁免同步来源缺失')))
  rmSync(root, { recursive: true, force: true })
})

test('runChecks exits 0 on a clean repo and 1 on any violation', () => {
  const clean = makeSkeleton({
    'api-service/app/main.py': 'UP = "http://api:8000"\n',
    'src/api/project.ts': 'const base = "/api"\n',
  })
  const cleanResult = runChecks(clean, { exemptLines: new Set() })
  assert.equal(cleanResult.code, 0, `${cleanResult.summary}\n${JSON.stringify(cleanResult.violations, null, 2)}`)
  rmSync(clean, { recursive: true, force: true })

  const dirty = makeSkeleton({ '.env.production.example': 'NODE_UPSTREAM_URL=http://backend:3001\n' })
  const dirtyResult = runChecks(dirty, { exemptLines: new Set() })
  assert.equal(dirtyResult.code, 1)
  assert.ok(dirtyResult.violations.some((v) => v.rel === '.env.production.example'))
  rmSync(dirty, { recursive: true, force: true })
})

test('collectScanFiles covers pytest scope plus compose/nginx/Dockerfile extensions', () => {
  const root = makeSkeleton({
    'api-service/app/main.py': 'x = 1\n',
    'api-service/tests/test_x.py': 'x = 1\n',
    'scripts/demo.mjs': '// demo\n',
    'src/api/project.ts': 'export const x = 1\n',
    'src/views/Login.vue': '<template />\n',
    'vite.config.ts': 'export default {}\n',
  })
  const files = collectScanFiles(root)
  for (const expected of [
    'api-service/app/main.py',
    'api-service/tests/test_x.py',
    'scripts/demo.mjs',
    'src/api/project.ts',
    'src/views/Login.vue',
    'vite.config.ts',
    'docker-compose.yml',
    'nginx.conf',
    'Dockerfile.worker',
    'Dockerfile.frontend',
    '.env.example',
    '.env.production.example',
  ]) {
    assert.ok(files.includes(expected), `扫描范围缺少 ${expected}`)
  }
  assert.ok(!files.includes('package.json'), 'package.json 不在任务书扫描范围')
  rmSync(root, { recursive: true, force: true })
})

test('scanner self files are excluded from their own scan', () => {
  const root = makeSkeleton({
    'scripts/assert-fastapi-only.mjs': 'const A = /API_NATIVE_/\n',
    'api-service/tests/test_worker_independence.py': 'P = re.compile(r"NODE_UPSTREAM_URL")\n',
  })
  const files = collectScanFiles(root).filter((rel) => rel === 'scripts/assert-fastapi-only.mjs')
  assert.ok(files.length === 1, 'collectScanFiles 仍收集自引用文件（由 scanFile 排除）')
  const { code, violations } = runChecks(root, { exemptLines: new Set() })
  assert.equal(code, 0, `自引用文件不应命中：${JSON.stringify(violations)}`)
  rmSync(root, { recursive: true, force: true })
})

test('real repository passes the gate with zero violations', () => {
  // 真实仓库冒烟：fixture 目录之外验证脚本对当前工作区全绿（防「只在临时目录绿」）。
  const realRoot = fileURLToPath(new URL('..', import.meta.url))
  const { code, violations, errors } = runChecks(realRoot)
  assert.equal(errors.length, 0, errors.join('\n'))
  assert.equal(code, 0, `真实仓库门禁违规：\n${violations.map((v) => `${v.rel}:${v.line}:${v.content}`).join('\n')}`)
})
