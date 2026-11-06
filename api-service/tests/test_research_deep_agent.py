"""DeepAgents 试点测试：固定脚本下的完成路径、预算触顶部分结果、耗时保护与子代理。"""

from __future__ import annotations

import pytest

from app.agent.research.budget import BudgetGuard, ResearchBudget
from app.agent.research.deep_research import (
    ScriptedResearchChatModel,
    build_deep_research_agent,
    run_deep_research,
)
from app.agent.schemas import ToolContext


def _context() -> ToolContext:
    """构造项目 5 的工具上下文。

    :return: ToolContext 实例（只读范围声明）。
    """
    return ToolContext(
        project_id=5,
        run_id="run-deep-research",
        trace_id="trace-deep-research",
        granted_scopes=["project:read"],
    )


def test_run_deep_research_completed_with_citations() -> None:
    """固定脚本下正常完成：answer 非空、citations 含 source、计数与快照一致。

    :return: 无返回值。
    :raises AssertionError: 状态、答案、citations 或计数不符时抛出。
    """
    agent = build_deep_research_agent(_context(), BudgetGuard(ResearchBudget()))

    result = run_deep_research(
        agent,
        project_id=5,
        question="主角林晚霞的角色设定",
        budget=ResearchBudget(),
    )

    assert result["engine"] == "deepagents"
    assert result["status"] == "completed"
    assert result["partial"] is False
    assert isinstance(result["answer"], str) and result["answer"].strip()
    assert result["citations"], "至少命中一条项目知识"
    first = result["citations"][0]
    assert set(first.keys()) == {"source", "title"}
    assert isinstance(first["source"], int)
    assert first["title"] in result["answer"]
    assert result["tool_calls"] >= 1
    assert result["steps"] >= 2
    assert result["subagents_used"] == 0
    assert result["cost_estimate_usd"] == pytest.approx(result["tool_calls"] * 0.0008)
    assert result["budget_snapshot"]["tool_calls"]["used"] == result["tool_calls"]
    assert result["budget_snapshot"]["cost_estimate_usd"]["estimate"] is True


def test_simple_question_does_not_spawn_subagent() -> None:
    """简单问题不触发子代理：subagents_used==0（direct 脚本不调用 task）。

    :return: 无返回值。
    :raises AssertionError: 子代理被意外派发时抛出。
    """
    agent = build_deep_research_agent(_context(), BudgetGuard(ResearchBudget()))

    result = run_deep_research(
        agent,
        project_id=5,
        question="云海学园天台场景设定",
        budget=ResearchBudget(),
    )

    assert result["status"] == "completed"
    assert result["subagents_used"] == 0
    assert result["budget_snapshot"]["subagents"]["used"] == 0


def test_step_budget_exceeded_keeps_partial_citations() -> None:
    """步骤预算触顶：status=budget_exceeded + partial=True 且 citations 保留部分结果。

    :return: 无返回值。
    :raises AssertionError: 部分结果丢失或状态不符时抛出。
    """
    agent = build_deep_research_agent(_context(), BudgetGuard(ResearchBudget()))

    result = run_deep_research(
        agent,
        project_id=5,
        question="主角林晚霞的角色设定",
        budget=ResearchBudget(max_steps=3),
    )

    assert result["status"] == "budget_exceeded"
    assert result["partial"] is True
    assert result["budget_snapshot"]["exceeded_dimension"] == "steps"
    assert result["citations"], "预算触顶前收集的 citations 不丢失"
    # deepagents 0.7.26 固定形态：before_agent + model + tools 三个 super-step
    # 内完成工具调用，第 4 个 super-step（最终汇总）被步骤预算拦停。
    assert result["steps"] == 3


def test_wall_time_budget_returns_safely() -> None:
    """耗时保护：wall_time 调到极小时安全返回部分结果且不挂死。

    :return: 无返回值。
    :raises AssertionError: 未超时挂死或状态不符时抛出。
    """
    model = ScriptedResearchChatModel(project_id=5, latency_seconds=0.3)
    agent = build_deep_research_agent(_context(), BudgetGuard(ResearchBudget()), fake_model=model)

    result = run_deep_research(
        agent,
        project_id=5,
        question="主角林晚霞的角色设定",
        budget=ResearchBudget(max_wall_time_seconds=0.05),
    )

    assert result["status"] == "budget_exceeded"
    assert result["partial"] is True
    assert result["budget_snapshot"]["exceeded_dimension"] == "wall_time"
    assert result["latency_ms"] < 1000


def test_delegate_path_uses_restricted_subagent() -> None:
    """委派路径：task 派发受限研究子代理一次，citations 经子代理回传。

    :return: 无返回值。
    :raises AssertionError: 子代理计数或结果不符时抛出。
    """
    model = ScriptedResearchChatModel(project_id=5, plan="delegate")
    agent = build_deep_research_agent(_context(), BudgetGuard(ResearchBudget()), fake_model=model)

    result = run_deep_research(
        agent,
        project_id=5,
        question="旧城区雨夜街景设定",
        budget=ResearchBudget(),
    )

    assert result["status"] == "completed"
    assert result["subagents_used"] == 1
    assert result["budget_snapshot"]["subagents"]["used"] == 1
