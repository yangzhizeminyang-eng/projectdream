"""frameCharacterContext 复刻对照测试（FastAPI-Only 迁移第三阶段第三组 · 任务 A）。

期望值来自 Node 真实实现（``server/services/frame-character-consistency.mjs``），
由一次性脚本 ``tests/fixtures/generate_frame_fixtures.mjs`` 生成并提交为
``tests/fixtures/frame_character_fixtures.json``。pytest 只读该 JSON，
不在运行期调用 Node（CI 零 Node 依赖）。

fixture 再生成命令（仓库根目录）::

    node api-service/tests/fixtures/generate_frame_fixtures.mjs
"""

import json
from pathlib import Path

import pytest

from app.domain.frame_character import (
    build_frame_consistency_prompt,
    create_frame_character_snapshot,
    resolve_frame_character_context,
)

FIXTURES_PATH = Path(__file__).resolve().parent / "fixtures" / "frame_character_fixtures.json"


def _load_cases() -> list[dict]:
    """读取 Node 生成的 fixture 用例集。

    :returns: 用例列表（name/description/storyboard/characters/expected）。
    """
    with FIXTURES_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)["cases"]


CASES = _load_cases()
CASE_NAMES = [case["name"] for case in CASES]


@pytest.mark.parametrize("case", CASES, ids=CASE_NAMES)
def test_frame_character_context_matches_node_fixture(case):
    """Python resolve_frame_character_context 输出与 Node fixture 逐字段一致。

    :param case: 单个 fixture 用例（含 storyboard/characters/expected）。
    :return: None。
    """
    result = resolve_frame_character_context(case["storyboard"], case["characters"])
    assert result == case["expected"], (
        f"fixture {case['name']} 不一致：\n"
        f"python = {json.dumps(result, ensure_ascii=False)}\n"
        f"node   = {json.dumps(case['expected'], ensure_ascii=False)}"
    )


def test_frame_character_fixture_covers_required_shapes():
    """fixture 形态覆盖硬要求：≥8 种形态且含关键类别。"""
    assert len(CASES) >= 8
    required = {
        "empty_storyboard_no_characters",
        "single_character_confirmed",
        "audio_only_identity_screen_mention",
        "explicit_offscreen_voiceover",
        "missing_reference_image",
        "multiple_characters_same_frame",
        "unmatched_character_name",
    }
    assert required.issubset(set(CASE_NAMES))


def test_frame_character_context_ready_case_is_primary():
    """单角色已确认形态：ready=True 且 primaryCharacterId 指向命中角色。"""
    case = next(item for item in CASES if item["name"] == "single_character_confirmed")
    result = resolve_frame_character_context(case["storyboard"], case["characters"])
    assert result["ready"] is True
    assert result["primaryCharacterId"] == 9
    assert result["characters"][0]["isPrimary"] is True


def test_frame_character_snapshot_shape_matches_node_contract():
    """createFrameCharacterSnapshot：字段齐全、参考图二选一落键（Node 契约）。"""
    context = resolve_frame_character_context(
        {"character_name": "林知夏"},
        [{
            "id": 9, "name": "林知夏", "role_tag": "主角", "gender": "female",
            "age_group": "young_adult", "appearance": "黑色短发",
            "reference_image_url": "https://media.example.com/9.png",
        }],
    )
    snapshot = create_frame_character_snapshot(context)
    assert snapshot["version"] == 1
    assert snapshot["primaryCharacterId"] == 9
    assert snapshot["characterFree"] is False
    character = snapshot["characters"][0]
    assert "referenceImageUrl" in character
    assert "referenceImageStorageKey" not in character
    assert character["isPrimary"] is True


def test_frame_consistency_prompt_includes_character_constraints():
    """buildFrameConsistencyPrompt：无参考图角色不产出参考图序号，负向词含一致性禁用词。"""
    context = resolve_frame_character_context(
        {"character_name": "林知夏"},
        [{
            "id": 9, "name": "林知夏", "role_tag": "主角", "gender": "female",
            "age_group": "young_adult", "appearance": "黑色短发",
        }],
    )
    result = build_frame_consistency_prompt(
        prompt="固定中景",
        negative_prompt="模糊",
        storyboard={"character_name": "林知夏", "action_text": "林知夏站着"},
        context=context,
        project_visual_style="电影感写实风格",
    )
    assert "【角色一致性硬约束】" in result["prompt"]
    assert "性别=女性" in result["prompt"]
    assert result["referenceImageUrls"] == []
    assert "gender swap" in result["negativePrompt"]
    assert "模糊" in result["negativePrompt"]


def test_frame_consistency_prompt_uses_stable_key_without_capturing_signed_url():
    context = resolve_frame_character_context(
        {"character_name": "林知夏"},
        [{
            "id": 9, "name": "林知夏", "role_tag": "主角", "gender": "female",
            "age_group": "young_adult", "appearance": "黑色短发",
            "reference_image_url": None,
            "reference_image_storage_key": "characters/9/v2-approved.png",
        }],
    )

    result = build_frame_consistency_prompt(storyboard={"character_name": "林知夏"}, context=context)

    assert result["referenceImageStorageKeys"] == ["characters/9/v2-approved.png"]
    assert result["referenceImageUrls"] == []
