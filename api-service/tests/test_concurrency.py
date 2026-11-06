"""多维限流与并发上限单元测试（阶段 6）。

覆盖：
- RateLimiter：默认关闭（limit=0 不限）、滑动窗口超限拒绝、窗口滑动后放行、
  快照反映窗口内命中数；
- ConcurrencyLimiter：try_acquire/release 语义、scope 异常路径不泄漏槽位、
  多线程下并发上限生效、不限流模式；
- AgentThrottle：三维键顺序（user → project → provider）、速率超限即拒、
  并发占满即拒且回滚已占用槽位、放行后正常释放。
"""

from __future__ import annotations

import threading
from typing import Any

import pytest

from app.agent.concurrency import AgentThrottle, ConcurrencyLimiter, RateLimiter
from app.agent.errors import RateLimitExceededError


class FakeClock:
    """可手动推进的可注入时钟（RateLimiter 测试用）。

    :param start: 初始时刻（秒）。
    """

    def __init__(self, start: float = 0.0) -> None:
        """初始化当前时刻。

        :param start: 初始时刻（秒）。
        """
        self.now = start

    def __call__(self) -> float:
        """返回当前时刻。

        :returns: 当前时钟值（秒）。
        """
        return self.now

    def advance(self, seconds: float) -> None:
        """推进时钟。

        :param seconds: 推进秒数。
        :returns: 无返回值。
        """
        self.now += seconds


# ---------------------------------------------------------------------------
# RateLimiter
# ---------------------------------------------------------------------------


def test_rate_limiter_default_is_unlimited() -> None:
    """默认 limit=0 表示不限：任意多次 acquire 均放行。

    :returns: 无返回值。
    :raises AssertionError: 默认配置下抛限流异常时抛出。
    """
    limiter = RateLimiter()
    for _ in range(1000):
        limiter.acquire("user:1")
    assert limiter.snapshot() == {}


def test_rate_limiter_sliding_window_rejects_over_limit() -> None:
    """窗口内命中数达到 limit 后拒绝，异常携带维度键信息。

    :returns: 无返回值。
    :raises RateLimitExceededError: 第 4 次 acquire 时抛出（本测试断言其发生）。
    """
    clock = FakeClock()
    limiter = RateLimiter(limit=3, window_seconds=60.0, clock=clock)
    limiter.acquire("user:42")
    limiter.acquire("user:42")
    limiter.acquire("user:42")
    with pytest.raises(RateLimitExceededError) as exc_info:
        limiter.acquire("user:42")
    assert "user:42" in str(exc_info.value)
    assert limiter.snapshot()["user:42"]["count"] == 3


def test_rate_limiter_allows_again_after_window_slides() -> None:
    """滑动窗口过期后旧命中出窗，重新允许请求。

    :returns: 无返回值。
    :raises AssertionError: 窗口滑动后仍拒绝时抛出。
    """
    clock = FakeClock()
    limiter = RateLimiter(limit=2, window_seconds=60.0, clock=clock)
    limiter.acquire("project:7")
    limiter.acquire("project:7")
    with pytest.raises(RateLimitExceededError):
        limiter.acquire("project:7")
    clock.advance(61.0)  # 窗口外：旧命中全部出窗
    limiter.acquire("project:7")
    assert limiter.snapshot()["project:7"]["count"] == 1


def test_rate_limiter_snapshot_reports_window_config() -> None:
    """快照包含窗口配置且只统计窗口内命中。

    :returns: 无返回值。
    :raises AssertionError: 快照字段或计数不符时抛出。
    """
    clock = FakeClock()
    limiter = RateLimiter(limit=5, window_seconds=60.0, clock=clock)
    limiter.acquire("provider:openai")
    clock.advance(59.0)
    limiter.acquire("provider:openai")
    clock.advance(2.0)  # 第一个命中出窗（60+ 秒前）
    snapshot = limiter.snapshot()
    assert snapshot["provider:openai"] == {
        "count": 1,
        "limit": 5,
        "window_seconds": 60.0,
    }


def test_rate_limiter_dimensions_are_independent() -> None:
    """不同维度键互不影响（user/project/provider 分桶）。

    :returns: 无返回值。
    :raises AssertionError: 拒绝了其他维度时抛出。
    """
    clock = FakeClock()
    limiter = RateLimiter(limit=1, window_seconds=60.0, clock=clock)
    limiter.acquire("user:1")
    with pytest.raises(RateLimitExceededError):
        limiter.acquire("user:1")
    limiter.acquire("project:1")  # 其他维度不受影响
    limiter.acquire("provider:fake")


# ---------------------------------------------------------------------------
# ConcurrencyLimiter
# ---------------------------------------------------------------------------


def test_concurrency_limiter_try_acquire_and_release() -> None:
    """try_acquire 占满返回 False，release 后可再次占用；快照反映占用数。

    :returns: 无返回值。
    :raises AssertionError: 占用/释放语义不符时抛出。
    """
    limiter = ConcurrencyLimiter(max_concurrent=2)
    assert limiter.try_acquire("project:7") is True
    assert limiter.try_acquire("project:7") is True
    assert limiter.try_acquire("project:7") is False
    assert limiter.snapshot() == {"project:7": {"active": 2, "max_concurrent": 2}}
    limiter.release("project:7")
    assert limiter.try_acquire("project:7") is True


def test_concurrency_limiter_scope_releases_on_exception() -> None:
    """scope 上下文在异常路径也释放槽位（不泄漏）。

    :returns: 无返回值。
    :raises RuntimeError: scope 内部主动抛出（本测试断言其传播）。
    """
    limiter = ConcurrencyLimiter(max_concurrent=1)
    with pytest.raises(RuntimeError):
        with limiter.scope("user:9"):
            assert limiter.snapshot()["user:9"]["active"] == 1
            raise RuntimeError("boom")
    assert limiter.snapshot().get("user:9", {"active": 0})["active"] == 0
    assert limiter.try_acquire("user:9") is True
    limiter.release("user:9")


def test_concurrency_limiter_unlimited_mode() -> None:
    """max_concurrent=0 不限：try_acquire 恒真、release 幂等无副作用。

    :returns: 无返回值。
    :raises AssertionError: 不限模式下返回 False 时抛出。
    """
    limiter = ConcurrencyLimiter()
    for _ in range(100):
        assert limiter.try_acquire("user:1") is True
    limiter.release("user:1")  # 不限模式下 release 为无操作
    assert limiter.snapshot() == {}


def test_concurrency_limiter_threaded_acquire_respects_max() -> None:
    """多线程并发下同一维度键的并发占用不超过上限。

    :returns: 无返回值。
    :raises AssertionError: 观测到超过上限的并发占用时抛出。
    """
    limiter = ConcurrencyLimiter(max_concurrent=3)
    active = {"count": 0, "max_seen": 0}
    lock = threading.Lock()
    barrier = threading.Barrier(8)

    def worker() -> None:
        """并发 worker：在 scope 内观测并发峰值。

        :returns: 无返回值。
        """
        barrier.wait()
        with limiter.scope("user:1"):
            with lock:
                active["count"] += 1
                active["max_seen"] = max(active["max_seen"], active["count"])
            with lock:
                active["count"] -= 1

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert active["max_seen"] <= 3
    assert limiter.snapshot().get("user:1", {"active": 0})["active"] == 0


# ---------------------------------------------------------------------------
# AgentThrottle
# ---------------------------------------------------------------------------


def test_throttle_dimension_keys_order_and_skipping() -> None:
    """维度键按 user → project → provider 顺序拼接，未提供的维度跳过。

    :returns: 无返回值。
    :raises AssertionError: 顺序或内容不符时抛出。
    """
    keys = AgentThrottle.dimension_keys(user_id=42, project_id=7, provider="openai")
    assert keys == ["user:42", "project:7", "provider:openai"]
    assert AgentThrottle.dimension_keys(project_id=7) == ["project:7"]
    assert AgentThrottle.dimension_keys() == []


def test_throttle_gate_passes_and_checks_all_dimensions() -> None:
    """放行时三维速率均已登记（user → project → provider 依次检查）。

    :returns: 无返回值。
    :raises AssertionError: 任一维度未登记或未释放时抛出。
    """
    throttle = AgentThrottle(rate_limit=10, max_concurrent=2)
    with throttle.gate(user_id=42, project_id=7, provider="openai") as info:
        assert info["keys"] == ["user:42", "project:7", "provider:openai"]
        assert set(throttle.rate_limiter.snapshot()) == {"user:42", "project:7", "provider:openai"}
    # 退出后并发槽位全部释放。
    assert throttle.concurrency_limiter.snapshot() == {}


def test_throttle_gate_rejects_on_rate_limit() -> None:
    """速率超限即拒（第二道门未过），退出后并发槽位无泄漏。

    :returns: 无返回值。
    :raises RateLimitExceededError: 第二次 gate 时抛出（本测试断言其发生）。
    """
    throttle = AgentThrottle(rate_limit=1, max_concurrent=5)
    with throttle.gate(user_id=1, project_id=1, provider="p1"):
        pass
    with pytest.raises(RateLimitExceededError) as exc_info:
        with throttle.gate(user_id=1, project_id=1, provider="p1"):
            pass
    assert "user:1" in str(exc_info.value)
    assert throttle.concurrency_limiter.snapshot() == {}


def test_throttle_gate_rolls_back_acquired_concurrency_on_rejection() -> None:
    """并发维度中途被拒时回滚已占用的槽位（不泄漏前置维度槽位）。

    :returns: 无返回值。
    :raises RateLimitExceededError: project 维度并发占满时抛出（本测试断言其发生）。
    """
    throttle = AgentThrottle(rate_limit=100, max_concurrent=1)
    # 预先占满 project:7 的并发槽位，模拟该维度已达并发上限。
    assert throttle.concurrency_limiter.try_acquire("project:7") is True
    with pytest.raises(RateLimitExceededError) as exc_info:
        with throttle.gate(user_id=1, project_id=7, provider="openai"):
            pass
    assert "project:7" in str(exc_info.value)
    # user:1 槽位已被回滚，只剩手动占用的 project:7。
    assert throttle.concurrency_limiter.snapshot() == {
        "project:7": {"active": 1, "max_concurrent": 1}
    }
    throttle.concurrency_limiter.release("project:7")


def test_throttle_gate_unlimited_by_default() -> None:
    """默认（不限流）下组合门恒放行，多次进入无异常。

    :returns: 无返回值。
    :raises AssertionError: 默认配置下抛限流异常时抛出。
    """
    throttle = AgentThrottle()
    for _ in range(100):
        with throttle.gate(user_id=1, project_id=1, provider="p1") as info:
            assert info["keys"] == ["user:1", "project:1", "provider:p1"]
