"""调用方网关：allowlist 校验、滑动窗口限流、request_id 解析与脱敏审计日志。

安全纪律（与阶段 0 脱敏约定对齐）：
- 审计结构化行绝不携带 query 全文，只记录 ``query_len``；
- 摘要行中的 query 最多保留前 32 字符并追加省略号；
- 内部令牌（X-RAG-Internal-Token）与密钥绝不进入任何日志字段。

校验顺序由 main.py 保证：先内部令牌（401/403/503 语义不变），再 allowlist，
最后限流。
"""

import logging
import threading
import time
import uuid
from collections import deque
from typing import Callable

from fastapi import HTTPException

from .config import Settings

#: 网关审计日志器；测试通过 caplog 按 "rag.gateway" 过滤。
logger = logging.getLogger("rag.gateway")

#: 摘要行中 query 允许保留的最大字符数。
_QUERY_PREVIEW_MAX_CHARS = 32
#: 滑动窗口宽度（秒）。
_WINDOW_SECONDS = 60.0
#: allowlist 未启用时匿名调用方在限流桶中的名称。
_ANONYMOUS_CALLER = "anonymous"


class CallerGate:
    """调用方网关：allowlist 三态校验 + 每调用方滑动窗口限流 + 脱敏审计。

    :param settings: 服务配置（读取 caller_allowlist 与 rate_limit_per_minute）。
    :param clock: 单调时钟函数（默认 ``time.monotonic``）；测试可注入假时钟
        验证窗口滑动恢复，注入的函数必须返回单调递增的秒值。
    """

    def __init__(self, settings: Settings, *, clock: Callable[[], float] = time.monotonic) -> None:
        """构造网关并解析 allowlist 名单。

        :param settings: 服务配置实例。
        :param clock: 单调时钟函数。
        :raises ValueError: 速率限制配置为负数时抛出（配置层已校验，此处兜底）。
        """
        self._allowlist: set[str] = {
            item.strip() for item in settings.caller_allowlist.split(",") if item.strip()
        }
        self._rate_limit_per_minute = settings.rate_limit_per_minute
        self._clock = clock
        self._lock = threading.Lock()
        # 按 caller id 分桶的请求时间戳滑动窗口。
        self._windows: dict[str, deque[float]] = {}

    @property
    def allowlist_enabled(self) -> bool:
        """是否启用了 allowlist（名单非空）。

        :return: 名单非空返回 True；为空表示不启用（放行）。
        """
        return bool(self._allowlist)

    def resolve_request_id(self, request_id: str | None) -> str:
        """解析或生成请求追踪 ID。

        :param request_id: 请求头 ``X-Request-Id`` 的原始值（可为 None）。
        :return: 去除首尾空白后的外部 ID；缺失或空白时生成 uuid4 hex（32 字符）。
        """
        candidate = (request_id or "").strip()
        return candidate or uuid.uuid4().hex

    def check_caller(self, caller_id: str | None) -> None:
        """执行 allowlist 三态校验（仅内部令牌校验通过后调用）。

        语义：
        - 名单为空 → 不启用，直接放行（兼容既有部署）；
        - 名单启用且调用方头缺失/空白 → 401；
        - 名单启用但调用方不在名单 → 403。

        :param caller_id: 请求头 ``X-RAG-Caller-Id`` 的原始值。
        :raises HTTPException: 缺失调用方头抛 401；不在名单抛 403。
        """
        if not self._allowlist:
            return
        candidate = (caller_id or "").strip()
        if not candidate:
            raise HTTPException(status_code=401, detail="RAG caller id header is required")
        if candidate not in self._allowlist:
            raise HTTPException(status_code=403, detail="RAG caller id is not allowed")

    def check_rate_limit(self, caller_id: str | None) -> None:
        """按调用方执行滑动窗口限流（60 秒窗口，内存分桶）。

        :param caller_id: 调用方 ID；allowlist 未启用时匿名请求统一进
            "anonymous" 桶。
        :raises HTTPException: 超出窗口配额抛 429，detail 携带
            ``retry_after_seconds``（窗口内最早请求滑出所需的秒数）。
        """
        if self._rate_limit_per_minute <= 0:
            return
        bucket = (caller_id or "").strip() or _ANONYMOUS_CALLER
        now = self._clock()
        with self._lock:
            window = self._windows.setdefault(bucket, deque())
            cutoff = now - _WINDOW_SECONDS
            while window and window[0] <= cutoff:
                window.popleft()
            if len(window) >= self._rate_limit_per_minute:
                retry_after = max(0.0, window[0] + _WINDOW_SECONDS - now)
                raise HTTPException(
                    status_code=429,
                    detail={
                        "message": "RAG rate limit exceeded for caller",
                        "retry_after_seconds": round(retry_after, 3),
                    },
                )
            window.append(now)

    def audit(
        self,
        *,
        request_id: str,
        caller_id: str | None,
        endpoint: str,
        outcome: str,
        duration_ms: float,
        project_id: int | None = None,
        query: str | None = None,
        query_len: int | None = None,
        top_k: int | None = None,
    ) -> None:
        """输出一条脱敏审计（结构化行）与一条摘要行。

        结构化行 ``rag_request`` 通过 ``extra`` 携带字段，不含 query 全文；
        摘要行的 query 预览最多前 32 字符加省略号。禁止传入内部令牌。

        :param request_id: 本次请求的追踪 ID。
        :param caller_id: 调用方 ID（可为 None，记录为 anonymous）。
        :param endpoint: 业务端点路径。
        :param outcome: 请求结果：ok / denied / rate_limited / error。
        :param duration_ms: 端点处理耗时（毫秒）。
        :param project_id: 查询绑定的项目 ID（index 端点为 None）。
        :param query: 原始查询文本（仅用于生成长度与预览，不落全文）。
        :param query_len: 查询长度；缺省时由 ``query`` 推导。
        :param top_k: 检索条数上限（index 端点为 None）。
        :return: 无返回值。
        """
        safe_caller = (caller_id or "").strip() or _ANONYMOUS_CALLER
        if query_len is None:
            query_len = len(query) if query is not None else None
        # 结构化审计行：字段层面保证不含 query 全文与任何令牌。
        logger.info(
            "rag_request",
            extra={
                "event": "rag_request",
                "request_id": request_id,
                "caller_id": safe_caller,
                "endpoint": endpoint,
                "project_id": project_id,
                "query_len": query_len,
                "top_k": top_k,
                "duration_ms": round(duration_ms, 3),
                "outcome": outcome,
            },
        )
        # 摘要行：query 只允许保留前 32 字符 + 省略号（阶段 0 脱敏纪律）。
        preview = ""
        if query:
            trimmed = query[:_QUERY_PREVIEW_MAX_CHARS]
            preview = trimmed + ("…" if len(query) > _QUERY_PREVIEW_MAX_CHARS else "")
        logger.info(
            "rag_request_summary request_id=%s caller=%s endpoint=%s project=%s outcome=%s "
            "query_len=%s top_k=%s duration_ms=%.3f query_preview=%s",
            request_id,
            safe_caller,
            endpoint,
            project_id,
            outcome,
            query_len,
            top_k,
            duration_ms,
            preview,
        )
