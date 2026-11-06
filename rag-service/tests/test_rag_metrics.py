"""轻量指标测试：/metrics 渲染与计数增长、分位计算、embedding/Milvus 异常计数与重抛。

全部用例不依赖真实 Milvus / 智谱 API：成功路径通过 fake embedding 客户端与
BasePydanticVectorStore 子类穿透 rag 层；异常路径通过 monkeypatch 抛错验证
"计数后原样重抛" 语义。
"""

import asyncio

import pytest
from fastapi.testclient import TestClient
from llama_index.core.schema import TextNode
from llama_index.core.vector_stores.types import (
    BasePydanticVectorStore,
    VectorStoreQuery,
    VectorStoreQueryResult,
)
from pydantic import PrivateAttr

from app.config import Settings
from app.main import create_app
from app.metrics import (
    EMBEDDING_ERRORS_TOTAL,
    MILVUS_ERRORS_TOTAL,
    QUERY_HITS_TOTAL,
    REQUESTS_TOTAL,
    MetricsRegistry,
    get_metrics,
    reset_metrics,
)
from app.rag import _CountedEmbeddingClient, index_documents, query_documents
from app.zhipu_embedding import ZhipuLlamaIndexEmbedding


@pytest.fixture(autouse=True)
def _reset_registry():
    """每个用例前后重置进程级指标单例，避免跨用例串数。

    :return: 无返回值（生成器夹具）。
    """
    reset_metrics()
    yield
    reset_metrics()


class _FakeEmbeddingClient:
    """假 embedding 客户端：返回固定 3 维向量，不发起任何网络请求。"""

    #: ZhipuLlamaIndexEmbedding 构造时会读取的模型名占位。
    model = "embedding-3"

    def embed_sync(self, texts: list[str]) -> list[list[float]]:
        """同步取向量的桩实现。

        :param texts: 待向量化文本列表。
        :return: 与输入等长的固定 3 维向量列表。
        """
        return [[0.1, 0.0, 0.0] for _ in texts]

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """异步取向量的桩实现。

        :param texts: 待向量化文本列表。
        :return: 与输入等长的固定 3 维向量列表。
        """
        return [[0.1, 0.0, 0.0] for _ in texts]


class _FakeVectorStore(BasePydanticVectorStore):
    """假向量库：通过 llama_index 的类型检查，add/query 全部内存化。"""

    stores_text: bool = True
    _added: list = PrivateAttr(default_factory=list)

    @property
    def client(self):
        """抽象属性桩。

        :return: None（测试不需要真实客户端）。
        """
        return None

    def add(self, nodes, **kwargs) -> list[str]:
        """内存记录新增节点。

        :param nodes: 待写入节点序列。
        :param kwargs: 兼容性关键字参数。
        :return: 节点 ID 列表。
        """
        self._added.extend(nodes)
        return [node.node_id for node in nodes]

    def delete(self, ref_doc_id: str, **kwargs) -> None:
        """删除桩实现（空操作）。

        :param ref_doc_id: 文档 ID。
        :param kwargs: 兼容性关键字参数。
        :return: 无返回值。
        """
        return None

    def query(self, query: VectorStoreQuery, **kwargs) -> VectorStoreQueryResult:
        """返回单条固定命中（项目 21 的场景资产）。

        :param query: 向量查询对象（忽略）。
        :param kwargs: 兼容性关键字参数。
        :return: 单节点命中结果。
        """
        node = TextNode(
            text="命中场景文本",
            metadata={
                "project_id": 21,
                "episode_id": 1,
                "asset_type": "scene",
                "asset_id": "p21-scene-fake",
                "asset_version": 1,
                "source": "confirmed_asset",
            },
        )
        return VectorStoreQueryResult(nodes=[node], similarities=[0.92])


def _rag_settings() -> Settings:
    """构造小维度（3 维）的本地 Settings，避免真实维度约束。

    :return: Settings 实例。
    """
    return Settings(
        zhipu_api_key="runtime-secret",
        internal_token="service-token",
        milvus_uri="/tmp/projectdream.db",
        milvus_dim=3,
        zhipu_dimensions=3,
    )


def _app_client(monkeypatch) -> TestClient:
    """构造 main 层依赖已 mock 的 TestClient。

    :param monkeypatch: pytest 夹具。
    :return: TestClient 实例（业务端点固定成功）。
    """

    async def fake_index_documents(*args, **kwargs):
        """索引桩：返回固定计数。

        :param args: 位置参数。
        :param kwargs: 关键字参数。
        :return: 固定索引计数。
        """
        return {"indexed": 1, "removed": 0, "updated": 1}

    async def fake_query_documents(*args, **kwargs):
        """检索桩：返回两条固定命中。

        :param args: 位置参数。
        :param kwargs: 关键字参数。
        :return: 两条命中结果。
        """
        return [{"text": "hit", "score": 0.9, "metadata": {"project_id": 21}}] * 2

    monkeypatch.setattr("app.main.index_documents", fake_index_documents)
    monkeypatch.setattr("app.main.query_documents", fake_query_documents)
    return TestClient(create_app(Settings(zhipu_api_key="k", internal_token="service-token", milvus_uri="/tmp/x.db")))


def test_metrics_endpoint_reports_counters_and_growth(monkeypatch):
    """/metrics 输出计数键且数值随调用增长；延迟分位键存在。

    :param monkeypatch: pytest 夹具。
    :return: 无返回值。
    :raises AssertionError: 关键键缺失或数值未增长时抛出。
    """
    client = _app_client(monkeypatch)
    # 预置延迟样本：真实延迟由 rag 层成功路径采样（见 rag 层用例），
    # 端到端这里验证渲染逻辑与分位键存在。
    get_metrics().observe_latency_seconds(0.012)

    headers = {"X-RAG-Internal-Token": "service-token"}
    payload = {"project_id": 21, "query": "测试查询", "top_k": 3}
    first = client.post("/v1/query", headers=headers, json=payload)
    second = client.post("/v1/query", headers=headers, json=payload)
    body = client.get("/metrics").text

    assert first.status_code == 200 and second.status_code == 200
    assert 'rag_requests_total{endpoint="/v1/query",outcome="ok"} 2' in body
    assert 'rag_request_latency_seconds{quantile="0.5"}' in body
    assert 'rag_request_latency_seconds{quantile="0.95"}' in body
    assert 'rag_request_latency_seconds{quantile="0.99"}' in body
    assert "rag_embedding_errors_total" not in body  # 无异常时不渲染错误计数
    # 拒绝请求计入 denied 桶。
    denied = client.post("/v1/query", headers={"X-RAG-Internal-Token": "wrong"}, json=payload)
    body_after_denied = client.get("/metrics").text
    assert denied.status_code == 403
    assert 'rag_requests_total{endpoint="/v1/query",outcome="denied"} 1' in body_after_denied


def test_latency_quantiles_use_nearest_rank():
    """分位计算采用最近排名法：3 个样本的 P50/P95/P99 精确可验证。

    :return: 无返回值。
    :raises AssertionError: 分位值与最近排名法不一致时抛出。
    """
    registry = MetricsRegistry()
    for value in (0.3, 0.1, 0.2):
        registry.observe_latency_seconds(value)

    # 排序后 [0.1, 0.2, 0.3]：P50→ceil(1.5)-1=1→0.2；P95/P99→2→0.3。
    assert registry.latency_quantile(0.5) == pytest.approx(0.2)
    assert registry.latency_quantile(0.95) == pytest.approx(0.3)
    assert registry.latency_quantile(0.99) == pytest.approx(0.3)
    assert registry.latency_sample_count() == 3

    body = registry.render()
    assert 'rag_request_latency_seconds{quantile="0.5"} 0.200000' in body
    assert "rag_request_latency_seconds_count 3" in body
    assert registry.latency_quantile(0.5) is not None


def test_counter_increment_and_render():
    """计数器按 (name, labels) 维度累加，渲染行稳定排序。

    :return: 无返回值。
    :raises AssertionError: 计数值或渲染行不符时抛出。
    """
    registry = MetricsRegistry()
    registry.increment_counter(REQUESTS_TOTAL, {"endpoint": "/v1/query", "outcome": "ok"})
    registry.increment_counter(REQUESTS_TOTAL, {"endpoint": "/v1/query", "outcome": "ok"})
    registry.increment_counter(REQUESTS_TOTAL, {"endpoint": "/v1/query", "outcome": "denied"})
    registry.increment_counter(QUERY_HITS_TOTAL, amount=4)

    assert registry.counter_value(REQUESTS_TOTAL, {"endpoint": "/v1/query", "outcome": "ok"}) == 2.0
    assert registry.counter_value(REQUESTS_TOTAL, {"endpoint": "/v1/query", "outcome": "denied"}) == 1.0
    assert registry.counter_value(QUERY_HITS_TOTAL) == 4.0

    body = registry.render()
    assert 'rag_requests_total{endpoint="/v1/query",outcome="denied"} 1.0' in body
    assert 'rag_requests_total{endpoint="/v1/query",outcome="ok"} 2.0' in body
    assert "rag_query_hits_total 4.0" in body


def test_embedding_error_is_counted_and_reraised():
    """embedding 调用异常：同步/异步路径均计数后原样重抛。

    :return: 无返回值。
    :raises AssertionError: 计数未增长或异常被改写时抛出。
    """

    class BrokenClient:
        """恒抛异常的假 embedding 客户端。"""

        def embed_sync(self, texts: list[str]) -> list[list[float]]:
            """同步取向量桩：恒抛 RuntimeError。

            :param texts: 待向量化文本列表。
            :raises RuntimeError: 模拟智谱服务不可用。
            """
            raise RuntimeError("embedding provider down")

        async def embed(self, texts: list[str]) -> list[list[float]]:
            """异步取向量桩：恒抛 RuntimeError。

            :param texts: 待向量化文本列表。
            :raises RuntimeError: 模拟智谱服务不可用。
            """
            raise RuntimeError("embedding provider down")

    counted = _CountedEmbeddingClient(BrokenClient())

    with pytest.raises(RuntimeError, match="embedding provider down"):
        counted.embed_sync(["query"])
    with pytest.raises(RuntimeError, match="embedding provider down"):
        asyncio.run(counted.embed(["query"]))

    assert get_metrics().counter_value(EMBEDDING_ERRORS_TOTAL) == 2.0


def test_milvus_error_is_counted_and_reraised(monkeypatch):
    """向量库创建/连接失败：计数后原样重抛（经 query_documents 真实调用链）。

    :param monkeypatch: pytest 夹具。
    :return: 无返回值。
    :raises AssertionError: 计数未增长或异常被改写时抛出。
    """

    def broken_create_vector_store(settings, dim):
        """替身 create_vector_store：恒抛 RuntimeError。

        :param settings: 服务配置。
        :param dim: 向量维度。
        :raises RuntimeError: 模拟 Milvus 不可用。
        """
        raise RuntimeError("milvus down")

    monkeypatch.setattr("app.rag.create_vector_store", broken_create_vector_store)

    with pytest.raises(RuntimeError, match="milvus down"):
        asyncio.run(query_documents(_rag_settings(), project_id=21, query="测试查询"))

    assert get_metrics().counter_value(MILVUS_ERRORS_TOTAL) == 1.0


def test_query_success_records_latency_and_hits(monkeypatch):
    """检索成功路径：延迟采样 +1、命中条数累计与返回条数一致。

    :param monkeypatch: pytest 夹具。
    :return: 无返回值。
    :raises AssertionError: 采样/计数与预期不符时抛出。
    """
    monkeypatch.setattr(
        "app.rag.create_embedding",
        lambda settings: ZhipuLlamaIndexEmbedding(_FakeEmbeddingClient(), 3),
    )
    monkeypatch.setattr("app.rag.create_vector_store", lambda settings, dim: _FakeVectorStore())

    items = asyncio.run(query_documents(_rag_settings(), project_id=21, query="测试查询", top_k=5))

    assert len(items) == 1
    assert items[0]["metadata"]["project_id"] == 21
    assert get_metrics().counter_value(QUERY_HITS_TOTAL) == 1.0
    assert get_metrics().latency_sample_count() == 1
    assert get_metrics().latency_quantile(0.5) is not None


def test_index_success_records_latency_without_hits(monkeypatch):
    """索引成功路径：延迟采样 +1、命中计数不增长。

    :param monkeypatch: pytest 夹具。
    :return: 无返回值。
    :raises AssertionError: 采样/计数与预期不符时抛出。
    """
    monkeypatch.setattr(
        "app.rag.create_embedding",
        lambda settings: ZhipuLlamaIndexEmbedding(_FakeEmbeddingClient(), 3),
    )
    monkeypatch.setattr("app.rag.create_vector_store", lambda settings, dim: _FakeVectorStore())
    document = {
        "text": "角色设定文本",
        "metadata": {
            "project_id": 21,
            "episode_id": 1,
            "asset_type": "character",
            "asset_id": "p21-char-fake",
            "asset_version": 1,
            "source": "confirmed_asset",
        },
    }

    report = asyncio.run(index_documents(_rag_settings(), [document]))

    assert report["indexed"] == 1
    assert get_metrics().latency_sample_count() == 1
    assert get_metrics().counter_value(QUERY_HITS_TOTAL) == 0.0
