"""Agent 运行时数据契约。

定义阶段 1（LangChain + LangGraph 试点）的请求/结果/工具声明模型。
本文件是运行时骨架与业务试点图共享的接口契约，修改前需同步
``.trae/specs/upgrade-agent-backend/`` 下的 spec 与任务书。

异常类型统一放在 :mod:`app.agent.errors`。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# Agent 运行状态：与 Node 侧 executor.mjs 的六态语义保持一致，
# 便于后续 LangGraph 编排结果与旧 Pipeline 状态机互认。
AgentRunStatus = Literal[
    "completed",
    "failed",
    "retryable_failed",
    "blocked",
    "waiting_approval",
    "canceled",
]

# 试点阶段支持的任务类型；扩展新任务时在此登记并实现对应编排图。
AgentTaskType = Literal["storyboard_quality"]


class AgentRequest(BaseModel):
    """Agent 执行请求。

    :param project_id: 项目 ID，所有工具调用与权限校验的项目范围。
    :param task_type: 任务类型，决定使用哪个编排图。
    :param payload: 任务输入负载，由对应图的 load 节点做 schema 校验。
    :param idempotency_key: 幂等键；同一键重复 invoke 返回已有 run，不重复执行。
    :param run_id: 可选的客户端指定 run ID；缺省由运行时生成。
    """

    model_config = ConfigDict(extra="forbid")

    project_id: int = Field(ge=1, description="项目 ID，权限与工具范围的锚点")
    task_type: AgentTaskType = Field(description="任务类型")
    payload: dict[str, Any] = Field(default_factory=dict, description="任务输入负载")
    idempotency_key: str = Field(
        min_length=8,
        max_length=128,
        description="幂等键，建议包含稳定业务范围（project_id + task_type + 业务主键）",
    )
    run_id: str | None = Field(default=None, description="可选客户端指定 run ID")


class AgentResult(BaseModel):
    """Agent 执行结果。

    :param run_id: 本次执行的稳定运行 ID。
    :param status: 六态之一的最终状态。
    :param validated_output: 通过 schema 校验的结构化输出；失败时为 None。
    :param blockers: 阻塞项列表，元素含 code/message/severity。
    :param usage: 模型调用用量记录（model/latency_ms/tokens/cost_status）。
    :param trace_id: 贯穿日志与事件的追踪 ID。
    :param checkpoint_id: LangGraph checkpoint 标识；内存图试点阶段可与 run_id 相同。
    """

    model_config = ConfigDict(extra="forbid")

    run_id: str = Field(description="运行 ID")
    status: AgentRunStatus = Field(description="执行状态")
    validated_output: dict[str, Any] | None = Field(default=None, description="校验后的结构化输出")
    blockers: list[dict[str, Any]] = Field(default_factory=list, description="阻塞项")
    usage: dict[str, Any] = Field(default_factory=dict, description="模型调用用量")
    trace_id: str = Field(description="追踪 ID")
    checkpoint_id: str | None = Field(default=None, description="checkpoint 标识")


class ToolSpec(BaseModel):
    """工具注册声明。

    :param name: 工具唯一名。
    :param description: 用途说明（面向模型与审计）。
    :param input_schema: JSON Schema，invoke 前强制校验。
    :param scopes: 所需权限范围声明，如 ``project:read``。
    :param timeout_seconds: 单次调用超时上限。
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=64, description="工具唯一名")
    description: str = Field(min_length=1, max_length=512, description="用途说明")
    input_schema: dict[str, Any] = Field(description="输入 JSON Schema")
    scopes: list[str] = Field(default_factory=list, description="权限范围声明")
    timeout_seconds: float = Field(default=10.0, gt=0, le=60, description="调用超时上限（秒）")


class ToolContext(BaseModel):
    """工具执行上下文，绑定项目与运行范围，防止跨项目越权。

    :param project_id: 当前 run 的项目 ID。
    :param run_id: 当前 run ID。
    :param trace_id: 追踪 ID，进入审计日志。
    :param granted_scopes: 本次 run 被授予的权限范围。
    :param user_id: 发起用户（可空，内部调用时为 None）。
    """

    model_config = ConfigDict(extra="forbid")

    project_id: int = Field(ge=1, description="项目 ID")
    run_id: str = Field(description="运行 ID")
    trace_id: str = Field(description="追踪 ID")
    granted_scopes: list[str] = Field(default_factory=list, description="授予的权限范围")
    user_id: str | None = Field(default=None, description="发起用户标识")


class ToolInvocationResult(BaseModel):
    """工具调用结果。

    :param ok: 是否成功。
    :param data: 成功时的输出数据。
    :param error: 失败时的错误摘要（脱敏，不含原始输入）。
    """

    model_config = ConfigDict(extra="forbid")

    ok: bool = Field(description="是否成功")
    data: dict[str, Any] | None = Field(default=None, description="输出数据")
    error: str | None = Field(default=None, description="脱敏错误摘要")
