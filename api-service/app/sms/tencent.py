"""腾讯云短信供应商适配器（tencentcloud-sdk-python-sms）。

对齐 Node ``sendVerificationCode`` 的 tencent 分支（server/index.mjs L6428-L6451）：
- ``PhoneNumberSet`` 带 ``+86`` 前缀；
- ``SessionContext`` 透传验证码用途（login / register / reset）；
- ``SendStatusSet[0].Code !== 'Ok'`` 时抛错（消息取 ``Message``，兜底固定文案）；
- 成功返回 ``{provider: 'tencent', countdown: 60, expiresIn: 300}``（不含 devCode）。

SDK 为延迟导入：包未安装时在构造期抛出 :class:`ImportError`，由工厂捕获并降级
mock（不阻断应用启动）。
"""

from __future__ import annotations

import logging
from typing import Any

from .provider import CODE_TTL_SECONDS, SEND_COUNTDOWN_SECONDS, SmsProvider, SmsSendError

logger = logging.getLogger("projectdream-api.sms")

# SendStatusSet 中表示发送成功的状态码（对齐 Node sendStatus.Code !== 'Ok' 判定）。
TENCENT_SUCCESS_CODE = "Ok"


class TencentSmsProvider(SmsProvider):
    """腾讯云短信适配器：封装 SmsClient.SendSms 并映射 Node 的入参/出参/错误语义。"""

    def __init__(
        self,
        secret_id: str,
        secret_key: str,
        sdk_app_id: str,
        sign_name: str,
        template_id: str,
        region: str = "ap-guangzhou",
    ) -> None:
        """构造腾讯云 SMS 客户端（对齐 Node 的 credential / region / TC3 签名配置）。

        :param secret_id: 腾讯云 API 密钥 SecretId（TENCENTCLOUD_SECRET_ID）。
        :param secret_key: 腾讯云 API 密钥 SecretKey（TENCENTCLOUD_SECRET_KEY）。
        :param sdk_app_id: 短信应用 SdkAppId（TENCENTCLOUD_SMS_SDK_APP_ID）。
        :param sign_name: 短信签名内容（TENCENTCLOUD_SMS_SIGN_NAME）。
        :param template_id: 短信模板 ID（TENCENTCLOUD_SMS_TEMPLATE_ID）。
        :param region: 地域（TENCENTCLOUD_SMS_REGION，缺省 ap-guangzhou，与 Node 一致）。
        :raises ImportError: tencentcloud-sdk-python-sms 未安装时抛出（工厂负责降级 mock）。
        """
        self._secret_id = secret_id
        self._secret_key = secret_key
        self._region = region
        sdk = self._import_sdk()
        self._sdk_modules = sdk
        credential_cls = sdk["credential"].Credential
        sms_client_cls = sdk["sms_client"].SmsClient
        self._client: Any = sms_client_cls(
            credential=credential_cls(secret_id, secret_key),
            region=region,
        )
        self._sdk_app_id = sdk_app_id
        self._sign_name = sign_name
        self._template_id = template_id

    def _import_sdk(self) -> dict[str, Any]:
        """延迟导入腾讯云 SMS SDK 的所需子模块（便于在测试中注入导入失败场景）。

        ``tencentcloud`` 是命名空间包，子模块需显式导入才有属性。

        :returns: ``{"credential", "sms_client", "models"}`` 模块字典。
        :raises ImportError: SDK 未安装时抛出。
        """
        import importlib

        return {
            "credential": importlib.import_module("tencentcloud.common.credential"),
            "sms_client": importlib.import_module("tencentcloud.sms.v20210111.sms_client"),
            "models": importlib.import_module("tencentcloud.sms.v20210111.models"),
        }

    def send_code(self, phone: str, code_type: str, code: str) -> dict[str, Any]:
        """调用腾讯云 SendSms 发送验证码（入参/校验/返回与 Node tencent 分支逐项对齐）。

        :param phone: 11 位标准化手机号（函数内部补 ``+86`` 前缀）。
        :param code_type: 验证码用途，透传给 ``SessionContext``。
        :param code: 6 位数字验证码明文（模板参数）。
        :returns: ``{"provider": "tencent", "countdown": 60, "expiresIn": 300, "devCode": None}``。
        :raises SmsSendError: SendStatusSet 为空、状态码非 'Ok' 或 SDK 调用异常时抛出。
        """
        sms_models = self._sdk_modules["models"]
        request = sms_models.SendSmsRequest()
        request.PhoneNumberSet = [f"+86{phone}"]
        request.SmsSdkAppId = self._sdk_app_id
        request.SignName = self._sign_name
        request.TemplateId = self._template_id
        request.TemplateParamSet = [code]
        request.SessionContext = code_type
        try:
            response = self._client.SendSms(request)
        except SmsSendError:
            raise
        except Exception as exc:  # SDK 网络/签名异常统一收口为受控文案
            raise SmsSendError(f"腾讯云短信发送失败：{type(exc).__name__}") from exc
        status_set = getattr(response, "SendStatusSet", None) or []
        status = status_set[0] if status_set else None
        status_code = str(getattr(status, "Code", "") or "")
        if status is None or status_code != TENCENT_SUCCESS_CODE:
            message = str(getattr(status, "Message", "") or "") or "腾讯云短信发送失败"
            raise SmsSendError(message)
        logger.info(
            "[tencent-sms] type=%s phone=%s serialNo=%s",
            code_type,
            phone,
            getattr(status, "SerialNo", "") or "",
        )
        return {
            "provider": "tencent",
            "countdown": SEND_COUNTDOWN_SECONDS,
            "expiresIn": CODE_TTL_SECONDS,
            "devCode": None,
        }
