"""调用方网关测试：allowlist 三态、滑动窗口限流与窗口恢复、request_id 透传、审计脱敏。"""

import logging

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.gateway import CallerGate
from app.main import create_app

_QUERY_ENDPOINT = "/v1/query"
_VALID_HEADERS = {"X-RAG-Internal-Token": "service-token"}


def _settings(**overrides) -> Settings:
    """构造已配置运行时依赖的 Settings（依赖与令牌均为占位值）。

    :param overrides: 需要覆盖的字段（如 caller_allowlist / rate_limit_per_minute）。
    :return: Settings 实例。
    """
    base = dict(
        zhipu_api_key="runtime-secret",
        internal_token="service-token",
        milvus_uri="/tmp/projectdream.db",
    )
    base.update(overrides)
    return Settings(**base)


def _client(settings: Settings, monkeypatch) -> TestClient:
    """构造已 mock 掉真实索引/检索依赖的 TestClient。

    :param settings: 服务配置。
    :param monkeypatch: pytest 夹具。
    :return: TestClient 实例（业务端点返回固定成功结果）。
    """

    async def fake_index_documents(*args, **kwargs):
        """替换真实索引流程的桩函数。

        :param args: 位置参数（settings、文档列表等）。
        :param kwargs: 关键字参数。
        :return: 固定的索引计数结果。
        """
        return {"indexed": 1, "removed": 0, "updated": 1}

    async def fake_query_documents(*args, **kwargs):
        """替换真实检索流程的桩函数。

        :param args: 位置参数（settings 等）。
        :param kwargs: 关键字参数（project_id/query/top_k 等）。
        :return: 单条固定命中结果。
        """
        return [{"text": "hit", "score": 0.9, "metadata": {"project_id": 21}}]

    monkeypatch.setattr("app.main.index_documents", fake_index_documents)
    monkeypatch.setattr("app.main.query_documents", fake_query_documents)
    return TestClient(create_app(settings))


def _query_payload() -> dict:
    """构造合法查询请求体。

    :return: 含 project_id/query/top_k 的字典。
    """
    return {"project_id": 21, "query": "测试查询", "top_k": 3}


def test_allowlist_disabled_allows_missing_caller_id(monkeypatch):
    """allowlist 未配置（空）时不启用：缺失 X-RAG-Caller-Id 也放行。

    :param monkeypatch: pytest 夹具。
    :return: 无返回值。
    :raises AssertionError: 响应状态码非 200 时抛出。
    """
    client = _client(_settings(), monkeypatch)

    response = client.post(_QUERY_ENDPOINT, headers=_VALID_HEADERS, json=_query_payload())

    assert response.status_code == 200


def test_allowlist_enabled_requires_caller_id(monkeypatch):
    """allowlist 启用后缺失 X-RAG-Caller-Id 返回 401。

    :param monkeypatch: pytest 夹具。
    :return: 无返回值。
    :raises AssertionError: 状态码或 detail 不符时抛出。
    """
    client = _client(_settings(caller_allowlist="api-service-agent"), monkeypatch)

    response = client.post(_QUERY_ENDPOINT, headers=_VALID_HEADERS, json=_query_payload())

    assert response.status_code == 401


def test_allowlist_rejects_unknown_caller(monkeypatch):
    """allowlist 启用后不在名单的调用方返回 403。

    :param monkeypatch: pytest 夹具。
    :return: 无返回值。
    :raises AssertionError: 状态码或 detail 不符时抛出。
    """
    client = _client(_settings(caller_allowlist="api-service-agent"), monkeypatch)

    response = client.post(
        _QUERY_ENDPOINT,
        headers={**_VALID_HEADERS, "X-RAG-Caller-Id": "rogue-caller"},
        json=_query_payload(),
    )

    assert response.status_code == 403


def test_allowlist_accepts_listed_caller(monkeypatch):
    """allowlist 启用且调用方在名单内时放行。

    :param monkeypatch: pytest 夹具。
    :return: 无返回值。
    :raises AssertionError: 响应状态码非 200 时抛出。
    """
    client = _client(_settings(caller_allowlist="api-service-agent, scheduler"), monkeypatch)

    response = client.post(
        _QUERY_ENDPOINT,
        headers={**_VALID_HEADERS, "X-RAG-Caller-Id": "api-service-agent"},
        json=_query_payload(),
    )

    assert response.status_code == 200


def test_rate_limit_returns_429_with_retry_after(monkeypatch):
    """限流启用后第 3 次请求返回 429，detail 携带 retry_after_seconds。

    :param monkeypatch: pytest 夹具。
    :return: 无返回值。
    :raises AssertionError: 状态码或 retry_after 结构不符时抛出。
    """
    client = _client(_settings(rate_limit_per_minute=2), monkeypatch)

    first = client.post(_QUERY_ENDPOINT, headers=_VALID_HEADERS, json=_query_payload())
    second = client.post(_QUERY_ENDPOINT, headers=_VALID_HEADERS, json=_query_payload())
    third = client.post(_QUERY_ENDPOINT, headers=_VALID_HEADERS, json=_query_payload())

    assert first.status_code == 200
    assert second.status_code == 200
    assert third.status_code == 429
    assert "retry_after_seconds" in third.json()["detail"]
    assert third.json()["detail"]["retry_after_seconds"] >= 0


def test_rate_limit_disabled_allows_burst(monkeypatch):
    """rate_limit_per_minute=0 表示不限流：连续多次请求全部放行。

    :param monkeypatch: pytest 夹具。
    :return: 无返回值。
    :raises AssertionError: 任一请求非 200 时抛出。
    """
    client = _client(_settings(), monkeypatch)

    statuses = [
        client.post(_QUERY_ENDPOINT, headers=_VALID_HEADERS, json=_query_payload()).status_code
        for _ in range(5)
    ]

    assert statuses == [200] * 5


def test_rate_limit_window_recovers_after_sliding(monkeypatch):
    """滑动窗口滑出后限流自动恢复：假时钟推进 61 秒后可再次请求。

    :param monkeypatch: pytest 夹具（未直接使用，保持签名一致）。
    :return: 无返回值。
    :raises HTTPException: 窗口恢复前再次请求（不应发生）；恢复后请求成功。
    """
    clock = {"now": 1000.0}
    gate = CallerGate(_settings(rate_limit_per_minute=1), clock=lambda: clock["now"])

    gate.check_rate_limit("caller-a")  # 第 1 次进入窗口
    with pytest.raises(Exception):
        gate.check_rate_limit("caller-a")  # 同窗口第 2 次应超限
    clock["now"] += 61.0
    gate.check_rate_limit("caller-a")  # 窗口滑出后恢复放行


def test_rate_limit_buckets_are_isolated_per_caller():
    """限流按 caller id 分桶：A 桶打满不影响 B 桶。

    :return: 无返回值。
    :raises HTTPException: B 桶首次请求不应超限。
    """
    clock = {"now": 0.0}
    gate = CallerGate(_settings(rate_limit_per_minute=1), clock=lambda: clock["now"])

    gate.check_rate_limit("caller-a")
    gate.check_rate_limit("caller-b")  # 不同桶不受 A 桶影响


def test_request_id_header_passthrough_and_generation(monkeypatch):
    """外部 X-Request-Id 原样回传；缺失时生成 32 位 uuid4 hex。

    :param monkeypatch: pytest 夹具。
    :return: 无返回值。
    :raises AssertionError: 回传值或生成值格式不符时抛出。
    """
    client = _client(_settings(), monkeypatch)

    echoed = client.post(
        _QUERY_ENDPOINT,
        headers={**_VALID_HEADERS, "X-Request-Id": "req-123"},
        json=_query_payload(),
    )
    generated = client.post(_QUERY_ENDPOINT, headers=_VALID_HEADERS, json=_query_payload())

    assert echoed.headers["X-Request-Id"] == "req-123"
    generated_id = generated.headers["X-Request-Id"]
    assert len(generated_id) == 32
    assert all(char in "0123456789abcdef" for char in generated_id)
    assert generated_id != "req-123"


def test_audit_log_redacts_query_and_token(caplog, monkeypatch):
    """审计日志不含 query 全文与内部令牌；结构化行仅含长度字段。

    :param caplog: pytest 日志捕获夹具。
    :param monkeypatch: pytest 夹具。
    :return: 无返回值。
    :raises AssertionError: 任何日志行泄露全文/令牌或缺少结构化字段时抛出。
    """
    client = _client(_settings(), monkeypatch)
    long_query = "这是一条很长的查询文本用于验证脱敏纪律" * 20

    with caplog.at_level(logging.INFO, logger="rag.gateway"):
        response = client.post(
            _QUERY_ENDPOINT,
            headers=_VALID_HEADERS,
            json={"project_id": 21, "query": long_query, "top_k": 3},
        )

    assert response.status_code == 200
    joined = "\n".join(record.getMessage() for record in caplog.records)
    assert long_query not in joined
    assert "service-token" not in joined
    # 摘要行的 query 预览只保留前 32 字符 + 省略号。
    assert (long_query[:32] + "…") in joined
    structured = [record for record in caplog.records if record.getMessage() == "rag_request"]
    assert structured, "缺少 rag_request 结构化审计行"
    record = structured[-1]
    assert record.__dict__.get("query") is None
    assert getattr(record, "query_len", None) == len(long_query)
    assert getattr(record, "top_k", None) == 3
    assert getattr(record, "project_id", None) == 21
    assert getattr(record, "outcome", None) == "ok"
    for value in record.__dict__.values():
        assert "service-token" not in str(value)


def test_health_and_ready_are_not_rate_limited(monkeypatch):
    """/health 与 /ready 不经过限流与 allowlist（无令牌也可访问）。

    :param monkeypatch: pytest 夹具。
    :return: 无返回值。
    :raises AssertionError: /health 非 200 时抛出。
    """
    client = _client(_settings(caller_allowlist="api-service-agent", rate_limit_per_minute=1), monkeypatch)

    health = client.get("/health")

    assert health.status_code == 200
