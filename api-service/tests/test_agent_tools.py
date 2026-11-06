"""ToolRegistry 单元测试。

覆盖：重复注册、schema 校验通过/失败、权限足/不足、超时、handler 异常脱敏、
审计日志不落 payload 与用户数据。
"""

import logging
import time

import pytest

from app.agent.errors import InvalidInputError, PermissionDeniedError, ToolInvocationError
from app.agent.schemas import ToolContext, ToolSpec
from app.agent.tools import ToolRegistry


def make_spec(**overrides) -> ToolSpec:
    """构造测试用 ToolSpec。

    :param overrides: 覆盖默认字段的键值。
    :returns: ToolSpec 实例。
    """
    base = {
        "name": "echo",
        "description": "回显工具",
        "input_schema": {
            "type": "object",
            "properties": {"message": {"type": "string"}},
            "required": ["message"],
        },
        "scopes": ["project:read"],
        "timeout_seconds": 1.0,
    }
    base.update(overrides)
    return ToolSpec(**base)


def make_context(**overrides) -> ToolContext:
    """构造测试用 ToolContext。

    :param overrides: 覆盖默认字段的键值。
    :returns: ToolContext 实例。
    """
    base = {
        "project_id": 1,
        "run_id": "run-1",
        "trace_id": "trace-1",
        "granted_scopes": ["project:read"],
    }
    base.update(overrides)
    return ToolContext(**base)


def test_register_duplicate_name_raises_value_error():
    """重复注册同名工具必须抛 ValueError。"""
    registry = ToolRegistry()
    registry.register(make_spec(), lambda payload, context: {"ok": True})
    with pytest.raises(ValueError):
        registry.register(make_spec(), lambda payload, context: {"ok": True})


def test_invoke_success_returns_wrapped_result():
    """成功调用返回 ToolInvocationResult 封装（ok=True 且携带 data）。"""
    registry = ToolRegistry()
    registry.register(make_spec(), lambda payload, context: {"echo": payload["message"]})
    result = registry.invoke("echo", {"message": "hi"}, make_context())
    assert result.ok is True
    assert result.data == {"echo": "hi"}
    assert result.error is None


def test_invoke_unknown_tool_is_not_retryable():
    """未注册工具抛 ToolInvocationError 且 retryable=False。"""
    registry = ToolRegistry()
    with pytest.raises(ToolInvocationError) as excinfo:
        registry.invoke("missing", {}, make_context())
    assert excinfo.value.retryable is False


def test_invoke_rejects_missing_required_field():
    """缺少必填字段抛 InvalidInputError。"""
    registry = ToolRegistry()
    registry.register(make_spec(), lambda payload, context: {})
    with pytest.raises(InvalidInputError):
        registry.invoke("echo", {}, make_context())


def test_invoke_rejects_wrong_field_type():
    """字段类型不符抛 InvalidInputError。"""
    registry = ToolRegistry()
    registry.register(make_spec(), lambda payload, context: {})
    with pytest.raises(InvalidInputError):
        registry.invoke("echo", {"message": 123}, make_context())


def test_invoke_rejects_unsupported_schema_type_declaration():
    """schema 声明了不支持的属性类型抛 InvalidInputError。"""
    registry = ToolRegistry()
    registry.register(
        make_spec(input_schema={"type": "object", "properties": {"x": {"type": "weird"}}}),
        lambda payload, context: {},
    )
    with pytest.raises(InvalidInputError):
        registry.invoke("echo", {"x": "any"}, make_context())


def test_invoke_allows_all_supported_types():
    """string/number/integer/boolean/array/object 六种类型全部校验通过。"""
    registry = ToolRegistry()
    schema = {
        "type": "object",
        "properties": {
            "s": {"type": "string"},
            "n": {"type": "number"},
            "i": {"type": "integer"},
            "b": {"type": "boolean"},
            "a": {"type": "array"},
            "o": {"type": "object"},
        },
    }
    registry.register(make_spec(input_schema=schema), lambda payload, context: {"got": payload})
    payload = {"s": "x", "n": 1.5, "i": 2, "b": True, "a": [1], "o": {"k": "v"}}
    result = registry.invoke("echo", payload, make_context())
    assert result.ok is True


def test_invoke_denied_when_scopes_not_granted():
    """授予范围不含工具所需 scope 时抛 PermissionDeniedError。"""
    registry = ToolRegistry()
    registry.register(make_spec(), lambda payload, context: {})
    with pytest.raises(PermissionDeniedError):
        registry.invoke("echo", {"message": "hi"}, make_context(granted_scopes=[]))


def test_invoke_allows_when_scopes_fully_granted():
    """授予范围完全覆盖（可多不可少）时允许调用。"""
    registry = ToolRegistry()
    registry.register(
        make_spec(scopes=["project:read", "project:write"]),
        lambda payload, context: {"ok": True},
    )
    result = registry.invoke(
        "echo",
        {"message": "hi"},
        make_context(granted_scopes=["project:read", "project:write", "extra"]),
    )
    assert result.ok is True


def test_invoke_timeout_is_retryable():
    """handler 超过 timeout_seconds 时抛 ToolInvocationError 且 retryable=True。"""
    registry = ToolRegistry()
    registry.register(
        make_spec(timeout_seconds=0.05),
        lambda payload, context: time.sleep(0.5) or {},
    )
    with pytest.raises(ToolInvocationError) as excinfo:
        registry.invoke("echo", {"message": "hi"}, make_context())
    assert excinfo.value.retryable is True


def test_invoke_handler_error_is_not_retryable_and_message_is_sanitized():
    """handler 抛异常映射为 retryable=False，且错误消息不含输入内容。"""

    def boom(payload, context):
        """抛出携带输入内容的异常，用于验证脱敏。

        :param payload: 工具输入负载。
        :param context: 工具执行上下文。
        :raises RuntimeError: 总是抛出。
        """
        raise RuntimeError(f"secret input leaked: {payload['message']}")

    registry = ToolRegistry()
    registry.register(make_spec(), boom)
    with pytest.raises(ToolInvocationError) as excinfo:
        registry.invoke("echo", {"message": "TOPSECRET"}, make_context())
    assert excinfo.value.retryable is False
    assert "TOPSECRET" not in excinfo.value.message
    assert "TOPSECRET" not in str(excinfo.value)


def test_audit_log_excludes_payload_and_user_data(caplog):
    """审计日志只含 tool_name/run_id/project_id/duration_ms/outcome，不含 payload 与用户数据。"""
    registry = ToolRegistry()
    registry.register(make_spec(), lambda payload, context: {"echo": payload["message"]})
    with caplog.at_level(logging.INFO, logger="app.agent.tools"):
        registry.invoke("echo", {"message": "USERDATA"}, make_context(user_id="user-42"))
    records = [record for record in caplog.records if record.getMessage() == "agent_tool_invoked"]
    assert len(records) == 1
    record = records[0]
    assert record.tool_name == "echo"
    assert record.run_id == "run-1"
    assert record.project_id == 1
    assert isinstance(record.duration_ms, int)
    assert record.outcome == "success"
    # extra 字段白名单：payload 与用户数据键不得出现在日志记录上
    # （"message" 是 LogRecord 标准属性，非本模块 extra）。
    assert "payload" not in record.__dict__
    assert "user_id" not in record.__dict__
    assert "granted_scopes" not in record.__dict__
    assert "USERDATA" not in caplog.text
    assert "user-42" not in caplog.text
