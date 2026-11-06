// FastAPI-Only 交付物一致性修复 · Task 5（fix-fastapi-only-handover）：文档一致性 lint 测试。
//
// 运行：node --test scripts/runbook-consistency.test.mjs
//
// 全离线读文件断言（不执行任何 docker/网络命令），防止已修复的文档事实回归：
//   · 切换手册禁用项：docker image prune（清理步骤必须「只读列示 + 操作者显式确认删除」）、
//     /health/ready（健康契约：探针仅 /health 与 /ready，无别名）、api 容器内 curl
//     （python:3.12-slim 镜像无 curl，容器内验证统一 python -c urllib）、
//     宿主 shell 展开 MYSQL_ROOT_PASSWORD（凭据须留 compose 服务 env，经 sh -c 在容器内展开）；
//   · 切换手册必含项：--exec-compose / --public（smoke 双目标模式）、「静态结构检查」、
//     mkdir -p backup（备份目录先建后写）、gzip -t（备份完整性校验）；
//   · 最终报告口径：无 /health/ready，含 TTS 原生覆盖、0 条 501 与 PENDING（生产待办）；
//   · smoke 脚本：源码含 --exec-compose 与形状校验关键词（isJson/shapeOk，SPA HTML 假阳性
//     防护），--help 文本（源码内 usage 数组）含 --exec-compose；
//   · fail-closed：任一被检文件缺失即 FAIL（各测试均先过文件守卫，不静默跳过）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { usage } from './fastapi-only-smoke.mjs'

/** 仓库根目录（本文件位于 scripts/，上一级即根）。 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 被检文件路径：切换手册。 */
const RUNBOOK_PATH = join(REPO_ROOT, 'docs', 'production-switch-runbook.md')
/** 被检文件路径：Node 下线最终报告。 */
const REPORT_PATH = join(REPO_ROOT, 'docs', 'node-retirement-final-report.md')
/** 被检文件路径：FastAPI-Only 冒烟脚本源码。 */
const SMOKE_PATH = join(REPO_ROOT, 'scripts', 'fastapi-only-smoke.mjs')
const OPS_SPEC_PATH = join(REPO_ROOT, 'api-service', 'docs', 'ops-endpoints-spec.md')
const INVENTORY_PATH = join(REPO_ROOT, 'docs', 'node-retirement-inventory.md')

/** 缺失的被检文件列表（fail-closed 判定依据）。 */
const missing = [RUNBOOK_PATH, REPORT_PATH, SMOKE_PATH, OPS_SPEC_PATH, INVENTORY_PATH]
  .filter((path) => !existsSync(path))

/**
 * fail-closed 守卫：任一被检文件缺失即断言失败（不静默跳过）。
 * @param {string} label - 调用方测试名（用于错误信息定位）。
 * @returns {void} 文件齐备时无副作用。
 * @throws {assert.AssertionError} 存在缺失文件时抛出（列出缺失路径）。
 */
function requireFiles(label) {
  assert.deepStrictEqual(missing, [], `[${label}] fail-closed：被检文件缺失 → ${missing.join(' ; ')}`)
}

/**
 * 逐行筛选同时命中全部关键片段的行（用于精确定位违例行而非整个文件）。
 * @param {string} text - 被扫描的文件全文。
 * @param {RegExp[]} patterns - 行级正则列表（全部命中才算违例行）。
 * @returns {string[]} 命中的原始行列表。
 */
function pickLines(text, patterns) {
  return text.split(/\r?\n/).filter((line) => patterns.every((pattern) => pattern.test(line)))
}

test('切换手册不含禁用命令/路径/宿主凭据展开（prune、/health/ready、api 容器内 curl、宿主展开凭据）', () => {
  requireFiles('runbook 禁用项扫描')
  const text = readFileSync(RUNBOOK_PATH, 'utf8')

  // 1) 全局镜像清理禁止回归：观察期清理必须「只读列示 + 操作者显式确认后 docker rmi」。
  assert.ok(!text.includes('docker image prune'), '手册不得包含 docker image prune（全局清理禁止作为默认步骤）')

  // 2) 探针无别名：健康契约仅 /health 与 /ready，不得出现合并别名 /health/ready。
  assert.ok(!text.includes('/health/ready'), '手册不得包含 /health/ready（探针无别名，就绪路径统一 /ready）')

  // 3) api 容器内 curl 禁止回归：python:3.12-slim 无 curl，docker compose exec api 行内出现 curl 即违例
  //    （同时覆盖 exec api curl 与 exec api sh -c 'curl ...' 两种形态）。
  const apiCurlLines = pickLines(text, [/docker\s+compose/, /\bexec\b/, /\bapi\b/, /\bcurl\b/])
  assert.deepStrictEqual(
    apiCurlLines,
    [],
    'api 容器内不得调用 curl（镜像内不存在，应统一 python -c urllib），命中行：\n' + apiCurlLines.join('\n'),
  )

  // 4) 宿主 shell 不得展开 MYSQL_ROOT_PASSWORD：
  //    合法排除行：含 sh -c 且含 "$MYSQL_ROOT_PASSWORD"（docker compose exec mysql sh -c 容器内展开）；
  //    非法形态：MYSQL_ROOT_PASSWORD=$...（宿主赋值展开）、-p$MYSQL_ROOT_PASSWORD（命令行未加引号展开）。
  const hostExpandLines = text.split(/\r?\n/).filter((line) => {
    if (line.includes('sh -c') && line.includes('"$MYSQL_ROOT_PASSWORD"')) return false // 容器内展开（合法）
    return /MYSQL_ROOT_PASSWORD=\$/.test(line) || /-p\$MYSQL_ROOT_PASSWORD/.test(line)
  })
  assert.deepStrictEqual(
    hostExpandLines,
    [],
    '宿主 shell 不得展开 MYSQL_ROOT_PASSWORD（凭据须留容器 env 经 sh -c 展开），命中行：\n' + hostExpandLines.join('\n'),
  )
})

test('切换手册含 smoke、备份和生产前置门禁（双目标/完整性/干净工作树/真实域名）', () => {
  requireFiles('runbook 必含项检查')
  const text = readFileSync(RUNBOOK_PATH, 'utf8')
  for (const needle of [
    '--exec-compose', '--public', '静态结构检查', 'mkdir -p backup', 'gzip -t',
    'status --porcelain', 'sudo nginx -T', '最终报告缺失，停止切换',
    'port frontend 8080', 'SMOKE_BASE_URL', '共享宿主 Nginx',
  ]) {
    assert.ok(text.includes(needle), `手册必须包含：${needle}`)
  }
})

test('最终报告区分历史生产切流证据与尚未发布的本地改动', () => {
  requireFiles('最终报告口径检查')
  const text = readFileSync(REPORT_PATH, 'utf8')
  assert.ok(!text.includes('/health/ready'), '报告不得包含 /health/ready（探针无别名，统一 /ready）')
  for (const needle of ['native=118', '501=0', 'TTS', 'final-edit', '导出创建', '#74/#75', '24-48 小时观察期', 'smsProvider=mock']) {
    assert.ok(text.includes(needle), `报告必须包含：${needle}`)
  }
})

test('迁移规格和库存表与当前原生路由覆盖口径一致', () => {
  requireFiles('迁移规格口径检查')
  const spec = readFileSync(OPS_SPEC_PATH, 'utf8')
  const inventory = readFileSync(INVENTORY_PATH, 'utf8')
  assert.ok(spec.includes('| **原生实现** | **36** |'), '规格应记录 36 项原生迁移')
  assert.ok(spec.includes('| **显式 501（code 5010）+ 缺口记录** | **0** |'), '规格应记录 0 条显式 501')
  assert.match(inventory, /\| 55 \| GET \|[^\n]+✅ FastAPI 原生/)
  assert.match(inventory, /\| 57 \| GET \|[^\n]+✅ FastAPI 原生/)
  assert.match(inventory, /\| 51 \| POST \|[^\n]+✅ FastAPI 原生/)
  assert.match(inventory, /\| 98 \| GET \|[^\n]+✅ FastAPI 原生/)
  assert.match(inventory, /\| 99 \| PUT \|[^\n]+✅ FastAPI 原生/)
  assert.match(inventory, /\| 101 \| POST \|[^\n]+✅ FastAPI 入队/)
})

test('smoke 脚本源码与 --help 文本含 --exec-compose 与形状校验关键词（isJson/shapeOk）', () => {
  requireFiles('smoke 脚本源码检查')
  const text = readFileSync(SMOKE_PATH, 'utf8')
  assert.ok(text.includes('--exec-compose'), 'smoke 源码必须包含 --exec-compose（容器内 readiness 模式）')
  assert.ok(
    text.includes('isJson') || text.includes('shapeOk'),
    'smoke 源码必须包含形状校验关键词（isJson/shapeOk，SPA HTML 假阳性防护）',
  )
  assert.ok(usage().includes('--exec-compose'), '--help 文本（usage 数组）必须包含 --exec-compose')
})

test('fail-closed：五份被检文件（runbook/报告/smoke/规格/库存）全部存在', () => {
  assert.deepStrictEqual(missing, [], `fail-closed：被检文件缺失 → ${missing.join(' ; ')}`)
})
