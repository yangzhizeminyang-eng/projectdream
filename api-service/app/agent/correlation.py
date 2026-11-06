"""关联 ID 追踪与日志脱敏（阶段 6）。

三个组件：

- :class:`TraceContext`：跨请求/流水线/执行/生成任务/供应商任务/线程/检查点的
  关联 ID 容器，``to_log_fields()`` 输出结构化日志字段；
- :class:`RedactingLogger`：包装标准 logger，输出前强制脱敏——不记录密钥、
  完整提示词（>64 字符截断）、私人媒体 URL（剥离查询参数）；
- :func:`correlation_log`：结构化一条携带 TraceContext 与业务字段的脱敏日志。

脱敏纪律（任务书阶段 6）：日志不出现密钥、完整提示词、私人媒体 URL。
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

# 脱敏截断阈值：超过该长度的文本视为提示词/用户输入，截断加省略号。
MAX_TEXT_LENGTH = 64
# 截断后的省略号后缀。
_ELLIPSIS = "…"
# 密钥占位符。
_REDACTED = "[REDACTED]"

# 私人媒体 URL：剥离整个查询串（签名/过期时间等敏感参数），只保留 path 前缀。
_URL_QUERY_PATTERN = re.compile(r"(https?://[^\s?\"']+)\?\S*")

# OpenAI 风格密钥：sk- 前缀 + 足够长的值（\b 防止误伤 "risk-..." 这类词内匹配）。
_SK_KEY_PATTERN = re.compile(r"\bsk-[A-Za-z0-9_-]{6,}")

# JWT 形态：eyJ 开头（Base64URL 的 {" 头部）的长 token。
_JWT_PATTERN = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.?[A-Za-z0-9_.-]*")

# Bearer 令牌：只保留方案名，值替换为占位符。
_BEARER_PATTERN = re.compile(r"\b(?i:bearer)\s+[A-Za-z0-9._~+/=-]+")

# API key / 令牌等键值形态：name=... 或 name: ...（值替换为占位符，保留键名）。
_KEY_VALUE_PATTERN = re.compile(
    r"\b(?i:api[_-]?key|apikey|access[_-]?token|secret|password|token)\s*[=:]\s*\S+"
)


class TraceContext(BaseModel):
    """关联 ID 容器：贯穿请求 → 流水线 run → 图执行 → 生成任务 → 供应商任务。

    :param request_id: HTTP 请求 ID（网关注入的 x-request-id）。
    :param pipeline_run_id: 业务流水线 run ID（agent_pipeline_runs）。
    :param execution_id: 编排图执行 ID（LangGraph 执行实例）。
    :param generation_job_id: 生成任务 ID（generation_jobs）。
    :param provider_task_id: 供应商侧任务 ID。
    :param thread_id: LangGraph thread ID（试点语义下即 run_id）。
    :param checkpoint_id: checkpoint 标识。
    """

    model_config = ConfigDict(extra="forbid")

    request_id: str | None = Field(default=None, description="HTTP 请求 ID")
    pipeline_run_id: str | None = Field(default=None, description="业务流水线 run ID")
    execution_id: str | None = Field(default=None, description="编排图执行 ID")
    generation_job_id: str | None = Field(default=None, description="生成任务 ID")
    provider_task_id: str | None = Field(default=None, description="供应商侧任务 ID")
    thread_id: str | None = Field(default=None, description="LangGraph thread ID")
    checkpoint_id: str | None = Field(default=None, description="checkpoint 标识")

    def to_log_fields(self) -> dict[str, Any]:
        """输出结构化日志字段（仅包含非空 ID，键名带 trace. 前缀）。

        :returns: ``{"trace.request_id": ..., "trace.pipeline_run_id": ...}`` 等字段 dict；
            全部 ID 为空时返回空 dict。
        """
        fields: dict[str, Any] = {}
        for name, value in self.model_dump().items():
            if value is not None:
                fields[f"trace.{name}"] = value
        return fields


def redact(text: Any, *, max_text_length: int = MAX_TEXT_LENGTH) -> str:
    """对任意文本执行脱敏（顺序：URL 查询参数剥离 → 密钥替换 → 长文本截断）。

    规则：
    1. URL 查询参数剥离：私人媒体 URL 只保留 path 前缀（签名/过期参数消失）；
    2. 密钥模式替换：sk- 前缀密钥、Bearer 后的值、eyJ 开头的 JWT、
       ``api_key=...`` 等键值形态 → ``[REDACTED]``；
    3. 长度超过阈值的文本（提示词/用户输入）截断加 ``…``。

    :param text: 任意输入（非字符串先转 str）。
    :param max_text_length: 长文本截断阈值（字符数，默认 64）。
    :returns: 脱敏后的字符串。
    """
    value = text if isinstance(text, str) else str(text)
    value = _URL_QUERY_PATTERN.sub(r"\1", value)
    value = _JWT_PATTERN.sub(_REDACTED, value)
    value = _BEARER_PATTERN.sub(f"Bearer {_REDACTED}", value)
    value = _SK_KEY_PATTERN.sub(_REDACTED, value)
    value = _KEY_VALUE_PATTERN.sub(_REDACTED, value)
    if len(value) > max_text_length:
        value = value[:max_text_length] + _ELLIPSIS
    return value


def redact_value(value: Any) -> Any:
    """对结构化字段的值脱敏（dict/list 序列化后整体脱敏，其他转 str 脱敏）。

    :param value: 字段值（str/dict/list/标量）。
    :returns: 脱敏后的字符串。
    """
    if isinstance(value, (dict, list, tuple)):
        return redact(json.dumps(value, ensure_ascii=False))
    return redact(value)


class RedactingLogger:
    """脱敏日志包装器：所有输出先经 :func:`redact` 再交给底层 logger。

    :param logger: 被包装的标准 logger。
    :param max_text_length: 截断阈值（默认 64，可注入以便测试）。
    """

    def __init__(self, logger: logging.Logger, *, max_text_length: int = MAX_TEXT_LENGTH) -> None:
        """注入底层 logger 与截断阈值。

        :param logger: 标准 logging.Logger 实例。
        :param max_text_length: 长文本截断阈值（字符数）。
        """
        self._logger = logger
        self._max_text_length = max_text_length

    @property
    def underlying(self) -> logging.Logger:
        """被包装的底层 logger。

        :returns: logging.Logger 实例。
        """
        return self._logger

    def _emit(
        self,
        level: int,
        msg: Any,
        args: tuple,
        exc_info: Any = None,
        extra: dict | None = None,
    ) -> None:
        """格式化并脱敏后写底层 logger（内部方法）。

        :param level: 日志级别。
        :param msg: 消息模板（可能含 %s 占位）。
        :param args: 模板参数（先 % 格式化再整体脱敏）。
        :param exc_info: 透传给底层 logger 的异常信息。
        :param extra: 透传给底层 logger 的 extra 字段。
        :raises Exception: 底层 logger 写入失败时原样抛出（基础设施错误，不静默）。
        """
        try:
            text = str(msg) % args if args else str(msg)
        except (TypeError, ValueError):
            text = str(msg)
        self._logger.log(
            level,
            redact(text, max_text_length=self._max_text_length),
            exc_info=exc_info,
            extra=extra,
        )

    def debug(self, msg: Any, *args: Any, **kwargs: Any) -> None:
        """写 DEBUG 级脱敏日志。

        :param msg: 消息模板或文本。
        :param args: 模板参数。
        :param kwargs: 透传参数（exc_info/extra）。
        """
        self._emit(logging.DEBUG, msg, args, **kwargs)

    def info(self, msg: Any, *args: Any, **kwargs: Any) -> None:
        """写 INFO 级脱敏日志。

        :param msg: 消息模板或文本。
        :param args: 模板参数。
        :param kwargs: 透传参数（exc_info/extra）。
        """
        self._emit(logging.INFO, msg, args, **kwargs)

    def warning(self, msg: Any, *args: Any, **kwargs: Any) -> None:
        """写 WARNING 级脱敏日志。

        :param msg: 消息模板或文本。
        :param args: 模板参数。
        :param kwargs: 透传参数（exc_info/extra）。
        """
        self._emit(logging.WARNING, msg, args, **kwargs)

    def error(self, msg: Any, *args: Any, **kwargs: Any) -> None:
        """写 ERROR 级脱敏日志。

        :param msg: 消息模板或文本。
        :param args: 模板参数。
        :param kwargs: 透传参数（exc_info/extra）。
        """
        self._emit(logging.ERROR, msg, args, **kwargs)

    def exception(self, msg: Any, *args: Any, **kwargs: Any) -> None:
        """写携带异常栈的 ERROR 级脱敏日志（消息本身仍脱敏）。

        :param msg: 消息模板或文本。
        :param args: 模板参数。
        :param kwargs: 透传参数（exc_info/extra）。
        """
        kwargs.setdefault("exc_info", True)
        self._emit(logging.ERROR, msg, args, **kwargs)


def correlation_log(
    logger: RedactingLogger | logging.Logger,
    event: str,
    ctx: TraceContext,
    **fields: Any,
) -> None:
    """结构化记录一条关联日志：event + TraceContext 字段 + 业务字段，全部脱敏。

    输出形如 ``{"event": ..., "trace.request_id": ..., ...}`` 的单行 JSON，
    每个字段值先经 :func:`redact_value` 脱敏（含 64 字符逐值截断）。
    传入 :class:`RedactingLogger` 时直接写其底层 logger（避免整行被二次截断），
    传入标准 logger 时按原样写（字段值已脱敏）。

    :param logger: 目标 logger（RedactingLogger 或标准 logging.Logger）。
    :param event: 事件名（如 ``agent.run.completed``）。
    :param ctx: 关联 ID 上下文。
    :param fields: 附加业务字段（值经 redact_value 脱敏）。
    :returns: 无返回值。
    :raises Exception: 底层 logger 写入失败时原样抛出（属基础设施错误，不静默）。
    """
    payload: dict[str, Any] = {"event": event}
    payload.update(ctx.to_log_fields())
    for key, value in fields.items():
        payload[key] = redact_value(value)
    line = json.dumps(payload, ensure_ascii=False)
    if isinstance(logger, RedactingLogger):
        # 字段值已逐项脱敏（含超长截断），直接写底层 logger；
        # 若再走 RedactingLogger 会把整行 JSON 按 64 字符截断破坏结构。
        logger.underlying.info(line)
    else:
        logger.info(line)
