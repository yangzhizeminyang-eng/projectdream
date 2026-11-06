"""Node 依赖静态扫描测试（FastAPI-Only 迁移第四阶段守卫）。

对源码文本逐行正则扫描，断言 Node 代理时代的产物（``NODE_UPSTREAM_URL``、
``API_NATIVE_*`` flag、``proxy_api``、上游 3001 地址、fake upstream 域名等）
在强制范围内零命中——代码或注释中出现即红灯，防止代理链路复活。

范围与语义（与第四阶段任务书一致）：

- **强制零命中**：``api-service/app/**/*.py``、``api-service/tests/**/*.py``、
  ``.env.example``、``api-service/requirements.txt``、``src/**/*.{ts,vue,js}``
  与 ``scripts/*.mjs``（延迟范围已在第六阶段清理收口：脚本默认上游切换
  FastAPI 8000，命中即红灯，与强制范围同语义）；
- **排除**：``api-service/tests/fixtures/*.mjs``（fixture 生成脚本 import Node
  真实实现，是对照验收工具，允许保留）；``api-service/docs/**``、``docs/**``
  （文档中的历史引用允许）；
- **豁免行**：``EXEMPT_LINES`` 显式登记两类行：纯文档注释行（复刻代码对照
  Node 权威源行号的引用）与 Worker 保留边界文件（``scripts/run-worker.mjs``、
  ``scripts/worker-healthcheck.mjs`` 及其测试）对 ``server/index.mjs`` 的进程内
  引用（compose 第六阶段后 Worker 仍由该模块承载任务执行，非 HTTP API 依赖）。
  按「相对路径:行号:行内容」三元组精确匹配——内容或行号漂移即
  重新报红，提示重新评估豁免是否仍必要。其余 11 个禁用模式（``NODE_UPSTREAM_URL`` 等）不接受任何豁免。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Iterator

import pytest

# 仓库根目录（tests/ → api-service/ → projectdream）。
REPO_ROOT = Path(__file__).resolve().parents[2]

# 禁用模式（正则）：Node 代理时代的代码/配置/测试产物。
# 命中即视为 Node 依赖残留（含注释——历史记录请迁移到 docs/**）。
BANNED_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("NODE_UPSTREAM_URL", re.compile(r"NODE_UPSTREAM_URL")),
    ("node_upstream_url", re.compile(r"node_upstream_url")),
    ("node_readiness", re.compile(r"node_readiness")),
    ("proxy_timeout_seconds", re.compile(r"proxy_timeout_seconds")),
    ("API_NATIVE_", re.compile(r"API_NATIVE_")),
    ("proxy_api", re.compile(r"proxy_api")),
    ("proxy_pass http://backend:3001", re.compile(r"proxy_pass http://backend:3001")),
    ("backend:3001", re.compile(r"backend:3001")),
    ("localhost:3001", re.compile(r"localhost:3001")),
    ("127.0.0.1:3001", re.compile(r"127\.0\.0\.1:3001")),
    ("node.invalid（fake upstream 域名）", re.compile(r"node\.invalid")),
    ("server/index.mjs（生产链路引用）", re.compile(r"server/index\.mjs")),
)

# 白名单豁免行：{("相对路径(正斜杠)", 行号, "行内容")}。仅限两类：纯文档注释
# （复刻实现对照 Node 权威源行号的引用）与 Worker 保留边界代码行（run-worker /
# worker-healthcheck 加载、识别 server/index.mjs 执行体，非 HTTP API 依赖）；
# 新增豁免须在本表登记并在阶段报告中列明理由。三元组精确匹配：注释内容或
# 行号漂移即失效重报。
EXEMPT_LINES: frozenset[tuple[str, int, str]] = frozenset(
    {
        # ---- Worker 保留边界（server/index.mjs 仍为 Worker 执行体入口）----
        ("scripts/run-worker.mjs", 5, "await import('../server/index.mjs')"),
        ("scripts/worker-healthcheck.mjs", 15, "      return commandLine.includes('server/index.mjs')"),
        ("scripts/worker-healthcheck.test.mjs", 5, "function createFs({ cmdline = 'node\\u0000server/index.mjs\\u0000', failPidRead = false } = {}) {"),
        ("scripts/worker-healthcheck.test.mjs", 26, "      fs: createFs({ cmdline: 'node\\u0000server/index.mjs\\u0000', failPidRead: true }),"),
        # ---- server/index.mjs 注释引用（Node 权威源行号对照，文档性质）----
        ("api-service/app/media_service.py", 4, "``/mock-assets/``），逐条对照 Node 实现（``server/index.mjs`` L11979-L12216 与"),
        ("api-service/app/media_service.py", 10, "  **与 Node 的差异（有意收紧）**：Node 裸读任意 key（``server/index.mjs`` L12926"),
        ("api-service/app/auth_captcha.py", 4, "``server/index.mjs`` L12268-L12292 的路由行为。与 Node 的差异：会话状态不使用"),
        ("api-service/app/sms/mock.py", 3, "对齐 Node ``sendVerificationCode`` mock 分支（server/index.mjs L6366-L6375）："),
        ("api-service/app/sms/provider.py", 3, "对齐 Node ``server/index.mjs`` 的 ``sendVerificationCode`` 返回形状："),
        ("api-service/app/sms/tencent.py", 3, "对齐 Node ``sendVerificationCode`` 的 tencent 分支（server/index.mjs L6428-L6451）："),
        ("api-service/app/domain/storyboard_ai.py", 8, "- ``server/index.mjs`` 内的 frameRole/子分镜/对白拆分/两帧兜底函数；"),
        ("api-service/app/domain/video_generation.py", 23, "- ``server/index.mjs``（内部函数，fixture 不可直调）：buildTwoKeyframeVideoPrompt /"),
        ("api-service/tests/test_media_service_compat.py", 5, "``server/index.mjs`` L11979-L12216（generated/mock/mock-assets）、L12926-L12946"),
        ("api-service/tests/test_generation_native_compat.py", 11, "  ``resolveReferenceAudioUrl`` 三个函数实现在 ``server/index.mjs`` 内部，"),
        ("api-service/tests/test_auth_extended_compat.py", 5, "Node 权威源：``server/index.mjs`` L12268-L12482 + ``server/services/auth-captcha.mjs``。"),
    }
)

# 延迟范围（第六阶段清理）：src 前端、顶层 scripts 脚本与根级 vite.config.ts
# （dev server 代理目标也属前端→Node 链路，纳入防回退）。
DEFERRED_GLOBS: tuple[str, ...] = (
    "src/**/*.ts",
    "src/**/*.vue",
    "src/**/*.js",
    "scripts/*.mjs",
    "vite.config.ts",
)
# 延迟范围内仍排除的目录（构建产物/依赖，防御性排除）。
DEFERRED_EXCLUDED_PARTS = {"node_modules", "dist", ".codex-runtime"}


def _iter_forced_files() -> Iterator[Path]:
    """产出强制零命中范围的文件集合。

    守卫扫描器自引用文件（``SCANNER_SELF_FILES``：本测试与
    ``test_worker_independence.py``）被排除——其模式定义/断言文本必然提及
    禁用词，属自引用而非 Node 依赖残留。该排除集与
    ``scripts/assert-fastapi-only.mjs`` 的 ``SCANNER_SELF_FILES`` 保持同一份
    语义，任一侧新增守卫文件须两边同步。

    :returns: 迭代器，逐个返回待扫描文件的绝对路径。
    """
    scanner_self_files = {
        Path(__file__).resolve(),
        (REPO_ROOT / "api-service" / "tests" / "test_worker_independence.py").resolve(),
    }
    yield REPO_ROOT / ".env.example"
    yield REPO_ROOT / "api-service" / "requirements.txt"
    for sub in ("app", "tests"):
        for path in sorted((REPO_ROOT / "api-service" / sub).rglob("*.py")):
            if path.resolve() in scanner_self_files:
                continue
            yield path


def _iter_deferred_files() -> Iterator[Path]:
    """产出延迟范围（src/scripts，第六阶段清理）的文件集合。

    守卫扫描器自引用文件（:func:`_iter_forced_files` 的 ``SCANNER_SELF_FILES``，
    含 scripts/assert-fastapi-only.mjs）一并排除。

    :returns: 迭代器，逐个返回待扫描文件的绝对路径；排除 node_modules/dist。
    """
    scanner_self_files = {
        Path(__file__).resolve(),
        (REPO_ROOT / "api-service" / "tests" / "test_worker_independence.py").resolve(),
        (REPO_ROOT / "scripts" / "assert-fastapi-only.mjs").resolve(),
        (REPO_ROOT / "scripts" / "assert-fastapi-only.test.mjs").resolve(),
    }
    for pattern in DEFERRED_GLOBS:
        for path in sorted(REPO_ROOT.glob(pattern)):
            if DEFERRED_EXCLUDED_PARTS.intersection(path.parts):
                continue
            if path.resolve() in scanner_self_files:
                continue
            yield path


def _scan_line(line: str) -> set[str]:
    """检测单行命中的禁用模式名。

    :param line: 文件中的一行文本（含换行符，已 rstrip）。
    :returns: 该行命中的模式名集合；未命中返回空集。
    """
    return {name for name, pattern in BANNED_PATTERNS if pattern.search(line)}


def _scan_files(files: list[Path]) -> list[tuple[Path, int, str, set[str]]]:
    """逐文件逐行扫描禁用模式（自动应用白名单豁免）。

    :param files: 待扫描文件列表。
    :returns: 命中记录列表，每项为 (文件, 行号, 行内容, 命中模式名集合)。
    """
    hits: list[tuple[Path, int, str, set[str]]] = []
    for path in files:
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        rel = path.relative_to(REPO_ROOT).as_posix()
        for lineno, line in enumerate(text.splitlines(), start=1):
            matched = _scan_line(line.rstrip())
            if not matched:
                continue
            if (rel, lineno, line.rstrip()) in EXEMPT_LINES:
                continue
            hits.append((path, lineno, line.rstrip(), matched))
    return hits


def test_forced_scope_is_node_free() -> None:
    """强制范围（app/tests/.env.example/requirements.txt）禁用模式零命中。

    :raises AssertionError: 存在命中时失败，逐条输出 ``文件:行号:内容``（供修复定位）。
    """
    files = list(_iter_forced_files())
    # 防呆：关键范围文件必须存在，避免空集导致扫描恒绿。
    assert (REPO_ROOT / ".env.example").is_file(), ".env.example 必须存在（范围防呆）"
    assert (REPO_ROOT / "api-service" / "app" / "main.py").is_file(), "app/main.py 必须存在（范围防呆）"
    assert len(files) > 20, f"强制范围文件数异常（{len(files)}），扫描可能失效"
    hits = _scan_files(files)
    if hits:
        detail = "\n".join(
            f"{h[0].relative_to(REPO_ROOT).as_posix()}:{h[1]}:{h[2]}  [命中: {', '.join(sorted(h[3]))}]"
            for h in hits
        )
        pytest.fail(f"强制范围发现 Node 依赖残留 {len(hits)} 行（修复或登记 EXEMPT_LINES）：\n{detail}")


def test_deferred_scope_is_node_free() -> None:
    """延迟范围（src/scripts）强制零命中（第六阶段清理已收口）。

    scripts/*.mjs 默认上游已切换 FastAPI 8000；Worker 保留边界文件
    （``scripts/run-worker.mjs``、``scripts/worker-healthcheck.mjs`` 及其测试）
    对 ``server/index.mjs`` 的进程内引用经 ``EXEMPT_LINES`` 精确豁免，
    内容或行号漂移即重新报红。

    :raises AssertionError: 延迟范围文件集为空（扫描失效防呆）。
    :raises pytest.fail.Exception: 存在未豁免命中时失败，逐条输出
        ``文件:行号:内容``（供修复定位）。
    """
    files = list(_iter_deferred_files())
    assert files, "src/scripts 范围为空，延迟扫描可能失效"
    hits = _scan_files(files)
    if hits:
        detail = "\n".join(
            f"{h[0].relative_to(REPO_ROOT).as_posix()}:{h[1]}:{h[2]}  [命中: {', '.join(sorted(h[3]))}]"
            for h in hits
        )
        pytest.fail(f"延迟范围发现 Node 依赖残留 {len(hits)} 行（修复或登记 EXEMPT_LINES）：\n{detail}")
