-- ProjectDream Agent 运行记录表（阶段 1 LangChain + LangGraph 试点）。
-- 用途：持久化每次 Agent run 的请求快照、终态结果与事件流，支撑幂等重放与状态查询。
-- 回滚方式：执行同目录 0001_agent_runs_rollback.sql（会删除 run 历史，仅限试点数据）。
-- 约定：utf8mb4 / InnoDB；payload_json / result_json 存 JSON 快照；SQL 侧由应用层全参数化访问。

CREATE TABLE IF NOT EXISTS agent_runs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  run_id VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(160) NOT NULL,
  project_id BIGINT NOT NULL,
  task_type VARCHAR(32) NOT NULL,
  status VARCHAR(24) NOT NULL,
  payload_json JSON NULL,
  result_json JSON NULL,
  trace_id VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_agent_runs_run_id (run_id),
  UNIQUE KEY uk_agent_runs_idempotency_key (idempotency_key),
  KEY idx_agent_runs_project_id (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_run_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  run_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(24) NOT NULL,
  payload_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_agent_run_events_run_id (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
