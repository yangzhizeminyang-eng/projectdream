"""鉴权组已接管 2 条路由（login-password / check-phone）的兼容测试（阶段 7.1）。

对照规格：``api-service/docs/auth-group-spec.md`` §6 核对矩阵。只补 ``test_contracts.py``
未覆盖的缺口，七类场景（未登录 N/A、字段缺失/非法、数据不存在、空数据/边界、异常依赖、
重复写入、状态码与 envelope 形状）全部离线执行（fake database）。
第四阶段已删除过渡开关：两条路由恒为原生实现，回退代理专项测试随实现一并移除。
"""

import hashlib

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

# 与 Node hashPassword（SHA-256 hex）一致的测试口令 "123456" 的哈希值。
PASSWORD_HASH = hashlib.sha256("123456".encode()).hexdigest()


class AuthDatabase:
    """鉴权组兼容测试的最小数据库桩。

    :ivar users: 以标准化手机号为键的用户表（形状对齐 Node users 行）。
    :ivar sessions: token -> user_id 的会话表。
    :ivar fetch_calls: ``fetch_user_by_phone`` 被调用次数（幂等断言用）。
    :ivar session_calls: ``create_session`` 被调用次数（重复登录断言用）。
    :ivar fail_on_fetch: 置 True 时查询抛异常，模拟数据库故障。
    """

    def __init__(self):
        self.users = {
            "13912345678": {
                "id": 7,
                "phone": "13912345678",
                "nickname": "测试用户",
                "password_hash": PASSWORD_HASH,
            }
        }
        self.sessions = {}
        self.fetch_calls = 0
        self.session_calls = 0
        self.fail_on_fetch = False

    def fetch_user_by_phone(self, phone):
        """按标准化手机号查询用户。

        :param phone: 11 位标准化手机号。
        :return: 命中时返回用户 dict，未注册返回 None；故障注入时抛 RuntimeError。
        :raises RuntimeError: fail_on_fetch 为 True 时模拟数据库离线。
        """
        self.fetch_calls += 1
        if self.fail_on_fetch:
            raise RuntimeError("database offline")
        return self.users.get(phone)

    def create_session(self, user):
        """为用户创建登录会话（每次调用产生新 token，不吊销旧会话）。

        :param user: 命中的用户 dict。
        :return: 新创建的会话 token。
        """
        self.session_calls += 1
        token = f"session-token-{self.session_calls}"
        self.sessions[token] = user["id"]
        return token

    def find_user_by_token(self, token):
        """按 token 反查用户（供网关其他受保护路由的鉴权降级使用，本文件用不到）。

        :param token: 访问令牌。
        :return: 命中时返回用户 dict，否则 None。
        """
        user_id = self.sessions.get(token)
        return next((user for user in self.users.values() if user["id"] == user_id), None)


def make_client(database=None):
    """构建鉴权组测试客户端（恒为原生模式，直连数据库桩）。

    :param database: 注入的数据库桩；缺省使用 AuthDatabase()。
    :return: 配置完成的 TestClient。
    """
    # raise_server_exceptions=False：让未处理异常走网关的 500 envelope handler 而非直接抛给测试。
    return TestClient(create_app(Settings(_env_file=None), database=database or AuthDatabase()), raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# 场景一：未登录 —— 两条路由均为公开路由，N/A（无对应测试，规格文档已标注）。
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# 场景二：字段缺失 / 非法
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "payload",
    [
        {},  # phone 与 password 全缺
        {"password": "123456"},  # 缺 phone
        {"phone": "92012345678", "password": "123456"},  # 非 1 开头
        {"phone": "1391234567", "password": "123456"},  # 少于 11 位
        {"phone": "139123456789", "password": "123456"},  # 12 位：Node slice(0,11) 截断后仍合法
    ],
)
def test_login_password_rejects_missing_or_invalid_phone(payload):
    """login-password：phone 缺失/非法返回 400/4001；12 位输入按 Node 语义截断为合法号。

    :param payload: 请求 JSON 体（参数化用例）。
    :return: None（断言失败时抛出 AssertionError）。
    """
    response = make_client().post("/api/auth/login-password", json=payload)

    if payload.get("phone") == "139123456789":
        # 截断为 13912345678：phone 合法，继续走密码校验，密码正确则成功。
        assert response.status_code == 200
        assert response.json()["code"] == 0
        return
    assert response.status_code == 400
    assert response.json() == {"code": 4001, "message": "手机号格式不正确", "data": None}


def test_login_password_rejects_short_password():
    """login-password：password 缺失或不足 6 位返回 400/4007，且先于密码比对触发。

    :return: None。
    """
    client = make_client()

    missing = client.post("/api/auth/login-password", json={"phone": "13912345678"})
    short = client.post("/api/auth/login-password", json={"phone": "13912345678", "password": "12345"})

    for response in (missing, short):
        assert response.status_code == 400
        assert response.json() == {"code": 4007, "message": "密码至少需要 6 位", "data": None}


def test_check_phone_rejects_missing_phone():
    """check-phone：query 缺 phone 参数时返回 400/4001。

    :return: None。
    """
    response = make_client().get("/api/auth/check-phone")

    assert response.status_code == 400
    assert response.json() == {"code": 4001, "message": "手机号格式不正确", "data": None}


# ---------------------------------------------------------------------------
# 场景三：数据不存在（未注册）
# ---------------------------------------------------------------------------


def test_login_password_unregistered_phone_contract():
    """login-password 未注册号：原生把未注册合并为 4008（防账号枚举）。

    规格 §4.1 已记录与 Node 4004 的语义差异（原生有意收紧）；flag 回退已删除，
    本测试锁定原生行为防止静默漂移。

    :return: None。
    """
    body = {"phone": "18800000000", "password": "123456"}

    response = make_client().post("/api/auth/login-password", json=body)

    assert response.status_code == 400
    assert response.json() == {"code": 4008, "message": "账号或密码不正确", "data": None}


def test_check_phone_returns_success_for_unregistered_phone():
    """check-phone：未注册手机号是 200 成功（exists=false），不是错误。

    :return: None。
    """
    response = make_client().get("/api/auth/check-phone?phone=18800000000")

    assert response.status_code == 200
    assert response.json() == {"code": 0, "message": "success", "data": {"exists": False}}


# ---------------------------------------------------------------------------
# 场景四：空数据 / 边界（手机号标准化，Node normalizePhone 语义）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expect_ok"),
    [
        ("139 1234 5678", True),  # 空格剔除后合法
        ("abc13912345678def", True),  # 字母剔除后命中合法号（normalizePhone 语义：仅留 ASCII 数字）
        ("", False),  # 空 phone
        ("+8613912345678", False),  # 剔除 + 后 86 开头，截断 11 位不以 1 开头
        ("1３９１２３４５６７８", False),  # 全角数字被剔除，仅剩 "1" → 非法（7.1 修复点）
        ("２３９１２３４５６７８", False),  # 全部为全角数字 → 剔除后为空
    ],
)
def test_login_password_phone_normalization_matches_node_semantics(raw, expect_ok):
    """login-password：标准化语义与 Node normalizePhone 一致（ASCII-only + 截取前 11 位）。

    :param raw: 原始 phone 输入（参数化用例）。
    :param expect_ok: True 表示剔除后应命中合法号并登录成功；False 表示期望 400/4001。
    :return: None。
    """
    response = make_client().post("/api/auth/login-password", json={"phone": raw, "password": "123456"})

    if expect_ok:
        assert response.status_code == 200
        assert response.json()["code"] == 0
        return
    assert response.status_code == 400
    assert response.json() == {"code": 4001, "message": "手机号格式不正确", "data": None}


@pytest.mark.parametrize(
    ("raw", "expected_exists"),
    [
        ("139 1234 5678", True),  # 空格剔除后命中已注册号
        ("139123456789", True),  # 12 位：Node slice(0,11) 截断后命中
        ("+8613912345678", None),  # 剔除 + 后为 86139123456…，截断 11 位不以 1 开头 → 4001
        ("18800000000 ", False),  # 尾部空格剔除后为未注册号
    ],
)
def test_check_phone_normalization_matches_node_semantics(raw, expected_exists):
    """check-phone：标准化语义与 Node normalizePhone 一致（ASCII-only + 截取前 11 位）。

    :param raw: 原始 phone 输入（参数化用例）。
    :param expected_exists: 期望的 exists 值；None 表示期望 400/4001。
    :return: None。
    """
    response = make_client().get("/api/auth/check-phone", params={"phone": raw})

    if expected_exists is None:
        assert response.status_code == 400
        assert response.json() == {"code": 4001, "message": "手机号格式不正确", "data": None}
        return
    assert response.status_code == 200
    assert response.json() == {"code": 0, "message": "success", "data": {"exists": expected_exists}}


# ---------------------------------------------------------------------------
# 场景五：异常依赖
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("path", ["/api/auth/login-password", "/api/auth/check-phone"])
def test_auth_routes_return_sanitized_500_envelope_when_database_fails(path):
    """异常依赖：数据库抛异常时两条路由统一 500/5001，响应不泄漏内部错误信息。

    :param path: 被测路由（参数化：login-password / check-phone）。
    :return: None。
    """
    database = AuthDatabase()
    database.fail_on_fetch = True
    client = make_client(database=database)
    if path == "/api/auth/login-password":
        response = client.post(path, json={"phone": "13912345678", "password": "123456"})
    else:
        response = client.get(path, params={"phone": "13912345678"})

    assert response.status_code == 500
    body = response.json()
    assert body == {"code": 5001, "message": "服务暂时不可用，请稍后重试", "data": None}
    # 不得泄漏 fake database 的异常文本。
    assert "database offline" not in response.text


# ---------------------------------------------------------------------------
# 场景六：重复写入
# ---------------------------------------------------------------------------


def test_login_password_repeated_logins_create_independent_sessions():
    """重复写入：重复登录每次创建新会话 token，旧 token 不被吊销（语义记录）。

    :return: None。
    """
    database = AuthDatabase()
    client = make_client(database=database)
    body = {"phone": "13912345678", "password": "123456"}

    first = client.post("/api/auth/login-password", json=body)
    second = client.post("/api/auth/login-password", json=body)

    assert first.status_code == second.status_code == 200
    assert first.json()["data"]["token"] == "session-token-1"
    assert second.json()["data"]["token"] == "session-token-2"
    assert database.session_calls == 2
    # 两个会话均有效：旧 token 不被新登录吊销。
    assert database.find_user_by_token("session-token-1")["id"] == 7
    assert database.find_user_by_token("session-token-2")["id"] == 7


def test_check_phone_is_idempotent_read_only():
    """重复写入：check-phone 为幂等只读——重复调用结果一致且仅产生查询、无任何写入。

    :return: None。
    """
    database = AuthDatabase()
    client = make_client(database=database)

    first = client.get("/api/auth/check-phone?phone=13912345678")
    second = client.get("/api/auth/check-phone?phone=13912345678")

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert database.fetch_calls == 2
    # 只读：users/sessions 均未被改动。
    assert database.sessions == {}


# ---------------------------------------------------------------------------
# 场景七：状态码与 envelope 形状
# ---------------------------------------------------------------------------


def test_login_password_success_envelope_keeps_safe_user_shape():
    """envelope 形状：登录成功为 200/code=0/message="登录成功"，user 仅含安全字段、无 password_hash。

    :return: None。
    """
    response = make_client().post("/api/auth/login-password", json={"phone": "13912345678", "password": "123456"})

    assert response.status_code == 200
    assert response.json() == {
        "code": 0,
        "message": "登录成功",
        "data": {
            "token": "session-token-1",
            "user": {"id": 7, "phone": "13912345678", "nickname": "测试用户", "createdAt": None},
        },
    }


def test_check_phone_success_envelope_does_not_leak_user_record():
    """envelope 形状：check-phone 成功 data 仅含 exists 布尔，不携带任何用户记录。

    :return: None。
    """
    response = make_client().get("/api/auth/check-phone?phone=13912345678")

    assert response.status_code == 200
    assert response.json() == {"code": 0, "message": "success", "data": {"exists": True}}
    assert "password_hash" not in response.text
    assert "nickname" not in response.text


def test_login_password_wrong_password_keeps_error_envelope_shape():
    """envelope 形状：密码错误为 400/4008，错误 envelope 的 data 恒为 null。

    :return: None。
    """
    response = make_client().post("/api/auth/login-password", json={"phone": "13912345678", "password": "654321"})

    assert response.status_code == 400
    assert response.json() == {"code": 4008, "message": "账号或密码不正确", "data": None}
