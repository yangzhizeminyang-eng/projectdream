# Checklist

## 第一阶段：清单与矩阵

- [ ] `docs/node-retirement-inventory.md` 落盘：Node 全部路由枚举（含 AI 生成/角色/画布/导出/运维段）+ FastAPI 分类 + 依赖清单 + 七组迁移矩阵
- [ ] 每条 Node 路由在矩阵中有唯一行与处置决策（已原生/待迁移/显式 501/Worker 保留）
- [ ] 风险清单与切流顺序经用户确认

## 第二阶段：架构决策

- [ ] 决策记录落盘：共享任务表即队列、captcha MySQL 化、SMS adapter 选型、frameCharacterContext 复刻方案、不引入 Redis 论证、Node Worker 保留边界与镜像拆分

## 第三阶段：按组迁移（每组四条：实现/测试/切流/观察）

- [ ] 鉴权组：captcha 全链路 FastAPI（MySQL 会话 + SVG + HMAC）、SMS adapter、register/login/reset/logout 全部原生；错误码 4001-4010 对照测试；会话状态不在 Node 内存
- [ ] 项目/资产组：asset_nodes、角色一致性锁定、版本升级 409、项目删除、角色/场景/声音管理全部原生；媒体 URL 由 FastAPI 产出；越权隔离测试
- [ ] 剧本/分镜组：frameCharacterContext 两侧 fixture 一致；单条 GET 原生无回退；generate 入队化；首镜头 0 秒/时长断裂/空提示词/失效引用回归
- [ ] 生成任务组：全部 generate 入队原生（Node Worker 直消费任务表）；视频/图片确认迁移；确认资产绑定与版本快照保持
- [ ] 媒体/存储组：Nginx 四路改指 FastAPI；本地/COS 媒体带权限校验可访问；导出链路边界确认
- [ ] 运维端点：逐条迁移或显式 501/503 + 缺口记录（无静默 Node 依赖）
- [ ] 每组完成时输出该组测试结果与切流证据

## 第四阶段：消除代理与回退

- [ ] proxy_api / Node upstream client / Node readiness / 全部 API_NATIVE_* / NODE_UPSTREAM_URL 从 FastAPI 删除
- [ ] 静态扫描测试转绿（生产链路零命中）
- [ ] 延期接口（如有）显式 501/503 + 缺口记录；无「以后切回 Node」隐藏开关

## 第五阶段：Docker / Nginx / 镜像

- [ ] Compose 无 backend Node API 服务；Node Worker 独立服务定义（无端口、无代理）；compose config 通过
- [ ] Nginx 无任何 backend:3001；四个媒体路指向 FastAPI
- [ ] API 镜像为 Python 且不含 server/index.mjs；Worker 镜像独立命名；healthcheck 只查 FastAPI/MySQL/必要依赖
- [ ] .env 模板无 Node API 配置

## 第六阶段：前端与脚本

- [ ] 全仓无 localhost:3001 / 127.0.0.1:3001 / backend:3001 引用（生产链路）
- [ ] Worker/脚本不请求 Node HTTP API
- [ ] README/部署文档声明 FastAPI 唯一 HTTP 后端；Node Worker（如保留）单独声明非 API

## 第七/八阶段：测试证据与硬门禁

- [ ] 路由覆盖测试：每条旧 Node 路由有 FastAPI 对应或显式 501 记录
- [ ] 黑盒契约测试全绿（登录/验证码/项目/资产/剧本/分镜/任务/媒体/导出）
- [ ] Worker 独立性测试全绿（停 Node 后主流程可用、无 HTTP 调用、重启恢复、重复回调不重复）
- [ ] `scripts/assert-fastapi-only.mjs` 存在且七类检查生效（失败非 0 + 文件行号）
- [ ] `scripts/fastapi-only-smoke.mjs` 存在且含停 Node 模拟与最小生成链路

## 第九/十阶段：生产切换与最终报告（云端）

- [ ] 14 步切换顺序逐步执行并有记录（备份先行）
- [ ] `docs/node-retirement-final-report.md` 产出：九条硬条件逐项 YES/NO
- [ ] 报告判定纪律：任一条件不满足 → 「Node API 尚未下线」+ 阻塞项，不用模糊表述代替
