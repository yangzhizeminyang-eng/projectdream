"""AgentRuntime 单元测试。

覆盖：invoke 成功、幂等重放不重复执行、异常→状态映射（blocked/retryable_failed/failed）、
未知 task_type（无编排图）→blocked、get_status/resume/cancel、事件序列、
同一 store 换新 runtime（模拟重启）后仍可查询终态与事件。
"""

from app.agent.errors import InvalidInputError, ModelOutputError, ToolInvocationError
from app.agent.model_provider import FakeStoryboardReviewProvider
from app.agent.run_store import InMemoryRunStore
from app.agent.runtime import AgentRuntime
from app.agent.schemas import AgentRequest


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


def make_runtime(graph_builder=None, store=None) -> AgentRuntime:
    """构造测试用 AgentRuntime（Fake provider + InMemory store）。

    :param graph_builder: 注入的图构建工厂。
    :param store: 注入的 run 存储。
    :returns: AgentRuntime 实例。
    """
    return AgentRuntime(
        provider=FakeStoryboardReviewProvider(response={"verdict": "pass"}),
        store=store or InMemoryRunStore(),
        graph_builder=graph_builder,
    )


def completed_graph_builder(provider):
    """返回恒定 completed 的假图可调用对象。

    :param provider: 模型提供方（骨架图中不使用）。
    :returns: run(state: dict) -> dict 可调用对象。
    """

    def run(state: dict) -> dict:
        """执行假图：直接返回 completed 终态。

        :param state: 运行时注入的状态 dict。
        :returns: 含 status/validated_output/blockers/usage 的 state dict。
        """
        return {"status": "completed", "validated_output": {"ok": True}, "blockers": [], "usage": {}}

    return run


def test_invoke_success_records_completed_status_and_events():
    """invoke 成功：终态 completed、trace_id/checkpoint 贯穿、事件序列 queued→running→completed。"""
    store = InMemoryRunStore()
    runtime = make_runtime(completed_graph_builder, store)
    result = runtime.invoke(make_request())
    assert result.status == "completed"
    assert result.validated_output == {"ok": True}
    assert result.trace_id
    assert result.checkpoint_id == result.run_id
    run = store.get_run(result.run_id)
    assert run["status"] == "completed"
    assert run["result"]["status"] == "completed"
    assert [event["event_type"] for event in store.list_events(result.run_id)] == [
        "queued",
        "running",
        "completed",
    ]


def test_invoke_replays_idempotent_hit_without_rerunning_graph():
    """幂等重放：计数器断言图只执行一次，重放追加 idempotent_replay 事件。"""
    calls = {"count": 0}

    def counting_graph_builder(provider):
        """返回带执行计数器的假图。

        :param provider: 模型提供方。
        :returns: run 可调用对象。
        """

        def run(state: dict) -> dict:
            """执行假图并累加计数。

            :param state: 运行状态 dict。
            :returns: completed 终态 state dict。
            """
            calls["count"] += 1
            return {"status": "completed", "validated_output": {"ok": True}, "blockers": [], "usage": {}}

        return run

    store = InMemoryRunStore()
    runtime = make_runtime(counting_graph_builder, store)
    first = runtime.invoke(make_request())
    second = runtime.invoke(make_request())
    assert calls["count"] == 1
    assert second.run_id == first.run_id
    assert second.validated_output == first.validated_output
    event_types = [event["event_type"] for event in store.list_events(first.run_id)]
    assert event_types == ["queued", "running", "completed", "idempotent_replay"]


def test_invalid_input_error_maps_to_blocked():
    """InvalidInputError 映射为 blocked 终态并写事件。"""

    def failing_builder(provider):
        """返回恒抛 InvalidInputError 的假图。

        :param provider: 模型提供方。
        :returns: run 可调用对象。
        """

        def run(state: dict) -> dict:
            """执行假图：抛出输入校验异常。

            :param state: 运行状态 dict。
            :raises InvalidInputError: 总是抛出。
            """
            raise InvalidInputError("payload 缺少 sceneId")

        return run

    store = InMemoryRunStore()
    runtime = make_runtime(failing_builder, store)
    result = runtime.invoke(make_request())
    assert result.status == "blocked"
    assert result.blockers[0]["code"] == "invalid_input"
    assert store.get_run(result.run_id)["status"] == "blocked"
    assert [event["event_type"] for event in store.list_events(result.run_id)] == [
        "queued",
        "running",
        "blocked",
    ]


def test_model_output_error_maps_to_retryable_failed():
    """ModelOutputError 映射为 retryable_failed 终态。"""

    def failing_builder(provider):
        """返回恒抛 ModelOutputError 的假图。

        :param provider: 模型提供方。
        :returns: run 可调用对象。
        """

        def run(state: dict) -> dict:
            """执行假图：抛出模型输出异常。

            :param state: 运行状态 dict。
            :raises ModelOutputError: 总是抛出。
            """
            raise ModelOutputError("结构化输出解析失败")

        return run

    runtime = make_runtime(failing_builder)
    result = runtime.invoke(make_request())
    assert result.status == "retryable_failed"
    assert result.blockers[0]["code"] == "model_output"


def test_tool_invocation_error_retryable_flag_drives_status():
    """ToolInvocationError 的 retryable 标志决定 retryable_failed 或 blocked。"""

    def retryable_builder(provider):
        """返回抛可重试工具异常的假图。

        :param provider: 模型提供方。
        :returns: run 可调用对象。
        """

        def run(state: dict) -> dict:
            """抛出可重试工具异常。

            :param state: 运行状态 dict。
            :raises ToolInvocationError: retryable=True。
            """
            raise ToolInvocationError("工具调用超时", retryable=True)

        return run

    def blocked_builder(provider):
        """返回抛不可重试工具异常的假图。

        :param provider: 模型提供方。
        :returns: run 可调用对象。
        """

        def run(state: dict) -> dict:
            """抛出不可重试工具异常。

            :param state: 运行状态 dict。
            :raises ToolInvocationError: retryable=False。
            """
            raise ToolInvocationError("工具执行失败", retryable=False)

        return run

    assert make_runtime(retryable_builder).invoke(make_request()).status == "retryable_failed"
    assert make_runtime(blocked_builder).invoke(make_request()).status == "blocked"


def test_unknown_task_type_without_graph_maps_to_blocked():
    """未注册编排图（非试点 task_type）时 invoke 映射为 blocked。"""
    runtime = make_runtime(None)
    result = runtime.invoke(make_request())
    assert result.status == "blocked"
    assert result.blockers[0]["code"] == "invalid_input"


def test_unexpected_exception_maps_to_failed_and_is_sanitized():
    """未知异常映射为 failed，且错误摘要脱敏（不含异常内嵌的用户数据）。"""

    def crash_builder(provider):
        """返回抛未预期异常的假图。

        :param provider: 模型提供方。
        :returns: run 可调用对象。
        """

        def run(state: dict) -> dict:
            """执行假图：抛出携带用户数据的未预期异常。

            :param state: 运行状态 dict。
            :raises RuntimeError: 总是抛出。
            """
            raise RuntimeError("USERDATA leaked here")

        return run

    store = InMemoryRunStore()
    runtime = make_runtime(crash_builder, store)
    result = runtime.invoke(make_request())
    assert result.status == "failed"
    assert "USERDATA" not in str(result.blockers)
    assert store.get_run(result.run_id)["status"] == "failed"


def test_get_status_resume_and_cancel_semantics():
    """get_status/resume/cancel：resume 用原 payload 重放到新 run；终态不可 resume/cancel。"""
    call_count = {"n": 0}

    def flaky_builder(provider):
        """返回首次失败、后续成功的假图。

        :param provider: 模型提供方。
        :returns: run 可调用对象。
        """

        def run(state: dict) -> dict:
            """首次调用抛 ModelOutputError，之后返回 completed。

            :param state: 运行状态 dict。
            :returns: completed 终态 state dict。
            :raises ModelOutputError: 仅首次调用抛出。
            """
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise ModelOutputError("首次解析失败")
            return {"status": "completed", "validated_output": {"ok": True}, "blockers": [], "usage": {}}

        return run

    store = InMemoryRunStore()
    runtime = make_runtime(flaky_builder, store)
    failed = runtime.invoke(make_request())
    assert failed.status == "retryable_failed"

    status = runtime.get_status(failed.run_id)
    assert status is not None
    assert status["status"] == "retryable_failed"

    resumed = runtime.resume(failed.run_id)
    assert resumed is not None
    assert resumed.status == "completed"
    assert resumed.run_id != failed.run_id
    assert call_count["n"] == 2

    # 已终态 run 不可再次 resume；已完成 run 不可 cancel；未知 run 查询返回 None。
    assert runtime.resume(resumed.run_id) is None
    assert runtime.cancel(resumed.run_id) is None
    assert runtime.get_status("missing-run") is None
    assert runtime.resume("missing-run") is None
    assert runtime.cancel("missing-run") is None


def test_cancel_marks_queued_run_as_canceled():
    """cancel 把未终态（queued）的 run 标记为 canceled 并写事件。"""
    store = InMemoryRunStore()
    runtime = make_runtime(completed_graph_builder, store)
    run_id = store.create_run(make_request(), "trace-1")
    result = runtime.cancel(run_id)
    assert result is not None
    assert result.status == "canceled"
    assert store.get_run(run_id)["status"] == "canceled"
    assert [event["event_type"] for event in store.list_events(run_id)] == ["canceled"]


def test_status_survives_new_runtime_over_same_store():
    """模拟重启：同一 store 换新 runtime 后仍可查询终态与事件（InMemory 不换实例）。"""
    store = InMemoryRunStore()
    runtime = make_runtime(completed_graph_builder, store)
    result = runtime.invoke(make_request())

    restarted = make_runtime(completed_graph_builder, store)
    status = restarted.get_status(result.run_id)
    assert status is not None
    assert status["status"] == "completed"
    assert [event["event_type"] for event in store.list_events(result.run_id)] == [
        "queued",
        "running",
        "completed",
    ]
