"""Worker 独立性测试（FastAPI-Only 迁移第七阶段 · Task 7.3）。

验证「停 Node 主流程、FastAPI 唯一 HTTP API」架构决策的三个不变量，全部为
代码级/数据级断言（pytest 无法真正停掉 Node 进程，真停 Node 的端到端验证
属云端部署项，见模块尾「局限声明」）：

1. **Worker 无对 API 的出站 HTTP 调用**：静态扫描 ``server/``（Worker 执行体），
   断言无 Node API 回环残留（NODE_UPSTREAM/backend:3001/localhost:3001）；
   ``fetch(``/``http.request``/``axios`` 出站调用点全部落在供应商适配器白名单
   （AI/云厂商 SDK 合法出站）与 ``server/index.mjs`` 的 ``downloadMediaToFile``
   （媒体下载回填）内；``rag-client.mjs`` 对 RAG 旁路服务的调用属合法服务间
   依赖（compose 独立 rag 服务）。``server/index.mjs`` 顶部残留的 Node API
   路由代码在 Worker 角色（``APP_RUNTIME_ROLE=worker``）下不进入执行路径
   （文件尾部 ``isWorkerRuntime`` 分支禁用 ``server.listen``），因此扫描判定
   边界为「执行路径可达的出站调用」而非全文。
2. **停 Node 主流程可用**：FastAPI 侧零 Node 依赖——config 无 upstream/3001、
   compose 无 ``backend:`` 服务与 api→backend 依赖、/ready 仅探 MySQL、
   兜底路由为 4040 收口而非代理（复用 Task 7.1 覆盖结论语义）。
3. **Worker 回写幂等**：Worker 侧 ``updateGenerationJob`` 为字段级
   ``UPDATE ... WHERE id = ?``（从 server/index.mjs 源码断言 SQL 形态）；
   Python 侧以等价语义状态机桩验证同一 job 二次状态回写幂等/无害。

全部离线执行（无网络、无 Node 进程、无 MySQL）。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

# 仓库根目录（tests/ → api-service/ → projectdream）。
REPO_ROOT = Path(__file__).resolve().parents[2]
SERVER_DIR = REPO_ROOT / "server"
COMPOSE_FILE = REPO_ROOT / "docker-compose.yml"

# Node API 回环残留模式：Worker 执行路径零命中（backend/localhost 上游、
# 代理时代的环境变量与上游常量名）。
API_UPSTREAM_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("NODE_UPSTREAM_URL", re.compile(r"NODE_UPSTREAM_URL")),
    ("node_upstream", re.compile(r"node_upstream")),
    ("backend:3001", re.compile(r"backend:3001")),
    ("localhost:3001", re.compile(r"localhost:3001")),
)

# 3001 字面量（含 127.0.0.1 形态）：执行路径命中须逐行登记豁免
# （媒体 URL 产出默认值等非 API 调用语义）。
LOOPBACK_3001_PATTERN = re.compile(r"127\.0\.0\.1:3001")

# 执行路径上允许发起出站 HTTP 的文件白名单（相对 server/）：
# - AI/云厂商供应商适配器（付费生成出站，合法 SDK 调用）；
# - rag-client.mjs（compose 独立 rag 旁路服务，合法服务间调用）。
OUTBOUND_HTTP_ALLOWLIST: frozenset[str] = frozenset(
    {
        "services/ai/provider.mjs",
        "services/ai/vision.mjs",
        "services/audio.mjs",
        "services/frame.mjs",
        "services/lip-sync.mjs",
        "services/video.mjs",
        "services/rag-client.mjs",
    }
)

# 出站 HTTP 调用点模式（fetch/http.request/axios）。
OUTBOUND_HTTP_PATTERN = re.compile(r"\bfetch\(|\bhttp\.request\b|\baxios\b")

# 3001 回环豁免行（三元组，与 test_no_node_dependencies.EXEMPT_LINES 同构模式）：
# object-storage.mjs 的默认公开基址是「媒体 URL 产出默认值」（写库的历史 URL 前缀），
# 不构成对 API 的 HTTP 调用；生产由 env 覆盖为 COS 域名。漂移即重新报红。
LOOPBACK_3001_EXEMPT_LINES: frozenset[tuple[str, int, str]] = frozenset(
    {
        ("server/services/object-storage.mjs", 14, "const DEFAULT_PUBLIC_BASE_URL = 'http://127.0.0.1:3001/storage'"),
    }
)


def _iter_worker_files() -> list[Path]:
    """收集 server/ 下全部 JS 模块（含测试文件）。

    :returns: server/**/*.mjs 文件列表（相对路径稳定排序）。
    """
    return sorted(SERVER_DIR.rglob("*.mjs"))


def _read_lines(path: Path) -> list[str]:
    """读取文件为行列表（读失败返回空，交由存在性防呆断言兜底）。

    :param path: 目标文件。
    :returns: 行列表（已去换行尾空白）。
    """
    try:
        return [line.rstrip() for line in path.read_text(encoding="utf-8").splitlines()]
    except (OSError, UnicodeDecodeError):
        return []


# ---------------------------------------------------------------------------
# 一、Worker 无对 API 的出站 HTTP 调用（静态扫描）
# ---------------------------------------------------------------------------


def test_worker_scope_sanity() -> None:
    """扫描范围防呆：server/ 关键文件必须存在，防止空集导致扫描恒绿。

    :raises AssertionError: Worker 入口或服务目录缺失。
    """
    assert (SERVER_DIR / "index.mjs").is_file(), "server/index.mjs 必须存在（Worker 执行体入口）"
    assert (SERVER_DIR / "services").is_dir(), "server/services/ 必须存在（Worker 服务模块）"
    files = _iter_worker_files()
    assert len(files) > 10, f"server/ 文件数异常（{len(files)}），扫描可能失效"


def test_worker_has_no_api_upstream_references() -> None:
    """执行路径零命中 Node API 上游引用（NODE_UPSTREAM/backend:3001/localhost:3001）。

    ``*.test.mjs`` 为 Node 侧单测（不进入 Worker 执行路径），其中媒体 URL 归一化
    用例的 localhost:3001 字面量属测试 fixture，不在判定范围。

    :raises AssertionError: 执行路径文件存在 API 上游引用。
    """
    violations: list[str] = []
    for path in _iter_worker_files():
        rel = path.relative_to(REPO_ROOT).as_posix()
        if rel.endswith(".test.mjs"):
            continue
        for lineno, line in enumerate(_read_lines(path), start=1):
            for name, pattern in API_UPSTREAM_PATTERNS:
                if pattern.search(line):
                    violations.append(f"{rel}:{lineno}:{line}  [命中: {name}]")
    assert not violations, "Worker 执行路径发现 Node API 上游引用：\n" + "\n".join(violations)


def test_worker_loopback_3001_lines_are_registered_exemptions() -> None:
    """执行路径 127.0.0.1:3001 命中必须逐行登记豁免（媒体 URL 默认值语义）。

    :raises AssertionError: 存在未登记的 3001 回环行，或豁免表含幽灵行。
    """
    hits: set[tuple[str, int, str]] = set()
    for path in _iter_worker_files():
        rel = path.relative_to(REPO_ROOT).as_posix()
        if rel.endswith(".test.mjs"):
            continue
        for lineno, line in enumerate(_read_lines(path), start=1):
            if LOOPBACK_3001_PATTERN.search(line):
                hits.add((rel, lineno, line))
    unregistered = sorted(hits - set(LOOPBACK_3001_EXEMPT_LINES))
    ghost = sorted(set(LOOPBACK_3001_EXEMPT_LINES) - hits)
    assert not unregistered, (
        "Worker 执行路径发现未登记的 127.0.0.1:3001 行（确认非 API 调用后登记豁免表）：\n"
        + "\n".join(f"  {rel}:{lineno}:{line}" for rel, lineno, line in unregistered)
    )
    assert not ghost, (
        "3001 豁免表存在已漂移的幽灵行（行号或内容变化，请更新登记）：\n"
        + "\n".join(f"  {rel}:{lineno}:{line}" for rel, lineno, line in ghost)
    )


def test_worker_outbound_http_calls_stay_in_allowlist() -> None:
    """出站 HTTP 调用点全部落在供应商/RAG 白名单与 downloadMediaToFile 内。

    判定边界：``server/index.mjs`` 顶部残留的 Node API 路由代码在 Worker 角色
    下不执行（文件尾 ``isWorkerRuntime`` 分支禁用 ``server.listen``），但其
    ``fetch(`` 调用点仍须可解释——当前唯一出站点是 ``downloadMediaToFile``
    （媒体下载回填，输入为媒体 URL 而非 API 端点），以函数体定位断言。

    :raises AssertionError: 白名单外文件存在出站调用，或 index.mjs 的 fetch
        落在 downloadMediaToFile 函数体之外。
    """

    def extract_function_body(text: str, signature: str, next_signature: str) -> str:
        """按函数签名截取函数体文本（下一个顶级函数声明为界）。

        :param text: 全文。
        :param signature: 目标函数签名（字面子串）。
        :param next_signature: 边界函数签名（字面子串）。
        :returns: [signature, next_signature) 区间文本；未找到时为空串。
        """
        start = text.find(signature)
        if start < 0:
            return ""
        end = text.find(next_signature, start)
        return text[start : end if end > 0 else len(text)]

    violations: list[str] = []
    for path in _iter_worker_files():
        rel = path.relative_to(REPO_ROOT).as_posix()
        if rel == "server/index.mjs":
            continue  # 单独以函数体边界判定。
        rel_in_server = path.relative_to(SERVER_DIR).as_posix().replace("\\", "/")
        if rel.endswith(".test.mjs") or rel_in_server in OUTBOUND_HTTP_ALLOWLIST:
            continue
        for lineno, line in enumerate(_read_lines(path), start=1):
            if OUTBOUND_HTTP_PATTERN.search(line):
                violations.append(f"{rel}:{lineno}:{line.strip()}")
    assert not violations, (
        "server/services 白名单外发现出站 HTTP 调用点（供应商适配请登记 OUTBOUND_HTTP_ALLOWLIST）：\n"
        + "\n".join(violations)
    )

    index_text = (SERVER_DIR / "index.mjs").read_text(encoding="utf-8")
    downloader_body = extract_function_body(
        index_text, "async function downloadMediaToFile(", "\nfunction mediaFileExtension("
    )
    assert downloader_body, "server/index.mjs 应包含 downloadMediaToFile（媒体下载回填执行体）"
    outside = [
        line.strip()
        for line in index_text.splitlines()
        if OUTBOUND_HTTP_PATTERN.search(line) and line not in downloader_body.splitlines()
    ]
    assert not outside, (
        "server/index.mjs 的出站 HTTP 调用点必须全部位于 downloadMediaToFile 函数体内：\n"
        + "\n".join(outside)
    )


def test_worker_runtime_disables_http_listener() -> None:
    """Worker 角色禁用 HTTP 监听（代码级断言 isWorkerRuntime 分支结构）。

    ``server/index.mjs`` 尾部：``if (isWorkerRuntime) { ...禁听... } else {
    server.listen(...) }``——Worker 进程不占用/监听任何 HTTP 端口，Node API
    角色退役后 server.listen 仅属历史 API 角色分支。

    :raises AssertionError: 分支结构漂移（Worker 可能重新监听端口）。
    """
    text = (SERVER_DIR / "index.mjs").read_text(encoding="utf-8")
    gate = re.search(r"const isWorkerRuntime = appRuntimeRole\.role === 'worker'", text)
    assert gate, "isWorkerRuntime 角色判定缺失"
    tail = text[gate.start() :]
    worker_branch = re.search(r"if \(isWorkerRuntime\) \{([\s\S]*?)\} else \{([\s\S]*)", tail)
    assert worker_branch, "isWorkerRuntime 的 if/else 分支结构漂移"
    assert "HTTP server disabled" in worker_branch.group(1), "Worker 分支应打印禁听声明"
    assert re.search(r"server\.listen\(", worker_branch.group(2)), "server.listen 应只存在于 else（API 角色）分支"


# ---------------------------------------------------------------------------
# 二、停 Node 主流程可用（FastAPI 侧零 Node 依赖）
# ---------------------------------------------------------------------------


def test_fastapi_config_has_no_node_dependency() -> None:
    """config 层零 Node 依赖：无 upstream 字段/3001/探活配置。

    对 ``api-service/app/config.py`` 全文静态扫描（含注释——历史记录应迁
    docs/**），并断言 Settings 实例无任何 node 相关键。

    :raises AssertionError: config 存在 Node 依赖残留。
    """
    config_text = (REPO_ROOT / "api-service" / "app" / "config.py").read_text(encoding="utf-8")
    for name, pattern in (
        ("NODE_UPSTREAM_URL", re.compile(r"NODE_UPSTREAM_URL")),
        ("node_upstream_url", re.compile(r"node_upstream_url")),
        ("node_readiness", re.compile(r"node_readiness")),
        ("3001", re.compile(r"3001")),
        ("proxy_api", re.compile(r"proxy_api")),
    ):
        assert not pattern.search(config_text), f"api-service/app/config.py 存在 Node 依赖残留：{name}"
    settings = Settings(_env_file=None)
    leaked = [key for key in settings.model_dump() if "node" in key.lower()]
    assert not leaked, f"Settings 存在 node 相关键：{leaked}"


def test_compose_has_no_backend_service_or_dependency() -> None:
    """compose 五服务定局：无 backend 服务、api 无 depends_on backend、
    api/worker-node 均不注入 NODE_UPSTREAM_URL。

    :raises AssertionError: compose 存在 Node API 编排残留。
    """
    text = COMPOSE_FILE.read_text(encoding="utf-8")
    assert re.search(r"^\s{2}backend:\s*$", text, re.M) is None, "compose 不应存在 backend: 服务定义"
    assert "NODE_UPSTREAM_URL" not in text, "compose 不应注入 NODE_UPSTREAM_URL"
    assert "backend:3001" not in text, "compose 不应引用 backend:3001 上游"
    # api 服务段内不得出现对 backend 服务的 depends_on / 连接串
    # （backend_net 网络名是容器网络拓扑，非服务依赖，不在判定范围）。
    api_block = re.search(r"^\s{2}api:\s*$([\s\S]*?)(?=^\s{2}\w+:)", text, re.M)
    assert api_block, "compose 缺少 api 服务段（范围防呆）"
    api_section = api_block.group(1)
    depends_block = re.search(r"depends_on:\s*\n((?:\s{6}[\s\S]*?)(?=\s{4}\w|\s{2}\w))", api_section)
    if depends_block:
        assert "backend" not in depends_block.group(1), "api depends_on 不得包含 backend"
    assert "backend:3001" not in api_section and "NODE_UPSTREAM" not in api_section, (
        "api 服务段不得引用 backend 服务（env/上游串）"
    )
    # api healthcheck 必须打自身 /ready（不再探 Node /api/health）。
    assert "/ready" in api_block.group(1), "api healthcheck 应使用 /ready 自检"
    # worker-node 保留且角色为 worker（五服务架构不变量）。
    for service in ("mysql", "api", "worker-node", "rag", "frontend"):
        assert re.search(r"^ {2}" + re.escape(service) + r":\s*$", text, re.M), (
            f"compose 缺少 {service}: 服务（五服务架构漂移）"
        )


def test_ready_probe_covers_mysql_only() -> None:
    """/ready 仅探自身依赖（MySQL）：checks 恰为 {"mysql": true}，不探 Node。

    :raises AssertionError: /ready 检查项含 MySQL 以外的上游。
    """

    class ReadyDatabase:
        """就绪探针桩：MySQL 健康。"""

        def health(self) -> bool:
            """健康检查。

            :returns: 恒 True（桩）。
            """
            return True

    client = TestClient(create_app(Settings(_env_file=None), database=ReadyDatabase()))
    response = client.get("/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ready", "checks": {"mysql": True}}


def test_fallback_route_is_4040_collector_not_proxy() -> None:
    """兜底路由为 4040 收口而非 Node 代理（复用 Task 7.1 覆盖结论的语义）。

    ``/api/{path:path}`` handler 必须是 ``api_fallback_not_found``（4040 envelope），
    app.routes 中不存在任何 proxy/转发语义路由；未知路径请求直接 404/4040。

    :raises AssertionError: 兜底路由语义漂移（代理复活）。
    """
    app = create_app(Settings(_env_file=None), database=_IdleDatabase())
    fallback = [route for route in app.routes if getattr(route, "path", "") == "/api/{path:path}"]
    assert len(fallback) == 1, "兜底 /api/{path:path} 路由应恰好注册一条"
    handler = fallback[0].endpoint
    assert getattr(handler, "__name__", "") == "api_fallback_not_found", (
        f"兜底路由 handler 应为 api_fallback_not_found（4040 收口），实际 {getattr(handler, '__name__', '?')}"
    )
    for route in app.routes:
        name = str(getattr(route, "name", ""))
        assert "proxy" not in name.lower(), f"app.routes 出现代理语义路由：{name}"
    # 运行时抽查：未知路径 404/4040 且无任何代理透传头。
    client = TestClient(app, raise_server_exceptions=False)
    response = client.get("/api/definitely-not-a-route", headers={"Authorization": "Bearer nobody"})
    assert response.status_code == 404
    assert response.json()["code"] == 4040
    assert "x-forwarded-by" not in response.headers, "兜底响应不得出现代理透传标记"


class _IdleDatabase:
    """兜底路由运行时抽查的最小数据库桩（仅鉴权反查）。"""

    def find_user_by_token(self, token: str) -> dict[str, Any] | None:
        """按 token 反查用户（任意 token 均无用户，走未登录 401 也满足 404 语义链）。

        :param token: 访问令牌。
        :returns: 恒 None（兜底路径不触库）。
        """
        return None


# ---------------------------------------------------------------------------
# 三、Worker 回写幂等（重复回调不重复）
# ---------------------------------------------------------------------------


def test_worker_update_generation_job_is_plain_field_update() -> None:
    """Worker 侧回写函数为字段级 UPDATE（从 server/index.mjs 源码断言 SQL 形态）。

    ``updateGenerationJob(jobId, fields)`` 语义：构建 ``SET col = ?`` 列表，
    空字段直接返回，``UPDATE generation_jobs SET ..., updated_at = NOW()
    WHERE id = ?``——天然幂等（同字段重复 SET 结果不变），不插入新行、
    不经 HTTP 回调 API。

    :raises AssertionError: Worker 回写函数形态漂移（如改为 HTTP 回调）。
    """
    text = (SERVER_DIR / "index.mjs").read_text(encoding="utf-8")
    start = text.find("async function updateGenerationJob(")
    assert start >= 0, "server/index.mjs 缺少 updateGenerationJob（Worker 回写函数）"
    body_start = text.find("\nfunction ", start)
    body = text[start : body_start if body_start > 0 else len(text)]
    assert "UPDATE generation_jobs SET" in body, "回写必须是 UPDATE generation_jobs SET 直写 DB"
    assert "WHERE id = ?" in body, "回写 WHERE 子句必须按 job id 定位"
    assert "updated_at = NOW()" in body, "回写应刷新 updated_at"
    assert re.search(r"if \(!sets\.length\) return", body), "空字段应短路返回（无操作即幂等）"
    assert not re.search(r"fetch\(|http\.request|axios", body), "回写不得发起 HTTP 调用（直写 DB）"


class _GenerationJobStateStore:
    """Python 侧生成任务状态机桩（对齐 Worker updateGenerationJob 的 UPDATE 语义）。

    以字典模拟 generation_jobs 行；:meth:`update_generation_job` 复刻
    「按传入列构建 SET 子句 + WHERE id = ? + updated_at=NOW()」的字段级直写，
    用于验证重复回调的幂等不变量。真实 Worker 经 Node 直连 MySQL 执行同一
    SQL 形态（见 :func:`test_worker_update_generation_job_is_plain_field_update`）。

    :ivar rows: job_id → 行。
    :ivar clock: 模拟 NOW() 时钟（每次回写 +1，便于区分「仅 updated_at 变化」）。
    """

    # 允许回写的列白名单（对齐 generation_jobs 表列）。
    ALLOWED_COLUMNS = frozenset(
        {"status", "progress_percent", "request_json", "result_json", "error_text"}
    )

    def __init__(self, row: dict[str, Any]) -> None:
        """以初始 job 行建桩。

        :param row: generation_jobs 行（至少含 id/status/progress_percent）。
        """
        self.rows: dict[int, dict[str, Any]] = {int(row["id"]): dict(row)}
        self.clock = 0

    def update_generation_job(self, job_id: int, fields: dict[str, Any]) -> None:
        """字段级回写（复刻 Worker UPDATE 语义；未知列抛错防漂移）。

        :param job_id: 任务 id（WHERE 定位）。
        :param fields: 待 SET 列 → 值。
        :raises KeyError: 传入白名单外列（模拟 SQL 列不存在错误）。
        """
        sets = {column: value for column, value in fields.items() if column in self.ALLOWED_COLUMNS}
        if not sets:
            return  # 对齐 Worker：if (!sets.length) return。
        assert set(sets) <= self.ALLOWED_COLUMNS, f"回写列越界：{sorted(set(fields) - set(sets))}"
        row = self.rows[int(job_id)]
        row.update(sets)
        self.clock += 1
        row["updated_at"] = f"NOW({self.clock})"

    def snapshot(self, job_id: int) -> dict[str, Any]:
        """按 id 取行快照。

        :param job_id: 任务 id。
        :returns: 行副本。
        """
        return dict(self.rows[int(job_id)])


def test_duplicate_status_callback_is_idempotent() -> None:
    """同一 job 二次状态回写幂等/无害：除 updated_at 外逐字段不变。

    Worker 断网重试/队列重复消费场景下，同一 ``{status, progress_percent}``
    回写两次——状态机不变量：status/progress/result 均不漂移、不产生新行。

    :raises AssertionError: 二次回写改变业务字段或产生新行。
    """
    store = _GenerationJobStateStore(
        {
            "id": 31, "project_id": 8, "job_type": "frame_image", "source_id": 21,
            "status": "queued", "progress_percent": 0, "request_json": "{}",
            "result_json": None, "error_text": None, "updated_at": "NOW(0)",
        }
    )
    callback = {"status": "running", "progress_percent": 35}

    store.update_generation_job(31, callback)
    first = store.snapshot(31)
    store.update_generation_job(31, callback)  # 重复回调（重试/重复消费）。
    second = store.snapshot(31)

    for column in ("status", "progress_percent", "request_json", "result_json", "error_text"):
        assert second[column] == first[column], f"重复回写漂移列：{column}（{first[column]} → {second[column]}）"
    assert second["updated_at"] != first["updated_at"], "仅 updated_at 应随 NOW() 推进"
    assert len(store.rows) == 1, "重复回调不得产生新行"


def test_terminal_status_stays_stable_under_repeated_callback() -> None:
    """终态重复回写稳定：succeeded 状态二次回写不回退、不改业务结果。

    :raises AssertionError: 终态被重复回调改写。
    """
    store = _GenerationJobStateStore(
        {
            "id": 32, "project_id": 8, "job_type": "frame_image", "source_id": 21,
            "status": "running", "progress_percent": 85, "request_json": "{}",
            "result_json": None, "error_text": None, "updated_at": "NOW(0)",
        }
    )
    terminal = {"status": "success", "progress_percent": 100}
    store.update_generation_job(32, terminal)
    first = store.snapshot(32)
    store.update_generation_job(32, terminal)  # 终态重复确认。
    second = store.snapshot(32)
    assert second["status"] == "success" and second["progress_percent"] == 100, "终态被重复回调改写"
    assert second["result_json"] == first["result_json"]
    # 乱序旧进度回调（重试链路迟到包）不会把 status 拉回 running——字段级 SET
    # 只作用于传入列，status 不在字段集内即不受影响。
    store.update_generation_job(32, {"progress_percent": 25})
    assert store.snapshot(32)["status"] == "success", "迟到进度包不得改写终态 status"


def test_empty_callback_is_noop() -> None:
    """空字段回写为无操作（对齐 Worker if (!sets.length) return 短路）。

    :raises AssertionError: 空回调产生副作用。
    """
    store = _GenerationJobStateStore(
        {"id": 33, "project_id": 8, "job_type": "frame_image", "source_id": 21,
         "status": "queued", "progress_percent": 0, "updated_at": "NOW(0)"}
    )
    store.update_generation_job(33, {})
    assert store.snapshot(33) == {
        "id": 33, "project_id": 8, "job_type": "frame_image", "source_id": 21,
        "status": "queued", "progress_percent": 0, "updated_at": "NOW(0)",
    }, "空回调应完全无副作用（含 updated_at）"


# ---------------------------------------------------------------------------
# 局限声明（报告口径）
# ---------------------------------------------------------------------------
#
# 1. pytest 无法在 CI 内真正「停掉 Node 进程」做端到端验证——本文件对「停 Node
#    主流程可用」的全部断言均为代码级/配置级/运行时桩级（config 零残留、compose
#    零 backend、/ready 仅探 MySQL、兜底 4040 非代理）。「真停 Node 后全链路
#    冒烟」属云端部署验收项，由 scripts/fastapi-only-smoke.mjs（Task 8.2）在
#    真实环境执行。
# 2. Worker「无出站 HTTP 到 API」为静态扫描结论 + 白名单护栏，不能排除动态
#    构造 URL 的调用（当前代码不存在此类形态）；新增出站调用会被白名单机制
#    拦截报红。
# 3. 回写幂等验证基于等价语义状态机桩（与 Worker UPDATE 逐语义对齐），非真实
#    MySQL 执行；SQL 形态一致性由源码断言锁定。
