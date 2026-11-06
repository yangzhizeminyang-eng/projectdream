"""模型提供方抽象与实现。

阶段 1 试点：为 LangGraph 编排图提供结构化输出模型调用。
- :class:`ModelProvider`：抽象基类，约定 ``complete_structured`` 接口。
- :class:`FakeStoryboardReviewProvider`：测试用固定响应实现（不发网络请求）。
- :class:`LangChainModelProvider`：基于 langchain_openai.ChatOpenAI 的
  OpenAI-compatible 实现（可指向任意 base_url）。

纪律：usage 必含 model/latency_ms/cost_status；禁止伪造 cost 金额——
成本未接入计费体系时一律 ``cost_status="unavailable"``。
"""

from __future__ import annotations

import os
import time
from abc import ABC, abstractmethod
from typing import Any

from pydantic import BaseModel, ValidationError

from app.agent.errors import AgentError, ModelOutputError
from langchain_openai import ChatOpenAI

# 环境变量名约定（部署时通过环境注入，不落代码仓库）。
ENV_API_KEY = "AGENT_MODEL_API_KEY"
ENV_BASE_URL = "AGENT_MODEL_BASE_URL"
ENV_MODEL_NAME = "AGENT_MODEL_NAME"
ENV_TIMEOUT_SECONDS = "AGENT_MODEL_TIMEOUT_SECONDS"
DEFAULT_TIMEOUT_SECONDS = 30.0


class ModelProvider(ABC):
    """结构化输出模型提供方抽象。"""

    @abstractmethod
    def complete_structured(
        self,
        *,
        system: str,
        user: str,
        schema_model: type[BaseModel],
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> tuple[BaseModel, dict[str, Any]]:
        """发起一次结构化补全。

        :param system: system 提示词。
        :param user: user 提示词。
        :param schema_model: 输出 pydantic 模型类型。
        :param timeout_seconds: 单次调用超时（秒）。
        :returns: (校验后的模型实例, usage dict)；usage 必含 model/latency_ms/cost_status。
        :raises ModelOutputError: 模型调用或输出解析/校验失败。
        """


class FakeStoryboardReviewProvider(ModelProvider):
    """测试用固定响应模型提供方（不发网络请求）。

    :param response: 固定响应 dict，将按 schema_model 校验后返回。
    :param fail_times: 前 N 次调用抛 ModelOutputError，模拟解析失败。
    :param latency_ms: usage 中回填的固定时延。
    """

    def __init__(
        self,
        response: dict[str, Any] | None = None,
        fail_times: int = 0,
        latency_ms: int = 0,
    ) -> None:
        """初始化固定响应配置。

        :param response: 固定响应 dict。
        :param fail_times: 模拟失败次数。
        :param latency_ms: 固定时延（毫秒）。
        """
        self._response = response if response is not None else {}
        self._fail_times = fail_times
        self._latency_ms = latency_ms
        self.calls = 0

    def complete_structured(
        self,
        *,
        system: str,
        user: str,
        schema_model: type[BaseModel],
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> tuple[BaseModel, dict[str, Any]]:
        """返回固定响应或模拟解析失败。

        :param system: system 提示词（忽略）。
        :param user: user 提示词（忽略）。
        :param schema_model: 输出 pydantic 模型类型。
        :param timeout_seconds: 单次调用超时（忽略）。
        :returns: (校验后的模型实例, usage dict)。
        :raises ModelOutputError: 处于模拟失败次数内，或固定响应不满足目标 schema。
        """
        self.calls += 1
        if self.calls <= self._fail_times:
            raise ModelOutputError(f"fake provider 第 {self.calls} 次调用模拟解析失败")
        try:
            instance = schema_model.model_validate(self._response)
        except ValidationError as exc:
            raise ModelOutputError("fake provider 固定响应不满足目标 schema") from exc
        usage = {
            "model": "fake-storyboard-review",
            "latency_ms": self._latency_ms,
            "cost_status": "unavailable",
        }
        return instance, usage


class LangChainModelProvider(ModelProvider):
    """基于 langchain_openai.ChatOpenAI 的 OpenAI-compatible 模型提供方。

    配置优先取显式参数，缺省回退到环境变量：
    AGENT_MODEL_API_KEY / AGENT_MODEL_BASE_URL / AGENT_MODEL_NAME /
    AGENT_MODEL_TIMEOUT_SECONDS（解析失败回退 30 秒）。

    :param api_key: 显式注入的 API key；缺省读环境变量。
    :param base_url: 显式注入的 base_url；缺省读环境变量（可空，走官方默认端点）。
    :param model_name: 显式注入的模型名；缺省读环境变量。
    :param timeout_seconds: 显式注入超时；缺省读环境变量。
    :raises AgentError: 未配置 API key 或模型名。
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        model_name: str | None = None,
        timeout_seconds: float | None = None,
    ) -> None:
        """解析配置并构造 ChatOpenAI 客户端（不发起任何网络请求）。

        :param api_key: 显式 API key。
        :param base_url: 显式 base_url。
        :param model_name: 显式模型名。
        :param timeout_seconds: 显式超时秒数。
        :raises AgentError: API key 或模型名缺失。
        """
        self._api_key = (api_key or os.environ.get(ENV_API_KEY, "")).strip()
        resolved_base_url = (base_url or os.environ.get(ENV_BASE_URL, "")).strip() or None
        self.model_name = (model_name or os.environ.get(ENV_MODEL_NAME, "")).strip()
        raw_timeout = (
            timeout_seconds if timeout_seconds is not None else os.environ.get(ENV_TIMEOUT_SECONDS, "")
        )
        try:
            self.timeout_seconds = (
                float(raw_timeout) if str(raw_timeout).strip() else DEFAULT_TIMEOUT_SECONDS
            )
        except (TypeError, ValueError):
            self.timeout_seconds = DEFAULT_TIMEOUT_SECONDS
        if not self._api_key:
            raise AgentError("未配置 AGENT_MODEL_API_KEY，无法初始化模型提供方")
        if not self.model_name:
            raise AgentError("未配置 AGENT_MODEL_NAME，无法初始化模型提供方")
        # ChatOpenAI 构造只建立客户端配置，真实网络调用发生在 complete_structured。
        self._client = ChatOpenAI(
            model=self.model_name,
            api_key=self._api_key,
            base_url=resolved_base_url,
            timeout=self.timeout_seconds,
        )

    def complete_structured(
        self,
        *,
        system: str,
        user: str,
        schema_model: type[BaseModel],
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> tuple[BaseModel, dict[str, Any]]:
        """发起一次结构化补全并提取 usage。

        :param system: system 提示词。
        :param user: user 提示词。
        :param schema_model: 输出 pydantic 模型类型。
        :param timeout_seconds: 单次调用超时（秒）。
        :returns: (校验后的模型实例, usage dict)；token 用量可得时 cost_status="recorded"。
        :raises ModelOutputError: 调用失败、输出解析失败或与目标 schema 不符。
        """
        started = time.perf_counter()
        try:
            runnable = self._client.with_structured_output(schema_model, include_raw=True)
            output = runnable.invoke(
                [("system", system), ("user", user)],
                config={"timeout": timeout_seconds},
            )
        except Exception as exc:
            raise ModelOutputError("模型结构化输出调用失败") from exc
        if not isinstance(output, dict) or output.get("parsing_error") is not None:
            raise ModelOutputError("模型输出未能解析为结构化结果")
        parsed = output.get("parsed")
        if not isinstance(parsed, schema_model):
            raise ModelOutputError("模型输出与目标 schema 不符")
        latency_ms = int((time.perf_counter() - started) * 1000)
        return parsed, self._extract_usage(output.get("raw"), latency_ms)

    def _extract_usage(self, raw_message: Any, latency_ms: int) -> dict[str, Any]:
        """从原始 AIMessage 提取 token 用量，构造脱敏 usage。

        :param raw_message: include_raw=True 时的原始 AIMessage（可能为 None）。
        :param latency_ms: 本次调用时延（毫秒）。
        :returns: usage dict；token 可得时 cost_status="recorded" 并含
            prompt_tokens/completion_tokens，否则 "unavailable"。
        """
        metadata = getattr(raw_message, "response_metadata", None)
        token_usage = metadata.get("token_usage") if isinstance(metadata, dict) else None
        usage_metadata = getattr(raw_message, "usage_metadata", None) or {}
        prompt_tokens = (token_usage or {}).get("prompt_tokens")
        completion_tokens = (token_usage or {}).get("completion_tokens")
        if prompt_tokens is None:
            prompt_tokens = usage_metadata.get("input_tokens")
        if completion_tokens is None:
            completion_tokens = usage_metadata.get("output_tokens")
        usage: dict[str, Any] = {
            "model": self.model_name,
            "latency_ms": latency_ms,
            "cost_status": "unavailable",
        }
        if prompt_tokens is not None or completion_tokens is not None:
            usage["cost_status"] = "recorded"
            if prompt_tokens is not None:
                usage["prompt_tokens"] = prompt_tokens
            if completion_tokens is not None:
                usage["completion_tokens"] = completion_tokens
        return usage
