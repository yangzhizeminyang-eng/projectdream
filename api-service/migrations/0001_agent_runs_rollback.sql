-- ProjectDream Agent 运行记录表回滚脚本。
-- 警告：DROP 会永久删除试点 run 历史与事件流，仅限清理试点数据时使用；生产 run 历史不可恢复。

DROP TABLE IF EXISTS agent_run_events;
DROP TABLE IF EXISTS agent_runs;
