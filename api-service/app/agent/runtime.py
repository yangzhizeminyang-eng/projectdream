"""Agent 运行时骨架。

职责：把 :class:`~app.agent.schemas.AgentRequest` 变成六态终态的
:class:`~app.agent.schemas.AgentResult`，全程贯穿 trace_id 与 usage。

- 幂等重放：同一 idempotency_key 命中已有终态结果时直接重放（append_event("idempotent_replay")）。
- 状态机：queued → running → 终态（completed/failed/retryable_failed/blocked/canceled 等）。
- 异常映射：InvalidInputError/PermissionDeniedError/ToolInvocationError(非重试) → blocked；
  ToolInvocationError(重试)/ModelOutputError → retryable_failed；其他 Exception → failed（消息脱敏）。
- 图注入：graph_builder 由调用方注入（本模块不 import quality 模块，避免循环依赖）。
  约定：graph_builder 接受 ModelProvider，返回可调用对象 ``run(state: dict) -> dict``，
  返回 state 需含 status/validated_output/blockers/usage 键（LangGraph 编译图的
  ``.invoke(state)`` 即满足该约定）。
"""

from __future__ import annotations

import threading
import uuid
from typing import Any, Callable

from app.agent.errors import (
    InvalidInputError,
    ModelOutputError,
    PermissionDeniedError,
    ToolInvocationError,
)
from app.agent.model_provider import ModelProvider
from app.agent.run_store import RunStore
from app.agent.schemas import AgentRequest, AgentResult

# 终态集合：cancel 只对未达终态的 run 生效；resume 只接受可重试终态。
_TERMINAL_STATUSES = frozenset({"completed", "failed", "retryable_failed", "blocked", "canceled"})
# resume 允许重放的终态集合。
_RESUMABLE_STATUSES = frozenset({"blocked", "retryable_failed"})


class AgentRuntime:
    """Agent 执行入口：编排幂等、run 记录、图执行与异常→状态映射。

    :param provider: 结构化输出模型提供方。
    :param store: run 存储实现。
    :param graph_builder: 可选的图构建工厂 ``(provider) -> run(state: dict) -> dict``；
        为 None 时对任何 task_type 均映射为 blocked（阶段 1 试点未注册编排图）。
    """

    def __init__(
        self,
        *,
        provider: ModelProvider,
        store: RunStore,
        graph_builder: Callable[[ModelProvider], Any] | None = None,
    ) -> None:
        """注入依赖并初始化空的图缓存。

        :param provider: 模型提供方。
        :param store: run 存储。
        :param graph_builder: 图构建工厂（调用方注入，避免与 quality 模块循环依赖）。
        """
        self._provider = provider
        self._store = store
        self._graph_builder = graph_builder
        self._graphs: dict[str, Any] = {}
        self._graphs_lock = threading.Lock()

    def invoke(self, request: AgentRequest) -> AgentResult:
        """执行一次 Agent 请求（幂等 + 全程事件留痕）。

        :param request: Agent 执行请求。
        :returns: 终态结果（所有异常均已映射为终态，不向外抛业务异常）。
        """
        trace_id = uuid.uuid4().hex
        # 幂等重放：命中已有终态结果时直接返回，不重复执行编排图。
        existing = self._store.find_by_idempotency_key(request.idempotency_key)
        if existing is not None and existing.get("result"):
            replayed = AgentResult.model_validate(existing["result"])
            self._store.append_event(replayed.run_id, "idempotent_replay", {"trace_id": trace_id})
            return replayed
        run_id = self._store.create_run(request, trace_id)
        self._store.append_event(run_id, "queued", {"trace_id": trace_id})
        self._store.append_event(run_id, "running", {"trace_id": trace_id})
        result = self._execute(request, run_id, trace_id)
        # 每个终态都 update_status + append_event。
        self._store.update_status(run_id, result.status, result)
        self._store.append_event(run_id, result.status, {"trace_id": trace_id})
        return result

    def get_status(self, run_id: str) -> dict[str, Any] | None:
        """查询 run 当前状态与结果。

        :param run_id: 运行 ID。
        :returns: run 记录 dict（含 status/result/事件外键信息）；不存在时返回 None。
        """
        return self._store.get_run(run_id)

    def resume(self, run_id: str) -> AgentResult | None:
        """对 blocked/retryable_failed 的 run 用原 payload 重放。

        阶段 1 语义：派生新幂等键与新 run_id（原 run 保留现场），返回新终态结果。

        :param run_id: 原 run ID。
        :returns: 重放后的新终态结果；run 不存在或状态不可重试时返回 None。
        """
        run = self._store.get_run(run_id)
        if run is None or run.get("status") not in _RESUMABLE_STATUSES:
            return None
        base_key = str(run.get("idempotency_key") or "")[:110]
        request = AgentRequest(
            project_id=int(run["project_id"]),
            task_type=run["task_type"],
            payload=run.get("payload") or {},
            idempotency_key=f"{base_key}-resume-{uuid.uuid4().hex[:8]}",
            run_id=None,
        )
        return self.invoke(request)

    def cancel(self, run_id: str) -> AgentResult | None:
        """取消未到终态的 run。

        :param run_id: 运行 ID。
        :returns: canceled 终态结果；run 不存在或已达终态时返回 None。
        """
        run = self._store.get_run(run_id)
        if run is None or run.get("status") in _TERMINAL_STATUSES:
            return None
        trace_id = str(run.get("trace_id") or uuid.uuid4().hex)
        result = AgentResult(
            run_id=run_id,
            status="canceled",
            validated_output=None,
            blockers=[{"code": "canceled", "message": "run 被人工取消", "severity": "warning"}],
            usage={},
            trace_id=trace_id,
            checkpoint_id=run_id,
        )
        self._store.update_status(run_id, "canceled", result)
        self._store.append_event(run_id, "canceled", {"trace_id": trace_id})
        return result

    def _resolve_graph(self, task_type: str) -> Any:
        """按 task_type 取（或构建并缓存）编排图可调用对象。

        :param task_type: 任务类型。
        :returns: 可调用对象 ``run(state: dict) -> dict``。
        :raises InvalidInputError: 未注入 graph_builder（非试点 task_type）。
        """
        if self._graph_builder is None:
            raise InvalidInputError(f"task_type {task_type} 未注册编排图（阶段 1 试点未覆盖）")
        with self._graphs_lock:
            graph = self._graphs.get(task_type)
        if graph is None:
            graph = self._graph_builder(self._provider)
            # LangGraph 编译图不可直接调用（CompiledStateGraph 只提供 .invoke），
            # 这里统一适配为 ``run(state) -> dict`` 可调用契约，业务图无需自行包装。
            if not callable(graph) and hasattr(graph, "invoke"):
                graph = graph.invoke
            with self._graphs_lock:
                self._graphs[task_type] = graph
        return graph

    def _execute(self, request: AgentRequest, run_id: str, trace_id: str) -> AgentResult:
        """执行编排图并把异常映射为终态结果。

        :param request: Agent 执行请求。
        :param run_id: 运行 ID。
        :param trace_id: 追踪 ID。
        :returns: 终态结果（completed 等图内声明状态，或异常映射状态）。
        """
        state: dict[str, Any] = {
            "run_id": run_id,
            "trace_id": trace_id,
            "task_type": request.task_type,
            "project_id": request.project_id,
            "payload": request.payload,
            "status": "running",
            "validated_output": None,
            "blockers": [],
            "usage": {},
        }
        try:
            graph = self._resolve_graph(request.task_type)
            output = graph(state)
            result = AgentResult(
                run_id=run_id,
                status=str(output.get("status") or "completed"),
                validated_output=output.get("validated_output"),
                blockers=output.get("blockers") or [],
                usage=output.get("usage") or {},
                trace_id=trace_id,
                checkpoint_id=run_id,
            )
        except InvalidInputError as exc:
            return self._failure_result(run_id, trace_id, "blocked", "invalid_input", exc.message)
        except PermissionDeniedError as exc:
            return self._failure_result(run_id, trace_id, "blocked", "permission_denied", exc.message)
        except ToolInvocationError as exc:
            if exc.retryable:
                return self._failure_result(run_id, trace_id, "retryable_failed", "tool_retryable", exc.message)
            return self._failure_result(run_id, trace_id, "blocked", "tool_blocked", exc.message)
        except ModelOutputError as exc:
            return self._failure_result(run_id, trace_id, "retryable_failed", "model_output", exc.message)
        except Exception as exc:
            # 脱敏：不携带异常消息（可能内嵌用户数据），仅暴露异常类型名。
            return self._failure_result(
                run_id, trace_id, "failed", "internal_error", f"agent_run_failed: {type(exc).__name__}"
            )
        return result

    @staticmethod
    def _failure_result(run_id: str, trace_id: str, status: str, code: str, message: str) -> AgentResult:
        """构造失败终态结果（blockers 携带脱敏错误摘要）。

        :param run_id: 运行 ID。
        :param trace_id: 追踪 ID。
        :param status: 失败终态（blocked/retryable_failed/failed）。
        :param code: 阻塞项错误码。
        :param message: 脱敏错误说明。
        :returns: 对应终态的 AgentResult。
        """
        return AgentResult(
            run_id=run_id,
            status=status,
            validated_output=None,
            blockers=[{"code": code, "message": message, "severity": "error"}],
            usage={},
            trace_id=trace_id,
            checkpoint_id=run_id,
        )
