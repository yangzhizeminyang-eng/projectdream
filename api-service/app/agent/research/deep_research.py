"""DeepAgents 受控试点实现：低风险研究类 Agent（离线 fake 模型，确定性脚本）。

实现要点（基于 deepagents==0.7.26 源码确认）：

- ``create_deep_agent(model, tools, *, system_prompt, middleware, subagents)``
  返回 LangGraph ``CompiledStateGraph``，可直接 ``.invoke`` / ``.stream``；
- deepagents 硬性要求 ``FilesystemMiddleware`` 与 ``SubAgentMiddleware``
  脚手架不可排除，但可通过在 ``middleware=`` 中传入同名
  ``FilesystemMiddleware(backend=StateBackend(), tools=["read_file"])``
  按名替换默认栈：StateBackend 是图 state 内的隔离虚拟沙箱（不触真实磁盘），
  唯一暴露的 ``read_file`` 为只读工具（写/删/shell 工具全部隐藏）；
- 子代理通过 ``subagents=`` 注册 :class:`deepagents.CompiledSubAgent`
  （预编译 runnable 形态，不继承任何默认文件中间件，天然无文件工具）；
  同时注册名为 ``general-purpose`` 的受限替身，阻止 deepagents 自动加入
  带默认文件工具栈的通用子代理（官方契约：显式 spec 覆盖默认）；
- ``max_subagents`` 预算由 :class:`BudgetGuard` 把关：``task`` 工具实际调用
  ``CompiledSubAgent["runnable"].invoke(...)``，该 runnable 被
  :class:`RunnableLambda` 包装，入口处执行 ``consume_subagent()``（可拦截，
  已对照 deepagents/middleware/subagents.py 源码确认）；
- fake 模型路径选择：采用**脚本化 tool-calling 路径**（非纯文本直答降级路径）。
  自定义 :class:`ScriptedResearchChatModel` 继承 langchain-core
  ``BaseChatModel``，覆盖 ``bind_tools``（默认实现会抛 NotImplementedError，
  langchain ``create_agent`` 需要绑定工具）并以固定两步脚本驱动：
  第一轮产出受限工具调用（或 ``task`` 委派），第二轮从 ``ToolMessage``
  提取来源标题汇总回答，全程确定性、零网络请求。

预算触顶处理：工具闭包抛出的 :class:`BudgetExceededError` 由
``run_deep_research`` 的 stream 循环外层捕获，返回
``status="budget_exceeded"`` + ``partial=True``，已收集的 citations 不丢失；
wall-time 预算由后台线程 + ``join(timeout)`` 保护，超时安全返回部分结果。
"""

from __future__ import annotations

import json
import threading
import time
from typing import Any, TypedDict

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import Runnable, RunnableConfig, RunnableLambda
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from deepagents import CompiledSubAgent, FilesystemMiddleware, create_deep_agent
from deepagents.backends import StateBackend

from ..schemas import ToolContext
from .budget import COST_PER_TOOL_CALL_USD, BudgetExceededError, BudgetGuard, ResearchBudget
from .tools import bind_research_tools

#: DeepAgents 主代理的中文系统提示：限定为项目知识研究，禁止越权与文件操作。
_RESEARCH_SYSTEM_PROMPT = (
    "你是 ProjectDream 的项目知识研究员。仅使用提供的只读研究工具在当前项目范围内"
    "检索角色设定、场景设定与市场反馈，并用中文汇总回答。不得尝试文件写入、删除、"
    "命令执行或访问项目外资源。"
)


class ScriptedResearchChatModel(BaseChatModel):
    """脚本化 fake 聊天模型：两步固定脚本，保证 DeepAgents 试点离线且确定。

    :param project_id: 绑定的项目 ID（写入工具调用参数，保证权限校验通过）。
    :param plan: 脚本计划，``direct``=直接调用知识检索工具后汇总；
        ``delegate``=先通过 ``task`` 工具委派受限研究子代理再汇总。
    :param latency_seconds: 每次 ``_generate`` 的模拟耗时（用于 wall-time
        预算测试，默认 0）。
    :param model_name: 模型标识（供 deepagents 模型识别与报告展示）。
    :param calls: 已发生的 ``_generate`` 调用次数（内部计数）。
    """

    project_id: int
    plan: str = "direct"
    latency_seconds: float = 0.0
    model_name: str = "pd-scripted-research"
    calls: int = 0

    def bind_tools(self, tools: Any, **kwargs: Any) -> "ScriptedResearchChatModel":
        """返回自身以模拟工具绑定（fake 模型按脚本直接产出 tool_calls）。

        :param tools: 工具列表（忽略，脚本固定产出受限工具调用）。
        :param kwargs: 兼容 bind 变体参数（忽略）。
        :return: 模型自身（绑定后行为不变，保证确定性）。
        """
        return self

    @property
    def _llm_type(self) -> str:
        """返回模型类型标识。

        :return: 固定字符串 ``"pd-scripted-research"``。
        """
        return "pd-scripted-research"

    def _generate(
        self,
        messages: list[Any],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        """按固定脚本产出消息：首轮工具调用，次轮汇总回答。

        :param messages: 当前对话消息列表（含 ``ToolMessage`` 工具结果）。
        :param stop: 停止词（忽略）。
        :param run_manager: 回调管理器（忽略）。
        :param kwargs: 兼容参数（忽略）。
        :return: ``ChatResult``；首轮为带 tool_calls 的 ``AIMessage``，
            次轮为引用来源标题的确定性汇总文本。
        """
        self.calls += 1
        if self.latency_seconds > 0:
            time.sleep(self.latency_seconds)
        tool_messages = [msg for msg in messages if isinstance(msg, ToolMessage)]
        if not tool_messages:
            question = ""
            for msg in reversed(messages):
                if isinstance(msg, HumanMessage):
                    question = str(msg.content)
                    break
            if self.plan == "delegate":
                tool_call = {
                    "name": "task",
                    "args": {
                        "description": question or "研究当前项目知识",
                        "subagent_type": "project-researcher",
                    },
                    "id": "call_task_1",
                    "type": "tool_call",
                }
            else:
                tool_call = {
                    "name": "project_knowledge_lookup",
                    "args": {"query": question or "项目知识", "project_id": self.project_id},
                    "id": "call_lookup_1",
                    "type": "tool_call",
                }
            return ChatResult(
                generations=[ChatGeneration(message=AIMessage(content="", tool_calls=[tool_call]))]
            )
        titles = _extract_source_titles(tool_messages)
        if titles:
            answer = "根据项目知识库检索：《" + "》《".join(titles) + "》与你的问题相关。" + _ANSWER_SUFFIX
        else:
            answer = "根据项目知识库检索：未命中相关条目。" + _ANSWER_SUFFIX
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=answer))])


#: 汇总回答的固定结尾（声明试点边界）。
_ANSWER_SUFFIX = "以上为项目范围内的只读研究摘要（离线 fake 模型，成本为估算值）。"


def _extract_source_titles(tool_messages: list[ToolMessage]) -> list[str]:
    """从工具结果消息中提取来源标题（供脚本汇总引用）。

    :param tool_messages: ``ToolMessage`` 列表（content 为工具返回的 JSON 字符串）。
    :return: 去重后的来源标题列表（解析失败或无来源时为空列表）。
    """
    titles: list[str] = []
    for msg in tool_messages:
        try:
            payload = json.loads(str(msg.content))
        except (TypeError, ValueError):
            continue
        if not isinstance(payload, dict):
            continue
        for item in payload.get("results") or []:
            source = (item or {}).get("source") or {}
            title = source.get("title")
            if title and title not in titles:
                titles.append(title)
        for citation in payload.get("citations") or []:
            title = (citation or {}).get("title")
            if title and title not in titles:
                titles.append(title)
        source = payload.get("source") or {}
        title = source.get("title")
        if title and title not in titles:
            titles.append(title)
    return titles


class _SubagentResearchState(TypedDict, total=False):
    """受限研究子代理 mini 图的状态容器（全部键显式声明）。

    :param messages: 子代理对话消息（入口为 ``task`` 描述的 ``HumanMessage``）。
    :param citations: 已收集的可回查来源。
    :param answer: 规则拼接的摘要文本。
    """

    messages: list[Any]
    citations: list[dict[str, Any]]
    answer: str | None


def _build_subagent_runnable(context: ToolContext, budget: BudgetGuard) -> Runnable:
    """构建受限研究子代理的预编译 runnable（含 ``consume_subagent`` 拦截入口）。

    子代理为确定性 mini LangGraph（lookup → summarize，无模型调用），仅使用
    :func:`bind_research_tools` 的同一批受限工具（与主代理共享 BudgetGuard
    计数口径），不包含文件 / shell / 网络能力。入口包装在
    :class:`RunnableLambda` 中：先执行 ``budget.consume_subagent()``（触顶时
    返回说明性消息而非崩溃，预算由 :class:`BudgetGuard` 记录），再把输入过滤
    为仅含 ``messages`` 的状态后调用 mini 图（隔离外部注入的未知键）。

    :param context: 工具执行上下文（子代理严格继承同一 project/user 权限）。
    :param budget: 预算守卫（子代理计数与主代理共享）。
    :return: 可被 deepagents ``task`` 工具调用的 Runnable（输出含 ``messages``）。
    """
    tools = bind_research_tools(context, budget)
    lookup_tool = next(t for t in tools if t.name == "project_knowledge_lookup")

    def lookup_node(state: _SubagentResearchState) -> dict[str, Any]:
        """执行受限知识检索并收集 citations。

        :param state: 子代理状态（从最后一条 ``HumanMessage`` 取检索词）。
        :return: 状态增量，含 citations 与规则摘要 answer。
        :raises BudgetExceededError: 预算触顶时由工具闭包传播（入口层捕获）。
        :raises PermissionDeniedError: 不会发生（查询项目与上下文一致）。
        """
        query = ""
        for msg in reversed(state.get("messages") or []):
            if isinstance(msg, HumanMessage):
                query = str(msg.content)
                break
        raw = lookup_tool.invoke({"query": query, "project_id": context.project_id})
        try:
            payload = json.loads(raw)
        except (TypeError, ValueError):
            payload = {}
        results = payload.get("results") or [] if isinstance(payload, dict) else []
        citations = [
            {"source": item["source"]["id"], "title": item["source"]["title"]}
            for item in results
            if isinstance(item, dict) and item.get("source")
        ]
        if citations:
            answer_text = "子代理检索命中 " + str(len(citations)) + " 条项目知识。"
        else:
            answer_text = "子代理检索未命中项目知识。"
        return {"citations": citations, "answer": answer_text}

    def summarize_node(state: _SubagentResearchState) -> dict[str, Any]:
        """把子代理结果打包为带标记的 JSON 文本（供主图识别与 citations 回传）。

        :param state: 子代理状态。
        :return: 状态增量（最后一条 ``AIMessage``，即 ``task`` 工具回传内容）。
        :raises: 本节点不抛出异常。
        """
        report = json.dumps(
            {
                "subagent_report": True,
                "answer": state.get("answer"),
                "citations": state.get("citations") or [],
            },
            ensure_ascii=False,
        )
        return {"messages": [AIMessage(content=report)]}

    builder: StateGraph = StateGraph(_SubagentResearchState)
    builder.add_node("lookup_knowledge", lookup_node)
    builder.add_node("summarize", summarize_node)
    builder.add_edge(START, "lookup_knowledge")
    builder.add_edge("lookup_knowledge", "summarize")
    builder.add_edge("summarize", END)
    mini_graph = builder.compile()

    def _entry(state: dict[str, Any], config: RunnableConfig | None = None) -> dict[str, Any]:
        """子代理拦截入口：子代理首次被调用时计入预算，越界安全停止。

        :param state: ``task`` 工具准备的子代理输入状态。
        :param config: 运行配置（透传给 mini 图）。
        :return: 含 ``messages`` 的状态 dict（mini 图输出或预算触顶说明）。
        """
        try:
            budget.consume_subagent()
            return mini_graph.invoke({"messages": list(state.get("messages") or [])}, config)
        except BudgetExceededError as exc:
            return {
                "messages": [
                    AIMessage(
                        content=json.dumps(
                            {
                                "subagent_report": True,
                                "answer": f"子代理预算触顶（{exc.dimension}），安全停止。",
                                "citations": [],
                            },
                            ensure_ascii=False,
                        )
                    )
                ]
            }

    return RunnableLambda(_entry)


def build_deep_research_agent(
    context: ToolContext, budget: BudgetGuard | ResearchBudget, *, fake_model: BaseChatModel | None = None
) -> CompiledStateGraph:
    """构建 DeepAgents 受控研究代理（编译图）。

    配置纪律：受限工具集 + 只读隔离沙箱（``StateBackend`` + 仅 ``read_file``）
    + 1 个受限研究子代理与 1 个 ``general-purpose`` 受限替身（均为
    ``CompiledSubAgent``，不继承任何文件中间件；替身用于阻止 deepagents
    自动加入带默认文件工具栈的通用子代理）。模型缺省使用
    :class:`ScriptedResearchChatModel`（离线确定性脚本）。

    :param context: 工具执行上下文（project/user 权限锚点）。
    :param budget: 预算守卫；传入 :class:`ResearchBudget` 时自动包装为
        :class:`BudgetGuard`（工具闭包与子代理入口按此把关）。
    :param fake_model: 可选注入的离线 fake 模型（如指定
        ``latency_seconds`` 或 ``plan="delegate"`` 的脚本模型）。
    :return: 编译后的 DeepAgents 图；``.invoke`` / ``.stream`` 输入输出为
        同构消息状态。
    :raises Exception: deepagents 构建配置错误时原样抛出（属编程错误，不静默）。
    """
    guard = budget if isinstance(budget, BudgetGuard) else BudgetGuard(budget)
    tools = bind_research_tools(context, guard)
    researcher: CompiledSubAgent = {
        "name": "project-researcher",
        "description": "受限项目知识研究子代理：仅可只读检索当前项目知识库，无文件/shell/网络能力。",
        "runnable": _build_subagent_runnable(context, guard),
    }
    # deepagents 在未显式提供名为 general-purpose 的子代理时会自动追加一个
    # 带默认文件工具栈的通用子代理；此处用同一受限 runnable 的替身覆盖默认，
    # 保证整个代理树无任何文件写入 / shell 能力（官方契约：显式 spec 覆盖默认）。
    gp_stand_in: CompiledSubAgent = {
        "name": "general-purpose",
        "description": "受限研究替身：与主研究代理同一套只读项目工具，禁止文件写入与命令执行。",
        "runnable": _build_subagent_runnable(context, guard),
    }
    model = fake_model or ScriptedResearchChatModel(project_id=context.project_id)
    return create_deep_agent(
        model,
        tools,
        system_prompt=_RESEARCH_SYSTEM_PROMPT,
        middleware=[
            # 按名替换 deepagents 默认文件中间件：StateBackend 为图 state 内
            # 隔离沙箱，tools=["read_file"] 仅暴露只读工具（写/删/shell 全隐藏）。
            FilesystemMiddleware(backend=StateBackend(), tools=["read_file"]),
        ],
        subagents=[researcher, gp_stand_in],
    )


def _absorb_tool_message(message: ToolMessage, flags: dict[str, Any]) -> None:
    """解析工具结果消息，累计 citations / 工具调用数 / 预算触顶标记。

    :param message: ``ToolMessage``（content 为工具返回的 JSON 字符串）。
    :param flags: 运行期累计标志 dict（就地更新）。
    :raises: 解析失败时静默跳过（不中断部分结果收集）。
    """
    try:
        payload = json.loads(str(message.content))
    except (TypeError, ValueError):
        return
    if not isinstance(payload, dict):
        return
    if payload.get("budget_exceeded") and flags["budget_exceeded_dimension"] is None:
        flags["budget_exceeded_dimension"] = payload.get("dimension") or "unknown"
    if payload.get("subagent_report"):
        flags["subagents"] += 1
        for citation in payload.get("citations") or []:
            flags["citations"].append(citation)
        return
    flags["tool_calls"] += 1
    for item in payload.get("results") or []:
        source = (item or {}).get("source") or {}
        flags["citations"].append({"source": source.get("id"), "title": source.get("title")})
    source = payload.get("source") or {}
    if source:
        flags["citations"].append({"source": source.get("id"), "title": source.get("title")})


def _dedupe_citations(citations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """对 citations 按 (source, title) 去重并剔除无效项（保序）。

    :param citations: 原始 citations 列表。
    :return: 去重后的 ``[{"source": id, "title": title}]`` 列表。
    """
    seen: set[tuple[Any, Any]] = set()
    output: list[dict[str, Any]] = []
    for citation in citations:
        source = citation.get("source")
        title = citation.get("title")
        if source is None:
            continue
        key = (source, title)
        if key in seen:
            continue
        seen.add(key)
        output.append({"source": source, "title": title})
    return output


def run_deep_research(
    agent: CompiledStateGraph,
    *,
    project_id: int,
    question: str,
    budget: ResearchBudget,
) -> dict:
    """运行 DeepAgents 研究代理并产出与 LangGraph 对照同构的结果 dict。

    执行保护：图执行置于后台守护线程，主线程 ``join(timeout=budget.
    max_wall_time_seconds)``，超时安全返回部分结果（线程自然收尾，不阻塞）；
    步骤预算在 stream 循环内逐步 ``consume_step()``，触顶即停止迭代。

    :param agent: :func:`build_deep_research_agent` 返回的编译图。
    :param project_id: 项目 ID（结果回显；权限锚点在构建时由 context 绑定）。
    :param question: 研究问题（作为首轮用户消息）。
    :param budget: 本轮运行的预算配置（max 值须与构建时 BudgetGuard 的配置
        一致，由调用方保证）。
    :return: 结果 dict，含 engine/status/answer/citations/steps/tool_calls/
        subagents_used/latency_ms/cost_estimate_usd/budget_snapshot/partial；
        ``status`` 为 completed（完成）、budget_exceeded（任一预算触顶或
        wall-time 超时，partial=True）或 error（其余异常，partial=True）。
        ``citations`` 每项含 ``{"source": 知识条目 id, "title": 标题}``，
        预算触顶时保留已收集的部分结果。
    :raises: 本函数不向调用方抛出图执行异常（全部折算为 error 状态）。
    """
    guard = BudgetGuard(budget)
    flags: dict[str, Any] = {
        "answer": None,
        "citations": [],
        "tool_calls": 0,
        "subagents": 0,
        "budget_exceeded_dimension": None,
        "error": None,
    }
    started = time.perf_counter()

    def _execute() -> None:
        """在后台线程中执行图 stream 循环并累计结果（不抛出，异常入 flags）。

        :raises BudgetExceededError: 循环内被捕获并记录维度后终止迭代。
        """
        try:
            for chunk in agent.stream(
                {"messages": [HumanMessage(content=question)]}, stream_mode="updates"
            ):
                guard.consume_step()
                guard.ensure_within_wall_time()
                if not isinstance(chunk, dict):
                    continue
                for update in chunk.values():
                    messages = update.get("messages") if isinstance(update, dict) else None
                    for message in messages or []:
                        if isinstance(message, ToolMessage):
                            _absorb_tool_message(message, flags)
                        elif (
                            isinstance(message, AIMessage)
                            and not message.tool_calls
                            and str(message.content or "").strip()
                        ):
                            flags["answer"] = str(message.content)
        except BudgetExceededError as exc:
            flags["budget_exceeded_dimension"] = exc.dimension
        except Exception as exc:  # noqa: BLE001 - 试点要求任何异常折算为 error 状态
            flags["error"] = f"{type(exc).__name__}: {exc}"

    thread = threading.Thread(target=_execute, daemon=True, name="pd-deep-research")
    thread.start()
    thread.join(timeout=budget.max_wall_time_seconds)
    timed_out = thread.is_alive()
    latency_ms = int((time.perf_counter() - started) * 1000)

    status = "completed"
    if timed_out and flags["budget_exceeded_dimension"] is None:
        flags["budget_exceeded_dimension"] = "wall_time"
    if flags["error"] is not None:
        status = "error"
    elif flags["budget_exceeded_dimension"] is not None:
        status = "budget_exceeded"

    snapshot = guard.snapshot()
    snapshot["tool_calls"]["used"] = flags["tool_calls"]
    snapshot["subagents"]["used"] = flags["subagents"]
    cost_estimate = round(flags["tool_calls"] * COST_PER_TOOL_CALL_USD, 6)
    snapshot["cost_estimate_usd"]["used"] = cost_estimate
    snapshot["exceeded_dimension"] = flags["budget_exceeded_dimension"]
    snapshot["exceeded"] = flags["budget_exceeded_dimension"] is not None

    return {
        "engine": "deepagents",
        "status": status,
        "answer": flags["answer"],
        "citations": _dedupe_citations(flags["citations"]),
        "steps": snapshot["steps"]["used"],
        "tool_calls": flags["tool_calls"],
        "subagents_used": flags["subagents"],
        "latency_ms": latency_ms,
        "cost_estimate_usd": cost_estimate,
        "budget_snapshot": snapshot,
        "partial": status != "completed",
    }
