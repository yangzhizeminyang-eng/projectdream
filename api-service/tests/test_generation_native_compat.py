"""生成任务入队快照构建器的原生对照测试（fixture 直调 Node services）。

对照手段（与 ``app/domain/video_generation.py`` 模块 docstring 声明一致）：

- ``tests/fixtures/generate_video_fixtures.mjs`` 在仓库根目录用 Node 直调
  ``server/services/*.mjs`` 纯函数（与 ``enqueueStoryboardVideoJob`` /
  ``enqueueLipSyncJob`` 入队路径同源实现）产出期望 JSON，提交为
  ``tests/fixtures/video_generation_fixtures.json``；本文件逐 case 断言
  Python 复刻输出与 Node 期望逐字段一致（深度相等，无快照漂移）。
- ``buildTwoKeyframeVideoPrompt`` / ``buildReferenceAudioPromptContext`` /
  ``resolveReferenceAudioUrl`` 三个函数实现在 ``server/index.mjs`` 内部，
  import 会启动服务器、fixture 无法直调 → 由本文件的专用用例按 Node 源码
  （index.mjs L8747 / L8762 / L8786）逐字段手工对照锁定。

fixture 再生成命令（仓库根目录）::

    node api-service/tests/fixtures/generate_video_fixtures.mjs

全部离线执行（无 DB / 无网络）。
"""

import json
import re
from pathlib import Path

import pytest

from app.direction_contract import validate_direction
from app.domain.storyboard_ai import sanitize_storyboard_prompt
from app.domain.video_generation import (
    assert_video_model_provider,
    build_color_continuity_constraints,
    build_lip_sync_prompt,
    build_mention_context_prompt,
    build_reference_audio_prompt_context,
    build_referenced_asset_prompt_context,
    build_storyboard_continuity_prompt,
    build_storyboard_direction_prompt,
    build_storyboard_frame_reference,
    build_storyboard_performance_prompt,
    build_storyboard_reference_snapshot,
    build_storyboard_video_prompt_parts,
    build_two_keyframe_video_prompt,
    build_video_continuity_constraints,
    build_video_reference_image_guide,
    has_unified_storyboard_prompt,
    infer_video_candidate_expectations,
    inspect_storyboard_generation_context,
    normalize_storyboard_mention_context,
    resolve_continuity_source_shot_no,
    resolve_lip_sync_duration,
    resolve_dash_scope_lip_sync_duration,
    resolve_reference_audio_url,
    should_use_storyboard_continuity,
    validate_storyboard_reference_snapshot,
)

FIXTURES_PATH = Path(__file__).resolve().parent / "fixtures" / "video_generation_fixtures.json"


def _load_cases() -> list[dict]:
    """读取 Node 生成的 fixture 用例集。

    :returns: fixture case 列表（name/group/input/expected）。
    :raises AssertionError: fixture 文件缺失或结构不符时立即失败。
    """
    assert FIXTURES_PATH.exists(), (
        f"missing {FIXTURES_PATH}; regenerate with: node api-service/tests/fixtures/generate_video_fixtures.mjs"
    )
    data = json.loads(FIXTURES_PATH.read_text(encoding="utf-8"))
    assert isinstance(data.get("cases"), list) and data["cases"], "fixture 文件缺少 cases 数组"
    return data["cases"]


def _snake(name: str) -> str:
    """camelCase → snake_case（fixture input 顶层键 → Python 关键字参数）。

    :param name: Node 侧参数名（camelCase）。
    :returns: Python 侧参数名（snake_case）。
    """
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def _snake_kwargs(payload: dict) -> dict:
    """把 fixture input 的顶层键统一转为 snake_case 关键字。

    :param payload: fixture case 的 input dict。
    :returns: 可直接 ``fn(**kwargs)`` 的参数字典。
    """
    return {_snake(key): value for key, value in (payload or {}).items()}


# group → Python 可调用（入队路径同源函数，签名均为关键字/位置自适应）。
_PY_CALLABLES = {
    "sanitizeStoryboardPrompt": lambda payload: sanitize_storyboard_prompt(
        payload.get("value"), character_names=payload.get("characterNames")
    ),
    "shouldUseStoryboardContinuity": lambda payload: should_use_storyboard_continuity(**_snake_kwargs(payload)),
    "resolveContinuitySourceShotNo": lambda payload: resolve_continuity_source_shot_no(**_snake_kwargs(payload)),
    "buildStoryboardFrameReference": lambda payload: build_storyboard_frame_reference(**_snake_kwargs(payload)),
    "buildStoryboardContinuityPrompt": lambda payload: build_storyboard_continuity_prompt(
        frame_reference=payload.get("frameReference")
    ),
    "normalizeStoryboardMentionContext": lambda payload: normalize_storyboard_mention_context(
        **_snake_kwargs(payload)
    ),
    "buildMentionContextPrompt": lambda payload: build_mention_context_prompt(payload.get("context")),
    "buildStoryboardReferenceSnapshot": lambda payload: build_storyboard_reference_snapshot(**_snake_kwargs(payload)),
    "validateStoryboardReferenceSnapshot": lambda payload: validate_storyboard_reference_snapshot(
        payload.get("snapshot")
    ),
    "hasUnifiedStoryboardPrompt": lambda payload: has_unified_storyboard_prompt(payload.get("prompt")),
    "buildStoryboardVideoPromptParts": lambda payload: build_storyboard_video_prompt_parts(**_snake_kwargs(payload)),
    "buildVideoReferenceImageGuide": lambda payload: build_video_reference_image_guide(**_snake_kwargs(payload)),
    "buildStoryboardDirectionPrompt": lambda payload: build_storyboard_direction_prompt(**_snake_kwargs(payload)),
    "buildStoryboardPerformancePrompt": lambda payload: build_storyboard_performance_prompt(payload.get("input")),
    "buildVideoContinuityConstraints": lambda payload: build_video_continuity_constraints(**_snake_kwargs(payload)),
    "buildColorContinuityConstraints": lambda payload: build_color_continuity_constraints(**_snake_kwargs(payload)),
    "inferVideoCandidateExpectations": lambda payload: infer_video_candidate_expectations(**_snake_kwargs(payload)),
    "buildLipSyncPrompt": lambda payload: build_lip_sync_prompt(**_snake_kwargs(payload)),
    "resolveLipSyncDuration": lambda payload: resolve_lip_sync_duration(**_snake_kwargs(payload)),
    "resolveDashScopeLipSyncDuration": lambda payload: resolve_dash_scope_lip_sync_duration(**_snake_kwargs(payload)),
}

# 断言类 group：Node expected 为 {raised, value}，Python 以异常对照。
_RAISE_GROUPS = {"assertVideoModelProvider"}


def _run_group(group: str, payload: dict):
    """按 group 分发到 Python 复刻并产出与 expected 同构的结果。

    :param group: fixture case 的 group 名（Node 函数名）。
    :param payload: fixture case 的 input dict。
    :returns: 与 fixture expected 同构的值；断言类 group 返回 {raised, value}。
    :raises AssertionError: group 无 Python 映射（防止 fixture 新增组被静默跳过）。
    """
    if group == "assertVideoModelProvider":
        try:
            return {"raised": None, "value": assert_video_model_provider(
                payload.get("modelName"), payload.get("provider")
            )}
        except ValueError as exc:
            return {"raised": str(exc), "value": None}
    if group == "inspectStoryboardGenerationContext":
        # Node/Python 执行时钟不同：checkedAt 不参与对照（fixture 已剥除）。
        report = inspect_storyboard_generation_context(**_snake_kwargs(payload))
        report.pop("checkedAt", None)
        return report
    if group == "validateStoryboardDirectionContract":
        return validate_direction(payload.get("input") or {})
    callable_ = _PY_CALLABLES.get(group)
    assert callable_ is not None, f"fixture group {group} 缺少 Python 映射，请补充 _PY_CALLABLES"
    return callable_(payload)


@pytest.mark.parametrize("case", _load_cases(), ids=lambda case: case["name"])
def test_generation_builder_matches_node_fixture(case):
    """Python 快照构建器输出与 Node fixture 逐字段一致。

    :param case: 单个 fixture 用例（name/group/input/expected）。
    :return: None。
    :raises AssertionError: 任一字段与 Node 期望不一致。
    """
    actual = _run_group(case["group"], case.get("input") or {})
    assert actual == case["expected"], (
        f"fixture {case['name']} (group={case['group']}) 不一致：\n"
        f"  node     = {json.dumps(case['expected'], ensure_ascii=False)}\n"
        f"  python   = {json.dumps(actual, ensure_ascii=False, default=str)}"
    )


def test_fixture_groups_all_have_python_mapping():
    """fixture 中的每个 group 都必须有 Python 映射（防新增组被静默跳过）。

    :return: None。
    """
    cases = _load_cases()
    mapped = set(_PY_CALLABLES) | _RAISE_GROUPS | {"inspectStoryboardGenerationContext", "validateStoryboardDirectionContract"}
    unknown = sorted({case["group"] for case in cases} - mapped)
    assert not unknown, f"fixture 中出现未映射 group：{unknown}"


def test_fixture_covers_enqueue_core_groups():
    """fixture 覆盖硬要求：入队链路核心 group 全部在场。

    :return: None。
    """
    groups = {case["group"] for case in _load_cases()}
    required = {
        "sanitizeStoryboardPrompt",
        "shouldUseStoryboardContinuity",
        "buildStoryboardFrameReference",
        "normalizeStoryboardMentionContext",
        "buildStoryboardReferenceSnapshot",
        "validateStoryboardReferenceSnapshot",
        "buildStoryboardVideoPromptParts",
        "buildStoryboardDirectionPrompt",
        "buildVideoContinuityConstraints",
        "buildColorContinuityConstraints",
        "inspectStoryboardGenerationContext",
        "inferVideoCandidateExpectations",
        "assertVideoModelProvider",
        "buildLipSyncPrompt",
        "resolveLipSyncDuration",
        "resolveDashScopeLipSyncDuration",
    }
    missing = sorted(required - groups)
    assert not missing, f"fixture 缺少入队核心 group：{missing}"


# ---------------------------------------------------------------------------
# index.mjs 内部函数（fixture 不可直调 → 手工对照 Node 源码逐字段锁定）
# ---------------------------------------------------------------------------


def test_two_keyframe_video_prompt_matches_node_manual():
    """buildTwoKeyframeVideoPrompt（index.mjs L8747）手工对照。

    Node 语义：主体 = trim(prompt || startImage.prompt_snapshot || shot.visual_prompt)；
    恒追加「自然发展」句；endPrompt = trim(endImage.prompt_snapshot || shot.end_visual_prompt)
    非空追加「动作终点参考：」；endImage.image_url 非空追加「结束帧已确认」句；空段过滤后空格 join。

    :return: None。
    """
    shot = {"visual_prompt": "固定中景，林知夏转身。", "end_visual_prompt": "林知夏停在屏幕前"}
    assert build_two_keyframe_video_prompt(
        prompt="近景，冷蓝机房。", shot=shot, start_image={"prompt_snapshot": "旧提示"}, end_image={"image_url": "https://media.example.com/end.jpg"}
    ) == (
        "近景，冷蓝机房。 "
        "视频需从起始帧的构图和人物状态自然发展，不切镜头，不新增人物，角色外貌和服装保持一致。 "
        "动作终点参考：林知夏停在屏幕前 "
        "结束帧已确认，请让人物动作、表情和镜头运动朝结束帧描述靠近。"
    )
    # prompt 缺失 → 回退 startImage.prompt_snapshot；end 无快照 → 回退 shot.end_visual_prompt。
    assert build_two_keyframe_video_prompt(prompt="", shot=shot, start_image={"prompt_snapshot": "起始帧快照"}, end_image=None) == (
        "起始帧快照 "
        "视频需从起始帧的构图和人物状态自然发展，不切镜头，不新增人物，角色外貌和服装保持一致。 "
        "动作终点参考：林知夏停在屏幕前"
    )
    # 全空 → 仅剩恒定句。
    assert build_two_keyframe_video_prompt(prompt=None, shot={}, start_image=None, end_image=None) == (
        "视频需从起始帧的构图和人物状态自然发展，不切镜头，不新增人物，角色外貌和服装保持一致。"
    )


def test_reference_audio_prompt_context_matches_node_manual():
    """buildReferenceAudioPromptContext（index.mjs L8762）手工对照。

    Node 语义：仅 voice_locked 且可解析出 URL 的行参与；URL 必须出现在
    referenceAudioUrls 里（决定 <Audio N> 序号）；文案为固定模板；无命中返回空串。

    :return: None。
    """
    rows = [
        {"character_name": "林知夏", "voice_locked": 1, "reference_audio_url": "https://media.example.com/ref-a.wav"},
        {"character_name": "陈默", "voice_locked": 0, "reference_audio_url": "https://media.example.com/ref-b.wav"},
        {"character_name": "旁白", "voice_locked": 1, "reference_audio_url": "https://media.example.com/missing.wav"},
    ]
    urls = ["https://media.example.com/ref-a.wav"]
    assert build_reference_audio_prompt_context(rows, urls) == (
        "官方 Agnes 参考音频绑定：\n"
        "音色@林知夏 使用 <Audio 1>；对白文本必须逐字使用本镜已写入的台词；"
        "人物发声、停顿、重音、情绪和嘴型动作必须与对白时序严格同步，禁止无声说话、错配台词或口型滞后；"
        "官方 Agnes 将参考音频用于声音特征、节奏和情绪参考。"
    )
    assert build_reference_audio_prompt_context(rows, []) == ""
    assert build_reference_audio_prompt_context([], urls) == ""


def test_resolve_reference_audio_url_matches_node_manual():
    """resolveReferenceAudioUrl（index.mjs L8786）手工对照。

    Node 语义：storage_key 优先（含从 COS 域名 URL 反推）→ createSignedUrl 成功即用；
    签名失败/无 key → 保留历史 URL；全空返回空串。

    :return: None。
    """

    def signer(key: str):
        return f"https://cos.example.com/signed/{key}"

    # storage_key 命中签名。
    assert resolve_reference_audio_url(
        {"reference_audio_storage_key": "audio/ref-a.wav", "reference_audio_url": "https://legacy.example.com/a.wav"},
        create_signed_url=signer,
    ) == "https://cos.example.com/signed/audio/ref-a.wav"
    # 无 storage_key 但 URL 是 COS 域名 → 反推 key。
    assert resolve_reference_audio_url(
        {"reference_audio_url": "https://bucket-1250000000.cos.ap-guangzhou.myqcloud.com/audio/ref-b.wav"},
        create_signed_url=signer,
    ) == "https://cos.example.com/signed/audio/ref-b.wav"
    # 签名失败 → 回退历史 URL。
    def broken_signer(_key: str):
        raise RuntimeError("signer down")

    assert resolve_reference_audio_url(
        {"reference_audio_storage_key": "audio/ref-c.wav", "reference_audio_url": "https://legacy.example.com/c.wav"},
        create_signed_url=broken_signer,
    ) == "https://legacy.example.com/c.wav"
    # 无 key、非 COS URL → 原样保留。
    assert resolve_reference_audio_url({"reference_audio_url": " https://legacy.example.com/d.wav "}, create_signed_url=signer) == (
        "https://legacy.example.com/d.wav"
    )
    # 全空 → 空串。
    assert resolve_reference_audio_url({}, create_signed_url=signer) == ""


def test_validate_direction_contract_shape_matches_enqueue_usage():
    """validateStoryboardDirectionContract 形态对照：入队路径消费 passed/blockers/gaze/sound。

    Node enqueueStoryboardVideoJob L2962 消费 ``{passed, blockers, gaze, sound}``；
    gaze/sound 再喂给 buildStoryboardDirectionPrompt 与 videoInspectionExpected。

    :return: None。
    """
    report = validate_direction({
        "durationSeconds": 5,
        "action_text": "林知夏转身看向屏幕",
        "gazePlan": {
            "startTarget": "屏幕",
            "transitions": [{"fromSecond": 0, "toSecond": 5, "target": "屏幕"}],
            "eyeLead": "眼睛先动",
            "endTarget": "屏幕",
        },
        "soundPlan": {"bed": "机房低频底噪", "cues": [], "silencePolicy": "无对白不等于无声"},
    })
    assert report["passed"] is True
    assert report["blockers"] == []
    assert set(report["gaze"]) >= {"transitions", "endTarget", "eyeLead", "promptText"}
    assert set(report["sound"]) >= {"bed", "cues", "silencePolicy", "promptText"}
    # 缺失计划时 gaze/sound 由推断兜底，passed 仍为 True（Node normalizeXxx 同语义）。
    fallback = validate_direction({"durationSeconds": 4, "action_text": "静态镜头"})
    assert fallback["passed"] is True
    assert fallback["gaze"]["transitions"] and fallback["sound"]["bed"]
