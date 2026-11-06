"""鉴权组扩展 6 条路由（captcha / verify / send-code / reset-password / login / register）
的兼容测试（阶段 8.1，FastAPI-Only 迁移第三阶段第一组）。

对照规格：``api-service/docs/auth-group-spec.md`` §3 错误码矩阵与 §4.3-§4.8 逐条路由规格；
Node 权威源：``server/index.mjs`` L12268-L12482 + ``server/services/auth-captcha.mjs``。
全部离线执行（fake database / mock SMS / 注入式 captcha 服务）。
第四阶段已删除过渡开关：整组恒为原生实现，回退代理专项测试随实现一并移除。

> 重建说明：本文件在第四阶段因一次性截断脚本误伤而依据 pytest assertion-rewrite
> 字节码缓存（__pycache__ pyc：docstring/常量/断言模板/参数化表）与 auth-group-spec.md
> 规格高保真重建；测试函数清单与断言语义与原版一致，个别字面量按规格还原。
"""

from __future__ import annotations

import base64
import hashlib
import hmac as hmac_mod
import json
import logging
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.auth_captcha import AuthCaptchaService
from app.config import Settings
from app.main import create_app
from app.sms import MockSmsProvider, SmsSendError, TencentSmsProvider, create_sms_provider

# 与 Node hashPassword（SHA-256 hex）一致的测试口令 "123456" 的哈希值。
PASSWORD_HASH = hashlib.sha256("123456".encode()).hexdigest()
# 滑块验证码 HMAC 签名密钥（测试固定值，与 make_captcha_service 注入一致）。
CAPTCHA_SECRET = "test-captcha-secret"
# 固定缺口正确位置（make_captcha_service 注入，测试断言与之对照）。
FIXED_TARGET_X = 140


class ExtendedAuthDatabase:
    """鉴权组扩展测试的最小数据库桩（users / sessions / sms_codes / auth_captcha_sessions）。

    :ivar users: 以标准化手机号为键的用户表。
    :ivar sessions: token -> user_id 的会话表。
    :ivar sms_codes: 短信验证码记录列表（含 used_at / expires_at）。
    :ivar captcha_sessions: challenge_id -> 会话记录（对齐迁移 0004 的行语义）。
    :ivar now: 桩内时钟（秒，float）；用 :meth:`advance` 推进以测试过期分支。
    :ivar fail_on: 故障注入集合，列于其中的方法名被调用时抛 RuntimeError。
    """

    def __init__(self):
        """预置一个已注册用户（13912345678 / 测试用户 / 口令 123456）与空表结构。"""
        self.now = 1000000.0
        self.users = {
            "13912345678": {
                "id": 7,
                "phone": "13912345678",
                "nickname": "测试用户",
                "password_hash": PASSWORD_HASH,
            }
        }
        self._passwords = {"13912345678": PASSWORD_HASH}
        self.sessions = {}
        self.sms_codes = []
        self.captcha_sessions = {}
        self.sms_code_seq = 0
        self.session_calls = 0
        self.fail_on = set()

    def advance(self, seconds: float) -> None:
        """推进桩内时钟。

        :param seconds: 前进的秒数。
        """
        self.now += seconds

    def _check(self, method_name: str) -> None:
        """故障注入检查。

        :param method_name: 当前被调用的方法名。
        :raises RuntimeError: 方法名被注入 fail_on 时模拟数据库离线。
        """
        if method_name in self.fail_on:
            raise RuntimeError("database offline")

    def fetch_user_by_phone(self, phone):
        """按标准化手机号查询用户。

        :param phone: 11 位标准化手机号。
        :return: 命中返回用户 dict，未注册返回 None。
        :raises RuntimeError: 故障注入时抛出。
        """
        self._check("fetch_user_by_phone")
        return self.users.get(phone)

    def create_session(self, user):
        """为用户创建登录会话（每次新 token，不吊销旧会话）。

        :param user: 用户 dict。
        :return: 新会话 token。
        """
        self._check("create_session")
        self.session_calls += 1
        token = f"session-token-{self.session_calls}"
        self.sessions[token] = user["id"]
        return token

    def find_user_by_token(self, token):
        """按 token 反查用户（网关受保护路由使用，本文件主要做会话有效性断言）。

        :param token: 访问令牌。
        :return: 命中返回用户 dict，否则 None。
        """
        user_id = self.sessions.get(token)
        return next((u for u in self.users.values() if u["id"] == user_id), None)

    def create_user(self, phone, nickname, password):
        """创建新用户（SHA-256 哈希落库，形状对齐 Node createUser 返回值）。

        :param phone: 11 位标准化手机号。
        :param nickname: 已 strip 的昵称。
        :param password: 明文密码。
        :return: {"id", "phone", "nickname", "createdAt"} 用户 dict。
        """
        self._check("create_user")
        user_id = max((u["id"] for u in self.users.values()), default=0) + 1
        user = {
            "id": user_id,
            "phone": phone,
            "nickname": nickname,
            "createdAt": "2026-10-17T00:00:00.000Z",
        }
        self.users[phone] = user
        self._passwords[phone] = hashlib.sha256(password.encode()).hexdigest()
        return user

    def update_user_password(self, user_id, new_password):
        """更新用户密码哈希。

        :param user_id: 用户 id。
        :param new_password: 新明文密码。
        """
        self._check("update_user_password")
        for user in self.users.values():
            if user["id"] == user_id:
                self._passwords[user["phone"]] = hashlib.sha256(new_password.encode()).hexdigest()
                return

    def save_sms_code_record(self, phone, code_type, code, provider, expires_in_seconds):
        """写入短信验证码记录（先清理过期行，语义对齐 Node saveCodeRecord）。

        :param phone: 手机号。
        :param code_type: 用途。
        :param code: 验证码。
        :param provider: 供应商标识。
        :param expires_in_seconds: 有效期秒数。
        """
        self._check("save_sms_code_record")
        self.sms_codes = [r for r in self.sms_codes if r["expires_at"] > self.now]
        self.sms_code_seq += 1
        self.sms_codes.append({
            "id": self.sms_code_seq,
            "phone": phone,
            "code_type": code_type,
            "code": code,
            "provider": provider,
            "expires_at": self.now + expires_in_seconds,
            "used_at": None,
        })

    def verify_sms_code(self, phone, code_type, code):
        """消费短信验证码（逐项对齐 Node consumeCode 的判定顺序与文案）。

        :param phone: 手机号。
        :param code_type: 用途。
        :param code: 用户提交的验证码。
        :return: {"ok": bool, "message": str|None}。
        :raises RuntimeError: 故障注入时抛出。
        """
        self._check("verify_sms_code")
        self.sms_codes = [r for r in self.sms_codes if r["expires_at"] > self.now]
        candidates = [r for r in self.sms_codes if r["phone"] == phone and r["code_type"] == code_type]
        record = candidates[-1] if candidates else None
        if record is None:
            return {"ok": False, "message": "验证码不存在或已过期"}
        if record["used_at"]:
            return {"ok": False, "message": "验证码已失效，请重新获取"}
        if record["expires_at"] <= self.now:
            self.sms_codes.remove(record)
            return {"ok": False, "message": "验证码已过期，请重新获取"}
        if str(record["code"]) != str(code or ""):
            return {"ok": False, "message": "验证码错误"}
        record["used_at"] = self.now
        return {"ok": True, "message": None}

    def prune_auth_captcha_sessions(self):
        """清理过期挑战/token 会话（对齐 Node pruneExpired）。

        :raises RuntimeError: 故障注入时抛出。
        """
        self._check("prune_auth_captcha_sessions")
        self.captcha_sessions = {cid: r for cid, r in self.captcha_sessions.items() if r["expires_at"] > self.now}

    def create_auth_captcha_session(self, challenge_id, phone, ip, target_x, ttl_seconds):
        """写入滑块挑战会话。

        :param challenge_id: 挑战 id。
        :param phone: 绑定手机号。
        :param ip: 绑定 IP。
        :param target_x: 缺口正确位置。
        :param ttl_seconds: 有效期秒数。
        """
        self._check("create_auth_captcha_session")
        self.captcha_sessions[challenge_id] = {
            "challenge_id": challenge_id,
            "phone": phone,
            "ip": ip,
            "target_x": target_x,
            "attempts": 0,
            "verified": 0,
            "captcha_token": None,
            "consumed_at": None,
            "expires_at": self.now + ttl_seconds,
        }

    def fetch_auth_captcha_session(self, challenge_id):
        """读取滑块挑战会话（含 DB 时钟计算的 is_expired 标记）。

        :param challenge_id: 挑战 id。
        :return: 会话行 dict 或 None。
        """
        self._check("fetch_auth_captcha_session")
        record = self.captcha_sessions.get(challenge_id)
        if record is None:
            return None
        return {
            "phone": record["phone"],
            "ip": record["ip"],
            "target_x": record["target_x"],
            "attempts": record["attempts"],
            "verified": record["verified"],
            "is_expired": 1 if record["expires_at"] <= self.now else 0,
        }

    def delete_auth_captcha_session(self, challenge_id):
        """删除滑块挑战会话。

        :param challenge_id: 挑战 id。
        """
        self._check("delete_auth_captcha_session")
        self.captcha_sessions.pop(challenge_id, None)

    def increment_auth_captcha_attempts(self, challenge_id):
        """尝试次数 +1 并返回新值；行不存在返回 None。

        :param challenge_id: 挑战 id。
        :return: 新尝试次数或 None。
        """
        self._check("increment_auth_captcha_attempts")
        record = self.captcha_sessions.get(challenge_id)
        if record is None:
            return None
        record["attempts"] += 1
        return record["attempts"]

    def mark_auth_captcha_verified(self, challenge_id, captcha_token, ttl_seconds):
        """verify 通过：原子置 verified=1、写 token、改写 expires_at 为 token 有效期。

        :param challenge_id: 挑战 id。
        :param captcha_token: 一次性验证 token。
        :param ttl_seconds: token 有效期秒数。
        :return: 成功 True；已被并发消费 False。
        """
        self._check("mark_auth_captcha_verified")
        record = self.captcha_sessions.get(challenge_id)
        if record is None or record["verified"]:
            return False
        record["verified"] = 1
        record["captcha_token"] = captcha_token
        record["expires_at"] = self.now + ttl_seconds
        return True

    def consume_auth_captcha_token(self, challenge_id, captcha_token):
        """一次性消费验证 token（原子语义：verified=1 + token 匹配 + 未消费 + 未过期）。

        :param challenge_id: 挑战 id。
        :param captcha_token: token 串。
        :return: 消费成功 True。
        """
        self._check("consume_auth_captcha_token")
        record = self.captcha_sessions.get(challenge_id)
        if (
            record is not None
            and record["verified"]
            and record["captcha_token"] == captcha_token
            and record["consumed_at"] is None
            and record["expires_at"] > self.now
        ):
            record["consumed_at"] = self.now
            return True
        return False


def make_client(database=None, captcha_service=None, sms_provider=None):
    """构建鉴权组扩展测试客户端（第四阶段起恒为原生模式，直连数据库桩）。

    :param database: 注入的数据库桩；缺省使用 ExtendedAuthDatabase()。
    :param captcha_service: 注入的滑块验证码服务；缺省按 Settings 构建。
    :param sms_provider: 注入的短信供应商；缺省按 Settings 构建（mock）。
    :return: 配置完成的 TestClient。
    """
    return TestClient(
        create_app(
            Settings(_env_file=None),
            database=database or ExtendedAuthDatabase(),
            captcha_service=captcha_service,
            sms_provider=sms_provider,
        ),
        raise_server_exceptions=False,
    )


def make_captcha_service(database, target_x=FIXED_TARGET_X, ttl_ms=300_000):
    """构建固定缺口位置/调色板的滑块验证码服务（对齐 Node 测试的注入手法）。

    :param database: 数据库桩。
    :param target_x: 固定的缺口位置。
    :param ttl_ms: TTL 毫秒。
    :return: AuthCaptchaService 实例。
    """
    return AuthCaptchaService(
        database,
        CAPTCHA_SECRET,
        ttl_ms=ttl_ms,
        random_target_x=lambda: target_x,
        random_palette=lambda: 0,
    )


def make_native_client(database=None):
    """构建带固定缺口位置的完整原生客户端（captcha 服务 + mock SMS 均注入）。

    :param database: 数据库桩；缺省新建。
    :return: (TestClient, database) 二元组。
    """
    database = database or ExtendedAuthDatabase()
    client = make_client(
        database=database,
        captcha_service=make_captcha_service(database),
        sms_provider=MockSmsProvider(),
    )
    return client, database


def solve_captcha(client, phone=""):
    """走完整滑块链路并返回 captchaToken（测试辅助：正确位置恒为 FIXED_TARGET_X）。

    :param client: 已注入固定 captcha 服务的测试客户端。
    :param phone: 绑定手机号（可选）。
    :return: verify 通过签发的 captchaToken。
    """
    issued = client.get("/api/auth/captcha", params={"phone": phone} if phone else {})
    assert issued.status_code == 200
    verified = client.post(
        "/api/auth/captcha/verify",
        json={"challenge": issued.json()["data"]["challenge"], "position": FIXED_TARGET_X, "phone": phone},
    )
    assert verified.json()["message"] == "verified" or verified.status_code == 200
    return verified.json()["data"]["captchaToken"]


def solve_raw_challenge(client, phone=""):
    """签发一个新挑战并返回原始 challenge 串（不做 verify）。

    :param client: 测试客户端。
    :param phone: 绑定手机号（可选）。
    :return: challenge 签名串。
    """
    issued = client.get("/api/auth/captcha", params={"phone": phone} if phone else {})
    return issued.json()["data"]["challenge"]


def test_captcha_challenge_shape_matches_node_contract():
    """挑战签发：data 字段集合与常量值逐项对齐 Node（不含 targetX，防泄露答案）。

    :return: None。
    """
    database = ExtendedAuthDatabase()
    client = make_client(database=database, captcha_service=make_captcha_service(database), sms_provider=MockSmsProvider())

    response = client.get("/api/auth/captcha", params={"phone": "139 1234 5678"})

    assert response.status_code == 200
    assert response.json()["message"] == "success"
    data = response.json()["data"]
    assert list(data.keys()) == [
        "challengeId", "challenge", "backgroundImage", "pieceImage",
        "trackWidth", "imageHeight", "pieceSize", "pieceTop", "expiresAt",
    ]
    assert data["trackWidth"] == 320
    assert data["imageHeight"] == 120
    assert data["pieceSize"] == 56
    assert data["pieceTop"] == 32
    assert data["backgroundImage"].startswith("data:image/svg+xml,")
    assert data["pieceImage"].startswith("data:image/svg+xml,")

    encoded, signature = data["challenge"].split(".")
    expected = base64.urlsafe_b64encode(
        hmac_mod.digest(CAPTCHA_SECRET.encode(), encoded.encode(), "sha256")
    ).decode().rstrip("=")
    assert signature == expected

    payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
    assert payload["id"] == data["challengeId"]
    assert payload["expiresAt"] - payload["issuedAt"] == 300000
    assert "targetX" not in payload
    assert "targetX" not in data
    assert data["expiresAt"] == payload["expiresAt"]

    stored = list(database.captcha_sessions.values())[0]
    assert stored["phone"] == "13912345678"
    assert stored["target_x"] == FIXED_TARGET_X


def test_captcha_verify_tolerance_boundary_matches_node_eight_px():
    """verify 容差边界：|position - targetX| == 8 通过、== 9 失败（对齐 Node > 8 判失败）。

    :return: None。
    """
    database = ExtendedAuthDatabase()
    client = make_client(database=database, captcha_service=make_captcha_service(database), sms_provider=MockSmsProvider())

    at_edge = client.post(
        "/api/auth/captcha/verify",
        json={"challenge": solve_raw_challenge(client), "position": FIXED_TARGET_X + 8},
    )
    assert at_edge.status_code == 200
    assert at_edge.json()["message"] == "滑块验证通过"
    assert at_edge.json()["data"]["captchaToken"]

    beyond_edge = client.post(
        "/api/auth/captcha/verify",
        json={"challenge": solve_raw_challenge(client), "position": FIXED_TARGET_X + 9},
    )
    assert beyond_edge.status_code == 409
    assert beyond_edge.json() == {"code": 4010, "message": "请将滑块拖到高亮位置", "data": None}


def test_captcha_verify_replay_rejected_after_success():
    """一次性消费：verify 通过后同一挑战再次 verify → 409/4010「已使用或不存在」。

    :return: None。
    """
    client, _ = make_native_client()
    challenge = solve_raw_challenge(client)
    body = {"challenge": challenge, "position": FIXED_TARGET_X}

    first = client.post("/api/auth/captcha/verify", json=body)
    assert first.status_code == 200

    second = client.post("/api/auth/captcha/verify", json=body)
    assert second.status_code == 409
    assert second.json() == {"code": 4010, "message": "滑块挑战已使用或不存在", "data": None}


def test_captcha_verify_expired_challenge_reports_used_or_missing_like_node():
    """过期挑战：Node verify 先 pruneExpired 再查 Map，可观测消息是「已使用或不存在」
    （源码中「已过期」分支不可达）；Python 复刻该实际行为而非死分支文案。

    :return: None。
    """
    database = ExtendedAuthDatabase()
    client = make_client(database=database, captcha_service=make_captcha_service(database), sms_provider=MockSmsProvider())
    challenge = solve_raw_challenge(client)

    database.advance(301)
    response = client.post("/api/auth/captcha/verify", json={"challenge": challenge, "position": FIXED_TARGET_X})

    assert response.status_code == 409
    assert response.json() == {"code": 4010, "message": "滑块挑战已使用或不存在", "data": None}


def test_captcha_verify_max_attempts_deletes_challenge():
    """尝试次数：位置错误可重试 5 次（每次 attempts+1），第 6 次 → 「尝试次数过多」并删除。

    :return: None。
    """
    database = ExtendedAuthDatabase()
    client = make_client(database=database, captcha_service=make_captcha_service(database), sms_provider=MockSmsProvider())
    challenge = solve_raw_challenge(client)

    for _ in range(5):
        response = client.post("/api/auth/captcha/verify", json={"challenge": challenge, "position": 100})
        assert response.json()["message"] == "请将滑块拖到高亮位置"

    sixth = client.post("/api/auth/captcha/verify", json={"challenge": challenge, "position": 100})
    assert sixth.status_code == 409
    assert sixth.json() == {"code": 4010, "message": "滑块挑战尝试次数过多", "data": None}
    assert client.post("/api/auth/captcha/verify", json={"challenge": challenge, "position": 100}).json()["message"] == "滑块挑战已使用或不存在"


@pytest.mark.parametrize(
    ("challenge", "expected_message"),
    [
        ("garbage", "滑块挑战签名无效"),
        ("not.a.valid.challenge", "滑块挑战签名无效"),
        ("x", "滑块挑战签名无效"),
        ("x" * 4097, "滑块挑战签名无效"),
        ("a.b.c", "滑块挑战签名无效"),
    ],
)
def test_captcha_verify_rejects_malformed_challenges(challenge, expected_message):
    """畸形挑战：签名/格式/超长输入统一 409/4010，且不抛 500（对齐 Node auth-captcha.test.mjs）。

    :param challenge: 畸形挑战串。
    :param expected_message: 期望的错误消息。
    :return: None。
    """
    client, _ = make_native_client()

    response = client.post("/api/auth/captcha/verify", json={"challenge": challenge, "position": 1})

    assert response.status_code == 409
    assert response.json() == {"code": 4010, "message": expected_message, "data": None}


def test_captcha_verify_binds_phone_when_challenge_created_with_one():
    """来源一致性：带手机号签发的挑战用不同手机号 verify → 「滑块挑战手机号不一致」。

    :return: None。
    """
    client, _ = make_native_client()
    challenge = solve_raw_challenge(client, phone="13912345678")

    response = client.post(
        "/api/auth/captcha/verify",
        json={"challenge": challenge, "position": FIXED_TARGET_X, "phone": "18800000000"},
    )

    assert response.status_code == 409
    assert response.json() == {"code": 4010, "message": "滑块挑战手机号不一致", "data": None}


def test_captcha_token_is_single_use_in_send_code():
    """captchaToken 一次性：send-code 消费后重放同一 token → 409/4009。

    :return: None。
    """
    client, _ = make_native_client()
    body = {"phone": "18800000000", "type": "register", "captchaToken": solve_captcha(client, phone="18800000000")}

    first = client.post("/api/auth/send-code", json=body)
    assert first.status_code == 200

    second = client.post("/api/auth/send-code", json=body)
    assert second.status_code == 409
    assert second.json() == {"code": 4009, "message": "请先完成滑块验证，验证结果已失效或已使用", "data": None}


def test_captcha_token_expired_cannot_be_consumed():
    """token 过期：verify 通过后超过 TTL 才到 send-code → 消费失败 409/4009。

    :return: None。
    """
    database = ExtendedAuthDatabase()
    client = make_client(
        database=database,
        captcha_service=make_captcha_service(database, ttl_ms=1000),
        sms_provider=MockSmsProvider(),
    )
    token = solve_captcha(client, phone="18800000000")

    database.advance(2)
    response = client.post("/api/auth/send-code", json={"phone": "18800000000", "captchaToken": token})

    assert response.status_code == 409
    assert response.json()["code"] == 4009


def test_send_code_rejects_missing_or_garbage_captcha_token():
    """send-code：captchaToken 缺失/垃圾值 → 409/4009，且手机号校验（4001）先行。

    :return: None。
    """
    client, database = make_native_client()

    missing = client.post("/api/auth/send-code", json={"phone": "18800000000", "captchaToken": "not.a.token"})
    assert missing.status_code == 409
    assert missing.json()["code"] == 4009

    garbage = client.post("/api/auth/send-code", json={"phone": "abc", "captchaToken": "also.bad"})
    assert garbage.json()["code"] == 4001
    assert all(session.get("consumed_at") is None for session in database.captcha_sessions.values())


@pytest.mark.parametrize(
    ("code_type", "phone", "expected_code"),
    [
        ("register", "13912345678", 4002),
        ("login", "18800000000", 4004),
        ("reset", "18800000000", 4004),
        ("weird", "18800000000", 4004),
    ],
)
def test_send_code_registration_state_checks_match_node(code_type, phone, expected_code):
    """send-code：type 语义与注册态校验对齐 Node（register 查已注册，login/reset 查未注册）。

    :param code_type: 请求的 type。
    :param phone: 手机号。
    :param expected_code: 期望业务错误码。
    :return: None。
    """
    client, _ = make_native_client()
    token = solve_captcha(client)

    response = client.post("/api/auth/send-code", json={"phone": phone, "type": code_type, "captchaToken": token})

    assert response.status_code == 400
    assert response.json()["code"] == expected_code


def test_send_code_mock_provider_returns_dev_code_and_persists_record():
    """mock 发码：devCode/countdown/expiresIn 对齐 Node mock 分支，验证码以 mock 供应商落库。

    :return: None。
    """
    client, database = make_native_client()
    token = solve_captcha(client, phone="18800000000")

    response = client.post("/api/auth/send-code", json={"phone": "18800000000", "type": "register", "captchaToken": token})

    assert response.status_code == 200
    assert response.json()["message"] == "验证码已发送"
    data = response.json()["data"]
    assert data["provider"] == "mock"
    assert data["countdown"] == 60
    assert data["expiresIn"] == 300
    dev_code = data["devCode"]
    assert len(dev_code) == 6
    assert dev_code.isdigit()
    assert len(database.sms_codes) == 1
    record = database.sms_codes[0]
    assert record["phone"] == "18800000000"
    assert record["code_type"] == "register"
    assert record["code"] == dev_code


def test_send_code_sms_provider_failure_returns_5001_with_curated_message():
    """异常依赖（SMS）：供应商抛 SmsSendError → 500/5001 + 受控文案，且不落验证码记录。

    :return: None。
    """

    class FailingProvider:
        """恒定失败的短信供应商。

        :raises SmsSendError: 每次发送都抛出。
        """

        def send_code(self, phone, code_type, code):
            """恒抛出受控异常。

            :param phone: 手机号。
            :param code_type: 用途。
            :param code: 验证码。
            :raises SmsSendError: 恒抛出。
            """
            raise SmsSendError("腾讯云短信发送失败")

    database = ExtendedAuthDatabase()
    client = make_client(
        database=database,
        captcha_service=make_captcha_service(database),
        sms_provider=FailingProvider(),
    )
    token = solve_captcha(client)

    response = client.post("/api/auth/send-code", json={"phone": "18800000000", "type": "register", "captchaToken": token})

    assert response.status_code == 500
    assert response.json() == {"code": 5001, "message": "腾讯云短信发送失败", "data": None}
    assert database.sms_codes == []


def test_send_code_database_failure_returns_sanitized_500_envelope():
    """异常依赖（DB）：send-code 内数据库故障 → 500/5001 脱敏（不泄漏桩异常文本）。

    :return: None。
    """
    database = ExtendedAuthDatabase()
    database.fail_on.add("fetch_user_by_phone")
    client = make_client(database=database, captcha_service=make_captcha_service(database), sms_provider=MockSmsProvider())
    token = solve_captcha(client)

    response = client.post("/api/auth/send-code", json={"phone": "18800000000", "captchaToken": token})

    assert response.status_code == 500
    assert response.json() == {"code": 5001, "message": "服务暂时不可用，请稍后重试", "data": None}
    assert "database offline" not in response.text


def test_register_success_creates_user_session_and_matches_node_envelope():
    """注册成功：建号（SHA-256 哈希）+ 签会话，envelope 与 Node「注册成功」形状一致。

    :return: None。
    """
    client, database = make_native_client()
    code = ""
    token = solve_captcha(client, phone="18800000000")
    response_send = client.post("/api/auth/send-code", json={"phone": "18800000000", "type": "register", "captchaToken": token})
    assert response_send.status_code == 200
    code = database.sms_codes[-1]["code"]

    response = client.post(
        "/api/auth/register",
        json={"phone": "18800000000", "code": code, "nickname": " 新用户 ", "password": "123456"},
    )

    assert response.status_code == 200
    assert response.json()["message"] == "注册成功"
    data = response.json()["data"]
    assert data["token"] == "session-token-1"
    assert data["user"]["phone"] == "18800000000"
    assert data["user"]["nickname"] == "新用户"
    assert "password_hash" not in response.text
    assert database._passwords["18800000000"] == PASSWORD_HASH
    assert database.sms_codes[-1]["used_at"] is not None
    assert database.find_user_by_token(data["token"])["id"] == data["user"]["id"]


def test_register_validation_order_matches_node_matrix():
    """注册校验顺序：4001 → 4002（先于码/昵称/密码）→ 4003 → 4006 → 4007 → 4005。

    :return: None。
    """
    client, _ = make_native_client()
    steps = [
        ({"phone": "123", "code": "abc", "nickname": "x", "password": "1"}, 400, 4001),
        ({"phone": "13912345678", "code": "1234", "nickname": "新名", "password": "123456"}, 400, 4002),
        ({"phone": "18800000000", "code": "12", "nickname": "好名", "password": "123456"}, 400, 4003),
        ({"phone": "18800000000", "code": "1234", "nickname": " 好 ", "password": "123456"}, 400, 4006),
        ({"phone": "18800000000", "code": "1234", "nickname": " 好名 ", "password": "12345"}, 400, 4007),
        ({"phone": "18800000000", "code": "1234", "nickname": "好名", "password": "123456"}, 400, 4005),
    ]
    for payload, expected_status, expected_code in steps:
        response = client.post("/api/auth/register", json=payload)
        assert response.status_code == expected_status, payload
        assert response.json()["code"] == expected_code, payload
    assert client.post("/api/auth/register", json=steps[-1][0]).json()["message"] == "验证码不存在或已过期"


def test_sms_login_success_and_session_reuse_login_password_semantics():
    """短信登录：成功签会话（与 login-password 同形状）；验证码一次性消费。

    :return: None。
    """
    client, database = make_native_client()
    token = solve_captcha(client, phone="13912345678")
    client.post("/api/auth/send-code", json={"phone": "13912345678", "captchaToken": token})
    code = database.sms_codes[-1]["code"]

    first = client.post("/api/auth/login", json={"phone": "13912345678", "code": code})

    assert first.status_code == 200
    assert first.json() == {
        "code": 0,
        "message": "登录成功",
        "data": {
            "token": "session-token-1",
            "user": {"id": 7, "phone": "13912345678", "nickname": "测试用户", "createdAt": None},
        },
    }

    second = client.post("/api/auth/login", json={"phone": "13912345678", "code": code})
    assert second.status_code == 400
    assert second.json()["code"] == 4005
    assert second.json()["message"] == "验证码已失效，请重新获取"


@pytest.mark.parametrize(
    ("payload", "expected_code"),
    [
        ({"phone": "123", "code": "1234"}, 4001),
        ({"phone": "13912345678", "code": "abc"}, 4003),
        ({"phone": "18800000000", "code": "1234"}, 4004),
    ],
)
def test_sms_login_validation_order_matches_node(payload, expected_code):
    """短信登录校验顺序：4001 → 4003 → 4004（先于验证码消费）。

    :param payload: 请求 JSON 体（参数化用例）。
    :param expected_code: 期望业务错误码。
    :return: None。
    """
    client, _ = make_native_client()

    response = client.post("/api/auth/login", json=payload)

    assert response.status_code == 400
    assert response.json()["code"] == expected_code


def test_sms_login_wrong_code_returns_node_message():
    """短信登录：验证码不匹配 → 4005「验证码错误」（Node consumeCode 原文）。

    :return: None。
    """
    client, database = make_native_client()
    token = solve_captcha(client, phone="13912345678")
    client.post("/api/auth/send-code", json={"phone": "13912345678", "captchaToken": token})
    assert database.sms_codes

    response = client.post("/api/auth/login", json={"phone": "13912345678", "code": "000000"})

    assert response.status_code == 400
    assert response.json() == {"code": 4005, "message": "验证码错误", "data": None}


def test_reset_password_updates_hash_and_matches_node_envelope():
    """重置密码：成功更新哈希 + ``{"success": true}`` envelope（message「密码重置成功」）。

    :return: None。
    """
    client, database = make_native_client()
    token = solve_captcha(client, phone="13912345678")
    client.post("/api/auth/send-code", json={"phone": "13912345678", "type": "reset", "captchaToken": token})
    code = database.sms_codes[-1]["code"]

    response = client.post(
        "/api/auth/reset-password",
        json={"phone": "13912345678", "code": code, "newPassword": "654321"},
    )

    assert response.status_code == 200
    assert response.json() == {"code": 0, "message": "密码重置成功", "data": {"success": True}}
    assert database._passwords["13912345678"] == hashlib.sha256("654321".encode()).hexdigest()


def test_reset_password_validation_order_matches_node_matrix():
    """重置密码校验顺序：4001 → 4003 → 4007（先于存在性）→ 4004 → 4005。

    :return: None。
    """
    client, _ = make_native_client()
    steps = [
        ({"phone": "abc", "code": "1234", "newPassword": "123456"}, 4001),
        ({"phone": "13912345678", "code": "12", "newPassword": "123456"}, 4003),
        ({"phone": "18800000000", "code": "1234", "newPassword": "12345"}, 4007),
        ({"phone": "18800000000", "code": "1234", "newPassword": "123456"}, 4004),
        ({"phone": "13912345678", "code": "9999", "newPassword": "123456"}, 4005),
    ]
    for payload, expected_code in steps:
        response = client.post("/api/auth/reset-password", json=payload)
        assert response.status_code == 400, payload
        assert response.json()["code"] == expected_code, payload


def test_register_same_phone_twice_conflicts_then_second_send_code_rejected():
    """重复写入：重复注册第二次 4002；重复发码（register + 已注册）同样 4002。

    :return: None。
    """
    client, database = make_native_client()
    token = solve_captcha(client, phone="18800000000")
    send = client.post("/api/auth/send-code", json={"phone": "18800000000", "type": "register", "captchaToken": token})
    assert send.status_code == 200
    code = database.sms_codes[-1]["code"]

    first = client.post("/api/auth/register", json={"phone": "18800000000", "code": code, "nickname": "好名", "password": "123456"})
    assert first.status_code == 200

    second = client.post("/api/auth/register", json={"phone": "18800000000", "code": code, "nickname": "好名", "password": "123456"})
    assert second.status_code == 400
    assert second.json()["code"] == 4002

    second_send = client.post(
        "/api/auth/send-code",
        json={"phone": "18800000000", "type": "register", "captchaToken": solve_captcha(client)},
    )
    assert second_send.status_code == 400
    assert second_send.json()["code"] == 4002


def test_repeated_sms_logins_create_independent_sessions():
    """重复写入：两次独立发码登录产生两个会话 token，旧会话不吊销。

    :return: None。
    """
    client, database = make_native_client()
    tokens = []
    for _ in range(2):
        token = solve_captcha(client, phone="13912345678")
        client.post("/api/auth/send-code", json={"phone": "13912345678", "captchaToken": token})
        code = database.sms_codes[-1]["code"]
        response = client.post("/api/auth/login", json={"phone": "13912345678", "code": code})
        assert response.status_code == 200
        tokens.append(response.json()["data"]["token"])

    assert tokens[0] == "session-token-1"
    assert database.find_user_by_token(tokens[0])["id"] == 7
    assert tokens[1] == "session-token-2"


@pytest.mark.parametrize(
    ("method", "path", "kwargs", "expected"),
    [
        ("get", "/api/auth/captcha", {}, None),
        (
            "post",
            "/api/auth/captcha/verify",
            {"json": {"challenge": "bad.challenge", "position": 1}},
            {"code": 4010, "message": "滑块挑战签名无效", "data": None},
        ),
        (
            "post",
            "/api/auth/send-code",
            {"json": {"phone": "18800000000"}},
            {"code": 4009, "message": "请先完成滑块验证，验证结果已失效或已使用", "data": None},
        ),
        (
            "post",
            "/api/auth/register",
            {"json": {"phone": "13912345678", "code": "1234", "nickname": "n", "password": "123456"}},
            {"code": 4002, "message": "该手机号已注册", "data": None},
        ),
        (
            "post",
            "/api/auth/login",
            {"json": {"phone": "18800000000", "code": "1234"}},
            {"code": 4004, "message": "该手机号尚未注册", "data": None},
        ),
        (
            "post",
            "/api/auth/reset-password",
            {"json": {"phone": "18800000000", "code": "1234", "newPassword": "123456"}},
            {"code": 4004, "message": "该手机号尚未注册", "data": None},
        ),
    ],
)
def test_extended_auth_error_envelopes_keep_null_data_shape(method, path, kwargs, expected):
    """envelope 形状：错误响应统一 ``{"code", "message", "data": null}``，与 Node fail() 一致。

    :param method: HTTP 方法。
    :param path: 被测路由。
    :param kwargs: 请求关键字参数。
    :param expected: 期望 envelope（captcha 成功形状单独测，此处传 None 跳过）。
    :return: None。
    """
    if expected is None:
        return
    response = getattr(make_native_client()[0], method)(path, **kwargs)

    assert response.json() == expected


def test_captcha_signing_secret_fallback_order_matches_node():
    """签名密钥读取顺序对齐 Node：CAPTCHA_SECRET → SESSION_SECRET → 开发期固定缺省。

    :return: None。
    """
    explicit = Settings(_env_file=None, AUTH_CAPTCHA_SECRET="a", SESSION_SECRET="b")
    fallback = Settings(_env_file=None, SESSION_SECRET="b")
    dev_default = Settings(_env_file=None)

    assert explicit.captcha_signing_secret == "a"
    assert fallback.captcha_signing_secret == "b"
    assert dev_default.captcha_signing_secret == "projectdream-captcha-development-secret"


def test_sms_factory_defaults_to_mock_provider():
    """工厂：缺省（无 SMS_PROVIDER）→ mock 供应商。

    :return: None。
    """
    provider = create_sms_provider(Settings(_env_file=None))

    assert isinstance(provider, MockSmsProvider)


def test_sms_factory_degrades_to_mock_when_tencent_credentials_missing(caplog):
    """降级策略：SMS_PROVIDER=tencent 凭据缺失 → 启动期 warning + mock（不 crash）。

    :param caplog: pytest 日志捕获夹具。
    :return: None。
    """
    with caplog.at_level(logging.WARNING, logger="projectdream-api"):
        provider = create_sms_provider(
            Settings(_env_file=None, SMS_PROVIDER="tencent", TENCENTCLOUD_SECRET_ID="only-id")
        )

    assert isinstance(provider, MockSmsProvider)
    # 缺失凭据会被逐项点名；此处锁定 SECRET_KEY（该用例唯一显式留空的项）在告警中出现。
    assert "TENCENTCLOUD_SECRET_KEY" in caplog.text
    assert any(record.levelname == "WARNING" for record in caplog.records)


def test_sms_factory_builds_tencent_provider_when_fully_configured():
    """工厂：tencent 配置齐全且 SDK 可用 → TencentSmsProvider（客户端构造不联网）。

    :return: None。
    """
    provider = create_sms_provider(
        Settings(
            _env_file=None,
            SMS_PROVIDER="tencent",
            TENCENTCLOUD_SECRET_ID="id",
            TENCENTCLOUD_SECRET_KEY="key",
            TENCENTCLOUD_SMS_SDK_APP_ID="1400000000",
            TENCENTCLOUD_SMS_SIGN_NAME="签名",
            TENCENTCLOUD_SMS_TEMPLATE_ID="100001",
        )
    )

    assert isinstance(provider, TencentSmsProvider)


def test_sms_factory_degrades_when_sdk_unavailable(monkeypatch, caplog):
    """降级策略：SDK 导入失败（未安装）→ warning + mock，构造期不抛异常。

    :param monkeypatch: pytest monkeypatch 夹具。
    :param caplog: pytest 日志捕获夹具。
    :return: None。
    """

    def raise_import_error(self):
        """模拟 SDK 缺失。

        :raises ImportError: 恒抛出。
        """
        raise ImportError("No module named 'tencentcloud'")

    monkeypatch.setattr(TencentSmsProvider, "_import_sdk", raise_import_error)
    with caplog.at_level(logging.WARNING, logger="projectdream-api"):
        provider = create_sms_provider(
            Settings(
                _env_file=None,
                SMS_PROVIDER="tencent",
                TENCENTCLOUD_SECRET_ID="id",
                TENCENTCLOUD_SECRET_KEY="key",
                TENCENTCLOUD_SMS_SDK_APP_ID="app",
                TENCENTCLOUD_SMS_SIGN_NAME="sign",
                TENCENTCLOUD_SMS_TEMPLATE_ID="tpl",
            )
        )

    assert isinstance(provider, MockSmsProvider)
    assert "降级" in caplog.text


def test_sms_factory_degrades_unknown_provider_value(caplog):
    """降级策略：未知 SMS_PROVIDER（如 aliyun，本阶段未移植）→ warning + mock。

    :param caplog: pytest 日志捕获夹具。
    :return: None。
    """
    with caplog.at_level(logging.WARNING, logger="projectdream-api"):
        provider = create_sms_provider(Settings(_env_file=None, SMS_PROVIDER="aliyun"))

    assert isinstance(provider, MockSmsProvider)
    assert "aliyun" in caplog.text


def test_tencent_provider_send_maps_node_request_fields_and_result():
    """tencent 适配器：入参（+86 前缀/SessionContext/模板参数）与返回值对齐 Node 分支。

    :return: None。
    """
    captured = {}

    class FakeTencentClient:
        """记录请求并返回可编程响应的假 SmsClient。"""

        def __init__(self):
            """预置一次成功响应（SendStatusSet[0] 全 Ok）。"""
            self.response = SimpleNamespace(
                SendStatusSet=[SimpleNamespace(Code="Ok", Message="send success", SerialNo="sn-1")]
            )

        def SendSms(self, request):
            """记录请求并返回预设响应。

            :param request: SendSmsRequest。
            :return: 预设响应对象。
            """
            captured["request"] = request
            return self.response

    provider = TencentSmsProvider(
        secret_id="id",
        secret_key="key",
        sdk_app_id="1400000000",
        sign_name="签名",
        template_id="100001",
    )
    provider._client = FakeTencentClient()

    result = provider.send_code("13912345678", "register", "123456")
    request = captured["request"]

    assert request.PhoneNumberSet == ["+8613912345678"]
    assert request.SmsSdkAppId == "1400000000"
    assert request.SignName == "签名"
    assert request.TemplateId == "100001"
    assert request.TemplateParamSet == ["123456"]
    assert request.SessionContext == "register"
    assert result == {"provider": "tencent", "countdown": 60, "expiresIn": 300, "devCode": None}


def test_tencent_provider_raises_sms_send_error_on_failed_status():
    """tencent 适配器：状态码非 Ok → SmsSendError（消息取 Message，兜底固定文案）。

    :return: None。
    """
    provider = TencentSmsProvider(
        secret_id="id",
        secret_key="key",
        sdk_app_id="app",
        sign_name="sign",
        template_id="tpl",
    )
    provider._client = SimpleNamespace(
        SendSms=lambda request: SimpleNamespace(
            SendStatusSet=[SimpleNamespace(Code="LimitExceeded.SendSmsFrequency", Message="发送频率超限", SerialNo="")]
        )
    )

    with pytest.raises(SmsSendError) as exc_info:
        provider.send_code("13912345678", "login", "123456")

    assert str(exc_info.value) == "发送频率超限"


def test_mock_provider_logs_code_like_node_and_returns_dev_code(caplog):
    """mock 适配器：日志格式对齐 Node '[mock-sms] type=... phone=... code=...'，devCode=code。

    :param caplog: pytest 日志捕获夹具。
    :return: None。
    """
    with caplog.at_level(logging.INFO, logger="projectdream-api"):
        result = MockSmsProvider().send_code("13912345678", "login", "654321")

    assert result == {"provider": "mock", "countdown": 60, "expiresIn": 300, "devCode": "654321"}
    assert "[mock-sms] type=login phone=13912345678 code=654321" in caplog.text
