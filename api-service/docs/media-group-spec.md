# 媒体/存储组规格（FastAPI-Only 迁移第三阶段第二组，阶段 3.2）


> **第四阶段状态（2026-10-19）**：本文所述 `API_NATIVE_*` 回退开关、`proxy_api` 代理与
> `node_upstream_url`/`node_readiness_timeout_seconds`/`proxy_timeout_seconds` 配置
> **已移除（第四阶段）**——对应组恒为原生实现，回退代理专项测试随实现一并删除；
> 静态扫描守卫 `api-service/tests/test_no_node_dependencies.py` 防止回归。
> 下文对 flag/代理的描述仅作迁移过程历史记录，不再反映当前实现。

FastAPI 原生承接 Nginx 四路媒体 location（`/generated/`、`/storage/`、`/mock/`、
`/mock-assets/`），为第五阶段 Nginx 从 `backend:3001` 切流到 `api:8000` 做准备。

- 实现文件：`api-service/app/media_service.py`（路由注册入口
  `register_media_routes(app, settings)`，由 `app/main.py` 在 `/api` 兜底代理之后调用；
  媒体路由不带 `/api` 前缀，与兜底代理 `@app.api_route("/api/{path:path}")` 互不冲突）。
- Node 权威源：`server/index.mjs` L11979-L12216（generated/mock/mock-assets）、
  L12926-L12946（storage）、L10543-L10642（mock SVG/WAV 生成器）、L18352（未匹配
  兜底 4040『接口不存在』）、`server/services/object-storage.mjs`
  （inferContentType / verifySignedUrl / normalizeObjectKey）。
- 测试：`api-service/tests/test_media_service_compat.py`（81 例，全离线）。

## 1. 四路规格表（Node 行号对照）

| FastAPI 路由（GET） | Node 正则（行号） | 成功行为 | 失败形状 |
| --- | --- | --- | --- |
| `/generated/frame/{name}` | `^/generated/frame/([a-zA-Z0-9._-]+)$`（L12013） | 本地 `GENERATED_FRAME_DIR` 流式读取；MIME：`.png→image/png`、`.webp→image/webp`、其余 `image/jpeg`；`Cache-Control: public, max-age=31536000, immutable`；不支持 Range、不发送 Accept-Ranges | 404/`4040 generated frame not found` |
| `/generated/audio/{name}` | L12039 | `GENERATED_AUDIO_DIR`；MIME：`.mp3→audio/mpeg`、`.ogg→audio/ogg`、`.m4a→audio/mp4`、其余 `audio/wav`；支持 Range；`Accept-Ranges: bytes` | 404/`4040 generated audio not found` |
| `/generated/video/{name}` | L12098 | `GENERATED_VIDEO_DIR`；恒 `video/mp4`；支持 Range | 404/`4040 generated video not found` |
| `/generated/export/{id}` 与 `/generated/export/{id}/{name}` | L12149 | `GENERATED_EXPORT_DIR`；无 `{name}` 时文件名回落 `export-{id}.mp4`，有 `{name}` 时落在 `exports/{id}/{name}`；`.srt→application/x-subrip; charset=utf-8` 且 `Accept-Ranges: none`、忽略 Range，其余 `video/mp4` 支持 Range | 404/`4040 generated export not found` |
| `/mock/image/{a}/{b}/{c}.svg` | L11979 | 代码生成 SVG（复刻 `buildMockImageSvg`，含 `SHOT {a}` / `Version {b} / Candidate {c}` 标题）；`image/svg+xml; charset=utf-8`；`Cache-Control: no-store` | 未匹配 → 兜底 4040 |
| `/mock/audio/...`（V2 六段）`audio/{p}/{s}/{c}/{v}/{type}/{n}.wav` | L12145 | 代码生成 WAV（复刻 `buildMockAudioBuffer`：22050Hz/单声道/16bit/3s，`freq = base{dialogue:220,narration:180,music:330,sfx:440,默认260} + n*28 + v*6 + (s*17+c*29)%41`）；`audio/wav` + `no-store`；V2 优先于 V1，`v/n` 为 `0` 时按 Node `Number\|\|1` 进位为 1 | 未匹配 → 兜底 4040 |
| `/mock/audio/...`（V1 四段）`audio/{p}/{v}/{type}/{n}.wav` | L12148 | 同上，seed=0 | 同上 |
| `/mock-assets/project-{p}/node-{n}/v{x}-{y}.png` | L11993 | 读静态占位图（Node `PUBLIC_MOCK_ASSET_IMAGE_PATH` = 仓库根 `public/images/login-hero-clean.png`；FastAPI 侧 `MOCK_ASSET_IMAGE_PATH` 可配置，缺省回落仓库根同路径）；`image/png` + `Cache-Control: public, max-age=3600` + `X-ProjectDream-Mock-Asset: true` | 404/`4040 mock asset image not found`（占位图缺失时与 Node 同款） |
| `/storage/{key}` | `^/storage/(.+)$`（L12926） | 本地模式读 `OBJECT_STORAGE_ROOT`（含 `.meta.json` sidecar contentType，Node `readMetadata` 同款）；COS 模式流式代理；`Cache-Control: public, max-age=31536000, immutable`；不支持 Range | 401/`4010`（签名缺失/伪造/过期，**有意收紧**）；404/`4040 stored object not found` |

所有媒体成功/失败响应均带 `Access-Control-Allow-Origin: *`（Node 媒体路由与 `json()`
助手 L6248 同款）。未匹配路径/空 path/裸前缀（如 `/storage`、`/generated/`）以及
**一切非 GET 方法（含 HEAD）** → Node 最终兜底 L18352 `404/4040『接口不存在』`
（Node 仅在 `req.method === 'GET'` 时处理媒体；Starlette 会为 GET 路由自动附加 HEAD
匹配，因此「非 GET」兜底路由先于 GET 主路由注册以抢占 HEAD）。

## 2. 权限方案与差异声明（有意收紧）

**URL 形状依据**：`app/media_urls.py` 在 local 模式产出带签名 URL
`{OBJECT_STORAGE_PUBLIC_BASE_URL}/{key}?expires={unix}&signature={hex}`，签名为
HMAC-SHA256(secret, `"{key}\n{expires}"`)——与 Node `object-storage.mjs` 的
`signatureFor` / `verifySignedUrl` / `createSignedUrl` **逐字同构**（跨进程互验兼容）。

**所选方案：`/storage` 强制无状态验签。**

- `expires`/`signature` 缺失、非 64 位十六进制、非整数、已过期（`expires <= now`）、
  或与请求键不匹配（常数时间 `hmac.compare_digest`）→ `401/4010
  「媒体访问签名缺失、无效或已过期」`。
- 验签在键归一化之后进行（签名绑定归一化键，与 `verifySignedUrl` 一致）。
- COS 模式同样强制验签（两种模式同一闸门）。

**与 Node 现状的差异（有意收紧，非兼容缺陷）**：Node `/storage` 路由（L12926）未调用
`verifySignedUrl`，任何键裸读（安全洞）。Node 侧已具备同构签名能力（`createSignedUrl`）
但媒体路由未启用；FastAPI 媒体 URL 产出（media_urls.py）已全面携带签名，因此原生
路由统一要求签名。过渡期影响：Node 时代写入 DB 的裸 `/storage/` 引用（若有）在切流后
返回 4010——按迁移计划 DB 存 `storage_key`、URL 在 API 出口经 `resolve_object_url`
重签，正常链路不受影响。

**公开资源（与 Node 现状一致，不要求鉴权）**：`/generated/*`、`/mock/*`、
`/mock-assets/*` 保持公开——前端以 `<img>/<video>` 标签直连加载，无法附加
Authorization 头；Node 现状同为裸读。`/generated` 文件名白名单 `[A-Za-z0-9._-]+`
天然阻断穿越。收紧范围聚焦 `/storage`（签名机制已存在且产出端已带签）。

## 3. 路径安全（必测）

统一链路：**服务端解码（uvicorn/TestClient 一次）→ 点段守卫 → 键/文件名白名单 →
resolve 后前缀校验**。

- 点段守卫：`p` 的任一段为 `.`/`..`（含 `%2e` 全变体解码后）→ 落 Node 兜底
  `4040『接口不存在』`（Node 的 WHATWG URL 解析器会把点段（含 %2e）在解析期归一化，
  归一化结果要么落空要么改变路径；本守卫与该兜底形状对齐）。
- `/storage` 键校验复刻 Node `normalizeObjectKey`（`media_urls._normalize_key`）：
  至多 3 轮 decode 至稳定；拒绝空键、前导 `/`/`\`、Windows 盘符（`C:/`、`C:\`）、
  任意 `\`、控制字符、空段/`.`/`..` 段。空段（`//`）WHATWG 会保留，故交由
  normalize 判非法 → `4040『stored object not found』`（与 Node 一致），不落入点段守卫。
- `/generated`、`/mock`、`/mock-assets` 子结构正则与 Node 逐条一致
  （`([A-Za-z0-9._-]+)`、`\d+` 等，re.ASCII 对齐 JS `\d` 的 ASCII 语义）。
- 本地读取前统一 `Path.resolve()` 后 `relative_to(root)` 前缀校验（并要求常规文件），
  双保险阻断穿越与符号链接逃逸（Node 无前缀校验，白名单已足够；本服务按任务要求加严）。
- 攻击用例（tests §三，generated 9 例 + storage 12 例参数化 + 带签名穿越键 1 例
  3 键变体）：`..`、`%2e%2e`、双编码 `%252e%252e`、`..%2f`、绝对路径 `%2Fabs`、
  `//etc/passwd`、Windows 盘符 `C%3A%5C`、反斜杠（字面与 `%5C` 编码）、尾随空段、
  5000 字符超长 path；根外机密文件内容永不出现在响应中。

### 与 Node 的已知微小差异（安全方向，非行为缺陷）

1. **字面点段**：`/generated/frame/../x` 在 Node 会被 WHATWG URL 归一化为
   `/generated/x` 类路径（可能意外命中其他子路由），本服务统一拦截为兜底 4040。
2. **百分号解码语义**：Node 对 `/generated` 系路由在**编码态** pathname 上做白名单
   匹配（`%41` 类编码不命中 → 接口不存在），本服务在**解码态**上匹配（`%41`→`A`
   可命中白名单文件）；因白名单与点段守卫共同收口，不产生穿越面，仅影响此类
   罕见编码请求的 404 文案。
3. **符号链接**：resolve 后前缀校验会拒绝指向根外的 symlink（Node 会跟随）。
4. **`bytes=-0` 怪癖**：Node 的后缀分支条件为 `!g1 && g2` 且 `Number('0')=0` 不触发
   后缀语义，`bytes=-0` 实际返回 `206 bytes 0-0`——已逐字复刻（见 tests §四）。

## 4. Range 语义（复刻 Node 单区间，index.mjs L12055-L12082 等）

- 解析：`^bytes=(\d*)-(\d*)$` 单区间（re.ASCII）；多区间/非数字 → 视为无 Range →
  `200` 全量。
- `bytes=a-b`：start=a、end=b（b 缺省 = size-1）；`bytes=-N`：后缀（start=size-N）；
  `end = min(end, size-1)` 钳制。
- 非法（`end<start` 或 `start>=size`）→ `416` + `Content-Range: bytes */{size}` + 空体。
- `206` 响应：`Accept-Ranges: bytes`、`Content-Range: bytes {start}-{end}/{size}`、
  `Content-Length: {len}`。
- 支持矩阵（= Node）：`/generated/audio`、`/generated/video`、`/generated/export`
  （`.srt` 除外）；`/generated/frame` 与 `/storage` 不支持（Node 全量返回），
  如实记录且保持同语义。

## 5. COS 代理模式（`OBJECT_STORAGE_PROVIDER=cos`）

- Node 现状：`getObject` 全量读入内存后返回（无 302 重定向）→ FastAPI 选**同构的
  代理转发**实现，且按任务要求升级为**流式**（64 KiB 分片，不落盘、不整读进内存）。
- 客户端经模块级 `cos_client_factory(settings)` 惰性构建（qcloud SDK 构建参数与
  `media_urls` 的 `create_object_url_resolver` 一致；进程内缓存一份，对齐 Node
  启动期构建）。测试 monkeypatch 该工厂注入伪客户端，全程离线。
- Content-Type 取 COS 响应 `Content-Type` 头，缺省按扩展名推断（Node
  `cosObjectInfo` 同款回落）。
- 任何 COS 异常（含 404/NoSuchKey）→ Node catch-all 同款 `404/4040
  『stored object not found』`。
- cos 模式下 FastAPI 产出的媒体 URL 是 COS 直连预签名地址（`media_urls` 现状），
  `/storage/` 路由仅服务遗留引用，同样强制验签（§2）。

## 6. flag：`API_NATIVE_MEDIA`（默认 true）

- true：四路媒体原生接管（本文件全部行为）。
- false：四路所有方法返回 `501/{code:5001, message:"媒体服务未启用
  （API_NATIVE_MEDIA=false，仍由 Node 后端提供）"}`。
- **过渡态说明**：本阶段 Nginx 仍把 `/generated|/storage|/mock|/mock-assets` 指向
  `backend:3001`，FastAPI 媒体路由经 Nginx 不可达；flag 的意义是 FastAPI 内实现开关
  与未来回退位。与其他业务组不同，媒体路由不带 `/api` 前缀、**无法**走既有兜底
  代理回退 Node，故 false 时为 501 过渡态而非代理。第五阶段 Nginx 切流到 api:8000
  验证后，该 flag 与 false 分支一并删除。

## 7. 配置变化（inventory C 节风险 4 处置）

- `OBJECT_STORAGE_PUBLIC_BASE_URL` 默认值 `http://127.0.0.1:3001/storage` →
  `http://127.0.0.1:8000/storage`（`.env.example` 同步；生产由 `.env.production`
  覆盖为公网地址——该文件为部署文件，本阶段未改动）。
- 新增 Settings 字段（validation_alias 与 Node 同名 env 对齐）：
  `OBJECT_STORAGE_ROOT`（本地对象存储根，默认 `.codex-runtime/object-storage`）、
  `GENERATED_FRAME_DIR` / `GENERATED_AUDIO_DIR` / `GENERATED_VIDEO_DIR` /
  `GENERATED_EXPORT_DIR`（Node 硬编码 `.codex-runtime` 相对 cwd；此处允许 env 覆盖
  便于测试与部署）、`MOCK_ASSET_IMAGE_PATH`（缺省回落仓库根
  `public/images/login-hero-clean.png`）、`API_NATIVE_MEDIA`。
- `docker-compose.yml`：仅添加注释（api 服务第五阶段需补挂
  `runtime_data:/app/.codex-runtime` 媒体卷并提供 mock 占位图），结构改动留给第五阶段。

## 8. 测试索引（`tests/test_media_service_compat.py`，81 例）

| 节 | 覆盖 | 例数 |
| --- | --- | --- |
| 一 | generated 四类 MIME 矩阵、缓存头、默认文件名、srt/Accept-Ranges、路由专属 4040 文案、未知前缀兜底 | 15 |
| 二 | mock SVG/WAV（V1/V2、确定性、未知音轨回落）、mock-assets 命中/缺失/结构不符 | 7 |
| 三 | 路径穿越全套（generated 9 例 + storage 12 例参数化 + 带签名穿越键 1 例 3 键） | 22 |
| 四 | Range：单区间/开区间/后缀/end 超界钳制/start 超界 416/end<start 416/非法头 200 全量（4 变体）/`bytes=-0` 怪癖/audio 区间/srt+frame+storage 忽略 Range/空文件 416 | 13 |
| 五 | /storage 本地：sidecar contentType、扩展名推断矩阵、含空格键（media_urls 契约互验）、对象缺失 4040、无签名 4010、伪造签名 7 变体 | 12 |
| 六 | COS：流式代理（Bucket/Key 断言）、对象缺失 4040、cos 模式强制验签 | 3 |
| 七 | flag=false 四路 501/5001（GET+POST）、默认开启、裸前缀兜底（5 变体）、HEAD/POST/PUT/DELETE 兜底、与 /api 代理作用域隔离 | 9 |

运行：`C:\Temp\pd-venvs\api\Scripts\python.exe -m pytest api-service\tests -q`
（全量 686 passed = 基线 605 + 本组 81。）
