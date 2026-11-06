"""DeepAgents 受控试点包（阶段 3）：低风险研究类 Agent 与纯 LangGraph 对照实验。

边界声明（任务书硬约束，违反即返工）：

- 试点范围仅限"项目知识研究"这一低风险只读场景，**不接管**图片/视频/音频
  生成等付费链路；
- 工具受限、只读、项目范围内（见 :mod:`app.agent.research.tools`）；
  子代理严格继承 project/user 权限，跨项目访问抛
  :class:`app.agent.errors.PermissionDeniedError`；
- 默认禁用任意路径读写、删除与 shell 执行：不挂载任何文件系统写入工具，
  仅以 ``FilesystemMiddleware(backend=StateBackend(), tools=["read_file"])``
  替换默认栈（StateBackend 为图 state 内的隔离虚拟沙箱，唯一暴露的
  ``read_file`` 为只读工具，且试点脚本不调用它）；
- 硬预算五项（最大步骤 / 最大工具调用数 / 最大耗时 / 最大成本估算 /
  最大子代理数）由 :class:`app.agent.research.budget.BudgetGuard` 把关，
  任何触顶安全停止并保存部分结果，不静默无限继续；
- 全部离线（fake chat model），零供应商费用；成本一律标注 estimate，
  不伪造真实计费金额；
- 试点结论必须有 :mod:`app.agent.research.comparison` 的对照数据支撑；
  若无收益，结论如实标注"限定为实验能力"。

模块一览：

- :mod:`app.agent.research.budget`：硬预算控制器。
- :mod:`app.agent.research.tools`：受限只读项目范围内工具。
- :mod:`app.agent.research.deep_research`：DeepAgents 试点实现。
- :mod:`app.agent.research.baseline_langgraph`：纯 LangGraph 对照实现。
- :mod:`app.agent.research.comparison`：对照运行器与产物落盘。
"""

from .budget import BudgetExceededError, BudgetGuard, ResearchBudget
from .comparison import format_comparison_report, run_comparison, write_comparison_artifact
from .deep_research import (
    ScriptedResearchChatModel,
    build_deep_research_agent,
    run_deep_research,
)
from .tools import bind_research_tools

__all__ = [
    "BudgetExceededError",
    "BudgetGuard",
    "ResearchBudget",
    "ScriptedResearchChatModel",
    "bind_research_tools",
    "build_deep_research_agent",
    "format_comparison_report",
    "run_comparison",
    "run_deep_research",
    "write_comparison_artifact",
]
