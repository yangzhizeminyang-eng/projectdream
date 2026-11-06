"""纯 LangGraph 对照实现测试：完成路径、citation 同构与预算计数。"""

from __future__ import annotations

import pytest

from app.agent.research.baseline_langgraph import run_baseline_research
from app.agent.research.budget import ResearchBudget

#: 与 DeepAgents 试点返回结构同构的键集合（对照可比的契约锁定）。
_EXPECTED_KEYS = {
    "engine",
    "status",
    "answer",
    "citations",
    "steps",
    "tool_calls",
    "subagents_used",
    "latency_ms",
    "cost_estimate_usd",
    "budget_snapshot",
    "partial",
}


def test_baseline_completed_with_citation_structure() -> None:
    """baseline 正常完成：answer 非空、citation 结构为 {"source","title"}。

    :return: 无返回值。
    :raises AssertionError: 状态、答案或 citation 结构不符时抛出。
    """
    result = run_baseline_research(
        project_id=5, question="云海学园天台场景设定", budget=ResearchBudget()
    )

    assert result["engine"] == "langgraph"
    assert set(result.keys()) == _EXPECTED_KEYS
    assert result["status"] == "completed"
    assert result["partial"] is False
    assert isinstance(result["answer"], str) and result["answer"].strip()
    assert result["citations"]
    first = result["citations"][0]
    assert set(first.keys()) == {"source", "title"}
    assert first["source"] in (501, 502, 503)
    assert first["title"] in result["answer"]
    assert result["subagents_used"] == 0


def test_baseline_isomorphic_with_deepagents_shape() -> None:
    """结构同构：baseline 与 deepagents 返回 dict 的键集合完全一致。

    :return: 无返回值。
    :raises AssertionError: 键集合不一致时抛出。
    """
    from app.agent.research.budget import BudgetGuard
    from app.agent.research.deep_research import build_deep_research_agent, run_deep_research
    from app.agent.schemas import ToolContext

    context = ToolContext(
        project_id=5,
        run_id="run-baseline-isomorphic",
        trace_id="trace-baseline-isomorphic",
        granted_scopes=["project:read"],
    )
    agent = build_deep_research_agent(context, BudgetGuard(ResearchBudget()))
    deep = run_deep_research(
        agent, project_id=5, question="主角林晚霞的角色设定", budget=ResearchBudget()
    )
    base = run_baseline_research(
        project_id=5, question="主角林晚霞的角色设定", budget=ResearchBudget()
    )

    assert set(deep.keys()) == set(base.keys()) == _EXPECTED_KEYS


def test_baseline_budget_counting_effective() -> None:
    """预算计数生效：max_steps=1 时第二步前触顶，citations 保留且快照联动。

    :return: 无返回值。
    :raises AssertionError: 触顶状态或部分结果不符时抛出。
    """
    result = run_baseline_research(
        project_id=5, question="主角林晚霞的角色设定", budget=ResearchBudget(max_steps=1)
    )

    assert result["status"] == "budget_exceeded"
    assert result["partial"] is True
    assert result["budget_snapshot"]["exceeded_dimension"] == "steps"
    assert result["citations"], "第一步已收集的 citations 不丢失"
    assert result["tool_calls"] == 1
    assert result["budget_snapshot"]["tool_calls"]["used"] == 1


def test_baseline_empty_question_still_completed() -> None:
    """空问题：检索未命中但流程完成（确定性规则拼接，无异常）。

    :return: 无返回值。
    :raises AssertionError: 状态或答案不符时抛出。
    """
    result = run_baseline_research(project_id=5, question="   ", budget=ResearchBudget())

    assert result["status"] == "completed"
    assert result["citations"] == []
    assert "未命中" in (result["answer"] or "")
