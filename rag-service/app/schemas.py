from typing import Any

from pydantic import BaseModel, Field


class DocumentInput(BaseModel):
    text: str = Field(min_length=1)
    metadata: dict[str, Any]


class IndexRequest(BaseModel):
    documents: list[DocumentInput] = Field(min_length=1, max_length=500)
    replace_scopes: bool = False


class QueryRequest(BaseModel):
    project_id: int = Field(gt=0)
    query: str = Field(min_length=1, max_length=4000)
    episode_id: int | None = Field(default=None, gt=0)
    top_k: int = Field(default=5, ge=1, le=20)
