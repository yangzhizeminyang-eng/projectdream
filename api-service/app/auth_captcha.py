"""滑块验证码（captcha）FastAPI 原生实现。

权威对照来源：``server/services/auth-captcha.mjs``（Node 实现，只读复刻）与
``server/index.mjs`` L12268-L12292 的路由行为。与 Node 的差异：会话状态不使用
进程内存 Map，而是全部落 MySQL ``auth_captcha_sessions`` 表（迁移 0004），
由 ``database`` 注入的数据访问层承担读写，以支撑多进程部署与一次性消费防重放。

关键复刻语义：
- 挑战签名为 ``base64url(JSON payload) + "." + HMAC-SHA256(base64url)``，密钥与 Node 共享配置；
- verify 通过后签发 ``<challenge_id>.<HMAC(challenge_id + ':verified')>`` 的一次性 token；
- 位置容差 8px、最大尝试 5 次、TTL 5 分钟，均与 Node 常量一致；
- 过期挑战在 Node 中先被 ``pruneExpired`` 删除，因此可观测错误消息是
  「滑块挑战已使用或不存在」（Node 源码中「已过期」分支实际不可达），本实现保持一致。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any, Callable
from urllib.parse import quote

# 与 Node auth-captcha.mjs 顶部常量逐项对齐。
DEFAULT_TTL_MS = 5 * 60 * 1000
MAX_ATTEMPTS = 5
TRACK_WIDTH = 320
IMAGE_HEIGHT = 120
PIECE_SIZE = 56
PIECE_TOP = 32
# Node verify：Math.abs(Number(position) - record.targetX) > 8 判失败。
POSITION_TOLERANCE_PX = 8
# Node verify：rawChallenge.length > 4096 直接判签名无效。
CHALLENGE_MAX_LENGTH = 4096
# Node consumeVerificationToken：rawToken.length > 256 直接拒绝。
TOKEN_MAX_LENGTH = 256

PALETTES = [
    ["#244c4b", "#c97c5d", "#d7b676", "#a7b89a"],
    ["#36566a", "#d47c58", "#e0c06f", "#93b7a4"],
    ["#594d3e", "#71968a", "#cf8462", "#d8bb82"],
]


def _text(value: Any) -> str:
    """对齐 Node ``text()``：String(value ?? '').trim()。

    :param value: 任意输入值。
    :returns: 字符串化并去除首尾空白后的结果（None 视为空串）。
    """
    return str(value if value is not None else "").strip()


def sign_payload(value: str, secret: str) -> str:
    """对齐 Node ``sign()``：HMAC-SHA256 后输出无填充 base64url。

    :param value: 待签名原文。
    :param secret: 共享签名密钥。
    :returns: base64url（去 ``=`` 填充）签名字符串。
    """
    digest = hmac.digest(secret.encode("utf-8"), value.encode("utf-8"), hashlib.sha256)
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _matches_signature(value: str, signature: str, secret: str) -> bool:
    """常数时间比较签名（对齐 Node matchesSignature 的 timingSafeEqual 语义）。

    :param value: 被签名的原文。
    :param signature: 请求方提供的签名。
    :param secret: 共享签名密钥。
    :returns: 签名匹配返回 True；长度不符或内容不一致返回 False。
    """
    expected = sign_payload(value, secret).encode("ascii")
    actual = str(signature if signature is not None else "").encode("utf-8")
    return hmac.compare_digest(expected, actual)


def _encode_payload(payload: dict[str, Any]) -> str:
    """对齐 Node ``encode()``：紧凑 JSON → base64url（去填充）。

    :param payload: 挑战负载 ``{"id", "issuedAt", "expiresAt"}``（毫秒时间戳）。
    :returns: base64url 编码字符串。
    """
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_payload(value: str) -> Any:
    """对齐 Node ``decode()``：base64url → JSON 反序列化。

    :param value: base64url 编码字符串（容忍缺失填充）。
    :returns: JSON 反序列化结果（dict 或其他 JSON 类型）。
    :raises Exception: base64 非法或 JSON 解析失败时抛出（由调用方映射为「格式无效」）。
    """
    padded = value + "=" * (-len(value) % 4)
    raw = base64.urlsafe_b64decode(padded.encode("ascii"))
    return json.loads(raw.decode("utf-8"))


def _data_uri(svg: str) -> str:
    """对齐 Node ``dataUri()``：``data:image/svg+xml,`` + encodeURIComponent(svg)。

    JS encodeURIComponent 不转义 ``A-Za-z0-9 - _ . ! ~ * ' ( )``，
    ``urllib.parse.quote`` 需通过 ``safe`` 参数补齐 ``!'()*`` 才能逐字符一致。

    :param svg: SVG 字符串。
    :returns: data URI 形式的图片地址。
    """
    encoded = quote(svg, safe="!'()*-._~")
    return f"data:image/svg+xml,{encoded}"


def _build_puzzle_path(x: int, y: int) -> str:
    """对齐 Node ``buildPuzzlePath()``：拼图缺口的 SVG path（带凸起/凹槽的方块轮廓）。

    :param x: 缺口左上角 x 坐标。
    :param y: 缺口左上角 y 坐标。
    :returns: SVG path d 属性字符串。
    """
    return (
        f"M {x + 8} {y + 8} H {x + 20} C {x + 16} {y} {x + 40} {y} {x + 36} {y + 8} "
        f"H {x + 48} V {y + 20} C {x + 56} {y + 16} {x + 56} {y + 40} {x + 48} {y + 36} "
        f"V {y + 48} H {x + 36} C {x + 40} {y + 56} {x + 16} {y + 56} {x + 20} {y + 48} "
        f"H {x + 8} V {y + 36} C {x} {y + 40} {x} {y + 16} {x + 8} {y + 20} Z"
    )


def _build_challenge_images(target_x: int, palette_index: int) -> dict[str, str]:
    """对齐 Node ``buildChallengeImages()``：生成背景图（含缺口）与滑块拼图两段 SVG。

    :param target_x: 缺口正确位置 x 坐标。
    :param palette_index: 调色板下标（0-2）。
    :returns: ``{"backgroundImage", "pieceImage"}``，值均为 data URI 形式的 SVG。
    """
    base, accent, highlight, secondary = PALETTES[palette_index % len(PALETTES)]
    gap_path = _build_puzzle_path(target_x, PIECE_TOP)
    piece_path = _build_puzzle_path(0, 0)
    background = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{TRACK_WIDTH}" height="{IMAGE_HEIGHT}" '
        f'viewBox="0 0 {TRACK_WIDTH} {IMAGE_HEIGHT}"><defs>'
        f'<linearGradient id="wash" x2="1" y2="1"><stop stop-color="{base}"/>'
        f'<stop offset="1" stop-color="{secondary}"/></linearGradient>'
        f'<pattern id="grain" width="18" height="18" patternUnits="userSpaceOnUse">'
        f'<path d="M0 17.5H18M17.5 0V18" stroke="#fff" stroke-opacity=".09"/></pattern></defs>'
        f'<rect width="320" height="120" fill="url(#wash)"/>'
        f'<path d="M0 82L70 42l42 21 60-38 49 28 56-35 43 23v79H0Z" fill="{accent}" fill-opacity=".74"/>'
        f'<path d="M0 101l59-26 45 16 58-35 50 27 45-24 63 25v36H0Z" fill="{highlight}" fill-opacity=".68"/>'
        f'<rect width="320" height="120" fill="url(#grain)"/>'
        f'<path d="M18 20h45v5H18zm0 12h30v4H18zm234 3h48v5h-48zm-15 12h63v4h-63z" fill="#fff" fill-opacity=".38"/>'
        f'<path d="{gap_path}" fill="#102629" fill-opacity=".62" stroke="#eff6dc" stroke-width="2" stroke-dasharray="4 3"/></svg>'
    )
    piece = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{PIECE_SIZE}" height="{PIECE_SIZE}" '
        f'viewBox="0 0 {PIECE_SIZE} {PIECE_SIZE}"><defs>'
        f'<linearGradient id="tile" x2="1" y2="1"><stop stop-color="{base}"/>'
        f'<stop offset=".58" stop-color="{accent}"/><stop offset="1" stop-color="{highlight}"/></linearGradient>'
        f'<pattern id="grain" width="12" height="12" patternUnits="userSpaceOnUse">'
        f'<path d="M0 11.5H12M11.5 0V12" stroke="#fff" stroke-opacity=".25"/></pattern>'
        f'<clipPath id="shape"><path d="{piece_path}"/></clipPath></defs>'
        f'<g clip-path="url(#shape)"><rect width="56" height="56" fill="url(#tile)"/>'
        f'<rect width="56" height="56" fill="url(#grain)"/>'
        f'<path d="M4 39 22 17l16 13 16-20v50H4Z" fill="{secondary}" fill-opacity=".8"/></g>'
        f'<path d="{piece_path}" fill="none" stroke="#f5f0d8" stroke-width="2"/></svg>'
    )
    return {"backgroundImage": _data_uri(background), "pieceImage": _data_uri(piece)}


def _default_now_ms() -> int:
    """默认毫秒时钟（对齐 Node Date.now()）。

    :returns: 当前 Unix 时间（毫秒）。
    """
    return int(time.time() * 1000)


def _default_random_target_x() -> int:
    """默认缺口位置随机源，对齐 Node ``randomInt(88, TRACK_WIDTH - PIECE_SIZE - 8)``。

    Node ``randomInt`` 上界开区间，等价于 [88, 255] 的均匀分布。

    :returns: 88-255 之间的随机整数。
    """
    return 88 + secrets.randbelow(TRACK_WIDTH - PIECE_SIZE - 8 - 88)


def _default_random_palette() -> int:
    """默认调色板随机源，对齐 Node ``randomInt(0, PALETTES.length)``。

    :returns: [0, len(PALETTES)) 的随机整数。
    """
    return secrets.randbelow(len(PALETTES))


class AuthCaptchaService:
    """滑块验证码服务：挑战签发、位置校验、一次性验证 token 消费。

    所有会话状态经 ``database`` 数据访问层落 MySQL（auth_captcha_sessions 表），
    本类只承载纯逻辑（签名 / SVG / 校验顺序），不持有任何进程内会话。
    """

    def __init__(
        self,
        database: Any,
        secret: str,
        ttl_ms: int = DEFAULT_TTL_MS,
        max_attempts: int = MAX_ATTEMPTS,
        random_target_x: Callable[[], int] | None = None,
        random_palette: Callable[[], int] | None = None,
        now_ms: Callable[[], int] | None = None,
    ) -> None:
        """初始化滑块验证码服务。

        :param database: 数据访问层（需提供 auth_captcha_sessions 相关方法）。
        :param secret: HMAC 签名密钥；空串视为未配置。
        :param ttl_ms: 挑战与验证 token 的有效期（毫秒），对齐 Node DEFAULT_TTL_MS。
        :param max_attempts: 单个挑战允许的最大校验次数，对齐 Node MAX_ATTEMPTS。
        :param random_target_x: 缺口位置随机源（可注入以便测试）。
        :param random_palette: 调色板随机源（可注入以便测试）。
        :param now_ms: 毫秒时钟（可注入以便测试）。
        :raises ValueError: 签名密钥为空时抛出（对齐 Node 'captcha signing secret is required'）。
        """
        if not _text(secret):
            raise ValueError("captcha signing secret is required")
        self._db = database
        self._secret = _text(secret)
        self._ttl_ms = int(ttl_ms)
        self._ttl_seconds = max(1, self._ttl_ms // 1000)
        self._max_attempts = int(max_attempts)
        self._random_target_x = random_target_x or _default_random_target_x
        self._random_palette = random_palette or _default_random_palette
        self._now_ms = now_ms or _default_now_ms

    def create_challenge(self, ip: str = "", phone: str = "") -> dict[str, Any]:
        """签发一个滑块挑战（对齐 Node captchaStore.createChallenge）。

        顺序：清理过期行 → 生成 id / 缺口位置 / 调色板 → 签名 → 写 DB → 返回
        与 Node 完全同形状的数据（不含 targetX，防泄露答案）。

        :param ip: 来源 IP（可为空；非空时 verify 阶段做一致性校验）。
        :param phone: 标准化手机号（可为空；非空时 verify 阶段做一致性校验）。
        :returns: ``{"challengeId", "challenge", "backgroundImage", "pieceImage",
            "trackWidth", "imageHeight", "pieceSize", "pieceTop", "expiresAt"}``。
        :raises Exception: DB 写入失败原样抛出（由网关兜底 500/5001）。
        """
        self._db.prune_auth_captcha_sessions()
        challenge_id = secrets.token_hex(12)
        target_x = max(1, min(TRACK_WIDTH - PIECE_SIZE - 1, int(self._random_target_x() or 0)))
        palette_index = max(0, min(len(PALETTES) - 1, int(self._random_palette() or 0)))
        now = self._now_ms()
        payload = {"id": challenge_id, "issuedAt": now, "expiresAt": now + self._ttl_ms}
        encoded = _encode_payload(payload)
        images = _build_challenge_images(target_x, palette_index)
        self._db.create_auth_captcha_session(
            challenge_id=challenge_id,
            phone=_text(phone),
            ip=_text(ip),
            target_x=target_x,
            ttl_seconds=self._ttl_seconds,
        )
        return {
            "challengeId": challenge_id,
            "challenge": f"{encoded}.{sign_payload(encoded, self._secret)}",
            **images,
            "trackWidth": TRACK_WIDTH,
            "imageHeight": IMAGE_HEIGHT,
            "pieceSize": PIECE_SIZE,
            "pieceTop": PIECE_TOP,
            "expiresAt": payload["expiresAt"],
        }

    def verify(self, challenge: Any = "", position: Any = 0, ip: str = "", phone: str = "") -> dict[str, Any]:
        """校验滑块挑战（对齐 Node captchaStore.verify 的校验顺序与消息）。

        校验顺序：长度 → 签名 → 格式 → 存在性（含过期折叠，见模块 docstring）→
        IP/手机号一致性 → 尝试次数 → 位置容差 → 原子置 verified 并签发 token。
        与 Node 的刻意差异：非数字 ``position`` 按「位置偏差」失败（fail-closed）；
        Node 因 ``NaN > 8`` 恒为 False 会放行，属不应复刻的安全漏洞。

        :param challenge: 签名挑战串 ``<encoded>.<hmac>``。
        :param position: 用户滑动的 x 坐标（数字或数字字符串）。
        :param ip: 来源 IP（挑战绑定了 IP 且本次非空时须一致）。
        :param phone: 标准化手机号（挑战绑定了手机号且本次非空时须一致）。
        :returns: ``{"ok": bool, "message": str|None, "verificationToken": str|None}``。
        """
        raw_challenge = _text(challenge)
        if len(raw_challenge) > CHALLENGE_MAX_LENGTH:
            return {"ok": False, "message": "滑块挑战签名无效", "verificationToken": None}
        parts = raw_challenge.split(".")
        encoded = parts[0] if len(parts) == 2 else ""
        signature = parts[1] if len(parts) == 2 else ""
        if not encoded or not signature or not _matches_signature(encoded, signature, self._secret):
            return {"ok": False, "message": "滑块挑战签名无效", "verificationToken": None}
        try:
            payload = _decode_payload(encoded)
        except Exception:
            return {"ok": False, "message": "滑块挑战格式无效", "verificationToken": None}
        challenge_id = payload.get("id") if isinstance(payload, dict) else None
        record = None
        if isinstance(challenge_id, str) and challenge_id:
            record = self._db.fetch_auth_captcha_session(challenge_id)
        # Node：挑战不存在、已被 verify 消费（challenges 已删）、或已过期（pruneExpired 已删）
        # 三种情况可观测消息均为「滑块挑战已使用或不存在」。
        if record is None or record.get("verified") or record.get("is_expired"):
            return {"ok": False, "message": "滑块挑战已使用或不存在", "verificationToken": None}
        if record.get("ip") and _text(ip) and record["ip"] != _text(ip):
            return {"ok": False, "message": "滑块挑战来源不一致", "verificationToken": None}
        if record.get("phone") and _text(phone) and record["phone"] != _text(phone):
            return {"ok": False, "message": "滑块挑战手机号不一致", "verificationToken": None}
        attempts = self._db.increment_auth_captcha_attempts(challenge_id)
        if attempts is None:
            return {"ok": False, "message": "滑块挑战已使用或不存在", "verificationToken": None}
        if attempts > self._max_attempts:
            self._db.delete_auth_captcha_session(challenge_id)
            return {"ok": False, "message": "滑块挑战尝试次数过多", "verificationToken": None}
        try:
            position_value = float(position)
        except (TypeError, ValueError):
            # fail-closed：Node 对非数字 position 得 NaN 而放行（NaN > 8 恒 False），不复刻。
            return {"ok": False, "message": "请将滑块拖到高亮位置", "verificationToken": None}
        if abs(position_value - float(record["target_x"])) > POSITION_TOLERANCE_PX:
            return {"ok": False, "message": "请将滑块拖到高亮位置", "verificationToken": None}
        verification_token = f"{challenge_id}.{sign_payload(f'{challenge_id}:verified', self._secret)}"
        if not self._db.mark_auth_captcha_verified(challenge_id, verification_token, self._ttl_seconds):
            return {"ok": False, "message": "滑块挑战已使用或不存在", "verificationToken": None}
        return {"ok": True, "message": None, "verificationToken": verification_token}

    def consume_verification_token(self, token: Any = "") -> bool:
        """一次性消费验证 token（对齐 Node consumeVerificationToken，send-code 专用）。

        通过 MySQL 原子 UPDATE（``consumed_at IS NULL`` 条件 + 受影响行数）防重放；
        过期判定使用 verify 通过时改写的 ``expires_at``（对齐 Node consumed Map 的 TTL）。

        :param token: verify 通过时签发的 ``<challenge_id>.<hmac>`` 字符串。
        :returns: 消费成功返回 True；签名无效、已消费、不存在或已过期返回 False。
        """
        raw_token = _text(token)
        if len(raw_token) > TOKEN_MAX_LENGTH:
            return False
        parts = raw_token.split(".")
        if len(parts) != 2:
            return False
        challenge_id, signature = parts
        if not challenge_id or not _matches_signature(f"{challenge_id}:verified", signature, self._secret):
            return False
        return bool(self._db.consume_auth_captcha_token(challenge_id, raw_token))
