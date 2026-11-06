"""中断恢复与对账单元测试（六类场景）。

① 节点前失败（load 层 InvalidInputError→blocked，可 resume）；
② 节点执行中断（handler 抛 RuntimeError→failed；run 停 running 时 resume_interrupted
   先置 retryable_failed 再重放恢复）；
③ 供应商已创建未保存（pending 记录存在时重试不产生第二条供应商任务，
   submit_fn 调用计数=2 但 provider_task_id 复用）；
④ 重复回调/重复提交（同幂等键第二次直接返回 reused=True，submit 计数不增）；
⑤ Worker 重启（checkpoint 新实例恢复 state 后从暂停节点继续）；
⑥ checkpoint 与 run 不一致（reconcile 判定 action=checkpoint_rewound，业务状态为准）。
"""

from typing import Any

import pytest

from app.agent.errors import InvalidInputError
from app.agent.model_provider import FakeStoryboardReviewProvider
from app.agent.pipeline.checkpoint import InMemoryCheckpointStore, MySQLCheckpointStore
from app.agent.pipeline.idempotency import build_idempotency_key
from app.agent.pipeline.paid_submission import (
    InMemoryPaidSubmissionStore,
    prepare_paid_submission,
)
from app.agent.pipeline.recovery import reconcile, resume_interrupted
from app.agent.pipeline.stages import PIPELINE_STAGES, build_pipeline_graph
from app.agent.run_store import InMemoryRunStore
from app.agent.runtime import AgentRuntime
from app.agent.schemas import AgentRequest, AgentResult
from test_pipeline_checkpoint import FakeCheckpointDatabase


def make_request(**overrides) -> AgentRequest:
    """构造测试用 AgentRequest。

    :param overrides: 覆盖默认字段的键值。
    :returns: AgentRequest 实例。
    """
    base = {
        "project_id": 8,
        "task_type": "storyboard_quality",
        "payload": {"sceneId": 3},
        "idempotency_key": "p8-storyboard-quality-3",
    }
    base.update(overrides)
    return AgentRequest(**base)


def make_result(run_id: str, status: str = "completed") -> AgentResult:
    """构造测试用终态 AgentResult。

    :param run_id: 运行 ID。
    :param status: 终态状态。
    :returns: AgentResult 实例。
    """
    return AgentResult(run_id=run_id, status=status, validated_output={"ok": True}, trace_id="trace-1")


def make_runtime(handler_registry: dict[str, Any], store: InMemoryRunStore | None = None) -> AgentRuntime:
    """构造测试用 AgentRuntime（8 阶段编排图 + InMemory store）。

    runtime 约定 graph_builder 返回 ``run(state: dict) -> dict`` 可调用对象；
    LangGraph 1.2.15 的编译图不可直接调用（须走 ``.invoke``），故在此包一层适配。

    :param handler_registry: stage key -> handler 的注册表。
    :param store: 可选注入的 run 存储。
    :returns: AgentRuntime 实例。
    """

    def graph_builder(provider):
        """构建 8 阶段图并适配 runtime 的 run(state) 调用约定。

        :param provider: 模型提供方（编排图不使用）。
        :returns: ``run(state: dict) -> dict`` 可调用对象（内部走 graph.invoke）。
        """
        graph = build_pipeline_graph(handler_registry)
        return lambda state: graph.invoke(state)

    return AgentRuntime(
        provider=FakeStoryboardReviewProvider(response={"verdict": "pass"}),
        store=store or InMemoryRunStore(),
        graph_builder=graph_builder,
    )


def build_paid_key(business_ref: str = "sb-1") -> str:
    """构造视频阶段付费提交的幂等键。

    :param business_ref: 业务主键（分镜 ID）。
    :returns: 幂等键字符串。
    """
    return build_idempotency_key(
        task_type="storyboard_pipeline", project_id=7, stage_key="video", business_ref=business_ref
    )


# ---------------------------------------------------------------------------
# 场景①：节点前失败（load 层 InvalidInputError → blocked，可 resume）
# ---------------------------------------------------------------------------


def test_scenario_1_load_invalid_input_maps_blocked_and_resume_replays():
    """load 层抛 InvalidInputError → run 落 blocked 终态；resume 派生新 run 重放。"""

    def asset_parse_handler(state: dict) -> dict:
        """资产解析 handler：恒抛 InvalidInputError（模拟 load 层校验失败）。

        :param state: 当前图状态。
        :returns: 永不返回。
        :raises InvalidInputError: 每次调用都抛出。
        """
        raise InvalidInputError("payload 缺少分镜记录")

    runtime = make_runtime({"asset-parse": asset_parse_handler})
    result = runtime.invoke(make_request(payload={}))
    assert result.status == "blocked"
    run = runtime.get_status(result.run_id)
    assert run["status"] == "blocked"

    resumed = runtime.resume(result.run_id)
    assert resumed is not None
    assert resumed.status == "blocked"  # 坏 payload 重放仍 blocked（可诊断、可重试）
    assert resumed.run_id != result.run_id  # 阶段 1 语义：派生新 run 保留原现场


# ---------------------------------------------------------------------------
# 场景②：节点执行中断（RuntimeError→failed；run 停 running 时 resume_interrupted 恢复）
# ---------------------------------------------------------------------------


def test_scenario_2a_handler_runtime_error_maps_failed():
    """handler 抛 RuntimeError → 运行时映射为 failed 终态（消息脱敏）。"""

    def video_handler(state: dict) -> dict:
        """视频生成 handler：模拟执行中断。

        :param state: 当前图状态。
        :returns: 永不返回。
        :raises RuntimeError: 每次调用都抛出。
        """
        raise RuntimeError("worker crashed mid-render")

    runtime = make_runtime({"video": video_handler})
    result = runtime.invoke(make_request())
    assert result.status == "failed"
    assert result.blockers[0]["code"] == "internal_error"
    assert "RuntimeError" in result.blockers[0]["message"]


def test_scenario_2b_resume_interrupted_marks_retryable_then_replays():
    """run 卡在 running（进程中断残留）→ 先置 retryable_failed，再重放恢复。"""
    store = InMemoryRunStore()

    def delivery_handler(state: dict) -> dict:
        """本地导出 handler：成功路径由收尾阶段落定 completed 终态。

        :param state: 当前图状态。
        :returns: 终态增量（透传节点不写 status，经 runtime 集成时由业务 handler 收口）。
        """
        return {"status": "completed", "validated_output": {"exportPath": "/tmp/out.mp4"}}

    runtime = make_runtime({"delivery": delivery_handler}, store)
    run_id = store.create_run(make_request(), "trace-1")
    store.update_status(run_id, "running", None)  # 模拟中断残留：非终态

    result = resume_interrupted(runtime, run_id)
    assert result is not None
    assert result.status == "completed"  # 重放成功并落终态
    assert result.run_id != run_id  # resume 产生新 run
    assert store.get_run(run_id)["status"] == "retryable_failed"  # 原 run 落可重试终态


def test_scenario_2b_resume_interrupted_noop_for_terminal_and_missing():
    """终态 run / 不存在的 run：resume_interrupted 返回 None（无可恢复项）。"""
    store = InMemoryRunStore()
    runtime = make_runtime({}, store)
    run_id = store.create_run(make_request(), "trace-1")
    store.update_status(run_id, "completed", make_result(run_id))
    assert resume_interrupted(runtime, run_id) is None
    assert resume_interrupted(runtime, "missing-run") is None


# ---------------------------------------------------------------------------
# 场景③：供应商已创建未保存（pending 中断后重试复用，绝不二次提交）
# ---------------------------------------------------------------------------


class CrashBeforePersistStore(InMemoryPaidSubmissionStore):
    """模拟"mark_submitted 落库前进程中断"的存储：首次标记时抛异常。

    :param: 无外部依赖。
    """

    def __init__(self) -> None:
        """初始化标记计数。"""
        super().__init__()
        self.mark_submitted_calls = 0

    def mark_submitted(self, idempotency_key: str, provider_task_id: str) -> None:
        """首次调用模拟中断抛异常，此后正常落库。

        :param idempotency_key: 幂等键。
        :param provider_task_id: 供应商任务 ID。
        :raises RuntimeError: 首次调用时抛出（模拟进程中断）。
        """
        self.mark_submitted_calls += 1
        if self.mark_submitted_calls == 1:
            raise RuntimeError("simulated crash before persisting submitted state")
        super().mark_submitted(idempotency_key, provider_task_id)


def test_scenario_3_provider_task_created_but_not_persisted_reuses_on_retry():
    """供应商侧已创建任务但 submitted 未落库：重试复用原任务，submit_fn 计数=2。"""
    store = CrashBeforePersistStore()
    submit_calls: list[dict[str, Any]] = []

    def submit_fn(payload: dict, existing: dict | None) -> dict:
        """模拟供应商提交：收到 existing 时按稳定业务键复用原任务。

        :param payload: 提交负载。
        :param existing: 既有 pending 记录（可为 None）。
        :returns: 含 provider_task_id 的结果 dict。
        """
        submit_calls.append({"payload": payload, "existing": existing})
        # 供应商侧按幂等键复用：无论是否中断，稳定返回同一个任务 ID（不创建第二条任务）。
        return {"provider_task_id": "prov-task-1"}

    key = build_paid_key()
    with pytest.raises(RuntimeError):
        prepare_paid_submission(
            store, submit_fn,
            idempotency_key=key, project_id=7, stage_key="video",
            provider="provider-a", payload={"sceneId": 3},
        )
    # 中断现场：库里是 pending（供应商侧已创建，submitted 未落库）。
    assert store.find_by_key(key)["submission_state"] == "pending"
    assert submit_calls[0]["existing"] is not None

    second = prepare_paid_submission(
        store, submit_fn,
        idempotency_key=key, project_id=7, stage_key="video",
        provider="provider-a", payload={"sceneId": 3},
    )
    assert len(submit_calls) == 2  # submit_fn 调用计数 = 2
    assert submit_calls[1]["existing"]["submission_state"] == "pending"  # 复用中断现场
    assert second == {
        "idempotency_key": key,
        "submission_state": "submitted",
        "provider_task_id": "prov-task-1",  # 与首次供应商侧任务一致，未产生第二条任务
        "reused": True,
    }


# ---------------------------------------------------------------------------
# 场景④：重复回调/重复提交（同幂等键第二次直接返回，submit 计数不增）
# ---------------------------------------------------------------------------


def test_scenario_4_duplicate_submission_replays_without_new_submit():
    """已 submitted 的幂等键重复调用：直接重放结果，不调 submit_fn。"""
    store = InMemoryPaidSubmissionStore()
    submit_calls: list[dict | None] = []

    def submit_fn(payload: dict, existing: dict | None) -> dict:
        """记录调用次数的供应商提交 Fake。

        :param payload: 提交负载。
        :param existing: 既有记录。
        :returns: 含 provider_task_id 的结果 dict。
        """
        submit_calls.append(existing)
        return {"provider_task_id": "prov-task-9"}

    kwargs = {
        "idempotency_key": build_paid_key("sb-9"),
        "project_id": 7,
        "stage_key": "video",
        "provider": "provider-a",
        "payload": {"sceneId": 3},
    }
    first = prepare_paid_submission(store, submit_fn, **kwargs)
    assert first == {
        "idempotency_key": kwargs["idempotency_key"],
        "submission_state": "submitted",
        "provider_task_id": "prov-task-9",
        "reused": False,
    }
    second = prepare_paid_submission(store, submit_fn, **kwargs)  # 重复回调/重复提交
    assert second["reused"] is True
    assert second["provider_task_id"] == "prov-task-9"
    assert len(submit_calls) == 1  # submit 计数不增


# ---------------------------------------------------------------------------
# 场景⑤：Worker 重启（checkpoint 新实例恢复 state 后继续）
# ---------------------------------------------------------------------------


def _scene_lock_gate_handler(state: dict) -> dict:
    """场景锁定 handler：未审批时 waiting_approval，审批通过后放行。

    :param state: 当前图状态。
    :returns: 状态增量。
    """
    if (state.get("approvals") or {}).get("scene-lock"):
        return {}
    return {"status": "waiting_approval"}


def test_scenario_5_worker_restart_resumes_from_checkpoint_new_instance():
    """Worker 重启：同一后端新实例 load 快照，注入 approvals 后从暂停节点继续。"""
    fake_db = FakeCheckpointDatabase()
    graph = build_pipeline_graph({"scene-lock": _scene_lock_gate_handler})
    store_a = MySQLCheckpointStore(fake_db)
    first = graph.invoke({"payload": {"projectId": 7}, "project_id": 7, "episode_no": 3})
    assert first["status"] == "waiting_approval"
    assert first["current_stage"] == "scene-lock"
    store_a.save("run-restart", first, first["status"])

    # 模拟 Worker 重启：新建 checkpoint 实例与新图实例（仅共享数据库后端）。
    store_b = MySQLCheckpointStore(fake_db)
    snapshot = store_b.load("run-restart")
    assert snapshot is not None
    resume_state = dict(snapshot["state"])
    resume_state["approvals"] = {"scene-lock": {"approved": True}}
    resume_state["status"] = "running"
    graph_b = build_pipeline_graph({"scene-lock": _scene_lock_gate_handler})
    second = graph_b.invoke(resume_state)

    assert list(second["stage_results"].keys()) == [stage.key for stage in PIPELINE_STAGES]
    assert second["current_stage"] == "delivery"


# ---------------------------------------------------------------------------
# 场景⑥：checkpoint 与 run 不一致（reconcile 以业务 run 状态为准）
# ---------------------------------------------------------------------------


def test_scenario_6_reconcile_reports_rewound_when_checkpoint_behind_run():
    """checkpoint 落后于业务 run → consistent=False、action=checkpoint_rewound。"""
    run_store = InMemoryRunStore()
    checkpoints = InMemoryCheckpointStore()
    run_id = run_store.create_run(make_request(), "trace-1")
    run_store.update_status(run_id, "completed", make_result(run_id))  # 业务库已是终态
    checkpoints.save(run_id, {"status": "running"}, "running")  # checkpoint 停留在旧现场

    report = reconcile(checkpoints, run_store, run_id)
    assert report == {
        "run_id": run_id,
        "checkpoint_status": "running",
        "run_status": "completed",
        "consistent": False,
        "action": "checkpoint_rewound",
    }


def test_scenario_6_rewind_checkpoint_from_run_restores_consistency():
    """业务库为事实源：按 run 状态回卷快照后重新对账一致。"""
    run_store = InMemoryRunStore()
    checkpoints = InMemoryCheckpointStore()
    run_id = run_store.create_run(make_request(), "trace-1")
    run_store.update_status(run_id, "completed", make_result(run_id))
    checkpoints.save(run_id, {"status": "running"}, "running")
    assert reconcile(checkpoints, run_store, run_id)["action"] == "checkpoint_rewound"

    # 调用方决定从 run 的 result_json 重建快照（本测试演示回卷动作）。
    run = run_store.get_run(run_id)
    checkpoints.save(run_id, run["result"] or {}, str(run["status"]))
    report = reconcile(checkpoints, run_store, run_id)
    assert report["consistent"] is True
    assert report["action"] == "none"


def test_scenario_6_missing_checkpoint_reports_rewound():
    """checkpoint 缺失而 run 存在 → 同样判 checkpoint_rewound。"""
    run_store = InMemoryRunStore()
    checkpoints = InMemoryCheckpointStore()
    run_id = run_store.create_run(make_request(), "trace-1")
    run_store.update_status(run_id, "retryable_failed", make_result(run_id, "retryable_failed"))
    report = reconcile(checkpoints, run_store, run_id)
    assert report["checkpoint_status"] is None
    assert report["run_status"] == "retryable_failed"
    assert report["consistent"] is False
    assert report["action"] == "checkpoint_rewound"


def test_scenario_6_reconcile_missing_run_raises_invalid_input():
    """run 不存在时对账抛 InvalidInputError（无对账目标）。"""
    run_store = InMemoryRunStore()
    checkpoints = InMemoryCheckpointStore()
    with pytest.raises(InvalidInputError):
        reconcile(checkpoints, run_store, "missing-run")
