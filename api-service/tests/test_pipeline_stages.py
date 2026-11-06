"""8 阶段编排图单元测试。

覆盖：与 Node ``pipeline-stages.mjs`` 逐字一致的映射表与副作用边界、
SCRIPTING 子集、节点名双射、线性透传全流程、InvalidInputError→blocked 直达 END、
waiting_approval 暂停停留 current_stage、以及从 checkpoint 恢复 state 重放
（注入 approvals 后从暂停节点继续执行后续阶段）。
"""

from typing import Any

import pytest

from app.agent.errors import InvalidInputError
from app.agent.pipeline.stages import (
    PIPELINE_STAGES,
    SCRIPTING_STAGE_KEYS,
    build_pipeline_graph,
    node_name_for_stage,
    stage_key_for_node,
)

# 与 server/services/agent/pipeline-stages.mjs 逐字对齐的基准（key/agentKey/label）。
NODE_BASELINE = [
    ("asset-parse", "asset-parser-agent", "资产解析"),
    ("character-lock", "character-agent", "角色锁定"),
    ("scene-lock", "scene-agent", "场景锁定"),
    ("storyboard", "storyboard-agent", "分镜脚本"),
    ("voice", "voice-agent", "音色绑定"),
    ("video", "video-agent", "视频生成"),
    ("quality", "quality-agent", "成片质检"),
    ("delivery", "delivery-agent", "本地导出"),
]

# 副作用边界基准：stage key -> (side_effect, paid, worker_owned)。
SIDE_EFFECT_BASELINE = {
    "asset-parse": ("model_only", False, False),
    "character-lock": ("db_write", False, False),
    "scene-lock": ("db_write", False, False),
    "storyboard": ("model_only", False, False),
    "voice": ("db_write", False, False),
    "video": ("paid_submission", True, True),
    "quality": ("read_only", False, False),
    "delivery": ("worker_submission", False, True),
}


def test_pipeline_stages_match_node_baseline_verbatim():
    """8 阶段的 key/agent_key/label 与 Node 侧逐字一致，顺序也一致。"""
    actual = [(stage.key, stage.agent_key, stage.label_cn) for stage in PIPELINE_STAGES]
    assert actual == NODE_BASELINE


def test_stage_side_effect_boundaries():
    """副作用边界：video 付费且 worker 执行、delivery 归 Worker、其余按声明。"""
    actual = {
        stage.key: (stage.side_effect, stage.paid, stage.worker_owned)
        for stage in PIPELINE_STAGES
    }
    assert actual == SIDE_EFFECT_BASELINE


def test_scripting_stage_keys_is_first_four():
    """SCRIPTING_STAGE_KEYS 等于前 4 个阶段（对应 Node 的 SCRIPTING_PIPELINE_STAGE_KEYS）。"""
    assert SCRIPTING_STAGE_KEYS == frozenset(
        {"asset-parse", "character-lock", "scene-lock", "storyboard"}
    )


def test_node_name_and_stage_key_are_bijective():
    """节点名与 stage key 双射：node_name_for_stage 与 stage_key_for_node 互逆。"""
    for stage in PIPELINE_STAGES:
        node_name = node_name_for_stage(stage.key)
        assert stage_key_for_node(node_name) == stage.key


def test_node_name_mapping_rejects_unknown_key():
    """未知 stage key / 节点名映射时抛 InvalidInputError。"""
    with pytest.raises(InvalidInputError):
        node_name_for_stage("not-a-stage")
    with pytest.raises(InvalidInputError):
        stage_key_for_node("not-a-node")


def test_default_pass_through_graph_runs_all_eight_stages_in_order():
    """空 handler_registry 时透传节点依次跑完 8 节点，stage_results 按序记录。"""
    graph = build_pipeline_graph({})
    output = graph.invoke({"payload": {"projectId": 7}, "project_id": 7})
    assert list(output["stage_results"].keys()) == [stage.key for stage in PIPELINE_STAGES]
    assert all(delta == {} for delta in output["stage_results"].values())
    assert output["current_stage"] == "delivery"


def test_invalid_input_error_maps_blocked_and_skips_remaining_stages():
    """handler 抛 InvalidInputError → 置 blocked 且直达 END，后续节点不执行。"""
    calls: list[str] = []

    def bad_asset_parse(state: dict) -> dict:
        """损坏的资产解析 handler：恒抛 InvalidInputError。

        :param state: 当前图状态。
        :returns: 永不返回。
        :raises InvalidInputError: 每次调用都抛出。
        """
        calls.append("asset-parse")
        raise InvalidInputError("payload 缺少分镜记录")

    graph = build_pipeline_graph({"asset-parse": bad_asset_parse})
    output = graph.invoke({"payload": {}})
    assert calls == ["asset-parse"]
    assert output["status"] == "blocked"
    assert output["error"] == "payload 缺少分镜记录"
    assert list(output["stage_results"].keys()) == ["asset-parse"]


def test_waiting_approval_routes_to_end_and_keeps_current_stage():
    """handler 返回 waiting_approval → 直达 END，current_stage 停留在暂停节点。"""

    def scene_lock_handler(state: dict) -> dict:
        """场景锁定 handler：要求人工审批。

        :param state: 当前图状态。
        :returns: waiting_approval 状态增量。
        """
        return {"status": "waiting_approval"}

    graph = build_pipeline_graph({"scene-lock": scene_lock_handler})
    output = graph.invoke({"payload": {"projectId": 7}})
    assert output["status"] == "waiting_approval"
    assert output["current_stage"] == "scene-lock"
    assert list(output["stage_results"].keys()) == ["asset-parse", "character-lock", "scene-lock"]


@pytest.mark.parametrize("status", ["blocked", "retryable_failed", "failed", "canceled"])
def test_interrupt_statuses_route_to_end(status: str):
    """blocked/retryable_failed/failed/canceled 四态均直达 END，不执行后续节点。"""

    def failing_handler(state: dict) -> dict:
        """voice 阶段 handler：返回受控失败状态。

        :param state: 当前图状态。
        :returns: 携带指定状态与脱敏错误说明的增量。
        """
        return {"status": status, "error": "synthetic"}

    graph = build_pipeline_graph({"voice": failing_handler})
    output = graph.invoke({"payload": {}})
    assert output["status"] == status
    # voice 是第 5 个阶段：其前的 asset-parse/character-lock/scene-lock/storyboard 已执行。
    assert list(output["stage_results"].keys()) == [
        "asset-parse", "character-lock", "scene-lock", "storyboard", "voice",
    ]


def test_resume_from_waiting_approval_replays_from_current_stage():
    """从 checkpoint 恢复 state 重放：注入 approvals 后从暂停节点继续，已越过节点跳过。"""
    calls: list[str] = []

    def counting_handler(stage_key: str):
        """构造带调用计数的 handler 工厂。

        :param stage_key: 阶段键（用于调用记录）。
        :returns: handler 函数。
        """

        def handler(state: dict) -> dict:
            """记录调用并按需要求审批。

            :param state: 当前图状态。
            :returns: scene-lock 未审批时返回 waiting_approval，否则透传空增量。
            """
            calls.append(stage_key)
            if stage_key == "scene-lock" and not (state.get("approvals") or {}).get("scene-lock"):
                return {"status": "waiting_approval"}
            return {}

        return handler

    graph = build_pipeline_graph(
        {
            "asset-parse": counting_handler("asset-parse"),
            "character-lock": counting_handler("character-lock"),
            "scene-lock": counting_handler("scene-lock"),
            "storyboard": counting_handler("storyboard"),
            "voice": counting_handler("voice"),
            "video": counting_handler("video"),
            "quality": counting_handler("quality"),
            "delivery": counting_handler("delivery"),
        }
    )
    # 第一次执行：跑到 scene-lock 等待审批。
    first = graph.invoke({"payload": {"projectId": 7}, "project_id": 7})
    assert first["status"] == "waiting_approval"
    assert first["current_stage"] == "scene-lock"
    assert calls.count("asset-parse") == 1

    # 模拟恢复：从 checkpoint 载入 state（此处直接用第一次输出构造快照语义），
    # 注入审批决定并把状态重置为可继续执行，再重新 invoke 同一张图。
    checkpoint_state: dict[str, Any] = dict(first)
    checkpoint_state["approvals"] = {"scene-lock": {"approved": True}}
    checkpoint_state["status"] = "running"
    second = graph.invoke(checkpoint_state)

    # asset-parse/character-lock 已越过，跳过不重放；scene-lock 从暂停点重放；后续继续。
    assert calls.count("asset-parse") == 1
    assert calls.count("character-lock") == 1
    assert calls.count("scene-lock") == 2
    assert calls.count("storyboard") == 1
    assert calls.count("voice") == 1
    assert calls.count("video") == 1
    assert calls.count("quality") == 1
    assert calls.count("delivery") == 1
    assert second["status"] != "waiting_approval"
    assert list(second["stage_results"].keys()) == [stage.key for stage in PIPELINE_STAGES]
