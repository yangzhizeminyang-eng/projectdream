-- 阶段 6 回滚：删除 Agent 运行认领租约表。
-- 影响：丢失在途租约状态（仅认领互斥层，不影响业务 run 数据）；
--       回滚后所有在途任务可被任意 Worker 重新认领（幂等键层兜底防重复执行）。

DROP TABLE IF EXISTS agent_run_leases;
