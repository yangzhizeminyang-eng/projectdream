# ProjectDream 腾讯云 Docker Compose 部署指南

> 适用服务器：腾讯云轻量应用服务器
> 公网 IPv4：`<YOUR_SERVER_IP>`
> 系统：Ubuntu Server 24.04 LTS 64bit
> Docker：27.5.1
> 配置：2 核 2G

---

## 一、部署架构

```text
浏览器
  -> http://<YOUR_SERVER_IP>
  -> frontend 容器 Nginx:8080
       -> Vue 静态页面
       -> /api/*、/generated/*、/storage/*、/mock/*、/mock-assets/*
          全部代理到 api:8000（FastAPI 统一入口）
  -> api 容器 FastAPI:8000
       -> 鉴权、项目、分镜、资产、任务入队等全部 /api 接口直接访问 mysql:3306
       -> 媒体服务（本地文件流 + COS 代理/预签名 + 权限校验）
       -> rag:8001（LlamaIndex + Milvus Lite 检索旁路）
       -> 腾讯云 COS 私有桶（生产媒体）
       -> /app/.codex-runtime 共享媒体卷（与 Worker 同卷读写）
  -> worker-node 容器 Node.js（Dockerfile.worker，无端口暴露）
       -> 进程内加载 server/index.mjs 执行体（scripts/run-worker.mjs 入口）
       -> mysql:3306
       -> /app/.codex-runtime 共享媒体卷
       -> 图片、视频、口型同步重试与 ffmpeg / ffprobe 导出 MP4
```

当前公网业务入口是 **FastAPI gateway（FastAPI-Only）**。鉴权、项目、分镜、资产与任务入队等全部 `/api` 接口由 FastAPI 直接访问 MySQL，媒体四路由 FastAPI 媒体服务承接；未迁移/未知路由返回显式 404/4040 envelope，不再代理到 Node。Node 仅在 worker-node 容器内作为 Worker 执行体运行（不暴露端口、无 HTTP API，健康检查走 `scripts/worker-healthcheck.mjs`）。RAG 仍是独立 FastAPI 旁路服务。

---

## 二、腾讯云防火墙

只开放：

```text
22    SSH
80    HTTP
443   HTTPS，后续绑定域名和证书时使用
```

不要开放：

```text
3306  MySQL
6379  Redis，本项目当前不用
```

MySQL 在 Compose 中只绑定：

```text
127.0.0.1:3306
```

如果需要用 Navicat 连接数据库，走 SSH 隧道，不要把 3306 暴露到公网。

---

## 三、部署文件说明

| 文件 | 作用 |
|---|---|
| `docker-compose.yml` | 编排 MySQL、FastAPI Gateway（api）、Node Worker（worker-node）、RAG、Frontend 五个服务；Node HTTP API（backend）已删除 |
| `Dockerfile.worker` | 构建 Node Worker 镜像，安装 FFmpeg；BuildKit 缓存 APK 包，支持配置国内 Alpine 镜像 |
| `Dockerfile.frontend` | 构建 Vue 前端，再交给 Nginx 运行 |
| `scripts/deploy-production.sh` | 生产构建保护、串行发布、健康检查、FFmpeg 验收和清理预览的唯一入口 |
| `nginx-main.conf` | Nginx 非 root 主配置 |
| `nginx.conf` | 前端站点配置和 API 反向代理 |
| `.dockerignore` | 排除本地依赖、生成媒体、测试、调试产物、补丁与密钥目录，控制构建上下文边界 |
| `.env.production.example` | 生产环境变量模板 |
| `rag-service/` | LlamaIndex + Milvus Lite + 智谱 `embedding-3` 检索旁路 |

RAG 灰度配置：

```dotenv
RAG_ENABLED=false
RAG_INDEX_ENABLED=false
RAG_SERVICE_URL=http://rag:8001
RAG_TIMEOUT_MS=15000
RAG_TOP_K=5
```

索引生命周期和版本覆盖策略完成前，保持两个开关关闭，避免空库查询造成无效向量调用，或重复写入历史向量。先完成索引幂等、更新/删除和回填策略，再单独打开索引写入与查询。

### 后端 FFmpeg 构建加速

Worker 镜像为 `Dockerfile.worker`（Node HTTP API 角色已退役，`/api` 与四路媒体由 FastAPI 网关 `api-service/Dockerfile` 纯 Python 镜像承接），并使用固定 BuildKit cache ID `projectdream-npm-cache` 与 `projectdream-apk-cache`。npm 下载缓存挂载到 `/root/.npm`，APK 缓存挂载到 `/var/cache/apk`；两者都仅缓存包/索引，不把 `node_modules` 或系统包缓存复制进运行时卷。FFmpeg 安装层位于 `npm ci` 之后、应用源码复制之前：普通源码变更会复用整个 FFmpeg 安装层；源码通过 `COPY --chown=app:app` 直接设置运行用户，避免对 `/app`（含整个 `node_modules`）递归 `chown`。`.dockerignore` 排除 `.genwork`、`artifacts`、本地产生媒体、测试与调试补丁，防止无关文件和凭据进入远程构建上下文。只有 `.codex-runtime` 单独设置为 `app` 可写，剪映草稿安装仍只在显式提供外部 `draftRoot` 时执行。`NPM_REGISTRY` 与 `APK_MIRROR` 可分别切换软件源。首次构建仍需下载依赖并解包 FFmpeg；缓存不能把首次干净构建描述为免下载。验收应记录 npm/APK 缓存复用、FFmpeg 安装层是否 `CACHED` 与完整构建耗时，不能用单步 APK 探针替代完整镜像验收。

生产环境默认使用阿里云 Alpine 镜像，也可以在 `.env.production` 中设置 `APK_MIRROR=https://mirrors.aliyun.com/alpine`。现在统一通过 `scripts/deploy-production.sh` 执行，脚本会在构建前检查 Docker、`flock`、`curl`、内存、Swap 和磁盘，并用全局部署锁阻止并发发布；按 api -> worker-node -> rag -> frontend 串行构建（服务名清单已与 compose 同步，Node API 服务 `backend` 已退役），任一构建失败时不会自动重建线上容器：

```bash
chmod +x scripts/deploy-production.sh
DOCKER_BUILDKIT=1 COMPOSE_DOCKER_CLI_BUILD=1 scripts/deploy-production.sh check
# 服务名清单已同步 compose（api/worker-node/rag/frontend），单服务 build/redeploy 可直接使用。
scripts/deploy-production.sh verify
```

验收时脚本会检查 `ffmpeg`、`ffprobe`、容器状态、首页、`/nginx-health`、`/api/health`，并实际生成/探测 1 秒 MP4。若服务器到所选镜像的网络仍慢，先检查 DNS、TLS 和仓库连通性；不要删除 Docker 缓存或生产卷来处理网络下载慢。

---

## 四、首次部署步骤

### 1. 进入项目目录

```bash
cd /path/to/projectdream
```

如果项目还没上传到服务器，可以先通过 Git、SCP、FinalShell 或宝塔文件管理上传。

### 2. 创建生产环境变量

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

编辑：

```bash
nano .env.production
```

至少要改：

```dotenv
PUBLIC_BASE_URL=http://<YOUR_SERVER_IP>:8002
MYSQL_PASSWORD=你的业务数据库密码
MYSQL_ROOT_PASSWORD=你的Root数据库密码
AI_API_KEY=你的文本模型密钥
TOAPI_API_KEY=你的ToAPI密钥
BIGMODEL_API_KEY=你的视频模型密钥
AGNES_API_KEY=你的Agnes密钥
DASHSCOPE_API_KEY=你的DashScope密钥
LIP_SYNC_API_KEY=你的DashScope密钥
VIDEO_IMAGE_UPLOAD_API_KEY=你的源图上传密钥
OBJECT_STORAGE_PROVIDER=cos
COS_SECRET_ID=你的COS子账号SecretId
COS_SECRET_KEY=你的COS子账号SecretKey
COS_BUCKET=你的存储桶名称-APPID
COS_REGION=ap-guangzhou
OBJECT_STORAGE_PUBLIC_BASE_URL=https://你的存储桶名称-APPID.cos.ap-guangzhou.myqcloud.com
BACKGROUND_QUEUE_POLL_INTERVAL_MS=15000
GENERATION_WORKER_CONCURRENCY=1
```

如果暂时只做页面和本地演示，可以把部分模型能力切成 mock，但真实生成图片、视频、音频时必须填对应密钥。

COS 使用要求：

- 存储桶保持私有读写，不要设置公共读。
- 给子账号最小权限：目标 Bucket 的 `GetObject`、`PutObject`、`HeadObject`、`DeleteObject`、`GetBucket`。
- `OBJECT_STORAGE_PUBLIC_BASE_URL` 必须是视频模型能通过公网 HTTPS 访问的 COS 域名或已配置的 HTTPS 自定义域名。
- 不把 `COS_SECRET_KEY`、签名 URL 或 `.env.production` 提交到 Git。

首次切换到 COS 前，在项目根目录执行只读预检：

```bash
node --env-file=.env.production scripts/verify-object-storage.mjs
```

预检只生成短时签名 URL 并调用 `HeadObject`，不会写入、删除或迁移媒体。默认预检对象不存在时会返回 `objectStatus: "missing"`，这仍表示配置、签名和读取权限已通过；缺少 `COS_SECRET_ID`、`COS_SECRET_KEY`、`COS_BUCKET` 或 `COS_REGION` 时会直接失败。

### 3. 建议创建 Swap

2G 服务器构建前端时可能内存紧张，建议创建 2G Swap：

```bash
free -h
swapon --show
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
free -h
```

持久化 Swap：

```bash
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 4. 检查 Compose 配置

```bash
docker compose --env-file .env.production config --quiet
```

没有输出代表配置语法通过。

### 5. 受保护地串行构建镜像

2 核 2G 不允许一次性并发构建。首次部署使用脚本：

```bash
chmod +x scripts/deploy-production.sh
scripts/deploy-production.sh check
scripts/deploy-production.sh build-all
```

`build-all` 会按 api、worker-node、rag、frontend 顺序串行构建；RAG 镜像更新也必须使用 `build rag` 后接 `redeploy rag`，不要绕过部署锁、资源预检和回滚保护直接重建生产服务。

### 6. 启动服务

```bash
scripts/deploy-production.sh redeploy
scripts/deploy-production.sh verify
```

`redeploy` 使用 `--no-build`，只会启动已经成功构建的镜像；整批服务重建前都会临时保存旧镜像，逐个服务和整栈入口验收均通过后才清理本轮临时标签。任一服务或整栈验收失败时，会恢复本批所有服务并保留临时回滚标签供追查；脚本锁文件为 `/tmp/projectdream-deploy-production.lock`，并发执行会直接拒绝；验收未通过前不要继续生成媒体或处理恢复队列。

---

## 五、健康检查

### 1. 查看容器状态

```bash
docker compose ps
```

理想状态：

```text
mysql       healthy
api         healthy
worker-node healthy
rag         healthy
frontend    healthy
```

整栈最终验收要求五个服务都配置 Docker healthcheck 且状态为 `healthy`，不会把“容器运行中”当成健康。Worker-node 的检查还会验证容器角色、Worker 主进程和 `generation_jobs` 数据库查询。升级失败回滚到尚无 healthcheck 的旧 Worker 镜像时，只报告旧 Worker 已恢复运行，不把它记为健康验收通过。

### 2. 后端健康检查

服务器本机：

```bash
curl -fsS http://127.0.0.1/api/health
```

公网：

```bash
curl -fsS http://<YOUR_SERVER_IP>/api/health
```

### 3. 前端健康检查

```bash
curl -fsS http://127.0.0.1/nginx-health
curl -I http://<YOUR_SERVER_IP>/
```

### 4. MySQL 检查

```bash
docker compose exec mysql mysqladmin ping -h 127.0.0.1 -u root -p
docker compose exec mysql sh -lc 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e "SHOW TABLES;"'
```

### 5. RAG 检查

```bash
docker compose exec rag python -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8001/ready", timeout=5).status)'
docker compose logs --tail=100 rag api worker-node
```

`/ready` 返回 `200` 表示 RAG 服务和向量库就绪；真正查询还会调用智谱向量模型。无检索结果是正常空结果，不代表 API 失败。Node 侧旁路请求默认最多等待 15 秒。

---

## 六、日常运维命令

查看日志：

```bash
docker compose logs --tail=200 api
docker compose logs --tail=200 worker-node
docker compose logs --tail=200 frontend
docker compose logs --tail=200 mysql
```

重启：

```bash
docker compose restart
```

停止：

```bash
docker compose stop
```

启动：

```bash
docker compose start
```

更新代码后重建。必须先完成单服务构建，再执行不带隐式构建的重建：

```bash
scripts/deploy-production.sh build api
scripts/deploy-production.sh build worker-node
scripts/deploy-production.sh redeploy api worker-node
scripts/deploy-production.sh verify
```

前端或 API 更新同理，分别执行 `build frontend` / `build api` 后再 `redeploy frontend` / `redeploy api`。不要把 `docker compose build` 和 `up -d` 串在一个无保护命令中。

查看资源：

```bash
docker stats --no-stream
docker system df
df -h
free -h
```

---

## 七、不要执行的命令

不要执行：

```bash
docker compose down -v
```

原因：`-v` 会删除命名数据卷，包括：

- `projectdream_mysql_data`
- `projectdream_runtime_data`

这会导致数据库和生成媒体丢失。

如果只是停止并移除容器，可以执行：

```bash
docker compose down
```

这个命令不会删除命名卷。

### 生产资源清理

云机清理必须先预览，不能用 `docker system prune -a`。脚本只把同时满足“无标签、且没有任何运行中或已停止容器引用”的 `projectdream/api` 镜像列为候选；运行镜像、`latest`、`rollback-*` 等带标签镜像及被容器引用的镜像都会显示为保留。候选显示的 `virtual_size` 包含共享层，不等于实际可回收空间；删除后用 `docker system df` 核对实际变化。Docker 枚举、镜像元数据或容器引用检查失败时，预览立即非零退出。命令也会列出已退出容器和 Docker 磁盘占用，但不会执行删除：

```bash
scripts/deploy-production.sh cleanup-preview
```

候选只是信息，不代表已获准删除。确认要删除某一个旧服务镜像后，使用脚本的受保护入口，并传入完整 ID（不能使用短 ID）：

```bash
scripts/deploy-production.sh cleanup-image sha256:<完整64位镜像ID>
```

入口会再次核验镜像标签、Compose 项目/服务归属和所有运行中/已停止容器引用；只允许 `api`、`worker-node`、`frontend`、`rag` 服务，无标签且无容器引用的镜像，任何检查不通过即拒绝。删除使用非强制 `docker image rm`，Docker 因父子镜像层或其它依赖拒绝时保持原样。此入口不删除容器、卷或 BuildKit 缓存；不要删除 `projectdream_mysql_data`、`projectdream_runtime_data`、`projectdream_rag_runtime_data`，本机 Docker Desktop 的 `dockerInference` 残留也不属于云端清理范围。

---

## 九、常见问题

### 1. 访问 `http://<YOUR_SERVER_IP>` 打不开

检查：

```bash
docker compose ps
docker compose logs --tail=200 frontend
sudo ss -lntp | grep ':80'
```

同时确认腾讯云防火墙已经开放 80。

> 2 核 2G 实例不要执行 `docker compose build` 全量并行构建。前端 Vite 构建会短时占用较多内存，和 MySQL、Worker、RAG 同时运行时可能触发 OOM，导致 sshd、Nginx 一起无响应。

恢复或发布时按以下顺序操作，业务数据卷不会被删除：

```bash
# 先确认宿主机和 Docker 已恢复，再只构建 API 网关
docker compose --env-file .env.production build api
docker compose --env-file .env.production up -d api

# 再构建前端；前端 Dockerfile 已将 Node 构建堆限制为 512MB
docker compose --env-file .env.production build frontend
docker compose --env-file .env.production up -d frontend

# 最后确认入口和网关，不要用无限等待的 curl
docker compose --env-file .env.production ps
curl -fsS --max-time 10 http://127.0.0.1:8002/nginx-health
curl -fsS --max-time 10 http://127.0.0.1:8002/api/health
```

如果 SSH 连接能建立但一直卡在 banner，或 `/nginx-health` 建立 TCP 后 10 秒无响应，先在腾讯云控制台使用 VNC/强制重启恢复宿主机，再执行上述命令；这不是账号密码校验失败。

### 2. `/api/health` 不通

检查网关：

```bash
docker compose logs --tail=200 api
docker compose ps api
```

常见原因：

- MySQL 密码填错；
- MySQL 还没 healthy；
- `.env.production` 缺少必填模型或数据库配置；
- 端口 80 没有映射到 frontend。

### 3. 导出 MP4 失败

检查 Worker 是否能找到 FFmpeg：

```bash
docker compose exec worker-node ffmpeg -version
docker compose exec worker-node ffprobe -version
```

如果命令存在，再看 Worker 日志：

```bash
docker compose logs --tail=300 worker-node
```

### 4. 图片、视频、音频地址打不开

确认 `.env.production`：

```dotenv
PUBLIC_BASE_URL=http://<YOUR_SERVER_IP>
```

然后重启网关：

```bash
docker compose --env-file .env.production up -d api
```

本项目已经把 `/generated/*` 和 `/mock/*` 交给 Nginx 代理到 api（FastAPI 媒体服务）。

### 5. COS 已配置但视频仍走 ToAPI 上传

检查新生成图片或历史图片是否已有 `storage_key`，以及后端返回的图片 URL 是否是 COS 的 `https://` 签名地址。只有公网 HTTPS 地址会被视频模块直接传给供应商；仍为 `127.0.0.1` 或旧 `/generated/*` 地址时，系统才会回退到 ToAPI 上传链路。

不要在未完成 COS 小文件读写验证前重跑恢复队列。建议先用一个测试项目生成并确认一张静帧，确认该静帧可从 COS 签名 URL 打开后，再按预算小批量执行恢复 dry-run。

### 6. 任务一直处于 queued

先确认 Worker 在运行：

```bash
docker compose ps worker-node
docker compose logs --tail=200 worker-node
```

`api` 只负责 API 和任务入队，不会执行图片、视频、口型同步或导出。Worker 启动时会恢复遗留 `running` 任务并按 `BACKGROUND_QUEUE_POLL_INTERVAL_MS` 轮询；当前生产配置只启一个 Worker，不能通过同时扩容多个 Worker 来提速。

查看 Worker 是否真正就绪：

```bash
docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing-healthcheck{{end}}' "$(docker compose ps -q worker-node)"
docker compose logs --tail=100 worker-node
```

新发布镜像必须显示 `running healthy`。`missing-healthcheck` 表示仍在运行旧镜像，不能视为部署验收通过。

### 7. 前端构建内存溢出

先确认 Swap：

```bash
free -h
swapon --show
```

然后单独重建前端：

```bash
docker compose --env-file .env.production build --no-cache frontend
```

---

## 十、答辩时可以这样讲部署

本项目部署时采用 Docker Compose 单机编排。前端容器使用 Nginx 托管 Vue 构建产物，并把 `/api`、`/generated` 和 `/mock` 请求反向代理到后端 API 容器。API 容器只负责 HTTP 和任务入队；Worker 容器专门执行图片、视频、口型同步重试与 FFmpeg 导出，避免长任务阻塞用户接口。MySQL 独立容器保存业务数据，只绑定服务器本机回环地址，不对公网开放。生成的图片、音频、视频和导出 MP4 通过 Docker 命名卷持久化，避免容器重建导致数据丢失。
