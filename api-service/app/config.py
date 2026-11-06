from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "projectdream-api"
    app_env: str = "development"
    host: str = "0.0.0.0"
    port: int = Field(default=8000, validation_alias="API_PORT")
    public_base_url: str = Field(default="", validation_alias="PUBLIC_BASE_URL")
    object_storage_provider: str = Field(default="local", validation_alias="OBJECT_STORAGE_PROVIDER")
    # 媒体组（阶段 3.2）：本地签名 URL 的公开基地址默认指向 FastAPI 媒体服务
    # （开发默认 127.0.0.1:8000；生产经 .env.production 覆盖为公网地址）。
    object_storage_public_base_url: str = Field(default="http://127.0.0.1:8000/storage", validation_alias="OBJECT_STORAGE_PUBLIC_BASE_URL")
    object_storage_signing_secret: str = Field(default="projectdream-local-signing-secret", validation_alias="OBJECT_STORAGE_SIGNING_SECRET")
    object_storage_signed_url_ttl_seconds: int = Field(default=900, gt=0, validation_alias="OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS")
    # 媒体组：本地对象存储根目录（对齐 Node OBJECT_STORAGE_ROOT，默认 .codex-runtime/object-storage）。
    object_storage_root: str = Field(default=".codex-runtime/object-storage", validation_alias="OBJECT_STORAGE_ROOT")
    # 媒体组：生成媒体目录（Node 硬编码 .codex-runtime 相对 cwd；此处允许 env 覆盖便于测试与部署）。
    generated_frame_dir: str = Field(default=".codex-runtime/generated-frames", validation_alias="GENERATED_FRAME_DIR")
    generated_audio_dir: str = Field(default=".codex-runtime/generated-audio", validation_alias="GENERATED_AUDIO_DIR")
    generated_video_dir: str = Field(default=".codex-runtime/generated-videos", validation_alias="GENERATED_VIDEO_DIR")
    generated_export_dir: str = Field(default=".codex-runtime/exports", validation_alias="GENERATED_EXPORT_DIR")
    # 媒体组：mock-assets 占位图（Node PUBLIC_MOCK_ASSET_IMAGE_PATH=public/images/login-hero-clean.png；
    # 留空时回落仓库根同路径，容器内未挂载则按 Node 同款 4040 处理）。
    mock_asset_image_path: str = Field(default="", validation_alias="MOCK_ASSET_IMAGE_PATH")
    cos_secret_id: str = Field(default="", validation_alias="COS_SECRET_ID")
    cos_secret_key: str = Field(default="", validation_alias="COS_SECRET_KEY")
    cos_bucket: str = Field(default="", validation_alias="COS_BUCKET")
    cos_region: str = Field(default="", validation_alias="COS_REGION")
    cos_domain: str = Field(default="", validation_alias="COS_DOMAIN")
    cos_protocol: str = Field(default="https:", validation_alias="COS_PROTOCOL")
    mysql_host: str = Field(default="mysql", validation_alias="DB_HOST")
    mysql_port: int = Field(default=3306, validation_alias="DB_PORT")
    mysql_user: str = Field(default="projectdream", validation_alias="DB_USER")
    mysql_password: str = Field(default="", validation_alias="DB_PASSWORD")
    mysql_database: str = Field(default="projectdream", validation_alias="DB_NAME")
    mysql_connect_timeout: int = Field(default=5, gt=0, validation_alias="DB_CONNECT_TIMEOUT")
    mysql_read_timeout: int = Field(default=15, gt=0, validation_alias="DB_READ_TIMEOUT")
    mysql_write_timeout: int = Field(default=15, gt=0, validation_alias="DB_WRITE_TIMEOUT")
    # 短信供应商选择（tencent | mock）；tencent 凭据缺失或 SDK 不可用时启动期警告并降级 mock。
    sms_provider: str = Field(default="mock", validation_alias="SMS_PROVIDER")
    # 滑块验证码 HMAC 签名密钥；读取顺序对齐 Node：CAPTCHA_SECRET → SESSION_SECRET → 开发期固定缺省。
    auth_captcha_secret: str = Field(default="", validation_alias="AUTH_CAPTCHA_SECRET")
    # 会话签名密钥（Node 侧已有 env），作为滑块验证码密钥的次级回退。
    session_secret: str = Field(default="", validation_alias="SESSION_SECRET")
    # 腾讯云短信凭据与模板配置（与 Node 侧同名 env 逐项对齐，便于共享部署配置）。
    tencent_secret_id: str = Field(default="", validation_alias="TENCENTCLOUD_SECRET_ID")
    tencent_secret_key: str = Field(default="", validation_alias="TENCENTCLOUD_SECRET_KEY")
    tencent_sms_sdk_app_id: str = Field(default="", validation_alias="TENCENTCLOUD_SMS_SDK_APP_ID")
    tencent_sms_sign_name: str = Field(default="", validation_alias="TENCENTCLOUD_SMS_SIGN_NAME")
    tencent_sms_template_id: str = Field(default="", validation_alias="TENCENTCLOUD_SMS_TEMPLATE_ID")
    tencent_sms_region: str = Field(default="ap-guangzhou", validation_alias="TENCENTCLOUD_SMS_REGION")
    # 内部 Agent 端点（/internal/agent/*）的调用令牌；留空表示未配置，端点将返回 503。
    internal_token: str = Field(default="", validation_alias="INTERNAL_TOKEN")
    # Agent 运行时试点开关；默认关闭，开启后 /internal/agent/* 端点才可用。
    agent_runtime_enabled: bool = Field(default=False, validation_alias="AGENT_RUNTIME_ENABLED")

    @property
    def captcha_signing_secret(self) -> str:
        """滑块验证码 HMAC 签名密钥的最终取值。

        读取顺序对齐 Node（index.mjs L344）：``CAPTCHA_SECRET`` → ``SESSION_SECRET``
        → 开发期固定缺省（与 Node 的 development fallback 相同，保证跨进程验签兼容）。

        :returns: 非空签名密钥字符串。
        """
        return self.auth_captcha_secret or self.session_secret or "projectdream-captcha-development-secret"

    model_config = SettingsConfigDict(
        env_file=(".env", ".env.local", ".env.production"),
        env_prefix="",
        case_sensitive=False,
        extra="ignore",
    )

    def public_summary(self) -> dict[str, object]:
        """健康摘要（/health 暴露的配置概览）。

        第四阶段已删除 ``node_upstream_configured``：Node 代理退役后不再是配置项，
        各组路由恒为原生实现（migrated_groups 仅为历史迁移轨迹记录）。

        :returns: 健康摘要字典（应用名、环境、MySQL 配置状态、已迁移组清单）。
        """
        return {
            "app_name": self.app_name,
            "app_env": self.app_env,
            "mysql_configured": bool(self.mysql_host and self.mysql_database),
            "migrated_groups": [
                "auth.password",
                "auth.check-phone",
                "auth.captcha",
                "auth.send-code",
                "auth.login-sms",
                "auth.register",
                "auth.reset-password",
                "project-audio.read",
                "projects.read-write",
                "projects.read-outline",
                "projects.read-story-bible",
                "projects.read-season-structure",
                "projects.latest-content.single-query",
                "project-assets.read-archive",
                "project-assets.read.owner-scoped-aggregate",
                "voice-profiles.read",
                "script.read-scenes-storyboards",
                "script.write-scene-metadata",
                "script.write-scene-content",
                "script.reorder-storyboards",
                "generation.read-job",
                "generation.project-task-center.read",
                "generation.retry-terminal-job",
            ],
        }
