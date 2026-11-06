-- ProjectDream Agent Pipeline 阶段 2 表回滚脚本。
-- 警告：DROP 会永久丢弃试点编排 checkpoint 快照与付费提交记录
-- （包括 provider_task_id 的对应关系，删除后无法再幂等回查供应商任务），
-- 仅限清理试点数据时使用；生产环境严禁执行。

DROP TABLE IF EXISTS agent_paid_submissions;
DROP TABLE IF EXISTS agent_pipeline_checkpoints;
