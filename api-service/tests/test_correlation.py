"""关联 ID 追踪与日志脱敏单元测试（阶段 6）。

覆盖：
- TraceContext：六类 ID 全贯通（request/pipeline_run/execution/generation_job/
  provider_task/thread/checkpoint）、to_log_fields 仅含非空字段；
- redact：sk- 密钥、Bearer 后值、eyJ JWT、api_key= 键值形态、长文本截断（>64 加 …）、
  私人媒体 URL 剥离查询参数、正常短文本不误伤；
- RedactingLogger / correlation_log：结构化日志携带 TraceContext 与业务字段且全部脱敏。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from app.agent.correlation import (
    MAX_TEXT_LENGTH,
    RedactingLogger,
    TraceContext,
    correlation_log,
    redact,
)

# 各类密钥样例（仅测试假值）。
_SK_KEY = "sk-abc123def456ghi789jkl012"
_BEARER_TOKEN = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
_RAW_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"


class ListHandler(logging.Handler):
    """捕获日志消息的内存 handler（测试断言用）。

    :param: 无参数。
    """

    def __init__(self) -> None:
        """初始化记录容器。"""
        super().__init__()
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        """追加格式化后的消息文本。

        :param record: 日志记录。
        :returns: 无返回值。
        """
        self.messages.append(record.getMessage())


def make_full_context() -> TraceContext:
    """构造携带全部关联 ID 的 TraceContext。

    :returns: TraceContext 实例（六类 ID 全部非空）。
    """
    return TraceContext(
        request_id="req-1001",
        pipeline_run_id="prun-2002",
        execution_id="exec-3003",
        generation_job_id="job-4004",
        provider_task_id="ptask-5005",
        thread_id="thread-6006",
        checkpoint_id="ckpt-7007",
    )


# ---------------------------------------------------------------------------
# TraceContext
# ---------------------------------------------------------------------------


def test_trace_context_to_log_fields_covers_all_ids() -> None:
    """全部 ID 贯通：to_log_fields 输出七个 trace.* 字段且值一致。

    :returns: 无返回值。
    :raises AssertionError: 字段缺失或值不符时抛出。
    """
    fields = make_full_context().to_log_fields()
    assert fields == {
        "trace.request_id": "req-1001",
        "trace.pipeline_run_id": "prun-2002",
        "trace.execution_id": "exec-3003",
        "trace.generation_job_id": "job-4004",
        "trace.provider_task_id": "ptask-5005",
        "trace.thread_id": "thread-6006",
        "trace.checkpoint_id": "ckpt-7007",
    }


def test_trace_context_empty_yields_empty_fields() -> None:
    """全空上下文输出空字段 dict（不产生 None 值日志噪音）。

    :returns: 无返回值。
    :raises AssertionError: 出现 None 值字段时抛出。
    """
    assert TraceContext().to_log_fields() == {}


def test_trace_context_partial_fields_only_present_ids() -> None:
    """部分 ID 时只输出非空字段。

    :returns: 无返回值。
    :raises AssertionError: 出现未填字段时抛出。
    """
    fields = TraceContext(request_id="req-1", thread_id="t-1").to_log_fields()
    assert fields == {"trace.request_id": "req-1", "trace.thread_id": "t-1"}


# ---------------------------------------------------------------------------
# redact 规则
# ---------------------------------------------------------------------------


def test_redact_sk_key_replaced() -> None:
    """sk- 前缀密钥整体替换为 [REDACTED]，原文不残留。

    :returns: 无返回值。
    :raises AssertionError: 密钥原文残留时抛出。
    """
    redacted = redact(f"Authorization: {_SK_KEY}")
    assert "[REDACTED]" in redacted
    assert "abc123def456" not in redacted


def test_redact_bearer_value_replaced() -> None:
    """Bearer 后的令牌值替换为 [REDACTED]，方案名保留。

    :returns: 无返回值。
    :raises AssertionError: 令牌原文残留时抛出。
    """
    redacted = redact(f"Authorization: {_BEARER_TOKEN}")
    assert "Bearer [REDACTED]" in redacted
    assert "eyJhbGciOiJIUzI1NiJ9" not in redacted


def test_redact_jwt_prefix_replaced() -> None:
    """eyJ 开头的 JWT 形态整体替换为 [REDACTED]。

    :returns: 无返回值。
    :raises AssertionError: JWT 原文残留时抛出。
    """
    redacted = redact(f"token payload: {_RAW_JWT}")
    assert "[REDACTED]" in redacted
    assert "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" not in redacted


def test_redact_api_key_value_form_replaced() -> None:
    """api_key= 键值形态替换为 [REDACTED]。

    :returns: 无返回值。
    :raises AssertionError: 键值原文残留时抛出。
    """
    redacted = redact("api_key=abcd1234efgh5678")
    assert "[REDACTED]" in redacted
    assert "abcd1234efgh5678" not in redacted


def test_redact_truncates_long_text_with_ellipsis() -> None:
    """超过 64 字符的提示词/用户输入截断加 …（且先脱敏再截断）。

    :returns: 无返回值。
    :raises AssertionError: 截断长度不符或密钥残留时抛出。
    """
    long_prompt = "高质量分镜提示词" * 30 + _SK_KEY  # 密钥藏在长文本尾部
    redacted = redact(long_prompt)
    assert len(redacted) == MAX_TEXT_LENGTH + 1  # 截断 + 1 个省略号
    assert redacted.endswith("…")
    assert "abc123def456" not in redacted  # 截断前的密钥替换已生效


def test_redact_media_url_strips_query_params() -> None:
    """私人媒体 URL 剥离查询参数，只保留 path 前缀。

    :returns: 无返回值。
    :raises AssertionError: 查询参数残留时抛出。
    """
    redacted = redact(
        "media ready: https://media.example.com/private/clip-42.mp4?sign=abc123&expires=999999999&t=7"
    )
    assert "https://media.example.com/private/clip-42.mp4" in redacted
    assert "sign=abc123" not in redacted
    assert "expires=999999999" not in redacted


def test_redact_keeps_normal_short_text() -> None:
    """正常短文本不误伤：无密钥/URL/超长时原样返回。

    :returns: 无返回值。
    :raises AssertionError: 正常文本被改写时抛出。
    """
    text = "中景，角色推进，镜头缓慢推进，规则质检通过"
    assert redact(text) == text
    assert redact("状态: completed") == "状态: completed"


def test_redact_exact_threshold_not_truncated() -> None:
    """恰好等于 64 字符的文本不截断（仅严格大于才截断，保留前 64 字符加 …）。

    :returns: 无返回值。
    :raises AssertionError: 边界文本被误截断时抛出。
    """
    text = "a" * MAX_TEXT_LENGTH
    assert redact(text) == text
    assert redact(text + "b") == text + "…"


# ---------------------------------------------------------------------------
# RedactingLogger / correlation_log
# ---------------------------------------------------------------------------


def test_redacting_logger_redacts_and_truncates() -> None:
    """RedactingLogger 输出先脱敏再落底层 logger（密钥/超长文本）。"""
    handler = ListHandler()
    logger = logging.getLogger("test-redacting-logger")
    logger.handlers = [handler]
    logger.setLevel(logging.INFO)
    redacting = RedactingLogger(logger)
    redacting.info(f"用户密钥 {_SK_KEY} 已随请求提交")
    redacting.warning("x" * 200)
    assert len(handler.messages) == 2
    assert "[REDACTED]" in handler.messages[0]
    assert "abc123def456" not in handler.messages[0]
    assert handler.messages[1].endswith("…")
    assert len(handler.messages[1]) == MAX_TEXT_LENGTH + 1


def test_correlation_log_structured_with_context_and_redacted_fields() -> None:
    """correlation_log 输出单行 JSON：event + trace.* + 业务字段全部脱敏。

    :returns: 无返回值。
    :raises AssertionError: 结构缺字段或敏感值残留时抛出。
    """
    handler = ListHandler()
    logger = logging.getLogger("test-correlation-log")
    logger.handlers = [handler]
    logger.setLevel(logging.INFO)
    redacting = RedactingLogger(logger)
    correlation_log(
        redacting,
        "agent.run.completed",
        make_full_context(),
        user_prompt="分镜提示词 " + _SK_KEY,
        media_url="https://media.example.com/private/clip-42.mp4?sign=abc123",
        duration_ms=12,
    )
    assert len(handler.messages) == 1
    payload: dict[str, Any] = json.loads(handler.messages[0])
    assert payload["event"] == "agent.run.completed"
    assert payload["trace.request_id"] == "req-1001"
    assert payload["trace.pipeline_run_id"] == "prun-2002"
    assert payload["trace.execution_id"] == "exec-3003"
    assert payload["trace.generation_job_id"] == "job-4004"
    assert payload["trace.provider_task_id"] == "ptask-5005"
    assert payload["trace.thread_id"] == "thread-6006"
    assert payload["trace.checkpoint_id"] == "ckpt-7007"
    assert "[REDACTED]" in payload["user_prompt"]
    assert "abc123def456" not in payload["user_prompt"]
    assert payload["media_url"] == "https://media.example.com/private/clip-42.mp4"
    assert payload["duration_ms"] == "12"  # 标量统一经 redact 转字符串
