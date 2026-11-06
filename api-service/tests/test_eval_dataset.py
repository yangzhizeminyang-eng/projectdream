"""Agent Eval 数据集契约测试。

断言：八类样本齐全且每类 ≥3、样本字段完整、verifier 名全部在 VERIFIERS 注册表、
case_id 前缀与类型对应、pending 样本必须声明 human_review 来源、每条样本都声明
expected_verdict、版本常量非空。
"""

from __future__ import annotations

import pytest

from app.agent.eval.dataset import (
    AGENT_EVAL_CASES,
    EVAL_DATASET_VERSION,
    EvalCase,
    EvalSource,
    EvalType,
    get_cases_by_type,
)
from app.agent.eval.validators import VERIFIERS

# eval_type → case_id 前缀 的约定映射（与 dataset.py 模块 docstring 一致）。
_PREFIX_BY_TYPE: dict[EvalType, str] = {
    EvalType.STORYBOARD_DURATION: "sb-dur-",
    EvalType.ASSET_MENTION: "asset-ref-",
    EvalType.CHARACTER_CONSISTENCY: "char-cons-",
    EvalType.PROMPT_CLASSIFICATION: "prompt-cls-",
    EvalType.ACTION_SOUND_CUES: "action-snd-",
    EvalType.FAILURE_RECOVERY: "fail-rec-",
    EvalType.RAG_CASES: "rag-",
    EvalType.API_COMPATIBILITY: "api-compat-",
}


def test_dataset_version_is_non_empty_string():
    """版本常量必须是非空字符串（样本变更时递增）。

    :return: 无返回值；断言失败即测试失败。
    :raises AssertionError: 版本常量为空或非字符串时抛出。
    """
    assert isinstance(EVAL_DATASET_VERSION, str)
    assert EVAL_DATASET_VERSION.strip()
    assert EVAL_DATASET_VERSION == "v1"


def test_all_eight_types_present_with_min_three_cases():
    """八类样本齐全且每类 ≥3（正反例兼备的最低规模约束）。

    :return: 无返回值。
    :raises AssertionError: 任一类型缺失或样本数 < 3 时抛出。
    """
    for eval_type in EvalType:
        cases = get_cases_by_type(eval_type)
        assert len(cases) >= 3, f"类型 {eval_type.value} 样本数不足 3：{len(cases)}"
    total = len({case.case_id for case in AGENT_EVAL_CASES})
    assert total == len(AGENT_EVAL_CASES), "case_id 存在重复"


def test_case_id_prefix_matches_eval_type():
    """case_id 前缀必须与 eval_type 的约定一一对应（便于人工审阅与过滤）。

    :return: 无返回值。
    :raises AssertionError: 任一样本前缀与类型不匹配时抛出。
    """
    for case in AGENT_EVAL_CASES:
        prefix = _PREFIX_BY_TYPE[case.eval_type]
        assert case.case_id.startswith(prefix), (
            f"样本 {case.case_id}（{case.eval_type.value}）前缀应为 {prefix}"
        )


@pytest.mark.parametrize("case", AGENT_EVAL_CASES, ids=lambda item: item.case_id)
def test_case_fields_complete(case: EvalCase):
    """逐样本断言字段完整：关键字段非空、input/context/expectations 非 None。

    :param case: 数据集中的一条样本。
    :return: 无返回值。
    :raises AssertionError: 字段缺失或为空时抛出。
    """
    assert isinstance(case, EvalCase)
    assert case.case_id.strip()
    assert case.name.strip()
    assert case.verifier.strip()
    assert case.verifier in VERIFIERS, f"样本 {case.case_id} 的校验器未注册：{case.verifier}"
    assert case.input is not None
    assert case.context is not None
    assert case.expectations is not None
    assert isinstance(case.source, EvalSource)
    assert isinstance(case.pending_review, bool)


def test_expectations_declare_expected_verdict():
    """每条样本的 expectations 必须声明 expected_verdict（pass/fail）。

    runner 依据它判定"校验器行为是否符合样本预期"，缺失会导致样本必失败。

    :return: 无返回值。
    :raises AssertionError: 任一样本缺 expected_verdict 或取值非法时抛出。
    """
    for case in AGENT_EVAL_CASES:
        assert isinstance(case.expectations, dict), f"样本 {case.case_id} 的 expectations 应为 dict"
        verdict = case.expectations.get("expected_verdict")
        assert verdict in ("pass", "fail"), (
            f"样本 {case.case_id} 的 expected_verdict 非法：{verdict!r}"
        )


def test_dataset_has_both_pass_and_fail_cases_per_type():
    """每类样本都应同时含预期通过（正例）与预期失败（反例）。

    :return: 无返回值。
    :raises AssertionError: 任一类型只有单侧样本时抛出。
    """
    for eval_type in EvalType:
        verdicts = {
            case.expectations.get("expected_verdict")
            for case in get_cases_by_type(eval_type)
        }
        assert {"pass", "fail"} <= verdicts, f"类型 {eval_type.value} 缺少正例或反例：{verdicts}"


def test_pending_cases_require_human_review_source():
    """pending_review=True 的样本必须声明 human_review 来源（来源区分语义）。

    :return: 无返回值。
    :raises AssertionError: pending 样本的 source 不是 human_review 时抛出。
    """
    pending_cases = [case for case in AGENT_EVAL_CASES if case.pending_review]
    assert pending_cases, "数据集应至少包含 1 条人工复核样本（语义判定边界）"
    for case in pending_cases:
        assert case.source is EvalSource.HUMAN_REVIEW, (
            f"pending 样本 {case.case_id} 的 source 应为 human_review，实际 {case.source}"
        )
        assert case.allowable_error, f"pending 样本 {case.case_id} 应标注 allowable_error（人工抽检说明）"


def test_get_cases_by_type_accepts_string_and_unknown_value():
    """get_cases_by_type 支持字符串入参；未知类型返回空列表。

    :return: 无返回值。
    :raises TypeError: 传入非法类型（如 int）时应抛出。
    :raises AssertionError: 字符串过滤结果与枚举过滤不一致时抛出。
    """
    by_enum = get_cases_by_type(EvalType.STORYBOARD_DURATION)
    by_string = get_cases_by_type("storyboard_duration")
    assert [case.case_id for case in by_enum] == [case.case_id for case in by_string]
    assert get_cases_by_type("no_such_type") == []
    with pytest.raises(TypeError):
        get_cases_by_type(123)  # type: ignore[arg-type]
