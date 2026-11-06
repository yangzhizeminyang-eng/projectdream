# FastAPI-Only 交付物一致性修复与闭环验收 Spec

## Why

阶段 0-10 交付物之间存在事实性不一致（健康探针路径、冒烟可达性、手册失效/危险命令、报告统计口径），会导致生产切换按错误步骤执行或把失败误判为成功。本规格以可复现测试修复一致性问题并完成仓库侧闭环验收。

## What Changes

- 统一健康/就绪契约：FastAPI 现注册 `/health` 与 `/ready`（main.py L2635/L2639）。**决策：不新增 `/health/ready` 别名**——现有消费者（compose healthcheck L77、smoke、pytest）全部使用 `/ready`，修正报告与手册中的错误表述即可；不通过 Nginx 暴露探针到公网（避免健康信息暴露面扩大）。
- smoke 脚本区分两种运行目标：
  - **容器内 readiness**（`--exec-compose`）：经 `docker compose exec api` 用镜像内 python urllib 探 `/health` `/ready`——解决 api 仅 expose 未发布宿主端口、smoke 默认 `127.0.0.1:8000` 宿主不可达的问题。
  - **公网黑盒**：不做探针直连；改验证 FastAPI 收口形状（4040 envelope、鉴权 4010）——SPA fallback 的 200 HTML 不再构成假阳性。
  - probe 校验响应 Content-Type/JSON 形状，杜绝「SPA HTML 被判健康」。
  - `--check-compose` 输出明确标注「静态结构检查」（parseComposeServices 仅解析 YAML 文本）。
  - 登录态链路使用专用测试账号 + 唯一临时项目（uuid 后缀），finally 尽力清理本次创建数据，不触碰既有项目。
- 切换手册命令修复：
  - MYSQL_ROOT_PASSWORD 不再依赖宿主 shell：统一 `docker compose exec mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" ...'`（凭据留在容器 env，不进宿主环境/命令行/日志）。
  - 备份目录 `mkdir -p`、文件名含秒级时间戳、`gzip -t` 完整性校验；迁移 stdin 重定向保持 0001→0004 顺序且先备份后迁移；回滚用同一凭据机制。
  - API 容器内 `curl` 全部替换为 `python -c urllib`（python:3.12-slim 无 curl）。
  - 移除全局 `docker image prune -f` 默认步骤：改为只读列示候选镜像（ID/归属/容器引用）+ 操作者显式确认后删除。
  - `logs -f` 类阻塞命令改为 `--tail` + 轮询/`timeout` 包装；每步给出失败停止条件与安全回退指向（§15）。
- 最终报告口径校准：
  - 501 统计拆分：本规格编写时的「20 条路由级显式 501（OPS_FALLBACK_501_ROUTES）」与「2 个 mock 任务动作在 native 计数路由内内联返回 501」分开陈述；截至 2026-10-20，当前工作树已迁移 10 条路由和 2 个 mock 动作，故当前为 10 条路由级 501、无内联 mock 501（未发布云端）。native 分类指路由存在，不等于所有请求行为已实现。
  - 九条硬条件逐条给出可复核证据（文件/命令/输出），生产侧保持 PENDING；新增「仍返回 501 的用户功能及其影响」专节。
  - 全局替换 `/health/ready` → `/ready`。

**BREAKING**：无（不新增/删除公开接口；Nginx 与 FastAPI 路由面不变）。

## Impact

- Affected specs: retire-node-http-api（本修复为其交付物收尾，不改其架构决策）
- Affected code:
  - `scripts/fastapi-only-smoke.mjs` + `scripts/fastapi-only-smoke.test.mjs`（probe 形状校验、双目标模式、临时项目清理、新单测）
  - `docs/production-switch-runbook.md`（B/C 块全部命令修复）
  - `docs/node-retirement-final-report.md`（D 块口径校准）
  - `docs/fastapi-only-architecture-decision.md`（健康契约决策备注，仅状态行）
  - `scripts/runbook-consistency.test.mjs`（新增：文档一致性 lint 测试，防 /health/ready、prune -f、容器内 curl 回归）
  - `.trae/specs/retire-node-http-api/tasks.md`（勾选状态校准）

## ADDED Requirements

### Requirement: 健康契约统一
系统 SHALL 以 `/health`（存活）与 `/ready`（就绪，仅探 MySQL）作为唯一健康/就绪探针路径，所有交付物（compose、smoke、手册、报告、测试）SHALL 使用一致路径，且探针 SHALL NOT 经 Nginx 暴露到公网。

#### Scenario: 消费者路径全一致
- **WHEN** 扫描 compose/healthcheck、smoke 脚本、两份文档、pytest 中的探针引用
- **THEN** 仅出现 `/health` 与 `/ready`，无 `/health/ready`；compose healthcheck 与 smoke 容器内模式均探 `/ready`

### Requirement: smoke 双目标模式与假阳性防护
smoke 脚本 SHALL 提供「容器内 readiness（--exec-compose）」与「公网黑盒（默认/`--public`）」两种目标，probe SHALL 校验响应 JSON 形状或 Content-Type，公网模式 SHALL 通过 FastAPI 专有收口形状（4040/4010）证明流量打到 FastAPI。

#### Scenario: SPA fallback 不再假阳性
- **WHEN** 对返回 200 + `text/html` 的 SPA fallback 路径做探针
- **THEN** probe 判定 FAIL（形状不符），smoke 输出 FAIL 而非 PASS

#### Scenario: 宿主机不可达 api 时容器内检查可用
- **WHEN** compose api 仅 expose 未发布宿主端口，操作者执行 `--exec-compose`
- **THEN** 经 `docker compose exec api python -c ...` 获取 `/ready` 形状 `{"status":"ready"}` 判定 PASS

#### Scenario: 登录态链路数据隔离与清理
- **WHEN** 配置了演示账号执行登录态最小生成链路
- **THEN** 仅创建唯一命名（含运行时间戳/uuid）的临时项目，结束时（含失败路径）尽力删除该项目，既有项目数据零改动

### Requirement: 手册命令可靠性
切换手册中每条命令 SHALL 在当前镜像/拓扑下实际可执行：数据库命令凭据 SHALL 来自 compose 服务环境（不依赖宿主 shell 导出），API 容器内验证 SHALL 仅使用镜像内存在的工具，默认清理步骤 SHALL NOT 包含全局 `docker image prune -f`，长输出命令 SHALL NOT 无限阻塞。

#### Scenario: 数据库备份不依赖宿主环境
- **WHEN** 宿主 shell 无 MYSQL_ROOT_PASSWORD 变量时按手册执行备份
- **THEN** 命令经 `docker compose exec mysql sh -c '...'` 成功执行，密码不出现在宿主命令行与输出中

#### Scenario: 清理步骤先列示后确认
- **WHEN** 执行观察期后的镜像清理步骤
- **THEN** 先只读输出候选镜像 ID/归属/引用，实际删除命令需操作者显式填入目标且不属于默认步骤

### Requirement: 报告口径可复核
最终报告 SHALL 区分「代码/仓库已验证」「本地容器已验证」「生产待办」三级证据；SHALL 分别陈述 20 条路由级 501 与 2 个内联 mock 动作 501；生产侧条件 SHALL 保持 PENDING 直到获得真实生产命令输出。

#### Scenario: 501 口径无歧义
- **WHEN** 阅读报告 §4 与路由覆盖矩阵
- **THEN** 覆盖统计明确含 2 个内联动作所在路由，并分别标注 final-edit 迁移前后与生产发布状态

## MODIFIED Requirements

（无公开接口变更；`--check-compose` 行为保持，仅输出标注精确化。）

## REMOVED Requirements

（无。）
