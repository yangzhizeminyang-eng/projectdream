"""分镜质量 LangGraph 编排图测试。

覆盖：纯规则成功路径、模型复核成功与 ModelOutputError 路径、
payload 非法 blocked 路径、规则 blocker 透传与模型复核跳过逻辑。
图不 import 运行时模块，provider 由本地 Fake 注入，零付费外部调用。
"""

from __future__ import annotations

import json

from app.agent.errors import ModelOutputError
from app.agent.quality.graph import (
    StoryboardReviewIssue,
    StoryboardReviewVerdict,
    build_storyboard_quality_graph,
)


class FakeStoryboardReviewProvider:
    """测试用 Fake provider：记录调用并按预设返回结论或抛出异常。

    :param verdict: complete_structured 的预设返回值（None 时返回默认通过结论）。
    :param error: 非 None 时在调用时抛出该异常，用于模拟模型输出不可解析。
    """

    def __init__(
        self,
        verdict: StoryboardReviewVerdict | None = None,
        error: Exception | None = None,
    ) -> None:
        self.verdict = verdict
        self.error = error
        self.calls: list[dict] = []

    def complete_structured(self, *, system: str, user: str, schema_model: type) -> StoryboardReviewVerdict:
        """模拟结构化输出调用。

        :param system: 系统提示词。
        :param user: 用户负载（JSON 字符串）。
        :param schema_model: 期望的输出 schema。
        :return: 预设的结论模型实例；未预设时返回“通过”的空结论。
        :raises Exception: 构造时注入了 error 时原样抛出。
        """
        self.calls.append({"system": system, "user": user, "schema_model": schema_model})
        if self.error is not None:
            raise self.error
        if self.verdict is not None:
            return self.verdict
        return schema_model(overall_pass=True, issues=[])


def _good_payload() -> dict:
    """构造可通过全部规则检查的标准分镜负载。

    :return: 含完整资产引用、公网图片资产与音色绑定的 payload dict。
    """
    return {
        "storyboard": {
            "id": 21,
            "visualPrompt": "中景，陈默站在时间裂缝前，镜头缓慢推进",
            "shotType": "中景",
            "cameraAngle": "平视",
            "dialogueText": "陈默：别过来。",
            "asset_reference_json": json.dumps({
                "characterId": 9,
                "characterVersionNo": 2,
                "characterViewSetVersion": 1,
                "characterViewKeys": ["front", "side", "back"],
                "characterBaseImageId": 71,
                "characterBaseVersionNo": 1,
                "characterFaceImageId": 72,
                "characterFaceVersionNo": 1,
                "sceneAssetId": 10,
                "scenePanoramaVersion": 3,
            }),
        },
        "assets": [
            {"id": 1, "label": "时间裂缝", "status": "confirmed", "imageUrl": "https://cdn.test/scene.png"}
        ],
        "characterVoices": [{"characterName": "陈默", "voiceProfileKey": "male-calm"}],
    }


def test_graph_completes_rule_only_review_without_model_call():
    """enable_model_review=False 时规则通过即完成，且不触发模型调用。

    :return: 无返回值。
    :raises AssertionError: 状态、validated_output 结构或调用次数不符时抛出。
    """
    provider = FakeStoryboardReviewProvider()
    graph = build_storyboard_quality_graph(provider, enable_model_review=False)

    state = graph.invoke({"payload": _good_payload()})

    assert state["status"] == "completed"
    # LangGraph 对未写入的 state 键不会出现在输出里，成功路径 error 未写，用 get 断言。
    assert state.get("error") is None
    assert state["blockers"] == []
    output = state["validated_output"]
    assert set(output) == {"asset_reference", "generation_context", "model_review"}
    assert output["asset_reference"]["passed"] is True
    assert output["generation_context"]["passed"] is True
    assert output["model_review"] is None
    assert provider.calls == []


def test_graph_merges_model_blockers_into_state():
    """启用模型复核时：schema 结论进入 validated_output，blocker 级问题并入 blockers。

    :return: 无返回值。
    :raises AssertionError: 合并结果或调用参数不符时抛出。
    """
    verdict = StoryboardReviewVerdict(
        overall_pass=False,
        issues=[
            StoryboardReviewIssue(code="model-composition-risk", message="构图冲突，建议调整机位", severity="blocker"),
            StoryboardReviewIssue(code="model-pacing-hint", message="动作节奏偏快", severity="warning"),
        ],
    )
    provider = FakeStoryboardReviewProvider(verdict=verdict)
    graph = build_storyboard_quality_graph(provider, enable_model_review=True)

    state = graph.invoke({"payload": _good_payload()})

    assert state["status"] == "completed"
    assert [item["code"] for item in state["blockers"]] == ["model-composition-risk"]
    assert state["validated_output"]["model_review"]["overall_pass"] is False
    assert len(state["validated_output"]["model_review"]["issues"]) == 2
    assert len(provider.calls) == 1
    assert provider.calls[0]["schema_model"] is StoryboardReviewVerdict
    assert state["usage"] == {"model_calls": 1}


def test_graph_marks_unparseable_model_output_retryable():
    """模型输出不可解析（ModelOutputError）时置 retryable_failed 并保留规则结果。

    :return: 无返回值。
    :raises AssertionError: 状态或 validated_output 不符时抛出。
    """
    provider = FakeStoryboardReviewProvider(error=ModelOutputError("模型输出解析失败"))
    graph = build_storyboard_quality_graph(provider, enable_model_review=True)

    state = graph.invoke({"payload": _good_payload()})

    assert state["status"] == "retryable_failed"
    assert state["error"] == "模型输出解析失败"
    assert state["validated_output"]["asset_reference"]["passed"] is True
    assert state["validated_output"]["generation_context"]["passed"] is True
    assert state["validated_output"]["model_review"] is None


def test_graph_rejects_payload_without_storyboard_as_blocked():
    """payload 缺少 dict 类型 storyboard 时置 blocked，validated_output 为 None。

    :return: 无返回值。
    :raises AssertionError: 状态或错误说明不符时抛出。
    """
    provider = FakeStoryboardReviewProvider()
    graph = build_storyboard_quality_graph(provider, enable_model_review=True)

    blocked_missing = graph.invoke({"payload": {}})
    blocked_wrong_type = graph.invoke({"payload": {"storyboard": 42}})

    assert blocked_missing["status"] == "blocked"
    assert "storyboard" in blocked_missing["error"]
    assert blocked_missing["validated_output"] is None
    assert blocked_wrong_type["status"] == "blocked"
    assert blocked_wrong_type["validated_output"] is None
    # blocked 路径不应触发任何模型调用。
    assert provider.calls == []


def test_graph_keeps_rule_blockers_and_skips_model_review():
    """规则未通过时 blockers 透传到最终状态，且即使启用复核也不调用模型。

    :return: 无返回值。
    :raises AssertionError: blockers 内容或调用次数不符时抛出。
    """
    provider = FakeStoryboardReviewProvider()
    graph = build_storyboard_quality_graph(provider, enable_model_review=True)

    state = graph.invoke({"payload": {"storyboard": {"id": 1, "character_id": 9}}})

    assert state["status"] == "completed"
    blocker_codes = {item["code"] for item in state["blockers"]}
    assert "character-version-reference-missing" in blocker_codes
    assert "scene-panorama-reference-missing" in blocker_codes
    assert state["validated_output"]["asset_reference"]["passed"] is False
    assert state["validated_output"]["model_review"] is None
    assert provider.calls == []


def test_graph_honors_require_flags_from_state():
    """状态中的 require_character / require_scene 开关能正确传入规则层。

    :return: 无返回值。
    :raises AssertionError: 开关未生效时抛出。
    """
    provider = FakeStoryboardReviewProvider()
    graph = build_storyboard_quality_graph(provider, enable_model_review=False)
    scene_only_reference = {
        "storyboard": {
            "id": 22,
            "visualPrompt": "空镜推进",
            "asset_reference_json": json.dumps({
                "sceneAssetId": 10,
                "scenePanoramaVersion": 3,
            }),
        },
    }

    # scene_only_reference 本身就是合法 payload（含 storyboard 键），
    # require_character 作为 state 开关与 payload 平级传入。
    state = graph.invoke({"payload": scene_only_reference, "require_character": False})

    assert state["status"] == "completed"
    assert state["blockers"] == []
    assert state["validated_output"]["asset_reference"]["passed"] is True
