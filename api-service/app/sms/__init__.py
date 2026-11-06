"""短信供应商适配层（FastAPI-Only 迁移第三阶段：auth 组原生化配套）。

对外入口：:func:`create_sms_provider` 工厂。依据 ``SMS_PROVIDER`` 环境变量选择
供应商；tencent 凭据缺失或 SDK 不可用时记录启动期警告并自动降级 mock（不 crash），
优于 Node「发送期才抛『腾讯云短信未配置完成』」的行为。
"""

from __future__ import annotations

import logging
from typing import Any

from .mock import MockSmsProvider
from .provider import CODE_TTL_SECONDS, SEND_COUNTDOWN_SECONDS, SmsProvider, SmsSendError
from .tencent import TencentSmsProvider

logger = logging.getLogger("projectdream-api.sms")

__all__ = [
    "CODE_TTL_SECONDS",
    "SEND_COUNTDOWN_SECONDS",
    "MockSmsProvider",
    "SmsProvider",
    "SmsSendError",
    "TencentSmsProvider",
    "create_sms_provider",
]

# tencent 供应商必需的配置字段：(Settings 属性名, 缺失告警用的字段标识)。
_TENCENT_REQUIRED_FIELDS = (
    ("tencent_secret_id", "TENCENTCLOUD_SECRET_ID"),
    ("tencent_secret_key", "TENCENTCLOUD_SECRET_KEY"),
    ("tencent_sms_sdk_app_id", "TENCENTCLOUD_SMS_SDK_APP_ID"),
    ("tencent_sms_sign_name", "TENCENTCLOUD_SMS_SIGN_NAME"),
    ("tencent_sms_template_id", "TENCENTCLOUD_SMS_TEMPLATE_ID"),
)


def create_sms_provider(settings: Any) -> SmsProvider:
    """按配置构建短信供应商；tencent 配置缺失/SDK 不可用时降级 mock。

    降级策略（与 Node 的差异，刻意收紧为启动期可见）：
    - ``SMS_PROVIDER=tencent`` 且任一必填凭据缺失 → 启动期 warning + mock；
    - SDK 未安装 / 客户端构造失败 → 启动期 warning + mock；
    - 其他未知取值（含 aliyun，本阶段未移植）→ warning + mock。
    降级后 ``provider`` 以 ``mock`` 身份返回（devCode 可用），保证登录链路可走通。

    :param settings: 应用配置对象（需含 sms_provider 及 tencent_* 字段）。
    :returns: 就绪的 :class:`SmsProvider` 实例（永不返回 None）。
    """
    provider_name = str(getattr(settings, "sms_provider", "") or "mock").strip().lower()
    if provider_name == "tencent":
        missing = [
            env_name
            for attr, env_name in _TENCENT_REQUIRED_FIELDS
            if not str(getattr(settings, attr, "") or "").strip()
        ]
        if missing:
            logger.warning(
                "SMS_PROVIDER=tencent 但缺少必需配置：%s；已自动降级为 mock 短信供应商"
                "（devCode 将写入日志与响应，生产环境请补齐配置）",
                ", ".join(missing),
            )
            return MockSmsProvider()
        try:
            return TencentSmsProvider(
                secret_id=str(settings.tencent_secret_id),
                secret_key=str(settings.tencent_secret_key),
                sdk_app_id=str(settings.tencent_sms_sdk_app_id),
                sign_name=str(settings.tencent_sms_sign_name),
                template_id=str(settings.tencent_sms_template_id),
                region=str(getattr(settings, "tencent_sms_region", "") or "ap-guangzhou"),
            )
        except Exception as exc:
            logger.warning(
                "腾讯云短信 SDK 初始化失败（%s: %s）；已自动降级为 mock 短信供应商",
                type(exc).__name__,
                exc,
            )
            return MockSmsProvider()
    if provider_name != "mock":
        logger.warning(
            "SMS_PROVIDER=%s 不受支持（当前仅支持 tencent/mock）；已自动降级为 mock 短信供应商",
            provider_name,
        )
    return MockSmsProvider()
