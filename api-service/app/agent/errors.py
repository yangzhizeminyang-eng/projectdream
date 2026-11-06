"""Agent 运行时异常体系。

按"重试只针对明确可重试错误"的纪律分级：
- :class:`InvalidInputError`：输入 schema 校验失败，属 blocked。
- :class:`PermissionDeniedError`：工具权限/越权，属 blocked。
- :class:`ToolInvocationError`：工具执行失败，由 ``retryable`` 标记区分。
- :class:`ModelOutputError`：模型结构化输出解析/校验失败，属 retryable。
"""

from __future__ import annotations


class AgentError(Exception):
    """Agent 运行时异常基类。

    :param message: 脱敏后的错误说明；禁止携带密钥或完整用户输入。
    """

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class InvalidInputError(AgentError):
    """任务输入不满足 schema 约束；映射为 blocked 状态。"""


class PermissionDeniedError(AgentError):
    """工具调用越权或权限范围不足；映射为 blocked 状态。"""


class ToolInvocationError(AgentError):
    """工具执行失败。

    :param message: 脱敏错误说明。
    :param retryable: 是否为明确可重试错误（如超时）；非重试错误映射 blocked。
    """

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


class ModelOutputError(AgentError):
    """模型输出解析或 schema 校验失败；映射为 retryable_failed，进入可诊断重试路径。"""


class RateLimitExceededError(AgentError):
    """请求超过限流维度（user/project/provider）速率或并发上限。

    属 AgentError 族：由调用方（/internal 前置门或 runtime 前置）决定拒绝语义；
    消息只携带维度键形状，不携带用户输入内容。
    """
