"""硬预算控制器测试：五项预算各一项触顶断言 + snapshot 形状 + 异常契约。"""

from __future__ import annotations

import time

import pytest

from app.agent.errors import AgentError
from app.agent.research.budget import (
    COST_PER_TOOL_CALL_USD,
    BudgetExceededError,
    BudgetGuard,
    ResearchBudget,
)


def test_step_budget_exceeded() -> None:
    """步骤预算触顶：超过 max_steps 抛出并携带维度与已用/上限。

    :return: 无返回值。
    :raises AssertionError: 维度或用量信息不符时抛出。
    """
    guard = BudgetGuard(ResearchBudget(max_steps=1))

    assert guard.consume_step() == 1
    with pytest.raises(BudgetExceededError) as excinfo:
        guard.consume_step()

    assert excinfo.value.dimension == "steps"
    assert excinfo.value.used == 2
    assert excinfo.value.limit == 1


def test_tool_call_budget_exceeded() -> None:
    """工具调用预算触顶：超过 max_tool_calls 抛出并携带维度。

    :return: 无返回值。
    :raises AssertionError: 维度或计数不符时抛出。
    """
    guard = BudgetGuard(ResearchBudget(max_tool_calls=2))

    guard.consume_tool_call()
    guard.consume_tool_call()
    with pytest.raises(BudgetExceededError) as excinfo:
        guard.consume_tool_call()

    assert excinfo.value.dimension == "tool_calls"
    assert excinfo.value.used == 3
    assert excinfo.value.limit == 2


def test_cost_estimate_budget_exceeded() -> None:
    """成本估算预算触顶：估算值超过上限抛出，且触顶调用不计数。

    :return: 无返回值。
    :raises AssertionError: 维度、估算值或不计数行为不符时抛出。
    """
    guard = BudgetGuard(ResearchBudget(max_cost_estimate_usd=COST_PER_TOOL_CALL_USD))

    guard.consume_tool_call()
    with pytest.raises(BudgetExceededError) as excinfo:
        guard.consume_tool_call()

    assert excinfo.value.dimension == "cost_estimate_usd"
    assert guard.snapshot()["tool_calls"]["used"] == 1
    assert guard.estimate_cost_usd() == pytest.approx(COST_PER_TOOL_CALL_USD)


def test_wall_time_budget_exceeded() -> None:
    """墙钟耗时预算触顶：极小上限 + sleep 触发，异常携带维度与已用秒数。

    :return: 无返回值。
    :raises AssertionError: 维度或 elapsed 语义不符时抛出。
    """
    guard = BudgetGuard(ResearchBudget(max_wall_time_seconds=0.01))
    time.sleep(0.05)

    assert guard.elapsed_seconds() >= 0.01
    with pytest.raises(BudgetExceededError) as excinfo:
        guard.ensure_within_wall_time()

    assert excinfo.value.dimension == "wall_time"
    assert excinfo.value.limit == 0.01


def test_subagent_budget_exceeded() -> None:
    """子代理预算触顶：max_subagents=0 时首次派发即抛出。

    :return: 无返回值。
    :raises AssertionError: 维度或上限不符时抛出。
    """
    guard = BudgetGuard(ResearchBudget(max_subagents=0))

    with pytest.raises(BudgetExceededError) as excinfo:
        guard.consume_subagent()

    assert excinfo.value.dimension == "subagents"
    assert excinfo.value.limit == 0


def test_budget_exceeded_error_is_agent_error() -> None:
    """BudgetExceededError 继承 AgentError（与既有异常体系兼容）。

    :return: 无返回值。
    :raises AssertionError: 继承关系不符时抛出。
    """
    assert issubclass(BudgetExceededError, AgentError)


def test_snapshot_shape() -> None:
    """snapshot 输出形状：五项维度 + exceeded 标记，cost 项带 estimate 标注。

    :return: 无返回值。
    :raises AssertionError: 快照键或子结构不符时抛出。
    """
    guard = BudgetGuard(ResearchBudget())
    guard.consume_step()
    guard.consume_tool_call()

    snapshot = guard.snapshot()

    assert set(snapshot.keys()) == {
        "steps",
        "tool_calls",
        "subagents",
        "wall_time_seconds",
        "cost_estimate_usd",
        "exceeded_dimension",
        "exceeded",
    }
    assert snapshot["steps"] == {"used": 1, "max": 8}
    assert snapshot["tool_calls"] == {"used": 1, "max": 16}
    assert snapshot["subagents"] == {"used": 0, "max": 2}
    assert snapshot["wall_time_seconds"]["used"] >= 0
    assert snapshot["cost_estimate_usd"]["estimate"] is True
    assert snapshot["cost_estimate_usd"]["max"] == 0.05
    assert snapshot["exceeded_dimension"] is None
    assert snapshot["exceeded"] is False
