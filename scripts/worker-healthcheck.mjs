// Worker 边界声明（FastAPI-Only 第六阶段）：本脚本由 worker-node 容器 healthcheck 调用，
// 通过 /proc cmdline 识别 Worker 执行体进程（node + server/index 入口），非任何 HTTP API 调用。
import { readdirSync, readFileSync } from 'node:fs'
import mysql from 'mysql2/promise'

export async function runWorkerHealthCheck({ env = process.env, fs = { readdirSync, readFileSync }, mysqlClient = mysql } = {}) {
  if (env.APP_RUNTIME_ROLE !== 'worker') {
    throw new Error('APP_RUNTIME_ROLE must be worker')
  }

  const workerProcessRunning = fs.readdirSync('/proc').some((entry) => {
    if (!/^\d+$/.test(entry)) return false
    try {
      const commandLine = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').toString()
      return commandLine.includes('server/index.mjs')
    } catch {
      return false
    }
  })
  if (!workerProcessRunning) throw new Error('worker process is not running')

  let connection
  try {
    connection = await mysqlClient.createConnection({
      host: env.DB_HOST || 'mysql',
      port: Number(env.DB_PORT || 3306),
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      connectTimeout: 3000,
    })
    await connection.query('SELECT 1 FROM generation_jobs LIMIT 0')
    await connection.query('SELECT 1 FROM export_records LIMIT 0')
    await connection.query('SELECT 1 FROM agent_pipeline_runs LIMIT 0')
  } catch {
    throw new Error('worker database readiness check failed')
  } finally {
    if (connection) await connection.end().catch(() => {})
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runWorkerHealthCheck().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
