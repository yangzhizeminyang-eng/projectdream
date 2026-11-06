"""检索边界校验与离线检索质量指标。

- :func:`evaluate_retrieval`：阶段一遗留的单用例边界断言（范围/期望/禁止资产），
  保持原签名与返回结构兼容。
- :func:`evaluate_retrieval_metrics`：批量评测的 Recall@K / MRR / 空结果率 /
  延迟分位 / 跨项目泄漏统计，输出 per_case 明细、按类型分组小计与 summary。

关于 Precision@K 的明确说明：标注数据集只标注了期望命中的资产和明确的禁止
资产，**不含全量负样本标注**，Precision@K 的分母（返回的全部结果是否相关）
无法可靠统计，因此暂不输出该指标，避免给出统计上无意义的分数。
"""

import math
import re
import time
from typing import Any, Callable

# 时钟注入点：默认使用单调高精度时钟；测试可 monkeypatch 本函数以
# 提供受控延迟序列，精确验证 P50/P95。
_now = time.perf_counter

# 资产 ID 的项目前缀约定：形如 "p21-char-linwanxia-v2"，用于从资产 ID
# 解析归属项目，判定跨项目泄漏（无法解析前缀的资产不参与项目判定）。
_FOREIGN_PROJECT_PREFIX = re.compile(r"^p(\d+)[-_]")


def evaluate_retrieval(expectation: dict[str, Any], results: list[dict[str, Any]]) -> dict[str, Any]:
    """Evaluate retrieval boundaries and required/forbidden asset hits."""
    expected_project = expectation.get("project_id")
    expected_episode = expectation.get("episode_id")
    expected_ids = {str(value) for value in expectation.get("expected_asset_ids", [])}
    forbidden_ids = {str(value) for value in expectation.get("forbidden_asset_ids", [])}
    scope_violations: list[dict[str, Any]] = []
    expected_hits: set[str] = set()
    forbidden_hits: set[str] = set()

    for result in results:
        metadata = result.get("metadata") or {}
        if metadata.get("project_id") != expected_project or (
            expected_episode is not None and metadata.get("episode_id") != expected_episode
        ):
            scope_violations.append(
                {"project_id": metadata.get("project_id"), "episode_id": metadata.get("episode_id")}
            )
        asset_id = metadata.get("asset_id")
        if asset_id is not None and str(asset_id) in expected_ids:
            expected_hits.add(str(asset_id))
        if asset_id is not None and str(asset_id) in forbidden_ids:
            forbidden_hits.add(str(asset_id))

    missing = sorted(expected_ids - expected_hits)
    expected = sorted(expected_hits)
    forbidden = sorted(forbidden_hits)
    return {
        "passed": not scope_violations and not missing and not forbidden,
        "scope_passed": not scope_violations,
        "expected_hits": expected,
        "missing_expected_asset_ids": missing,
        "scope_violations": scope_violations,
        "forbidden_asset_hits": forbidden,
    }


def _asset_project_id(asset_id: str) -> int | None:
    """从资产 ID 前缀解析归属项目 ID。

    :param asset_id: 资产 ID（约定形如 "p21-char-linwanxia-v2"）。
    :return: 解析出的项目 ID；无前缀或非数字时返回 None。
    """
    match = _FOREIGN_PROJECT_PREFIX.match(asset_id)
    return int(match.group(1)) if match else None


def _is_leaked_asset(asset_id: str, *, forbid_ids: set[str], case_project_id: Any) -> bool:
    """判定单个命中资产是否构成泄漏。

    判定规则（满足任一即泄漏）：
    - 命中 forbid_asset_ids（含过期版本、跨项目同名等禁止项）；
    - 资产 ID 前缀解析出的项目与 case 的 project_id 不一致（他项目资产）；
      前缀不可解析时不做项目判定，避免误报。

    :param asset_id: 命中的资产 ID。
    :param forbid_ids: 该 case 的禁止资产集合。
    :param case_project_id: case 声明的项目 ID。
    :return: 构成泄漏返回 True。
    """
    if asset_id in forbid_ids:
        return True
    asset_project = _asset_project_id(asset_id)
    if asset_project is not None and case_project_id is not None:
        try:
            return asset_project != int(case_project_id)
        except (TypeError, ValueError):
            return False
    return False


def evaluate_retrieval_metrics(
    cases: list[dict[str, Any]],
    query_fn: Callable[[dict[str, Any]], list[str]],
    *,
    top_k: int = 5,
) -> dict[str, Any]:
    """批量执行检索评测并输出质量指标。

    :param cases: 评测样本列表（结构见 :mod:`app.eval_dataset`：case_id/type/
        project_id/episode_id/query/expect_hit_asset_ids/forbid_asset_ids/
        required_filters）。
    :param query_fn: 检索执行函数；接收单个 case，返回命中 asset_id 的有序列表
        （按检索相关性降序，长度可超过 top_k，函数内部截断）。
    :param top_k: 参与统计的返回条数上限（与线上检索口径一致，默认 5）。
    :return: 评测报告：``per_case``（逐条明细）、``by_type``（按 case type 分组
        小计）与 ``summary``（全量口径）。
    :raises Exception: query_fn 抛出的异常原样传播（评测中止，不吞错）。

    指标口径：
    - Recall@K / MRR：仅在 ``expect_hit_asset_ids`` 非空的 case 上平均（空期望
      的 case 分母无意义，只参与空结果率与泄漏统计）；
    - 空结果率：全部 case 中命中列表为空的比例；
    - 泄漏数：全部 case 中命中 forbid 或他项目资产的命中条目总数（按条计）；
    - 延迟：对每次 ``query_fn`` 调用计时，输出 P50/P95（毫秒，最近排名法）；
    - Precision@K：标注集不含全量负样本，不具统计意义，暂不输出。
    """
    per_case: list[dict[str, Any]] = []
    by_type_acc: dict[str, dict[str, Any]] = {}
    all_latencies: list[float] = []
    total_recall = 0.0
    total_mrr = 0.0
    recall_case_count = 0
    mrr_case_count = 0
    empty_case_count = 0
    leak_total = 0

    for case in cases:
        expected = [str(value) for value in (case.get("expect_hit_asset_ids") or [])]
        expected_set = set(expected)
        forbid_set = {str(value) for value in (case.get("forbid_asset_ids") or [])}
        case_type = str(case.get("type") or "unknown")
        case_id = str(case.get("case_id") or "")

        started = _now()
        hits = [str(value) for value in (query_fn(case) or [])][: max(0, top_k)]
        duration_seconds = _now() - started
        all_latencies.append(duration_seconds)

        leaked = [asset_id for asset_id in hits if _is_leaked_asset(asset_id, forbid_ids=forbid_set, case_project_id=case.get("project_id"))]
        leak_total += len(leaked)
        is_empty = not hits
        if is_empty:
            empty_case_count += 1

        first_hit_rank = next((index + 1 for index, asset_id in enumerate(hits) if asset_id in expected_set), None)
        mrr = (1.0 / first_hit_rank) if first_hit_rank is not None else 0.0
        recall = (len(expected_set & set(hits)) / len(expected_set)) if expected_set else None

        if expected_set:
            recall_case_count += 1
            total_recall += recall
            mrr_case_count += 1
            total_mrr += mrr

        per_case.append(
            {
                "case_id": case_id,
                "type": case_type,
                "hit_asset_ids": hits,
                "recall_at_k": recall,
                "mrr": mrr if expected_set else None,
                "empty": is_empty,
                "leaked_asset_ids": leaked,
                "duration_ms": round(duration_seconds * 1000, 3),
            }
        )

        stats = by_type_acc.setdefault(
            case_type,
            {"case_count": 0, "recall_sum": 0.0, "recall_case_count": 0, "mrr_sum": 0.0,
             "mrr_case_count": 0, "empty_count": 0, "leak_count": 0},
        )
        stats["case_count"] += 1
        if expected_set:
            stats["recall_sum"] += recall
            stats["recall_case_count"] += 1
            stats["mrr_sum"] += mrr
            stats["mrr_case_count"] += 1
        if is_empty:
            stats["empty_count"] += 1
        stats["leak_count"] += len(leaked)

    def _group_report(stats: dict[str, Any], case_total: int) -> dict[str, Any]:
        """把分组累加值折算为最终小计指标。

        :param stats: 该分组的累加器。
        :param case_total: 该分组 case 数（同时用于空结果率分母）。
        :return: 分组小计（recall/mrr 平均、空结果率、泄漏数）。
        """
        return {
            "case_count": case_total,
            "recall_at_k": (stats["recall_sum"] / stats["recall_case_count"]) if stats["recall_case_count"] else None,
            "mrr": (stats["mrr_sum"] / stats["mrr_case_count"]) if stats["mrr_case_count"] else None,
            "empty_rate": (stats["empty_count"] / case_total) if case_total else None,
            "leak_count": stats["leak_count"],
        }

    by_type = {name: _group_report(stats, stats["case_count"]) for name, stats in by_type_acc.items()}
    case_total = len(cases)
    summary: dict[str, Any] = {
        "case_count": case_total,
        "recall_at_k": (total_recall / recall_case_count) if recall_case_count else None,
        "mrr": (total_mrr / mrr_case_count) if mrr_case_count else None,
        "empty_rate": (empty_case_count / case_total) if case_total else None,
        "leak_count": leak_total,
        # Precision@K：标注集不含全量负样本，不具统计意义，暂不输出。
    }
    if all_latencies:
        ordered = sorted(all_latencies)
        # 延迟分位按最近排名法取值，与 metrics.py 口径一致。

        def _quantile_ms(q: float) -> float:
            """按最近排名法取延迟分位并换算为毫秒。

            :param q: 分位系数（0.5 / 0.95）。
            :return: 分位延迟（毫秒，保留 3 位小数）。
            """
            index = max(0, math.ceil(q * len(ordered)) - 1)
            return round(ordered[index] * 1000, 3)

        summary["latency_p50_ms"] = _quantile_ms(0.5)
        summary["latency_p95_ms"] = _quantile_ms(0.95)

    return {"per_case": per_case, "by_type": by_type, "summary": summary}
