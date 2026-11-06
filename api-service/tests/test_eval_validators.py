"""Agent Eval 确定性校验器测试。

每类校验器 1-2 组正/反例直接断言，重点覆盖：分镜"首镜头 0 秒"与容差边界、
角色矛盾词表触发、asset_reference 约束不误伤、pending 样本只做结构检查、
RAG 报告缺失时的修复指引、API envelope 错误码约定与 media URL 协议。
"""

from __future__ import annotations

import json
from pathlib import Path

from app.agent.eval.dataset import (
    AGENT_EVAL_CASES,
    EVAL_DATASET_VERSION,
    EvalCase,
    EvalSource,
    EvalType,
)
from app.agent.eval.validators import (
    KNOWN_RECOVERY_SCENARIOS,
    VERIFIERS,
    verify_action_sound_cues,
    verify_api_compatibility,
    verify_asset_mentions,
    verify_character_consistency,
    verify_failure_recovery,
    verify_prompt_classification,
    verify_rag_cases,
    verify_storyboard_duration,
)

# 仓库根目录（tests 位于 {repo}/api-service/tests/ 下，parents[2] 即仓库根）。
_REPO_ROOT = Path(__file__).resolve().parents[2]

# 数据集共享的资产目录快照（与 dataset.py 中 _ASSET_CATALOG 等价，测试内联构造）。
_CATALOG = [
    {"asset_id": "p8-char-linwan", "project_id": 8, "status": "confirmed", "asset_type": "character", "capabilities": ["image", "voice"], "name": "林晚"},
    {"asset_id": "p9-char-shadow", "project_id": 9, "status": "confirmed", "asset_type": "character", "capabilities": ["image", "voice"], "name": "影子客串"},
    {"asset_id": "p8-char-draft-hero", "project_id": 8, "status": "draft", "asset_type": "character", "capabilities": ["image"], "name": "未确认主角"},
    {"asset_id": "p8-video-novoice", "project_id": 8, "status": "confirmed", "asset_type": "video", "capabilities": ["voice"], "name": "无声样片"},
]


def _case_from_dataset(case_id: str) -> EvalCase:
    """按 case_id 从固定数据集取样本。

    :param case_id: 样本 ID。
    :returns: 对应样本。
    :raises LookupError: case_id 不存在时抛出。
    """
    for case in AGENT_EVAL_CASES:
        if case.case_id == case_id:
            return case
    raise LookupError(f"数据集中不存在样本：{case_id}")


def _make_case(case_id: str, eval_type: EvalType, verifier: str, payload: dict) -> EvalCase:
    """构造测试专用的临时样本（不进入固定数据集）。

    :param case_id: 临时样本 ID。
    :param eval_type: 样本类型。
    :param verifier: 校验器名。
    :param payload: 校验器输入。
    :returns: EvalCase 实例。
    """
    return EvalCase(
        case_id=case_id,
        eval_type=eval_type,
        name=f"测试样本 {case_id}",
        verifier=verifier,
        input=payload,
        context={"purpose": "单元测试临时样本"},
        expectations={"expected_verdict": "pass"},
        source=EvalSource.RULE_CHECK,
    )


def _run_dataset_case(verifier_name: str, case_id: str) -> dict:
    """对固定数据集样本执行指定校验器。

    :param verifier_name: 校验器名。
    :param case_id: 样本 ID。
    :returns: 校验器返回的 ``{"passed","failures","details"}``。
    """
    return VERIFIERS[verifier_name](_case_from_dataset(case_id))


def test_verifier_registry_covers_all_eight_types():
    """VERIFIERS 注册表必须恰好注册八个校验器（与八类样本一一对应）。

    :return: 无返回值。
    :raises AssertionError: 注册表缺项或多项时抛出。
    """
    assert set(VERIFIERS) == {
        "verify_storyboard_duration",
        "verify_asset_mentions",
        "verify_character_consistency",
        "verify_prompt_classification",
        "verify_action_sound_cues",
        "verify_failure_recovery",
        "verify_rag_cases",
        "verify_api_compatibility",
    }


# ---------------------------------------------------------------------------
# 一、分镜时长
# ---------------------------------------------------------------------------
def test_storyboard_duration_pass_and_dataset_fail_samples():
    """合法连续覆盖应通过；数据集中的负时长/缺口/超容差反例应失败。

    :return: 无返回值。
    :raises AssertionError: 判定与样本预期不符时抛出。
    """
    passed = _run_dataset_case("verify_storyboard_duration", "sb-dur-01")
    assert passed["passed"] is True
    assert passed["details"]["total_seconds"] == 8.0

    negative = _run_dataset_case("verify_storyboard_duration", "sb-dur-02")
    assert negative["passed"] is False
    assert any("时长非法" in item for item in negative["failures"])

    gap = _run_dataset_case("verify_storyboard_duration", "sb-dur-03")
    assert gap["passed"] is False
    assert any("不连续" in item for item in gap["failures"])

    over = _run_dataset_case("verify_storyboard_duration", "sb-dur-05")
    assert over["passed"] is False
    assert any("总时长" in item for item in over["failures"])


def test_storyboard_duration_first_shot_zero_length_fails():
    """首镜头 end-start==0（0 秒占位镜头）必须判失败。

    :return: 无返回值。
    :raises AssertionError: 判定未失败或文案不符时抛出。
    """
    result = _run_dataset_case("verify_storyboard_duration", "sb-dur-04")
    assert result["passed"] is False
    assert any("时长非法" in item for item in result["failures"])


def test_storyboard_duration_tolerance_boundary():
    """总时长恰好等于目标+容差应通过；再多 0.01s 应失败（容差边界）。

    :return: 无返回值。
    :raises AssertionError: 边界行为与预期不符时抛出。
    """
    shots_at_limit = [
        {"index": 1, "start_seconds": 0.0, "end_seconds": 2.0},
        {"index": 2, "start_seconds": 2.0, "end_seconds": 5.0},
        {"index": 3, "start_seconds": 5.0, "end_seconds": 8.5},
    ]
    at_limit = verify_storyboard_duration(_make_case(
        "sb-dur-tol-at-limit", EvalType.STORYBOARD_DURATION, "verify_storyboard_duration",
        {"shots": shots_at_limit, "target_total_seconds": 8.0, "tolerance_seconds": 0.5},
    ))
    assert at_limit["passed"] is True

    over_limit = verify_storyboard_duration(_make_case(
        "sb-dur-tol-over-limit", EvalType.STORYBOARD_DURATION, "verify_storyboard_duration",
        {
            "shots": [dict(shot) for shot in shots_at_limit[:-1]]
            + [{"index": 3, "start_seconds": 5.0, "end_seconds": 8.51}],
            "target_total_seconds": 8.0,
            "tolerance_seconds": 0.5,
        },
    ))
    assert over_limit["passed"] is False
    assert any("总时长" in item for item in over_limit["failures"])


# ---------------------------------------------------------------------------
# 二、@资产引用
# ---------------------------------------------------------------------------
def test_asset_mentions_pass_and_dataset_fail_samples():
    """全部确认资产应通过；跨项目/draft/能力不匹配反例应失败。

    :return: 无返回值。
    :raises AssertionError: 判定与样本预期不符时抛出。
    """
    passed = _run_dataset_case("verify_asset_mentions", "asset-ref-01")
    assert passed["passed"] is True

    cross_project = _run_dataset_case("verify_asset_mentions", "asset-ref-02")
    assert cross_project["passed"] is False
    assert any("跨项目" in item for item in cross_project["failures"])

    draft = _run_dataset_case("verify_asset_mentions", "asset-ref-03")
    assert draft["passed"] is False
    assert any("状态为 draft" in item for item in draft["failures"])

    capability = _run_dataset_case("verify_asset_mentions", "asset-ref-04")
    assert capability["passed"] is False
    assert any("能力" in item for item in capability["failures"])


def test_asset_mentions_at_reference_mismatch_fails():
    """@名称与资产目录不一致（@了他人名字）必须判失败。

    :return: 无返回值。
    :raises AssertionError: 判定未失败或文案不符时抛出。
    """
    case = _make_case(
        "asset-ref-at-mismatch", EvalType.ASSET_MENTION, "verify_asset_mentions",
        {
            "mentions": [{"asset_id": "p8-char-linwan", "text": "@影子客串 挥手", "purpose": "video"}],
            "asset_catalog": _CATALOG,
            "current_project_id": 8,
        },
    )
    result = verify_asset_mentions(case)
    assert result["passed"] is False
    assert any("@引用" in item for item in result["failures"])


# ---------------------------------------------------------------------------
# 三、角色一致性
# ---------------------------------------------------------------------------
def test_character_consistency_gender_word_conflict_triggers():
    """gender=female 但 appearance/action 含男性矛盾词（男/他）必须触发词表。

    :return: 无返回值。
    :raises AssertionError: 判定未失败或文案不符时抛出。
    """
    result = _run_dataset_case("verify_character_consistency", "char-cons-02")
    assert result["passed"] is False
    assert any("性别矛盾" in item for item in result["failures"])
    assert result["details"]["gender_polarity"] == "female"


def test_character_consistency_age_and_voice_conflicts_fail():
    """年龄组词表冲突（少年 vs 中年）与"有对白无音色"都必须失败。

    :return: 无返回值。
    :raises AssertionError: 判定与样本预期不符时抛出。
    """
    age_conflict = _run_dataset_case("verify_character_consistency", "char-cons-03")
    assert age_conflict["passed"] is False
    assert any("年龄矛盾" in item for item in age_conflict["failures"])

    voice_missing = _run_dataset_case("verify_character_consistency", "char-cons-04")
    assert voice_missing["passed"] is False
    assert any("音色" in item for item in voice_missing["failures"])


def test_character_consistency_asset_reference_constraint_not_flagged():
    """asset_reference 类约束不参与动作矛盾检查（含矛盾词也不误伤）。

    :return: 无返回值。
    :raises AssertionError: 被误伤判失败时抛出。
    """
    passed = _run_dataset_case("verify_character_consistency", "char-cons-01")
    assert passed["passed"] is True

    skipped = _run_dataset_case("verify_character_consistency", "char-cons-05")
    assert skipped["passed"] is True
    assert skipped["details"]["asset_reference_skipped"] == 1


def test_character_consistency_identity_clothing_conflict_fails():
    """identity=学生 搭配 警服（身份-服饰冲突词表）必须失败。

    :return: 无返回值。
    :raises AssertionError: 判定未失败或文案不符时抛出。
    """
    case = _make_case(
        "char-cons-identity-conflict", EvalType.CHARACTER_CONSISTENCY, "verify_character_consistency",
        {
            "character": {
                "gender": "female",
                "age_range": "youth",
                "appearance": "扎马尾的女生",
                "clothing": "深蓝警服",
                "identity": "学生",
                "voice_binding": None,
            },
            "constraints": [],
        },
    )
    result = verify_character_consistency(case)
    assert result["passed"] is False
    assert any("身份矛盾" in item for item in result["failures"])


# ---------------------------------------------------------------------------
# 四、Prompt 分类
# ---------------------------------------------------------------------------
def test_prompt_classification_pass_and_dataset_fail_samples():
    """四类 Prompt 合规应通过；表演动词/丢 mentions/静态描述反例应失败。

    :return: 无返回值。
    :raises AssertionError: 判定与样本预期不符时抛出。
    """
    passed = _run_dataset_case("verify_prompt_classification", "prompt-cls-01")
    assert passed["passed"] is True
    assert set(passed["details"]["kinds_seen"]) == {"prop_asset", "scene_asset", "storyboard_shot", "video_action"}

    performance = _run_dataset_case("verify_prompt_classification", "prompt-cls-02")
    assert performance["passed"] is False
    assert any("表演动词" in item for item in performance["failures"])

    missing_mentions = _run_dataset_case("verify_prompt_classification", "prompt-cls-03")
    assert missing_mentions["passed"] is False
    assert any("mentions" in item for item in missing_mentions["failures"])

    static = _run_dataset_case("verify_prompt_classification", "prompt-cls-04")
    assert static["passed"] is False
    assert any("静态道具描述" in item for item in static["failures"])


def test_prompt_classification_layout_marks_fail():
    """text 含换行乱序标记（连续空行/回车符）必须判失败。

    :return: 无返回值。
    :raises AssertionError: 判定未失败或文案不符时抛出。
    """
    case = _make_case(
        "prompt-cls-layout", EvalType.PROMPT_CLASSIFICATION, "verify_prompt_classification",
        {"prompts": [{"kind": "video_action", "text": "角色转身\r\n\n\n，镜头缓推", "mentions": []}]},
    )
    result = verify_prompt_classification(case)
    assert result["passed"] is False
    assert any("排版乱序" in item for item in result["failures"])


# ---------------------------------------------------------------------------
# 五、动作与声音
# ---------------------------------------------------------------------------
def test_action_sound_cues_structure_pass_and_fail_samples():
    """结构完整应通过；缺 end_state 与 cue 越镜头区间应失败。

    :return: 无返回值。
    :raises AssertionError: 判定与样本预期不符时抛出。
    """
    passed = _run_dataset_case("verify_action_sound_cues", "action-snd-01")
    assert passed["passed"] is True
    assert "semantic_check" not in passed["details"]

    missing_state = _run_dataset_case("verify_action_sound_cues", "action-snd-02")
    assert missing_state["passed"] is False
    assert any("可观察动作要素" in item for item in missing_state["failures"])

    out_of_range = _run_dataset_case("verify_action_sound_cues", "action-snd-03")
    assert out_of_range["passed"] is False
    assert any("超出镜头区间" in item for item in out_of_range["failures"])


def test_action_sound_cues_pending_sample_structure_only_with_semantic_flag():
    """pending 人工复核样本只做结构检查并在 details 标注 semantic_check。

    :return: 无返回值。
    :raises AssertionError: 标注缺失或结构判定不符时抛出。
    """
    case = _case_from_dataset("action-snd-04")
    assert case.pending_review is True
    assert case.source is EvalSource.HUMAN_REVIEW

    result = verify_action_sound_cues(case)
    assert result["passed"] is True
    assert result["details"]["semantic_check"] == "pending_human_review"


def test_action_sound_cues_unknown_kind_fails():
    """声音 cue kind 超出三类合法值必须失败。

    :return: 无返回值。
    :raises AssertionError: 判定未失败或文案不符时抛出。
    """
    case = _make_case(
        "action-snd-bad-kind", EvalType.ACTION_SOUND_CUES, "verify_action_sound_cues",
        {
            "shot_start_seconds": 0.0,
            "shot_end_seconds": 5.0,
            "cues": [{"kind": "narration", "start_seconds": 0.0, "end_seconds": 1.0, "subject": "旁白", "goal": "交代背景", "start_state": "无声", "end_state": "旁白响起"}],
        },
    )
    result = verify_action_sound_cues(case)
    assert result["passed"] is False
    assert any("kind 非法" in item for item in result["failures"])


# ---------------------------------------------------------------------------
# 六、故障恢复
# ---------------------------------------------------------------------------
def test_failure_recovery_known_scenarios_and_registry_constant():
    """已知场景+合法期望结果应通过；KNOWN_RECOVERY_SCENARIOS 必须是六类场景。

    :return: 无返回值。
    :raises AssertionError: 常量与阶段 2 六类场景不符或判定不符时抛出。
    """
    assert KNOWN_RECOVERY_SCENARIOS == frozenset({
        "node_pre_failure",
        "execution_interrupted",
        "provider_created_not_saved",
        "duplicate_callback",
        "worker_restart",
        "checkpoint_mismatch",
    })
    passed = _run_dataset_case("verify_failure_recovery", "fail-rec-01")
    assert passed["passed"] is True


def test_failure_recovery_unknown_scenario_and_invalid_outcome_fail():
    """未知场景名与非法 expected_outcome（自由文本）都必须失败。

    :return: 无返回值。
    :raises AssertionError: 判定与样本预期不符时抛出。
    """
    unknown = _run_dataset_case("verify_failure_recovery", "fail-rec-02")
    assert unknown["passed"] is False
    assert any("未知恢复场景名" in item for item in unknown["failures"])

    invalid = _run_dataset_case("verify_failure_recovery", "fail-rec-03")
    assert invalid["passed"] is False
    assert any("expected_outcome 非法" in item for item in invalid["failures"])


# ---------------------------------------------------------------------------
# 七、RAG 检索
# ---------------------------------------------------------------------------
def test_rag_cases_phase4_report_passes():
    """阶段 4 报告（cleaned_snapshot.summary 六键齐全、leak_count=1）应通过。

    :return: 无返回值。
    :raises FileNotFoundError: 仓库缺少阶段 4 报告时由样本判定失败暴露。
    :raises AssertionError: 判定未通过时抛出。
    """
    assert (_REPO_ROOT / "artifacts" / "phase4-retrieval-eval.json").exists(), (
        "阶段 4 报告 artifacts/phase4-retrieval-eval.json 应存在于仓库根"
    )
    result = _run_dataset_case("verify_rag_cases", "rag-01")
    assert result["passed"] is True, result["failures"]
    assert result["details"]["summary_source"] == "report_file"
    assert result["details"]["leak_count"] == 1


def test_rag_cases_leak_over_limit_fails():
    """leak_count=99（远超设计内上限 1）必须失败。

    :return: 无返回值。
    :raises AssertionError: 判定未失败或文案不符时抛出。
    """
    result = _run_dataset_case("verify_rag_cases", "rag-02")
    assert result["passed"] is False
    assert any("超过设计内暴露上限" in item for item in result["failures"])


def test_rag_cases_missing_report_file_fails_with_guidance():
    """报告文件缺失必须失败且 failures 给出修复指引。

    :return: 无返回值。
    :raises AssertionError: 判定未失败或缺少指引时抛出。
    """
    result = _run_dataset_case("verify_rag_cases", "rag-03")
    assert result["passed"] is False
    assert any("修复指引" in item for item in result["failures"])


def test_rag_cases_missing_metric_keys_fail(tmp_path: Path):
    """summary 缺少六键中的任意键必须失败（构造缺 empty_rate 的报告）。

    :param tmp_path: pytest 临时目录。
    :return: 无返回值。
    :raises AssertionError: 判定未失败或文案不符时抛出。
    """
    report_path = tmp_path / "summary-missing.json"
    report_path.write_text(
        json.dumps({"cleaned_snapshot": {"summary": {
            "recall_at_k": 0.75, "mrr": 0.7, "leak_count": 0,
            "latency_p50_ms": 0.1, "latency_p95_ms": 0.2,
        }}}),
        encoding="utf-8",
    )
    case = _make_case(
        "rag-missing-keys", EvalType.RAG_CASES, "verify_rag_cases",
        {"rag_report_path": str(report_path)},
    )
    result = verify_rag_cases(case)
    assert result["passed"] is False
    assert any("缺少指标键" in item for item in result["failures"])


# ---------------------------------------------------------------------------
# 八、API 兼容
# ---------------------------------------------------------------------------
def test_api_compatibility_pass_including_401_4010_exception():
    """合法 envelope 应通过，且 401↔4010 特例被允许。

    :return: 无返回值。
    :raises AssertionError: 判定与样本预期不符时抛出。
    """
    passed = _run_dataset_case("verify_api_compatibility", "api-compat-01")
    assert passed["passed"] is True


def test_api_compatibility_dataset_fail_samples():
    """缺 data 键、401 与 code 不匹配、media URL 协议非法反例都必须失败。

    :return: 无返回值。
    :raises AssertionError: 判定与样本预期不符时抛出。
    """
    missing_data = _run_dataset_case("verify_api_compatibility", "api-compat-02")
    assert missing_data["passed"] is False
    assert any("缺少键" in item for item in missing_data["failures"])

    mismatch = _run_dataset_case("verify_api_compatibility", "api-compat-03")
    assert mismatch["passed"] is False
    assert any("不匹配" in item for item in mismatch["failures"])

    bad_url = _run_dataset_case("verify_api_compatibility", "api-compat-04")
    assert bad_url["passed"] is False
    assert any("media URL 非法" in item for item in bad_url["failures"])


def test_api_compatibility_relative_media_url_allowed():
    """media URL 以相对 / 开头应被允许（合法形态补充覆盖）。

    :return: 无返回值。
    :raises AssertionError: 相对路径被误判失败时抛出。
    """
    case = _make_case(
        "api-compat-relative-url", EvalType.API_COMPATIBILITY, "verify_api_compatibility",
        {
            "samples": [{
                "path": "/api/videos/12",
                "method": "GET",
                "expected_status": 200,
                "expected_envelope": {"code": 0, "message": "success", "data": {"video_url": "/media/v12.mp4"}},
            }],
        },
    )
    result = verify_api_compatibility(case)
    assert result["passed"] is True


def test_dataset_version_referenced_by_validators_import():
    """导入健全性：数据集版本与样本数量满足最低规模（32 条 = 8 类下限之和）。

    :return: 无返回值。
    :raises AssertionError: 样本规模不足时抛出。
    """
    assert EVAL_DATASET_VERSION
    assert len(AGENT_EVAL_CASES) >= 8 * 3
