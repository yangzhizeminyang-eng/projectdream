"""Agent Eval 报告运行器测试。

覆盖：run_agent_eval 报告结构完整性、pending 样本不混入通过率分母（合成 pending
样本断言分母不变）、failures 样例结构、CI 安全的静态 AST import 自检（validators/
runner 无网络与模型客户端依赖）、write_report + previous_diff 对比、__main__ 子进程
退出码语义与 JSON 可回读。
"""

from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
from pathlib import Path

from app.agent.eval import dataset as dataset_module
from app.agent.eval import runner as runner_module
from app.agent.eval.dataset import EvalCase, EvalSource, EvalType

# 仓库根目录（tests 位于 {repo}/api-service/tests/ 下）。
_REPO_ROOT = Path(__file__).resolve().parents[2]
# api-service 根目录（runner 的合法 cwd，pythonpath=. 生效处）。
_API_SERVICE_ROOT = Path(__file__).resolve().parents[1]

# CI 安全硬约束：validators/runner 禁止 import 的网络与模型客户端根模块。
# （含 urllib/http 等标准库网络入口、全部 langchain/langgraph 编排与模型栈。）
_FORBIDDEN_ROOT_MODULES = frozenset({
    "httpx", "requests", "aiohttp", "http3", "urllib", "urllib3", "http",
    "socket", "ssl", "asyncio", "telnetlib", "ftplib", "smtplib", "xmlrpc",
    "openai", "anthropic", "dashscope", "zhipuai", "tiktoken",
    "langchain", "langchain_core", "langchain_openai", "langchain_community",
    "langgraph", "deepagents",
})


def _collect_import_roots(module) -> set[str]:
    """AST 扫描模块源码，收集全部 import 语句的根模块名。

    :param module: 已加载的 Python 模块对象。
    :returns: 根模块名集合（相对导入 level>0 不计入，属包内协作）。
    :raises SyntaxError: 源码无法解析时由 ast.parse 抛出。
    """
    source = Path(module.__file__).read_text(encoding="utf-8")
    tree = ast.parse(source)
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                roots.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            roots.add(node.module.split(".")[0])
    return roots


def _make_case(case_id: str, eval_type: EvalType, payload: dict, *, pending: bool = False) -> EvalCase:
    """构造测试专用临时样本。

    :param case_id: 临时样本 ID。
    :param eval_type: 样本类型。
    :param payload: 校验器输入。
    :param pending: 是否为人工复核样本。
    :returns: EvalCase 实例。
    """
    return EvalCase(
        case_id=case_id,
        eval_type=eval_type,
        name=f"测试样本 {case_id}",
        verifier="verify_storyboard_duration",
        input=payload,
        context={"purpose": "runner 测试临时样本"},
        expectations={"expected_verdict": "pass"},
        source=EvalSource.HUMAN_REVIEW if pending else EvalSource.RULE_CHECK,
        allowable_error="人工抽检说明" if pending else None,
        pending_review=pending,
    )


def test_report_structure_complete():
    """run_agent_eval 报告必须包含全部约定键且 totals 自洽。

    :return: 无返回值。
    :raises AssertionError: 结构缺键或计数不一致时抛出。
    """
    report = runner_module.run_agent_eval()
    for key in (
        "report_version", "dataset_version", "generated_at", "totals",
        "pass_rate_excluding_pending", "by_type", "cases", "failures",
        "pending_review", "sources", "previous_diff", "runtime", "command", "artifact",
    ):
        assert key in report, f"报告缺少键：{key}"

    assert report["report_version"] == "v1"
    assert report["dataset_version"] == dataset_module.EVAL_DATASET_VERSION
    assert report["previous_diff"] is None  # 未传上一版报告

    totals = report["totals"]
    assert totals["cases"] == len(dataset_module.AGENT_EVAL_CASES)
    assert totals["passed"] + totals["failed"] == totals["cases"]
    assert totals["pending_review_count"] == sum(
        1 for row in report["cases"] if row["pending_review"]
    )
    assert set(report["by_type"]) == {eval_type.value for eval_type in EvalType}
    assert set(report["sources"]) == {source.value for source in EvalSource}

    runtime = report["runtime"]
    assert runtime["model_config"] == {
        "provider": "fake-offline",
        "real_model_calls": 0,
        "api_key_present": runtime["model_config"]["api_key_present"],
    }
    assert isinstance(runtime["model_config"]["api_key_present"], bool)  # 脱敏：仅布尔
    for package in ("python", "pytest", "langgraph", "deepagents", "fastapi"):
        assert isinstance(runtime[package], str) and runtime[package]
    assert report["artifact"] == "artifacts/agent-eval-report.json"

    for row in report["cases"]:
        assert set(row) == {
            "case_id", "eval_type", "name", "source", "pending_review",
            "expected_verdict", "passed", "failures", "duration_ms", "details",
        }


def test_pass_rate_excludes_pending_denominator():
    """通过率只在非 pending 样本上计算：分母 = cases - pending_review_count。

    :return: 无返回值。
    :raises AssertionError: 分母混入 pending 或数值不符时抛出。
    """
    report = runner_module.run_agent_eval()
    totals = report["totals"]
    deterministic = [row for row in report["cases"] if not row["pending_review"]]
    assert len(deterministic) == totals["cases"] - totals["pending_review_count"]
    expected_rate = round(
        sum(1 for row in deterministic if row["passed"]) / len(deterministic), 4
    )
    assert report["pass_rate_excluding_pending"] == expected_rate


def test_synthetic_pending_case_does_not_change_denominator(monkeypatch):
    """合成一条 pending 样本后：总数 +1、pending +1，通过率分母保持不变。

    :param monkeypatch: pytest 夹具。
    :return: 无返回值。
    :raises AssertionError: 分母被 pending 样本稀释时抛出。
    """
    baseline = runner_module.run_agent_eval()
    baseline_denominator = baseline["totals"]["cases"] - baseline["totals"]["pending_review_count"]

    synthetic = _make_case(
        "sb-dur-synthetic-pending",
        EvalType.STORYBOARD_DURATION,
        {
            "shots": [{"index": 1, "start_seconds": 0.0, "end_seconds": 3.0}],
            "target_total_seconds": 3.0,
            "tolerance_seconds": 0.5,
        },
        pending=True,
    )
    monkeypatch.setattr(
        dataset_module, "AGENT_EVAL_CASES", (*dataset_module.AGENT_EVAL_CASES, synthetic)
    )
    report = runner_module.run_agent_eval()

    assert report["totals"]["cases"] == baseline["totals"]["cases"] + 1
    assert report["totals"]["pending_review_count"] == baseline["totals"]["pending_review_count"] + 1
    denominator = report["totals"]["cases"] - report["totals"]["pending_review_count"]
    assert denominator == baseline_denominator
    assert any(item["case_id"] == "sb-dur-synthetic-pending" for item in report["pending_review"])
    assert report["pending_review"][0]["reason"]


def test_failures_payload_has_samples_when_verifier_regresses(monkeypatch):
    """校验器回归（正例意外失败）时 failures 必须给出 case_id + failures 样例。

    :param monkeypatch: pytest 夹具。
    :return: 无返回值。
    :raises AssertionError: failures 结构缺失或为空时抛出。
    """
    broken_rows = []
    for case in dataset_module.AGENT_EVAL_CASES:
        if case.case_id == "sb-dur-01":
            broken_input = {**case.input, "target_total_seconds": 99.0}
            broken_rows.append(case.model_copy(update={"input": broken_input}))
        else:
            broken_rows.append(case)
    monkeypatch.setattr(dataset_module, "AGENT_EVAL_CASES", tuple(broken_rows))

    report = runner_module.run_agent_eval()
    assert report["totals"]["failed"] >= 1
    failed_ids = {item["case_id"] for item in report["failures"]}
    assert "sb-dur-01" in failed_ids
    for item in report["failures"]:
        assert item["failures"], f"失败样例 {item['case_id']} 缺少 failures 文案"


def test_sources_and_by_type_counts_consistent():
    """by_type 与 sources 的计数必须与逐 case 记录一致（pending 单列）。

    :return: 无返回值。
    :raises AssertionError: 分组计数与明细不符时抛出。
    """
    report = runner_module.run_agent_eval()
    for row in report["cases"]:
        type_bucket = report["by_type"][row["eval_type"]]
        source_bucket = report["sources"][row["source"]]
        assert type_bucket["cases"] >= 1 and source_bucket["cases"] >= 1
    for eval_type, bucket in report["by_type"].items():
        rows = [
            row for row in report["cases"]
            if row["eval_type"] == eval_type
        ]
        assert bucket["cases"] == len(rows)
        assert bucket["passed"] == sum(1 for row in rows if row["passed"])
        assert bucket["failed"] == sum(1 for row in rows if not row["passed"])
        assert bucket["pending"] == sum(1 for row in rows if row["pending_review"])
        assert bucket["cases"] == bucket["passed"] + bucket["failed"]


def test_ast_static_import_guard_for_validators_and_runner():
    """静态自检：validators/runner 的 import 不得包含网络与模型客户端依赖。

    :return: 无返回值。
    :raises AssertionError: 发现禁止依赖时抛出（含具体模块名）。
    """
    from app.agent.eval import validators as validators_module

    for module in (validators_module, runner_module):
        roots = _collect_import_roots(module)
        forbidden = roots & _FORBIDDEN_ROOT_MODULES
        assert not forbidden, (
            f"{module.__name__} 引入了 CI 禁止的网络/模型客户端依赖：{sorted(forbidden)}"
        )


def test_write_report_and_previous_diff_roundtrip(tmp_path: Path):
    """write_report 落盘可回读；带上一次报告重跑时 previous_diff 非 None。

    :param tmp_path: pytest 临时目录。
    :return: 无返回值。
    :raises AssertionError: 落盘内容或 diff 结构不符时抛出。
    """
    first = runner_module.run_agent_eval()
    first_path = tmp_path / "eval-report-first.json"
    written = runner_module.write_report(first, first_path)
    assert written == first_path and first_path.exists()
    loaded = json.loads(first_path.read_text(encoding="utf-8"))
    assert loaded["dataset_version"] == dataset_module.EVAL_DATASET_VERSION

    second = runner_module.run_agent_eval(previous_report_path=str(first_path))
    assert second["previous_diff"] is not None
    assert second["previous_diff"]["previous_report"] == str(first_path)
    assert second["previous_diff"]["new_failures"] == []
    assert second["previous_diff"]["fixed"] == []


def test_previous_diff_detects_new_failure_and_fix(monkeypatch, tmp_path: Path):
    """上一版通过、本次失败 → new_failures；反之 → fixed（pending 不参与对比）。

    :param monkeypatch: pytest 夹具。
    :param tmp_path: pytest 临时目录。
    :return: 无返回值。
    :raises AssertionError: diff 未捕获翻转时抛出。
    """
    original_cases = dataset_module.AGENT_EVAL_CASES
    healthy = runner_module.run_agent_eval()
    healthy_path = tmp_path / "eval-report-healthy.json"
    runner_module.write_report(healthy, healthy_path)

    broken_rows = []
    for case in original_cases:
        if case.case_id == "sb-dur-01":
            broken_input = {**case.input, "target_total_seconds": 99.0}
            broken_rows.append(case.model_copy(update={"input": broken_input}))
        else:
            broken_rows.append(case)
    monkeypatch.setattr(dataset_module, "AGENT_EVAL_CASES", tuple(broken_rows))

    regressed = runner_module.run_agent_eval(previous_report_path=str(healthy_path))
    assert regressed["previous_diff"]["new_failures"] == ["sb-dur-01"]
    assert regressed["previous_diff"]["fixed"] == []

    regressed_path = tmp_path / "eval-report-regressed.json"
    runner_module.write_report(regressed, regressed_path)

    # 在 monkeypatch 作用域内恢复原始数据集：上一版失败、本次通过 → fixed。
    monkeypatch.setattr(dataset_module, "AGENT_EVAL_CASES", original_cases)
    recovered = runner_module.run_agent_eval(previous_report_path=str(regressed_path))
    assert recovered["previous_diff"]["fixed"] == ["sb-dur-01"]
    assert recovered["previous_diff"]["new_failures"] == []


def test_runner_main_exit_zero_and_json_readable(tmp_path: Path):
    """__main__ 子进程：健康数据集下退出码 0，输出 JSON 可回读且结构完整。

    :param tmp_path: pytest 临时目录。
    :return: 无返回值。
    :raises AssertionError: 退出码非 0、JSON 不可回读或摘要未打印时抛出。
    """
    output_path = tmp_path / "eval-report-cli.json"
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    process = subprocess.run(
        [sys.executable, "-m", "app.agent.eval.runner", "--output", str(output_path)],
        cwd=str(_API_SERVICE_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        timeout=180,
    )
    assert process.returncode == 0, f"stdout={process.stdout}\nstderr={process.stderr}"
    assert process.stdout.strip(), "CLI 应打印人读摘要"
    assert "Agent Eval 摘要" in process.stdout

    payload = json.loads(output_path.read_text(encoding="utf-8"))
    assert payload["totals"]["failed"] == 0
    assert payload["totals"]["cases"] >= 8 * 3
    assert payload["previous_diff"] is None  # 未传 --previous


def test_report_json_serializable_without_secrets():
    """报告整体 JSON 可序列化且不含任何密钥内容（只允许布尔/名称/计数）。

    :return: 无返回值。
    :raises AssertionError: 序列化失败或 runtime 泄漏非约定字段时抛出。
    """
    report = runner_module.run_agent_eval()
    serialized = json.dumps(report, ensure_ascii=False)
    assert "sk-" not in serialized.lower()
    model_config = report["runtime"]["model_config"]
    assert set(model_config) == {"provider", "real_model_calls", "api_key_present"}
    assert model_config["provider"] == "fake-offline"
    assert model_config["real_model_calls"] == 0
