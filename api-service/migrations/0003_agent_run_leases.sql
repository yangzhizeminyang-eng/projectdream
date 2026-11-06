-- 阶段 6：Agent 运行认领租约表（前向迁移）。
-- 用途：多 Worker/多进程并发认领同一 run/job 时的互斥门——
--       claim 为单条原子 UPDATE（lease_until IS NULL OR lease_until < now）+ 受影响行数判定，
--       持有者可 renew/release，租约过期后其他 Worker 可 takeover_if_expired 超时回收。
-- 回滚方式：执行 0003_agent_run_leases_rollback.sql（会丢失在途租约状态，
--           仅影响认领互斥，不影响业务 run 数据；重试路径可安全重建）。

CREATE TABLE IF NOT EXISTS agent_run_leases (
  job_key VARCHAR(160) NOT NULL COMMENT '业务任务键（幂等键或 run 标识）',
  lease_owner VARCHAR(96) NOT NULL COMMENT '当前持有者标识（Worker/实例名）',
  lease_until DATETIME NOT NULL COMMENT '租约到期时间；到期后可被 takeover',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (job_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Agent 运行认领租约：原子 claim/renew/release/takeover 互斥门';
