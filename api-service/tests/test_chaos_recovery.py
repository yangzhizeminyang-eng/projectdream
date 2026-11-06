"""故障注入与恢复测试（阶段 6 五场景）。

五场景（任务书阶段 6：任何注入下无重复付费、无状态丢失）：
① 并发重复提交：50 线程同幂等键 + 租约门 invoke，执行计数==1 且全部同 run_id；
② 进程被杀模拟：run 停留 running（无终态事件），resume_interrupted 恢复且图执行计数不重复；
③ DB 断连：create_run 失败抛 ConnectionError，重试成功且同键只有一个 run；
④ RAG 超时 / 供应商限流注入：paid_submission 重试不二次提交（submit 计数锁定）；
⑤ 注入解除后全部恢复正常：原 run 状态与事件保留（无状态丢失），恢复 run 落 completed。

另含 ChaosController / ChaosDB / ChaosProvider / simulate_process_kill 的组件级单测。
"""

from __future__ import annotations

import threading
import time
from typing import Any

import pytest

from app.agent.chaos import ChaosController, ChaosDB, ChaosProvider, simulate_process_kill
from app.agent.errors import AgentError, ToolInvocationError
from app.agent.lease import InMemoryLeaseStore
from app.agent.model_provider import FakeStoryboardReviewProvider
from app.agent.pipeline.paid_submission import (
    InMemoryPaidSubmissionStore,
    prepare_paid_submission,
)
from app.agent.pipeline.recovery import resume_interrupted
from app.agent.quality.graph import (
    StoryboardReviewVerdict,
    build_storyboard_quality_graph,
)
from app.agent.run_store import InMemoryRunStore, MySQLRunStore
from app.agent.runtime import AgentRuntime
from app.agent.schemas import AgentRequest, AgentResult

# 规则门可通过的合法分镜负载（与编译图试点 fixture 一致）。
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


class ExecutionCounter:
    """线程安全的图执行计数器（副作用计数的断言锚点）。

    :param: 无外部依赖。
    """

    def __init__(self) -> None:
        """初始化计数与互斥锁。"""
        self._count = 0
        self._lock = threading.Lock()

    def bump(self) -> None:
        """执行计数加一（图每次执行调用一次）。

        :returns: 无返回值。
        """
        with self._lock:
            self._count += 1

    @property
    def count(self) -> int:
        """当前累计执行次数。

        :returns: 计数值。
        """
        with self._lock:
            return self._count


def counting_graph_builder(counter: ExecutionCounter, *, sleep_seconds: float = 0.0):
    """构造带执行计数的图工厂（runtime graph_builder 契约）。

    :param counter: 执行计数器。
    :param sleep_seconds: 每次执行前的停顿（放大并发竞态窗口）。
    :returns: ``graph_builder(provider) -> run(state) -> dict``。
    """

    def graph_builder(provider):
        """构建计数图可调用对象。

        :param provider: 模型提供方（计数图不使用）。
        :returns: ``run(state: dict) -> dict`` 可调用对象。
        """

        def run(state: dict) -> dict:
            """执行一次并计数。

            :param state: 图状态。
            :returns: completed 终态增量。
            """
            if sleep_seconds > 0:
                time.sleep(sleep_seconds)
            counter.bump()
            return {
                "status": "completed",
                "validated_output": {"ok": True},
                "blockers": [],
                "usage": {},
            }

        return run

    return graph_builder


class GraphVerdictProvider:
    """质量图模型复核节点契约的 Fake provider（直接返回结论模型，带调用计数）。

    与 test_quality_graph.py 的 Fake 同契约：``complete_structured`` 直接返回
    ``StoryboardReviewVerdict`` 实例（不是 (model, usage) 元组——
    ``_normalize_verdict`` 只接受模型实例或 dict）。

    :param: 无外部依赖。
    """

    def __init__(self) -> None:
        """初始化调用计数。"""
        self.calls = 0

    def complete_structured(
        self,
        *,
        system: str,
        user: str,
        schema_model: Any,
        timeout_seconds: float = 30.0,
    ) -> StoryboardReviewVerdict:
        """返回固定"通过"结论并计数。

        :param system: system 提示词（忽略）。
        :param user: user 提示词（忽略）。
        :param schema_model: 输出 schema（忽略）。
        :param timeout_seconds: 超时（忽略，ChaosProvider 转发时传入）。
        :returns: 通过的 StoryboardReviewVerdict 实例。
        """
        self.calls += 1
        return StoryboardReviewVerdict(overall_pass=True, issues=[])


def quality_graph_builder(provider):
    """构建启用了模型复核的编译质量图（provider 会被真实调用）。

    :param provider: 模型提供方。
    :returns: 编译后的 LangGraph 图。
    """
    return build_storyboard_quality_graph(provider, enable_model_review=True)


def make_request(idempotency_key: str) -> AgentRequest:
    """构造指向质量图的最小请求。

    :param idempotency_key: 幂等键。
    :returns: AgentRequest 实例。
    """
    return AgentRequest(
        project_id=5,
        task_type="storyboard_quality",
        payload=_VALID_PAYLOAD,
        idempotency_key=idempotency_key,
    )


def make_runtime(store, counter: ExecutionCounter, *, sleep_seconds: float = 0.0) -> AgentRuntime:
    """构造带计数图的 runtime。

    :param store: run 存储。
    :param counter: 执行计数器。
    :param sleep_seconds: 图执行停顿秒数。
    :returns: AgentRuntime 实例。
    """
    return AgentRuntime(
        provider=FakeStoryboardReviewProvider(),
        store=store,
        graph_builder=counting_graph_builder(counter, sleep_seconds=sleep_seconds),
    )


def invoke_under_lease(
    runtime: AgentRuntime,
    store,
    leases: InMemoryLeaseStore,
    request: AgentRequest,
    owner: str,
    *,
    lease_seconds: float = 30.0,
    wait_seconds: float = 10.0,
) -> AgentResult:
    """租约门 + invoke：同 job 只有一个执行者执行图，其余等待终态后重放。

    这是阶段 6 的应用层组装形状：抢到租约者执行 runtime.invoke 并释放；
    未抢到者轮询幂等键直到已有 run 落终态（result 落库）后重放，
    保证并发重复提交不重复执行图（无重复付费）。

    :param runtime: Agent 运行时。
    :param store: run 存储（轮询终态用）。
    :param leases: 租约存储。
    :param request: Agent 请求。
    :param owner: 认领者标识。
    :param lease_seconds: 租约时长（秒）。
    :param wait_seconds: 等待终态超时（秒）。
    :returns: 终态 AgentResult（执行者与等待重放者拿到同一 run_id）。
    :raises TimeoutError: 等待已有 run 落终态超时时抛出。
    """
    job_key = f"invoke:{request.idempotency_key}"
    if leases.claim(job_key, owner, lease_seconds):
        try:
            return runtime.invoke(request)
        finally:
            leases.release(job_key, owner)
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        run = store.find_by_idempotency_key(request.idempotency_key)
        if run is not None and run.get("result"):
            return AgentResult.model_validate(run["result"])
        time.sleep(0.01)
    raise TimeoutError(f"等待 run 终态超时: {job_key}")


class FakeAgentRunDatabase:
    """模拟 agent_runs / agent_run_events 表的假 database（行为化 SQL）。

    与 test_agent_run_store.py 风格一致：记录语句，按语句类型施加
    INSERT/UPDATE 行为，供 MySQLRunStore 完整走一遍 run 生命周期。
    """

    def __init__(self) -> None:
        """初始化语句记录与空表。"""
        self.statements: list[tuple[str, str, tuple]] = []
        # run_id -> 行 dict（含 payload_json/result_json 原始列）。
        self.rows: dict[str, dict[str, Any]] = {}

    @staticmethod
    def _normalize(sql: str) -> str:
        """归一化 SQL 文本（折叠空白、转大写）。

        :param sql: 原始 SQL。
        :returns: 归一化后的 SQL。
        """
        return " ".join(sql.split()).upper()

    def execute(self, sql: str, params: tuple = ()) -> int:
        """记录写语句并模拟 INSERT/UPDATE 行为。

        :param sql: 参数化 SQL。
        :param params: SQL 参数。
        :returns: 受影响行数（固定 1）。
        """
        self.statements.append(("execute", sql, params))
        normalized = self._normalize(sql)
        if "INSERT INTO AGENT_RUN_EVENTS" in normalized:
            pass  # 事件表：仅记录语句
        elif "INSERT INTO AGENT_RUNS" in normalized:
            run_id, idempotency_key, project_id, task_type, payload_json, trace_id = params
            self.rows[run_id] = {
                "run_id": run_id,
                "idempotency_key": idempotency_key,
                "project_id": project_id,
                "task_type": task_type,
                "status": "queued",
                "payload_json": payload_json,
                "result_json": None,
                "trace_id": trace_id,
                "created_at": "2026-10-16 08:00:00",
                "updated_at": "2026-10-16 08:00:00",
            }
        elif "UPDATE AGENT_RUNS" in normalized:
            status, result_json, run_id = params
            row = self.rows.get(run_id)
            if row is not None:
                row["status"] = status
                row["result_json"] = result_json
        return 1

    def fetchone(self, sql: str, params: tuple = ()) -> dict[str, Any] | None:
        """记录读语句并按 WHERE 形状返回行副本。

        :param sql: 参数化 SQL。
        :param params: SQL 参数。
        :returns: 命中行副本或 None。
        """
        self.statements.append(("fetchone", sql, params))
        normalized = self._normalize(sql)
        if "WHERE IDEMPOTENCY_KEY = %S" in normalized:
            (key,) = params
            for row in self.rows.values():
                if row["idempotency_key"] == key:
                    return dict(row)
            return None
        if "WHERE RUN_ID = %S" in normalized:
            row = self.rows.get(params[0])
            return dict(row) if row is not None else None
        return None

    def fetchall(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        """记录读语句并返回事件行（本假库不模拟事件内容）。

        :param sql: 参数化 SQL。
        :param params: SQL 参数。
        :returns: 空列表。
        """
        self.statements.append(("fetchall", sql, params))
        return []

    def rows_for_idempotency_key(self, key: str) -> list[dict[str, Any]]:
        """统计指定幂等键下的 run 行（重复提交断言用）。

        :param key: 幂等键。
        :returns: 命中行列表。
        """
        return [row for row in self.rows.values() if row["idempotency_key"] == key]


# ---------------------------------------------------------------------------
# 场景①：并发重复提交（50 线程同幂等键，执行计数==1 且全部同 run_id）
# ---------------------------------------------------------------------------


def test_scenario_1_concurrent_duplicate_submission_executes_once() -> None:
    """50 线程同幂等键 + 租约门：图只执行一次，全部拿到同一 run_id（无重复付费）。

    :returns: 无返回值。
    :raises AssertionError: 执行计数或 run_id 不唯一时抛出。
    """
    store = InMemoryRunStore()
    counter = ExecutionCounter()
    runtime = make_runtime(store, counter, sleep_seconds=0.02)
    leases = InMemoryLeaseStore()
    request = make_request("chaos:dup:p5:storyboard:1")
    results: list[AgentResult] = []
    errors: list[Exception] = []
    barrier = threading.Barrier(50)

    def worker(index: int) -> None:
        """并发 worker：齐发后走租约门提交同一请求。

        :param index: worker 序号。
        :returns: 无返回值。
        """
        try:
            barrier.wait()
            results.append(
                invoke_under_lease(runtime, store, leases, request, owner=f"worker-{index}")
            )
        except Exception as exc:  # pragma: no cover - 仅在测试失败时触发
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(50)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert counter.count == 1  # 执行计数==1：同一副作用绝不重复
    assert len({result.run_id for result in results}) == 1  # 全部同 run_id
    assert results[0].status == "completed"
    # 执行者释放租约后可被重新认领（无槽位泄漏）。
    assert leases.claim("invoke:" + request.idempotency_key, "verifier", 30.0) is True


# ---------------------------------------------------------------------------
# 场景②：进程被杀模拟 → resume_interrupted 恢复且无重复副作用
# ---------------------------------------------------------------------------


def test_scenario_2_process_kill_resume_without_duplicate_side_effect() -> None:
    """强杀残留（running、无终态事件）→ 恢复重放只执行一次图。

    :returns: 无返回值。
    :raises AssertionError: 恢复后状态或执行计数不符时抛出。
    """
    store = InMemoryRunStore()
    counter = ExecutionCounter()
    runtime = make_runtime(store, counter)
    request = make_request("chaos:kill:p5:storyboard:2")

    run_id = store.create_run(request, "trace-kill")
    killed = simulate_process_kill(store, run_id)
    assert killed is not None and killed["status"] == "running"  # 强杀残留现场
    assert store.list_events(run_id) == []  # 无终态事件

    result = resume_interrupted(runtime, run_id)
    assert result is not None
    assert result.status == "completed"
    assert result.run_id != run_id  # resume 派生新 run，原 run 保留现场
    assert counter.count == 1  # 无重复副作用：恢复重放仅执行一次图
    assert store.get_run(run_id)["status"] == "retryable_failed"  # 原 run 落可重试终态


def test_simulate_process_kill_missing_run_returns_none() -> None:
    """simulate_process_kill 对不存在的 run 返回 None。

    :returns: 无返回值。
    :raises AssertionError: 返回值非 None 时抛出。
    """
    assert simulate_process_kill(InMemoryRunStore(), "missing-run") is None


# ---------------------------------------------------------------------------
# 场景③：DB 断连 → create_run 失败，重试成功且同键不重复
# ---------------------------------------------------------------------------


def test_scenario_3_db_disconnect_then_retry_succeeds_without_duplicate() -> None:
    """ChaosDB 注入 db_disconnect：首次 create_run 抛 ConnectionError；
    重试成功且同幂等键只有一个 run（无重复创建）。

    :returns: 无返回值。
    :raises ConnectionError: 首次 invoke 时抛出（本测试断言其发生）。
    """
    fake_db = FakeAgentRunDatabase()
    chaos = ChaosController()
    chaos.arm("db_disconnect", after_calls=3)  # 第 3 次 DB 调用 = create_run 的 INSERT
    store = MySQLRunStore(ChaosDB(fake_db, chaos))
    counter = ExecutionCounter()
    runtime = AgentRuntime(
        provider=FakeStoryboardReviewProvider(),
        store=store,
        graph_builder=counting_graph_builder(counter),
    )
    request = make_request("chaos:db:p5:storyboard:3")

    with pytest.raises(ConnectionError, match="injected: mysql gone away"):
        runtime.invoke(request)
    assert fake_db.rows_for_idempotency_key(request.idempotency_key) == []  # 未落半行脏数据

    # 注入一次性消耗：直接重试成功。
    result = runtime.invoke(request)
    assert result.status == "completed"
    assert len(fake_db.rows_for_idempotency_key(request.idempotency_key)) == 1  # 同键不重复
    replayed = store.find_by_idempotency_key(request.idempotency_key)
    assert replayed is not None and replayed["run_id"] == result.run_id


# ---------------------------------------------------------------------------
# 场景④：RAG 超时 / 供应商限流注入 → paid_submission 重试不二次提交
# ---------------------------------------------------------------------------


def test_scenario_4_provider_rate_limited_injection_no_double_submit() -> None:
    """限流注入命中 submit_fn：首次落 failed（未创建供应商任务），
    重试成功且成功提交计数==1，再次幂等重放不增计数（无重复付费）。

    :returns: 无返回值。
    :raises AssertionError: submit 计数或提交结果不符时抛出。
    """
    store = InMemoryPaidSubmissionStore()
    chaos = ChaosController()
    chaos.arm("provider_rate_limited", after_calls=1)
    submissions: list[str] = []

    def submit_fn(payload: dict, existing: dict | None) -> dict:
        """供应商提交 Fake：真实提交前经过注入点。

        :param payload: 提交负载。
        :param existing: 既有记录。
        :returns: 含 provider_task_id 的结果 dict。
        :raises AgentError: 命中限流注入时抛出。
        """
        chaos.before("provider_rate_limited")
        provider_task_id = f"prov-task-{len(submissions) + 1}"
        submissions.append(provider_task_id)
        return {"provider_task_id": provider_task_id}

    kwargs = {
        "idempotency_key": "storyboard_pipeline:p7:video:sb-601",
        "project_id": 7,
        "stage_key": "video",
        "provider": "provider-a",
        "payload": {"sceneId": 3},
    }
    first = prepare_paid_submission(store, submit_fn, **kwargs)
    assert first["submission_state"] == "failed"
    assert submissions == []  # 注入在真实提交前抛出：未创建任何供应商任务
    assert store.find_by_key(kwargs["idempotency_key"])["submission_state"] == "failed"

    second = prepare_paid_submission(store, submit_fn, **kwargs)  # 注入已消耗，重试成功
    assert second["submission_state"] == "submitted"
    assert second["reused"] is False
    assert len(submissions) == 1  # 成功提交只发生一次

    third = prepare_paid_submission(store, submit_fn, **kwargs)  # 已 submitted：幂等重放
    assert third["submission_state"] == "submitted"
    assert third["reused"] is True
    assert third["provider_task_id"] == second["provider_task_id"]
    assert len(submissions) == 1  # submit 计数不增：绝不二次提交


def test_scenario_4b_rag_timeout_retryable_then_recovered() -> None:
    """ChaosProvider 注入 rag_timeout：run 落 retryable_failed；
    resume 重放（注入已消耗）成功且真实模型调用计数==1。

    :returns: 无返回值。
    :raises AssertionError: 状态或模型调用计数不符时抛出。
    """
    chaos = ChaosController()
    chaos.arm("rag_timeout", after_calls=1)
    fake = GraphVerdictProvider()
    runtime = AgentRuntime(
        provider=ChaosProvider(fake, chaos),
        store=InMemoryRunStore(),
        graph_builder=quality_graph_builder,
    )
    request = make_request("chaos:rag:p5:storyboard:4")

    first = runtime.invoke(request)
    assert first.status == "retryable_failed"  # ToolInvocationError(retryable) 映射
    assert fake.calls == 0  # 注入在真实 provider 前抛出

    resumed = runtime.resume(first.run_id)
    assert resumed is not None and resumed.status == "completed"
    assert fake.calls == 1  # 恢复重放仅一次真实模型调用


def test_chaos_provider_rate_limited_error_shape() -> None:
    """provider_rate_limited 注入抛 AgentError，消息为注入标记（便于断言）。

    :returns: 无返回值。
    :raises AgentError: 命中注入时抛出（本测试断言其类型与消息）。
    """
    chaos = ChaosController()
    chaos.arm("provider_rate_limited", after_calls=1)
    provider = ChaosProvider(FakeStoryboardReviewProvider(), chaos)
    with pytest.raises(AgentError, match="injected: 429 provider rate limited"):
        provider.complete_structured(system="s", user="u", schema_model=dict)


def test_chaos_controller_one_shot_and_validation() -> None:
    """注入计划一次性消耗；arm 校验非法 kind 与 after_calls<1。

    :returns: 无返回值。
    :raises ConnectionError: 命中注入时抛出（本测试断言其发生）。
    """
    chaos = ChaosController()
    with pytest.raises(ValueError):
        chaos.arm("unknown", 1)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        chaos.arm("db_disconnect", 0)
    chaos.arm("db_disconnect", 1)
    with pytest.raises(ConnectionError, match="injected: mysql gone away"):
        chaos.before("db_disconnect")
    chaos.before("db_disconnect")  # 一次性：第二次放行
    chaos.disarm("db_disconnect")
    chaos.before("db_disconnect")  # 撤销后放行
    assert chaos.injections == {"db_disconnect": 1}


# ---------------------------------------------------------------------------
# 场景⑤：注入解除后全部恢复正常（状态无丢失）
# ---------------------------------------------------------------------------


def test_scenario_5_after_chaos_cleared_all_recovered_and_state_intact() -> None:
    """rag_timeout / provider_rate_limited 相继注入后 reset 解除：
    两个 run 分别 resume 成功，原 run 状态与事件完整保留（无状态丢失）。

    :returns: 无返回值。
    :raises AssertionError: 状态丢失或事件链断裂时抛出。
    """
    store = InMemoryRunStore()
    chaos = ChaosController()
    fake = GraphVerdictProvider()
    runtime = AgentRuntime(
        provider=ChaosProvider(fake, chaos),
        store=store,
        graph_builder=quality_graph_builder,
    )

    chaos.arm("rag_timeout", after_calls=1)
    first = runtime.invoke(make_request("chaos:s5:p5:storyboard:101"))
    assert first.status == "retryable_failed"

    chaos.arm("provider_rate_limited", after_calls=1)
    second = runtime.invoke(make_request("chaos:s5:p5:storyboard:102"))
    assert second.status == "failed"  # AgentError → failed 终态

    assert chaos.injections == {"rag_timeout": 1, "provider_rate_limited": 1}
    chaos.reset()  # 注入解除

    # 恢复路径一：retryable_failed 走 runtime.resume（派生新幂等键重放）。
    recovered_first = runtime.resume(first.run_id)
    assert recovered_first is not None and recovered_first.status == "completed"
    # 恢复路径二：failed 终态不在 resume 白名单（契约），以新幂等键重试。
    recovered_second = runtime.invoke(make_request("chaos:s5:p5:storyboard:102-retry"))
    assert recovered_second.status == "completed"
    assert fake.calls == 2  # 两次恢复各一次真实调用；注入调用从未触达 provider

    # 状态无丢失：原 run 保留注入时的终态与完整事件链。
    assert store.get_run(first.run_id)["status"] == "retryable_failed"
    assert store.get_run(second.run_id)["status"] == "failed"
    assert [event["event_type"] for event in store.list_events(first.run_id)] == [
        "queued",
        "running",
        "retryable_failed",
    ]
    assert [event["event_type"] for event in store.list_events(second.run_id)] == [
        "queued",
        "running",
        "failed",
    ]
    # 恢复 run 有完整事件链且落 completed。
    assert [event["event_type"] for event in store.list_events(recovered_first.run_id)] == [
        "queued",
        "running",
        "completed",
    ]


# ---------------------------------------------------------------------------
# 组件级：ChaosDB 转发与注入
# ---------------------------------------------------------------------------


def test_chaos_db_forwards_and_injects() -> None:
    """ChaosDB 转发 execute/fetchone/fetchall 与未知属性；命中计划抛 ConnectionError。

    :returns: 无返回值。
    :raises ConnectionError: 命中注入时抛出（本测试断言其发生）。
    """
    fake_db = FakeAgentRunDatabase()
    chaos = ChaosController()
    chaos.arm("db_disconnect", after_calls=2)
    db = ChaosDB(fake_db, chaos)
    db.fetchone("SELECT * FROM agent_runs WHERE run_id = %s", ("r1",))  # 第 1 次放行
    with pytest.raises(ConnectionError, match="injected: mysql gone away"):
        db.execute("INSERT INTO agent_runs (run_id) VALUES (%s)", ("r1",))  # 第 2 次注入
    db.fetchall("SELECT 1")  # 注入一次性消耗后放行
    assert db.rows is fake_db.rows  # __getattr__ 透传未包装属性
    assert chaos.injections == {"db_disconnect": 1}