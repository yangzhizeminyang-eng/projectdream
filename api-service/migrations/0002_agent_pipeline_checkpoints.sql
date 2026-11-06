-- ProjectDream Agent Pipeline 阶段 2：编排检查点与付费提交记录表。
-- 用途：
--   1) agent_pipeline_checkpoints：thread_id 维度的整状态快照（覆盖式保存），
--      支撑编排图暂停（waiting_approval 等）后的恢复重放与对账（recovery.reconcile）；
--   2) agent_paid_submissions：付费节点（video）"先创建幂等任务，再提交供应商"的
--      提交记录，按 idempotency_key 保证绝不二次提交。
-- 回滚方式：执行同目录 0002_agent_pipeline_checkpoints_rollback.sql（会丢失试点
-- checkpoint 快照与付费提交记录，仅限清理试点数据时使用）。
-- 约定：utf8mb4 / InnoDB；state_json / payload_json 存 JSON 快照；
--       SQL 侧由应用层全参数化访问；不引入 Redis/Postgres。

CREATE TABLE IF NOT EXISTS agent_pipeline_checkpoints (
  thread_id VARCHAR(96) NOT NULL,
  state_json JSON NULL,
  status VARCHAR(24) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (thread_id),
  KEY idx_agent_pipeline_checkpoints_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Agent Pipeline 编排检查点：thread_id 维度整状态快照（试点语义 thread_id 即 run_id）';

CREATE TABLE IF NOT EXISTS agent_paid_submissions (
  idempotency_key VARCHAR(160) NOT NULL,
  project_id BIGINT NOT NULL,
  stage_key VARCHAR(32) NOT NULL,
  provider VARCHAR(64) NOT NULL,
  submission_state VARCHAR(16) NOT NULL,
  provider_task_id VARCHAR(96) NULL,
  payload_json JSON NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (idempotency_key),
  KEY idx_agent_paid_submissions_project_stage (project_id, stage_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='付费节点提交记录：pending/submitted/failed 生命周期，幂等键唯一防二次提交';
