"""runtime 对 LangGraph 编译图的自动适配测试。

阶段 2 发现：LangGraph 1.2 编译图（CompiledStateGraph）不可直接调用，
只能 ``.invoke(state)``。runtime 现在统一适配该形态，业务图 builder
可以直接返回编译图，无需自行包 lambda。本文件锁定该契约。
"""

from __future__ import annotations

import pytest

from app.agent.errors import InvalidInputError
from app.agent.model_provider import FakeStoryboardReviewProvider
from app.agent.quality.graph import build_storyboard_quality_graph
from app.agent.run_store import InMemoryRunStore
from app.agent.runtime import AgentRuntime
from app.agent.schemas import AgentRequest


def _request(idempotency_key: str) -> AgentRequest:
    """构造一个指向质量分析图的最小请求。

    :param idempotency_key: 幂等键。
    :return: AgentRequest 实例。
    """
    return AgentRequest(
        project_id=5,
        task_type="storyboard_quality",
        payload={
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
        },
        idempotency_key=idempotency_key,
    )


def test_runtime_accepts_compiled_langgraph_graph_directly() -> None:
    """graph_builder 直接返回编译图时 runtime 能自动适配并完成执行。

    :return: 无返回值。
    :raises AssertionError: 适配失败或结果状态不符时抛出。
    """
    runtime = AgentRuntime(
        provider=FakeStoryboardReviewProvider(),
        store=InMemoryRunStore(),
        graph_builder=lambda provider: build_storyboard_quality_graph(
            provider, enable_model_review=False
        ),
    )

    result = runtime.invoke(_request("storyboard-quality:p5:storyboard:31"))

    assert result.status == "completed"
    assert result.validated_output is not None
    assert result.validated_output["asset_reference"]["passed"] is True


def test_runtime_compiled_graph_idempotent_replay() -> None:
    """编译图接入 runtime 后幂等语义保持：同键重放不重复执行。

    :return: 无返回值。
    :raises AssertionError: 二次调用产生不同 run 时抛出。
    """
    runtime = AgentRuntime(
        provider=FakeStoryboardReviewProvider(),
        store=InMemoryRunStore(),
        graph_builder=lambda provider: build_storyboard_quality_graph(
            provider, enable_model_review=False
        ),
    )
    request = _request("storyboard-quality:p5:storyboard:31")

    first = runtime.invoke(request)
    second = runtime.invoke(request)

    assert first.run_id == second.run_id
    assert second.status == "completed"


def test_runtime_without_graph_builder_blocks_unknown_task() -> None:
    """未注入 graph_builder 时未知 task_type 映射 blocked。

    :return: 无返回值。
    :raises AssertionError: 状态不是 blocked 时抛出。
    """
    runtime = AgentRuntime(provider=FakeStoryboardReviewProvider(), store=InMemoryRunStore())
    request = _request("storyboard-quality:p5:storyboard:32").model_copy(
        update={"task_type": "storyboard_quality"}
    )

    result = runtime.invoke(request)

    assert result.status == "blocked"
    assert isinstance(result.blockers, list)


def test_runtime_graph_builder_invalid_input_maps_blocked() -> None:
    """图内 InvalidInputError 由 runtime 映射为 blocked（编译图路径）。

    :return: 无返回值。
    :raises InvalidInputError: 未注册编排图时（本测试已注册，不应触发）。
    """
    runtime = AgentRuntime(
        provider=FakeStoryboardReviewProvider(),
        store=InMemoryRunStore(),
        graph_builder=lambda provider: build_storyboard_quality_graph(
            provider, enable_model_review=False
        ),
    )
    request = AgentRequest(
        project_id=5,
        task_type="storyboard_quality",
        payload={"not_storyboard": True},
        idempotency_key="storyboard-quality:p5:storyboard:33",
    )

    result = runtime.invoke(request)

    assert result.status == "blocked"
