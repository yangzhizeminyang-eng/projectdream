"""检索质量指标测试：Recall@K、MRR、空结果率、跨项目泄漏与延迟分位的精确验证。"""

import pytest

import app.retrieval_eval as retrieval_eval
from app.retrieval_eval import evaluate_retrieval_metrics


def _case(case_id: str, *, project_id: int = 21, expect=None, forbid=None, case_type: str = "positive") -> dict:
    """构造最小评测样本。

    :param case_id: 样本 ID。
    :param project_id: 项目 ID。
    :param expect: 期望命中资产列表。
    :param forbid: 禁止资产列表。
    :param case_type: 场景类型。
    :return: case 字典。
    """
    return {
        "case_id": case_id,
        "type": case_type,
        "project_id": project_id,
        "episode_id": 1,
        "query": f"query-{case_id}",
        "expect_hit_asset_ids": list(expect or []),
        "forbid_asset_ids": list(forbid or []),
        "required_filters": {"project_id": project_id, "episode_id": 1},
    }


def _patch_clock(monkeypatch, delays):
    """把评测时钟替换为受控序列：每条 case 两次取时，差值即注入延迟。

    :param monkeypatch: pytest 夹具。
    :param delays: 每条 case 的延迟（秒）列表。
    :return: 无返回值。
    """
    ticks = []
    cursor = 0.0
    for delay in delays:
        ticks.append(cursor)          # 开始
        cursor += delay
        ticks.append(cursor)          # 结束（差值 = delay）

    sequence = iter(ticks)
    monkeypatch.setattr(retrieval_eval, "_now", lambda: next(sequence))


def test_metrics_report_exact_values_for_known_hits():
    """手工构造已知命中顺序：Recall@K / MRR / 空结果率 / 泄漏数精确。

    4 条 case 的命中设计：
    - c1 命中 ["p21-a", "p21-b"]（期望 p21-a）→ recall 1.0，MRR 1.0；
    - c2 命中 ["p21-x", "p21-a"]（期望 p21-a）→ recall 1.0，MRR 0.5；
    - c3 命中 []（期望 p21-a）→ recall 0.0，MRR 0.0，空结果；
    - c4 命中 ["p22-foreign"]（forbid）→ 泄漏 1，无期望不进 recall/mrr 平均。

    :return: 无返回值。
    :raises AssertionError: summary/per_case 数值与手工推导不符时抛出。
    """
    cases = [
        _case("c1", expect=["p21-a"]),
        _case("c2", expect=["p21-a"]),
        _case("c3", expect=["p21-a"]),
        _case("c4", expect=[], forbid=["p22-foreign"], case_type="empty"),
    ]
    fixed_hits = {
        "c1": ["p21-a", "p21-b"],
        "c2": ["p21-x", "p21-a"],
        "c3": [],
        "c4": ["p22-foreign"],
    }

    report = evaluate_retrieval_metrics(cases, lambda case: fixed_hits[case["case_id"]], top_k=5)

    summary = report["summary"]
    assert summary["case_count"] == 4
    assert summary["recall_at_k"] == pytest.approx(2 / 3)  # (1.0 + 1.0 + 0.0) / 3
    assert summary["mrr"] == pytest.approx(0.5)            # (1.0 + 0.5 + 0.0) / 3
    assert summary["empty_rate"] == pytest.approx(0.25)    # 仅 c3 空结果
    assert summary["leak_count"] == 1                      # c4 命中禁止资产

    per_case = {item["case_id"]: item for item in report["per_case"]}
    assert per_case["c1"]["recall_at_k"] == pytest.approx(1.0)
    assert per_case["c1"]["mrr"] == pytest.approx(1.0)
    assert per_case["c2"]["mrr"] == pytest.approx(0.5)
    assert per_case["c3"]["empty"] is True
    assert per_case["c3"]["recall_at_k"] == pytest.approx(0.0)
    assert per_case["c4"]["leaked_asset_ids"] == ["p22-foreign"]
    assert per_case["c4"]["recall_at_k"] is None  # 空期望不进 recall 统计


def test_cross_project_leak_detected_by_asset_prefix():
    """命中资产的项目前缀与 case 项目不一致时计入泄漏（无需显式 forbid）。

    :return: 无返回值。
    :raises AssertionError: 泄漏判定与预期不符时抛出。
    """
    cases = [_case("c1", project_id=21, expect=["p21-a"])]
    report = evaluate_retrieval_metrics(cases, lambda case: ["p22-somewhere", "p21-a"], top_k=5)

    assert report["summary"]["leak_count"] == 1
    assert report["per_case"][0]["leaked_asset_ids"] == ["p22-somewhere"]
    # 期望资产仍命中，recall 不受泄漏影响。
    assert report["summary"]["recall_at_k"] == pytest.approx(1.0)


def test_latency_quantiles_use_controlled_clock(monkeypatch):
    """受控延迟序列 [0.1, 0.2, 0.3, 0.4] 秒：P50=200ms、P95=400ms（最近排名法）。

    :param monkeypatch: pytest 夹具。
    :return: 无返回值。
    :raises AssertionError: 分位数与注入延迟不符时抛出。
    """
    cases = [_case(f"c{i}", expect=["p21-a"]) for i in range(1, 5)]
    _patch_clock(monkeypatch, delays=[0.1, 0.2, 0.3, 0.4])

    report = evaluate_retrieval_metrics(cases, lambda case: ["p21-a"], top_k=5)

    # 排序后 [0.1, 0.2, 0.3, 0.4]：P50→ceil(2)-1=1→0.2s；P95→ceil(3.8)-1=3→0.4s。
    assert report["summary"]["latency_p50_ms"] == pytest.approx(200.0)
    assert report["summary"]["latency_p95_ms"] == pytest.approx(400.0)
    assert report["per_case"][0]["duration_ms"] == pytest.approx(100.0)
    assert report["per_case"][3]["duration_ms"] == pytest.approx(400.0)


def test_top_k_truncates_hits_before_scoring():
    """命中列表按 top_k 截断后再统计：超出 top_k 的命中不参与 Recall/MRR。

    :return: 无返回值。
    :raises AssertionError: 截断行为与预期不符时抛出。
    """
    cases = [_case("c1", expect=["p21-a", "p21-b"])]
    deep_hits = ["p21-x", "p21-y", "p21-z", "p21-a"]  # 期望资产排在 top_k=2 之外

    report = evaluate_retrieval_metrics(cases, lambda case: deep_hits, top_k=2)

    assert report["summary"]["recall_at_k"] == pytest.approx(0.0)
    assert report["per_case"][0]["hit_asset_ids"] == ["p21-x", "p21-y"]
    assert report["summary"]["mrr"] == pytest.approx(0.0)


def test_by_type_grouping_aggregates_per_type():
    """按 case type 分组小计：各组 recall/空结果/泄漏独立统计。

    :return: 无返回值。
    :raises AssertionError: 分组小计与手工推导不符时抛出。
    """
    cases = [
        _case("pos-1", expect=["p21-a"], case_type="positive"),
        _case("pos-2", expect=["p21-b"], case_type="positive"),
        _case("emp-1", expect=[], case_type="empty"),
    ]
    fixed_hits = {"pos-1": ["p21-a"], "pos-2": [], "emp-1": ["p22-x"]}

    report = evaluate_retrieval_metrics(cases, lambda case: fixed_hits[case["case_id"]], top_k=5)

    assert set(report["by_type"]) == {"positive", "empty"}
    assert report["by_type"]["positive"]["case_count"] == 2
    assert report["by_type"]["positive"]["recall_at_k"] == pytest.approx(0.5)
    assert report["by_type"]["empty"]["leak_count"] == 1
    assert report["by_type"]["empty"]["recall_at_k"] is None
    assert "precision_at_k" not in report["summary"]  # Precision@K 明确不输出
