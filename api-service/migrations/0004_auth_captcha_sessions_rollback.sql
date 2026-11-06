-- 阶段 8.1 回滚：删除滑块验证码会话表。
-- 影响：丢失在途滑块挑战与未消费的 captchaToken（均为短 TTL 临时态，最长 5 分钟）；
--       受影响用户需重新完成滑块验证。users / sms_codes / sessions 等业务数据不受影响。
-- 回滚后须同时将 API_NATIVE_AUTH_EXTENDED 置为 false（整组回退代理 Node），
-- 否则 captcha 相关路由会因缺表返回 500/5001。

DROP TABLE IF EXISTS auth_captcha_sessions;
