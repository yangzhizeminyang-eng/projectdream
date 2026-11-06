from typing import Any


def build_scope_expression(project_id: int, episode_id: int | None) -> str:
    if not isinstance(project_id, int) or project_id <= 0:
        raise ValueError("project_id must be a positive integer")
    expression = f"project_id == {project_id}"
    if episode_id is not None:
        if not isinstance(episode_id, int) or episode_id <= 0:
            raise ValueError("episode_id must be a positive integer")
        expression += f" and episode_id == {episode_id}"
    return expression


def build_project_filter(project_id: int, episode_id: int | None = None) -> list[dict[str, Any]]:
    if not isinstance(project_id, int) or project_id <= 0:
        raise ValueError("project_id must be a positive integer")
    filters: list[dict[str, Any]] = [{"key": "project_id", "value": project_id, "operator": "=="}]
    if episode_id is not None:
        if not isinstance(episode_id, int) or episode_id <= 0:
            raise ValueError("episode_id must be a positive integer")
        filters.append({"key": "episode_id", "value": episode_id, "operator": "=="})
    return filters


def ensure_collection_loaded(store: Any) -> None:
    """Make the collection searchable after process restart or Milvus Lite reopen."""
    collection_name = getattr(store, "collection_name", None)
    client = getattr(store, "client", None)
    if not collection_name or client is None:
        raise RuntimeError("Milvus store is missing its client or collection name")
    state = client.get_load_state(collection_name)
    state_name = str(getattr(state, "name", state)).lower()
    if state_name not in {"loaded", "loadstate.loaded"}:
        client.load_collection(collection_name)


def create_vector_store(settings: Any, embedding_dim: int):
    """Create the LlamaIndex Milvus adapter only after runtime config is validated.

    调用约束：必须在**运行中的事件循环线程**内调用（生产路径为 FastAPI async 端点）。
    pymilvus 2.6.x 的 ``MilvusVectorStore`` 构造会初始化 ``AsyncMilvusClient``，
    其连接 alias 绑定当前 loop id——同步上下文（无 running loop）会抛
    ``ConnectionConfigException``。
    """
    if not settings.milvus_uri:
        raise RuntimeError("MILVUS_URI is required before creating the vector store")
    if embedding_dim <= 0:
        raise ValueError("embedding_dim must be positive")

    from llama_index.vector_stores.milvus import MilvusVectorStore

    store = MilvusVectorStore(
        uri=settings.milvus_uri,
        token=settings.milvus_token or None,
        collection_name=settings.milvus_collection,
        dim=embedding_dim,
        overwrite=False,
        upsert_mode=True,
    )
    ensure_collection_loaded(store)
    return store
