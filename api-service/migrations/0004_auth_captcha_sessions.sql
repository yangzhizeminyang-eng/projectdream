-- 阶段 8.1（FastAPI-Only 迁移第三阶段第一组）：滑块验证码会话表（前向迁移）。
-- 用途：把 Node auth-captcha.mjs 的进程内存 Map（challenges / consumed）替换为 MySQL 持久会话，
--       使 FastAPI 原生接管 GET /api/auth/captcha、POST /api/auth/captcha/verify 与
--       POST /api/auth/send-code 的 captchaToken 消费链路（多进程可共享、重启不丢、防重放）。
-- 关键语义（对齐 server/services/auth-captcha.mjs）：
--       verified=0        → 挑战待校验（对应 Node challenges Map）；
--       verified=1        → verify 通过、captchaToken 已签发待消费（对应 Node consumed Map，TTL 重算）；
--       consumed_at       → send-code 一次性消费时间戳（NULL=未消费），原子 UPDATE 防重放；
--       expires_at        → 挑战有效期；verify 通过后改写为 captchaToken 有效期（签发时刻 + TTL）。
-- 注意：两侧会话存储互不共享（Node 仍读写自身内存 Map）。本表只服务 FastAPI 原生链路，
--       部署时须先执行本迁移再开启 API_NATIVE_AUTH_EXTENDED=true，否则 captcha 路由会 500。
-- 回滚方式：执行同目录 0004_auth_captcha_sessions_rollback.sql（丢失未消费的挑战/验证 token，
--           用户需重新完成滑块验证，不影响任何业务数据）。

CREATE TABLE IF NOT EXISTS auth_captcha_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  challenge_id VARCHAR(64) NOT NULL COMMENT '挑战 id（对齐 Node randomBytes(12) hex，24 字符）',
  phone VARCHAR(20) NOT NULL DEFAULT '' COMMENT '签发时绑定的标准化手机号（可选，空串=未绑定）',
  ip VARCHAR(64) NOT NULL DEFAULT '' COMMENT '签发时绑定的来源 IP（可选，空串=未绑定）',
  target_x SMALLINT UNSIGNED NOT NULL COMMENT '拼图缺口正确位置 x 坐标（像素，1-263）',
  attempts INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '已尝试校验次数（超过 MAX_ATTEMPTS=5 作废）',
  verified TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'verify 通过标记：0=待校验；1=已通过并签发 token',
  captcha_token VARCHAR(128) DEFAULT NULL COMMENT 'verify 通过后签发的一次性验证 token（<challenge_id>.<hmac>）',
  consumed_at DATETIME(3) DEFAULT NULL COMMENT '被 send-code 消费的时间（NULL=未消费）；一次性消费防重放',
  issued_at DATETIME(3) NOT NULL COMMENT '挑战签发时间',
  expires_at DATETIME(3) NOT NULL COMMENT '过期时间：挑战 TTL；verify 通过后改写为 token 有效期（签发时刻+TTL）',
  PRIMARY KEY (id),
  UNIQUE KEY uk_auth_captcha_challenge (challenge_id),
  UNIQUE KEY uk_auth_captcha_token (captcha_token),
  KEY idx_auth_captcha_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='滑块验证码会话：挑战签发/校验/一次性 token 消费（替代 Node 内存 Map）';
