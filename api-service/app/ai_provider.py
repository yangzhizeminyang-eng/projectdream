"""文本模型提供方（FastAPI-Only 迁移第三阶段第三组 · 任务 C）。

逐行为复刻 Node ``server/services/ai/config.mjs`` 与 ``server/services/ai/provider.mjs``：
统一完成配置检查 → POST ``{baseUrl}/chat/completions`` → 超时处理 → HTTP 错误
文案映射 → JSON 容错解析。mock 模式（``AI_PROVIDER=mock``，默认）不发起任何
真实请求——与 Node 一致，由调用方决定走本地兜底还是抛可诊断错误。

与 ``app/agent/model_provider.py`` 的关系：后者面向 LangGraph 结构化输出的
试点（pydantic schema），本模块面向 Node 同形生成链路（自由 JSON + 容错解析），
两者并行不互相替代。
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any

import httpx

# 长任务集合（Node provider.mjs LONG_TASKS）：这些 task 使用长超时。
LONG_TASKS = frozenset(
    {"story-bible", "outline", "season-structure", "script", "storyboard", "scene-extraction", "characters"}
)


class AiProviderError(Exception):
    """AI 调用统一错误包装（对齐 Node AiProviderError）。

    :ivar status: 上游 HTTP 状态码（网络错误时为 0）。
    :ivar detail: 受控诊断细节（不入响应 message）。
    """

    def __init__(self, message: str, *, status: int = 0, detail: str = "") -> None:
        """初始化错误。

        :param message: 面向用户的受控错误文案。
        :param status: 上游 HTTP 状态码。
        :param detail: 诊断细节。
        """
        super().__init__(message)
        self.status = status
        self.detail = detail


class AiConfig:
    """文本模型运行配置（对齐 Node getAiConfig 返回结构）。

    :ivar provider: 供应商标识（mock / 其他任意值视为真实模式）。
    :ivar base_url: OpenAI-compatible 端点（尾斜杠已剥离）。
    :ivar api_key: 接口密钥。
    :ivar default_model: 默认模型。
    :ivar outline_model / script_model / storyboard_model / character_model: 分任务模型覆盖。
    :ivar timeout_ms: 普通任务超时毫秒。
    :ivar long_task_timeout_ms: 长任务超时毫秒。
    :ivar fallback_to_mock: 真实调用失败时是否回退 mock 生成。
    """

    def __init__(self, *, provider: str, base_url: str, api_key: str, default_model: str,
                 outline_model: str, script_model: str, storyboard_model: str, character_model: str,
                 timeout_ms: int, long_task_timeout_ms: int, fallback_to_mock: bool) -> None:
        """保存配置字段（字段含义见类注释）。"""
        self.provider = provider
        self.base_url = base_url
        self.api_key = api_key
        self.default_model = default_model
        self.outline_model = outline_model
        self.script_model = script_model
        self.storyboard_model = storyboard_model
        self.character_model = character_model
        self.timeout_ms = timeout_ms
        self.long_task_timeout_ms = long_task_timeout_ms
        self.fallback_to_mock = fallback_to_mock


def _env_bool(value: str | None, default: bool) -> bool:
    """Node parseBoolean：1/true/yes/on → True；0/false/no/off → False；其余默认。"""
    if value is None or value == "":
        return default
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _env_positive_int(value: str | None, default: int) -> int:
    """Node parsePositiveInt：正整数才收，否则默认值。"""
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def get_ai_config(env: dict[str, str] | None = None) -> AiConfig:
    """读取文本模型配置（对齐 Node getAiConfig，环境变量名逐字一致）。

    :param env: 环境变量快照；缺省读 os.environ。
    :returns: :class:`AiConfig` 实例。
    """
    source = os.environ if env is None else env
    timeout_ms = _env_positive_int(source.get("AI_TIMEOUT_MS"), 60000)
    return AiConfig(
        provider=str(source.get("AI_PROVIDER") or "mock").strip().lower(),
        base_url=re.sub(r"/+$", "", str(source.get("AI_BASE_URL") or "").strip()),
        api_key=str(source.get("AI_API_KEY") or "").strip(),
        default_model=str(source.get("AI_MODEL") or "gpt-5.4").strip(),
        outline_model=str(source.get("AI_MODEL_OUTLINE") or source.get("AI_MODEL") or "gpt-5.4").strip(),
        script_model=str(source.get("AI_MODEL_SCRIPT") or source.get("AI_MODEL") or "gpt-5.4").strip(),
        storyboard_model=str(source.get("AI_MODEL_STORYBOARD") or source.get("AI_MODEL") or "gpt-5.4").strip(),
        character_model=str(source.get("AI_MODEL_CHARACTER") or source.get("AI_MODEL") or "gpt-5.4").strip(),
        timeout_ms=timeout_ms,
        long_task_timeout_ms=_env_positive_int(
            source.get("AI_LONG_TASK_TIMEOUT_MS"), max(timeout_ms, 180000)
        ),
        fallback_to_mock=_env_bool(source.get("AI_FALLBACK_TO_MOCK"), True),
    )


def is_mock_provider(config: AiConfig) -> bool:
    """Node isMockProvider：provider === 'mock' 视为本地演示模式。"""
    return config.provider == "mock"


def resolve_ai_request_timeout_ms(config: AiConfig, task: str) -> int:
    """Node resolveAiRequestTimeoutMs：长任务取 max(long, normal)。"""
    if str(task or "").strip() in LONG_TASKS:
        return max(config.long_task_timeout_ms or config.timeout_ms, config.timeout_ms)
    return config.timeout_ms


def describe_ai_request_error(error: Any, task: str, status: int = 0) -> str:
    """Node describeAiRequestError：把上游异常翻译成受控中文文案。

    :param error: 上游异常（含 message 属性或字符串）。
    :param task: 任务标识（story-bible 有专属文案）。
    :param status: 上游 HTTP 状态码。
    :returns: 受控错误文案（不泄漏密钥）。
    """
    detail = _upstream_detail(error).lower()
    if _is_timeout_error(error):
        prefix = "故事设定" if task == "story-bible" else "AI"
        return f"{prefix}生成超时，上游模型处理时间较长，请稍后重试。"
    if status in (401, 403) or re.search(r"unauthorized|invalid api key|authentication|鉴权|密钥", detail):
        return "文本模型接口密钥无效或无权限，请打开模型设置检查文本服务商和接口密钥。"
    if status == 402 or re.search(r"insufficient account balance|insufficient balance|余额不足|quota|额度", detail):
        return "文本模型额度不足，请打开模型设置更换可用账号或充值后重试。"
    if re.search(r"fetch failed|econnrefused|enotfound|connect timeout|socket", detail):
        return "文本模型接口暂时无法连接，请打开模型设置检查接口地址，确认服务可访问后重试。"
    return f"AI 请求失败：{_upstream_detail(error) or '上游服务未返回具体原因'}"


def _upstream_detail(error: Any) -> str:
    """Node normalizeUpstreamDetail：error.message 或 error 本身的字符串化。"""
    if isinstance(error, Exception):
        return str(error).strip()
    return str(error or "").strip()


def _is_timeout_error(error: Any) -> bool:
    """Node isTimeoutError：TimeoutError / ETIMEDOUT / UND_ERR_HEADERS_TIMEOUT。"""
    name = getattr(error, "name", "") or type(error).__name__
    code = getattr(error, "code", "") or ""
    return name in {"TimeoutError", "ConnectTimeout", "ReadTimeout", "WriteTimeout", "PoolTimeout"} or code in {
        "ETIMEDOUT",
        "UND_ERR_HEADERS_TIMEOUT",
    }


def _strip_code_fence(text: str) -> str:
    """Node stripCodeFence：剥离 ```json ... ``` 外层标记。"""
    raw = str(text or "").strip()
    if not raw.startswith("```"):
        return raw
    return re.sub(r"\s*```$", "", re.sub(r"^```(?:json)?\s*", "", raw, count=1, flags=re.I)).strip()


def _extract_json_text(text: str) -> str:
    """Node extractJsonText：从自然语言回复中截取最外层 JSON 片段。"""
    raw = _strip_code_fence(text)
    first_brace = raw.find("{")
    first_bracket = raw.find("[")
    starts = [n for n in (first_brace, first_bracket) if n >= 0]
    if not starts:
        return raw
    start = min(starts)
    end = max(raw.rfind("}"), raw.rfind("]"))
    if end < start:
        return raw[start:].strip()
    return raw[start : end + 1].strip()


def _find_balanced_json_candidates(text: str) -> list[str]:
    """Node findBalancedJsonCandidates：括号配对扫描全部候选 JSON 串。"""
    raw = _strip_code_fence(text)
    candidates: list[str] = []
    for start in range(len(raw)):
        if raw[start] not in "{[":
            continue
        stack: list[str] = []
        in_string = False
        escaped = False
        for index in range(start, len(raw)):
            char = raw[index]
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
                continue
            if char == '"':
                in_string = True
            elif char in "{[":
                stack.append(char)
            elif char in "}]":
                expected = "{" if char == "}" else "["
                if not stack or stack[-1] != expected:
                    break
                stack.pop()
                if not stack:
                    candidates.append(raw[start : index + 1].strip())
                    break
    return candidates


def parse_json_payload(text: str) -> Any:
    """Node parseJsonPayload：容错解析模型输出；全部候选失败抛 AiProviderError。

    :param text: 模型原始输出。
    :returns: 解析后的 JSON 值。
    :raises AiProviderError: 无法解析出合法 JSON。
    """
    json_text = _extract_json_text(text)
    candidates = [json_text, *_find_balanced_json_candidates(text)]
    for candidate in candidates:
        if not candidate:
            continue
        try:
            return json.loads(candidate)
        except ValueError:
            continue
    raise AiProviderError("AI 返回内容不是合法 JSON", detail=str(text or "")[:600])


async def generate_structured_json(
    *,
    task: str,
    system_prompt: str,
    user_prompt: str,
    client: httpx.AsyncClient,
    config: AiConfig | None = None,
    model: str | None = None,
    temperature: float = 0.7,
    response_format: dict[str, str] | None = None,
    max_tokens: int | None = None,
    thinking: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Node generateStructuredJson 的 async Python 复刻（请求体构造逐字段一致）。

    :param task: 任务标识（决定超时档位与错误文案）。
    :param system_prompt: system 提示词。
    :param user_prompt: user 提示词。
    :param client: 注入的 httpx.AsyncClient（测试用 MockTransport 替换）。
    :param config: AI 配置；缺省读环境。
    :param model: 模型覆盖；缺省用 default_model。
    :param temperature: 采样温度。
    :param response_format: OpenAI response_format（如 {"type": "json_object"}）。
    :param max_tokens: 输出 token 预算。
    :param thinking: 思考模式开关（对齐 Node payload.thinking）。
    :returns: ``{"content", "json", "raw"}``。
    :raises AiProviderError: 配置缺失 / 网络失败 / HTTP 错误 / 空 content / JSON 解析失败。
    """
    active_config = config or get_ai_config()
    if is_mock_provider(active_config):
        raise AiProviderError("当前 AI_PROVIDER=mock，不执行真实模型调用")
    if not active_config.base_url:
        raise AiProviderError("缺少 AI_BASE_URL 配置")
    if not active_config.api_key:
        raise AiProviderError("缺少 AI_API_KEY 配置")
    model_name = str(model or active_config.default_model or "").strip()
    if not model_name:
        raise AiProviderError("缺少 AI_MODEL 配置")

    payload: dict[str, Any] = {
        "model": model_name,
        "temperature": temperature,
        "messages": [
            {"role": "system", "content": str(system_prompt or "").strip()},
            {"role": "user", "content": str(user_prompt or "").strip()},
        ],
    }
    if response_format:
        payload["response_format"] = response_format
    if isinstance(max_tokens, int) and max_tokens > 0:
        payload["max_tokens"] = max_tokens
    if thinking:
        payload["thinking"] = thinking

    url = f"{active_config.base_url}/chat/completions"
    started = time.perf_counter()
    try:
        response = await client.post(
            url,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {active_config.api_key}",
            },
            json=payload,
            timeout=resolve_ai_request_timeout_ms(active_config, task) / 1000,
        )
    except httpx.HTTPError as exc:
        diagnostic = " ".join(
            [
                f"url={url}",
                f"model={model_name}",
                f"error={type(exc).__name__}",
                f"detail={_upstream_detail(exc)}",
            ]
        )
        raise AiProviderError(describe_ai_request_error(exc, task), detail=diagnostic) from exc

    text = response.text
    try:
        raw = json.loads(text) if text else None
    except ValueError:
        raw = None
    if response.status_code >= 400:
        detail = (
            (raw or {}).get("error", {}).get("message")
            if isinstance(raw, dict)
            else None
        ) or (raw.get("message") if isinstance(raw, dict) else None) or (
            raw.get("detail") if isinstance(raw, dict) else None
        ) or text[:400] or f"HTTP {response.status_code}"
        raise AiProviderError(
            describe_ai_request_error(_UpstreamMessage(detail), task, response.status_code),
            status=response.status_code,
            detail=detail,
        )

    content_value = (raw or {}).get("choices", [{}])[0].get("message", {}).get("content")
    if isinstance(content_value, list):
        content_value = "".join(
            part if isinstance(part, str) else (part or {}).get("text") or "" for part in content_value
        )
    if not content_value or not str(content_value).strip():
        raise AiProviderError("AI 没有返回有效内容")
    return {
        "content": str(content_value),
        "json": parse_json_payload(str(content_value)),
        "raw": raw,
        "latency_ms": int((time.perf_counter() - started) * 1000),
    }


class _UpstreamMessage(Exception):
    """把上游错误文本包装成异常（复用 describe_ai_request_error 的匹配逻辑）。"""
