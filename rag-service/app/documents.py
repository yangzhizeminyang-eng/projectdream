from collections.abc import Iterable
from typing import Any


REQUIRED_METADATA = (
    "project_id",
    "episode_id",
    "asset_type",
    "asset_id",
    "asset_version",
    "source",
)


def build_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    result = {key: metadata.get(key) for key in REQUIRED_METADATA}
    if not isinstance(result["project_id"], int) or result["project_id"] <= 0:
        raise ValueError("metadata.project_id must be a positive integer")
    if result["episode_id"] is not None and (
        not isinstance(result["episode_id"], int) or result["episode_id"] <= 0
    ):
        raise ValueError("metadata.episode_id must be a positive integer")
    if not str(result["asset_type"] or "").strip():
        raise ValueError("metadata.asset_type is required")
    if not str(result["asset_id"] or "").strip():
        raise ValueError("metadata.asset_id is required")
    if not isinstance(result["asset_version"], int) or result["asset_version"] <= 0:
        raise ValueError("metadata.asset_version must be a positive integer")
    if not str(result["source"] or "").strip():
        raise ValueError("metadata.source is required")
    return result


def normalize_documents(documents: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for document in documents:
        text = str(document.get("text") or "").strip()
        if not text:
            raise ValueError("document.text is required")
        normalized.append({"text": text, "metadata": build_metadata(document.get("metadata") or {})})
    return normalized
