"""故障注入包装器（阶段 6）：可编程 chaos，用于验证幂等与恢复语义。

五种注入场景（任务书阶段 6）：
``db_disconnect``（DB 断连）/ ``rag_timeout``（RAG 超时）/
``provider_rate_limited``（供应商限流）/ ``process_kill``（进程被杀模拟）/
``none``（显式无注入）。

验证目标：任何注入下都 **无重复付费、无状态丢失**——由
``tests/test_chaos_recovery.py`` 的五个场景测试锁定。

触发语义：:meth:`ChaosController.arm` 注册"第 N 次转发调用时注入"的计划；
计数到达即抛注入错误并消耗掉该计划（一次性），需再次注入须重新 arm。
"""

from __future__ import annotations

import threading
from typing import Any, Callable, Literal

from app.agent.errors import AgentError, ToolInvocationError
from app.agent.model_provider import DEFAULT_TIMEOUT_SECONDS, ModelProvider
from app.agent.run_store import RunStore

# 注入类型集合。
ChaosKind = Literal[
    "db_disconnect",
    "rag_timeout",
    "provider_rate_limited",
    "process_kill",
    "none",
]

# 全部可注入类型（用于遍历与校验）。
CHAOS_KINDS: tuple[str, ...] = (
    "db_disconnect",
    "rag_timeout",
    "provider_rate_limited",
    "process_kill",
    "none",
)

# 各类型的默认注入错误工厂（error_factory 未提供时使用）。
_DEFAULT_ERROR_FACTORIES: dict[str, Callable[[], Exception]] = {
    "db_disconnect": lambda: ConnectionError("injected: mysql gone away"),
    "rag_timeout": lambda: ToolInvocationError("injected: rag timeout", retryable=True),
    "provider_rate_limited": lambda: AgentError("injected: 429 provider rate limited"),
    "process_kill": lambda: RuntimeError("injected: process kill"),
    # none：永不注入（before 直接放行）。
    "none": lambda: RuntimeError("injected: none kind never triggers"),
}

# error_factory 契约：无参调用返回一个 Exception 实例。
ErrorFactory = Callable[[], Exception]


class ChaosController:
    """可编程注入器：按 kind 计数触发，一次性消耗，可重复 arm。

    :param: 无外部依赖（内部仅线程锁与计数器）。
    """

    def __init__(self) -> None:
        """初始化计划表、转发调用计数与注入计数（均为线程安全）。"""
        self._lock = threading.Lock()
        # kind -> {"after_calls": int, "error_factory": ErrorFactory | None}
        self._plans: dict[str, dict[str, Any]] = {}
        # kind -> 已转发的调用次数（自 arm 起计数）。
        self._calls: dict[str, int] = {}
        # kind -> 已发生的注入次数（观测用）。
        self._injections: dict[str, int] = {}

    def arm(self, kind: ChaosKind, after_calls: int, *, error_factory: ErrorFactory | None = None) -> None:
        """注册一次注入计划：该 kind 第 ``after_calls`` 次转发调用时注入。

        :param kind: 注入类型（db_disconnect/rag_timeout/provider_rate_limited/
            process_kill/none）。
        :param after_calls: 触发前放行的转发调用次数（>=1；1 表示下一次调用即注入）。
        :param error_factory: 注入错误工厂（无参返回 Exception 实例）；缺省用各类型默认错误。
        :returns: 无返回值。
        :raises ValueError: kind 不在支持集合，或 after_calls < 1 时抛出。
        """
        if kind not in CHAOS_KINDS:
            raise ValueError(f"unknown chaos kind: {kind}")
        if after_calls < 1:
            raise ValueError("after_calls 必须 >= 1")
        with self._lock:
            self._plans[kind] = {"after_calls": after_calls, "error_factory": error_factory}
            self._calls[kind] = 0

    def disarm(self, kind: ChaosKind) -> None:
        """撤销指定类型的注入计划（已发生计数保留）。

        :param kind: 注入类型。
        :returns: 无返回值。
        """
        with self._lock:
            self._plans.pop(kind, None)

    def reset(self) -> None:
        """清空全部注入计划与计数（注入解除，恢复常态）。

        :returns: 无返回值。
        """
        with self._lock:
            self._plans.clear()
            self._calls.clear()
            self._injections.clear()

    def before(self, kind: ChaosKind) -> None:
        """转发调用前调用：计数并按计划注入（一次性）。

        :param kind: 本次调用对应的注入类型。
        :returns: 无返回值；未命中计划或 kind=none 时正常返回。
        :raises Exception: 命中注入计划时抛出该 kind 的注入错误（计划随即消耗）。
        """
        factory: ErrorFactory | None = None
        with self._lock:
            if kind == "none":
                return
            plan = self._plans.get(kind)
            if plan is None:
                return
            self._calls[kind] = self._calls.get(kind, 0) + 1
            if self._calls[kind] >= plan["after_calls"]:
                factory = plan["error_factory"] or _DEFAULT_ERROR_FACTORIES[kind]
                # 一次性：触发后消耗计划，避免重复注入干扰后续调用。
                self._plans.pop(kind, None)
                self._injections[kind] = self._injections.get(kind, 0) + 1
        if factory is not None:
            raise factory()

    def forwarded_calls(self, kind: ChaosKind) -> int:
        """查询指定类型已转发的调用次数。

        :param kind: 注入类型。
        :returns: 转发计数。
        """
        with self._lock:
            return self._calls.get(kind, 0)

    @property
    def injections(self) -> dict[str, int]:
        """已发生的注入次数快照（kind -> 次数，观测用）。

        :returns: 注入计数字典副本。
        """
        with self._lock:
            return dict(self._injections)


class ChaosDB:
    """duck-typing database 包装器：转发读写并按计划注入 db_disconnect。

    :param inner: 被包装的真实 database 对象（提供 execute/fetchone/fetchall）。
    :param chaos: 注入控制器。
    """

    def __init__(self, inner: Any, chaos: ChaosController) -> None:
        """注入被包装数据库与控制器。

        :param inner: 真实 database 对象。
        :param chaos: 注入控制器。
        """
        self._inner = inner
        self._chaos = chaos

    def execute(self, sql: str, params: tuple = ()) -> int:
        """转发 execute（注入点：db_disconnect）。

        :param sql: 参数化 SQL。
        :param params: SQL 参数。
        :returns: 受影响行数。
        :raises ConnectionError: 命中 db_disconnect 计划时抛出。
        """
        self._chaos.before("db_disconnect")
        return self._inner.execute(sql, params)

    def fetchone(self, sql: str, params: tuple = ()) -> dict[str, Any] | None:
        """转发 fetchone（注入点：db_disconnect）。

        :param sql: 参数化 SQL。
        :param params: SQL 参数。
        :returns: 单行 dict 或 None。
        :raises ConnectionError: 命中 db_disconnect 计划时抛出。
        """
        self._chaos.before("db_disconnect")
        return self._inner.fetchone(sql, params)

    def fetchall(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        """转发 fetchall（注入点：db_disconnect）。

        :param sql: 参数化 SQL。
        :param params: SQL 参数。
        :returns: 行 dict 列表。
        :raises ConnectionError: 命中 db_disconnect 计划时抛出。
        """
        self._chaos.before("db_disconnect")
        return self._inner.fetchall(sql, params)

    def __getattr__(self, name: str) -> Any:
        """未显式转发的方法/属性透传给被包装数据库（保持 duck-typing 兼容）。

        :param name: 属性名。
        :returns: 被包装对象的同名属性。
        """
        return getattr(self._inner, name)


class ChaosProvider(ModelProvider):
    """ModelProvider 包装器：按计划注入 provider_rate_limited 或 rag_timeout。

    :param inner: 被包装的真实模型提供方。
    :param chaos: 注入控制器。
    """

    def __init__(self, inner: ModelProvider, chaos: ChaosController) -> None:
        """注入被包装提供方与控制器。

        :param inner: 真实模型提供方。
        :param chaos: 注入控制器。
        """
        self._inner = inner
        self._chaos = chaos

    def complete_structured(
        self,
        *,
        system: str,
        user: str,
        schema_model: Any,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> tuple[Any, dict[str, Any]]:
        """转发结构化补全（注入点：rag_timeout / provider_rate_limited）。

        :param system: system 提示词。
        :param user: user 提示词。
        :param schema_model: 输出 pydantic 模型类型。
        :param timeout_seconds: 单次调用超时（秒）。
        :returns: (校验后的模型实例, usage dict)。
        :raises ToolInvocationError: 命中 rag_timeout 计划时抛出（retryable）。
        :raises AgentError: 命中 provider_rate_limited 计划时抛出。
        """
        self._chaos.before("rag_timeout")
        self._chaos.before("provider_rate_limited")
        return self._inner.complete_structured(
            system=system,
            user=user,
            schema_model=schema_model,
            timeout_seconds=timeout_seconds,
        )


def simulate_process_kill(store: RunStore, run_id: str) -> dict[str, Any] | None:
    """进程被杀模拟：run 停留 running（无终态事件），返回当前状态供恢复流程接手。

    真实进程被杀不会执行任何清理逻辑，run 记录会残留最后一次写入的状态；
    本函数把 run 强制置回 ``running``（不追加任何终态事件），复现该现场，
    是 :func:`app.agent.pipeline.recovery.resume_interrupted` 的标准输入。

    :param store: run 存储实现。
    :param run_id: 运行 ID。
    :returns: 模拟后的 run 记录 dict（status=running）；run 不存在时返回 None。
    """
    run = store.get_run(run_id)
    if run is None:
        return None
    # 模拟强杀残留：状态停在 running，且不写任何终态事件（恢复流程据此接管）。
    store.update_status(run_id, "running", None)
    return store.get_run(run_id)
