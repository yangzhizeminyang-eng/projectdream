"""ProjectDream 阶段 6 应用层形状压测（进程内 ASGI，非 pytest，独立脚本）。

目标：测量 ``POST /internal/agent/runs`` 形状的应用层吞吐与延迟——直接构造
AgentRuntime（InMemoryRunStore + FakeStoryboardReviewProvider + 编译 quality 图），
用最小 FastAPI app 暴露该端点（内部 runtime.invoke，走 asyncio.to_thread，
不走 main.py），并以 httpx ``ASGITransport`` 进程内施压。

阶段：
- baseline：并发 1，60 请求（基线延迟）；
- ramp：并发 1/2/4/8/16 各 120 请求（吞吐爬坡）；
- steady：并发 8，300 请求（稳定性）；
- chaos：并发 8，200 请求，每第 10 次供应商调用注入 provider_rate_limited（约 10%），
  观察错误率与恢复时间（注入解除后首个成功请求延迟）。

报告纪律（任务书阶段 6）：
- 不虚构 TPS：所有数字来自本机实测；
- environment 字段如实写：Windows 本机 / 进程内 ASGI / InMemory store /
  FakeProvider / 非生产数据库 / 数据规模（请求数）；
- capacity_verdict 字段固定 ``not_a_production_capacity_claim``；
- 本报告是"应用层形状测量"，**不是生产容量承诺**。

运行方式（cwd=api-service）::

    C:\\Temp\\pd-venvs\\api\\Scripts\\python.exe -m tests.loadtest.run_loadtest

输出：``api-service/artifacts/phase6-loadtest-report.json`` + 控制台摘要。
"""

from __future__ import annotations

import asyncio
import itertools
import json
import math
import platform
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI

from app.agent.errors import AgentError
from app.agent.quality.graph import StoryboardReviewVerdict, build_storyboard_quality_graph
from app.agent.run_store import InMemoryRunStore
from app.agent.runtime import AgentRuntime
from app.agent.schemas import AgentRequest, AgentResult

# 报告输出目录（固定为仓库根 artifacts，与阶段 3/4/5 报告同位置，与 cwd 无关）。
_API_SERVICE_DIR = Path(__file__).resolve().parents[2]
_REPO_ROOT = _API_SERVICE_DIR.parent
_ARTIFACTS_DIR = _REPO_ROOT / "artifacts"
_REPORT_PATH = _ARTIFACTS_DIR / "phase6-loadtest-report.json"

# 压测负载：复用编译质量图试点的合法分镜 payload（规则门通过）。
_VALID_PAYLOAD: dict[str, Any] = {
    "storyboard": {
        "id": 31,
        "visualPrompt": "中景，角色推进",
        "asset_reference_json": (
            '{"characterId": 9, "characterVersionNo": 2, "characterViewSetVersion": 1,'
            ' "characterViewKeys": ["front", "side", "back"], "characterBaseImageId": 71,'
            ' "characterBaseVersionNo": 1, "characterFaceImageId": 72, "characterFaceVersionNo": 1,'
            ' "sceneAssetId": 10, "scenePanoramaVersion": 3}'
        ),
    }
}

# 压测项目 ID（报告与幂等键中使用）。
_LOADTEST_PROJECT_ID = 7


class VerdictProvider:
    """质量图模型复核节点契约的固定响应 provider（不发网络请求）。

    与 test_quality_graph.py 的 Fake 同契约：``complete_structured`` 直接返回
    ``StoryboardReviewVerdict`` 实例（非 (model, usage) 元组），保证
    ``enable_model_review=True`` 时模型复核节点正常通过。

    :param: 无外部依赖。
    """

    def complete_structured(
        self,
        *,
        system: str,
        user: str,
        schema_model: Any,
        timeout_seconds: float = 30.0,
    ) -> StoryboardReviewVerdict:
        """返回固定"通过"结论。

        :param system: system 提示词（忽略）。
        :param user: user 提示词（忽略）。
        :param schema_model: 输出 schema（忽略）。
        :param timeout_seconds: 超时（忽略）。
        :returns: 通过的 StoryboardReviewVerdict 实例。
        """
        return StoryboardReviewVerdict(overall_pass=True, issues=[])


class InjectingProvider:
    """压测用模型提供方包装器：可开关地按固定间隔注入 provider_rate_limited。

    实现质量图 provider 契约（非 ModelProvider 元组契约），注入在转发前抛出。

    :param inject_every: 每第 N 次调用注入一次（0 = 永不注入）。
    """

    def __init__(self, *, inject_every: int = 0) -> None:
        """初始化内部固定响应提供方与注入计数。

        :param inject_every: 注入间隔（0 = 关闭注入）。
        """
        self._inner = VerdictProvider()
        self._inject_every = inject_every
        self.calls = 0
        self.injected_calls = 0

    @property
    def inject_enabled(self) -> bool:
        """注入开关状态（chaos 阶段开启，其余阶段关闭）。

        :returns: 开启返回 True。
        """
        return self._inject_every > 0

    def enable_injection(self, inject_every: int = 10) -> None:
        """开启注入：每第 N 次供应商调用抛一次限流错误。

        :param inject_every: 注入间隔（次）。
        :returns: 无返回值。
        """
        self._inject_every = max(1, inject_every)

    def disable_injection(self) -> None:
        """关闭注入（恢复常态，用于测量恢复时间）。

        :returns: 无返回值。
        """
        self._inject_every = 0

    def complete_structured(
        self,
        *,
        system: str,
        user: str,
        schema_model: Any,
        timeout_seconds: float = 30.0,
    ) -> StoryboardReviewVerdict:
        """转发结构化补全；inject_every 命中时抛供应商限流注入错误。

        :param system: system 提示词。
        :param user: user 提示词。
        :param schema_model: 输出 pydantic 模型类型。
        :param timeout_seconds: 单次调用超时（秒）。
        :returns: 校验后的结论模型实例（图契约，直接返回）。
        :raises AgentError: 命中注入间隔时抛出（模拟供应商 429）。
        """
        self.calls += 1
        if self._inject_every > 0 and self.calls % self._inject_every == 0:
            self.injected_calls += 1
            raise AgentError("injected: 429 provider rate limited")
        return self._inner.complete_structured(
            system=system,
            user=user,
            schema_model=schema_model,
            timeout_seconds=timeout_seconds,
        )


def build_loadtest_app(provider: InjectingProvider) -> FastAPI:
    """构建暴露 POST /internal/agent/runs 的最小 FastAPI 应用（不走 main.py）。

    :param provider: 压测模型提供方（含注入开关）。
    :returns: FastAPI 应用实例。
    """
    runtime = AgentRuntime(
        provider=provider,
        store=InMemoryRunStore(),
        graph_builder=lambda p: build_storyboard_quality_graph(p, enable_model_review=True),
    )
    app = FastAPI(title="ProjectDream Phase6 Loadtest")

    @app.post("/internal/agent/runs")
    async def create_agent_run(request: AgentRequest) -> dict[str, Any]:
        """内部 Agent 运行端点（与 main.py 形状对齐：同步 invoke 入线程池）。

        :param request: 经 Pydantic 校验的 AgentRequest。
        :returns: success envelope（data 为 AgentResult dump）。
        """
        result: AgentResult = await asyncio.to_thread(runtime.invoke, request)
        return {"code": 0, "message": "success", "data": result.model_dump(mode="json")}

    return app


def _percentile(sorted_values: list[float], quantile: float) -> float:
    """最近邻法计算分位数。

    :param sorted_values: 升序样本。
    :param quantile: 分位（0-1）。
    :returns: 分位数值。
    """
    if not sorted_values:
        return 0.0
    index = max(0, min(len(sorted_values) - 1, math.ceil(quantile * len(sorted_values)) - 1))
    return sorted_values[index]


def _latency_summary(latencies_ms: list[float]) -> dict[str, float]:
    """汇总延迟指标。

    :param latencies_ms: 请求延迟样本（毫秒）。
    :returns: 含 p50/p95/p99/mean/min/max 的 dict。
    """
    if not latencies_ms:
        return {"p50": 0.0, "p95": 0.0, "p99": 0.0, "mean": 0.0, "min": 0.0, "max": 0.0}
    ordered = sorted(latencies_ms)
    return {
        "p50": round(_percentile(ordered, 0.50), 3),
        "p95": round(_percentile(ordered, 0.95), 3),
        "p99": round(_percentile(ordered, 0.99), 3),
        "mean": round(sum(ordered) / len(ordered), 3),
        "min": round(ordered[0], 3),
        "max": round(ordered[-1], 3),
    }


async def run_phase(
    client: httpx.AsyncClient,
    *,
    phase_name: str,
    concurrency: int,
    total_requests: int,
) -> dict[str, Any]:
    """执行一个压测阶段并汇总指标。

    请求幂等键全局唯一（``loadtest:{phase}:p{project}:storyboard:{seq}``），
    每个请求真实执行一次编译图。run status=completed 记为成功，
    其余（failed/blocked/retryable_failed 等）记为错误。

    :param client: httpx 异步客户端（ASGITransport 进程内）。
    :param phase_name: 阶段名（用于幂等键与报告）。
    :param concurrency: 并发 worker 数。
    :param total_requests: 本阶段总请求数。
    :returns: 阶段指标 dict。
    """
    seq_counter = itertools.count()
    latencies: list[float] = []
    statuses: list[str] = []
    started = time.perf_counter()

    async def worker() -> None:
        """单个并发 worker：循环领取序号并发请求直到配额用尽。

        :returns: 无返回值。
        """
        while True:
            seq = next(seq_counter)
            if seq >= total_requests:
                return
            body = {
                "project_id": _LOADTEST_PROJECT_ID,
                "task_type": "storyboard_quality",
                "payload": _VALID_PAYLOAD,
                "idempotency_key": f"loadtest:{phase_name}:p{_LOADTEST_PROJECT_ID}:storyboard:{seq}",
            }
            request_started = time.perf_counter()
            status = "http_error"
            try:
                response = await client.post("/internal/agent/runs", json=body)
                if response.status_code == 200:
                    data = response.json().get("data") or {}
                    status = str(data.get("status") or "unknown")
                else:
                    status = f"http_{response.status_code}"
            except Exception:
                status = "client_error"
            latencies.append((time.perf_counter() - request_started) * 1000.0)
            statuses.append(status)

    await asyncio.gather(*(worker() for _ in range(concurrency)))
    duration = time.perf_counter() - started

    status_counts: dict[str, int] = {}
    for status in statuses:
        status_counts[status] = status_counts.get(status, 0) + 1
    error_count = len(statuses) - status_counts.get("completed", 0)
    return {
        "name": phase_name,
        "concurrency": concurrency,
        "requests": total_requests,
        "duration_seconds": round(duration, 3),
        "throughput_rps": round(total_requests / duration, 2) if duration > 0 else 0.0,
        "latency_ms": _latency_summary(latencies),
        "status_counts": status_counts,
        "error_count": error_count,
        "error_rate": round(error_count / total_requests, 4) if total_requests else 0.0,
    }


async def execute_loadtest() -> dict[str, Any]:
    """执行完整压测（baseline → ramp → steady → chaos + 恢复探测）并产出报告 dict。

    :returns: 报告 dict（environment/phases/data_scale/capacity_verdict）。
    """
    provider = InjectingProvider(inject_every=0)
    app = build_loadtest_app(provider)
    transport = httpx.ASGITransport(app=app)
    phases: dict[str, Any] = {}

    # base_url 必须显式给出：ASGITransport 无真实网络栈，httpx 需要
    # 一个可解析的基址来构造请求/处理响应 cookie。
    async with httpx.AsyncClient(transport=transport, base_url="http://loadtest.local") as client:
        # baseline：并发 1，60 请求。
        phases["baseline"] = await run_phase(
            client, phase_name="baseline", concurrency=1, total_requests=60
        )

        # ramp：1/2/4/8/16 各 120 请求。
        ramp_results = []
        for concurrency in (1, 2, 4, 8, 16):
            ramp_results.append(
                await run_phase(
                    client,
                    phase_name=f"ramp-c{concurrency}",
                    concurrency=concurrency,
                    total_requests=120,
                )
            )
        phases["ramp"] = ramp_results

        # steady：并发 8，300 请求。
        phases["steady"] = await run_phase(
            client, phase_name="steady", concurrency=8, total_requests=300
        )

        # chaos：并发 8，200 请求，每第 10 次供应商调用注入 provider_rate_limited（约 10%）。
        provider.enable_injection(10)
        chaos_phase = await run_phase(
            client, phase_name="chaos", concurrency=8, total_requests=200
        )
        # 注入期（status!=completed）与非注入期（completed）对比。
        chaos_error_rate = chaos_phase["error_rate"]
        phases["chaos"] = {
            **chaos_phase,
            "injection": {
                "kind": "provider_rate_limited",
                "inject_every_provider_calls": 10,
                "injected_provider_calls": provider.injected_calls,
                "observed_error_rate": chaos_error_rate,
                "note": "注入请求全部映射为 failed 终态；非注入请求应全部 completed",
            },
        }
        # 注入解除：关开关后发恢复探测请求，其延迟即恢复时间。
        provider.disable_injection()
        recovery_phase = await run_phase(
            client, phase_name="chaos-recovery-probe", concurrency=1, total_requests=5
        )
        phases["chaos"]["recovery"] = {
            "first_success_latency_ms_after_disarm": recovery_phase["latency_ms"]["p50"],
            "probe_requests": recovery_phase["requests"],
            "probe_error_count": recovery_phase["error_count"],
            "note": "注入解除后首个成功请求延迟（恢复时间）",
        }

    total_requests = 60 + 5 * 120 + 300 + 200
    report: dict[str, Any] = {
        "phase": 6,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "scenario": "POST /internal/agent/runs（AgentRuntime.invoke + 编译 storyboard_quality 图）",
        "environment": {
            "os": f"Windows 本机（{platform.platform()}）",
            "python": sys.version.split()[0],
            "transport": "进程内 ASGI（httpx ASGITransport，无网络栈）",
            "execution": "asyncio + asyncio.to_thread（同步 runtime.invoke 在线程池执行）",
            "store": "InMemoryRunStore（进程内存，threading.Lock）",
            "provider": "VerdictProvider（固定响应 Fake，无网络、无真实模型）",
            "database": "非生产数据库（未接入；InMemory 等价实现）",
            "graph": "build_storyboard_quality_graph 编译图（enable_model_review=True）",
        },
        "disclaimer": (
            "本报告为应用层形状测量（application-layer shape measurement）："
            "进程内 ASGI、内存 store、FakeProvider、非生产数据库，"
            "不代表生产环境容量，不构成任何生产容量承诺。"
        ),
        "capacity_verdict": "not_a_production_capacity_claim",
        "phases": phases,
        "data_scale": {
            "total_requests": total_requests,
            "phase_requests": {
                "baseline": 60,
                "ramp": "1/2/4/8/16 并发各 120",
                "steady": 300,
                "chaos": 200,
            },
            "unique_idempotency_keys": total_requests,
        },
    }
    return report


def print_summary(report: dict[str, Any]) -> None:
    """打印人读摘要（每阶段吞吐/延迟/错误率 + chaos 对比 + 恢复时间）。

    :param report: 压测报告 dict。
    :returns: 无返回值。
    """

    def fmt_phase(phase: dict[str, Any]) -> str:
        """格式化单个阶段摘要行。

        :param phase: 阶段指标 dict。
        :returns: 摘要行文本。
        """
        latency = phase["latency_ms"]
        return (
            f"[{phase['name']:<22}] c={phase['concurrency']:<3} n={phase['requests']:<4} "
            f"rps={phase['throughput_rps']:>8.2f} "
            f"p50={latency['p50']:>8.2f}ms p95={latency['p95']:>8.2f}ms "
            f"p99={latency['p99']:>8.2f}ms err={phase['error_rate'] * 100:.2f}%"
        )

    print("=" * 100)
    print("ProjectDream 阶段 6 应用层形状压测（非生产容量承诺）")
    print("=" * 100)
    print(fmt_phase(report["phases"]["baseline"]))
    for ramp in report["phases"]["ramp"]:
        print(fmt_phase(ramp))
    print(fmt_phase(report["phases"]["steady"]))
    print(fmt_phase(report["phases"]["chaos"]))
    injection = report["phases"]["chaos"]["injection"]
    recovery = report["phases"]["chaos"]["recovery"]
    print(
        f"  chaos 注入: {injection['kind']} 每 {injection['inject_every_provider_calls']} 次供应商调用 1 次"
        f"（实际注入 {injection['injected_provider_calls']} 次），"
        f"错误率 {injection['observed_error_rate'] * 100:.2f}%"
    )
    print(
        f"  恢复: 注入解除后首个成功请求延迟 {recovery['first_success_latency_ms_after_disarm']:.2f}ms"
        f"（探测 {recovery['probe_requests']} 次，错误 {recovery['probe_error_count']} 次）"
    )
    print(f"环境: {report['environment']['os']} / {report['environment']['transport']} / "
          f"{report['environment']['store']} / {report['environment']['provider']}")
    print(f"容量结论: {report['capacity_verdict']}")
    print("=" * 100)


def main() -> int:
    """压测入口：执行、写报告、打印摘要。

    :returns: 进程退出码（0 = 成功）。
    :raises Exception: 压测执行或报告写入失败时原样抛出。
    """
    report = asyncio.run(execute_loadtest())
    _ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    _REPORT_PATH.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print_summary(report)
    print(f"报告已写入: {_REPORT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
