"""轻量进程内指标：线程安全计数器、延迟采样与纯文本渲染。

设计约束（与任务书一致）：
- 不引入 prometheus 等第三方依赖，``render()`` 输出 ``key value`` 文本行；
- 计数器与延迟采样共用一把 ``threading.Lock``，可在 uvicorn 多线程环境安全读写；
- 指标键名集中定义，供 main.py / rag.py 埋点与测试复用；
- 延迟采样使用固定容量 deque（默认 512），分位计算采用最近排名法（nearest-rank）。
"""

import math
import threading
from collections import deque
from typing import Any

#: 业务请求计数器：labels(endpoint, outcome)，outcome 取 ok/denied/rate_limited/error。
REQUESTS_TOTAL = "rag_requests_total"
#: embedding 调用异常计数器（无 labels）。
EMBEDDING_ERRORS_TOTAL = "rag_embedding_errors_total"
#: Milvus 存储调用异常计数器（无 labels）。
MILVUS_ERRORS_TOTAL = "rag_milvus_errors_total"
#: 检索命中条数累计（无 labels，成功 query 的返回条数求和）。
QUERY_HITS_TOTAL = "rag_query_hits_total"
#: 请求延迟采样（秒），渲染时输出 quantile 标签的 P50/P95/P99。
REQUEST_LATENCY = "rag_request_latency_seconds"

#: 延迟样本容量；超出的最旧样本被丢弃。
_LATENCY_SAMPLE_CAPACITY = 512
#: 渲染输出的分位档位。
_QUANTILE_KEYS = ("0.5", "0.95", "0.99")


def nearest_rank_quantile(sorted_values: list[float], quantile: float) -> float | None:
    """按最近排名法（nearest-rank）计算分位值。

    :param sorted_values: 已升序排序的样本列表。
    :param quantile: 0 到 1 之间的分位系数（如 0.95）。
    :return: 分位值；样本为空时返回 None。
    :raises ValueError: quantile 不在 (0, 1] 区间时抛出。
    """
    if not 0 < quantile <= 1:
        raise ValueError("quantile must be in (0, 1]")
    if not sorted_values:
        return None
    index = max(0, math.ceil(quantile * len(sorted_values)) - 1)
    return sorted_values[index]


class MetricsRegistry:
    """线程安全的计数器与延迟采样注册表。

    计数器按 ``(指标名, labels 排序元组)`` 维度存储；延迟样本存入固定容量
    deque。渲染输出稳定的排序键序，便于测试与日志比对。
    """

    def __init__(self, *, latency_capacity: int = _LATENCY_SAMPLE_CAPACITY) -> None:
        """初始化空注册表。

        :param latency_capacity: 延迟采样队列容量（默认 512）。
        """
        self._lock = threading.Lock()
        # key: (指标名, ((label 名, label 值), ...))；labels 排序保证键稳定。
        self._counters: dict[tuple[str, tuple[tuple[str, str], ...]], float] = {}
        self._latencies: deque[float] = deque(maxlen=latency_capacity)

    def increment_counter(self, name: str, labels: dict[str, str] | None = None, *, amount: float = 1.0) -> None:
        """累加一个计数器。

        :param name: 指标名（使用本模块定义的常量）。
        :param labels: 可选标签字典（如 endpoint/outcome）。
        :param amount: 增量，默认 1.0；命中条数累计时可传入条数。
        """
        key = (name, tuple(sorted((labels or {}).items())))
        with self._lock:
            self._counters[key] = self._counters.get(key, 0.0) + amount

    def counter_value(self, name: str, labels: dict[str, str] | None = None) -> float:
        """读取当前计数器值（测试与诊断辅助）。

        :param name: 指标名。
        :param labels: 可选标签字典，须与累加时一致。
        :return: 当前累计值；未累计过返回 0.0。
        """
        key = (name, tuple(sorted((labels or {}).items())))
        with self._lock:
            return self._counters.get(key, 0.0)

    def observe_latency_seconds(self, value: float) -> None:
        """记录一次延迟采样（秒）。

        :param value: 非负延迟值；负值按 0 处理以防污染分位。
        """
        with self._lock:
            self._latencies.append(max(0.0, value))

    def latency_quantile(self, quantile: float) -> float | None:
        """计算当前延迟样本的分位值（秒）。

        :param quantile: 分位系数（0.5 / 0.95 / 0.99）。
        :return: 分位值；无样本时返回 None。
        """
        with self._lock:
            snapshot = sorted(self._latencies)
        return nearest_rank_quantile(snapshot, quantile)

    def latency_sample_count(self) -> int:
        """返回当前延迟样本数量（测试辅助）。

        :return: 样本条数。
        """
        with self._lock:
            return len(self._latencies)

    def render(self) -> str:
        """渲染全部指标为纯文本 ``key value`` 行。

        :return: 以换行结尾的文本；计数器行在前，延迟分位行在后
            （无延迟样本时省略分位行，避免输出无意义 NaN）。
        """
        with self._lock:
            counter_keys = sorted(self._counters.keys())
            latency_snapshot = sorted(self._latencies)
        lines: list[str] = []
        for name, labels in counter_keys:
            value = self._counters[(name, labels)]
            rendered = name
            if labels:
                label_text = ",".join(f'{key}="{value}"' for key, value in labels)
                rendered = f"{name}{{{label_text}}}"
            lines.append(f"{rendered} {value}")
        if latency_snapshot:
            for quantile_key in _QUANTILE_KEYS:
                quantile_value = nearest_rank_quantile(latency_snapshot, float(quantile_key))
                lines.append(f'{REQUEST_LATENCY}{{quantile="{quantile_key}"}} {quantile_value:.6f}')
            lines.append(f"{REQUEST_LATENCY}_count {len(latency_snapshot)}")
        return "\n".join(lines) + ("\n" if lines else "")


# 进程级单例：main.py 与 rag.py 共享同一注册表。
_registry: MetricsRegistry | None = None
_registry_lock = threading.Lock()


def get_metrics() -> MetricsRegistry:
    """获取进程级指标单例（惰性创建）。

    :return: 全局唯一的 :class:`MetricsRegistry` 实例。
    """
    global _registry
    if _registry is None:
        with _registry_lock:
            if _registry is None:
                _registry = MetricsRegistry()
    return _registry


def reset_metrics() -> None:
    """重置进程级指标单例（仅测试使用）。

    :return: 无返回值；下一次 :func:`get_metrics` 会重建空注册表。
    """
    global _registry
    with _registry_lock:
        _registry = None
