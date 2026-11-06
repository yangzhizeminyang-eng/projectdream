﻿# Tasks

- [x] Task 1: 健康契约统一（探针路径全局一致 + 不暴露公网）
  - [x] 1.1 Grep 全仓 `/health/ready` 残留（docs/**、api-service/docs/**、.trae/specs/**），修正最终报告与切换手册表述为 `/ready`（历史记录性文件仅改易误导处）
  - [x] 1.2 复核全部消费者：compose healthcheck（/ready ✓）、smoke、pytest 断言；在 runbook §0 增加一句「探针不经 Nginx 暴露公网，公网黑盒用收口形状验证」的契约说明
- [x] Task 2: smoke 脚本双目标模式与假阳性防护（TDD：先红灯测试再实现）
  - [x] 2.1 红灯：fastapi-only-smoke.test.mjs 新增——SPA HTML 假阳性（200+text/html 判 FAIL）、非 JSON body 形状校验、`--exec-compose` exec 命令构造（dry-run 断言）、公网模式收口形状步骤、登录态临时项目清理调用（含失败路径）、`--check-compose` 输出含「静态结构检查」标注
  - [x] 2.2 实现：probe 增加 Content-Type/JSON 形状判定；`--exec-compose`（docker compose exec api python -c urllib 探 /health /ready）；公网模式探针步骤替换为 4040/4010 形状断言；登录态链路临时项目 uuid 命名 + finally 清理；输出标注
  - [x] 2.3 回归：node --test scripts/assert-fastapi-only.test.mjs scripts/fastapi-only-smoke.test.mjs 全绿；既有断言仅在行为变更处更新并逐条列明
- [x] Task 3: 切换手册命令修复（B+C 块全部条目）
  - [x] 3.1 数据库段：exec 容器 env 凭据机制统一（备份/迁移/校验/回滚四处）、mkdir -p backup、秒级时间戳文件名、gzip -t、先备份后迁移的停止条件、迁移顺序与幂等核对说明
  - [x] 3.2 验证段：API 容器内 curl → python urllib；logs -f → --tail + timeout/轮询；每步失败停止条件与回退指向（§15）
  - [x] 3.3 清理段：删除全局 docker image prune -f 默认步骤，改为「只读列示（docker images/ps 引用核对）→ 操作者显式填目标删除」；docker rm/compose down/备份删除命令补充影响范围与备份保留说明
  - [x] 3.4 smoke 用法段：与 Task 2 新接口一致（--exec-compose 容器内 / 公网模式两轮黑盒命令重写）
- [x] Task 4: 最终报告口径校准（D 块）
  - [x] 4.1 九条硬条件逐条重写证据（文件路径/命令/输出），路径统一 /ready；PENDING 保持
  - [x] 4.2 501 口径拆分：20 条路由级 + 2 个内联 mock 动作（native 计数含义显式说明）；新增「仍 501 的用户功能及影响」节
  - [x] 4.3 「代码/仓库已验证 / 本地容器已验证 / 生产待办」三级证据标注复核
- [x] Task 5: 文档一致性 lint 测试（新增 scripts/runbook-consistency.test.mjs，node --test）
  - [x] 5.1 断言 runbook 不含 `docker image prune -f`（默认步骤）、API 容器内无 curl 调用、无 /health/ready；断言 report 无 /health/ready、含 501 口径拆分表述与 PENDING 生产条目；断言 smoke --help 含 --exec-compose
- [x] Task 6: 闭环验收实跑与记录（E 块 8 项，逐项记录真实结果）
  - [x] 6.1 node scripts/assert-fastapi-only.mjs
  - [x] 6.2 node --test scripts/assert-fastapi-only.test.mjs scripts/fastapi-only-smoke.test.mjs scripts/runbook-consistency.test.mjs
  - [x] 6.3 python -m pytest api-service/tests -q
  - [x] 6.4 npm test（先读 package.json 确认 test 脚本实际范围）
  - [x] 6.5 npm run build
  - [x] 6.6 docker compose --env-file .env.production.example config --services
  - [x] 6.7 Docker Engine 可用性判定：可用 → API/Worker 镜像 build --check + 隔离 smoke；不可用 → 如实记录并给出云端执行指引
  - [x] 6.8 git diff 复核：无无关文件改动、无密钥/本地产物混入；旧任务书 tasks.md 勾选状态同步

- [x] Task 7: final-edit 两条路由原生迁移（P74 增量，2026-10-20）
  - [x] 7.1 GET 聚合确认视频/静帧、音轨、草稿与导出校验；PUT 做片段/音量归一并 owner-scoped upsert
  - [x] 7.2 兼容测试覆盖 GET/PUT 成功形状、去重/非法 ID/音量钳位、持久化返回与跨用户拒绝
  - [x] 7.3 覆盖矩阵由 native=105/501=13 更新为 native=107/501=11，并同步库存、报告、切换手册和文档 lint
  - [ ] 7.4 全量回归、镜像构建与隔离云端发布（验收通过后再勾选）

- [x] Task 8: 导出创建接入共享队列并由 Worker 持续消费（P74 增量，2026-10-20）
  - [x] 8.1 POST 校验 owner、export package 与 final-edit；空媒体拒绝；成功后写 queued export_records
  - [x] 8.2 Worker 周期扫描 queued/running 导出，扫描间隔使用 BACKGROUND_QUEUE_POLL_INTERVAL_MS；healthcheck 检查两张队列表
  - [x] 8.3 API/Worker 定向测试通过，矩阵由 native=107/501=11 更新为 native=108/501=10；同步规格、库存、报告和 lint
  - [ ] 8.4 全量回归、镜像构建与隔离云端发布（验收通过后再勾选）

# Task Dependencies

- Task 1 → Task 4/5（口径先行）；Task 2 → Task 3.4/5（smoke 接口定稿后文档与 lint 跟进）；Task 6 依赖 1-5 全部。
- Task 2.1/2.2 为 TDD 对（先红后绿）；Task 5 在 2/3/4 完成后编写。
