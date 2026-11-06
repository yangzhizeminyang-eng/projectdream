"""Agent 工具注册表与调用执行器。

阶段 1 试点：为 LangGraph 编排图提供受控的工具调用入口。
- 注册时声明 :class:`~app.agent.schemas.ToolSpec`（输入 schema + 权限范围 + 超时）。
- 调用时按序执行：存在性 → schema 校验 → 权限校验 → 超时包裹执行。
- 每次调用写一条脱敏审计日志（extra 不含 payload 与用户数据）。

异常语义见 :mod:`app.agent.errors`。
"""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from typing import Callable

from app.agent.errors import InvalidInputError, PermissionDeniedError, ToolInvocationError
from app.agent.schemas import ToolContext, ToolInvocationResult, ToolSpec

logger = logging.getLogger(__name__)

# 工具处理器签名：接收 (payload, context)，返回 dict 输出。
ToolHandler = Callable[[dict, ToolContext], dict]

# 共享线程池：以 future.result(timeout) 为同步 handler 提供软超时。
# 注意：超时后 worker 线程可能继续运行，无法强杀；骨架阶段可接受，
# 后续如需硬中断应改用子进程或异步 handler。
_TOOL_EXECUTOR = ThreadPoolExecutor(max_workers=8, thread_name_prefix="agent-tool")

# JSON Schema 基础类型 → 校验函数映射（手写校验，不新增依赖）。
_TYPE_CHECKERS: dict[str, Callable[[object], bool]] = {
    "string": lambda value: isinstance(value, str),
    "number": lambda value: isinstance(value, (int, float)) and not isinstance(value, bool),
    "integer": lambda value: isinstance(value, int) and not isinstance(value, bool),
    "boolean": lambda value: isinstance(value, bool),
    "array": lambda value: isinstance(value, list),
    "object": lambda value: isinstance(value, dict),
}


def validate_payload_against_schema(tool_name: str, input_schema: dict, payload: dict) -> None:
    """按工具声明校验输入负载。

    仅支持 ``{"type": "object", "properties": {...}, "required": [...]}`` 子集，
    属性类型支持 string/number/integer/boolean/array/object。

    :param tool_name: 工具名，用于错误消息定位。
    :param input_schema: 工具输入 JSON Schema 声明。
    :param payload: 待校验的输入负载。
    :returns: 校验通过时无返回值。
    :raises InvalidInputError: 缺少必填字段、字段类型不符或 schema 声明超出支持范围。
    """
    if not isinstance(input_schema, dict):
        return
    declared_type = input_schema.get("type")
    if declared_type not in (None, "object"):
        raise InvalidInputError(f"工具 {tool_name} 的 input_schema 仅支持 object 顶层类型")
    properties = input_schema.get("properties")
    properties = properties if isinstance(properties, dict) else {}
    required = input_schema.get("required")
    required = required if isinstance(required, list) else []
    for key in required:
        if key not in payload:
            raise InvalidInputError(f"工具 {tool_name} 缺少必填字段: {key}")
    for key, rule in properties.items():
        if key not in payload:
            continue
        expected = (rule or {}).get("type") if isinstance(rule, dict) else None
        checker = _TYPE_CHECKERS.get(expected) if expected else None
        if expected and checker is None:
            raise InvalidInputError(f"工具 {tool_name} 字段 {key} 声明了不支持的类型: {expected}")
        if checker is not None and not checker(payload[key]):
            raise InvalidInputError(f"工具 {tool_name} 字段 {key} 类型不符，期望 {expected}")


class ToolRegistry:
    """工具注册表：线程安全地管理 ToolSpec → handler 映射并提供受控调用。

    :param logger_name: 审计日志使用的 logger 名称；缺省为本模块 logger。
    """

    def __init__(self, logger_name: str | None = None) -> None:
        """初始化空注册表。

        :param logger_name: 可选的审计 logger 名。
        """
        self._specs: dict[str, ToolSpec] = {}
        self._handlers: dict[str, ToolHandler] = {}
        self._lock = threading.Lock()
        self._logger = logging.getLogger(logger_name) if logger_name else logger

    def register(self, spec: ToolSpec, handler: ToolHandler) -> None:
        """注册一个工具。

        :param spec: 工具声明（名称/输入 schema/权限范围/超时）。
        :param handler: 同步处理器，签名 ``(payload, context) -> dict``。
        :raises ValueError: 工具名重复注册。
        """
        with self._lock:
            if spec.name in self._specs:
                raise ValueError(f"工具 {spec.name} 已注册")
            self._specs[spec.name] = spec
            self._handlers[spec.name] = handler

    def invoke(self, name: str, payload: dict, context: ToolContext) -> ToolInvocationResult:
        """执行一次工具调用（含 schema 校验、权限校验、超时与审计）。

        :param name: 工具名。
        :param payload: 工具输入负载。
        :param context: 工具执行上下文（项目/权限/追踪）。
        :returns: 成功时返回 ``ok=True`` 且携带 handler 输出的结果封装。
        :raises ToolInvocationError: 工具未注册（retryable=False）、调用超时（retryable=True）或 handler 抛异常（retryable=False，消息脱敏）。
        :raises InvalidInputError: payload 不满足工具 input_schema。
        :raises PermissionDeniedError: spec.scopes 未被 context.granted_scopes 完全包含。
        """
        started = time.perf_counter()
        with self._lock:
            spec = self._specs.get(name)
            handler = self._handlers.get(name)
        if spec is None or handler is None:
            self._audit(context, name, started, "unknown_tool")
            raise ToolInvocationError(f"工具 {name} 未注册", retryable=False)
        try:
            validate_payload_against_schema(spec.name, spec.input_schema, payload)
        except InvalidInputError:
            self._audit(context, name, started, "invalid_input")
            raise
        missing_scopes = [scope for scope in spec.scopes if scope not in context.granted_scopes]
        if missing_scopes:
            self._audit(context, name, started, "permission_denied")
            raise PermissionDeniedError(f"工具 {name} 缺少权限范围: {', '.join(missing_scopes)}")
        future = _TOOL_EXECUTOR.submit(handler, payload, context)
        try:
            data = future.result(timeout=spec.timeout_seconds)
        except FutureTimeoutError:
            future.cancel()
            self._audit(context, name, started, "timeout")
            raise ToolInvocationError(
                f"工具 {name} 调用超时（>{spec.timeout_seconds:g}s）", retryable=True
            ) from None
        except Exception as exc:
            self._audit(context, name, started, "handler_error")
            # 脱敏：不携带异常消息（可能内嵌输入内容），仅暴露异常类型名。
            raise ToolInvocationError(f"工具 {name} 执行失败（{type(exc).__name__}）", retryable=False) from None
        self._audit(context, name, started, "success")
        return ToolInvocationResult(ok=True, data=data, error=None)

    def _audit(self, context: ToolContext, tool_name: str, started: float, outcome: str) -> None:
        """写一条脱敏审计日志。

        extra 只含 tool_name/run_id/project_id/duration_ms/outcome，
        不含 payload 与用户数据。

        :param context: 工具执行上下文。
        :param tool_name: 工具名。
        :param started: 调用起始时间（perf_counter）。
        :param outcome: 调用结果（success/timeout/handler_error/invalid_input/permission_denied/unknown_tool）。
        """
        duration_ms = int((time.perf_counter() - started) * 1000)
        self._logger.info(
            "agent_tool_invoked",
            extra={
                "tool_name": tool_name,
                "run_id": context.run_id,
                "project_id": context.project_id,
                "duration_ms": duration_ms,
                "outcome": outcome,
            },
        )
