"""幂等键构造与反解析单元测试。

覆盖：统一格式、反解析 round-trip、同一业务重试构造同键、
不同 project/stage/business_ref 键不同、business_ref 含 ":" 的拒绝。
"""

import pytest

from app.agent.errors import InvalidInputError
from app.agent.pipeline.idempotency import build_idempotency_key, parse_idempotency_key


def test_build_idempotency_key_with_stage():
    """含 stage_key 时构造出四段键。"""
    key = build_idempotency_key(
        task_type="storyboard_pipeline",
        project_id=8,
        stage_key="video",
        business_ref="sb-42",
    )
    assert key == "storyboard_pipeline:p8:video:sb-42"


def test_build_idempotency_key_without_stage():
    """stage_key 为 None 时构造出三段键。"""
    key = build_idempotency_key(
        task_type="storyboard_pipeline", project_id=8, stage_key=None, business_ref="ep-12"
    )
    assert key == "storyboard_pipeline:p8:ep-12"


def test_same_business_retry_builds_same_key():
    """同一业务重试（相同四要素）构造出同一个键。"""
    kwargs = {
        "task_type": "storyboard_pipeline",
        "project_id": 8,
        "stage_key": "video",
        "business_ref": "sb-42",
    }
    assert build_idempotency_key(**kwargs) == build_idempotency_key(**kwargs)


@pytest.mark.parametrize(
    ("left", "right"),
    [
        ({"project_id": 8}, {"project_id": 9}),
        ({"stage_key": "video"}, {"stage_key": "voice"}),
        ({"business_ref": "sb-42"}, {"business_ref": "sb-43"}),
        ({"task_type": "storyboard_pipeline"}, {"task_type": "delivery_pipeline"}),
    ],
)
def test_different_business_dims_build_different_keys(left, right):
    """不同 project/stage/business_ref/task_type 必然得到不同键。"""
    base = {"task_type": "storyboard_pipeline", "project_id": 8, "stage_key": "video", "business_ref": "sb-42"}

    def build(overrides: dict) -> str:
        """按覆盖项构造幂等键。

        :param overrides: 覆盖默认四要素的键值。
        :returns: 幂等键字符串。
        """
        merged = {**base, **overrides}
        return build_idempotency_key(**merged)

    assert build(left) != build(right)


def test_parse_idempotency_key_round_trip():
    """反解析 round-trip：build 后 parse 得到相同组成字段。"""
    key = build_idempotency_key(
        task_type="storyboard_pipeline", project_id=8, stage_key="scene-lock", business_ref="sb-42"
    )
    parsed = parse_idempotency_key(key)
    assert parsed == {
        "task_type": "storyboard_pipeline",
        "project_id": 8,
        "stage_key": "scene-lock",
        "business_ref": "sb-42",
    }


def test_parse_idempotency_key_without_stage_returns_none_stage():
    """三段键反解析时 stage_key 为 None。"""
    parsed = parse_idempotency_key("storyboard_pipeline:p8:ep-12")
    assert parsed["stage_key"] is None
    assert parsed["project_id"] == 8
    assert parsed["business_ref"] == "ep-12"


@pytest.mark.parametrize(
    "key",
    [
        "",
        "no-separator",
        "a:b",  # 段数不足
        "a:p8:video:extra:sb-1",  # 段数超限
        "a::video:sb-1",  # 空段
        "a:p8::sb-1",  # 空 stage 段
        "a:8:video:sb-1",  # project 段缺 p 前缀
        "a:p0:video:sb-1",  # project_id 必须为正整数
        "a:p8x:video:sb-1",  # project 段非法
    ],
)
def test_parse_idempotency_key_rejects_malformed(key: str):
    """格式不符的反解析一律抛 InvalidInputError。"""
    with pytest.raises(InvalidInputError):
        parse_idempotency_key(key)


def test_build_rejects_colon_in_business_ref():
    """business_ref 含 ":" 会被拒绝（防反解析歧义）。"""
    with pytest.raises(InvalidInputError):
        build_idempotency_key(
            task_type="storyboard_pipeline", project_id=8, stage_key="video", business_ref="sb:42"
        )


def test_build_rejects_blank_business_ref_and_bad_task_type():
    """business_ref 空白、task_type 为空/含 ":" 均拒绝。"""
    with pytest.raises(InvalidInputError):
        build_idempotency_key(
            task_type="storyboard_pipeline", project_id=8, stage_key=None, business_ref="  "
        )
    with pytest.raises(InvalidInputError):
        build_idempotency_key(
            task_type="", project_id=8, stage_key=None, business_ref="sb-42"
        )
    with pytest.raises(InvalidInputError):
        build_idempotency_key(
            task_type="bad:type", project_id=8, stage_key=None, business_ref="sb-42"
        )


def test_build_rejects_non_positive_project_id():
    """project_id 非正整数时拒绝。"""
    with pytest.raises(InvalidInputError):
        build_idempotency_key(
            task_type="storyboard_pipeline", project_id=0, stage_key=None, business_ref="sb-42"
        )


def test_build_rejects_oversized_key():
    """拼接结果超过 160 字符（幂等键列宽）时拒绝。"""
    with pytest.raises(InvalidInputError):
        build_idempotency_key(
            task_type="storyboard_pipeline",
            project_id=8,
            stage_key=None,
            business_ref="x" * 160,
        )
