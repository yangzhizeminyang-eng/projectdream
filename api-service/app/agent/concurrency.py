"""多维限流与并发上限（阶段 6）。

提供三个协作组件，供 /internal 端点或 runtime 前置门使用（本轮只交付模块与测试，
不接入 main.py）：

- :class:`RateLimiter`：滑动窗口速率限制（默认 60s 窗口），维度键由调用方拼接
  （``f"user:{id}"`` / ``f"project:{id}"`` / ``f"provider:{name}"``）；
- :class:`ConcurrencyLimiter`：每维度并发上限（``threading.Semaphore`` 语义 + dict 分桶）；
- :class:`AgentThrottle`：组合门，按 user/project/provider 三维依次检查，任一超限即拒。

配置纪律：**不接入 config.py**——所有限流参数由构造注入，默认值写在类签名；
``limit=0`` / ``max_concurrent=0`` 表示不限（默认关闭，行为回归零限流）。

超限抛 :class:`~app.agent.errors.RateLimitExceededError`（AgentError 族）。
"""

from __future__ import annotations

import threading
import time
from collections import deque
from contextlib import contextmanager
from typing import Any, Callable, Iterator

from app.agent.errors import RateLimitExceededError

# 维度键前缀约定：由调用方拼接完整键（本模块不关心业务 ID 语义）。
DIMENSION_USER = "user"
DIMENSION_PROJECT = "project"
DIMENSION_PROVIDER = "provider"


class RateLimiter:
    """滑动窗口速率限制器（60s 窗口，deque + Lock，时钟可注入）。

    :param limit: 窗口内允许的最大请求数；``0`` 表示不限（默认关闭）。
    :param window_seconds: 滑动窗口宽度（秒）。
    :param clock: 时钟注入点，返回单调递增的秒值；缺省 ``time.monotonic``，
        测试可注入假时钟驱动窗口滑动。
    """

    def __init__(
        self,
        *,
        limit: int = 0,
        window_seconds: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """初始化窗口容器与互斥锁。

        :param limit: 窗口内允许的最大请求数（0 = 不限）。
        :param window_seconds: 滑动窗口宽度（秒）。
        :param clock: 可注入时钟。
        """
        self._limit = limit
        self._window_seconds = window_seconds
        self._clock = clock
        self._lock = threading.Lock()
        # 维度键 -> 窗口内命中时间戳队列（升序）。
        self._hits: dict[str, deque[float]] = {}

    @property
    def limit(self) -> int:
        """窗口内允许的最大请求数（0 表示不限）。

        :returns: 配置的 limit 值。
        """
        return self._limit

    def acquire(self, key: str) -> None:
        """登记一次请求；窗口内超限则拒绝。

        :param key: 维度键（调用方拼接，如 ``user:42``）。
        :returns: 无返回值；未超限正常返回。
        :raises RateLimitExceededError: 滑动窗口内该键命中数已达 limit 时抛出。
        """
        if self._limit <= 0:
            return
        now = self._clock()
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            window_start = now - self._window_seconds
            while hits and hits[0] <= window_start:
                hits.popleft()
            if len(hits) >= self._limit:
                raise RateLimitExceededError(
                    f"rate limit exceeded for dimension {key}: "
                    f"{len(hits)} hits in {self._window_seconds}s window (limit={self._limit})"
                )
            hits.append(now)

    def snapshot(self) -> dict[str, Any]:
        """返回各维度键当前窗口内的命中快照（观测用，只读）。

        :returns: ``{维度键: {"count": 窗口内命中数, "limit": 上限, "window_seconds": 窗口宽}}``。
        """
        now = self._clock()
        window_start = now - self._window_seconds
        with self._lock:
            return {
                key: {
                    "count": sum(1 for hit in hits if hit > window_start),
                    "limit": self._limit,
                    "window_seconds": self._window_seconds,
                }
                for key, hits in self._hits.items()
            }


class ConcurrencyLimiter:
    """每维度并发上限（``threading.Semaphore`` 语义 + dict 分桶）。

    :param max_concurrent: 每个维度键允许的最大并发数；``0`` 表示不限（默认关闭）。
    """

    def __init__(self, *, max_concurrent: int = 0) -> None:
        """初始化分桶容器与互斥锁。

        :param max_concurrent: 每维度最大并发数（0 = 不限）。
        """
        self._max_concurrent = max_concurrent
        self._lock = threading.Lock()
        # 维度键 -> 信号量（首次使用时创建，容量固定）。
        self._semaphores: dict[str, threading.Semaphore] = {}
        # 维度键 -> 当前占用数（观测用）。
        self._active: dict[str, int] = {}

    @property
    def max_concurrent(self) -> int:
        """每维度最大并发数（0 表示不限）。

        :returns: 配置的 max_concurrent 值。
        """
        return self._max_concurrent

    def _semaphore_for(self, key: str) -> threading.Semaphore:
        """取（或创建）指定维度键的信号量。

        :param key: 维度键。
        :returns: 该键绑定的 Semaphore 实例。
        """
        with self._lock:
            semaphore = self._semaphores.get(key)
            if semaphore is None:
                semaphore = threading.Semaphore(self._max_concurrent)
                self._semaphores[key] = semaphore
            return semaphore

    def acquire(self, key: str) -> None:
        """阻塞式占用一个并发槽位。

        :param key: 维度键。
        :returns: 无返回值；获取成功后必须调用 :meth:`release` 释放。
        """
        if self._max_concurrent <= 0:
            return
        self._semaphore_for(key).acquire()
        with self._lock:
            self._active[key] = self._active.get(key, 0) + 1

    def try_acquire(self, key: str) -> bool:
        """非阻塞尝试占用一个并发槽位（超限即拒，不等待）。

        :param key: 维度键。
        :returns: 占用成功返回 True；已达上限返回 False（不占用、不等待）。
        """
        if self._max_concurrent <= 0:
            return True
        if not self._semaphore_for(key).acquire(blocking=False):
            return False
        with self._lock:
            self._active[key] = self._active.get(key, 0) + 1
        return True

    def release(self, key: str) -> None:
        """释放一个并发槽位（与 acquire/try_acquire 成对调用）。

        占用数归零后清理该键的观测条目（快照只反映仍在占用的维度）。

        :param key: 维度键。
        :returns: 无返回值。
        """
        if self._max_concurrent <= 0:
            return
        with self._lock:
            active = self._active.get(key, 0)
            if active > 0:
                if active - 1 == 0:
                    self._active.pop(key, None)
                else:
                    self._active[key] = active - 1
        self._semaphore_for(key).release()

    @contextmanager
    def scope(self, key: str) -> Iterator[None]:
        """上下文管理器：进入时占用槽位，退出（含异常路径）时释放。

        :param key: 维度键。
        :returns: 上下文管理器（yield None）。
        :raises RateLimitExceededError: 本方法不抛限流异常（阻塞式获取）。
        """
        self.acquire(key)
        try:
            yield
        finally:
            self.release(key)

    def snapshot(self) -> dict[str, Any]:
        """返回各维度键当前占用快照（观测用，只读）。

        :returns: ``{维度键: {"active": 当前占用数, "max_concurrent": 上限}}``。
        """
        with self._lock:
            return {
                key: {"active": active, "max_concurrent": self._max_concurrent}
                for key, active in self._active.items()
            }


class AgentThrottle:
    """Agent 组合门：按 user/project/provider 三维依次检查，任一超限即拒。

    检查顺序：先三维速率（RateLimiter.acquire），再三维并发（try_acquire，
    失败时回滚已占用的并发槽位）。供 /internal 端点或 runtime 前置使用。

    :param rate_limit: 每维度滑动窗口请求上限（0 = 不限）。
    :param max_concurrent: 每维度并发上限（0 = 不限）。
    :param window_seconds: 滑动窗口宽度（秒）。
    :param clock: 可注入时钟（透传给 RateLimiter）。
    """

    def __init__(
        self,
        *,
        rate_limit: int = 0,
        max_concurrent: int = 0,
        window_seconds: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """初始化两个子限制器。

        :param rate_limit: 每维度速率上限（0 = 不限）。
        :param max_concurrent: 每维度并发上限（0 = 不限）。
        :param window_seconds: 滑动窗口宽度（秒）。
        :param clock: 可注入时钟。
        """
        self.rate_limiter = RateLimiter(
            limit=rate_limit, window_seconds=window_seconds, clock=clock
        )
        self.concurrency_limiter = ConcurrencyLimiter(max_concurrent=max_concurrent)

    @staticmethod
    def dimension_keys(
        *,
        user_id: str | int | None = None,
        project_id: str | int | None = None,
        provider: str | None = None,
    ) -> list[str]:
        """拼接三维维度键（未提供的维度跳过）。

        :param user_id: 用户标识。
        :param project_id: 项目 ID。
        :param provider: 供应商标识。
        :returns: 维度键列表（user → project → provider 顺序）。
        """
        keys: list[str] = []
        if user_id is not None:
            keys.append(f"{DIMENSION_USER}:{user_id}")
        if project_id is not None:
            keys.append(f"{DIMENSION_PROJECT}:{project_id}")
        if provider is not None:
            keys.append(f"{DIMENSION_PROVIDER}:{provider}")
        return keys

    @contextmanager
    def gate(
        self,
        *,
        user_id: str | int | None = None,
        project_id: str | int | None = None,
        provider: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        """组合门上下文：进入时依次检查三维限流与并发，退出时释放并发槽位。

        语义：速率维度按 user → project → provider 依次 acquire（任一超限即拒，
        此前维度已登记的窗口命中不回滚）；并发维度全部 try_acquire 成功才放行，
        任一失败时回滚已占用槽位并拒绝。

        :param user_id: 用户标识。
        :param project_id: 项目 ID。
        :param provider: 供应商标识。
        :returns: 上下文管理器，yield 本次放行的维度键信息 dict（含 ``keys``）。
        :raises RateLimitExceededError: 任一维度速率超限或并发占满时抛出。
        """
        keys = self.dimension_keys(user_id=user_id, project_id=project_id, provider=provider)
        acquired: list[str] = []
        try:
            for key in keys:
                self.rate_limiter.acquire(key)
            for key in keys:
                if not self.concurrency_limiter.try_acquire(key):
                    raise RateLimitExceededError(
                        f"concurrency limit exceeded for dimension {key} "
                        f"(max_concurrent={self.concurrency_limiter.max_concurrent})"
                    )
                acquired.append(key)
            yield {"keys": keys}
        finally:
            # 逆序释放并发槽位，保证异常/拒绝路径不泄漏。
            for key in reversed(acquired):
                self.concurrency_limiter.release(key)
