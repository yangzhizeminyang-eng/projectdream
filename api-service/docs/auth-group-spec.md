# ProjectDream 鉴权组（/api/auth/*）迁移规格


> **第四阶段状态（2026-10-19）**：本文所述 `API_NATIVE_*` 回退开关、`proxy_api` 代理与
> `node_upstream_url`/`node_readiness_timeout_seconds`/`proxy_timeout_seconds` 配置
> **已移除（第四阶段）**——对应组恒为原生实现，回退代理专项测试随实现一并删除；
> 静态扫描守卫 `api-service/tests/test_no_node_dependencies.py` 防止回归。
> 下文对 flag/代理的描述仅作迁移过程历史记录，不再反映当前实现。

> 阶段 7.1 · 鉴权组 API 迁移加固 · 2026-10-17
>
> 本文档从 Node HTTP API（`server/index.mjs` L12257-L12480 及 `server/services/auth-captcha.mjs`）只读提取行为规格，作为 FastAPI 网关（`api-service/`）渐进接管的对照基准。Node 侧源码在提取时为用户修改中文件，本文档不伴随其改动自动更新，后续以 diff 复核。

## 1. 范围与接管状态总览

| # | 方法 | 路径 | 接管状态 | 原生开关（回退 flag） |
|---|------|------|----------|----------------------|
| 1 | POST | `/api/auth/login-password` | ✅ 已原生接管 | `API_NATIVE_AUTH_LOGIN_PASSWORD`（默认 true；7.1 新增） |
| 2 | GET | `/api/auth/check-phone` | ✅ 已原生接管 | `API_NATIVE_AUTH_CHECK_PHONE`（默认 true） |
| 3 | GET | `/api/auth/captcha` | ✅ 已原生接管（8.1） | `API_NATIVE_AUTH_EXTENDED`（默认 true；与 4-8 共用整组开关） |
| 4 | POST | `/api/auth/captcha/verify` | ✅ 已原生接管（8.1） | `API_NATIVE_AUTH_EXTENDED` |
| 5 | POST | `/api/auth/send-code` | ✅ 已原生接管（8.1） | `API_NATIVE_AUTH_EXTENDED` |
| 6 | POST | `/api/auth/reset-password` | ✅ 已原生接管（8.1） | `API_NATIVE_AUTH_EXTENDED` |
| 7 | POST | `/api/auth/login` | ✅ 已原生接管（8.1） | `API_NATIVE_AUTH_EXTENDED` |
| 8 | POST | `/api/auth/register` | ✅ 已原生接管（8.1） | `API_NATIVE_AUTH_EXTENDED` |

Node 鉴权组只有以上 8 条路由：**不存在** `/api/auth/logout` 与 `/api/auth/refresh`（登出为前端清除 localStorage，无服务端端点），8.1 未为其新增实现。

flag 为 `false` 时对应路由整条代理给 Node（`proxy_api`，`app/main.py` L719 起）：转发原 method/query/body，剔除 `host`/`content-length` 头并追加 `x-forwarded-by: projectdream-fastapi`；透传 Node 状态码与响应体（仅保留 `content-type`/`cache-control` 头）；Node 网络失败 → `502 / code=5020 "业务服务暂时不可用，请稍后重试"`。

鉴权组 8 条路由全部为公开路由（无需登录，无 Authorization 校验），因此「未登录」场景对本组一律标注 N/A。

## 2. 通用约定（Node 侧语义提取）

- **envelope**：`success(res, data, message)` → HTTP 200 + `{"code": 0, "message": message, "data": data}`（`index.mjs` L6258）；`fail(res, code, message, statusCode=400)` → HTTP statusCode + `{"code": code, "message": message, "data": null}`（L6262）。FastAPI 侧由 `app/envelope.py` 的 `success()`/`failure()` 对齐。
- **手机号标准化 `normalizePhone`**（L6293）：`String(input || '').replace(/\D/g, '').slice(0, 11)` —— 删除所有**非 ASCII 数字**字符（空格、`+`、`-`、全角数字 `１-９` 等一律剔除），截取前 11 位。合法形态 `/^1\d{10}$/`。
  - 注意：JS `\D` 等价 `[^0-9]`（仅 ASCII）。Python 侧等价实现为 `"".join(c for c in s if "0" <= c <= "9")[:11]`，**不可用** `str.isdigit()`（它保留全角数字）。7.1 已将 `login-password` 原生实现的 `isdigit()` 修正为 ASCII 判断，与 `check-phone` 及 Node 对齐。
  - 边界语义：`"139 1234 5678"` → `13912345678`（通过）；`"+8613912345678"` → `8613912345678` 截断为 `86139123456`（不以 1 开头 → 4001）；`"139123456789"`（12 位）→ 截断为 `13912345678`（通过）；全角 `"１３９１２３４５６７８"` → 空串（4001）。
- **密码哈希**：SHA-256 hex（`hashPassword`，L6297）；users 表 `password_hash VARCHAR(64)`。
- **safe user 形状 `toSafeUser`**：`{"id", "phone", "nickname", "createdAt"}`，绝不包含 `passwordHash`。Python 侧对应 `_safe_user()`。
- **会话**：`createSession(user)` 写 DB `sessions` 表（token、user_id、phone、created_at、revoked_at，L4677），返回 token。重复登录产生**新会话**，不吊销旧会话。

## 3. 错误码矩阵（鉴权组）

| code | HTTP | message（Node 原文） | 触发路由 | 语义 |
|------|------|---------------------|----------|------|
| 4001 | 400 | 手机号格式不正确 | 全部 8 条 | normalizePhone 后不匹配 `/^1\d{10}$/` |
| 4002 | 400 | 该手机号已注册 | send-code(register)、register | 数据已存在 |
| 4003 | 400 | 验证码格式不正确 | send-code 无 / login、register、reset-password | code 不匹配 `/^\d{4,8}$/` |
| 4004 | 400 | 该手机号尚未注册 | send-code(login/reset)、reset-password、login、login-password | 数据不存在 |
| 4005 | 400 | （verifySmsCode 返回的 message） | login、register、reset-password | 短信验证码校验失败（过期/错误/已用） |
| 4006 | 400 | 昵称至少需要 2 个字符 | register | nickname.trim() 长度 < 2 |
| 4007 | 400 | 密码至少需要 6 位 / 新密码至少需要 6 位 | login-password、register、reset-password | 密码长度 < 6 |
| 4008 | 400 | 账号或密码不正确 | login-password | 密码哈希不匹配 |
| 4009 | 409 | 请先完成滑块验证，验证结果已失效或已使用 | send-code | captchaToken 消费失败 |
| 4010 | 409 | 滑块挑战签名无效 / 已使用或不存在 / 已过期 / 来源不一致 / 手机号不一致 / 尝试次数过多 / 请将滑块拖到高亮位置 | captcha/verify | 滑块校验失败（4010 另在受保护路由作 401 未登录语义，与本组无关） |

状态码规律：4001-4008 → 400；4009/4010（滑块类）→ 409；未登录 4010 → 401（仅受保护路由）。

## 4. 逐条路由规格

### 4.1 POST /api/auth/login-password —— ✅ 已接管（Node L12339）

- **请求 JSON**：`phone`（string）、`password`（string）。
- **校验顺序**：4001 手机号 → 4007 密码长度 → 查库 → 4008 密码不匹配。
- **成功 envelope**：`{"code": 0, "message": "登录成功", "data": {"token": "<64位hex>", "user": {"id", "phone", "nickname", "createdAt"}}}`。
- **依赖**：`users` 表（`fetch_user_by_phone`）、`sessions` 表（`create_session`）。均已 DB 化，Python 原生直连 MySQL。
- **Python 原生实现**（`app/main.py` L225）：校验顺序 4001 → 4007 → `fetch_user_by_phone` → SHA-256 比对 → `create_session` → `success(..., "登录成功")`。
- **与 Node 的已知差异**：
  1. **未注册手机号**：Node 返回 `400 / 4004 "该手机号尚未注册"`；Python 原生合并为 `400 / 4008 "账号或密码不正确"`（防账号枚举的收紧，7.1 保持现状并在测试中锁定两侧行为）。前端对两种文案均有兜底；若产品要求对齐 4004，属一行改动，需产品决策后另行变更。
  2. **全角数字**：原 Python 实现用 `isdigit()` 会把全角手机号标准化成合法号（与 Node 不一致），7.1 已修正为 ASCII-only 判断（见 §2），修正后两侧一致。
- **重复写入语义**：每次成功登录创建新 session 行，旧 token 不失效。

### 4.2 GET /api/auth/check-phone —— ✅ 已接管（Node L12257）

- **请求 query**：`phone`。
- **校验顺序**：4001 手机号 → 查库。
- **成功 envelope**：`{"code": 0, "message": "success", "data": {"exists": true|false}}`；`exists=false` 同样是 200 成功（「未注册」在本路由不是错误）。
- **依赖**：`users` 表。只读、幂等。
- **Python 原生实现**（`app/main.py` L242）：flag 分支 → normalizePhone（ASCII-only）→ 4001 → `fetch_user_by_phone` → `success({"exists": bool(user)})`；响应体不泄漏用户记录（仅 exists 布尔）。

### 4.3 GET /api/auth/captcha —— ✅ 已原生接管（8.1，Node L12268）

- **请求 query**：`phone`（可选，原样传入 createChallenge）；IP 取 `x-forwarded-for` / `x-real-ip` / socket 首段。
- **成功 envelope**：`{"code": 0, "message": "success", "data": {"challengeId", "challenge"（base64url 签名串 `<encoded>.<hmac>`）, "backgroundImage"（SVG dataUri）, "pieceImage", "trackWidth": 320, "imageHeight": 120, "pieceSize": 56, "pieceTop", "expiresAt"}}`。
- **依赖**：`auth_captcha_sessions` 表（迁移 0004）+ `app/auth_captcha.py` 的 `AuthCaptchaService`（SVG 拼图为纯字符串模板逐字符复刻 Node，密钥 `captcha_signing_secret` 读取顺序对齐 Node：`CAPTCHA_SECRET` → `SESSION_SECRET` → 开发期固定缺省）。
- **8.1 实现说明**：挑战记录由 Node 进程内存 Map 改为 MySQL 行（`verified=0`）；响应字段集合与常量值与 Node 完全一致，`targetX` 答案只落 DB 不出现在响应。注意两侧会话存储互不共享：flag 切换后旧挑战失效（用户需重新滑块），属可接受的短暂过渡态。

### 4.4 POST /api/auth/captcha/verify —— ✅ 已原生接管（8.1，Node L12276）

- **请求 JSON**：`challenge`（签串）、`position`（number）、`phone`（可选）。
- **成功 envelope**：`{"code": 0, "message": "滑块验证通过", "data": {"captchaToken": "<challengeId>.<hmac>"}}`。
- **错误**：校验失败一律 `409 / 4010 / <result.message>`（签名无效、已用、过期、IP/手机号不一致、尝试次数超 MAX_ATTEMPTS、位置偏差 > 8px）。
- **依赖**：`AuthCaptchaService.verify`——按 DB 行校验，成功后原子 `UPDATE verified=1` 并签发验证 token（HMAC），`expires_at` 同步改写为 token 有效期（对齐 Node consumed Map 的 TTL）。
- **8.1 实现说明（含 Node 行为考古两则）**：
  1. Node `verify` 先 `pruneExpired()` 再查 Map，因此**「滑块挑战已过期，请重新验证」分支实际不可达**——过期挑战的可观测消息是「滑块挑战已使用或不存在」（Node 自带测试也只断言 `ok=false`）。Python 复刻实际可观测行为：过期行在 fetch 时标记 `is_expired`，与「不存在/已用」同文案。
  2. Node 对**非数字** `position`（如 `"abc"`）得 `NaN`，`NaN > 8` 恒 False → **校验放行**（安全洞）。Python 刻意收紧为 fail-closed：无法 `float()` 的 position 按「请将滑块拖到高亮位置」失败。缺失/`null` position 两侧同为失败（Node 解构默认 0）。

### 4.5 POST /api/auth/send-code —— ✅ 已原生接管（8.1，Node L12294）

- **请求 JSON**：`phone`、`captchaToken`、`type`（`login`/`register`/`reset`，缺省与非法值都落 `login`）。
- **校验顺序**：4001 手机号 → **消费 captchaToken**（失败 `409 / 4009`）→ `register` 已注册 4002 / `login|reset` 未注册 4004 → 发码。
- **成功 envelope**：`{"code": 0, "message": "验证码已发送", "data": {"countdown", "expiresIn", "devCode", "provider"}}`。`devCode` 仅 mock provider 返回（测试/开发模式）；tencent 供应商时该键省略（Node JSON 序列化丢弃 `undefined`）。
- **依赖**：`auth_captcha_sessions` 表（captchaToken 原子消费）+ `app/sms/` 供应商适配层 + DB `sms_codes` 表（`save_sms_code_record`，phone/code_type/code/provider/expires_at）。
- **8.1 实现说明**：验证码为 6 位随机数字（对齐 Node `randomInt(100000, 1000000)`）；发送失败 → `500/5001` + 适配器受控文案（对齐 Node 全局兜底形状）；发送成功后先落库再返回。Node 无路由级发码限频（频控由短信供应商自身承担），Python 同样不复刻额外限频。前置的「Python 无 SMS SDK」缺口已由 `tencentcloud-sdk-python-sms==3.0.1302`（requirements pin）+ mock 适配器补齐。

### 4.6 POST /api/auth/reset-password —— ✅ 已原生接管（8.1，Node L12370）

- **请求 JSON**：`phone`、`code`、`newPassword`。
- **校验顺序**：4001 → 4003（code 非 4-8 位数字）→ 4007（newPassword < 6）→ 4004 未注册 → `verifySmsCode(phone, 'reset', code)` 失败 4005 → 更新密码。
- **成功 envelope**：`{"code": 0, "message": "密码重置成功", "data": {"success": true}}`。
- **依赖**：`users` 表 + `sms_codes` 表（`verify_sms_code`，事务语义逐项对齐 Node `consumeCode`：FOR UPDATE 行锁 / used_at 一次性 / 过期删行 / 错误可重试）+ `update_user_password`（SHA-256）。

### 4.7 POST /api/auth/login —— ✅ 已原生接管（8.1，Node L12408）

- **请求 JSON**：`phone`、`code`。
- **校验顺序**：4001 → 4003 → 4004 未注册 → `verifySmsCode(phone, 'login', code)` 失败 4005 → `createSession`。
- **成功 envelope**：同 §4.1（`token` + `user`，message `登录成功`）。
- **依赖**：`users` / `sms_codes` / `sessions` 表（均已 DB 化）。
- **已知差异**：与 login-password 相同，响应 `user.createdAt` 为 null（Python `fetch_user_by_phone` 未取该列，7.1 既有行为；Node 返回 DB 时间戳）。

### 4.8 POST /api/auth/register —— ✅ 已原生接管（8.1，Node L12440）

- **请求 JSON**：`phone`、`code`、`nickname`、`password`。
- **校验顺序**：4001 → 4002 已注册（先于 code/nickname/password 校验）→ 4003 → 4006（nickname.trim() < 2）→ 4007 → 4005 → `createUser` + `createSession`。
- **成功 envelope**：同 §4.1，message `注册成功`。
- **依赖**：`users` / `sms_codes` / `sessions` 表；`create_user`（SHA-256 哈希，返回 `createdAt` ISO 字符串，对齐 Node `createUser`）。

## 5. 原生化前置条件（未接管 6 条）

> **8.1 状态更新：本节三项前置已在 Python 侧独立落地，6 条路由均已原生化。**
> §5.1 → 迁移 0004（`auth_captcha_sessions` 表，Python 单侧读写，**未协调 Node 改造**——Node 保留内存 Map 服务自身 flag=false 回退链路，两侧会话互不共享）；§5.2 → 路径 1（`tencentcloud-sdk-python-sms` 原生发送 + mock 适配器，未走 Node 内部转发）；§5.3 → 顺序依赖按 ①→②→③→④ 一次性完成（④ captcha/verify 与 ① 同批实现）。以下小节保留为当时的评估快照。

### 5.1 captcha 会话 DB 化迁移草案（**Node 侧改造是前置，需与用户协调**）

现状：`auth-captcha.mjs` L66-67 的 `challenges = new Map()` / `consumed = new Map()` 为单进程内存态——重启丢失、多实例不共享、Python 进程无法消费。这使得 captcha、captcha/verify、send-code 三条路由无法被 FastAPI 原生接管。

**Python 侧先备好的表设计**（供 Node 改造时对齐；Node 改造完成后由迁移脚本建表）：

```sql
CREATE TABLE IF NOT EXISTS auth_captcha_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  challenge_id   VARCHAR(64)  NOT NULL COMMENT '挑战 id（Node randomBytes(12) hex）',
  phone          VARCHAR(20)  NOT NULL DEFAULT '' COMMENT '发起挑战时绑定的手机号（可选）',
  ip             VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '发起挑战时绑定的来源 IP（可选）',
  target_x       SMALLINT UNSIGNED NOT NULL COMMENT '拼图正确位置 x 坐标',
  attempts       INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '已尝试次数（超过 MAX_ATTEMPTS 作废）',
  verified       TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'verify 通过后置 1',
  captcha_token  VARCHAR(128) DEFAULT NULL COMMENT 'verify 通过后签发的一次性验证 token',
  consumed       TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '被 send-code 消费后置 1（对应 Node consumed Map）',
  issued_at      DATETIME     NOT NULL COMMENT '签发时间',
  expires_at     DATETIME     NOT NULL COMMENT '过期时间（对应 ttlMs / pruneExpired）',
  PRIMARY KEY (id),
  UNIQUE KEY uk_auth_captcha_challenge (challenge_id),
  KEY idx_auth_captcha_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

要点：
- `consumed` 列取代 Node 内存 `consumed Map`（一次性消费标记 + TTL 清理）；`attempts` 取代 `record.attempts`；`ip`/`phone` 支撑「来源/手机号一致性」校验。
- HMAC 签名串（`challenge` / `captchaToken`）格式与密钥管理保持 Node 现状（签名可跨进程验签，密钥经共享配置下发 Python）。
- Node 改造（**前置**，需协调）：`createCaptchaStore` 的 Map 读写替换为 DB 存取（或抽 storage 接口双实现）；先双写灰度，验证后再切 Python 原生读写。
- 清理策略：`expires_at` 索引 + 定时删除过期行，等价 `pruneExpired()`。

### 5.2 SMS 供应商 Python SDK 缺口（或经 Node 内部端点转发的过渡评估）

- Node 侧：`tencentcloud-sdk-nodejs-sms`（v20210111，L16/L4591）为主，阿里云 PNVS 为备选，另有 mock provider（devCode）。发送动作 + `sms_codes` 落库在 `sendVerificationCode`/`saveCodeRecord`（L6366/L6318）。
- Python 侧：`api-service/requirements.txt` 无任何 SMS SDK。两条路径：
  1. **原生化发送**：引入 `tencentcloud-sdk-python-sms`（及阿里云对应 SDK），在 FastAPI 复刻 provider 选择 / devCode / countdown / expiresIn 语义。成本：SDK 引入 + 双供应商适配 + 密钥配置迁移。
  2. **过渡转发**：Node 暴露内部端点（如 `POST /internal/sms/send`，复用 `INTERNAL_TOKEN` 模式），Python `send-code` 原生完成校验与落库、仅转发发送动作。成本：Node 侧小改（需协调），但保留 Node SDK 依赖。**注意：Node 侧任何改动均为用户修改中文件的协调事项，本阶段未实施。**
- `sms_codes` 表已 DB 化，`verifySmsCode`（login/register/reset 消费侧）Python 可直接实现，不构成缺口。

### 5.3 login / register / reset 原生化的顺序依赖

```
① captcha DB 化（§5.1，Node 改造前置）
        ↓  否则 Python send-code 无法消费 Node 内存 captchaToken → 验证码断链
② send-code 原生化（§5.2：Python 发码 或 Node 内部转发）
        ↓  否则短信码仍由 Node 侧 context 发出，难以闭环
③ reset-password / login / register 原生化（纯 DB：users / sms_codes / sessions）
        ↓
④ captcha / captcha/verify 原生化（需复刻 SVG 拼图生成与验签，收益低，可长期保留 Node 或最后做）
```

- `sessions` 表已 DB 化：③ 中 login/register 的 `createSession` 无阻碍；`check-phone`、`login-password` 已证明 users 表读写可直接迁移。
- 若跳过 ①② 直接原生化 ③，`verifySmsCode` 虽可读 `sms_codes`，但上游 send-code 仍要求 Node 内存 captchaToken，用户全流程仍会打到 Node —— 不产生收益且引入两侧消费竞争，故**禁止跳序**。

## 6. 七类场景 × 2 条已接管路由核对矩阵

覆盖来源：[E] = 既有 `tests/test_contracts.py`；[N] = 7.1 新增 `tests/test_auth_group_compat.py`。

| 场景 | POST /api/auth/login-password | GET /api/auth/check-phone |
|------|------------------------------|---------------------------|
| 未登录 | N/A（公开路由） | N/A（公开路由） |
| 字段缺失/非法 | 缺 phone → 400/4001 [N]；缺 password → 400/4007 [N]；password<6 → 400/4007 [N]；phone 非法 → 400/4001 [N] | 缺 phone → 400/4001 [E]；phone 非法 → 400/4001 [E] |
| 数据不存在（未注册） | 原生 400/4008（与 Node 4004 的差异，锁定两侧）[N]；flag 回退透传 400/4004 [N] | 200/exists=false（非错误）[N] |
| 空数据/边界（标准化） | 空格 `139 1234 5678` → 通过 [N]；`+86` 前缀 → 4001 [N]；12 位截断 → 通过 [N]；全角 → 4001（7.1 修复对齐 Node）[N] | 空格 → 通过 [N]；`+86` → 4001 [N]；12 位截断 → 通过 [N]；全角 → 4001 [E] |
| 异常依赖 | DB 抛异常 → 500/5001（不泄漏内部信息）[N]；flag 回退 + upstream 失败 → 502/5020 [N] | DB 抛异常 → 500/5001 [N]；flag 回退 + upstream 失败 → 502/5020 [N] |
| 重复写入 | 两次登录 → 两次 create_session（新 token，旧会话不吊销）[N] | 幂等只读：两次调用结果一致、无写入 [N] |
| 状态码与 envelope 形状 | 成功 200 `{code:0, message:"登录成功", data:{token,user}}`，user 不含 password_hash [E+N]；错误 `{code,message,data:null}` [E+N] | 成功 200 `{code:0, message:"success", data:{exists}}` [E]；错误同上 [E+N] |

flag 回退专项（§7 交付 3）：

| 用例 | 断言 | 来源 |
|------|------|------|
| `API_NATIVE_AUTH_CHECK_PHONE=false` | 请求到达 fake upstream（URL/method/query/头），响应原样透传 | [E] 已有成功路径；[N] 补非 200 透传 + 失败 502 |
| `API_NATIVE_AUTH_LOGIN_PASSWORD=false` | body 透传给 fake upstream，Node envelope 原样返回 | [N] |
| flag=true（默认） | 直连 DB，不触 upstream | [E] + [N] |
| flag 值非法（如 `"abc"`） | pydantic bool 解析在 Settings 构造期抛 `ValidationError`（快速失败，不做静默回退） | [N] |
| flag 布尔字符串等价类 | `"0"/"no"/"off"` → False；`"1"/"yes"/"on"` → True | [N] |

## 7. 7.1 变更清单

- `app/config.py`：新增 `native_auth_login_password`（`API_NATIVE_AUTH_LOGIN_PASSWORD`，默认 true，模式与 `native_auth_check_phone` 一致）。
- `app/main.py`：`login-password` 路由增加 flag 回退分支（照抄 `check-phone` 模式）；标准化由 `isdigit()` 修正为 ASCII-only 判断（对齐 Node `normalizePhone`）。
- `tests/test_auth_group_compat.py`：新增鉴权组兼容测试（本文件 §6 矩阵）。
- 只读未动：`server/index.mjs`、`server/services/auth-captcha*`、`server/services/tencent-sms*`、`src/`。

## 8. 8.1 变更清单（FastAPI-Only 迁移第三阶段第一组：鉴权组剩余 6 条原生化）

### 8.1 交付物

| 类型 | 文件 | 说明 |
|------|------|------|
| 迁移 | `migrations/0004_auth_captcha_sessions.sql` + `_rollback.sql` | 滑块会话表：challenge_id 唯一、captcha_token 唯一、expires_at 索引；`verified` / `consumed_at` 两级一次性标记（挑战级 + token 级）；时间列 `DATETIME(3)`，TTL 全部以 DB 时钟（`NOW(3)`）计算。**部署顺序：先执行迁移再开启 `API_NATIVE_AUTH_EXTENDED=true`** |
| 服务 | `app/auth_captcha.py` | `AuthCaptchaService`：SVG 拼图纯字符串模板（逐字符复刻 Node，`encodeURIComponent` 与 `urllib.parse.quote` 的 safe 集合对齐）、HMAC-SHA256 base64url 签名、verify 校验顺序（长度→签名→格式→存在性→IP/手机号→尝试次数→容差）、一次性 token 消费；`random_target_x` / `random_palette` / `now_ms` 可注入 |
| SMS | `app/sms/`（`provider.py` / `mock.py` / `tencent.py` / `__init__.py`） | 接口 + mock（devCode，日志格式对齐 Node `[mock-sms]`）+ tencent（`+86` 前缀 / `SessionContext` 透传 / `Code != 'Ok'` 抛受控 `SmsSendError`）；工厂 `create_sms_provider` 按 `SMS_PROVIDER` 选择 |
| 路由 | `app/main.py` | 6 条新路由 + `_normalize_phone` / `_client_ip` 助手 + `AUTH_PHONE_PATTERN` / `AUTH_SMS_CODE_PATTERN`（re.ASCII 对齐 JS `\d`）；`create_app` 新增 `captcha_service` / `sms_provider` 注入参数 |
| 配置 | `app/config.py` | `native_auth_extended`（`API_NATIVE_AUTH_EXTENDED`，默认 true）、`sms_provider`（`SMS_PROVIDER`）、`auth_captcha_secret`（`AUTH_CAPTCHA_SECRET`）、`session_secret`（`SESSION_SECRET`）、`tencent_*` 凭据 6 项、`captcha_signing_secret` 属性（读取顺序对齐 Node L344） |
| 依赖 | `requirements.txt` | `tencentcloud-sdk-python-sms==3.0.1302`（SDK 在适配器内延迟导入，未安装时启动不 crash） |
| 测试 | `tests/test_auth_extended_compat.py` | 59 条离线用例：captcha 形状/容差边界/重放/过期/畸形/手机号绑定、send-code 全矩阵、register/login/reset 校验顺序与验证码消费、七类场景、flag 回退（GET query + 5 条 POST body 透传、非 200 透传、502）、SMS 工厂降级与 tencent 字段映射 |

### 8.2 SMS 供应商选择与降级策略（实测）

| 场景 | 行为 |
|------|------|
| `SMS_PROVIDER` 缺省 / `mock` | MockSmsProvider：日志 `[mock-sms] type=... phone=... code=... expiresIn=300s`，返回 `devCode` |
| `SMS_PROVIDER=tencent` 且凭据齐全 | TencentSmsProvider（SDK 已在测试 venv 安装验证）；发送失败 → `SmsSendError`（Message 取自 SendStatusSet）→ 500/5001 受控文案 |
| `SMS_PROVIDER=tencent` 但凭据缺失 | **启动期 warning（只列缺失 env 名，不打印凭据值）+ 自动降级 mock**；Node 对照：Node 在发送期才抛「腾讯云短信未配置完成」，Python 收紧为启动期可见 |
| SDK 未安装 / 客户端构造失败 | warning + 降级 mock（不 crash） |
| 未知取值（含 `aliyun`，本阶段未移植 PNVS） | warning + 降级 mock |

### 8.3 发现的 Node↔Python 行为差异清单（8.1 处置）

1. **「已过期」死分支**（§4.4）：Node verify 的过期消息不可达，Python 按可观测行为折叠为「滑块挑战已使用或不存在」。
2. **非数字 position 放行**（§4.4）：Node `NaN > 8` 恒 False 会通过校验；Python fail-closed 拒绝（前端恒传数字，无可观测差异）。
3. **SMS 未配置时机**：Node 发送期抛错；Python 启动期警告 + 降级 mock（可用性优先，见 §8.2）。
4. **SMS provider 取值域**：Node 非 mock/aliyun 一律走 tencent 分支（`xyz` → 发送期抛「腾讯云短信未配置完成」）；Python 未知取值降级 mock。
5. **aliyun PNVS 未移植**：`SMS_PROVIDER=aliyun` 降级 mock（Node 支持阿里云测试短信），后续需要时另行补适配器。
6. **maxEntries 容量上限未复刻**：Node 内存 Map 有 10000 条上限，DB 化后由 `expires_at` 索引 + 写入前清理过期行控制体量。
7. **短信登录响应 `user.createdAt` 为 null**（§4.7）：与 login-password 的 7.1 既有差异保持一致（Node 返回 DB 时间戳）。
8. **logout / refresh 不存在**：Node 无对应路由，未新增（§1 表格下方说明）。

### 8.4 全量测试基线

- 基线（8.1 前）：546 passed；8.1 后：**605 passed**（新增 59，无回归），命令：
  `C:\Temp\pd-venvs\api\Scripts\python.exe -m pytest api-service\tests -q`。
- 七类场景 × 6 条路由核对矩阵见 `tests/test_auth_extended_compat.py` 模块 docstring 与分节注释；flag 回退/解析专项与 §6 表同构。
