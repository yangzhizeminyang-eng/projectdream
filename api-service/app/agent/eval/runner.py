"""Agent Eval 报告运行器：遍历固定数据集执行校验器，产出回归门禁报告。

边界纪律（CI 安全硬约束，由 AST 静态自检测试强制）：
- 本模块与 :mod:`app.agent.eval.validators` 均**不得 import** httpx/requests/
  langchain 等网络与模型客户端；执行全程离线、零真实模型调用、零费用；
- 通过率（pass_rate_excluding_pending）只在**非 pending** 的确定性样本上计算，
  ``pending_review=True`` 的人工复核样本不混入分母，避免语义待定项稀释门禁信号；
- 样本判定语义：``passed`` 表示"校验器行为符合样本预期"（expectations 里的
  ``expected_verdict`` 与校验器实际判定一致），因此**反例样本被正确判 fail 也算
  通过**——报告反映的是校验器健康度（回归门禁），不是业务数据质量；
- ``model_config`` 只含布尔与名称（provider/real_model_calls/api_key_present），
  **绝不写入任何密钥内容**。

CLI 用法（cwd = api-service）::

    C:\\Temp\\pd-venvs\\api\\Scripts\\python.exe -m app.agent.eval.runner
        [--output artifacts/agent-eval-report.json]
        [--previous artifacts/agent-eval-report.json]

退出码：0（全部样本判定符合预期，含存在 pending 样本的情况）；
1（存在确定性失败：正例意外失败或反例不再失败）。
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import platform
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import dataset as dataset_module
from .dataset import EvalCase, EvalSource, EvalType
from .validators import VERIFIERS

#: 报告结构版本（报告 schema 变更时递增，与数据集版本相互独立）。
REPORT_VERSION = "v1"

#: 默认报告落盘路径（相对仓库根的 artifacts 目录）。
DEFAULT_REPORT_PATH = "artifacts/agent-eval-report.json"

#: 报告中 command 字段使用的模块调用形式。
_RUNNER_COMMAND_SUFFIX = "-m app.agent.eval.runner"

# 仓库根目录（runner.py 位于 {repo}/api-service/app/agent/eval/ 下，parents[4] 即仓库根）。
# 仓库约定：artifacts/ 相对仓库根定位（与阶段 4 phase4-retrieval-eval.json 一致），
# CLI 的 --output 相对路径按仓库根解析，使 cwd=api-service 也能稳定落盘到仓库根。
_REPO_ROOT = Path(__file__).resolve().parents[4]

# 常见模型 API Key 的环境变量名（只探测存在性，绝不读取/写入内容）。
_API_KEY_ENV_NAMES: tuple[str, ...] = (
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DASHSCOPE_API_KEY",
    "MOONSHOT_API_KEY",
    "ZHIPU_API_KEY",
    "DEEPSEEK_API_KEY",
)


def _utc_now_iso() -> str:
    """生成 UTC ISO 时间戳。

    :returns: 形如 ``2026-10-16T08:00:00+00:00`` 的字符串。
    """
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _package_version(distribution_name: str) -> str:
    """读取发行包版本号。

    :param distribution_name: 发行包名（如 "pytest"/"langgraph"/"deepagents"/"fastapi"）。
    :returns: 版本字符串；未安装或元数据不可读时返回 "unavailable"。
    """
    try:
        return importlib.metadata.version(distribution_name)
    except importlib.metadata.PackageNotFoundError:
        return "unavailable"


def _expected_verdict(case: EvalCase) -> str | None:
    """读取样本预期的校验器判定。

    :param case: 样本。
    :returns: "pass" / "fail"；expectations 非 dict 或缺少合法 expected_verdict
        时返回 None（runner 会把该样本判为失败并给出明确失败说明）。
    """
    expectations = case.expectations
    if isinstance(expectations, dict):
        verdict = expectations.get("expected_verdict")
        if verdict in ("pass", "fail"):
            return str(verdict)
    return None


def _runtime_section() -> dict[str, Any]:
    """构造报告 runtime 节点（版本信息 + 脱敏模型配置）。

    :returns: 含 python/pytest/langgraph/deepagents/fastapi 版本与 model_config 的 dict；
        model_config 只有 provider 名称、调用计数与 api_key_present 布尔，绝无密钥内容。
    """
    return {
        "python": platform.python_version(),
        "pytest": _package_version("pytest"),
        "langgraph": _package_version("langgraph"),
        "deepagents": _package_version("deepagents"),
        "fastapi": _package_version("fastapi"),
        "model_config": {
            "provider": "fake-offline",
            "real_model_calls": 0,
            "api_key_present": any(os.environ.get(name) for name in _API_KEY_ENV_NAMES),
        },
    }


def _execute_case(case: EvalCase) -> dict[str, Any]:
    """执行单条样本并产出逐 case 记录。

    :param case: 样本。
    :returns: ``{case_id,eval_type,name,source,pending_review,expected_verdict,
        passed,failures,duration_ms,details}`` 记录（全部 JSON 可序列化）。
    """
    started = time.perf_counter()
    verifier = VERIFIERS.get(case.verifier)
    failures: list[str] = []
    details: dict[str, Any] = {}
    verdict = _expected_verdict(case)

    if verifier is None:
        failures.append(f"校验器 {case.verifier!r} 未在 VERIFIERS 注册表注册")
        passed = False
    else:
        result = verifier(case)
        details = result.get("details", {})
        actual = "pass" if result.get("passed") else "fail"
        failures = [str(item) for item in result.get("failures", [])]
        if verdict is None:
            passed = False
            failures.append("样本 expectations 缺少合法的 expected_verdict（pass/fail），无法判定")
        else:
            passed = actual == verdict
            if not passed:
                failures.append(
                    f"判定与预期不符：期望 {expected_text(verdict)}，实际 {expected_text(actual)}"
                )

    duration_ms = round((time.perf_counter() - started) * 1000, 3)
    return {
        "case_id": case.case_id,
        "eval_type": case.eval_type.value if isinstance(case.eval_type, EvalType) else str(case.eval_type),
        "name": case.name,
        "source": case.source.value if isinstance(case.source, EvalSource) else str(case.source),
        "pending_review": bool(case.pending_review),
        "expected_verdict": verdict,
        "passed": passed,
        "failures": failures,
        "duration_ms": duration_ms,
        "details": details,
    }


def expected_text(verdict: str) -> str:
    """把 verdict 值转成中文说明（用于失败文案）。

    :param verdict: "pass" 或 "fail"。
    :returns: "通过" / "失败"。
    """
    return "通过" if verdict == "pass" else "失败"


def _load_previous_case_map(previous_report_path: str) -> dict[str, dict[str, Any]] | None:
    """读取上一版报告的逐 case 结果映射。

    :param previous_report_path: 上一版报告 JSON 路径。
    :returns: case_id → 上一版记录 的映射；文件不可读/结构不符返回 None。
    """
    try:
        with open(previous_report_path, "r", encoding="utf-8") as handle:
            previous = json.load(handle)
    except (OSError, ValueError):
        return None
    rows = previous.get("cases") if isinstance(previous, dict) else None
    if not isinstance(rows, list):
        return None
    case_map: dict[str, dict[str, Any]] = {}
    for row in rows:
        if isinstance(row, dict) and row.get("case_id") is not None:
            case_map[str(row["case_id"])] = row
    return case_map


def _previous_diff(
    current_rows: list[dict[str, Any]], previous_report_path: str | None
) -> dict[str, Any] | None:
    """与上一版报告对比，产出新增失败/修复项（pending 样本不参与对比）。

    :param current_rows: 本次运行的逐 case 记录。
    :param previous_report_path: 上一版报告路径；None 表示无上一版。
    :returns: ``{"previous_report","new_failures","fixed"}``；无上一版返回 None；
        上一版不可读时附 error 字段。
    """
    if not previous_report_path:
        return None
    previous_map = _load_previous_case_map(previous_report_path)
    if previous_map is None:
        return {
            "previous_report": previous_report_path,
            "error": "上一版报告不可读或缺少逐 case 结果（cases 键）",
            "new_failures": [],
            "fixed": [],
        }
    new_failures: list[str] = []
    fixed: list[str] = []
    for row in current_rows:
        if row["pending_review"]:
            continue
        previous_row = previous_map.get(row["case_id"])
        if previous_row is None:
            continue
        previous_passed = bool(previous_row.get("passed"))
        current_passed = bool(row["passed"])
        if previous_passed and not current_passed:
            new_failures.append(row["case_id"])
        elif not previous_passed and current_passed:
            fixed.append(row["case_id"])
    return {
        "previous_report": previous_report_path,
        "new_failures": new_failures,
        "fixed": fixed,
    }


def run_agent_eval(*, previous_report_path: str | None = None) -> dict[str, Any]:
    """运行全量 Agent Eval 并生成回归门禁报告。

    遍历 :data:`app.agent.eval.dataset.AGENT_EVAL_CASES`，按样本 verifier 名查
    :data:`app.agent.eval.validators.VERIFIERS` 注册表执行；pending 样本单独归入
    pending_review 列表且不混入通过率分母。

    :param previous_report_path: 上一版报告 JSON 路径（用于 previous_diff）；
        None 表示无上一版（previous_diff=null）。
    :returns: 报告 dict（全部 JSON 可序列化），含 report_version/dataset_version/
        generated_at/totals/pass_rate_excluding_pending/by_type/cases/failures/
        pending_review/sources/previous_diff/runtime/command/artifact。
    :raises: 本函数不抛出异常；校验器缺失或样本缺 expected_verdict 均记为该样本失败。
    """
    cases = dataset_module.AGENT_EVAL_CASES
    rows = [_execute_case(case) for case in cases]

    totals = {
        "cases": len(rows),
        "passed": sum(1 for row in rows if row["passed"]),
        "failed": sum(1 for row in rows if not row["passed"]),
        "pending_review_count": sum(1 for row in rows if row["pending_review"]),
    }

    deterministic_rows = [row for row in rows if not row["pending_review"]]
    if deterministic_rows:
        pass_rate = round(
            sum(1 for row in deterministic_rows if row["passed"]) / len(deterministic_rows), 4
        )
    else:
        pass_rate = None

    by_type: dict[str, dict[str, int]] = {
        eval_type.value: {"cases": 0, "passed": 0, "failed": 0, "pending": 0}
        for eval_type in EvalType
    }
    for row in rows:
        bucket = by_type.setdefault(row["eval_type"], {"cases": 0, "passed": 0, "failed": 0, "pending": 0})
        bucket["cases"] += 1
        bucket["passed" if row["passed"] else "failed"] += 1
        if row["pending_review"]:
            bucket["pending"] += 1

    sources: dict[str, dict[str, int]] = {
        source.value: {"cases": 0, "passed": 0, "failed": 0}
        for source in EvalSource
    }
    for row in rows:
        bucket = sources.setdefault(row["source"], {"cases": 0, "passed": 0, "failed": 0})
        bucket["cases"] += 1
        bucket["passed" if row["passed"] else "failed"] += 1

    case_by_id = {case.case_id: case for case in cases}
    failures_payload = [
        {"case_id": row["case_id"], "failures": row["failures"]}
        for row in rows
        if not row["passed"]
    ]
    pending_payload = []
    for row in rows:
        if not row["pending_review"]:
            continue
        case = case_by_id.get(row["case_id"])
        if case is not None and case.allowable_error is not None:
            reason = str(case.allowable_error)
        else:
            reason = "包含不可机器判定的语义检查，需人工复核"
        if not row["passed"]:
            reason += "；且结构检查未通过，需优先处理"
        pending_payload.append({"case_id": row["case_id"], "name": row["name"], "reason": reason})

    return {
        "report_version": REPORT_VERSION,
        "dataset_version": dataset_module.EVAL_DATASET_VERSION,
        "generated_at": _utc_now_iso(),
        "totals": totals,
        "pass_rate_excluding_pending": pass_rate,
        "by_type": by_type,
        "cases": rows,
        "failures": failures_payload,
        "pending_review": pending_payload,
        "sources": sources,
        "previous_diff": _previous_diff(rows, previous_report_path),
        "runtime": _runtime_section(),
        "command": f"{sys.executable} {_RUNNER_COMMAND_SUFFIX}",
        "artifact": DEFAULT_REPORT_PATH,
    }


def write_report(report: dict[str, Any], path: "str | Path") -> Path:
    """把报告 JSON 落盘（UTF-8、缩进 2、保留中文）。

    :param report: :func:`run_agent_eval` 产出的报告 dict。
    :param path: 目标文件路径；父目录不存在时自动创建。
    :returns: 实际写入的 Path。
    :raises OSError: 目录创建或文件写入失败时抛出。
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return target


def _print_summary(report: dict[str, Any], output_path: "str | Path") -> None:
    """打印人读摘要（CI 日志友好，全部 ASCII 安全的中英文本，无密钥内容）。

    :param report: 报告 dict。
    :param output_path: 报告落盘路径（仅用于展示）。
    :return: 无返回值。
    """
    totals = report["totals"]
    print(f"Agent Eval 摘要 | report={report['report_version']} dataset={report['dataset_version']}")
    print(
        f"样本总数: {totals['cases']} | 判定符合预期: {totals['passed']} | "
        f"确定性失败: {totals['failed']} | 待人工复核: {totals['pending_review_count']}"
    )
    print(f"pass_rate_excluding_pending: {report['pass_rate_excluding_pending']}")
    type_summary = " | ".join(
        f"{eval_type}: {bucket['passed']}/{bucket['cases']}"
        f"{' (pending ' + str(bucket['pending']) + ')' if bucket['pending'] else ''}"
        for eval_type, bucket in report["by_type"].items()
    )
    print(f"按类型: {type_summary}")
    if report["pending_review"]:
        for item in report["pending_review"]:
            print(f"待复核 {item['case_id']}: {item['reason']}")
    if report["failures"]:
        print("确定性失败样例:")
        for item in report["failures"]:
            print(f"  {item['case_id']}: {item['failures']}")
    if report["previous_diff"] is not None:
        diff = report["previous_diff"]
        print(
            f"previous_diff: 新增失败 {len(diff.get('new_failures', []))} 项, "
            f"修复 {len(diff.get('fixed', []))} 项"
        )
    print(f"报告已写入: {output_path}")


def _resolve_output_path(raw_path: str) -> Path:
    """解析 CLI 的 --output 路径（相对路径按仓库根解析，绝对路径原样使用）。

    :param raw_path: 用户传入的输出路径（绝对或相对仓库根）。
    :returns: 解析后的目标 Path。
    """
    candidate = Path(raw_path)
    if candidate.is_absolute():
        return candidate
    return _REPO_ROOT / candidate


def main(argv: "list[str] | None" = None) -> int:
    """CLI 入口：运行评测、落盘报告、打印摘要并返回退出码。

    退出码语义：0 = 全部样本判定符合预期（有 pending 样本也返回 0）；
    1 = 存在确定性失败（校验器回归：正例意外失败或反例不再失败）。

    :param argv: 命令行参数列表；None 时使用 sys.argv[1:]。
    :returns: 进程退出码（0 或 1）。
    """
    parser = argparse.ArgumentParser(description="ProjectDream Agent Eval 离线回归门禁运行器")
    parser.add_argument(
        "--output",
        default=DEFAULT_REPORT_PATH,
        help=f"报告输出路径（相对路径按仓库根解析；默认 {DEFAULT_REPORT_PATH}）",
    )
    parser.add_argument(
        "--previous",
        default=None,
        help="上一版报告路径，用于生成 previous_diff（默认无）",
    )
    args = parser.parse_args(argv)

    output_path = _resolve_output_path(args.output)
    report = run_agent_eval(previous_report_path=args.previous)
    write_report(report, output_path)
    _print_summary(report, output_path)
    return 0 if report["totals"]["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
