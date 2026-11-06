"""项目组 / 资产组已接管路由的兼容测试（阶段 7.2）。

对照规格：``api-service/docs/project-asset-group-spec.md``。只补 ``test_contracts.py``
未覆盖的缺口：七类场景（未登录、字段非法、数据不存在、空数据/边界、异常依赖、
重复写入、状态码与 envelope 形状）+ 7.2 四项修复点回归（aspectRatio 语义、PATCH
错误优先级、空数据 message、非法资产类型 4040）+ 分组 flag 回退专项 + 同 fixture
双侧对照。全部离线执行（fake database / httpx.MockTransport）。
"""

import json

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import Settings
from app.main import create_app

AUTH = {"Authorization": "Bearer session-token"}


class GroupDatabase:
    """项目组/资产组兼容测试的最小数据库桩。

    :ivar projects: 项目行列表（user_id 归属判定）。
    :ivar outlines/story_bibles/season_structures: 项目 id -> 记录行列表（取最新版本）。
    :ivar assets: (asset_type, asset_id) -> 资产行（归档保护语义）。
    :ivar fail_on_read: 置 True 时读取类方法抛异常，模拟数据库故障。
    """

    def __init__(self):
        self.projects = [{"id": 8, "user_id": 7, "name": "悬疑短剧", "status": "draft"}]
        self.outlines = {}
        self.story_bibles = {}
        self.season_structures = {}
        self.project_asset_rows = {}
        self.assets = {}
        self.fail_on_read = False

    # -- 通用鉴权 ----------------------------------------------------------

    def find_user_by_token(self, token):
        """按 token 反查用户（require_user 鉴权入口）。

        :param token: 访问令牌。
        :return: 命中时返回用户 dict，否则 None。
        """
        if token == "session-token":
            return {"id": 7, "phone": "13912345678", "nickname": "测试用户"}
        return None

    def _project_of(self, project_id, user_id):
        """校验项目归属；故障注入时抛 RuntimeError。

        :param project_id: 项目 id。
        :param user_id: 用户 id。
        :return: 命中的项目行；不存在或非本人返回 None。
        :raises RuntimeError: fail_on_read 为 True 时模拟数据库离线。
        """
        if self.fail_on_read:
            raise RuntimeError("database offline")
        return next(
            (project for project in self.projects if project["id"] == project_id and project["user_id"] == user_id),
            None,
        )

    # -- 项目组 ------------------------------------------------------------

    def list_projects(self, user_id):
        """列出用户项目（含聚合列时 project_row 输出 progress 字段）。

        :param user_id: 用户 id。
        :return: 该用户的项目行列表。
        :raises RuntimeError: 故障注入时抛出。
        """
        if self.fail_on_read:
            raise RuntimeError("database offline")
        return [project for project in self.projects if project["user_id"] == user_id]

    def create_project(self, user_id, payload):
        """创建项目（Node 语义：重名不拦截，各自独立成行）。

        :param user_id: 用户 id。
        :param payload: 含 name 的请求体。
        :return: 新建的项目行。
        """
        project = {
            "id": max((project["id"] for project in self.projects), default=0) + 1,
            "user_id": user_id,
            "name": payload["name"],
            "category": payload.get("category"),
            "aspect_ratio": payload.get("aspectRatio"),
            "status": "draft",
        }
        self.projects.append(project)
        return project

    def get_project(self, project_id, user_id):
        """按 id + 归属读取单项目（原始行，无聚合列）。

        :param project_id: 项目 id。
        :param user_id: 用户 id。
        :return: 命中的项目行或 None。
        """
        return self._project_of(project_id, user_id)

    def update_project(self, project_id, user_id, updates):
        """按字段更新项目并返回更新后的原始行。

        :param project_id: 项目 id。
        :param user_id: 用户 id。
        :param updates: 字段 -> 新值。
        :return: 更新后的项目行；项目不存在返回 None。
        """
        project = self._project_of(project_id, user_id)
        if project is None:
            return None
        project.update(updates)
        return project

    def latest_outline(self, project_id, user_id):
        """读取最新总纲（outcome 语义与 MySQLDatabase 对齐）。

        :param project_id: 项目 id。
        :param user_id: 用户 id。
        :return: {"outcome": ..., "outline": row|None}。
        """
        if self._project_of(project_id, user_id) is None:
            return {"outcome": "not_found", "outline": None}
        rows = sorted(self.outlines.get(project_id, []), key=lambda row: (row.get("version_no") or 0, row["id"]), reverse=True)
        return {"outcome": "found", "outline": rows[0] if rows else None}

    def latest_story_bible(self, project_id, user_id):
        """读取最新故事设定（outcome 语义与 MySQLDatabase 对齐）。

        :param project_id: 项目 id。
        :param user_id: 用户 id。
        :return: {"outcome": ..., "item": row|None}。
        """
        if self._project_of(project_id, user_id) is None:
            return {"outcome": "not_found", "item": None}
        rows = sorted(self.story_bibles.get(project_id, []), key=lambda row: (row.get("version_no") or 0, row["id"]), reverse=True)
        return {"outcome": "found", "item": rows[0] if rows else None}

    def latest_season_structure(self, project_id, user_id):
        """读取最新分集结构（outcome 语义与 MySQLDatabase 对齐）。

        :param project_id: 项目 id。
        :param user_id: 用户 id。
        :return: {"outcome": ..., "item": row|None}。
        """
        if self._project_of(project_id, user_id) is None:
            return {"outcome": "not_found", "item": None}
        rows = sorted(self.season_structures.get(project_id, []), key=lambda row: (row.get("version_no") or 0, row["id"]), reverse=True)
        return {"outcome": "found", "item": rows[0] if rows else None}

    # -- 资产组 ------------------------------------------------------------

    def project_assets(self, project_id, user_id):
        """读取项目资产聚合（形状对齐 MySQLDatabase.project_assets）。

        :param project_id: 项目 id。
        :param user_id: 用户 id。
        :return: 四类资产分组 dict；项目不存在返回 None。
        """
        if self._project_of(project_id, user_id) is None:
            return None
        return self.project_asset_rows.get(project_id, {"characters": [], "images": [], "videos": [], "audios": []})

    def archive_project_asset(self, asset_type, asset_id, user_id):
        """归档项目资产（保留 previous_status 供路由层做保护语义判定）。

        :param asset_type: 资产类型（character/image/video/audio）。
        :param asset_id: 资产 id。
        :param user_id: 用户 id。
        :return: {"id", "status", "previous_status"}；不存在或非本人返回 None。
        """
        if self.fail_on_read:
            raise RuntimeError("database offline")
        asset = self.assets.get((asset_type, asset_id))
        if not asset or asset["user_id"] != user_id:
            return None
        previous_status = asset["status"]
        if previous_status not in {"archived", "confirmed", "finalized", "done"}:
            asset["status"] = "archived"
        return {"id": asset_id, "status": asset["status"], "previous_status": previous_status}


def make_client(database=None, **settings_kwargs):
    """构建原生模式测试客户端（upstream 指向不可达地址，触达即失败）。

    :param database: 注入的数据库桩；缺省使用 GroupDatabase()。
    :param settings_kwargs: 透传给 Settings 的额外配置。
    :return: 配置完成的 TestClient。
    """
    settings = Settings(
        _env_file=None,
        **settings_kwargs,
    )
    # raise_server_exceptions=False：未处理异常走网关 500 envelope handler。
    return TestClient(create_app(settings, database=database or GroupDatabase()), raise_server_exceptions=False)


def _raising_upstream_handler(request):
    """MockTransport 处理函数：模拟 Node upstream 网络不可达。

    :param request: fake upstream 收到的 httpx.Request。
    :return: 无返回，恒抛 httpx.ConnectError。
    :raises httpx.ConnectError: 恒抛出。
    """
    raise httpx.ConnectError("connection refused", request=request)


# ---------------------------------------------------------------------------
# 7.2 修复点回归
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("ratio", "expect_ok"),
    [
        ("16:9", True),
        ("16:10", True),  # Node canvasFromRatioLabel 接受任意 W:H（7.2 前固定白名单误拒）
        ("2.39:1", True),
        ("1.85:1", True),
        ("3/2", True),  # 斜杠分隔同样可解析
        ("16：10", True),  # 全角冒号
        ("16 : 9", True),  # 分隔符两侧空白
        ("自适应", True),  # 业务特殊标签
        ("auto", True),
        ("abc", False),
        ("0:9", False),  # Node 要求两侧均 > 0
        ("16:0", False),
        ("０.５:1", False),  # 全角数字：JS \d 仅 ASCII，Python re.ASCII 对齐
        (":16", False),
        ("16:", False),
    ],
)
def test_patch_aspect_ratio_matches_node_canvas_resolution(ratio, expect_ok):
    """PATCH aspectRatio：任意 W:H/W：H/W/H（正数、支持小数）+ 特殊标签均可解析，与 Node 对齐。

    :param ratio: 比例标签（参数化用例）。
    :param expect_ok: True 期望 200，False 期望 400/4001。
    :return: None。
    """
    response = make_client().patch("/api/projects/8", headers=AUTH, json={"aspectRatio": ratio})

    if expect_ok:
        assert response.status_code == 200
        assert response.json()["data"]["aspectRatio"] == ratio
        return
    assert response.status_code == 400
    assert response.json() == {
        "code": 4001,
        "message": f"画面比例「{ratio}」无法解析，请使用 16:9、9:16、2.39:1 这类格式",
        "data": None,
    }


def test_patch_returns_first_error_in_node_field_order():
    """PATCH 校验错误优先级：多字段同时非法时按 Node 固定顺序（name→category→…）返回第一个。

    :return: None。
    """
    client = make_client()

    name_first = client.patch(
        "/api/projects/8",
        headers=AUTH,
        json={"name": " ", "category": "x" * 81, "aspectRatio": "zzz"},
    )
    category_second = client.patch(
        "/api/projects/8",
        headers=AUTH,
        json={"category": "x" * 81, "aspectRatio": "zzz"},
    )

    assert name_first.status_code == 400
    assert name_first.json()["message"] == "项目名不能为空"
    assert category_second.status_code == 400
    assert category_second.json()["message"] == "作品类型不能超过 80 个字"


@pytest.mark.parametrize(
    "path",
    ["/api/projects/8/outline", "/api/projects/8/story-bible", "/api/projects/8/season-structure"],
)
def test_null_latest_content_uses_node_default_success_message(path):
    """空数据 envelope：message 为 Node success() 默认值 "success"（7.2 前误写 "ok"）。

    :param path: 被测只读路由（参数化：outline/story-bible/season-structure）。
    :return: None。
    """
    response = make_client().get(path, headers=AUTH)

    assert response.status_code == 200
    assert response.json() == {"code": 0, "message": "success", "data": None}


@pytest.mark.parametrize(
    ("asset_type", "status_code", "code"),
    [
        ("plot", 404, 4040),  # 未知类型：Node URL 正则不匹配 → 404/4040（7.2 前误 400/4001）
        ("CHARACTER", 404, 4040),  # 大小写敏感：Node 正则只认小写
        ("character", 200, 0),  # 小写合法类型照常归档
    ],
)
def test_archive_asset_type_is_case_sensitive_like_node(asset_type, status_code, code):
    """资产归档类型校验：与 Node URL 正则对齐（精确小写，未知/大写 → 404/4040）。

    :param asset_type: URL 中的资产类型原串。
    :param status_code: 期望 HTTP 状态码。
    :param code: 期望 envelope code。
    :return: None。
    """
    database = GroupDatabase()
    database.assets[("character", 5)] = {"id": 5, "user_id": 7, "status": "draft"}
    response = make_client(database).post(f"/api/project-assets/{asset_type}/5/archive", headers=AUTH)

    assert response.status_code == status_code
    assert response.json()["code"] == code
    if code == 0:
        assert response.json() == {
            "code": 0,
            "message": "项目资产已归档",
            "data": {"id": 5, "assetType": "character", "status": "archived"},
        }


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/api/projects"),
        ("post", "/api/projects"),
        ("get", "/api/projects/8"),
        ("patch", "/api/projects/8"),
        ("get", "/api/projects/8/assets"),
        ("get", "/api/projects/8/audio"),
        ("get", "/api/projects/8/outline"),
        ("get", "/api/projects/8/story-bible"),
        ("get", "/api/projects/8/season-structure"),
        ("get", "/api/projects/8/tasks"),
        ("get", "/api/projects/8/scenes"),
        ("get", "/api/scenes/11"),
        ("put", "/api/scenes/11"),
        ("put", "/api/scenes/11/script"),
        ("get", "/api/scenes/11/storyboards"),
        ("get", "/api/storyboards/21"),
        ("put", "/api/storyboards/21"),
        ("post", "/api/storyboards/reorder"),
        ("post", "/api/project-assets/character/5/archive"),
        ("post", "/api/audio-assets/5/confirm"),
        ("post", "/api/audio-assets/5/archive"),
        ("put", "/api/audio-assets/5"),
        ("post", "/api/images/5/confirm"),
        ("get", "/api/shots/21/images"),
    ],
)
def test_group_routes_require_authentication(method, path):
    """未登录：项目组/资产组路由统一 401/4010 envelope。

    :param method: HTTP 方法。
    :param path: 被测路由。
    :return: None。
    """
    client = make_client()
    kwargs = {"json": {}} if method in {"post", "patch", "put"} else {}

    response = getattr(client, method)(path, **kwargs)

    assert response.status_code == 401
    assert response.json() == {"code": 4010, "message": "未登录或登录已过期", "data": None}


# ---------------------------------------------------------------------------
# 场景二：字段缺失 / 非法
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("payload", [{}, {"name": "   "}, {"category": "悬疑"}])
def test_create_project_rejects_missing_name(payload):
    """POST /api/projects：name 缺失或空白 → 400/4001（Node L12565 同语义）。

    :param payload: 请求 JSON 体（参数化用例）。
    :return: None。
    """
    response = make_client().post("/api/projects", headers=AUTH, json=payload)

    assert response.status_code == 400
    assert response.json() == {"code": 4001, "message": "项目名不能为空", "data": None}


def test_patch_project_rejects_empty_body_and_length_overflow():
    """PATCH /api/projects/{id}：空 body → 没有可更新的字段；name/category 超长各自报错。

    :return: None。
    """
    client = make_client()

    empty = client.patch("/api/projects/8", headers=AUTH, json={})
    long_name = client.patch("/api/projects/8", headers=AUTH, json={"name": "名" * 201})
    long_category = client.patch("/api/projects/8", headers=AUTH, json={"category": "类" * 81})

    assert empty.status_code == 400
    assert empty.json() == {"code": 4001, "message": "没有可更新的字段", "data": None}
    assert long_name.json()["message"] == "项目名不能超过 200 个字"
    assert long_category.json()["message"] == "作品类型不能超过 80 个字"


# ---------------------------------------------------------------------------
# 场景三：数据不存在
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/api/projects/999"),
        ("patch", "/api/projects/999"),
        ("get", "/api/projects/999/assets"),
        ("post", "/api/project-assets/character/999/archive"),
    ],
)
def test_group_routes_hide_foreign_or_missing_projects(method, path):
    """数据不存在/他人项目：统一 404/4004「项目/资产不存在或无权访问」。

    :param method: HTTP 方法。
    :param path: 被测路由。
    :return: None。
    """
    kwargs = {"json": {"name": "新名"}} if method == "patch" else {}
    response = getattr(make_client(), method)(path, headers=AUTH, **kwargs)

    assert response.status_code == 404
    body = response.json()
    assert body["code"] == 4004
    assert body["data"] is None


# ---------------------------------------------------------------------------
# 场景五：异常依赖
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path", "kwargs"),
    [
        ("get", "/api/projects", {}),
        ("get", "/api/projects/8", {}),
        ("get", "/api/projects/8/assets", {}),
        ("post", "/api/project-assets/character/5/archive", {"json": {}}),
    ],
)
def test_group_routes_return_sanitized_500_when_database_fails(method, path, kwargs):
    """异常依赖：数据库故障 → 500/5001，不泄漏内部异常文本。

    :param method: HTTP 方法。
    :param path: 被测路由。
    :param kwargs: 请求关键字参数。
    :return: None。
    """
    database = GroupDatabase()
    database.fail_on_read = True
    response = getattr(make_client(database), method)(path, headers=AUTH, **kwargs)

    assert response.status_code == 500
    assert response.json() == {"code": 5001, "message": "服务暂时不可用，请稍后重试", "data": None}
    assert "database offline" not in response.text


# ---------------------------------------------------------------------------
# 场景六：重复写入
# ---------------------------------------------------------------------------


def test_repeated_identical_patches_are_idempotent():
    """重复写入：同一 PATCH 重复提交结果一致（幂等更新，不产生副作用累积）。

    :return: None。
    """
    database = GroupDatabase()
    client = make_client(database)

    first = client.patch("/api/projects/8", headers=AUTH, json={"name": "改名", "aspectRatio": "16:10"})
    second = client.patch("/api/projects/8", headers=AUTH, json={"name": "改名", "aspectRatio": "16:10"})

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert database.projects[0]["name"] == "改名"


def test_repeated_same_name_creates_independent_projects():
    """重复写入：同名项目重复创建各自独立成行（Node 无唯一约束，不做合并/报错）。

    :return: None。
    """
    database = GroupDatabase()
    client = make_client(database)

    first = client.post("/api/projects", headers=AUTH, json={"name": "同名项目"})
    second = client.post("/api/projects", headers=AUTH, json={"name": "同名项目"})

    assert first.json()["data"]["id"] != second.json()["data"]["id"]
    assert len([project for project in database.projects if project["name"] == "同名项目"]) == 2


# ---------------------------------------------------------------------------
# 场景七：状态码与 envelope 形状（成功路径）
# ---------------------------------------------------------------------------


def test_create_project_success_envelope_keeps_node_message():
    """envelope 形状：创建成功 200/code=0/message=「项目创建成功」，data 为 projectRow 形状。

    :return: None。
    """
    response = make_client().post(
        "/api/projects", headers=AUTH, json={"name": "新项目", "category": "悬疑", "aspectRatio": "16:10"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 0
    assert body["message"] == "项目创建成功"
    assert body["data"]["name"] == "新项目"
    assert body["data"]["aspectRatio"] == "16:10"
    # 原始行无聚合列 → 不含 progress 字段（与 Node GET 单项目一致）。
    assert "progressPercent" not in body["data"]


def test_archive_protected_status_messages_match_node_policy():
    """归档保护语义：confirmed/finalized/done/archived 各自的 400/4001 文案与 Node 一致。

    :return: None。
    """
    database = GroupDatabase()
    database.assets[("image", 1)] = {"id": 1, "user_id": 7, "status": "confirmed"}
    database.assets[("image", 2)] = {"id": 2, "user_id": 7, "status": "finalized"}
    database.assets[("image", 3)] = {"id": 3, "user_id": 7, "status": "done"}
    database.assets[("image", 4)] = {"id": 4, "user_id": 7, "status": "archived"}
    client = make_client(database)

    confirmed = client.post("/api/project-assets/image/1/archive", headers=AUTH)
    finalized = client.post("/api/project-assets/image/2/archive", headers=AUTH)
    done = client.post("/api/project-assets/image/3/archive", headers=AUTH)
    already = client.post("/api/project-assets/image/4/archive", headers=AUTH)

    assert confirmed.json()["message"] == "已确认或定稿资产不能直接归档"
    assert finalized.json()["message"] == "已确认或定稿资产不能直接归档"
    assert done.json()["message"] == "已完成资产不允许直接归档"
    assert already.json()["message"] == "项目资产已经归档"
    for response in (confirmed, finalized, done, already):
        assert response.status_code == 400
        assert response.json()["code"] == 4001


# ---------------------------------------------------------------------------
# 同 fixture 字段形状对照（Node 形状静态锁定，代理已于第四阶段删除）
# ---------------------------------------------------------------------------


def test_same_fixture_native_projects_list_shape_matches_node_fields():
    """原生 mapper 输出与 Node 形状的项目列表 item 字段集合一致（防止 mapper 静默漂移）。

    Node 形状字段清单为静态期望（原「原生 vs 代理」双侧对照在第四阶段代理删除后
    改为对本组 Node 字段清单的静态锁定）。

    :return: None。
    """
    database = GroupDatabase()
    database.projects = [{
        "id": 8, "user_id": 7, "name": "悬疑短剧", "status": "draft",
        "outline_count": 1, "scene_count": 1, "storyboard_count": 2,
        "confirmed_image_count": 1, "confirmed_video_count": 0,
        "confirmed_audio_count": 0, "latest_export_id": None,
        "latest_export_video_url": None, "latest_export_duration_seconds": None,
        "latest_export_created_at": None,
    }]
    native = make_client(database).get("/api/projects", headers=AUTH).json()["data"]["items"][0]

    node_shape_keys = {
        "id", "userId", "name", "category", "targetDuration",
        "narrativeVision", "visualStyle", "aspectRatio", "status",
        "createdAt", "updatedAt", "latestVideo",
        "progressPercent", "progressStage", "progressDetails", "progressComplete",
    }

    assert set(native.keys()) == node_shape_keys
    assert native["id"] == 8
    assert native["userId"] == 7
    assert native["name"] == "悬疑短剧"
    assert native["status"] == "draft"
