"""Agent Eval 离线评测包：固定数据集 + 确定性校验器 + 回归门禁报告。

体系边界（硬约束）：
- **离线**：零网络、零真实模型调用、零供应商费用；所有样本输入为固定字面量，
  校验器为纯函数，执行结果在任何机器上都可复现；
- **固定与可版本化**：数据集以 :data:`.dataset.EVAL_DATASET_VERSION` 标记版本，
  样本任何增删改必须递增版本号；报告以 ``artifacts/agent-eval-report.json`` 落盘，
  支持与上一版对比（previous_diff：新增失败/修复项）；
- **来源区分与 pending_review 语义**：每条样本声明 source（rule_check / llm_judge /
  vision_audio_check / human_review）；不可机器判定的语义样本必须
  ``pending_review=True``，它们单独进入报告 pending_review 列表且**不混入**
  pass_rate_excluding_pending 的分母；
- **CI 安全**：:mod:`.validators` 与 :mod:`.runner` 均不 import 网络与模型客户端
  （httpx/requests/langchain 等），由 ``tests/test_eval_runner.py`` 的 AST 静态
  自检强制保证；报告 runtime.model_config 只含布尔与名称，绝无密钥内容。

模块组成：
- :mod:`.dataset`：样本注册表（八类 × 正反例）与 :class:`.dataset.EvalCase` 契约；
- :mod:`.validators`：八类确定性校验器与 :data:`.validators.VERIFIERS` 注册表；
- :mod:`.runner`：报告运行器（:func:`.runner.run_agent_eval` /
  :func:`.runner.write_report` / ``python -m app.agent.eval.runner`` CLI 入口）。

runner 相关符号采用 PEP 562 惰性导出：避免 ``python -m app.agent.eval.runner``
执行前 runner 已被包初始化加载进 sys.modules（消除 runpy 的 RuntimeWarning）。
"""

from .dataset import (
    AGENT_EVAL_CASES,
    EVAL_DATASET_VERSION,
    EvalCase,
    EvalSource,
    EvalType,
    get_cases_by_type,
)
from .validators import KNOWN_RECOVERY_SCENARIOS, VERIFIERS

__all__ = [
    "AGENT_EVAL_CASES",
    "EVAL_DATASET_VERSION",
    "EvalCase",
    "EvalSource",
    "EvalType",
    "get_cases_by_type",
    "KNOWN_RECOVERY_SCENARIOS",
    "VERIFIERS",
    "REPORT_VERSION",
    "run_agent_eval",
    "write_report",
]

# 惰性导出的 runner 符号 → runner 模块内实际名称（当前一一对应）。
_RUNNER_EXPORTS = ("REPORT_VERSION", "run_agent_eval", "write_report")


def __getattr__(name: str):
    """PEP 562 模块级惰性属性：按需导入 runner 再取符号。

    :param name: 被访问的模块属性名。
    :returns: runner 模块内对应的符号值。
    :raises AttributeError: 属性名不在惰性导出表内时抛出。
    """
    if name in _RUNNER_EXPORTS:
        from . import runner

        return getattr(runner, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
