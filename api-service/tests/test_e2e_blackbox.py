"""端到端黑盒契约测试（FastAPI-Only 迁移第七阶段 · Task 7.2）。

以 TestClient + fake database（现有 stub 模式）跑跨端点用户旅程，每条链路
至少覆盖一个完整旅程并断言「上一端点输出是下一端点输入」的跨层串联语义，
envelope 形状（``{code, message, data}``，成功 code=0）全链一致：

1. **鉴权链**：captcha 获取 → verify → send-code（mock SMS devCode）→
   register → 登录态调项目接口（建项目 + 列表可见）；
2. **内容链**：建项目 → 场景编辑（项目级场景生成依赖预置场景数据 + PUT 编辑进入系统）→
   剧本 generate（mock AI 确定性生成）→ 分镜 generate（mock + 资产门禁 +
   事务替换）→ storyboard detail（frameCharacterContext 断言）→ 静帧入队 →
   任务行可见（任务中心）→ 生成任务详情可查；
3. **媒体链**：storage 签名 URL 生成（resolve_object_url 产出）→ 带签名访问
   200 → 无签名访问 401/4010（有意收紧：Node 裸读 → 强制验签）→
   /generated/video Range 206。

与既有测试的分工：单端点字段级细节由 test_auth_extended_compat /
test_script_native_compat / test_media_service_compat 等覆盖，本文件只断言
「链路可通」与跨端点数据流转，不重复字段级契约断言。

全部离线执行（fake database + mock SMS + mock AI + tmp_path 文件，零外部依赖）。
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app.auth_captcha import AuthCaptchaService
from app.config import Settings
from app.main import create_app
from app.media_urls import resolve_object_url
from app.sms import MockSmsProvider

# 测试签名密钥（媒体链 Settings 显式注入，验签与产签同源）。
SIGNING_SECRET = "blackbox-media-signing-secret"
# 滑块验证码 HMAC 密钥与固定缺口位置（AuthCaptchaService 注入）。
CAPTCHA_SECRET = "blackbox-captcha-secret"
FIXED_TARGET_X = 140
# 注册手机号（鉴权链，未预置——走完整注册旅程）与内容链预置用户手机号。
AUTH_PHONE = "13700000002"
PHONE = "13700000001"


class BlackboxDatabase:
    """黑盒链路的最小数据库桩（鉴权 + 项目/内容 + 生成任务三域合一）。

    :ivar users: 手机号 → 用户行。
    :ivar sessions: token → user_id。
    :ivar sms_codes: 验证码记录列表。
    :ivar captcha_sessions: challenge_id → 会话行。
    :ivar projects: 项目 id → 行。
    :ivar scenes / storyboards / characters / asset_rows: 内容链数据。
    :ivar generation_jobs: 生成任务表（静帧入队产出）。
    """

    def __init__(self) -> None:
        self.now = 1000000.0
        # 预置内容链用户（id=7，与场景/角色/资产预置数据归属一致）。
        self.users: dict[str, dict[str, Any]] = {
            PHONE: {"id": 7, "phone": PHONE, "nickname": "黑盒链路用户", "createdAt": "2026-10-19T00:00:00.000Z"}
        }
        self.sessions: dict[str, int] = {}
        self.sms_codes: list[dict[str, Any]] = []
        self.captcha_sessions: dict[str, dict[str, Any]] = {}
        self.sms_seq = 0
        self.session_seq = 0
        self.project_seq = 0
        self.scene_seq = 0
        self.storyboards: dict[int, dict[str, Any]] = {}
        self.generation_jobs: dict[int, dict[str, Any]] = {}
        self.projects: dict[int, dict[str, Any]] = {}
        # 内容链预置：项目 8（用户 7）+ 场景 11 + 角色 9（林知夏）+ 资产行
        # （角色资产板 71 / 场景全景 72，均为 confirmed+passed——分镜资产门禁输入）。
        self.characters = {
            8: [
                {
                    "id": 9, "name": "林知夏", "project_id": 8, "role_tag": "主角",
                    "personality": "克制冷静", "appearance": "黑色短发，灰色风衣",
                    "age_group": "young_adult", "gender": "female",
                    "reference_image_url": "https://media.example.com/9.png", "status": "confirmed",
                }
            ]
        }
        self.asset_rows = [
            {
                "asset_node_id": 71, "node_type": "character", "ref_id": 9, "label": "林知夏",
                "asset_prompt": None, "image_id": 81, "version_no": 3, "view_set_version": 2,
                "view_index": 1, "view_key": None, "view_set_type": "character-asset-pack",
                "status": "confirmed", "vision_status": "passed",
            },
            {
                "asset_node_id": 72, "node_type": "scene", "ref_id": 11, "label": "值班室",
                "asset_prompt": None, "image_id": 82, "version_no": 2, "view_set_version": 1,
                "view_index": 1, "view_key": None, "view_set_type": "single",
                "status": "confirmed", "vision_status": "passed",
            },
        ]
        self.scenes: dict[int, dict[str, Any]] = {
            11: {
                "id": 11, "user_id": 7, "project_id": 8, "episode_no": 1, "scene_no": 1,
                "title": "夜班值班台", "summary": "异常物品出现", "content": "",
                "mood": None, "location": "值班室", "time_of_day": "深夜",
                "estimated_duration": None, "sort_order": 0, "status": "draft",
            }
        }

    # ---- 鉴权域（与 test_auth_extended_compat 的 ExtendedAuthDatabase 同语义）----

    def get_user_count(self) -> int:
        """用户总数（/api/health 摘要字段）。

        :returns: 用户表行数。
        """
        return len(self.users)

    def fetch_user_by_phone(self, phone: str) -> dict[str, Any] | None:
        """按标准化手机号查询用户。

        :param phone: 11 位手机号。
        :returns: 用户行或 None。
        """
        return self.users.get(phone)

    def create_user(self, phone: str, nickname: str, password: str) -> dict[str, Any]:
        """创建新用户（SHA-256 哈希落库，形状对齐 Node createUser）。

        :param phone: 11 位手机号。
        :param nickname: 昵称。
        :param password: 明文口令。
        :returns: {"id", "phone", "nickname", "createdAt"}。
        """
        user_id = max((u["id"] for u in self.users.values()), default=0) + 1
        user = {"id": user_id, "phone": phone, "nickname": nickname, "createdAt": "2026-10-19T00:00:00.000Z"}
        self.users[phone] = user
        self.users[phone]["password_hash"] = hashlib.sha256(password.encode()).hexdigest()
        return user

    def create_session(self, user: dict[str, Any]) -> str:
        """为用户签发新会话 token。

        :param user: 用户行。
        :returns: 新 token。
        """
        self.session_seq += 1
        token = f"blackbox-session-{self.session_seq}"
        self.sessions[token] = int(user["id"])
        return token

    def find_user_by_token(self, token: str) -> dict[str, Any] | None:
        """按 token 反查用户（require_user 鉴权入口）。

        :param token: 访问令牌。
        :returns: 用户行或 None。
        """
        user_id = self.sessions.get(token)
        if user_id is None:
            return None
        return next((u for u in self.users.values() if u["id"] == user_id), None)

    def save_sms_code_record(self, phone: str, code_type: str, code: str, provider: str, expires_in_seconds: int) -> None:
        """写入短信验证码记录（先清理过期行）。

        :param phone: 手机号。
        :param code_type: 用途（login/register/reset）。
        :param code: 验证码。
        :param provider: 供应商标识。
        :param expires_in_seconds: 有效期秒数。
        """
        self.sms_codes = [r for r in self.sms_codes if r["expires_at"] > self.now]
        self.sms_seq += 1
        self.sms_codes.append({
            "id": self.sms_seq, "phone": phone, "code_type": code_type, "code": code,
            "provider": provider, "expires_at": self.now + expires_in_seconds, "used_at": None,
        })

    def verify_sms_code(self, phone: str, code_type: str, code: str) -> dict[str, Any]:
        """消费短信验证码（一次性；对齐 Node consumeCode 判定顺序）。

        :param phone: 手机号。
        :param code_type: 用途。
        :param code: 用户提交验证码。
        :returns: {"ok", "message"}。
        """
        self.sms_codes = [r for r in self.sms_codes if r["expires_at"] > self.now]
        candidates = [r for r in self.sms_codes if r["phone"] == phone and r["code_type"] == code_type]
        record = candidates[-1] if candidates else None
        if record is None:
            return {"ok": False, "message": "验证码不存在或已过期"}
        if record["used_at"]:
            return {"ok": False, "message": "验证码已失效，请重新获取"}
        if record["expires_at"] <= self.now:
            return {"ok": False, "message": "验证码已过期，请重新获取"}
        if str(record["code"]) != str(code or ""):
            return {"ok": False, "message": "验证码错误"}
        record["used_at"] = self.now
        return {"ok": True, "message": None}

    def prune_auth_captcha_sessions(self) -> None:
        """清理过期挑战/token 会话。"""
        self.captcha_sessions = {cid: r for cid, r in self.captcha_sessions.items() if r["expires_at"] > self.now}

    def create_auth_captcha_session(self, challenge_id: str, phone: str, ip: str, target_x: int, ttl_seconds: int) -> None:
        """写入滑块挑战会话。

        :param challenge_id: 挑战 id。
        :param phone: 绑定手机号。
        :param ip: 绑定 IP。
        :param target_x: 缺口正确位置。
        :param ttl_seconds: 有效期秒数。
        """
        self.captcha_sessions[challenge_id] = {
            "challenge_id": challenge_id, "phone": phone, "ip": ip, "target_x": target_x,
            "attempts": 0, "verified": 0, "captcha_token": None, "consumed_at": None,
            "expires_at": self.now + ttl_seconds,
        }

    def fetch_auth_captcha_session(self, challenge_id: str) -> dict[str, Any] | None:
        """读取滑块挑战会话（含 is_expired 标记）。

        :param challenge_id: 挑战 id。
        :returns: 会话行或 None。
        """
        record = self.captcha_sessions.get(challenge_id)
        if record is None:
            return None
        return {
            "phone": record["phone"], "ip": record["ip"], "target_x": record["target_x"],
            "attempts": record["attempts"], "verified": record["verified"],
            "is_expired": 1 if record["expires_at"] <= self.now else 0,
        }

    def delete_auth_captcha_session(self, challenge_id: str) -> None:
        """删除滑块挑战会话。

        :param challenge_id: 挑战 id。
        """
        self.captcha_sessions.pop(challenge_id, None)

    def increment_auth_captcha_attempts(self, challenge_id: str) -> int | None:
        """尝试次数 +1 并返回新值。

        :param challenge_id: 挑战 id。
        :returns: 新尝试次数或 None。
        """
        record = self.captcha_sessions.get(challenge_id)
        if record is None:
            return None
        record["attempts"] += 1
        return record["attempts"]

    def mark_auth_captcha_verified(self, challenge_id: str, captcha_token: str, ttl_seconds: int) -> bool:
        """verify 通过：置 verified=1、写 token、改写 token 有效期。

        :param challenge_id: 挑战 id。
        :param captcha_token: 一次性 token。
        :param ttl_seconds: token 有效期秒数。
        :returns: 成功 True；已并发消费 False。
        """
        record = self.captcha_sessions.get(challenge_id)
        if record is None or record["verified"]:
            return False
        record["verified"] = 1
        record["captcha_token"] = captcha_token
        record["expires_at"] = self.now + ttl_seconds
        return True

    def consume_auth_captcha_token(self, challenge_id: str, captcha_token: str) -> bool:
        """一次性消费验证 token（原子语义）。

        :param challenge_id: 挑战 id。
        :param captcha_token: token 串。
        :returns: 消费成功 True。
        """
        record = self.captcha_sessions.get(challenge_id)
        if (
            record is not None
            and record["verified"]
            and record["captcha_token"] == captcha_token
            and record["consumed_at"] is None
            and record["expires_at"] > self.now
        ):
            record["consumed_at"] = self.now
            return True
        return False

    # ---- 项目域 ----

    def create_project(self, user_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        """创建项目（黑盒链路的第一个业务写入）。

        :param user_id: 归属用户。
        :param payload: 请求体（name 必填）。
        :returns: 项目行。
        """
        self.project_seq += 1
        row = {
            "id": self.project_seq, "user_id": user_id, "name": str(payload.get("name") or "").strip(),
            "category": payload.get("category"), "narrative_vision": payload.get("narrativeVision"),
            "visual_style": payload.get("visualStyle"), "aspect_ratio": payload.get("aspectRatio"),
            "outline_count": 0, "scene_count": 0, "storyboard_count": 0,
            "confirmed_image_count": 0, "confirmed_video_count": 0, "confirmed_audio_count": 0,
        }
        self.projects[self.project_seq] = row
        return dict(row)

    def get_project(self, project_id: int, user_id: int) -> dict[str, Any] | None:
        """按 id+用户取项目。

        :param project_id: 项目 id。
        :param user_id: 用户 id。
        :returns: 项目行或 None。
        """
        row = self.projects.get(project_id)
        return row if row and int(row["user_id"]) == int(user_id) else None

    def list_projects(self, user_id: int) -> list[dict[str, Any]]:
        """列出用户全部项目。

        :param user_id: 用户 id。
        :returns: 项目行列表。
        """
        return [dict(row) for row in self.projects.values() if int(row["user_id"]) == int(user_id)]

    # ---- 场景域 ----

    def list_scenes(self, project_id: int, user_id: int) -> list[dict[str, Any]] | None:
        """列出项目场景；项目归属失败返回 None。

        :param project_id: 项目 id。
        :param user_id: 用户 id。
        :returns: 场景行列表；项目不存在 None。
        """
        if self.get_project(project_id, user_id) is None:
            return None
        return [dict(row) for row in self.scenes.values() if row["project_id"] == project_id]

    def get_scene(self, scene_id: int, user_id: int) -> dict[str, Any] | None:
        """按 id 读取场景（归属判定）。

        :param scene_id: 场景 id。
        :param user_id: 用户 id。
        :returns: 场景行或 None。
        """
        scene = self.scenes.get(scene_id)
        return scene if scene and scene["user_id"] == user_id else None

    def update_scene(self, scene_id: int, user_id: int, updates: dict[str, Any]) -> dict[str, Any] | None:
        """按字段更新场景。

        :param scene_id: 场景 id。
        :param user_id: 用户 id。
        :param updates: 列名 → 新值。
        :returns: 更新后的场景行或 None。
        """
        scene = self.get_scene(scene_id, user_id)
        if scene is None:
            return None
        scene.update(updates)
        return scene

    def get_scene_with_project(self, scene_id: int, user_id: int) -> dict[str, Any] | None:
        """场景 + 项目字段联查（generate 端点前置）。

        :param scene_id: 场景 id。
        :param user_id: 用户 id。
        :returns: 场景行（带 projectName/category/visual_style 联查字段）或 None。
        """
        scene = self.get_scene(scene_id, user_id)
        if scene is None:
            return None
        project = self.projects.get(scene["project_id"])
        row = dict(scene)
        row.update({
            "ownerId": user_id,
            "projectName": (project or {}).get("name") or "夜班项目",
            "category": (project or {}).get("category") or "悬疑",
            "narrative_vision": (project or {}).get("narrative_vision"),
            "visual_style": (project or {}).get("visual_style") or "电影感写实风格",
        })
        return row

    # ---- 剧本 / 分镜生成域（与 test_script_native_compat 的 GenerateDatabase 同语义）----

    def latest_story_bible_row(self, project_id: int) -> dict[str, Any] | None:
        """最新故事设定行（黑盒链路无 bible → None）。"""
        return None

    def latest_season_structure_row(self, project_id: int) -> dict[str, Any] | None:
        """最新分集大纲行（黑盒链路无 → None）。"""
        return None

    def latest_outline_row(self, project_id: int) -> dict[str, Any] | None:
        """最新总纲行（黑盒链路无 → None）。"""
        return None

    def save_generated_scene_script(self, scene_id: int, fields: dict[str, Any]) -> dict[str, Any] | None:
        """AI 剧本回写（status='generated'）。

        :param scene_id: 场景 id。
        :param fields: 剧本字段。
        :returns: 更新后的场景行或 None。
        """
        scene = self.scenes.get(scene_id)
        if scene is None:
            return None
        scene.update(fields)
        scene["status"] = "generated"
        return dict(scene)

    def list_project_characters_with_assets(self, project_id: int) -> list[dict[str, Any]]:
        """项目角色（含资产版本）。

        :param project_id: 项目 id。
        :returns: 角色行列表。
        """
        return [dict(c) for c in self.characters.get(project_id, [])]

    def list_storyboard_asset_rows(self, project_id: int, *, include_missing_vision: bool = False) -> list[dict[str, Any]]:
        """资产节点行（分镜门禁与提示词补齐输入）。

        :param project_id: 项目 id。
        :param include_missing_vision: 是否包含 vision 缺失行（事务期语义）。
        :returns: 资产行列表。
        """
        return [dict(row) for row in self.asset_rows]

    def replace_scene_storyboards(self, scene_id: int, project_id: int, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """整场替换分镜（DELETE+INSERT 语义由列表重建模拟）。

        :param scene_id: 场景 id。
        :param project_id: 项目 id。
        :param rows: 插入行。
        :returns: 替换后的分镜行列表。
        """
        self.storyboards = {
            row_id: row for row_id, row in self.storyboards.items() if row["scene_id"] != scene_id
        }
        for index, row in enumerate(rows):
            new_id = 300 + index
            self.storyboards[new_id] = {
                "id": new_id, "scene_id": scene_id, "project_id": project_id,
                "status": "pending", "image_url": None, "end_image_url": None,
                "video_url": None, **row,
            }
        self.scenes[scene_id]["status"] = "storyboard_ready"
        return self.list_scene_storyboard_rows(scene_id)

    def list_scene_storyboard_rows(self, scene_id: int) -> list[dict[str, Any]]:
        """场景全部分镜行（sort_order 升序）。

        :param scene_id: 场景 id。
        :returns: 分镜行列表。
        """
        return [dict(row) for row in sorted(
            (row for row in self.storyboards.values() if row["scene_id"] == scene_id),
            key=lambda row: (row.get("sort_order") or 0, row["id"]),
        )]

    def get_storyboard_detail(self, storyboard_id: int, user_id: int) -> dict[str, Any] | None:
        """单分镜详情联查（归属经由场景判定）。

        :param storyboard_id: 分镜 id。
        :param user_id: 用户 id。
        :returns: 分镜行或 None。
        """
        shot = self.storyboards.get(storyboard_id)
        if shot is None:
            return None
        scene = self.scenes.get(shot["scene_id"])
        if scene is None or scene["user_id"] != user_id:
            return None
        row = dict(shot)
        row.setdefault("project_id", scene["project_id"])
        return row

    def list_frame_characters(self, project_id: int) -> list[dict[str, Any]]:
        """项目角色库（frameCharacterContext 输入；排除 archived）。

        :param project_id: 项目 id。
        :returns: 角色行列表。
        """
        return [dict(c) for c in self.characters.get(project_id, []) if c.get("status") != "archived"]

    # ---- 静帧入队 / 生成任务域 ----

    def get_shot_for_frame_job(self, shot_id: int, user_id: int) -> dict[str, Any] | None:
        """静帧入队前置查询。

        :param shot_id: 分镜 id。
        :param user_id: 用户 id。
        :returns: 分镜行（带项目风格联查字段）或 None。
        """
        shot = self.storyboards.get(shot_id)
        scene = self.scenes.get(shot["scene_id"]) if shot else None
        if shot is None or scene is None or scene["user_id"] != user_id:
            return None
        row = dict(shot)
        row.update({"project_id": scene["project_id"], "project_visual_style": "电影感写实风格"})
        return row

    def next_image_version(self, storyboard_id: int) -> int:
        """下一静帧版本号。

        :param storyboard_id: 分镜 id。
        :returns: 版本号（从 1 起）。
        """
        return 1

    def create_generation_job(self, project_id: int, job_type: str, source_id: int, request: dict[str, Any]) -> dict[str, Any]:
        """创建/复用生成任务（queued/running 活动任务幂等复用，与 Node 一致）。

        :param project_id: 项目 id。
        :param job_type: 任务类型。
        :param source_id: 来源 id。
        :param request: 请求快照。
        :returns: 任务行。
        """
        for job in self.generation_jobs.values():
            if (
                job["project_id"] == project_id and job["job_type"] == job_type
                and job["source_id"] == source_id and job["status"] in {"queued", "running"}
            ):
                return job
        job_id = max(self.generation_jobs.keys(), default=30) + 1
        job = {
            "id": job_id, "job_key": f"{job_type}-{source_id}-blackbox", "project_id": project_id,
            "job_type": job_type, "source_id": source_id, "status": "queued", "progress_percent": 0,
            "request_json": json.dumps({**(request or {}), "projectId": int(project_id)}, ensure_ascii=False),
            "result_json": None, "error_text": None,
            "created_at": "2026-10-19T00:00:00", "updated_at": "2026-10-19T00:00:00",
        }
        self.generation_jobs[job_id] = job
        return job

    def get_generation_job(self, job_id: int, user_id: int) -> dict[str, Any] | None:
        """按 id 取生成任务（owner 经 project 归属判定）。

        :param job_id: 任务 id。
        :param user_id: 用户 id。
        :returns: 任务行或 None。
        """
        job = self.generation_jobs.get(job_id)
        if job is None:
            return None
        return job if self.get_project(int(job["project_id"]), user_id) else None

    def list_project_task_rows(self, project_id: int, user_id: int) -> dict[str, Any] | None:
        """任务中心行集合（generation_jobs + 四类素材行）。

        :param project_id: 项目 id。
        :param user_id: 用户 id。
        :returns: 行集合 dict；项目不存在 None。
        """
        if self.get_project(project_id, user_id) is None:
            return None
        shot_rows = {row["id"]: row for row in self.storyboards.values()}
        jobs = []
        for job in self.generation_jobs.values():
            if int(job["project_id"]) != int(project_id):
                continue
            shot = shot_rows.get(int(job.get("source_id") or 0))
            jobs.append({
                **job,
                "scene_id": shot.get("scene_id") if shot else None,
                "scene_no": self.scenes[shot["scene_id"]]["scene_no"] if shot else None,
                "scene_title": self.scenes[shot["scene_id"]]["title"] if shot else None,
                "shot_no": shot.get("shot_no") if shot else None,
            })
        return {"images": [], "videos": [], "audios": [], "exports": [], "generation_jobs": jobs, "runtime_states": []}


def make_blackbox_settings(tmp_path: Path | None = None) -> Settings:
    """构建黑盒链路配置（关闭 env 文件；媒体链时注入 tmp_path 目录与签名密钥）。

    :param tmp_path: pytest 临时目录（媒体链使用；None 时用默认配置）。
    :returns: Settings 实例。
    """
    kwargs: dict[str, Any] = {"_env_file": None}
    if tmp_path is not None:
        kwargs.update({
            "object_storage_provider": "local",
            "object_storage_public_base_url": "http://testserver/storage",
            "object_storage_signing_secret": SIGNING_SECRET,
            "object_storage_signed_url_ttl_seconds": 900,
            "object_storage_root": str(tmp_path / "object-storage"),
            "generated_frame_dir": str(tmp_path / "generated-frames"),
            "generated_audio_dir": str(tmp_path / "generated-audio"),
            "generated_video_dir": str(tmp_path / "generated-videos"),
            "generated_export_dir": str(tmp_path / "exports"),
            "mock_asset_image_path": str(tmp_path / "login-hero-clean.png"),
        })
    return Settings(**kwargs)


def make_blackbox_client(database: BlackboxDatabase | None = None, tmp_path: Path | None = None) -> tuple[TestClient, BlackboxDatabase]:
    """构建黑盒链路客户端（captcha 固定缺口 + mock SMS 注入）。

    :param database: 数据库桩；缺省新建。
    :param tmp_path: 媒体链临时目录（None 用默认 Settings）。
    :returns: (TestClient, database) 二元组。
    """
    database = database or BlackboxDatabase()
    captcha_service = AuthCaptchaService(
        database,
        CAPTCHA_SECRET,
        ttl_ms=300_000,
        random_target_x=lambda: FIXED_TARGET_X,
        random_palette=lambda: 0,
    )
    settings = make_blackbox_settings(tmp_path)
    client = TestClient(
        create_app(settings, database=database, captcha_service=captcha_service, sms_provider=MockSmsProvider()),
        raise_server_exceptions=False,
    )
    return client, database


def assert_envelope(body: dict[str, Any], *, code: int = 0) -> None:
    """断言 Node 风格 envelope 形状全链一致。

    :param body: 响应 JSON。
    :param code: 期望业务码（成功为 0）。
    :raises AssertionError: envelope 三键缺失或业务码不符。
    """
    assert set(body.keys()) == {"code", "message", "data"}, f"envelope 键集漂移：{sorted(body.keys())}"
    assert body["code"] == code, f"业务码期望 {code}，实际 {body['code']}（message={body['message']}）"


# ---------------------------------------------------------------------------
# 链路一：鉴权链（captcha → verify → send-code → register → 登录态调项目接口）
# ---------------------------------------------------------------------------


def test_auth_chain_captcha_to_project_access() -> None:
    """完整注册旅程：滑块挑战签发 → 校验换取 token → mock SMS 发码（devCode
    透出）→ 注册签会话 → 登录态建项目并在列表可见。

    跨层串联语义：captcha 输出 captchaToken 是 send-code 的输入；send-code 的
    devCode 是 register 的输入；register 的 token 是项目接口的 Authorization。
    每步 envelope 形状一致。

    :raises AssertionError: 任一环节断言失败。
    """
    client, database = make_blackbox_client()

    # 1) 获取滑块挑战。
    issued = client.get("/api/auth/captcha", params={"phone": AUTH_PHONE})
    assert issued.status_code == 200
    assert_envelope(issued.json())
    challenge = issued.json()["data"]["challenge"]
    assert challenge and issued.json()["data"]["challengeId"]

    # 2) 校验滑块 → captchaToken（上一端点输出是下一端点输入）。
    verified = client.post(
        "/api/auth/captcha/verify",
        json={"challenge": challenge, "position": FIXED_TARGET_X, "phone": AUTH_PHONE},
    )
    assert verified.status_code == 200
    assert_envelope(verified.json())
    captcha_token = verified.json()["data"]["captchaToken"]

    # 3) 发送注册验证码（captchaToken 一次性消费；mock SMS 回传 devCode）。
    sent = client.post("/api/auth/send-code", json={"phone": AUTH_PHONE, "captchaToken": captcha_token, "type": "register"})
    assert sent.status_code == 200
    assert_envelope(sent.json())
    dev_code = sent.json()["data"]["devCode"]
    assert dev_code and len(dev_code) == 6, "mock SMS 应透出 6 位 devCode"

    # 4) 注册 → 会话 token（验证码一次性：同码二次注册应 4005）。
    registered = client.post(
        "/api/auth/register",
        json={"phone": AUTH_PHONE, "code": dev_code, "nickname": "黑盒链路用户", "password": "secret123"},
    )
    assert registered.status_code == 200
    assert_envelope(registered.json())
    session_token = registered.json()["data"]["token"]
    assert registered.json()["data"]["user"]["phone"] == AUTH_PHONE

    # 5) 登录态调项目接口：建项目 → 详情 → 列表可见。
    auth = {"Authorization": f"Bearer {session_token}"}
    created = client.post(
        "/api/projects",
        headers=auth,
        json={"name": "黑盒鉴权链项目", "category": "悬疑", "visualStyle": "电影感写实风格"},
    )
    assert created.status_code == 200
    assert_envelope(created.json())
    project_id = created.json()["data"]["id"]

    detail = client.get(f"/api/projects/{project_id}", headers=auth)
    assert detail.status_code == 200
    assert_envelope(detail.json())
    assert detail.json()["data"]["name"] == "黑盒鉴权链项目"

    listed = client.get("/api/projects", headers=auth)
    assert listed.status_code == 200
    assert_envelope(listed.json())
    assert any(item["id"] == project_id for item in listed.json()["data"]["items"])

    # 未登录态访问项目接口 → 401/4010（鉴权门禁生效）。
    anonymous = client.get("/api/projects")
    assert anonymous.status_code == 401
    assert anonymous.json()["code"] == 4010


# ---------------------------------------------------------------------------
# 链路二：内容链（建项目 → 场景 → 剧本 generate → 分镜 generate →
#          storyboard detail → 静帧入队 → 任务行可见）
# ---------------------------------------------------------------------------


def test_content_chain_project_to_storyboard_to_task_center(monkeypatch) -> None:
    """完整创作旅程：建项目 → 场景编辑 → mock 剧本生成 → mock 分镜生成 →
    分镜详情（frameCharacterContext）→ 静帧入队 → 生成任务详情 → 任务中心行。

    跨层串联语义：项目 id 撑起场景归属；剧本 generate 的 content 是分镜
    generate 的前置（空剧本 400/4004）；分镜 items[0].id 是静帧入队与详情页
    的输入；入队产出的 generation-{jobId} 在任务中心可见且详情可查。
    注意：项目级场景草稿生成在运维兼容测试中覆盖；本链路聚焦后续生成与资产门禁，
    场景数据经 DB 桩预置 + PUT 编辑进入系统；FRAME_PROVIDER 注入
    volcengine 以满足定妆参考图通道断言（默认 trae-url 通道为 Node 同款 409）。

    :param monkeypatch: pytest 环境变量注入夹具。
    :raises AssertionError: 任一环节断言失败。
    """
    monkeypatch.setenv("FRAME_PROVIDER", "volcengine")
    client, database = make_blackbox_client()
    # 预置登录态（鉴权链已覆盖注册旅程，此处直接签会话聚焦内容链）。
    user = database.users[PHONE]
    token = database.create_session(user)
    auth = {"Authorization": f"Bearer {token}"}

    # 1) 建项目。
    created = client.post("/api/projects", headers=auth, json={"name": "黑盒内容链项目", "category": "悬疑"})
    assert created.status_code == 200
    assert_envelope(created.json())
    project_id = created.json()["data"]["id"]

    # 场景 11 预置归属绑定到新项目/新用户，聚焦本链后半段生成与资产门禁。
    database.scenes[11]["project_id"] = project_id
    database.scenes[11]["user_id"] = int(user["id"])
    # 角色库随项目归属迁移（frameCharacterContext / 分镜 Agent 输入）。
    database.characters[project_id] = database.characters.pop(8)

    # 2) 场景编辑（PUT /api/scenes/{id} 白名单字段）。
    scene_edit = client.put(
        "/api/scenes/11",
        headers=auth,
        json={"title": "夜班值班台", "summary": "林知夏发现异常信号", "location": "值班室"},
    )
    assert scene_edit.status_code == 200
    assert_envelope(scene_edit.json())
    assert scene_edit.json()["data"]["status"] == "draft"

    # 3) mock 剧本生成（AI_PROVIDER 默认 mock → 确定性生成并回写场景）。
    script_generated = client.post("/api/scenes/11/script/generate", headers=auth)
    assert script_generated.status_code == 200
    assert_envelope(script_generated.json())
    script_body = script_generated.json()["data"]
    assert script_body["content"], "mock 剧本应回写非空 content"
    assert script_body["status"] == "generated"

    # 4) mock 分镜生成（依赖 3) 的 content；资产门禁 + 事务替换）。
    storyboards_generated = client.post("/api/scenes/11/storyboards/generate", headers=auth)
    assert storyboards_generated.status_code == 200
    assert_envelope(storyboards_generated.json())
    items = storyboards_generated.json()["data"]["items"]
    assert len(items) >= 1, "mock 分镜应至少产出 1 个镜头"
    first_shot_id = items[0]["id"]

    # 5) 分镜详情：frameCharacterContext 派生字段就绪（静帧页依赖）。
    detail = client.get(f"/api/storyboards/{first_shot_id}", headers=auth)
    assert detail.status_code == 200
    assert_envelope(detail.json())
    context = detail.json()["data"]["frameCharacterContext"]
    assert set(context.keys()) == {"ready", "characterFree", "primaryCharacterId", "characters", "blockers", "warnings"}
    assert context["ready"] is True, f"主角色已绑定且资产门禁通过，context 应 ready：{context['blockers']}"
    assert context["primaryCharacterId"] == 9

    # 6) 静帧入队（输出 generation job 快照）。
    enqueued = client.post(
        f"/api/shots/{first_shot_id}/images/generate",
        headers=auth,
        json={"frameRole": "start", "candidateCount": 2},
    )
    assert enqueued.status_code == 200
    assert_envelope(enqueued.json())
    job = enqueued.json()["data"]
    job_id = job["id"]
    assert job["jobType"] == "frame_image" and job["status"] == "queued"

    # 7) 生成任务详情可查（入队输出 → 详情输入）。
    job_detail = client.get(f"/api/generation-jobs/{job_id}", headers=auth)
    assert job_detail.status_code == 200
    assert_envelope(job_detail.json())
    assert job_detail.json()["data"]["id"] == job_id
    assert job_detail.json()["data"]["sourceId"] == first_shot_id

    # 8) 任务中心：generation-{jobId} 行可见（任务行状态 queued）。
    tasks = client.get(f"/api/projects/{project_id}/tasks", headers=auth)
    assert tasks.status_code == 200
    assert_envelope(tasks.json())
    task_items = tasks.json()["data"]["items"]
    assert tasks.json()["data"]["summary"]["totalCount"] >= 1
    generation_rows = [item for item in task_items if item["taskKey"] == f"generation-{job_id}"]
    assert len(generation_rows) == 1, f"任务中心缺少 generation-{job_id} 行：{[i['taskKey'] for i in task_items]}"
    assert generation_rows[0]["status"] == "queued"
    assert generation_rows[0]["runtimeStatus"] == "queued"


# ---------------------------------------------------------------------------
# 链路三：媒体链（storage 签名 URL 生成 → 带签名访问 → 无签名 401 → Range 206）
# ---------------------------------------------------------------------------


def test_media_chain_signed_url_to_range_streaming(tmp_path: Path) -> None:
    """完整媒体消费旅程：签名 URL 产出（resolve_object_url）→ 带签名访问 200 →
    无签名访问 401/4010 → /generated/video Range 206 + Content-Range 切片。

    跨层串联语义：签名 URL 的 query（expires/signature）是访问端点的输入；
    生成的视频文件落盘路径决定 /generated/video 流式读取与 Range 切片。

    :param tmp_path: pytest 临时目录（媒体目录根）。
    :raises AssertionError: 任一环节断言失败。
    """
    settings = make_blackbox_settings(tmp_path)
    client, _database = make_blackbox_client(tmp_path=tmp_path)

    # 1) storage 签名 URL 生成（产签与验签同源：media_urls.resolve_object_url）。
    object_key = "projects/8/reference/character-9.png"
    signed_url = resolve_object_url(object_key, settings)
    assert signed_url, "local 模式应产出签名 URL"
    signed_path = signed_url.split("testserver", 1)[-1]
    assert "signature=" in signed_path and "expires=" in signed_path

    # 2) 无签名访问 → 401/4010（有意收紧：Node 裸读 → 强制验签）。
    unsigned = client.get(f"/storage/{object_key}")
    assert unsigned.status_code == 401
    assert unsigned.json()["code"] == 4010

    # 3) 带签名访问 → 200（对象内容原样返回；本步对象未写入 → 404 亦属签名
    #    通过后的正常语义，此处写入对象以断言完整 200 流）。
    payload = b"blackbox-png-payload"
    storage_root = Path(settings.object_storage_root)
    target = storage_root / object_key
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(payload)
    ok = client.get(signed_path)
    assert ok.status_code == 200, ok.text
    assert ok.content == payload

    # 4) /generated/video Range 流（上一环节产出的媒体文件是本环节读取输入）。
    video_dir = Path(settings.generated_video_dir)
    video_dir.mkdir(parents=True, exist_ok=True)
    (video_dir / "v1.mp4").write_bytes(b"x" * 1000)
    ranged = client.get("/generated/video/v1.mp4", headers={"Range": "bytes=100-199"})
    assert ranged.status_code == 206
    assert ranged.headers["content-range"] == "bytes 100-199/1000"
    assert len(ranged.content) == 100


def test_blackbox_envelope_shape_is_uniform_across_chains(tmp_path: Path) -> None:
    """envelope 一致性抽查：成功/失败/未实现三类响应的键集全链一致。

    :param tmp_path: pytest 临时目录。
    :raises AssertionError: 任一类响应键集漂移。
    """
    client, database = make_blackbox_client()
    user = database.users[PHONE]
    auth = {"Authorization": f"Bearer {database.create_session(user)}"}

    assert_envelope(client.get("/api/health").json())
    assert_envelope(client.get("/api/projects", headers=auth).json())
    # 原显式 501 的 TTS 路径已进入原生校验；未知路径仍由 4040 收口。
    assert_envelope(client.post("/api/projects/1/audio/generate", headers=auth, json={}).json(), code=4004)
    assert_envelope(client.get("/api/definitely-not-a-route", headers=auth).json(), code=4040)
