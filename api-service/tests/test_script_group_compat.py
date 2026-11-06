"""剧本/分镜组已接管路由的兼容测试（阶段 7.3）。

对照规格：``api-service/docs/script-group-spec.md``。覆盖 7.3 修复点回归
（场景 PUT 空变更 message、storyboard videoPrompt 优先、characterName 名称解析、
单条 GET frameCharacterContext）、七类场景缺口。全部离线执行（fake database）。
第四阶段已删除过渡开关：整组恒为原生实现，回退代理专项测试随实现一并移除。
"""

import json

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

AUTH = {"Authorization": "Bearer session-token"}


class ScriptDatabase:
    """剧本/分镜组兼容测试的最小数据库桩。

    :ivar scenes: scene_id -> 场景行（user_id 归属判定）。
    :ivar storyboards: storyboard_id -> 分镜行。
    :ivar characters: 项目 id -> 角色行列表（名称解析与归属校验）。
    :ivar fail_on_read: 置 True 时读取类方法抛异常，模拟数据库故障。
    """

    def __init__(self):
        self.scenes = {
            11: {
                "id": 11, "user_id": 7, "project_id": 8, "episode_no": 1,
                "scene_no": 1, "title": "夜班值班台", "summary": "异常物品出现",
                "content": "窗口滑出发卡", "mood": None, "location": None,
                "time_of_day": None, "estimated_duration": None,
                "sort_order": 0, "status": "draft",
            }
        }
        self.storyboards = {
            21: {
                "id": 21, "scene_id": 11, "project_id": 8, "shot_no": "01",
                "duration_seconds": 5, "action_text": "发卡滑出窗口",
                "visual_prompt": "固定中景", "sort_order": 0, "status": "pending",
            }
        }
        self.characters = {
            8: [
                {"id": 9, "name": "林知夏", "project_id": 8},
                {"id": 12, "name": "陈默", "project_id": 8},
            ]
        }
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

    # -- 场景 --------------------------------------------------------------

    def list_scenes(self, project_id, user_id):
        """列出项目场景；项目归属失败返回 None。

        :param project_id: 项目 id。
        :param user_id: 用户 id。
        :return: 场景行列表；项目不存在返回 None。
        :raises RuntimeError: fail_on_read 为 True 时模拟数据库离线。
        """
        if self.fail_on_read:
            raise RuntimeError("database offline")
        project_owned = any(
            project["id"] == project_id and project.get("user_id") == user_id
            for project in getattr(self, "projects", [{"id": 8, "user_id": user_id}])
        )
        if project_id == 8 and project_owned:
            return [row for row in self.scenes.values() if row["project_id"] == project_id]
        return None

    def get_scene(self, scene_id, user_id):
        """按 id 读取场景（归属判定）。

        :param scene_id: 场景 id。
        :param user_id: 用户 id。
        :return: 命中的场景行；不存在或非本人返回 None。
        """
        if self.fail_on_read:
            raise RuntimeError("database offline")
        scene = self.scenes.get(scene_id)
        return scene if scene and scene["user_id"] == user_id else None

    def update_scene(self, scene_id, user_id, updates):
        """按字段更新场景。

        :param scene_id: 场景 id。
        :param user_id: 用户 id。
        :param updates: 列名 -> 新值。
        :return: 更新后的场景行；不存在返回 None。
        """
        scene = self.get_scene(scene_id, user_id)
        if scene is None:
            return None
        scene.update(updates)
        return scene

    def save_scene_script(self, scene_id, user_id, content, mood, title):
        """保存单场景剧本并标记 revised。

        :param scene_id: 场景 id。
        :param user_id: 用户 id。
        :param content: 剧本内容。
        :param mood: 情绪基调。
        :param title: 标题。
        :return: 更新后的场景行；不存在返回 None。
        """
        scene = self.get_scene(scene_id, user_id)
        if scene is None:
            return None
        scene.update({"content": content, "mood": mood, "title": title, "status": "revised"})
        return scene

    # -- 分镜 --------------------------------------------------------------

    def list_storyboards(self, scene_id, user_id):
        """列出场景分镜；场景归属失败返回 None。

        :param scene_id: 场景 id。
        :param user_id: 用户 id。
        :return: 分镜行列表；场景不存在返回 None。
        """
        scene = self.get_scene(scene_id, user_id)
        if scene is None:
            return None
        return [row for row in self.storyboards.values() if row["scene_id"] == scene_id]

    def get_storyboard(self, storyboard_id, user_id):
        """按 id 读取分镜（归属经由场景判定）。

        :param storyboard_id: 分镜 id。
        :param user_id: 用户 id。
        :return: 命中的分镜行；不存在或非本人返回 None。
        """
        if self.fail_on_read:
            raise RuntimeError("database offline")
        shot = self.storyboards.get(storyboard_id)
        scene = self.scenes.get(shot["scene_id"]) if shot else None
        return shot if shot and scene and scene["user_id"] == user_id else None

    def get_storyboard_detail(self, storyboard_id, user_id):
        """单分镜详情联查桩（模拟 COALESCE 角色名覆盖 + project_id 带出）。

        :param storyboard_id: 分镜 id。
        :param user_id: 用户 id。
        :return: 分镜行（character_name 被绑定角色名覆盖）；不存在或非本人 None。
        """
        shot = self.get_storyboard(storyboard_id, user_id)
        if shot is None:
            return None
        row = dict(shot)
        if row.get("character_id"):
            character = self.character_in_project(row["character_id"], row.get("project_id", 8))
            if character:
                row["character_name"] = character["name"]
        row.setdefault("project_id", 8)
        return row

    def list_frame_characters(self, project_id):
        """项目角色库桩（frameCharacterContext 输入；排除 archived 由测试数据控制）。

        :param project_id: 项目 id。
        :return: 角色行列表。
        """
        if self.fail_on_read:
            raise RuntimeError("database offline")
        return [
            character
            for character in self.characters.get(project_id, [])
            if character.get("status") != "archived"
        ]

    def character_in_project(self, character_id, project_id):
        """按 id+项目查角色（不过滤 archived，对齐 Node L16151）。

        :param character_id: 角色 id。
        :param project_id: 项目 id。
        :return: {"id", "name"}；未命中返回 None。
        """
        for character in self.characters.get(project_id, []):
            if character["id"] == character_id:
                return character
        return None

    def find_character_by_name(self, project_id, name):
        """按名称在同项目内解析角色。

        :param project_id: 项目 id。
        :param name: 角色名。
        :return: {"id", "name"}；未命中返回 None。
        """
        for character in self.characters.get(project_id, []):
            if character["name"] == name:
                return character
        return None

    def update_storyboard(self, storyboard_id, user_id, updates):
        """按字段更新分镜（API camelCase → 行内 snake_case，对齐 MySQLDatabase 列映射）。

        :param storyboard_id: 分镜 id。
        :param user_id: 用户 id。
        :param updates: API 字段名 -> 新值。
        :return: 更新后的分镜行；不存在返回 None。
        """
        shot = self.get_storyboard(storyboard_id, user_id)
        if shot is None:
            return None
        column_map = {
            "shotType": "shot_type",
            "cameraAngle": "camera_angle",
            "characterId": "character_id",
            "characterName": "character_name",
            "actionText": "action_text",
            "dialogueText": "dialogue_text",
            "visualPrompt": "visual_prompt",
            "startVisualPrompt": "start_visual_prompt",
            "endVisualPrompt": "end_visual_prompt",
            "imageUrl": "image_url",
            "endImageUrl": "end_image_url",
            "status": "status",
            "assetReference": "asset_reference_json",
        }
        shot.update({column_map.get(key, key): value for key, value in updates.items()})
        return shot

    def reorder_storyboards(self, orders, user_id):
        """批量重排序（原子 + 同场景校验，FastAPI 有意收紧语义）。

        :param orders: [{"id", "sortOrder"}]。
        :param user_id: 用户 id。
        :return: {"outcome": "updated"}；越权 not_found；跨场景 cross_scene。
        """
        shots = [self.storyboards.get(item["id"]) for item in orders]
        if any(not shot or self.get_storyboard(shot["id"], user_id) is None for shot in shots):
            return {"outcome": "not_found"}
        if len({shot["scene_id"] for shot in shots}) != 1:
            return {"outcome": "cross_scene"}
        for item in orders:
            self.storyboards[item["id"]]["sort_order"] = item["sortOrder"]
        return {"outcome": "updated"}


def make_client(database=None):
    """构建原生模式测试客户端（第四阶段起恒为原生实现，直连数据库桩）。

    :param database: 注入的数据库桩；缺省使用 ScriptDatabase()。
    :return: 配置完成的 TestClient。
    """
    return TestClient(create_app(Settings(_env_file=None), database=database or ScriptDatabase()), raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# 7.3 修复点回归
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [{}, {"status": "confirmed"}, {"unknownField": 1}],  # status/unknown 均不在白名单
)
def test_put_scene_without_updatable_fields_returns_no_change_message(body):
    """PUT 场景：无可识别字段时返回当前行 + message「场景无变更」，不发 UPDATE。

    :param body: 请求 JSON 体（参数化：空 body / 仅白名单外字段）。
    :return: None。
    """
    database = ScriptDatabase()
    original = dict(database.scenes[11])
    response = make_client(database).put("/api/scenes/11", headers=AUTH, json=body)

    assert response.status_code == 200
    assert response.json()["message"] == "场景无变更"
    assert response.json()["data"]["title"] == "夜班值班台"
    # 数据未被改动。
    assert database.scenes[11] == original


def test_put_storyboard_video_prompt_takes_priority_over_visual_prompt():
    """PUT 分镜：同时传 videoPrompt 与 visualPrompt 时 videoPrompt 优先（对齐 Node）。

    :return: None。
    """
    database = ScriptDatabase()
    response = make_client(database).put(
        "/api/storyboards/21",
        headers=AUTH,
        json={"videoPrompt": "视频提示词", "visualPrompt": "静帧提示词"},
    )

    assert response.status_code == 200
    assert response.json()["data"]["visualPrompt"] == "视频提示词"


def test_put_storyboard_resolves_character_id_from_character_name():
    """PUT 分镜：仅传 characterName 时按名称解析同项目角色并回填 characterId。

    :return: None。
    """
    database = ScriptDatabase()
    client = make_client(database)

    resolved = client.put("/api/storyboards/21", headers=AUTH, json={"characterName": "陈默"})
    unresolved = client.put(
        "/api/storyboards/21", headers=AUTH, json={"characterName": "无名路人"}
    )

    assert resolved.status_code == 200
    assert resolved.json()["data"]["characterId"] == 12
    assert resolved.json()["data"]["characterName"] == "陈默"
    # 名称未命中：characterId 置空（Node 语义），characterName 保持传入值。
    assert unresolved.json()["data"]["characterId"] is None
    assert unresolved.json()["data"]["characterName"] == "无名路人"


def test_put_storyboard_keeps_archived_character_binding():
    """PUT 分镜：character_in_project 不再过滤 archived——已归档角色仍可保持绑定（对齐 Node）。

    :return: None。
    """
    database = ScriptDatabase()
    database.characters[8].append({"id": 30, "name": "已归档角色", "project_id": 8})
    response = make_client(database).put("/api/storyboards/21", headers=AUTH, json={"characterId": 30})

    assert response.status_code == 200
    assert response.json()["data"]["characterId"] == 30


def test_get_storyboard_native_response_includes_frame_character_context():
    """GET 分镜单条：已原生化（第三阶段第三组废除固定代理），响应附带 frameCharacterContext。

    角色库来自 db.list_frame_characters；blockers 文案与 Node 逐字一致
    （fixture 对照见 test_frame_character_fixtures.py）。

    :return: None。
    """
    database = ScriptDatabase()
    database.storyboards[21].update(
        {
            "character_name": "无名路人",
            "action_text": "无名路人走过大厅。",
            "visual_prompt": "全景。",
        }
    )
    database.characters[8] = [
        {
            "id": 9, "name": "林知夏", "role_tag": "主角", "personality": "克制",
            "appearance": "黑色短发", "age_group": "young_adult", "gender": "female",
            "reference_image_url": "https://media.example.com/9.png", "status": "confirmed",
        }
    ]
    response = make_client(database).get("/api/storyboards/21", headers=AUTH)

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["id"] == 21
    assert data["shotNo"] == "01"
    context = data["frameCharacterContext"]
    assert context["ready"] is False
    assert context["primaryCharacterId"] is None
    assert context["blockers"] == ["分镜角色“无名路人”无法匹配角色库，请先在分镜编辑器中绑定真实角色"]


def test_get_storyboard_native_resolves_bound_character_name_and_ready_context():
    """GET 分镜单条：COALESCE 角色名覆盖 + 就绪上下文（无 blockers）。

    :return: None。
    """
    database = ScriptDatabase()
    database.storyboards[21].update(
        {
            "character_id": 9,
            "character_name": "旧快照名",
            "action_text": "林知夏站在值班台前。",
            "visual_prompt": "固定中景。",
        }
    )
    database.characters[8] = [
        {
            "id": 9, "name": "林知夏", "role_tag": "主角", "personality": "克制",
            "appearance": "黑色短发", "age_group": "young_adult", "gender": "female",
            "reference_image_url": "https://media.example.com/9.png", "status": "confirmed",
        }
    ]
    response = make_client(database).get("/api/storyboards/21", headers=AUTH)

    assert response.status_code == 200
    data = response.json()["data"]
    # Node：COALESCE(c.name, s.character_name) —— 绑定角色的真实姓名覆盖快照文本。
    assert data["characterName"] == "林知夏"
    context = data["frameCharacterContext"]
    assert context["ready"] is True
    assert context["primaryCharacterId"] == 9
    assert context["characters"][0]["hasReferenceImage"] is True
    assert context["blockers"] == []


# ---------------------------------------------------------------------------
# 场景一：未登录
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/api/projects/8/scenes"),
        ("get", "/api/scenes/11"),
        ("put", "/api/scenes/11"),
        ("put", "/api/scenes/11/script"),
        ("get", "/api/scenes/11/storyboards"),
        ("get", "/api/storyboards/21"),
        ("put", "/api/storyboards/21"),
        ("post", "/api/storyboards/reorder"),
    ],
)
def test_script_group_routes_require_authentication(method, path):
    """未登录：剧本/分镜组路由统一 401/4010 envelope。

    :param method: HTTP 方法。
    :param path: 被测路由。
    :return: None。
    """
    kwargs = {"json": {}} if method in {"put", "post"} else {}
    response = getattr(make_client(), method)(path, **kwargs)

    assert response.status_code == 401
    assert response.json() == {"code": 4010, "message": "未登录或登录已过期", "data": None}


# ---------------------------------------------------------------------------
# 场景二：字段缺失 / 非法
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("payload", [{"durationSeconds": 0}, {"durationSeconds": 31}, {"durationSeconds": "abc"}])
def test_put_storyboard_rejects_invalid_duration(payload):
    """PUT 分镜：durationSeconds 非 1-30 整数 → 400/4001（与 Node 的 500 差异为有意保留）。

    :param payload: 请求 JSON 体（参数化用例）。
    :return: None。
    """
    response = make_client().put("/api/storyboards/21", headers=AUTH, json=payload)

    assert response.status_code == 400
    assert response.json() == {"code": 4001, "message": "分镜时长必须是有效整数（1-30 秒）", "data": None}


@pytest.mark.parametrize("payload", [{"characterId": "abc"}, {"characterId": 0}, {"characterId": -3}])
def test_put_storyboard_rejects_invalid_character_id(payload):
    """PUT 分镜：characterId 非法（非数字/0/负数）→ 400/4001 无效的 characterId。

    :param payload: 请求 JSON 体（参数化用例）。
    :return: None。
    """
    response = make_client().put("/api/storyboards/21", headers=AUTH, json=payload)

    assert response.status_code == 400
    assert response.json() == {"code": 4001, "message": "无效的 characterId", "data": None}


def test_put_storyboard_rejects_character_from_other_project():
    """PUT 分镜：characterId 不属于当前项目 → 404/4004。

    :return: None。
    """
    response = make_client().put("/api/storyboards/21", headers=AUTH, json={"characterId": 777})

    assert response.status_code == 404
    assert response.json() == {"code": 4004, "message": "角色不存在或不属于当前项目", "data": None}


@pytest.mark.parametrize(
    "payload",
    [
        {},  # 缺 orders
        {"orders": []},  # 空 orders
        {"orders": [{"id": 21}]},  # 缺 sortOrder
        {"orders": [{"id": 21, "sortOrder": -1}]},  # 负排序
        {"orders": [{"id": 21, "sortOrder": True}]},  # 布尔伪装
        {"orders": [{"id": 21, "sortOrder": 1}, {"id": 21, "sortOrder": 2}]},  # 重复 id
    ],
)
def test_reorder_rejects_invalid_payload(payload):
    """重排序：非法 payload → 400/4001（FastAPI 有意收紧语义，README 已声明）。

    :param payload: 请求 JSON 体（参数化用例）。
    :return: None。
    """
    response = make_client().post("/api/storyboards/reorder", headers=AUTH, json=payload)

    assert response.status_code == 400
    assert response.json()["code"] == 4001
    assert response.json()["data"] is None


# ---------------------------------------------------------------------------
# 场景三：数据不存在
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/api/scenes/999"),
        ("put", "/api/scenes/999"),
        ("put", "/api/scenes/999/script"),
        ("get", "/api/scenes/999/storyboards"),
        ("put", "/api/storyboards/999"),
    ],
)
def test_script_group_routes_hide_missing_resources(method, path):
    """数据不存在：统一 404/4004「场景/分镜不存在或无权访问」。

    :param method: HTTP 方法。
    :param path: 被测路由。
    :return: None。
    """
    kwargs = {"json": {"title": "新标题"}} if method == "put" else {}
    response = getattr(make_client(), method)(path, headers=AUTH, **kwargs)

    assert response.status_code == 404
    assert response.json()["code"] == 4004
    assert response.json()["data"] is None


# ---------------------------------------------------------------------------
# 场景五：异常依赖
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path", "kwargs"),
    [
        ("get", "/api/projects/8/scenes", {}),
        ("get", "/api/scenes/11", {}),
        ("put", "/api/scenes/11", {"json": {"title": "新标题"}}),
        ("get", "/api/scenes/11/storyboards", {}),
    ],
)
def test_script_group_routes_return_sanitized_500_when_database_fails(method, path, kwargs):
    """异常依赖：数据库故障 → 500/5001，不泄漏内部异常文本。

    :param method: HTTP 方法。
    :param path: 被测路由。
    :param kwargs: 请求关键字参数。
    :return: None。
    """
    database = ScriptDatabase()
    database.fail_on_read = True
    response = getattr(make_client(database), method)(path, headers=AUTH, **kwargs)

    assert response.status_code == 500
    assert response.json() == {"code": 5001, "message": "服务暂时不可用，请稍后重试", "data": None}
    assert "database offline" not in response.text


# ---------------------------------------------------------------------------
# 场景六：重复写入 + envelope 形状
# ---------------------------------------------------------------------------


def test_repeated_identical_scene_puts_are_idempotent():
    """重复写入：同一 PUT 场景重复提交结果一致（幂等更新）。

    :return: None。
    """
    database = ScriptDatabase()
    client = make_client(database)

    first = client.put("/api/scenes/11", headers=AUTH, json={"title": "改名", "location": "值班台"})
    second = client.put("/api/scenes/11", headers=AUTH, json={"title": "改名", "location": "值班台"})

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert first.json()["message"] == "场景已保存"


def test_put_scene_null_values_clear_columns():
    """PUT 场景：显式 null/空串字段清成 NULL（对齐 Node SET col = NULL 语义）。

    :return: None。
    """
    response = make_client().put(
        "/api/scenes/11", headers=AUTH, json={"title": None, "timeOfDay": ""}
    )

    assert response.status_code == 200
    assert response.json()["data"]["title"] is None
    assert response.json()["data"]["timeOfDay"] is None


def test_save_scene_script_marks_revised_with_node_message():
    """envelope 形状：剧本保存 message「剧本已保存」且 status 置 revised。

    :return: None。
    """
    response = make_client().put("/api/scenes/11/script", headers=AUTH, json={"content": "改后剧本"})

    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 0
    assert body["message"] == "剧本已保存"
    assert body["data"]["status"] == "revised"
    assert body["data"]["content"] == "改后剧本"
    # 未传字段回退当前行值。
    assert body["data"]["title"] == "夜班值班台"


def test_reorder_success_envelope_keeps_node_shape():
    """重排序成功：200 + data {"success": true} + message「排序已更新」；sortOrder=0 合法。

    :return: None。
    """
    response = make_client().post(
        "/api/storyboards/reorder", headers=AUTH, json={"orders": [{"id": 21, "sortOrder": 0}]}
    )

    assert response.status_code == 200
    assert response.json() == {"code": 0, "message": "排序已更新", "data": {"success": True}}
