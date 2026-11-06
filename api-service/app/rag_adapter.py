"""受控 RAG 检索适配器：api-service Agent 访问项目记忆的唯一通道。

安全声明（硬性边界）：
- 本模块**绝不直连 Milvus**。所有向量检索访问都必须经 rag-service 的 HTTP
  API（``POST /v1/query``），由服务端完成内部令牌校验（X-RAG-Internal-Token）、
  调用方 allowlist（X-RAG-Caller-Id）与项目隔离过滤（metadata filter）。
- ``project_id`` / ``episode_id`` 仅在构造时绑定，``retrieve`` 的签名不暴露
  项目参数，调用方在查询时**不可能**切换到其他项目。

重试语义（与"只对明确可重试错误重试"的纪律一致）：
- 仅连接级错误（``httpx.TransportError``，含连接失败与超时）与 HTTP 429 / 503
  触发一次重试（退避 0.2 秒）；
- 401 / 403 及其余 4xx / 5xx 原样映射为 :class:`RagAdapterError`（携带状态码与
  脱敏消息，不包含令牌与 query 全文）。

LangChain 兼容形态：:class:`RagServiceRetriever` 轻量继承
``langchain_core.retrievers.BaseRetriever``（仅覆写 ``_get_relevant_documents``，
无需 embedding 集成），因此同时提供 ``invoke("query")``（Runnable 标准）与
``invoke({"query": ...})``（工具式 dict 入参）两种调用方式。
"""

from __future__ import annotations

import time
import uuid
from typing import Any

import httpx
from langchain_core.documents import Document
from langchain_core.retrievers import BaseRetriever
from pydantic import PrivateAttr

#: 本适配器在 rag-service allowlist 中的固定调用方标识。
_CALLER_ID = "api-service-agent"
#: 可重试的 HTTP 状态码：限流与服务暂不可用。
_RETRYABLE_STATUS_CODES = frozenset({429, 503})
#: 重试退避时间（秒）。
_RETRY_BACKOFF_SECONDS = 0.2
#: 默认请求超时（秒）。
_DEFAULT_TIMEOUT_SECONDS = 15.0
#: 默认重试次数（额外重试 1 次，即总尝试 2 次）。
_DEFAULT_MAX_RETRIES = 1
#: top_k 上限（与 rag-service QueryRequest 的约束一致）。
_TOP_K_LIMIT = 20


class RagAdapterError(Exception):
    """RAG 服务访问失败异常。

    :param message: 脱敏后的错误说明；不含令牌与 query 全文。
    :param status_code: 失败对应的 HTTP 状态码；连接级错误为 None。
    """

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class RagRetrieverAdapter:
    """rag-service 检索适配器：构造绑定项目范围，仅暴露受控 retrieve 入口。

    :param base_url: rag-service 基础地址（如 ``http://127.0.0.1:8001``）。
    :param token: 内部服务令牌（对应环境变量 INTERNAL_TOKEN；仅随请求头发送，
        不进入日志与错误消息）。
    :param project_id: 绑定的项目 ID；构造后不可变更，检索始终限定该项目。
    :param episode_id: 可选绑定的分集 ID；缺省检索整个项目。
    :param timeout_seconds: 单次 HTTP 请求超时（默认 15 秒）。
    :param max_retries: 连接错误/429/503 的额外重试次数（默认 1）。
    :param http_client: 外部注入的 httpx.Client（测试注入 MockTransport）；
        缺省时内部创建并持有，``close()`` 时负责释放。
    :raises RagAdapterError: project_id 非正整数或 query 为空时抛出。
    """

    def __init__(
        self,
        *,
        base_url: str,
        token: str,
        project_id: int,
        episode_id: int | None = None,
        timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = _DEFAULT_MAX_RETRIES,
        http_client: httpx.Client | None = None,
    ) -> None:
        """构造适配器并绑定项目范围。

        :raises RagAdapterError: project_id 不是正整数时抛出。
        """
        if not isinstance(project_id, int) or project_id <= 0:
            raise RagAdapterError("project_id 必须是正整数")
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._project_id = project_id
        self._episode_id = episode_id
        self._max_retries = max(0, max_retries)
        # sleep 注入点：测试可替换为零延迟，避免用例真实退避。
        self._sleep = time.sleep
        self._owns_client = http_client is None
        self._client = http_client or httpx.Client(timeout=timeout_seconds)

    @property
    def project_id(self) -> int:
        """当前绑定的项目 ID（只读）。

        :return: 构造时绑定的 project_id。
        """
        return self._project_id

    def close(self) -> None:
        """释放内部持有的 httpx.Client（外部注入的客户端不负责关闭）。

        :return: 无返回值。
        """
        if self._owns_client:
            self._client.close()

    def retrieve(self, query: str, *, top_k: int = 5) -> list[dict[str, Any]]:
        """在绑定的项目范围内检索项目记忆。

        :param query: 检索查询文本（不可为空）。
        :param top_k: 返回条数上限（1-20，默认 5）。
        :return: rag-service 返回的 items 列表（text/score/metadata）。
        :raises RagAdapterError: query 为空、非 2xx 响应或连接失败时抛出；
            401/403 等鉴权失败不重试，429/503/连接错误重试一次后仍失败才抛出。
        """
        if not query or not query.strip():
            raise RagAdapterError("query 不能为空")
        payload: dict[str, Any] = {
            # project_id 只来自构造绑定值：查询层不存在跨项目入参。
            "project_id": self._project_id,
            "query": query,
            "top_k": max(1, min(top_k, _TOP_K_LIMIT)),
        }
        if self._episode_id is not None:
            payload["episode_id"] = self._episode_id
        headers = {
            "X-RAG-Internal-Token": self._token,
            "X-RAG-Caller-Id": _CALLER_ID,
            "X-Request-Id": uuid.uuid4().hex,
        }

        for attempt in range(self._max_retries + 1):
            try:
                response = self._client.post(
                    f"{self._base_url}/v1/query", json=payload, headers=headers
                )
            except httpx.TransportError as exc:
                if attempt < self._max_retries:
                    self._sleep(_RETRY_BACKOFF_SECONDS)
                    continue
                raise RagAdapterError(
                    f"rag-service 连接失败：{type(exc).__name__}"
                ) from exc
            if response.status_code == 200:
                items = response.json().get("items")
                if not isinstance(items, list):
                    raise RagAdapterError("rag-service 返回格式异常：items 缺失")
                return items
            if response.status_code in _RETRYABLE_STATUS_CODES and attempt < self._max_retries:
                self._sleep(_RETRY_BACKOFF_SECONDS)
                continue
            # 401/403 及其余错误：原样映射为脱敏异常，不重试。
            raise RagAdapterError(
                f"rag-service 查询失败：HTTP {response.status_code}",
                status_code=response.status_code,
            )
        raise RagAdapterError("rag-service 查询失败：重试耗尽")


class RagServiceRetriever(BaseRetriever):
    """LangChain BaseRetriever 形态的受控 RAG 检索器。

    BaseRetriever 只要求覆写 ``_get_relevant_documents``，无 embedding 集成
    负担，因此选择轻量继承（而非 duck-typing）：可直接进入 LCEL / Agent 的
    Runnable 组合。``invoke`` 同时兼容两种入参：
    - ``invoke("查询文本")``：Runnable 标准形态；
    - ``invoke({"query": "查询文本"})``：与 LangChain 工具一致的 dict 形态。

    项目隔离由内部 :class:`RagRetrieverAdapter` 的构造绑定保证。

    :param adapter: 已绑定项目范围的检索适配器。
    :param top_k: 每次检索返回的文档数上限（默认 5）。
    """

    top_k: int = 5
    _adapter: RagRetrieverAdapter = PrivateAttr()

    def __init__(self, adapter: RagRetrieverAdapter, *, top_k: int = 5) -> None:
        """绑定适配器构造检索器。

        :param adapter: RagRetrieverAdapter 实例。
        :param top_k: 返回文档数上限。
        """
        super().__init__(top_k=top_k)
        self._adapter = adapter

    def _get_relevant_documents(self, query: str) -> list[Document]:
        """执行检索并把 items 转换为 LangChain Document 列表。

        :param query: 检索查询文本。
        :return: Document 列表（page_content=text，metadata=rag metadata）。
        :raises RagAdapterError: 上游检索失败时原样传播。
        """
        items = self._adapter.retrieve(query, top_k=self.top_k)
        return [
            Document(
                page_content=str(item.get("text") or ""),
                metadata=dict(item.get("metadata") or {}),
            )
            for item in items
        ]

    def invoke(self, input: Any, config: Any = None, **kwargs: Any) -> list[Document]:
        """检索入口：兼容字符串与 ``{"query": ...}`` 字典两种形态。

        :param input: 查询字符串，或含 ``query`` 键的字典（取其余键忽略）。
        :param config: Runnable 配置（透传父类）。
        :param kwargs: 额外参数（透传父类）。
        :return: 检索到的 Document 列表。
        :raises RagAdapterError: 上游检索失败时原样传播。
        """
        if isinstance(input, dict):
            input = str(input.get("query") or "")
        return super().invoke(input, config=config, **kwargs)
