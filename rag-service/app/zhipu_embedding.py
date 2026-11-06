from typing import Any

import httpx
from llama_index.core.embeddings import BaseEmbedding
from pydantic import PrivateAttr


def parse_embedding_response(payload: dict[str, Any]) -> list[list[float]]:
    items = payload.get("data")
    if not isinstance(items, list) or not items:
        raise ValueError("embedding response contains no embedding data")

    ordered = sorted(items, key=lambda item: int(item.get("index", 0)))
    vectors = [item.get("embedding") for item in ordered]
    if any(not isinstance(vector, list) or not vector for vector in vectors):
        raise ValueError("embedding response contains an invalid embedding")
    return [[float(value) for value in vector] for vector in vectors]


class ZhipuEmbeddingClient:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        timeout: float = 30.0,
        dimensions: int | None = None,
    ):
        if not api_key:
            raise ValueError("ZHIPU_API_KEY is required")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.dimensions = dimensions

    def _payload(self, texts: list[str]) -> dict[str, object]:
        payload: dict[str, object] = {"model": self.model, "input": texts}
        if self.dimensions is not None:
            payload["dimensions"] = self.dimensions
        return payload

    def _parse_texts(self, texts: list[str]) -> list[str]:
        if not texts or any(not str(text).strip() for text in texts):
            raise ValueError("texts must contain at least one non-empty value")
        return texts

    def embed_sync(self, texts: list[str]) -> list[list[float]]:
        texts = self._parse_texts(texts)
        with httpx.Client(timeout=self.timeout) as client:
            response = client.post(
                f"{self.base_url}/embeddings",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json=self._payload(texts),
            )
            response.raise_for_status()
            return parse_embedding_response(response.json())

    async def embed(self, texts: list[str]) -> list[list[float]]:
        texts = self._parse_texts(texts)
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                f"{self.base_url}/embeddings",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json=self._payload(texts),
            )
            response.raise_for_status()
            return parse_embedding_response(response.json())


class ZhipuLlamaIndexEmbedding(BaseEmbedding):
    """Small LlamaIndex adapter backed by Zhipu's OpenAI-compatible endpoint."""

    _client: ZhipuEmbeddingClient = PrivateAttr()
    dimension: int

    def __init__(self, client: ZhipuEmbeddingClient, dimension: int):
        super().__init__(model_name=client.model, dimension=dimension)
        self._client = client

    def _validate(self, vector: list[float]) -> list[float]:
        if len(vector) != self.dimension:
            raise ValueError(
                f"embedding dimension mismatch: expected {self.dimension}, received {len(vector)}"
            )
        return vector

    def _get_text_embedding(self, text: str) -> list[float]:
        return self._validate((self._client.embed_sync([text]))[0])

    def _get_text_embedding_batch(self, texts: list[str]) -> list[list[float]]:
        return [self._validate(vector) for vector in self._client.embed_sync(texts)]

    async def _aget_text_embedding(self, text: str) -> list[float]:
        return self._validate((await self._client.embed([text]))[0])

    async def _aget_text_embedding_batch(self, texts: list[str]) -> list[list[float]]:
        return [self._validate(vector) for vector in await self._client.embed(texts)]

    def _get_query_embedding(self, query: str) -> list[float]:
        return self._validate((self._client.embed_sync([query]))[0])

    async def _aget_query_embedding(self, query: str) -> list[float]:
        return self._validate((await self._client.embed([query]))[0])
