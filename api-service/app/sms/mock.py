"""mock 短信供应商：开发/测试模式，验证码经日志输出并作为 devCode 返回。

对齐 Node ``sendVerificationCode`` mock 分支（server/index.mjs L6366-L6375）：
``console.log('[mock-sms] type=... phone=... code=... expiresIn=300s')`` 后返回
``{provider: 'mock', countdown: 60, expiresIn: 300, devCode: code}``。
"""

from __future__ import annotations

import logging
from typing import Any

from .provider import CODE_TTL_SECONDS, SEND_COUNTDOWN_SECONDS, SmsProvider

logger = logging.getLogger("projectdream-api.sms")


class MockSmsProvider(SmsProvider):
    """mock 供应商：不发出真实短信，验证码写入应用日志并回传 devCode。"""

    def send_code(self, phone: str, code_type: str, code: str) -> dict[str, Any]:
        """记录验证码日志并返回 devCode 形状的结果（对齐 Node mock 分支）。

        :param phone: 11 位标准化手机号。
        :param code_type: 验证码用途（login / register / reset）。
        :param code: 6 位数字验证码明文。
        :returns: ``{"provider": "mock", "countdown": 60, "expiresIn": 300, "devCode": code}``。
        :raises SmsSendError: 本供应商不会失败（无外部依赖）。
        """
        # 日志文案与 Node '[mock-sms] type=... phone=... code=... expiresIn=300s' 对齐，
        # 便于本地开发时在两侧日志中用同一模式检索验证码。
        logger.info(
            "[mock-sms] type=%s phone=%s code=%s expiresIn=%ss",
            code_type,
            phone,
            code,
            CODE_TTL_SECONDS,
        )
        return {
            "provider": "mock",
            "countdown": SEND_COUNTDOWN_SECONDS,
            "expiresIn": CODE_TTL_SECONDS,
            "devCode": code,
        }
