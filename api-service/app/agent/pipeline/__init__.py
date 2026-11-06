"""阶段 2 兼容编排层：把 Node 侧 8 阶段 Agent Pipeline 平移到 Python/LangGraph。

职责边界（与阶段 1 运行时骨架的关系）：
- :mod:`.stages`：8 阶段定义（key/agent_key 与 Node ``pipeline-stages.mjs`` 逐字对齐）、
  副作用边界声明与线性 LangGraph 编排图（START → 8 节点 → END，六态受控）。
- :mod:`.idempotency`：跨阶段统一的幂等键构造/反解析（业务主键防歧义）。
- :mod:`.checkpoint`：thread_id 维度的整状态快照存储（InMemory + MySQL），支撑恢复与对账。
- :mod:`.recovery`：checkpoint 与业务 run 的对账（业务库为事实源）与中断 run 恢复。
- :mod:`.paid_submission`：付费节点"先创建幂等任务，再提交供应商"的提交决策层
  （voice/video/delivery 等长耗时阶段在编排层只做准备与提交决策，真实执行归 Worker）。

纪律约束：本包不修改 Node 侧任何文件（registry/executor 保持生产路径）；
checkpoint 与提交记录均落 MySQL（不引入 Redis/Postgres）；
失败分类收敛到 :mod:`app.agent.schemas` 的六态，UI/Node 兼容字段原样保留。
"""
