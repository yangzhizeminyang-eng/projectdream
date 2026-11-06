"""对照运行器：同一输入分别跑 DeepAgents 试点与纯 LangGraph 对照，产出可比报告。

对照纪律：

- 两侧使用同一 :class:`ResearchBudget` 配置（各自实例化守卫，计数互不污染）；
- 两侧返回 dict 同构（engine/status/answer/citations/steps/tool_calls/
  subagents_used/latency_ms/cost_estimate_usd/budget_snapshot/partial）；
- ``delta`` 定义为 ``deepagents 值 - langgraph 值``（负值表示对照更优）；
- 成本一律为估算（estimate，0.0008 USD / 工具调用），两引擎均为离线
  fake 模型运行，零供应商费用。
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from ..schemas import ToolContext
from .budget import ResearchBudget
from .deep_research import build_deep_research_agent, run_deep_research
from .baseline_langgraph import run_baseline_research

#: 对照报告需要读数的字段名（试点结论必须由这些字段的数据支撑）。
_VERDICT_FIELDS: list[str] = [
    "latency_ms",
    "steps",
    "tool_calls",
    "cost_estimate_usd",
    "subagents_used",
]


def run_comparison(
    *,
    project_id: int,
    question: str,
    budget: ResearchBudget | None = None,
) -> dict:
    """以相同输入运行两实现并返回对照报告 dict。

    :param project_id: 项目 ID（两侧相同，权限锚点一致）。
    :param question: 研究问题（两侧相同）。
    :param budget: 预算配置；缺省使用 :class:`ResearchBudget` 保守默认值。
        同一配置分别实例化守卫注入两侧，保证 delta 可比。
    :return: 对照报告 dict，含 question/project_id/budget/deepagents/
        langgraph/delta/verdict_fields；``delta`` 各字段为
        ``deepagents 值 - langgraph 值``。
    :raises: 图执行异常不向调用方传播（两侧各自折算为 error 状态）。
    """
    resolved_budget = budget or ResearchBudget()
    context = ToolContext(
        project_id=project_id,
        run_id=f"comparison-{uuid.uuid4().hex[:12]}",
        trace_id=f"comparison-trace-{uuid.uuid4().hex[:12]}",
        granted_scopes=["project:read"],
    )
    agent = build_deep_research_agent(context, ResearchBudget(**resolved_budget.model_dump()))
    deep_result = run_deep_research(
        agent, project_id=project_id, question=question, budget=resolved_budget
    )
    base_result = run_baseline_research(
        project_id=project_id, question=question, budget=resolved_budget
    )
    delta = {
        "latency_ms": deep_result["latency_ms"] - base_result["latency_ms"],
        "steps": deep_result["steps"] - base_result["steps"],
        "tool_calls": deep_result["tool_calls"] - base_result["tool_calls"],
        "cost_estimate_usd": round(
            deep_result["cost_estimate_usd"] - base_result["cost_estimate_usd"], 6
        ),
    }
    return {
        "question": question,
        "project_id": project_id,
        "budget": resolved_budget.model_dump(),
        "deepagents": deep_result,
        "langgraph": base_result,
        "delta": delta,
        "verdict_fields": list(_VERDICT_FIELDS),
    }


def format_comparison_report(report: dict) -> str:
    """把对照报告渲染为人类可读的文本报告（表格化 delta）。

    :param report: :func:`run_comparison` 返回的报告 dict。
    :return: 多行文本报告；明确标注成本为估算（estimate）、两引擎均为
        离线 fake 模型运行。
    :raises KeyError: 报告缺少必需字段时抛出（属调用方契约错误，不静默）。
    """
    deep = report["deepagents"]
    base = report["langgraph"]
    delta = report["delta"]
    budget = report["budget"]
    lines: list[str] = []
    lines.append("ProjectDream 阶段 3 · DeepAgents 受控试点对照报告")
    lines.append("=" * 56)
    lines.append(f"问题：{report['question']}")
    lines.append(f"项目：p{report['project_id']}")
    lines.append(
        "预算上限：max_steps={max_steps}, max_tool_calls={max_tool_calls}, "
        "max_wall_time_seconds={max_wall_time_seconds}, "
        "max_cost_estimate_usd={max_cost_estimate_usd}(estimate), "
        "max_subagents={max_subagents}".format(**budget)
    )
    lines.append("")
    lines.append(
        "说明：两引擎均在离线 fake 模型下运行（零网络请求、零供应商费用）；"
        "cost 为估算值（estimate，按 0.0008 USD/工具调用），非真实计费。"
    )
    lines.append("")
    lines.append("| 指标 | deepagents | langgraph | delta(deep-langgraph) |")
    lines.append("| --- | --- | --- | --- |")
    lines.append(
        f"| latency_ms | {deep['latency_ms']} | {base['latency_ms']} | {delta['latency_ms']} |"
    )
    lines.append(f"| steps | {deep['steps']} | {base['steps']} | {delta['steps']} |")
    lines.append(
        f"| tool_calls | {deep['tool_calls']} | {base['tool_calls']} | {delta['tool_calls']} |"
    )
    lines.append(
        f"| cost_estimate_usd(estimate) | {deep['cost_estimate_usd']} "
        f"| {base['cost_estimate_usd']} | {delta['cost_estimate_usd']} |"
    )
    lines.append(
        f"| subagents_used | {deep['subagents_used']} | {base['subagents_used']} "
        f"| {deep['subagents_used'] - base['subagents_used']} |"
    )
    lines.append("")
    lines.append(f"状态：deepagents={deep['status']}(partial={deep['partial']}) | "
                 f"langgraph={base['status']}(partial={base['partial']})")
    lines.append(
        f"回答要点：deepagents={deep['answer'] or '（无，部分结果）'} | "
        f"langgraph={base['answer'] or '（无，部分结果）'}"
    )
    lines.append(
        f"citations：deepagents={len(deep['citations'])} 条 | langgraph={len(base['citations'])} 条"
    )
    lines.append("")
    lines.append("试点读数字段（verdict_fields）：" + ", ".join(report["verdict_fields"]))
    return "\n".join(lines)


def write_comparison_artifact(report: dict, path: str | Path) -> Path:
    """把对照报告以 JSON 落盘（供试点结论复现与归档）。

    :param report: :func:`run_comparison` 返回的报告 dict。
    :param path: 目标文件路径（父目录不存在时自动创建）。
    :return: 实际写入的文件 :class:`Path`。
    :raises TypeError: 报告含不可 JSON 序列化对象时抛出。
    :raises OSError: 文件写入失败时抛出。
    """
    target = Path(path)
    if target.parent and str(target.parent) not in ("", "."):
        target.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(report, ensure_ascii=False, indent=2)
    target.write_text(payload, encoding="utf-8")
    return target
