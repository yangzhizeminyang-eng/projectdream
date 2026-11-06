"""模型设置中心域层（对齐 Node ``/api/model-settings`` 路由族）。

复刻范围（Node index.mjs L352-L412 + L6531-L6677 与 services/{ai,frame,video,
lip-sync,audio}.mjs 的 config 解析器）：

- ``MODEL_SETTING_GROUPS`` / ``MODEL_SETTING_FIELDS``：设置中心分组与 41 个字段
  定义（key/group/label/type/options），键序与 Node 数组字面量一致；
- ``normalize_model_setting_value``：布尔/数值/文本三类归一化（数值必须正整数）；
- ``get_model_setting_fallback_values``：未持久化字段的运行时兜底值，AI 组经
  ``ai_provider.get_ai_config``（已有迁移），frame/video/lip-sync/audio 组按 Node
  各自 config 解析器的 provider 分支逻辑逐条转录。

字段值语义：``secret`` 类型在 payload 中不回显明文（value 恒空串，仅
``secretConfigured`` 提示是否已配置）。
"""

from __future__ import annotations

import os
from typing import Any

from ..ai_provider import get_ai_config

# 设置中心分组（对齐 Node MODEL_SETTING_GROUPS，index.mjs L352-L357）。
MODEL_SETTING_GROUPS: list[dict[str, str]] = [
    {"key": "text", "label": "文本模型"},
    {"key": "frame", "label": "图片模型"},
    {"key": "video", "label": "视频模型"},
    {"key": "audio", "label": "音频模型"},
]

# 字段定义（对齐 Node MODEL_SETTING_FIELDS，index.mjs L359-L410；顺序即数组序，
# 前端设置中心按此顺序渲染，不可调整）。
MODEL_SETTING_FIELDS: list[dict[str, Any]] = [
    {"key": "AI_PROVIDER", "group": "text", "label": "文本服务商", "type": "select", "options": ["openai-compatible", "mock"]},
    {"key": "AI_BASE_URL", "group": "text", "label": "文本接口地址", "type": "text"},
    {"key": "AI_API_KEY", "group": "text", "label": "文本接口密钥", "type": "secret"},
    {"key": "AI_MODEL", "group": "text", "label": "文本默认模型", "type": "text"},
    {"key": "AI_MODEL_OUTLINE", "group": "text", "label": "总纲模型", "type": "text"},
    {"key": "AI_MODEL_SCRIPT", "group": "text", "label": "剧本模型", "type": "text"},
    {"key": "AI_MODEL_STORYBOARD", "group": "text", "label": "分镜模型", "type": "text"},
    {"key": "AI_MODEL_CHARACTER", "group": "text", "label": "角色模型", "type": "text"},
    {"key": "AI_TIMEOUT_MS", "group": "text", "label": "文本超时毫秒", "type": "number"},
    {"key": "AI_LONG_TASK_TIMEOUT_MS", "group": "text", "label": "长文本任务超时毫秒", "type": "number"},
    {"key": "AI_FALLBACK_TO_MOCK", "group": "text", "label": "文本失败回退 mock", "type": "boolean"},
    {"key": "FRAME_PROVIDER", "group": "frame", "label": "图片服务商", "type": "select", "options": ["volcengine", "bigmodel", "zhipu", "toapi", "agnes", "trae-url", "mock"]},
    {"key": "FRAME_BASE_URL", "group": "frame", "label": "图片接口地址", "type": "text"},
    {"key": "FRAME_API_KEY", "group": "frame", "label": "图片接口密钥", "type": "secret"},
    {"key": "ARK_API_KEY", "group": "frame", "label": "火山方舟 / 豆包图片密钥", "type": "secret"},
    {"key": "VOLCENGINE_API_KEY", "group": "frame", "label": "火山方舟兼容密钥", "type": "secret"},
    {"key": "BIGMODEL_API_KEY", "group": "frame", "label": "智谱接口密钥", "type": "secret"},
    {"key": "FRAME_MODEL", "group": "frame", "label": "静帧默认模型", "type": "text"},
    {"key": "FRAME_FALLBACK_MODELS", "group": "frame", "label": "静帧备用模型链", "type": "text"},
    {"key": "FRAME_ASSET_PACK_MODEL", "group": "frame", "label": "角色资产包模型", "type": "text"},
    {"key": "FRAME_CHARACTER_ASSET_PACK_ENABLED", "group": "frame", "label": "启用角色资产包", "type": "boolean"},
    {"key": "FRAME_IMAGE_SIZE", "group": "frame", "label": "静帧尺寸", "type": "text"},
    {"key": "FRAME_IMAGE_RATIO", "group": "frame", "label": "静帧比例", "type": "select", "options": ["16:9", "9:16", "1:1"]},
    {"key": "FRAME_FALLBACK_TO_MOCK", "group": "frame", "label": "图片失败回退 mock", "type": "boolean"},
    {"key": "VIDEO_PROVIDER", "group": "video", "label": "视频服务商", "type": "select", "options": ["bigmodel", "zhipu", "agnes", "minimax", "wan", "mock"]},
    {"key": "VIDEO_BASE_URL", "group": "video", "label": "视频接口地址", "type": "text"},
    {"key": "VIDEO_API_KEY", "group": "video", "label": "视频接口密钥", "type": "secret"},
    {"key": "VIDEO_MODEL", "group": "video", "label": "图生视频模型", "type": "text"},
    {"key": "VIDEO_SIZE", "group": "video", "label": "视频尺寸", "type": "text"},
    {"key": "VIDEO_WATERMARK_ENABLED", "group": "video", "label": "供应商水印", "type": "boolean"},
    {"key": "VIDEO_FALLBACK_TO_MOCK", "group": "video", "label": "视频失败回退 mock", "type": "boolean"},
    {"key": "VIDEO_CREATE_RATE_LIMIT_MAX_REQUESTS", "group": "video", "label": "视频创建限流次数", "type": "number"},
    {"key": "VIDEO_CREATE_RATE_LIMIT_WINDOW_MS", "group": "video", "label": "视频创建限流窗口毫秒", "type": "number"},
    {"key": "VIDEO_IMAGE_UPLOAD_BASE_URL", "group": "video", "label": "源图上传接口地址", "type": "text"},
    {"key": "VIDEO_IMAGE_UPLOAD_API_KEY", "group": "video", "label": "源图上传接口密钥", "type": "secret"},
    {"key": "LIP_SYNC_PROVIDER", "group": "video", "label": "口型服务商", "type": "select", "options": ["dashscope", "toapi", "seedance", "latentsync", "mock"]},
    {"key": "LIP_SYNC_BASE_URL", "group": "video", "label": "口型接口地址", "type": "text"},
    {"key": "LIP_SYNC_MODEL", "group": "video", "label": "口型模型", "type": "text"},
    {"key": "LIP_SYNC_API_KEY", "group": "video", "label": "口型接口密钥", "type": "secret"},
    {"key": "AUDIO_PROVIDER", "group": "audio", "label": "音频服务商", "type": "select", "options": ["dashscope", "mock"]},
    {"key": "AUDIO_BASE_URL", "group": "audio", "label": "音频接口地址", "type": "text"},
    {"key": "DASHSCOPE_API_KEY", "group": "audio", "label": "DashScope 接口密钥", "type": "secret"},
    {"key": "AUDIO_MODEL", "group": "audio", "label": "TTS 主模型", "type": "text"},
    {"key": "AUDIO_FALLBACK_MODEL", "group": "audio", "label": "TTS 备用模型", "type": "text"},
    {"key": "AUDIO_VOICE", "group": "audio", "label": "默认音色", "type": "text"},
    {"key": "AUDIO_LANGUAGE_TYPE", "group": "audio", "label": "默认语言", "type": "text"},
    {"key": "AUDIO_FALLBACK_TO_MOCK", "group": "audio", "label": "音频失败回退 mock", "type": "boolean"},
]

# key → 字段定义（对齐 Node MODEL_SETTING_FIELD_MAP）。
MODEL_SETTING_FIELD_MAP: dict[str, dict[str, Any]] = {field["key"]: field for field in MODEL_SETTING_FIELDS}


def _env(key: str, default: str = "") -> str:
    """读取环境变量（Node ``process.env[key] || default`` 语义）。

    :param key: 环境变量名。
    :param default: 缺省值。
    :returns: 非空环境变量值（已存在但空串视为未设置，取 default）。
    """
    return str(os.environ.get(key) or default)


def _env_bool(key: str, default: bool) -> bool:
    """Node parseBoolean：1/true/yes/on → True；0/false/no/off → False；其余默认。

    :param key: 环境变量名。
    :param default: 未设置/非布尔词时的默认值。
    :returns: 解析后的布尔值。
    """
    value = os.environ.get(key)
    if value is None or value == "":
        return default
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _env_positive_int(key: str, default: int) -> int:
    """Node parsePositiveInt：正整数才收，否则默认值。

    :param key: 环境变量名。
    :param default: 默认值。
    :returns: 解析后的正整数。
    """
    try:
        parsed = int(str(os.environ.get(key)).strip())
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _normalize_base_url(value: str) -> str:
    """Node normalizeBaseUrl：strip 后剥尾部斜杠。

    :param value: 原始 URL。
    :returns: 归一化 URL（空串原样返回）。
    """
    raw = str(value or "").strip()
    return raw.rstrip("/") if raw else ""


def normalize_model_setting_value(field: dict[str, Any], value: Any) -> str:
    """归一化设置值（对齐 Node normalizeModelSettingValue，index.mjs L6531）。

    :param field: 字段定义（type ∈ boolean/number/其他文本）。
    :param value: 原始值。
    :returns: 归一化后的字符串值。
    :raises ValueError: number 类型非正整数时抛出，message 与 Node 一致
                        （``{label} 必须是正整数``）。
    """
    if field["type"] == "boolean":
        return "true" if value is True or str(value).strip().lower() == "true" else "false"
    if field["type"] == "number":
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"{field['label']} 必须是正整数")
        if not parsed.is_integer() or parsed <= 0:
            raise ValueError(f"{field['label']} 必须是正整数")
        return str(int(parsed))
    return str(value if value is not None else "").strip()


def get_model_setting_fallback_values() -> dict[str, str]:
    """计算未持久化字段的运行时兜底值（对齐 Node getModelSettingFallbackValues）。

    AI 组经 ``ai_provider.get_ai_config``（与 Node services/ai/config.mjs 同源迁移）；
    AI_MODEL_CHARACTER 因 FastAPI AiConfig 未含该字段，按 Node 同款 env 链
    （AI_MODEL_CHARACTER → AI_MODEL → 'gpt-5.4'）直读；frame/video/lip-sync/audio
    组按各 Node config 解析器的 provider 分支逐条转录。

    :returns: key → 兜底值字符串。
    """
    ai_config = get_ai_config()
    frame_provider = _env("FRAME_PROVIDER", "trae-url").strip().lower()
    video_provider = _env("VIDEO_PROVIDER", "mock").strip().lower()
    lip_sync_provider = _env("LIP_SYNC_PROVIDER", "toapi").strip().lower()

    # ---- frame 组（对齐 services/frame.mjs getFrameConfig L267-L337）----
    if frame_provider == "agnes":
        frame_default_base_url = "https://apihub.agnes-ai.com/v1"
    elif frame_provider == "toapi":
        frame_default_base_url = "https://toapis.com/v1"
    elif frame_provider == "volcengine":
        frame_default_base_url = "https://ark.cn-beijing.volces.com/api/v3"
    elif frame_provider in {"bigmodel", "zhipu"}:
        frame_default_base_url = "https://open.bigmodel.cn/api/paas/v4"
    else:
        frame_default_base_url = "https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image"
    frame_configured_base_url = _normalize_base_url(_env("FRAME_BASE_URL"))
    if frame_provider == "volcengine" and "agnes-ai.com" in frame_configured_base_url.lower():
        frame_base_url = "https://ark.cn-beijing.volces.com/api/v3"
    else:
        frame_base_url = frame_configured_base_url or frame_default_base_url
    frame_configured_model = _env("FRAME_MODEL").strip()
    if frame_provider == "volcengine" and frame_configured_model.lower().startswith("agnes-"):
        frame_default_model = "doubao-seedream-5-0-flash-260915"
    elif frame_configured_model:
        frame_default_model = frame_configured_model
    elif frame_provider == "agnes":
        frame_default_model = "agnes-image-2.1-flash"
    elif frame_provider == "toapi":
        frame_default_model = "gpt-image-2"
    elif frame_provider == "volcengine":
        frame_default_model = "doubao-seedream-5-0-flash-260915"
    elif frame_provider in {"bigmodel", "zhipu"}:
        frame_default_model = "cogview-3-flash"
    else:
        frame_default_model = "trae-text2image-v1"
    if frame_provider == "volcengine":
        frame_api_key = (_env("ARK_API_KEY") or _env("VOLCENGINE_API_KEY")).strip()
    elif frame_provider in {"bigmodel", "zhipu"}:
        frame_api_key = (_env("FRAME_API_KEY") or _env("BIGMODEL_API_KEY") or _env("ZHIPU_API_KEY") or "").strip()
    elif frame_provider == "agnes":
        frame_api_key = (_env("FRAME_API_KEY") or _env("AGNES_API_KEY") or "").strip()
    elif frame_provider == "toapi":
        frame_api_key = (_env("FRAME_API_KEY") or _env("TOAPI_API_KEY") or "").strip()
    else:
        frame_api_key = (_env("FRAME_API_KEY") or _env("TOAPI_API_KEY") or _env("AGNES_API_KEY") or "").strip()
    frame_configured_fallbacks = _env("FRAME_FALLBACK_MODELS") or ("agnes-image-2.0-flash" if frame_provider == "agnes" else "")
    frame_fallback_models = ",".join(
        item.strip()
        for item in frame_configured_fallbacks.split(",")
        if item.strip() and not (frame_provider == "volcengine" and item.strip().lower().startswith("agnes-"))
    )
    frame_asset_pack_model = _env("FRAME_ASSET_PACK_MODEL").strip()
    if frame_provider == "volcengine" and frame_asset_pack_model.lower().startswith("agnes-"):
        frame_asset_pack_model = "doubao-seedream-5-0-flash-260915"
    else:
        frame_asset_pack_model = (
            frame_asset_pack_model
            or (_env("FRAME_MODEL").strip() if frame_provider == "volcengine" else "")
            or _env("FRAME_MODEL").strip()
        )

    # ---- video 组（对齐 services/video.mjs getVideoConfig L81-L152）----
    if video_provider in {"bigmodel", "zhipu"}:
        video_default_base_url = "https://open.bigmodel.cn/api/paas/v4"
    elif video_provider == "minimax":
        video_default_base_url = "https://api.minimax.cn"
    elif video_provider == "wan":
        video_default_base_url = _env("WAN_API_BASE_URL") or "https://dashscope.aliyuncs.com"
    else:
        video_default_base_url = "https://apihub.agnes-ai.com"
    if video_provider in {"bigmodel", "zhipu"}:
        video_api_key = (_env("VIDEO_API_KEY") or _env("BIGMODEL_API_KEY") or _env("ZHIPU_API_KEY") or "").strip()
    elif video_provider == "minimax":
        video_api_key = (_env("VIDEO_API_KEY") or _env("MINIMAX_API_KEY") or "").strip()
    elif video_provider == "agnes":
        video_api_key = (_env("VIDEO_API_KEY") or _env("AGNES_API_KEY") or "").strip()
    elif video_provider == "wan":
        video_api_key = (
            _env("VIDEO_API_KEY") or _env("WAN_API_KEY") or _env("DASHSCOPE_API_KEY") or ""
        ).strip()
    else:
        video_api_key = (
            _env("VIDEO_API_KEY") or _env("AGNES_API_KEY") or _env("BIGMODEL_API_KEY") or _env("ZHIPU_API_KEY") or ""
        ).strip()
    if video_provider in {"bigmodel", "zhipu"}:
        video_default_model = "cogvideox-flash"
    elif video_provider == "minimax":
        video_default_model = "MiniMax-H3"
    elif video_provider == "wan":
        video_default_model = "wan3.0-video"
    else:
        video_default_model = "agnes-video-2.5-flash"

    # ---- lip-sync 组（对齐 services/lip-sync.mjs getLipSyncConfig L26-L64）----
    if lip_sync_provider == "dashscope":
        lip_default_base_url = "https://dashscope.aliyuncs.com/api/v1"
    elif lip_sync_provider == "latentsync":
        lip_default_base_url = "http://127.0.0.1:8080"
    else:
        lip_default_base_url = "https://toapis.com/v1"
    lip_api_key = (
        _env("LIP_SYNC_API_KEY")
        or (_env("DASHSCOPE_API_KEY") if lip_sync_provider == "dashscope" else _env("TOAPI_API_KEY"))
        or ""
    ).strip()
    if lip_sync_provider == "dashscope":
        lip_default_model = "videoretalk"
    elif lip_sync_provider == "latentsync":
        lip_default_model = "LatentSync"
    else:
        lip_default_model = "seedance-2"

    return {
        # ---- text 组 ----
        "AI_PROVIDER": ai_config.provider,
        "AI_BASE_URL": ai_config.base_url,
        "AI_API_KEY": ai_config.api_key,
        "AI_MODEL": ai_config.default_model,
        "AI_MODEL_OUTLINE": ai_config.outline_model,
        "AI_MODEL_SCRIPT": ai_config.script_model,
        "AI_MODEL_STORYBOARD": ai_config.storyboard_model,
        # FastAPI AiConfig 未迁移 character_model；按 Node services/ai/config.mjs L40 同款 env 链直读。
        "AI_MODEL_CHARACTER": (_env("AI_MODEL_CHARACTER") or _env("AI_MODEL") or "gpt-5.4").strip(),
        "AI_TIMEOUT_MS": str(ai_config.timeout_ms),
        "AI_LONG_TASK_TIMEOUT_MS": str(ai_config.long_task_timeout_ms),
        "AI_FALLBACK_TO_MOCK": str(ai_config.fallback_to_mock),
        # ---- frame 组 ----
        "FRAME_PROVIDER": frame_provider,
        "FRAME_BASE_URL": frame_base_url,
        "FRAME_API_KEY": frame_api_key,
        # ARK/VOLCENGINE/BIGMODEL 三键在 Node fallback 中直读 env（不经 config 解析器）。
        "ARK_API_KEY": _env("ARK_API_KEY"),
        "VOLCENGINE_API_KEY": _env("VOLCENGINE_API_KEY"),
        "BIGMODEL_API_KEY": _env("BIGMODEL_API_KEY"),
        "FRAME_MODEL": frame_default_model,
        "FRAME_FALLBACK_MODELS": frame_fallback_models,
        "FRAME_IMAGE_SIZE": _env(
            "FRAME_IMAGE_SIZE",
            "2K" if frame_provider in {"agnes", "volcengine"}
            else ("1344x768" if frame_provider in {"bigmodel", "zhipu"} else "landscape_16_9"),
        ).strip(),
        "FRAME_IMAGE_RATIO": _env("FRAME_IMAGE_RATIO", "16:9").strip(),
        "FRAME_ASSET_PACK_MODEL": frame_asset_pack_model,
        "FRAME_CHARACTER_ASSET_PACK_ENABLED": str(
            _env_bool("FRAME_CHARACTER_ASSET_PACK_ENABLED", frame_provider in {"volcengine", "agnes"})
        ).lower(),
        "FRAME_FALLBACK_TO_MOCK": str(_env_bool("FRAME_FALLBACK_TO_MOCK", True)).lower(),
        # ---- video 组 ----
        "VIDEO_PROVIDER": video_provider,
        "VIDEO_BASE_URL": _normalize_base_url(_env("VIDEO_BASE_URL") or video_default_base_url),
        "VIDEO_API_KEY": video_api_key,
        "VIDEO_MODEL": _env("VIDEO_MODEL") or video_default_model,
        "VIDEO_SIZE": _env("VIDEO_SIZE") or ("720P" if video_provider == "agnes" else ""),
        "VIDEO_WATERMARK_ENABLED": str(_env_bool("VIDEO_WATERMARK_ENABLED", False)).lower(),
        "VIDEO_FALLBACK_TO_MOCK": str(_env_bool("VIDEO_FALLBACK_TO_MOCK", True)).lower(),
        "VIDEO_CREATE_RATE_LIMIT_MAX_REQUESTS": str(
            _env_positive_int("VIDEO_CREATE_RATE_LIMIT_MAX_REQUESTS", 2 if video_provider == "agnes" else 1000)
        ),
        "VIDEO_CREATE_RATE_LIMIT_WINDOW_MS": str(_env_positive_int("VIDEO_CREATE_RATE_LIMIT_WINDOW_MS", 60000)),
        "VIDEO_IMAGE_UPLOAD_BASE_URL": _normalize_base_url(_env("VIDEO_IMAGE_UPLOAD_BASE_URL") or "https://toapis.com/v1"),
        "VIDEO_IMAGE_UPLOAD_API_KEY": (
            _env("VIDEO_IMAGE_UPLOAD_API_KEY") or _env("TOAPI_API_KEY") or _env("FRAME_API_KEY") or ""
        ).strip(),
        # ---- video 组的 lip-sync 子组 ----
        "LIP_SYNC_PROVIDER": lip_sync_provider,
        "LIP_SYNC_BASE_URL": _normalize_base_url(_env("LIP_SYNC_BASE_URL") or lip_default_base_url),
        "LIP_SYNC_MODEL": _env("LIP_SYNC_MODEL") or lip_default_model,
        "LIP_SYNC_API_KEY": lip_api_key,
        # ---- audio 组（对齐 services/audio.mjs getAudioConfig L90-L109）----
        "AUDIO_PROVIDER": _env("AUDIO_PROVIDER", "mock").strip().lower(),
        "AUDIO_BASE_URL": _normalize_base_url(
            _env("AUDIO_BASE_URL")
            or "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
        ),
        "DASHSCOPE_API_KEY": (_env("DASHSCOPE_API_KEY") or _env("AUDIO_API_KEY") or "").strip(),
        "AUDIO_MODEL": _env("AUDIO_MODEL") or "qwen3-tts-flash",
        "AUDIO_FALLBACK_MODEL": _env("AUDIO_FALLBACK_MODEL") or "qwen3-tts-instruct-flash",
        "AUDIO_VOICE": _env("AUDIO_VOICE") or "Cherry",
        "AUDIO_LANGUAGE_TYPE": _env("AUDIO_LANGUAGE_TYPE") or "Chinese",
        "AUDIO_FALLBACK_TO_MOCK": str(_env_bool("AUDIO_FALLBACK_TO_MOCK", False)).lower(),
    }


def build_model_settings_payload(persisted: dict[str, str]) -> dict[str, Any]:
    """构建设置中心 payload（对齐 Node buildModelSettingsPayload，index.mjs L6618）。

    :param persisted: model_settings 表的 ``{setting_key: setting_value}`` 映射。
    :returns: ``{groups, fields, effective}``；fields 每项含 value/persisted/
              secretConfigured/source；secret 类型 value 恒空串不回显。
    """
    fallbacks = get_model_setting_fallback_values()
    fields: list[dict[str, Any]] = []
    for field in MODEL_SETTING_FIELDS:
        key = field["key"]
        has_stored_value = key in persisted
        effective_value = (
            str(persisted.get(key) if persisted.get(key) is not None else "")
            if has_stored_value
            else str(fallbacks.get(key) or _env(key) or "")
        )
        secret_configured = field["type"] == "secret" and bool(str(effective_value).strip())
        fields.append(
            {
                **field,
                "value": "" if field["type"] == "secret" else effective_value,
                "persisted": has_stored_value,
                "secretConfigured": secret_configured,
                "source": "database" if has_stored_value else "environment",
            }
        )

    return {
        "groups": MODEL_SETTING_GROUPS,
        "fields": fields,
        "effective": {
            # effective 与 Node 同源：直接取各 config 解析器的当前生效值（即兜底映射值）。
            "text": {
                "provider": fallbacks["AI_PROVIDER"],
                "defaultModel": fallbacks["AI_MODEL"],
                "outlineModel": fallbacks["AI_MODEL_OUTLINE"],
                "scriptModel": fallbacks["AI_MODEL_SCRIPT"],
                "storyboardModel": fallbacks["AI_MODEL_STORYBOARD"],
                "characterModel": fallbacks["AI_MODEL_CHARACTER"],
            },
            "frame": {
                "provider": fallbacks["FRAME_PROVIDER"],
                "defaultModel": fallbacks["FRAME_MODEL"],
                # Node frameConfig.fallbackModels 为数组（parseFrameModelList）；兜底映射是 join(',') 形态。
                "fallbackModels": [item for item in fallbacks["FRAME_FALLBACK_MODELS"].split(",") if item],
                "imageSize": fallbacks["FRAME_IMAGE_SIZE"],
                "imageRatio": fallbacks["FRAME_IMAGE_RATIO"],
            },
            "video": {
                "provider": fallbacks["VIDEO_PROVIDER"],
                "defaultModel": fallbacks["VIDEO_MODEL"],
                "size": fallbacks["VIDEO_SIZE"],
                "lipSyncProvider": fallbacks["LIP_SYNC_PROVIDER"],
                "lipSyncModel": fallbacks["LIP_SYNC_MODEL"],
            },
            "audio": {
                "provider": fallbacks["AUDIO_PROVIDER"],
                "defaultModel": fallbacks["AUDIO_MODEL"],
                "fallbackModel": fallbacks["AUDIO_FALLBACK_MODEL"],
                "defaultVoice": fallbacks["AUDIO_VOICE"],
            },
        },
    }


def save_model_settings(settings: Any, user_id: int | None, upsert_setting: Any) -> None:
    """保存模型设置（对齐 Node saveModelSettings，index.mjs L6679）。

    逐条 upsert 到 model_settings 表；``secret`` 类型空值跳过（避免清空密钥）；
    未注册 key 忽略；归一化失败（如数值非法）抛错由路由转为 400/4001。
    Node 同款行为还会把生效值合并回 process.env——FastAPI 进程内 env 合并仅影响
    当前进程且 Node 侧 Worker 独立读取 DB，此处保持 DB 持久化为唯一事实源。

    :param settings: 前端提交的 ``[{key, value}]`` 数组。
    :param user_id: 操作用户 id（可为 None）。
    :param upsert_setting: DB 层 upsert 回调 ``upsert_setting(key, value, user_id)``。
    :raises ValueError: settings 非数组或字段值非法（message 与 Node 一致）。
    """
    if not isinstance(settings, list):
        raise ValueError("设置格式不正确")
    for item in settings:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "").strip()
        field = MODEL_SETTING_FIELD_MAP.get(key)
        if field is None:
            continue
        if field["type"] == "secret" and not str(item.get("value") or "").strip():
            continue
        value = normalize_model_setting_value(field, item.get("value"))
        upsert_setting(key, value, user_id)
