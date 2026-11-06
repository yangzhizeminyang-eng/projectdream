"""短信（SMS）供应商适配层接口与公共错误类型。

对齐 Node ``server/index.mjs`` 的 ``sendVerificationCode`` 返回形状：
``{"provider", "countdown", "expiresIn", "devCode"?}``。其中 ``devCode`` 仅
mock 供应商返回（Node 中 tencent/aliyun 分支不携带该键，JSON 序列化时省略），
``CODE_TTL_SECONDS`` 与 Node L324 一致（5 分钟）。
"""

from __future__ import annotations

# 短信验证码有效期（秒），对齐 Node CODE_TTL_SECONDS = 5 * 60。
CODE_TTL_SECONDS = 5 * 60
# 发送冷却时间（秒），对齐 Node mock / tencent 分支固定返回的 countdown。
SEND_COUNTDOWN_SECONDS = 60


class SmsSendError(Exception):
    """短信发送失败（供应商返回错误状态或配置缺失），消息面向用户可直接展示。

    Node 侧等价行为：sendVerificationCode 抛错 → 全局兜底 500/5001 + error.message。
    本异常的消息由适配器用受控文案构造（不透传 SDK 原始堆栈），网关捕获后
    以 500/5001 + 该消息返回，与 Node envelope 形状一致且不泄漏内部细节。
    """

    def __init__(self, message: str) -> None:
        """构造发送失败异常。

        :param message: 面向用户的受控错误文案（如「腾讯云短信发送失败」）。
        """
        super().__init__(message)


class SmsProvider:
    """短信供应商适配器接口。

    子类只需实现 :meth:`send_code`，返回与 Node ``sendVerificationCode``
    一致的 dict；发送失败抛 :class:`SmsSendError`。
    """

    def send_code(self, phone: str, code_type: str, code: str) -> dict[str, object]:
        """向指定手机号发送短信验证码。

        :param phone: 11 位标准化手机号。
        :param code_type: 验证码用途（login / register / reset，随 SessionContext 透传）。
        :param code: 6 位数字验证码明文。
        :returns: ``{"provider": str, "countdown": int, "expiresIn": int, "devCode": str|None}``。
        :raises SmsSendError: 供应商返回失败状态时抛出。
        :raises NotImplementedError: 基类未实现时抛出。
        """
        raise NotImplementedError
