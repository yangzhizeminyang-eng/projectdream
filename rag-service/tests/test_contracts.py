import os

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.documents import build_metadata, normalize_documents
from app.milvus_store import build_project_filter, build_scope_expression
from app.zhipu_embedding import parse_embedding_response
from app.zhipu_embedding import ZhipuEmbeddingClient, ZhipuLlamaIndexEmbedding
from app.main import create_app
from app.rag import build_document_id


def test_settings_read_runtime_secrets_without_exposing_them():
    settings = Settings(
        zhipu_api_key="runtime-secret",
        milvus_token="runtime-milvus-secret",
    )

    assert settings.zhipu_api_key == "runtime-secret"
    assert settings.milvus_token == "runtime-milvus-secret"
    assert "runtime-secret" not in settings.public_summary()
    assert "runtime-milvus-secret" not in settings.public_summary()
    assert settings.public_summary()["embedding_model"] == "embedding-3"


def test_settings_use_persistent_lite_database_by_default():
    assert Settings().milvus_uri.endswith("projectdream.db")


def test_settings_read_rag_prefixed_runtime_environment(monkeypatch):
    monkeypatch.setenv("RAG_APP_ENV", "production")
    monkeypatch.setenv("RAG_PORT", "8123")
    monkeypatch.setenv("RAG_MILVUS_URI", "/tmp/rag-prefixed.db")

    settings = Settings(_env_file=None)

    assert settings.app_env == "production"
    assert settings.port == 8123
    assert settings.milvus_uri == "/tmp/rag-prefixed.db"


def test_document_metadata_keeps_project_scope_and_asset_version():
    metadata = build_metadata(
        {
            "project_id": 21,
            "episode_id": 1,
            "asset_type": "character",
            "asset_id": 12,
            "asset_version": 3,
            "source": "confirmed_asset",
        }
    )

    assert metadata == {
        "project_id": 21,
        "episode_id": 1,
        "asset_type": "character",
        "asset_id": 12,
        "asset_version": 3,
        "source": "confirmed_asset",
    }


def test_document_normalization_rejects_missing_project_scope():
    with pytest.raises(ValueError, match="project_id"):
        normalize_documents([{"text": "角色设定", "metadata": {}}])


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("asset_type", "", "asset_type"),
        ("asset_id", "", "asset_id"),
        ("asset_version", 0, "asset_version"),
        ("episode_id", 0, "episode_id"),
    ],
)
def test_document_metadata_rejects_invalid_asset_identity(field, value, message):
    metadata = {
        "project_id": 21,
        "episode_id": 1,
        "asset_type": "scene",
        "asset_id": "scene:1",
        "asset_version": 1,
        "source": "confirmed_asset",
    }
    metadata[field] = value

    with pytest.raises(ValueError, match=message):
        build_metadata(metadata)


def test_zhipu_embedding_parser_supports_ordered_data_items():
    payload = {
        "data": [
            {"index": 1, "embedding": [0.2, 0.3]},
            {"index": 0, "embedding": [0.1, 0.4]},
        ]
    }

    assert parse_embedding_response(payload) == [[0.1, 0.4], [0.2, 0.3]]


def test_zhipu_embedding_parser_rejects_empty_response():
    with pytest.raises(ValueError, match="embedding"):
        parse_embedding_response({"data": []})


def test_project_filter_always_scopes_retrieval_to_project():
    filters = build_project_filter(project_id=21, episode_id=1)

    assert filters == [
        {"key": "project_id", "value": 21, "operator": "=="},
        {"key": "episode_id", "value": 1, "operator": "=="},
    ]


def test_project_filter_rejects_missing_scope():
    with pytest.raises(ValueError, match="project_id"):
        build_project_filter(project_id=0)


def test_snapshot_scope_expression_is_project_and_episode_isolated():
    assert build_scope_expression(21, 3) == "project_id == 21 and episode_id == 3"


def test_stale_document_ids_exclude_current_snapshot_ids():
    from app.rag import _stale_document_ids

    assert _stale_document_ids(
        [{"doc_id": "old"}, {"doc_id": "current"}, {"doc_id": "old"}],
        {"current"},
    ) == ["old"]


def test_project_memory_document_id_is_stable_and_versioned():
    metadata = {
        "project_id": 21,
        "episode_id": 1,
        "asset_type": "scene",
        "asset_id": "scene:1:1",
        "asset_version": 2,
    }

    assert build_document_id(metadata) == "project:21:episode:1:scene:scene:1:1:v2"
    assert build_document_id(metadata) == build_document_id(dict(metadata))


def test_llamaindex_embedding_rejects_wrong_milvus_dimension():
    client = ZhipuEmbeddingClient(
        api_key="runtime-secret",
        base_url="https://example.invalid/v4",
        model="embedding-3",
    )
    embedding = ZhipuLlamaIndexEmbedding(client, dimension=3)

    with pytest.raises(ValueError, match="dimension mismatch"):
        embedding._validate([0.1, 0.2])


def test_ready_reports_unconfigured_service_with_http_503():
    client = TestClient(create_app(Settings(zhipu_api_key="")))

    response = client.get("/ready")

    assert response.status_code == 503
    assert response.json()["status"] == "not_configured"


def test_ready_checks_that_milvus_store_can_be_created(monkeypatch):
    settings = Settings(
        zhipu_api_key="runtime-secret",
        internal_token="service-token",
        milvus_uri="/tmp/projectdream.db",
    )
    calls = []

    def fake_create_vector_store(current_settings, embedding_dim):
        calls.append((current_settings, embedding_dim))
        return object()

    monkeypatch.setattr("app.main.create_vector_store", fake_create_vector_store)
    client = TestClient(create_app(settings))

    response = client.get("/ready")

    assert response.status_code == 200
    assert response.json()["status"] == "ready"
    assert len(calls) == 1


def test_index_rejects_missing_runtime_configuration():
    client = TestClient(create_app(Settings(zhipu_api_key="")))
    payload = {
        "documents": [
            {
                "text": "角色设定",
                "metadata": {
                    "project_id": 21,
                    "episode_id": 1,
                    "asset_type": "character",
                    "asset_id": 12,
                    "asset_version": 3,
                    "source": "confirmed_asset",
                },
            }
        ]
    }

    response = client.post("/v1/index/documents", json=payload)

    assert response.status_code == 503
    assert response.json()["detail"] == "RAG dependencies are not configured"


def test_index_requires_service_token_when_rag_is_configured(monkeypatch):
    settings = Settings(
        zhipu_api_key="runtime-secret",
        internal_token="service-token",
        milvus_uri="/tmp/projectdream.db",
    )
    async def fake_index_documents(*args):
        return 1

    monkeypatch.setattr("app.main.index_documents", fake_index_documents)
    client = TestClient(create_app(settings))
    payload = {
        "documents": [
            {
                "text": "角色设定",
                "metadata": {
                    "project_id": 21,
                    "episode_id": 1,
                    "asset_type": "character",
                    "asset_id": 12,
                    "asset_version": 3,
                    "source": "confirmed_asset",
                },
            }
        ]
    }

    response = client.post("/v1/index/documents", json=payload)

    assert response.status_code == 401
    assert response.json()["detail"] == "RAG service token is required"


def test_index_accepts_valid_service_token(monkeypatch):
    settings = Settings(
        zhipu_api_key="runtime-secret",
        internal_token="service-token",
        milvus_uri="/tmp/projectdream.db",
    )
    monkeypatch.setattr("app.main.index_documents", lambda *args, **kwargs: __import__("asyncio").sleep(0, result={"indexed": 1, "removed": 2, "updated": 1}))
    client = TestClient(create_app(settings))
    payload = {
        "documents": [
            {
                "text": "角色设定",
                "metadata": {
                    "project_id": 21,
                    "episode_id": 1,
                    "asset_type": "character",
                    "asset_id": 12,
                    "asset_version": 3,
                    "source": "confirmed_asset",
                },
            }
        ]
    }

    response = client.post(
        "/v1/index/documents",
        headers={"X-RAG-Internal-Token": "service-token"},
        json=payload,
    )

    assert response.status_code == 200
    assert response.json()["indexed"] == 1
    assert response.json()["removed"] == 2


def test_milvus_lite_collection_is_loaded_and_project_filtered(tmp_path):
    import asyncio

    from llama_index.core.schema import TextNode
    from llama_index.core.vector_stores import ExactMatchFilter, MetadataFilters, VectorStoreQuery

    settings = Settings(
        milvus_uri=str(tmp_path / "integration.db"),
        milvus_collection="project_scope_test",
        milvus_dim=3,
    )

    # pymilvus 2.6.x 的 AsyncMilvusClient 初始化要求运行中的事件循环——生产路径
    # （FastAPI async 端点 → rag.py → create_vector_store）天然满足，测试对齐同一形态：
    # 在 asyncio.run 内完成 store 创建；后续 add/query 为同步调用，不依赖该 loop。
    async def _create_store():
        from app.milvus_store import create_vector_store

        return create_vector_store(settings, 3)

    store = asyncio.run(_create_store())
    store.add(
        [
            TextNode(
                text="project-21",
                metadata={"project_id": 21, "episode_id": 1},
                embedding=[1.0, 0.0, 0.0],
            ),
            TextNode(
                text="project-22",
                metadata={"project_id": 22, "episode_id": 1},
                embedding=[0.0, 1.0, 0.0],
            ),
        ]
    )

    result = store.query(
        VectorStoreQuery(
            query_embedding=[1.0, 0.0, 0.0],
            similarity_top_k=5,
            filters=MetadataFilters(filters=[ExactMatchFilter(key="project_id", value=21)]),
        )
    )

    assert [node.metadata["project_id"] for node in result.nodes] == [21]


def test_milvus_store_loads_released_collection_before_queries():
    from types import SimpleNamespace

    from app.milvus_store import ensure_collection_loaded

    calls = []
    client = SimpleNamespace(
        get_load_state=lambda name: "NotLoad",
        load_collection=lambda name: calls.append(name),
    )
    ensure_collection_loaded(SimpleNamespace(client=client, collection_name="scope"))

    assert calls == ["scope"]


def test_retrieval_eval_accepts_scoped_expected_asset_hit():
    from app.retrieval_eval import evaluate_retrieval

    report = evaluate_retrieval(
        {
            "project_id": 21,
            "episode_id": 1,
            "expected_asset_ids": [12],
        },
        [
            {
                "metadata": {"project_id": 21, "episode_id": 1, "asset_id": 12},
                "score": 0.92,
            }
        ],
    )

    assert report == {
        "passed": True,
        "scope_passed": True,
        "expected_hits": ["12"],
        "missing_expected_asset_ids": [],
        "scope_violations": [],
        "forbidden_asset_hits": [],
    }


def test_retrieval_eval_rejects_cross_project_and_missing_expected_asset():
    from app.retrieval_eval import evaluate_retrieval

    report = evaluate_retrieval(
        {
            "project_id": 21,
            "episode_id": 1,
            "expected_asset_ids": [12],
            "forbidden_asset_ids": [99],
        },
        [
            {
                "metadata": {"project_id": 22, "episode_id": 1, "asset_id": 99},
                "score": 0.91,
            }
        ],
    )

    assert report["passed"] is False
    assert report["scope_passed"] is False
    assert report["expected_hits"] == []
    assert report["missing_expected_asset_ids"] == ["12"]
    assert report["scope_violations"] == [{"project_id": 22, "episode_id": 1}]
    assert report["forbidden_asset_hits"] == ["99"]
