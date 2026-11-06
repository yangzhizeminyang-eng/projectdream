"""模型提供方单元测试（不发任何真实网络请求）。

覆盖：Fake 成功/失败路径、usage 形状、LangChainModelProvider 未配置抛错 +
配置齐全时可构造（monkeypatch 环境变量）。
"""

import pytest
from pydantic import BaseModel

from app.agent.errors import AgentError, ModelOutputError
from app.agent.model_provider import FakeStoryboardReviewProvider, LangChainModelProvider


class ReviewOutput(BaseModel):
    """测试用结构化输出 schema。

    :param verdict: 审查结论。
    :param score: 分数，缺省 0。
    """

    verdict: str
    score: int = 0


def test_fake_provider_success_returns_validated_instance_and_usage():
    """Fake 成功路径：返回按 schema 校验后的实例与完整 usage 形状。"""
    provider = FakeStoryboardReviewProvider(response={"verdict": "pass", "score": 9}, latency_ms=12)
    instance, usage = provider.complete_structured(system="s", user="u", schema_model=ReviewOutput)
    assert instance.verdict == "pass"
    assert instance.score == 9
    assert usage["model"] == "fake-storyboard-review"
    assert usage["latency_ms"] == 12
    assert usage["cost_status"] == "unavailable"
    assert set(usage) == {"model", "latency_ms", "cost_status"}


def test_fake_provider_fails_first_n_times_then_recovers():
    """Fake 失败路径：前 fail_times 次抛 ModelOutputError，之后恢复成功。"""
    provider = FakeStoryboardReviewProvider(response={"verdict": "pass"}, fail_times=2)
    for _ in range(2):
        with pytest.raises(ModelOutputError):
            provider.complete_structured(system="s", user="u", schema_model=ReviewOutput)
    instance, _usage = provider.complete_structured(system="s", user="u", schema_model=ReviewOutput)
    assert instance.verdict == "pass"
    assert provider.calls == 3


def test_fake_provider_invalid_response_raises_model_output_error():
    """固定响应不满足 schema 时抛 ModelOutputError。"""
    provider = FakeStoryboardReviewProvider(response={"score": 1})
    with pytest.raises(ModelOutputError):
        provider.complete_structured(system="s", user="u", schema_model=ReviewOutput)


def test_langchain_provider_requires_api_key(monkeypatch):
    """未配置 AGENT_MODEL_API_KEY 时构造抛 AgentError。"""
    monkeypatch.delenv("AGENT_MODEL_API_KEY", raising=False)
    with pytest.raises(AgentError):
        LangChainModelProvider()


def test_langchain_provider_constructs_with_full_config(monkeypatch):
    """配置齐全（含非法超时回退默认）时可构造，且不发起任何网络请求。"""
    monkeypatch.setenv("AGENT_MODEL_API_KEY", "test-key")
    monkeypatch.setenv("AGENT_MODEL_BASE_URL", "http://127.0.0.1:9/v1")
    monkeypatch.setenv("AGENT_MODEL_NAME", "fake-model")
    monkeypatch.setenv("AGENT_MODEL_TIMEOUT_SECONDS", "5")
    provider = LangChainModelProvider()
    assert provider.model_name == "fake-model"
    assert provider.timeout_seconds == 5.0

    # 超时环境变量非法时回退默认 30 秒（构造仍不触发网络）。
    monkeypatch.setenv("AGENT_MODEL_TIMEOUT_SECONDS", "not-a-number")
    fallback = LangChainModelProvider()
    assert fallback.timeout_seconds == 30.0


def test_langchain_provider_requires_model_name(monkeypatch):
    """API key 就绪但缺模型名时构造抛 AgentError。"""
    monkeypatch.setenv("AGENT_MODEL_API_KEY", "test-key")
    monkeypatch.delenv("AGENT_MODEL_NAME", raising=False)
    with pytest.raises(AgentError):
        LangChainModelProvider()
