// Worker 边界声明（FastAPI-Only 第六阶段）：本脚本是 worker-node 执行体入口，
// 直接加载 server/index 入口模块启动 Worker（进程内共享服务，非 HTTP API 调用）。
process.env.APP_RUNTIME_ROLE = 'worker'

await import('../server/index.mjs')
