"""分镜质检规则与 Node ``quality-gate.test.mjs`` 样例的跨语言兼容测试。

遍历 :mod:`app.agent.quality.fixtures` 中的全部 fixture（Node 17 个测试场景的
结构化转译 + 4 个对抗样例），断言 Python 复刻版的 passed / blocker codes /
warning codes / reference 字段 / summary 文案与 Node 期望一致。
"""

from __future__ import annotations

import re

import pytest

from app.agent.quality.fixtures import FIXTURES
from app.agent.quality.rules import (
    inspect_generated_video_result,
    inspect_storyboard_asset_reference_gate,
    inspect_storyboard_generation_context,
)

# fixture.kind -> 规则函数的映射。
_RULE_FUNCTIONS = {
    "asset_reference": inspect_storyboard_asset_reference_gate,
    "generation_context": inspect_storyboard_generation_context,
    "video_result": inspect_generated_video_result,
}

# JS toISOString 形如 2026-10-16T08:00:00.123Z（毫秒精度 + Z）。
_ISO_UTC_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda item: item["name"])
def test_quality_rules_match_node_expectations(fixture):
    """逐条断言 Python 规则输出与 Node 测试期望一致。

    :param fixture: fixtures.FIXTURES 中的一条样例（含入参与期望）。
    :return: 无返回值；断言失败即测试失败。
    :raises AssertionError: 任一期望不满足时由 pytest 抛出。
    """
    func = _RULE_FUNCTIONS[fixture["kind"]]
    report = func(**fixture["kwargs"])

    assert report["passed"] is fixture["expected_passed"], report["summary"]
    assert {item["code"] for item in report["blockers"]} == set(fixture["expected_blocker_codes"])
    if "warnings" in report:
        assert {item["code"] for item in report["warnings"]} == set(fixture["expected_warning_codes"])

    # 每个问题条目结构与 Node issue() 同构，且 severity 与所在集合一致。
    for item in report["blockers"]:
        assert set(item) == {"code", "message", "severity"}
        assert item["severity"] == "blocker"
        assert item["message"]
    for item in report.get("warnings", []):
        assert set(item) == {"code", "message", "severity"}
        assert item["severity"] == "warning"

    # 可选的 reference 字段子集断言（Node 测试中显式检查过的字段）。
    for key, expected in fixture.get("expected_reference_items", {}).items():
        assert report["reference"][key] == expected

    fragment = fixture.get("expected_summary_fragment")
    if fragment:
        assert fragment in report["summary"]

    if "checkedAt" in report:
        assert _ISO_UTC_PATTERN.match(report["checkedAt"])


def test_asset_gate_tolerates_none_storyboard_like_node_defaults():
    """Node 侧允许缺省入参；Python 版对 None/空 dict 也应返回空引用报告。

    :return: 无返回值；断言失败即测试失败。
    :raises AssertionError: 默认行为与 Node 语义不符时抛出。
    """
    report = inspect_storyboard_asset_reference_gate({})

    assert report["passed"] is False
    assert report["reference"] == {}
    assert report["summary"] == "资产引用门禁未通过：8 个问题需要处理"


def test_video_result_accepts_missing_items_list():
    """items 传 None 时按空列表处理，等价 Node 的 ``{ items = [] } = {}`` 缺省。

    :return: 无返回值。
    :raises AssertionError: 行为与 Node 语义不符时抛出。
    """
    report = inspect_generated_video_result(None)

    assert report["passed"] is False
    assert [item["code"] for item in report["blockers"]] == ["video-result-missing"]
    assert [item["code"] for item in report["warnings"]] == ["video-candidate-count-short"]
