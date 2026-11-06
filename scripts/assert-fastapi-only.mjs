// FastAPI-Only 迁移第八阶段 · Task 8.1：FastAPI-Only 硬门禁扫描脚本。
//
// 用法：node scripts/assert-fastapi-only.mjs
// 退出码：0 = 七类禁用项零命中；1 = 存在残留/漂移/关键范围文件缺失。
//
// 七类禁用项（逐条输出 文件:行号:内容）：
//   1. Node HTTP API 引用（NODE_UPSTREAM_URL/node_upstream_url/node_readiness/
//      proxy_timeout_seconds/proxy_api/node.invalid）；
//   2. 3001 端口引用（backend:3001/localhost:3001/127.0.0.1:3001）；
//   3. proxy_pass http://backend（Nginx 四媒体路回代）；
//   4. API_NATIVE_ flag 残留；
//   5. server/index.mjs 生产链路引用（豁免：Worker 边界行 + 注释引用行，移植
//      pytest 的 EXEMPT_LINES——本脚本运行时直接读取
//      api-service/tests/test_no_node_dependencies.py 解析 EXEMPT_LINES 三元组，
//      保证与 pytest 扫描是同一份豁免语义，任何一侧漂移即失败）；
//   6. Dockerfile.backend 文件存在性（应已改名）与 compose `backend:` 服务定义；
//   7. API 镜像含 Node（api-service/Dockerfile 断言 FROM 非 node 基础镜像、
//      无 nodejs 安装/npm 全局 node 命令）。
//
// 扫描范围与 api-service/tests/test_no_node_dependencies.py 保持一致
// （api-service/app、api-service/tests、scripts/*.mjs、src、vite.config.ts、
// .env.example、requirements.txt），并按任务书扩展 compose/nginx/Dockerfile/
// .env.production.example。排除：api-service/tests/fixtures/**（Node 对照
// fixture 工具）、docs/**、api-service/docs/**（文档历史引用）、node_modules/
// dist/.codex-runtime（构建产物）。关键范围文件缺失即失败（自身漂移防护）。

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PYTEST_SCANNER = 'api-service/tests/test_no_node_dependencies.py'

// ---------------------------------------------------------------------------
// 类别 1-5 的行级禁用模式（与 pytest BANNED_PATTERNS 同语义）。
// ---------------------------------------------------------------------------
const LINE_PATTERNS = [
  { category: '1.Node-HTTP-API-引用', patterns: [/NODE_UPSTREAM_URL/, /node_upstream_url/, /node_readiness/, /proxy_timeout_seconds/, /proxy_api/, /node\.invalid/] },
  { category: '2.3001-端口引用', patterns: [/backend:3001/, /localhost:3001/, /127\.0\.0\.1:3001/] },
  { category: '3.proxy_pass-http-backend', patterns: [/proxy_pass\s+http:\/\/backend/] },
  { category: '4.API_NATIVE-flag-残留', patterns: [/API_NATIVE_/] },
  { category: '5.server-index-mjs-生产链路引用', patterns: [/server\/index\.mjs/] },
]

// 关键范围文件（自身漂移防护：任一缺失即失败，防止扫描范围静默塌缩）。
const REQUIRED_FILES = [
  'docker-compose.yml',
  'nginx.conf',
  '.env.example',
  '.env.production.example',
  'api-service/Dockerfile',
  'api-service/app/main.py',
  'api-service/tests/test_no_node_dependencies.py',
  'scripts/deploy-production.sh',
  'Dockerfile.worker',
]

// 范围内禁用的路径片段（构建产物/依赖/fixture 工具，防御性排除）。
const EXCLUDED_PARTS = new Set(['node_modules', 'dist', '.codex-runtime', 'fixtures', '__pycache__'])

// 守卫扫描器自引用文件：其模式定义/断言文本必然提及禁用词，属自引用而非
// Node 依赖残留。与 pytest 扫描器（test_no_node_dependencies.py 的
// SCANNER_SELF_FILES 排除集）保持同一份语义，任一侧新增守卫文件须两边同步。
const SCANNER_SELF_FILES = new Set([
  'api-service/tests/test_no_node_dependencies.py',
  'api-service/tests/test_worker_independence.py',
  'scripts/assert-fastapi-only.mjs',
  'scripts/assert-fastapi-only.test.mjs',
])

// Worker 执行体入口结构豁免（按 文件+行内容正则 匹配，不绑定行号）：
// compose worker-node 服务 command / Dockerfile.worker CMD 以 worker 角色启动
// server/index.mjs（APP_RUNTIME_ROLE=worker，非 HTTP API 链路），属五服务架构
// 保留项。pytest 扫描范围不含 compose/Dockerfile，故本豁免在本脚本内维护；
// 语义与 pytest EXEMPT_LINES 的「Worker 保留边界」一致（scripts/run-worker.mjs、
// scripts/worker-healthcheck.mjs 的 4 行豁免仍由 pytest EXEMPT_LINES 提供）。
const WORKER_ENTRY_EXEMPTS = [
  { rel: 'docker-compose.yml', pattern: /^\s*command:\s*\["node",\s*"server\/index\.mjs"\],?\s*$/ },
  { rel: 'Dockerfile.worker', pattern: /^CMD\s*\["node",\s*"server\/index\.mjs"\]\s*$/ },
]

/**
 * 解析 pytest 扫描器中的 EXEMPT_LINES frozenset 豁免三元组。
 * @param {string} source - test_no_node_dependencies.py 全文。
 * @returns {{ lines: Set<string>, ok: boolean, error?: string }} 豁免行集合
 *   （"相对路径:行号:行内容" 键）与解析成败。
 */
export function parseExemptLines(source) {
  const match = source.match(/EXEMPT_LINES[^=]*=\s*frozenset\(\s*\{([\s\S]*?)\n\s*\}\s*\)/)
  if (!match) return { lines: new Set(), ok: false, error: 'EXEMPT_LINES 定义未找到或结构漂移' }
  const entryPattern = /\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*(\d+)\s*,\s*"((?:[^"\\]|\\.)*)"\s*,?\s*\)/g
  // Python 字符串字面量反转义：源码中 \\u0000 / \\" 等序列按 Python 语义还原，
  // 与 pytest 求值后的豁免键逐字对齐（如 worker-healthcheck.test.mjs 的 \\u0000 行）。
  // 先占位双反斜杠，避免 \\u0000 被误判为 \uXXXX 转义。
  const unescapePython = (raw) => raw
    .replace(/\\\\/g, '\u0000BSL\u0000')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\"/g, '"')
    .replace(/\u0000BSL\u0000/g, '\\')
  const lines = new Set()
  let entry
  while ((entry = entryPattern.exec(match[1])) !== null) {
    lines.add(`${unescapePython(entry[1])}:${entry[2]}:${unescapePython(entry[3])}`)
  }
  if (!lines.size) return { lines, ok: false, error: 'EXEMPT_LINES 解析结果为空（格式漂移）' }
  return { lines, ok: true }
}

/**
 * 构造行级扫描范围文件清单（相对仓库根的 POSIX 路径）。
 * @param {string} root - 仓库根目录绝对路径。
 * @returns {string[]} 待扫描文件相对路径列表。
 */
export function collectScanFiles(root) {
  const files = []
  const pushIfExists = (rel) => {
    if (existsSync(join(root, rel))) files.push(rel)
  }
  for (const sub of ['api-service/app', 'api-service/tests']) {
    for (const ext of ['.py']) {
      const dir = join(root, ...sub.split('/'))
      try {
        const stack = [dir]
        while (stack.length) {
          const current = stack.pop()
          let entries = []
          try {
            entries = readdirSafe(current)
          } catch {
            continue
          }
          for (const name of entries) {
            const full = join(current, name)
            const rel = relative(root, full).split(sep).join('/')
            if (name === '.' || name === '..') continue
            if (EXCLUDED_PARTS.has(name)) continue
            if (isDirectorySafe(full)) {
              stack.push(full)
            } else if (name.endsWith(ext)) {
              files.push(rel)
            }
          }
        }
      } catch {
        // 目录缺失时跳过（REQUIRED_FILES 已防护关键文件）。
      }
    }
  }
  for (const rel of [
    'scripts/run-worker.mjs',
  ]) {
    pushIfExists(rel)
  }
  // scripts/*.mjs（含 *.test.mjs）。
  for (const name of readdirSafe(join(root, 'scripts'))) {
    if (name.endsWith('.mjs')) pushIfExists(`scripts/${name}`)
  }
  // src/**/*.{ts,vue,js}。
  for (const ext of ['.ts', '.vue', '.js']) {
    const walk = (dir) => {
      for (const name of readdirSafe(dir)) {
        const full = join(dir, name)
        const rel = relative(root, full).split(sep).join('/')
        if (EXCLUDED_PARTS.has(name)) continue
        if (isDirectorySafe(full)) walk(full)
        else if (name.endsWith(ext)) files.push(rel)
      }
    }
    walk(join(root, 'src'))
  }
  for (const rel of ['vite.config.ts', '.env.example', '.env.production.example', 'api-service/requirements.txt', 'docker-compose.yml', 'nginx.conf', 'Dockerfile.worker', 'Dockerfile.frontend']) {
    pushIfExists(rel)
  }
  return [...new Set(files)].sort()
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isDirectorySafe(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 扫描单文件的行级禁用模式（应用豁免行）。
 * @param {string} root - 仓库根。
 * @param {string} rel - 文件相对路径。
 * @param {Set<string>} exemptLines - 豁免行三元组键集合。
 * @returns {{ category: string, rel: string, line: number, content: string }[]}
 *   命中列表。
 */
export function scanFile(root, rel, exemptLines) {
  const hits = []
  if (SCANNER_SELF_FILES.has(rel)) return hits
  let text
  try {
    text = readFileSync(join(root, ...rel.split('/')), 'utf8')
  } catch {
    return hits
  }
  const workerEntryPatterns = WORKER_ENTRY_EXEMPTS.filter((item) => item.rel === rel).map((item) => item.pattern)
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\s+$/, '')
    const matched = LINE_PATTERNS.filter(({ patterns }) => patterns.some((p) => p.test(line)))
    if (!matched.length) continue
    const exemptKey = `${rel}:${i + 1}:${line}`
    if (exemptLines.has(exemptKey)) continue
    if (workerEntryPatterns.some((pattern) => pattern.test(line))) continue
    for (const { category } of matched) {
      hits.push({ category, rel, line: i + 1, content: line })
    }
  }
  return hits
}

/**
 * 类别 6/7：Dockerfile.backend 存在性、compose backend 服务、API 镜像含 Node。
 * @param {string} root - 仓库根。
 * @returns {{ category: string, rel: string, line: number, content: string }[]}
 *   违规列表。
 */
export function scanStructuralRules(root) {
  const violations = []
  if (existsSync(join(root, 'Dockerfile.backend'))) {
    violations.push({ category: '6.Dockerfile.backend-应已改名', rel: 'Dockerfile.backend', line: 0, content: '文件不应存在（backend 与 worker 已拆分为 Dockerfile.worker）' })
  }
  const composePath = join(root, 'docker-compose.yml')
  if (existsSync(composePath)) {
    const compose = readFileSync(composePath, 'utf8')
    const serviceMatch = compose.match(/^ {2}backend:\s*$/m)
    if (serviceMatch) {
      const line = compose.slice(0, serviceMatch.index).split(/\r?\n/).length
      violations.push({ category: '6.compose-backend-服务定义', rel: 'docker-compose.yml', line, content: '  backend:' })
    }
  }
  const apiDockerfile = join(root, 'api-service', 'Dockerfile')
  if (existsSync(apiDockerfile)) {
    const dockerfile = readFileSync(apiDockerfile, 'utf8')
    const lines = dockerfile.split(/\r?\n/)
    const nodePatterns = [
      { reason: 'FROM node 基础镜像', pattern: /^FROM\s+.*\bnode\b/i },
      { reason: 'nodejs 安装命令', pattern: /\bapt-get[^\n]*\binstall[^\n]*nodejs|\bapk[^\n]*\badd[^\n]*nodejs/i },
      { reason: 'npm 全局 node 安装', pattern: /\bnpm\s+install[^\n]*\snode\b/i },
    ]
    for (let i = 0; i < lines.length; i += 1) {
      for (const { reason, pattern } of nodePatterns) {
        if (pattern.test(lines[i])) {
          violations.push({ category: `7.API-镜像含Node（${reason}）`, rel: 'api-service/Dockerfile', line: i + 1, content: lines[i] })
        }
      }
    }
  }
  return violations
}

/**
 * 执行完整门禁检查（行级扫描 + 结构规则 + 关键文件防呆 + 豁免解析防护）。
 * @param {string} root - 仓库根目录。
 * @param {{ exemptLines?: Set<string>, skipExemptParse?: boolean }} [options]
 *   测试注入项：exemptLines 直接提供豁免集；skipExemptParse 跳过 pytest 解析。
 * @returns {{ code: number, violations: object[], errors: string[], summary: string }}
 *   退出码、违规明细、防护错误与汇总行。
 */
export function runChecks(root, options = {}) {
  const errors = []
  let exemptLines = options.exemptLines
  if (!exemptLines && !options.skipExemptParse) {
    const pytestPath = join(root, ...PYTEST_SCANNER.split('/'))
    if (!existsSync(pytestPath)) {
      errors.push(`豁免同步来源缺失：${PYTEST_SCANNER}（与 pytest 扫描的同一份语义无法建立）`)
    } else {
      const parsed = parseExemptLines(readFileSync(pytestPath, 'utf8'))
      if (!parsed.ok) errors.push(`${PYTEST_SCANNER} EXEMPT_LINES 解析失败：${parsed.error}`)
      else exemptLines = parsed.lines
    }
  }
  for (const rel of REQUIRED_FILES) {
    if (!existsSync(join(root, ...rel.split('/')))) {
      errors.push(`关键范围文件缺失：${rel}（扫描范围防呆失败）`)
    }
  }
  const violations = []
  if (exemptLines) {
    for (const rel of collectScanFiles(root)) {
      violations.push(...scanFile(root, rel, exemptLines))
    }
  }
  violations.push(...scanStructuralRules(root))
  const summary = `FastAPI-Only 门禁：${violations.length} 处违规 / ${errors.length} 项防护错误`
  return { code: violations.length || errors.length ? 1 : 0, violations, errors, summary }
}

// 主入口（被单测 import 时不执行）。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = runChecks(REPO_ROOT)
  for (const error of result.errors) console.error(`[drift-guard] ${error}`)
  for (const v of result.violations) {
    console.error(`${v.rel}:${v.line}:${v.content}  [${v.category}]`)
  }
  console.log(result.summary)
  process.exit(result.code)
}
