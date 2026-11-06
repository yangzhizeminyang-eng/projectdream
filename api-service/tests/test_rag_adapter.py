"""受控 RAG 检索适配器测试：头部与绑定断言、错误映射、重试语义与 LangChain 形态。

全部用例通过 ``httpx.MockTransport`` 模拟 rag-service 响应，不发真实网络请求。
"""

import httpx
import pytest
from langchain_core.documents import Document

from app.rag_adapter import RagAdapterError, RagRetrieverAdapter, RagServiceRetriever


class _ResponseScript:
    """按调用序返回预设响应/异常的 MockTransport 处理器。

    :param scripts: 响应序列；元素为 httpx.Response 或 Exception 实例。
    """

    def __init__(self, scripts: list) -> None:
        self._scripts = scripts
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """记录请求并按序取出脚本。

        :param request: httpx 请求对象。
        :return: 脚本中预设的响应。
        :raises Exception: 脚本元素为异常时原样抛出（模拟传输层错误）。
        """
        self.requests.append(request)
        script = self._scripts[min(len(self.requests) - 1, len(self._scripts) - 1)]
        if isinstance(script, Exception):
            raise script
        return script


def _ok_response() -> httpx.Response:
    """构造标准成功响应（单条命中）。

    :return: httpx.Response（200，items 含一条场景命中）。
    """
    return httpx.Response(
        200,
        json={
            "items": [
                {
                    "text": "云海学园天台场景设定",
                    "score": 0.92,
                    "metadata": {"project_id": 5, "asset_id": 910, "episode_id": 1},
                }
            ]
        },
    )


def _adapter(script: _ResponseScript, **overrides) -> RagRetrieverAdapter:
    """构造注入 MockTransport 的适配器。

    :param script: 响应脚本。
    :param overrides: 覆盖构造参数（episode_id/max_retries 等）。
    :return: RagRetrieverAdapter 实例。
    """
    params = dict(base_url="http://rag.test", token="service-token", project_id=5)
    params.update(overrides)
    return RagRetrieverAdapter(
        **params,
        http_client=httpx.Client(transport=httpx.MockTransport(script)),
    )


def test_retrieve_success_sends_auth_headers_and_bound_project():
    """成功检索：令牌/调用方/请求 ID 头齐全，请求体携带构造绑定的 project_id。

    :return: 无返回值。
    :raises AssertionError: 头部缺失、project_id 不符或结果转换错误时抛出。
    """
    script = _ResponseScript([_ok_response()])
    adapter = _adapter(script)

    items = adapter.retrieve("天台场景 设定", top_k=5)

    assert len(script.requests) == 1
    request = script.requests[0]
    assert request.headers["X-RAG-Internal-Token"] == "service-token"
    assert request.headers["X-RAG-Caller-Id"] == "api-service-agent"
    assert request.headers["X-Request-Id"]
    body = request.read()
    assert b'"project_id":5' in body.replace(b" ", b"")
    assert len(items) == 1
    assert items[0]["metadata"]["asset_id"] == 910


def test_auth_failures_map_to_adapter_error_without_retry():
    """401/403 原样映射为 RagAdapterError（携带状态码，不重试、不泄露令牌）。

    :return: 无返回值。
    :raises AssertionError: 状态码、重试次数或消息脱敏不符时抛出。
    """
    for status in (401, 403):
        script = _ResponseScript([httpx.Response(status, json={"detail": "denied"})])
        adapter = _adapter(script)

        with pytest.raises(RagAdapterError) as exc_info:
            adapter.retrieve("查询文本")

        assert exc_info.value.status_code == status
        assert "service-token" not in exc_info.value.message
        assert len(script.requests) == 1  # 鉴权失败不重试


def test_rate_limited_retries_once_then_succeeds():
    """429 触发一次 0.2 秒退避重试，重试后成功返回。

    :return: 无返回值。
    :raises AssertionError: 重试次数、退避时长或结果不符时抛出。
    """
    script = _ResponseScript([httpx.Response(429, json={"detail": {"retry_after_seconds": 0.2}}), _ok_response()])
    adapter = _adapter(script)
    backoffs: list[float] = []
    adapter._sleep = backoffs.append

    items = adapter.retrieve("查询文本")

    assert len(script.requests) == 2
    assert backoffs == [0.2]
    assert items[0]["text"] == "云海学园天台场景设定"


def test_service_unavailable_retry_exhaustion_raises():
    """503 重试一次后仍失败：抛 RagAdapterError 且携带状态码。

    :return: 无返回值。
    :raises AssertionError: 重试次数或异常状态码不符时抛出。
    """
    script = _ResponseScript([httpx.Response(503), httpx.Response(503)])
    adapter = _adapter(script)
    adapter._sleep = lambda seconds: None

    with pytest.raises(RagAdapterError) as exc_info:
        adapter.retrieve("查询文本")

    assert len(script.requests) == 2
    assert exc_info.value.status_code == 503


def test_connection_error_retries_once_then_raises():
    """连接错误重试一次后仍失败：抛脱敏 RagAdapterError（无状态码）。

    :return: 无返回值。
    :raises AssertionError: 重试次数、退避次数或异常消息不符时抛出。
    """
    script = _ResponseScript([httpx.ConnectError("boom"), httpx.ConnectError("boom")])
    adapter = _adapter(script)
    backoffs: list[float] = []
    adapter._sleep = backoffs.append

    with pytest.raises(RagAdapterError) as exc_info:
        adapter.retrieve("查询文本")

    assert len(script.requests) == 2
    assert backoffs == [0.2]
    assert exc_info.value.status_code is None
    assert "ConnectError" in exc_info.value.message


def test_project_id_is_always_bound_constructor_value():
    """project_id 在签名上不暴露：多次检索与不同 top_k 下请求体恒为构造值。

    :return: 无返回值。
    :raises AssertionError: 请求体出现其他 project_id 或缺失绑定值时抛出。
    """
    script = _ResponseScript([_ok_response() for _ in range(3)])
    adapter = _adapter(script)

    adapter.retrieve("第一次查询", top_k=3)
    adapter.retrieve("第二次查询", top_k=10)

    assert len(script.requests) == 2
    for request in script.requests:
        payload = request.read()
        assert b'"project_id":5' in payload.replace(b" ", b"")
        assert b'"project_id":7' not in payload.replace(b" ", b"")
    assert adapter.project_id == 5


def test_empty_query_is_rejected_locally():
    """空 query 本地直接拒绝（不发起 HTTP 请求）。

    :return: 无返回值。
    :raises AssertionError: 未抛 RagAdapterError 或仍发请求时抛出。
    """
    script = _ResponseScript([_ok_response()])
    adapter = _adapter(script)

    with pytest.raises(RagAdapterError):
        adapter.retrieve("   ")

    assert script.requests == []


def test_retriever_invoke_supports_string_and_dict_forms():
    """LangChain 形态：invoke("文本") 与 invoke({"query": "文本"}) 均返回 Document。

    :return: 无返回值。
    :raises AssertionError: Document 内容/metadata 或入参兼容性不符时抛出。
    """
    script = _ResponseScript([_ok_response(), _ok_response()])
    adapter = _adapter(script)
    retriever = RagServiceRetriever(adapter, top_k=5)

    by_string = retriever.invoke("天台场景 设定")
    by_dict = retriever.invoke({"query": "天台场景 设定"})

    assert len(script.requests) == 2
    for documents in (by_string, by_dict):
        assert len(documents) == 1
        assert isinstance(documents[0], Document)
        assert documents[0].page_content == "云海学园天台场景设定"
        assert documents[0].metadata["project_id"] == 5
