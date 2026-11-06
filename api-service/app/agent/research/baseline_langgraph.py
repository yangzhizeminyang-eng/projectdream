"""纯 LangGraph 对照实现：两节点研究图（无模型调用，确定性规则拼接）。

与 DeepAgents 试点保持对照可比：

- 同数据源：节点内复用 :func:`app.agent.research.tools.bind_research_tools`
  的受限工具闭包（内部即 ``_PROJECT_KNOWLEDGE``，只读），citation 结构一致；
- 同预算口径：工具调用经同一 :class:`BudgetGuard` 计数（闭包共享），
  步骤计数同样在 stream 循环内 ``consume_step()``；
- 同结果结构：返回 dict 与 :func:`run_deep_research` 同构
  （engine="langgraph"），保证 delta 可比。

图结构::

    START -> lookup_knowledge -> summarize -> END
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any, TypedDict

from langchain_core.tools import BaseTool
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from ..schemas import ToolContext
from .budget import COST_PER_TOOL_CALL_USD, BudgetExceededError, BudgetGuard, ResearchBudget
from .deep_research import _dedupe_citations
from .tools import bind_research_tools


class StoryboardResearchState(TypedDict, total=False):
    """对照研究图的状态容器（全部键显式声明，未写键不出现在输出）。

    :param question: 研究问题。
    :param project_id: 项目 ID（权限锚点，与工具上下文一致）。
    :param results: 检索命中的知识条目列表。
    :param citations: 可回查来源列表（``[{"source": id, "title": 标题}]``）。
    :param answer: 规则拼接的摘要回答（未完成时为 None）。
    :param tool_calls: 本图内发生的工具调用次数。
    :param error: 脱敏错误说明（成功时为 None）。
    """

    question: str
    project_id: int
    results: list[dict[str, Any]]
    citations: list[dict[str, Any]]
    answer: str | None
    tool_calls: int
    error: str | None


def build_baseline_research_graph(lookup_tool: BaseTool) -> CompiledStateGraph:
    """构建纯 LangGraph 对照研究图（两节点，无模型调用）。

    :param lookup_tool: 受限知识检索工具（:func:`bind_research_tools` 产出的
        闭包工具，携带项目上下文与预算守卫）。
    :return: 编译后的 LangGraph 图；``.invoke`` / ``.stream`` 输入输出为
        :class:`StoryboardResearchState` 同构 dict。
    :raises Exception: LangGraph 构建配置错误时原样抛出（属编程错误，不静默）。
    """

    def lookup_knowledge(state: StoryboardResearchState) -> dict[str, Any]:
        """调用受限检索工具并收集结果与 citations。

        :param state: 当前图状态（question/project_id）。
        :return: 状态增量，含 results/citations/tool_calls/error。
        :raises BudgetExceededError: 预算触顶时由工具闭包传播（由运行侧捕获，
            与 DeepAgents 试点同口径）。
        :raises PermissionDeniedError: project_id 越权时由工具闭包传播。
        """
        raw = lookup_tool.invoke(
            {"query": state.get("question", ""), "project_id": state.get("project_id", 0)}
        )
        try:
            payload = json.loads(raw)
        except (TypeError, ValueError):
            payload = None
        if not isinstance(payload, dict):
            return {"results": [], "citations": [], "tool_calls": 1, "error": "invalid_payload"}
        # 结果性 not ok（如 empty_query）视为"未命中"，流程继续 summarize；
        # 仅载荷不可解析才折算为 error 状态。
        results = payload.get("results") or []
        citations = [
            {"source": item["source"]["id"], "title": item["source"]["title"]}
            for item in results
            if isinstance(item, dict) and item.get("source")
        ]
        return {"results": results, "citations": citations, "tool_calls": 1, "error": None}

    def summarize(state: StoryboardResearchState) -> dict[str, Any]:
        """按规则拼接摘要回答（无模型调用，确定性）。

        :param state: 当前图状态（含 citations/results）。
        :return: 状态增量（answer 与最终结果确认）。
        :raises: 本节点不抛出异常。
        """
        titles = [c.get("title") for c in state.get("citations", []) if c.get("title")]
        if titles:
            answer = "根据项目知识库检索：《" + "》《".join(titles) + "》与你的问题相关。"
        else:
            answer = "根据项目知识库检索：未命中相关条目。"
        return {"answer": answer}

    builder: StateGraph = StateGraph(StoryboardResearchState)
    builder.add_node("lookup_knowledge", lookup_knowledge)
    builder.add_node("summarize", summarize)
    builder.add_edge(START, "lookup_knowledge")
    builder.add_edge("lookup_knowledge", "summarize")
    builder.add_edge("summarize", END)
    return builder.compile()


def run_baseline_research(*, project_id: int, question: str, budget: ResearchBudget) -> dict:
    """运行纯 LangGraph 对照研究并返回与 DeepAgents 试点同构的结果 dict。

    执行口径与 :func:`run_deep_research` 对齐：stream 循环内逐步
    ``consume_step()``（触顶抛 :class:`BudgetExceededError` 后捕获并返回
    ``status="budget_exceeded"`` + ``partial=True``），已收集的 citations
    不丢失；图本身确定性执行（无网络 / 无模型），无需线程超时保护。

    :param project_id: 项目 ID。
    :param question: 研究问题（作为检索词）。
    :param budget: 预算配置（与 DeepAgents 侧使用相同配置以保证对照可比）。
    :return: 结果 dict，含 engine/status/answer/citations/steps/tool_calls/
        subagents_used/latency_ms/cost_estimate_usd/budget_snapshot/partial，
        键集合与 :func:`run_deep_research` 的返回完全一致（engine="langgraph"）。
    :raises: 本函数不向调用方抛出图执行异常（预算触顶折算为对应状态）。
    """
    guard = BudgetGuard(budget)
    context = ToolContext(
        project_id=project_id,
        run_id=f"baseline-{uuid.uuid4().hex[:12]}",
        trace_id=f"baseline-trace-{uuid.uuid4().hex[:12]}",
        granted_scopes=["project:read"],
    )
    tools = bind_research_tools(context, guard)
    lookup_tool = next(t for t in tools if t.name == "project_knowledge_lookup")
    graph = build_baseline_research_graph(lookup_tool)

    citations: list[dict[str, Any]] = []
    answer: str | None = None
    tool_calls = 0
    error: str | None = None
    exceeded_dimension: str | None = None
    started = time.perf_counter()

    try:
        for chunk in graph.stream(
            {"question": question, "project_id": project_id}, stream_mode="updates"
        ):
            guard.consume_step()
            guard.ensure_within_wall_time()
            if not isinstance(chunk, dict):
                continue
            for update in chunk.values():
                if not isinstance(update, dict):
                    continue
                for citation in update.get("citations") or []:
                    citations.append(citation)
                tool_calls += int(update.get("tool_calls") or 0)
                if update.get("answer"):
                    answer = str(update["answer"])
                if update.get("error"):
                    error = str(update["error"])
    except BudgetExceededError as exc:
        exceeded_dimension = exc.dimension
    except Exception as exc:  # noqa: BLE001 - 对照实验同样把异常折算为 error 状态
        error = f"{type(exc).__name__}: {exc}"

    status = "completed"
    if error is not None:
        status = "error"
    elif exceeded_dimension is not None:
        status = "budget_exceeded"

    latency_ms = int((time.perf_counter() - started) * 1000)
    cost_estimate = round(tool_calls * COST_PER_TOOL_CALL_USD, 6)
    snapshot = guard.snapshot()
    snapshot["cost_estimate_usd"]["used"] = cost_estimate

    return {
        "engine": "langgraph",
        "status": status,
        "answer": answer,
        "citations": _dedupe_citations(citations),
        "steps": snapshot["steps"]["used"],
        "tool_calls": tool_calls,
        "subagents_used": 0,
        "latency_ms": latency_ms,
        "cost_estimate_usd": cost_estimate,
        "budget_snapshot": snapshot,
        "partial": status != "completed",
    }
