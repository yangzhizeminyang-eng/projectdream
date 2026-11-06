"""硬预算控制器：DeepAgents 试点与 LangGraph 对照共用的五项预算。

五项硬预算（任何一项触顶必须安全停止并保存部分结果，不得静默无限继续）：

1. 最大步骤（``max_steps``）：编排图 super-step 次数；
2. 最大工具调用数（``max_tool_calls``）：受限工具的调用次数；
3. 最大耗时（``max_wall_time_seconds``）：墙钟时间，``time.monotonic`` 计时；
4. 最大成本估算（``max_cost_estimate_usd``）：按工具调用次数 × 每次
   0.0008 USD 估算，**一律标注 estimate，非真实计费**；
5. 最大子代理数（``max_subagents``）：``task`` 工具实际派发的子代理次数。

设计纪律：计数器带锁（wall-time 超时后后台线程可能仍在运行），触顶即抛
:class:`BudgetExceededError` 并记录触顶维度，供 snapshot 与上层状态判定使用。
"""

from __future__ import annotations

import threading
import time

from pydantic import BaseModel, ConfigDict, Field

from ..errors import AgentError

#: 单次工具调用的成本估算单价（USD，估算值，非真实计费）。
COST_PER_TOOL_CALL_USD = 0.0008


class BudgetExceededError(AgentError):
    """研究预算触顶异常。

    :param dimension: 触顶的预算维度名（steps/tool_calls/wall_time/
        cost_estimate_usd/subagents）。
    :param used: 触顶时的已用量（计数值或秒/美元）。
    :param limit: 该维度的上限值。
    """

    def __init__(self, dimension: str, used: float, limit: float) -> None:
        """格式化脱敏错误信息并记录维度用量。

        :param dimension: 预算维度名。
        :param used: 已用量。
        :param limit: 上限值。
        """
        self.dimension = dimension
        self.used = used
        self.limit = limit
        super().__init__(f"研究预算触顶：维度={dimension}，已用={used}，上限={limit}")


class ResearchBudget(BaseModel):
    """五项硬预算的配置模型。

    :param max_steps: 编排图最大步骤（super-step）数，必须大于 0。
    :param max_tool_calls: 最大工具调用数，必须大于 0。
    :param max_wall_time_seconds: 最大墙钟耗时（秒），必须大于 0。
    :param max_cost_estimate_usd: 最大成本估算（USD，estimate），允许 0
        （表示不允许任何工具调用）。
    :param max_subagents: 最大子代理派发次数，允许 0（表示禁止子代理）。
    """

    model_config = ConfigDict(extra="forbid")

    max_steps: int = Field(default=8, gt=0, description="最大步骤数")
    max_tool_calls: int = Field(default=16, gt=0, description="最大工具调用数")
    max_wall_time_seconds: float = Field(default=30.0, gt=0, description="最大墙钟耗时（秒）")
    max_cost_estimate_usd: float = Field(default=0.05, ge=0, description="最大成本估算（USD，estimate）")
    max_subagents: int = Field(default=2, ge=0, description="最大子代理数")


class BudgetGuard:
    """预算守卫：线程安全计数并在触顶时抛出 :class:`BudgetExceededError`。

    :param budget: 五项预算配置。
    """

    def __init__(self, budget: ResearchBudget) -> None:
        """初始化计数器与计时起点。

        :param budget: 预算配置模型。
        """
        self._budget = budget
        self._lock = threading.Lock()
        self._start_monotonic = time.monotonic()
        self._steps = 0
        self._tool_calls = 0
        self._subagents = 0
        self._exceeded_dimension: str | None = None

    @property
    def config(self) -> ResearchBudget:
        """读取当前预算配置。

        :return: 构造时注入的 :class:`ResearchBudget` 实例。
        """
        return self._budget

    def _mark_exceeded(self, dimension: str, used: float, limit: float) -> None:
        """记录触顶维度并抛出预算异常（调用方需已持有锁）。

        :param dimension: 预算维度名。
        :param used: 已用量。
        :param limit: 上限值。
        :raises BudgetExceededError: 总是抛出（本方法职责即抛出）。
        """
        self._exceeded_dimension = dimension
        raise BudgetExceededError(dimension, used, limit)

    def consume_step(self) -> int:
        """消耗一个编排步骤；超过 ``max_steps`` 时抛出。

        :return: 消耗后的步骤计数。
        :raises BudgetExceededError: 步骤数将超过上限时抛出（维度 steps）。
        """
        with self._lock:
            if self._steps + 1 > self._budget.max_steps:
                self._mark_exceeded("steps", self._steps + 1, self._budget.max_steps)
            self._steps += 1
            return self._steps

    def consume_tool_call(self) -> int:
        """消耗一次工具调用；超过 ``max_tool_calls`` 或成本估算上限时抛出。

        成本估算按 ``(工具调用次数) × COST_PER_TOOL_CALL_USD`` 计算，
        仅用于预算把关与报告展示，是 estimate 而非真实计费。

        :return: 消耗后的工具调用计数。
        :raises BudgetExceededError: 工具调用数将超过上限（维度
            tool_calls）或成本估算将超过上限（维度 cost_estimate_usd）时抛出。
        """
        with self._lock:
            if self._tool_calls + 1 > self._budget.max_tool_calls:
                self._mark_exceeded("tool_calls", self._tool_calls + 1, self._budget.max_tool_calls)
            projected_cost = (self._tool_calls + 1) * COST_PER_TOOL_CALL_USD
            if projected_cost > self._budget.max_cost_estimate_usd:
                self._mark_exceeded(
                    "cost_estimate_usd",
                    round(projected_cost, 6),
                    self._budget.max_cost_estimate_usd,
                )
            self._tool_calls += 1
            return self._tool_calls

    def consume_subagent(self) -> int:
        """消耗一次子代理派发；超过 ``max_subagents`` 时抛出。

        :return: 消耗后的子代理计数。
        :raises BudgetExceededError: 子代理数将超过上限时抛出（维度 subagents）。
        """
        with self._lock:
            if self._subagents + 1 > self._budget.max_subagents:
                self._mark_exceeded("subagents", self._subagents + 1, self._budget.max_subagents)
            self._subagents += 1
            return self._subagents

    def elapsed_seconds(self) -> float:
        """返回自守卫创建以来的墙钟耗时（秒，``time.monotonic`` 计时）。

        :return: 已流逝秒数（浮点）。
        """
        return time.monotonic() - self._start_monotonic

    def ensure_within_wall_time(self) -> float:
        """校验墙钟耗时未超上限；超限即抛出。

        :return: 当前已流逝秒数。
        :raises BudgetExceededError: 已流逝时间超过 ``max_wall_time_seconds``
            时抛出（维度 wall_time）。
        """
        elapsed = self.elapsed_seconds()
        if elapsed > self._budget.max_wall_time_seconds:
            with self._lock:
                self._mark_exceeded("wall_time", round(elapsed, 6), self._budget.max_wall_time_seconds)
        return elapsed

    def estimate_cost_usd(self) -> float:
        """按工具调用次数估算成本（estimate，非真实计费）。

        :return: 估算成本（USD），等于 ``工具调用次数 × COST_PER_TOOL_CALL_USD``。
        """
        with self._lock:
            return round(self._tool_calls * COST_PER_TOOL_CALL_USD, 6)

    def snapshot(self) -> dict:
        """输出当前用量/上限/是否触顶的快照（供报告与部分结果保存）。

        :return: 快照 dict，含 steps/tool_calls/subagents（used+max）、
            wall_time_seconds（used+max）、cost_estimate_usd（used+max，
            且带 ``estimate=True`` 标注）、exceeded_dimension（None 或维度名）
            与 exceeded（布尔）。
        """
        with self._lock:
            steps = self._steps
            tool_calls = self._tool_calls
            subagents = self._subagents
            exceeded_dimension = self._exceeded_dimension
        elapsed = self.elapsed_seconds()
        return {
            "steps": {"used": steps, "max": self._budget.max_steps},
            "tool_calls": {"used": tool_calls, "max": self._budget.max_tool_calls},
            "subagents": {"used": subagents, "max": self._budget.max_subagents},
            "wall_time_seconds": {"used": round(elapsed, 6), "max": self._budget.max_wall_time_seconds},
            "cost_estimate_usd": {
                "used": round(tool_calls * COST_PER_TOOL_CALL_USD, 6),
                "max": self._budget.max_cost_estimate_usd,
                "estimate": True,
            },
            "exceeded_dimension": exceeded_dimension,
            "exceeded": exceeded_dimension is not None,
        }
