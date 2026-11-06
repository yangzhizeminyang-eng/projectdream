"""对照运行器测试：engine 字段、delta 方向、报告文本与 JSON 产物落盘。"""

from __future__ import annotations

import json

import pytest

from app.agent.research.budget import ResearchBudget
from app.agent.research.comparison import (
    format_comparison_report,
    run_comparison,
    write_comparison_artifact,
)


@pytest.fixture(scope="module")
def comparison_report() -> dict:
    """模块级共享对照报告（两实现各运行一次，避免重复图构建）。

    :return: run_comparison 的报告 dict。
    """
    return run_comparison(
        project_id=5,
        question="主角林晚霞的角色设定",
        budget=ResearchBudget(),
    )


def test_run_comparison_engines_and_delta(comparison_report: dict) -> None:
    """两侧 engine 字段正确、delta 数值方向正确且与两侧数值自洽。

    :param comparison_report: 对照报告 fixture。
    :return: 无返回值。
    :raises AssertionError: engine/delta/回显字段不符时抛出。
    """
    report = comparison_report

    assert report["question"] == "主角林晚霞的角色设定"
    assert report["project_id"] == 5
    assert report["deepagents"]["engine"] == "deepagents"
    assert report["langgraph"]["engine"] == "langgraph"
    assert report["deepagents"]["latency_ms"] >= 0
    assert report["langgraph"]["latency_ms"] >= 0

    delta = report["delta"]
    assert set(delta.keys()) == {"latency_ms", "steps", "tool_calls", "cost_estimate_usd"}
    assert delta["latency_ms"] == report["deepagents"]["latency_ms"] - report["langgraph"]["latency_ms"]
    assert delta["steps"] == report["deepagents"]["steps"] - report["langgraph"]["steps"]
    assert delta["tool_calls"] == report["deepagents"]["tool_calls"] - report["langgraph"]["tool_calls"]
    assert delta["cost_estimate_usd"] == pytest.approx(
        report["deepagents"]["cost_estimate_usd"] - report["langgraph"]["cost_estimate_usd"]
    )
    assert report["verdict_fields"]


def test_format_report_contains_engines_and_estimate_notice(comparison_report: dict) -> None:
    """报告文本：含两引擎名、estimate 声明与离线 fake 模型运行声明。

    :param comparison_report: 对照报告 fixture。
    :return: 无返回值。
    :raises AssertionError: 缺少引擎名或声明时抛出。
    """
    text = format_comparison_report(comparison_report)

    assert "deepagents" in text
    assert "langgraph" in text
    assert "estimate" in text
    assert "fake 模型" in text
    assert "主角林晚霞的角色设定" in text


def test_write_comparison_artifact_roundtrip(
    comparison_report: dict, tmp_path
) -> None:
    """JSON 产物落盘：写出后可 json.load 回读且内容与报告一致。

    :param comparison_report: 对照报告 fixture。
    :param tmp_path: pytest 临时目录。
    :return: 无返回值。
    :raises AssertionError: 回读内容与报告不一致时抛出。
    """
    artifact_path = tmp_path / "artifacts" / "stage3-comparison.json"

    written = write_comparison_artifact(comparison_report, artifact_path)

    assert written == artifact_path
    assert artifact_path.exists()
    restored = json.loads(artifact_path.read_text(encoding="utf-8"))
    assert restored == comparison_report
