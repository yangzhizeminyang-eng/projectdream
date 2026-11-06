"""检查点与业务 run 的对账及中断恢复。

核心原则：**业务 run 库（agent_pipeline_runs）是事实源**。checkpoint 只是编排
现场的加速恢复手段；两者状态不一致时，一律以 run 状态为准回卷 checkpoint
（回卷动作由调用方依据 run 的 result_json 决定，本模块只报告判定结果）。
"""

from __future__ import annotations

from typing import Any

from ..errors import InvalidInputError
from ..run_store import RunStore
from ..runtime import AgentRuntime
from ..schemas import AgentResult
from .checkpoint import CheckpointStore

# 非终态集合：进程中断时 run 可能残留在这两种状态，属于"可被 resume_interrupted 恢复"的范围。
_NON_TERMINAL_STATUSES: frozenset[str] = frozenset({"queued", "running"})


def reconcile(checkpoints: CheckpointStore, run_store: RunStore, run_id: str) -> dict[str, Any]:
    """对账 checkpoint 快照状态与业务 run 状态。

    试点语义下 checkpoint 的 thread_id 即 run_id。判定规则：
    - 两者状态一致 → ``consistent=True``、``action="none"``；
    - 状态不一致 → ``consistent=False``、``action="checkpoint_rewound"``（以业务 run 为准）；
    - checkpoint 缺失而 run 存在 → 同样判 ``checkpoint_rewound``（由调用方决定是否
      从 run 的 result_json 重建快照，本函数只报告、不写存储）。

    :param checkpoints: 检查点存储实现。
    :param run_store: 业务 run 存储（事实源）。
    :param run_id: 运行 ID（同时作为 checkpoint 的 thread_id）。
    :returns: 对账报告 dict，含 ``run_id/checkpoint_status/run_status/consistent/action``；
        ``checkpoint_status`` 在快照缺失时为 None。
    :raises InvalidInputError: run 不存在时抛出（无对账目标，属调用方输入错误）。
    """
    run = run_store.get_run(run_id)
    if run is None:
        raise InvalidInputError(f"run {run_id} 不存在，无法对账")
    checkpoint = checkpoints.load(run_id)
    run_status = str(run.get("status"))
    checkpoint_status = str(checkpoint["status"]) if checkpoint is not None else None
    consistent = checkpoint_status == run_status
    return {
        "run_id": run_id,
        "checkpoint_status": checkpoint_status,
        "run_status": run_status,
        "consistent": consistent,
        "action": "none" if consistent else "checkpoint_rewound",
    }


def resume_interrupted(runtime: AgentRuntime, run_id: str) -> AgentResult | None:
    """恢复因进程中断而卡在非终态（queued/running）的 run。

    处理策略：
    - run 不存在 → 返回 None；
    - run 已是终态（completed/failed/retryable_failed/blocked/canceled）→ 返回 None
      （无可恢复项；blocked/retryable_failed 的重放由调用方直接走 ``runtime.resume``）；
    - run 停在 queued/running → 先经 ``run_store.update_status`` 落一个可重试终态
      ``retryable_failed``，再走阶段 1 的 ``runtime.resume``（派生新幂等键与新 run_id
      重放原 payload）。

    :param runtime: Agent 运行时实例（本函数通过其内部 run_store 修正中断状态，
        属同包协作访问；阶段 1 的 runtime 未暴露公开的 update_status 入口）。
    :param run_id: 运行 ID。
    :returns: 恢复重放产生的新终态 :class:`AgentResult`；无可恢复项时返回 None。
    """
    run = runtime.get_status(run_id)
    if run is None:
        return None
    if run.get("status") not in _NON_TERMINAL_STATUSES:
        return None
    # 中断 run 不该停留在非终态：先落 retryable_failed（retryable 语义，可重试）再重放。
    runtime._store.update_status(run_id, "retryable_failed", None)
    return runtime.resume(run_id)
