import time
from typing import Any

from .config import Settings
from .documents import normalize_documents
from .metrics import (
    EMBEDDING_ERRORS_TOTAL,
    MILVUS_ERRORS_TOTAL,
    QUERY_HITS_TOTAL,
    get_metrics,
)
from .milvus_store import build_project_filter, build_scope_expression, create_vector_store
from .zhipu_embedding import ZhipuEmbeddingClient, ZhipuLlamaIndexEmbedding


class _CountedEmbeddingClient:
    """带异常计数的 embedding 客户端代理。

    以组合方式包装 :class:`ZhipuEmbeddingClient`：embed 调用异常先计入
    ``rag_embedding_errors_total``，再把原始异常原样重抛（不吞不改）。
    其余属性经 ``__getattr__`` 透传，保持与真实客户端行为一致。
    """

    def __init__(self, inner: ZhipuEmbeddingClient) -> None:
        """包装真实 embedding 客户端。

        :param inner: 真实的 Zhipu embedding 客户端实例。
        """
        self._inner = inner

    def __getattr__(self, name: str) -> Any:
        """透传未覆写的属性访问（如 api_key/model 等）。

        :param name: 属性名。
        :return: 内部客户端上的同名属性。
        """
        return getattr(self._inner, name)

    def embed_sync(self, texts: list[str]) -> list[list[float]]:
        """同步批量取向量；异常计数后原样重抛。

        :param texts: 待向量化的文本列表。
        :return: 与输入顺序一致的向量列表。
        :raises Exception: 内部客户端抛出的原始异常（计数后重抛）。
        """
        try:
            return self._inner.embed_sync(texts)
        except Exception:
            get_metrics().increment_counter(EMBEDDING_ERRORS_TOTAL)
            raise

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """异步批量取向量；异常计数后原样重抛。

        :param texts: 待向量化的文本列表。
        :return: 与输入顺序一致的向量列表。
        :raises Exception: 内部客户端抛出的原始异常（计数后重抛）。
        """
        try:
            return await self._inner.embed(texts)
        except Exception:
            get_metrics().increment_counter(EMBEDDING_ERRORS_TOTAL)
            raise


def create_embedding(settings: Settings) -> ZhipuLlamaIndexEmbedding:
    """创建带异常计数的 LlamaIndex embedding 适配器。

    :param settings: 服务配置。
    :return: 包装了计数代理客户端的 embedding 实例。
    """
    client = ZhipuEmbeddingClient(
        api_key=settings.zhipu_api_key,
        base_url=settings.zhipu_base_url,
        model=settings.zhipu_model,
        timeout=settings.zhipu_timeout_seconds,
        dimensions=settings.zhipu_dimensions,
    )
    return ZhipuLlamaIndexEmbedding(_CountedEmbeddingClient(client), settings.milvus_dim)


def _create_counted_vector_store(settings: Settings, embedding_dim: int) -> Any:
    """创建向量库；连接/建表/加载失败计入 milvus 错误指标后原样重抛。

    :param settings: 服务配置。
    :param embedding_dim: 向量维度。
    :return: LlamaIndex Milvus 向量库实例。
    :raises Exception: 底层 Milvus 异常（计数后重抛）。
    """
    try:
        return create_vector_store(settings, embedding_dim)
    except Exception:
        get_metrics().increment_counter(MILVUS_ERRORS_TOTAL)
        raise


def build_document_id(metadata: dict[str, Any]) -> str:
    """Build a stable Milvus primary key for one project-memory document."""
    project_id = int(metadata["project_id"])
    episode_id = metadata.get("episode_id") or "all"
    asset_type = str(metadata.get("asset_type") or "memory").strip()
    asset_id = str(metadata.get("asset_id") or "memory").strip()
    asset_version = metadata.get("asset_version") or 1
    return f"project:{project_id}:episode:{episode_id}:{asset_type}:{asset_id}:v{asset_version}"


def _document_scope(metadata: dict[str, Any]) -> tuple[int, int | None]:
    return int(metadata["project_id"]), metadata.get("episode_id")


def _current_document_ids(documents: list[dict[str, Any]]) -> set[str]:
    return {build_document_id(item["metadata"]) for item in documents}


def _stale_document_ids(existing: list[dict[str, Any]], current_ids: set[str]) -> list[str]:
    return sorted({str(item.get("doc_id") or "").strip() for item in existing} - current_ids - {""})


def _scope_documents(store: Any, project_id: int, episode_id: int | None) -> list[dict[str, Any]]:
    """查询指定范围内已有文档 ID；Milvus 异常计数后原样重抛。

    :param store: Milvus 向量库实例。
    :param project_id: 项目 ID。
    :param episode_id: 分集 ID（可为 None）。
    :return: 范围内已有文档（含 doc_id 字段）。
    :raises Exception: Milvus 查询异常（计数后重抛）。
    """
    try:
        return store.client.query(
            collection_name=store.collection_name,
            filter=build_scope_expression(project_id, episode_id),
            output_fields=[getattr(store, "doc_id_field", "doc_id")],
        )
    except Exception:
        get_metrics().increment_counter(MILVUS_ERRORS_TOTAL)
        raise


def _delete_counted(store: Any, doc_ids: list[str]) -> None:
    """删除指定文档；Milvus 异常计数后原样重抛。

    :param store: Milvus 向量库实例。
    :param doc_ids: 待删除的文档 ID 列表。
    :raises Exception: Milvus 删除异常（计数后重抛）。
    """
    try:
        store.delete(doc_ids)
    except Exception:
        get_metrics().increment_counter(MILVUS_ERRORS_TOTAL)
        raise


async def index_documents(
    settings: Settings,
    documents: list[dict[str, Any]],
    *,
    replace_scopes: bool = False,
) -> dict[str, int]:
    started = time.perf_counter()
    normalized = normalize_documents(documents)
    embedding = create_embedding(settings)
    store = _create_counted_vector_store(settings, settings.milvus_dim)

    from llama_index.core import Document, StorageContext, VectorStoreIndex

    nodes = [
        Document(
            id_=build_document_id(item["metadata"]),
            text=item["text"],
            metadata=item["metadata"],
        )
        for item in normalized
    ]
    storage_context = StorageContext.from_defaults(vector_store=store)
    VectorStoreIndex.from_documents(nodes, storage_context=storage_context, embed_model=embedding)

    removed = 0
    if replace_scopes:
        scopes = {_document_scope(item["metadata"]) for item in normalized}
        current_ids = _current_document_ids(normalized)
        stale_ids: set[str] = set()
        for project_id, episode_id in scopes:
            stale_ids.update(_stale_document_ids(_scope_documents(store, project_id, episode_id), current_ids))
        if stale_ids:
            _delete_counted(store, sorted(stale_ids))
            removed = len(stale_ids)
    # 成功路径：记录索引延迟采样（失败不采样，避免污染分位）。
    get_metrics().observe_latency_seconds(time.perf_counter() - started)
    return {"indexed": len(nodes), "removed": removed, "updated": len(nodes)}


async def query_documents(
    settings: Settings,
    *,
    project_id: int,
    query: str,
    episode_id: int | None = None,
    top_k: int = 5,
) -> list[dict[str, Any]]:
    if not query.strip():
        raise ValueError("query is required")
    started = time.perf_counter()
    embedding = create_embedding(settings)
    store = _create_counted_vector_store(settings, settings.milvus_dim)

    from llama_index.core import StorageContext, VectorStoreIndex
    from llama_index.core.vector_stores import ExactMatchFilter, MetadataFilters

    filters = MetadataFilters(
        filters=[ExactMatchFilter(key=item["key"], value=item["value"]) for item in build_project_filter(project_id, episode_id)]
    )
    index = VectorStoreIndex.from_vector_store(
        store,
        storage_context=StorageContext.from_defaults(vector_store=store),
        embed_model=embedding,
    )
    retriever = index.as_retriever(similarity_top_k=max(1, min(top_k, 20)), filters=filters)
    results = await retriever.aretrieve(query)
    items = [
        {
            "text": item.node.get_content(),
            "score": item.score,
            "metadata": item.node.metadata,
        }
        for item in results
    ]
    # 成功路径：记录检索延迟采样与命中条数累计。
    get_metrics().observe_latency_seconds(time.perf_counter() - started)
    get_metrics().increment_counter(QUERY_HITS_TOTAL, amount=len(items))
    return items
