from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "projectdream-rag"
    app_env: str = Field(
        default="development",
        validation_alias=AliasChoices("RAG_APP_ENV", "APP_ENV"),
    )
    host: str = "0.0.0.0"
    port: int = Field(
        default=8001,
        validation_alias=AliasChoices("RAG_PORT", "PORT"),
    )

    # Milvus can be a local standalone instance or a managed endpoint.
    # Keep Milvus Lite's file path out of PyMilvus' global MILVUS_URI env var.
    # PyMilvus parses that variable during import as a remote URI.
    milvus_uri: str = Field(
        default="/app/.codex-runtime/milvus/projectdream.db",
        validation_alias=AliasChoices("RAG_MILVUS_URI", "MILVUS_URI"),
    )
    milvus_token: str = Field(
        default="",
        validation_alias=AliasChoices("RAG_MILVUS_TOKEN", "MILVUS_TOKEN"),
    )
    milvus_collection: str = "projectdream_rag_v1"
    milvus_dim: int = 2048
    zhipu_dimensions: int | None = 2048

    zhipu_model: str = "embedding-3"
    zhipu_api_key: str = ""
    zhipu_base_url: str = "https://open.bigmodel.cn/api/paas/v4"
    zhipu_timeout_seconds: float = 30.0
    internal_token: str = ""

    # 调用方网关：allowlist 为空表示不启用（放行所有通过令牌校验的调用方），
    # 启用后按逗号分隔的 caller id 精确匹配请求头 X-RAG-Caller-Id。
    caller_allowlist: str = Field(
        default="",
        validation_alias=AliasChoices("RAG_CALLER_ALLOWLIST", "CALLER_ALLOWLIST"),
    )
    # 每分钟每个调用方允许的请求数；0 表示不限流。滑动窗口按 caller id 分桶。
    rate_limit_per_minute: int = Field(
        default=0,
        ge=0,
        validation_alias=AliasChoices("RAG_RATE_LIMIT_PER_MINUTE", "RATE_LIMIT_PER_MINUTE"),
    )

    model_config = SettingsConfigDict(
        env_file=(".env", ".env.local", ".env.production"),
        env_prefix="",
        case_sensitive=False,
        extra="ignore",
    )

    def public_summary(self) -> dict[str, object]:
        """构造非敏感配置摘要，供 /health 展示。

        :return: 只含布尔开关与模型维度等非敏感字段的字典；
            绝不回显 allowlist 名单内容、令牌或密钥。
        """
        return {
            "app_name": self.app_name,
            "app_env": self.app_env,
            "milvus_configured": bool(self.milvus_uri),
            "milvus_collection": self.milvus_collection,
            "embedding_model": self.zhipu_model,
            "embedding_dim": self.milvus_dim,
            "embedding_dimensions_param": self.zhipu_dimensions,
            "zhipu_configured": bool(self.zhipu_api_key),
            "internal_auth_configured": bool(self.internal_token),
            "caller_allowlist_enabled": bool(self.caller_allowlist.strip()),
            "rate_limit_per_minute": self.rate_limit_per_minute,
        }
