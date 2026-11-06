from __future__ import annotations

import hashlib
import json
import re
import secrets
from datetime import datetime, timezone
from typing import Any

import pymysql
from pymysql.cursors import DictCursor

from .domain.workflow_gates import create_script_fingerprint, find_scene_node_match


def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


def _as_id(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _repair_video_retry_request(cursor: Any, job: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    if job.get("job_type") != "video_image":
        return request
    keys = [value for value in request.get("referenceImageStorageKeys", []) if value] if isinstance(request.get("referenceImageStorageKeys"), list) else []
    images = [value for value in request.get("referenceImages", []) if value] if isinstance(request.get("referenceImages"), list) else []
    if len(keys) >= 2 and len(images) >= 2:
        return request

    cursor.execute(
        """SELECT sb.asset_reference_json
           FROM storyboards sb INNER JOIN script_scenes sc ON sc.id = sb.scene_id
           WHERE sb.id = %s AND sc.project_id = %s LIMIT 1""",
        (job["source_id"], job["project_id"]),
    )
    shot = cursor.fetchone() or {}
    reference = shot.get("asset_reference_json") or {}
    if isinstance(reference, str):
        try:
            reference = json.loads(reference)
        except (TypeError, ValueError):
            reference = {}
    if not isinstance(reference, dict):
        reference = {}
    node_ids = [value for value in (_as_id(reference.get("characterId")), _as_id(reference.get("sceneAssetId"))) if value]
    if not node_ids:
        return request
    placeholders = ", ".join(["%s"] * len(node_ids))
    cursor.execute(
        f"""SELECT ai.id, ai.storage_key, ai.image_url, ai.thumbnail_url,
                   ai.view_key, ai.view_set_type, ai.status, ai.vision_status, an.node_type
            FROM asset_node_images ai INNER JOIN asset_nodes an ON an.id = ai.asset_node_id
            WHERE ai.asset_node_id IN ({placeholders}) AND ai.status = 'confirmed'
              AND ((an.node_type = 'character' AND ai.view_set_type = 'character-asset-pack')
                OR (an.node_type IN ('prop', 'tool', 'material') AND ai.view_set_type = 'single' AND ai.view_key IS NULL)
                OR an.node_type = 'scene')
              AND (ai.vision_status = 'passed' OR ai.vision_status IS NULL
                OR (an.node_type = 'scene' AND ai.vision_status = 'skipped'))
            ORDER BY ai.id ASC""",
        node_ids,
    )
    asset_rows = list(cursor.fetchall())
    order = {"front": 0, "side": 1, "back": 2}
    character_views = sorted(
        [row for row in asset_rows if row.get("node_type") == "character" and row.get("view_key") in order],
        key=lambda row: order[row["view_key"]],
    )
    selected = [
        *[row for row in asset_rows if row.get("node_type") == "character" and row.get("view_set_type") in {"single", "character-asset-pack"} and not str(row.get("view_key") or "").strip()],
        *character_views,
        *[row for row in asset_rows if row.get("node_type") == "character" and row.get("view_set_type") == "character-face-closeup" and row.get("view_key") == "face"],
        *[row for row in asset_rows if row.get("node_type") == "character" and row.get("view_set_type") == "character-asset-pack"],
        *[row for row in asset_rows if row.get("node_type") == "scene" and not str(row.get("view_key") or "").strip() and row.get("view_set_type") == "single"],
        *[row for row in asset_rows if row.get("node_type") == "scene" and str(row.get("view_key") or "") == str(reference.get("sceneViewKey") or "")],
    ]
    unique: list[dict[str, Any]] = []
    for row in selected:
        storage_key = row.get("storage_key")
        if storage_key and any(item.get("storage_key") == storage_key for item in unique):
            continue
        if row.get("storage_key") or row.get("image_url") or row.get("thumbnail_url"):
            unique.append(row)
        if len(unique) == 6:
            break
    if len(unique) < 2:
        return request
    return {
        **request,
        "referenceImages": [row.get("image_url") or row.get("thumbnail_url") for row in unique if row.get("image_url") or row.get("thumbnail_url")],
        "referenceImageStorageKeys": [row["storage_key"] for row in unique if row.get("storage_key")],
        "providerReferenceImages": [],
    }


def _retry_request_snapshot(job: dict[str, Any]) -> str:
    request = job.get("request_json") or {}
    if isinstance(request, str):
        try:
            request = json.loads(request)
        except (TypeError, ValueError):
            request = {}
    if not isinstance(request, dict):
        request = {}
    tasks = request.get("providerTasks")
    tasks = tasks if isinstance(tasks, list) else []
    request["providerTasks"] = [
        task for task in tasks
        if isinstance(task, dict)
        and str(task.get("videoId") or "").strip()
        and str(task.get("status") or "").strip().lower() != "failed"
        and (str(task.get("status") or "").strip().lower() != "succeeded" or re.match(r"^https?://", str(task.get("videoUrl") or "").strip(), re.I))
    ]
    request.pop("providerTaskId", None)
    if not request["providerTasks"]:
        request.pop("providerReferenceImages", None)
    return json.dumps(request, ensure_ascii=False)


class MySQLDatabase:
    def __init__(self, settings: Any):
        self.settings = settings

    @staticmethod
    def workflow_asset_nodes_query() -> str:
        return """SELECT n.id, n.node_type, n.ref_id, n.group_key, n.label, n.status,
                          MAX(CASE WHEN ai.status = 'confirmed'
                                    AND ai.image_url NOT LIKE '%%/mock-assets/%%'
                                    AND (ai.model_name IS NULL OR ai.model_name NOT LIKE 'mock-%%')
                                    AND (ai.vision_status = 'passed'
                                         OR (n.node_type = 'scene' AND ai.vision_status = 'skipped')
                                         OR ai.vision_status IS NULL OR ai.vision_status = '')
                                   THEN 1 ELSE 0 END) AS has_confirmed_image
                   FROM asset_nodes n LEFT JOIN asset_node_images ai ON ai.asset_node_id = n.id
                   WHERE n.project_id = %s AND n.status <> 'archived'
                   GROUP BY n.id, n.node_type, n.ref_id, n.group_key, n.label, n.status"""

    def _connection(self):
        return pymysql.connect(
            host=self.settings.mysql_host,
            port=self.settings.mysql_port,
            user=self.settings.mysql_user,
            password=self.settings.mysql_password,
            database=self.settings.mysql_database,
            charset="utf8mb4",
            cursorclass=DictCursor,
            autocommit=False,
            connect_timeout=self.settings.mysql_connect_timeout,
            read_timeout=self.settings.mysql_read_timeout,
            write_timeout=self.settings.mysql_write_timeout,
        )

    def health(self) -> bool:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                return cursor.fetchone() is not None
        finally:
            connection.close()

    def fetch_user_by_phone(self, phone: str) -> dict[str, Any] | None:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id, phone, nickname, password_hash FROM users WHERE phone = %s LIMIT 1",
                    (phone,),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def create_session(self, user: dict[str, Any]) -> str:
        token = secrets.token_hex(16)
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO sessions (token, user_id, phone) VALUES (%s, %s, %s)",
                    (token, user["id"], user["phone"]),
                )
            connection.commit()
            return token
        finally:
            connection.close()

    def find_user_by_token(self, token: str) -> dict[str, Any] | None:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT u.id, u.phone, u.nickname, u.created_at AS createdAt
                       FROM sessions s INNER JOIN users u ON u.id = s.user_id
                       WHERE s.token = %s AND s.revoked_at IS NULL LIMIT 1""",
                    (token,),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def list_projects(self, user_id: int) -> list[dict[str, Any]]:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT p.*,
                              (SELECT COUNT(*) FROM story_outlines o WHERE o.project_id = p.id) AS outline_count,
                              (SELECT COUNT(*) FROM script_scenes sc WHERE sc.project_id = p.id) AS scene_count,
                              (SELECT COUNT(*) FROM storyboards sb INNER JOIN script_scenes sc ON sc.id = sb.scene_id WHERE sc.project_id = p.id) AS storyboard_count,
                              (SELECT COUNT(*) FROM image_assets ia INNER JOIN storyboards sb ON sb.id = ia.storyboard_id INNER JOIN script_scenes sc ON sc.id = sb.scene_id WHERE sc.project_id = p.id AND ia.status = 'confirmed') AS confirmed_image_count,
                              (SELECT COUNT(*) FROM video_assets va INNER JOIN storyboards sb ON sb.id = va.storyboard_id INNER JOIN script_scenes sc ON sc.id = sb.scene_id WHERE sc.project_id = p.id AND va.status = 'confirmed') AS confirmed_video_count,
                              (SELECT COUNT(*) FROM audio_assets aa WHERE aa.project_id = p.id AND aa.status = 'confirmed') AS confirmed_audio_count,
                              latest_export.id AS latest_export_id,
                              latest_export.video_url AS latest_export_video_url,
                              latest_export.duration_seconds AS latest_export_duration_seconds,
                              latest_export.created_at AS latest_export_created_at
                       FROM projects p
                       LEFT JOIN export_records latest_export
                         ON latest_export.id = (
                            SELECT er.id FROM export_records er
                            WHERE er.project_id = p.id AND er.status = 'completed'
                            ORDER BY er.id DESC LIMIT 1
                         )
                       WHERE p.user_id = %s ORDER BY p.created_at DESC, p.id DESC""",
                    (user_id,),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def create_project(self, user_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """INSERT INTO projects
                       (user_id, name, category, target_duration, narrative_vision, visual_style, aspect_ratio, status)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, 'draft')""",
                    (
                        user_id,
                        payload["name"],
                        payload.get("category"),
                        payload.get("targetDuration"),
                        payload.get("narrativeVision"),
                        payload.get("visualStyle"),
                        payload.get("aspectRatio"),
                    ),
                )
                project_id = cursor.lastrowid
                cursor.execute("SELECT * FROM projects WHERE id = %s LIMIT 1", (project_id,))
                project = cursor.fetchone()
            connection.commit()
            return project
        finally:
            connection.close()

    def get_project(self, project_id: int, user_id: int) -> dict[str, Any] | None:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM projects WHERE id = %s AND user_id = %s LIMIT 1",
                    (project_id, user_id),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def list_active_voice_profiles(self) -> list[dict[str, Any]]:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM voice_profiles WHERE status = 'active' ORDER BY sort_order ASC, profile_key ASC"
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def _latest_project_record(self, table: str, project_id: int, user_id: int) -> dict[str, Any]:
        if table not in {"story_outlines", "story_bibles", "season_structures"}:
            raise ValueError("Unsupported project record table")
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"""SELECT p.id AS owner_project_id, o.*
                        FROM projects p
                        LEFT JOIN {table} o
                          ON o.project_id = p.id
                         AND o.id = (
                             SELECT latest.id FROM {table} latest
                             WHERE latest.project_id = p.id
                             ORDER BY latest.version_no DESC, latest.id DESC LIMIT 1
                         )
                        WHERE p.id = %s AND p.user_id = %s LIMIT 1""",
                    (project_id, user_id),
                )
                row = cursor.fetchone()
                if row is None:
                    return {"outcome": "not_found", "item": None}
                row.pop("owner_project_id", None)
                return {"outcome": "found", "item": row if row.get("id") is not None else None}
        finally:
            connection.close()

    def latest_outline(self, project_id: int, user_id: int) -> dict[str, Any]:
        result = self._latest_project_record("story_outlines", project_id, user_id)
        return {"outcome": result["outcome"], "outline": result["item"]}

    def latest_story_bible(self, project_id: int, user_id: int) -> dict[str, Any]:
        return self._latest_project_record("story_bibles", project_id, user_id)

    def latest_season_structure(self, project_id: int, user_id: int) -> dict[str, Any]:
        return self._latest_project_record("season_structures", project_id, user_id)

    def update_project(self, project_id: int, user_id: int, updates: dict[str, Any]) -> dict[str, Any] | None:
        columns = {"name": "name", "category": "category", "narrativeVision": "narrative_vision", "visualStyle": "visual_style", "aspectRatio": "aspect_ratio"}
        safe_updates = {columns[key]: value for key, value in updates.items() if key in columns}
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                if safe_updates:
                    assignments = ", ".join(f"{column} = %s" for column in safe_updates)
                    cursor.execute(
                        f"UPDATE projects SET {assignments}, updated_at = NOW() WHERE id = %s AND user_id = %s",
                        (*safe_updates.values(), project_id, user_id),
                    )
                cursor.execute("SELECT * FROM projects WHERE id = %s AND user_id = %s LIMIT 1", (project_id, user_id))
                row = cursor.fetchone()
            connection.commit()
            return row
        finally:
            connection.close()

    def project_assets(self, project_id: int, user_id: int) -> dict[str, Any] | None:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT p.id AS owner_project_id,
                              COALESCE((
                                  SELECT JSON_ARRAYAGG(JSON_OBJECT(
                                      'id', c.id, 'name', c.name, 'role_tag', c.role_tag,
                                      'status', c.status, 'reference_image_url', c.reference_image_url,
                                      'created_at', c.created_at, 'updated_at', c.updated_at
                                  )) FROM characters c
                                  WHERE c.project_id = p.id AND c.status <> 'archived'
                              ), JSON_ARRAY()) AS characters,
                              COALESCE((
                                  SELECT JSON_ARRAYAGG(JSON_OBJECT(
                                      'id', ia.id, 'status', ia.status, 'created_at', ia.created_at,
                                      'scene_id', sc.id,
                                      'scene_no', sc.scene_no, 'scene_title', sc.title,
                                      'storyboard_id', sb.id, 'shot_no', sb.shot_no,
                                      'thumbnail_url', ia.thumbnail_url, 'image_url', ia.image_url,
                                      'version_no', ia.version_no
                                  )) FROM image_assets ia
                                  INNER JOIN storyboards sb ON sb.id = ia.storyboard_id
                                  INNER JOIN script_scenes sc ON sc.id = sb.scene_id
                                  WHERE sc.project_id = p.id AND ia.status <> 'archived'
                              ), JSON_ARRAY()) AS images,
                              COALESCE((
                                  SELECT JSON_ARRAYAGG(JSON_OBJECT(
                                      'id', va.id, 'status', va.status, 'created_at', va.created_at,
                                      'scene_id', sc.id,
                                      'scene_no', sc.scene_no, 'scene_title', sc.title,
                                      'storyboard_id', sb.id, 'shot_no', sb.shot_no,
                                      'thumbnail_url', va.thumbnail_url, 'video_url', va.video_url,
                                      'version_no', va.version_no
                                  )) FROM video_assets va
                                  INNER JOIN storyboards sb ON sb.id = va.storyboard_id
                                  INNER JOIN script_scenes sc ON sc.id = sb.scene_id
                                  WHERE sc.project_id = p.id AND va.status <> 'archived'
                              ), JSON_ARRAY()) AS videos,
                              COALESCE((
                                  SELECT JSON_ARRAYAGG(JSON_OBJECT(
                                      'id', aa.id, 'status', aa.status, 'created_at', aa.created_at,
                                      'scene_id', sc.id,
                                      'scene_no', sc.scene_no, 'scene_title', sc.title,
                                      'storyboard_id', sb.id, 'shot_no', sb.shot_no,
                                      'character_id', aa.character_id, 'character_name', c.name,
                                      'title', aa.title, 'audio_url', aa.audio_url,
                                      'track_type', aa.track_type, 'duration_seconds', aa.duration_seconds,
                                      'voice_name', aa.voice_name, 'confirmed_at', aa.confirmed_at,
                                      'version_no', aa.version_no
                                  )) FROM audio_assets aa
                                  LEFT JOIN script_scenes sc ON sc.id = aa.scene_id
                                  LEFT JOIN storyboards sb ON sb.id = aa.storyboard_id
                                  LEFT JOIN characters c ON c.id = aa.character_id
                                  WHERE aa.project_id = p.id AND aa.status <> 'archived'
                              ), JSON_ARRAY()) AS audios
                       FROM projects p WHERE p.id = %s AND p.user_id = %s LIMIT 1""",
                    (project_id, user_id),
                )
                row = cursor.fetchone()
                if row is None:
                    return None
                assets = {}
                for key in ("characters", "images", "videos", "audios"):
                    value = row.get(key)
                    if isinstance(value, (str, bytes, bytearray)):
                        try:
                            value = json.loads(value)
                        except (TypeError, ValueError):
                            value = []
                    assets[key] = value if isinstance(value, list) else []
                    timestamp_field = "updated_at" if key == "characters" else "created_at"
                    assets[key].sort(
                        key=lambda item: (
                            str(item.get(timestamp_field) or ""),
                            _as_id(item.get("id")) or 0,
                        ),
                        reverse=True,
                    )
                return assets
        finally:
            connection.close()

    def list_project_task_rows(self, project_id: int, user_id: int) -> dict[str, Any] | None:
        """Read task-center sources only after verifying project ownership."""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT id FROM projects WHERE id = %s AND user_id = %s LIMIT 1", (project_id, user_id))
                if cursor.fetchone() is None:
                    return None
                cursor.execute(
                    """SELECT ia.*, sc.id AS scene_id, sc.scene_no, sc.title AS scene_title,
                              sb.id AS storyboard_id, sb.shot_no
                       FROM image_assets ia INNER JOIN storyboards sb ON sb.id = ia.storyboard_id
                       INNER JOIN script_scenes sc ON sc.id = sb.scene_id
                       WHERE sc.project_id = %s ORDER BY ia.created_at DESC, ia.id DESC""",
                    (project_id,),
                )
                images = list(cursor.fetchall())
                cursor.execute(
                    """SELECT va.*, sc.id AS scene_id, sc.scene_no, sc.title AS scene_title,
                              sb.id AS storyboard_id, sb.shot_no
                       FROM video_assets va INNER JOIN storyboards sb ON sb.id = va.storyboard_id
                       INNER JOIN script_scenes sc ON sc.id = sb.scene_id
                       WHERE sc.project_id = %s ORDER BY va.created_at DESC, va.id DESC""",
                    (project_id,),
                )
                videos = list(cursor.fetchall())
                cursor.execute(
                    """SELECT aa.*, sc.scene_no, sc.title AS scene_title, sb.shot_no,
                              c.name AS character_name
                       FROM audio_assets aa LEFT JOIN script_scenes sc ON sc.id = aa.scene_id
                       LEFT JOIN storyboards sb ON sb.id = aa.storyboard_id
                       LEFT JOIN characters c ON c.id = aa.character_id
                       WHERE aa.project_id = %s ORDER BY aa.created_at DESC, aa.id DESC""",
                    (project_id,),
                )
                audios = list(cursor.fetchall())
                cursor.execute(
                    "SELECT * FROM export_records WHERE project_id = %s ORDER BY created_at DESC, id DESC",
                    (project_id,),
                )
                exports = list(cursor.fetchall())
                cursor.execute(
                    """SELECT gj.*, sb.scene_id, sc.scene_no, sc.title AS scene_title, sb.shot_no,
                              c.name AS character_name, an.label AS asset_node_label, an.node_type AS asset_node_type
                       FROM generation_jobs gj
                       LEFT JOIN storyboards sb ON gj.job_type IN ('frame_image', 'video_image', 'lip_sync') AND sb.id = gj.source_id
                       LEFT JOIN script_scenes sc ON sc.id = sb.scene_id
                       LEFT JOIN characters c ON gj.job_type = 'character_image' AND c.id = gj.source_id
                       LEFT JOIN asset_nodes an ON gj.job_type = 'asset_node_image' AND an.id = gj.source_id
                       WHERE gj.project_id = %s ORDER BY gj.created_at DESC, gj.id DESC""",
                    (project_id,),
                )
                generation_jobs = list(cursor.fetchall())
                cursor.execute("SELECT * FROM task_runtime_states WHERE project_id = %s", (project_id,))
                runtime_by_key = {row["task_key"]: row for row in cursor.fetchall()}
                for row in images:
                    row["runtime"] = runtime_by_key.get(f"image-{row['id']}")
                for row in videos:
                    row["runtime"] = runtime_by_key.get(f"video-{row['id']}")
                for row in audios:
                    row["runtime"] = runtime_by_key.get(f"audio-{row['id']}")
                for row in exports:
                    row["runtime"] = runtime_by_key.get(f"export-{row['id']}")
                return {
                    "images": images, "videos": videos, "audios": audios, "exports": exports,
                    "generation_jobs": generation_jobs,
                }
        finally:
            connection.close()

    def apply_mock_task_action(self, task_type: str, source_id: int, user_id: int, action: str) -> dict[str, Any]:
        """Apply a task-center mock retry/cancel after owner and state checks."""
        source_queries = {
            "image": """SELECT sc.project_id, ia.status, ia.image_url AS file_url
                        FROM image_assets ia JOIN storyboards sb ON sb.id = ia.storyboard_id
                        JOIN script_scenes sc ON sc.id = sb.scene_id
                        JOIN projects p ON p.id = sc.project_id
                        WHERE ia.id = %s AND p.user_id = %s FOR UPDATE""",
            "video": """SELECT sc.project_id, va.status, va.video_url AS file_url
                        FROM video_assets va JOIN storyboards sb ON sb.id = va.storyboard_id
                        JOIN script_scenes sc ON sc.id = sb.scene_id
                        JOIN projects p ON p.id = sc.project_id
                        WHERE va.id = %s AND p.user_id = %s FOR UPDATE""",
            "audio": """SELECT aa.project_id, aa.status, aa.audio_url AS file_url
                        FROM audio_assets aa JOIN projects p ON p.id = aa.project_id
                        WHERE aa.id = %s AND p.user_id = %s FOR UPDATE""",
            "export": """SELECT er.project_id, er.status, er.video_url AS file_url
                        FROM export_records er JOIN projects p ON p.id = er.project_id
                        WHERE er.id = %s AND p.user_id = %s FOR UPDATE""",
        }
        query = source_queries.get(task_type)
        if query is None:
            return {"outcome": "not_found"}
        task_key = f"{task_type}-{source_id}"
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(query, (source_id, user_id))
                source = cursor.fetchone()
                if source is None:
                    connection.rollback()
                    return {"outcome": "not_found"}
                cursor.execute(
                    "SELECT runtime_status, progress_percent, updated_at FROM task_runtime_states WHERE task_key = %s FOR UPDATE",
                    (task_key,),
                )
                runtime = cursor.fetchone()
                progress = max(0, min(100, round(float((runtime or {}).get("progress_percent") or 0))))
                if action == "cancel":
                    runtime_status = str((runtime or {}).get("runtime_status") or ("success" if source.get("file_url") else "failed"))
                    updated_at = (runtime or {}).get("updated_at")
                    if runtime is not None and updated_at is not None:
                        elapsed = max(0.0, (datetime.now() - updated_at).total_seconds())
                        if runtime_status == "queued" and elapsed >= 10:
                            runtime_status = "success"
                        elif runtime_status == "queued" and elapsed >= 4:
                            runtime_status = "running"
                        elif runtime_status == "running" and elapsed >= 8:
                            runtime_status = "success"
                    if runtime_status not in {"queued", "running"}:
                        connection.rollback()
                        return {"outcome": "not_cancelable"}
                    target_status = "canceled"
                else:
                    progress = 0
                    target_status = "queued"
                cursor.execute(
                    """INSERT INTO task_runtime_states
                       (task_key, project_id, task_type, source_id, runtime_status, progress_percent, error_text)
                       VALUES (%s, %s, %s, %s, %s, %s, NULL)
                       ON DUPLICATE KEY UPDATE runtime_status = VALUES(runtime_status),
                         progress_percent = VALUES(progress_percent), error_text = NULL,
                         updated_at = CURRENT_TIMESTAMP""",
                    (task_key, source["project_id"], task_type, source_id, target_status, progress),
                )
            connection.commit()
            return {"outcome": "updated", "project_id": int(source["project_id"]), "runtime_status": target_status}
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def archive_project_asset(self, asset_type: str, asset_id: int, user_id: int) -> dict[str, Any] | None:
        """Archive one project asset after checking ownership in the same transaction."""
        table_queries = {
            "character": (
                """SELECT c.id, c.status, p.user_id AS owner_id
                   FROM characters c INNER JOIN projects p ON p.id = c.project_id
                   WHERE c.id = %s LIMIT 1""",
                "characters",
            ),
            "image": (
                """SELECT ia.id, ia.status, p.user_id AS owner_id
                   FROM image_assets ia
                   INNER JOIN storyboards sb ON sb.id = ia.storyboard_id
                   INNER JOIN script_scenes sc ON sc.id = sb.scene_id
                   INNER JOIN projects p ON p.id = sc.project_id
                   WHERE ia.id = %s LIMIT 1""",
                "image_assets",
            ),
            "video": (
                """SELECT va.id, va.status, p.user_id AS owner_id
                   FROM video_assets va
                   INNER JOIN storyboards sb ON sb.id = va.storyboard_id
                   INNER JOIN script_scenes sc ON sc.id = sb.scene_id
                   INNER JOIN projects p ON p.id = sc.project_id
                   WHERE va.id = %s LIMIT 1""",
                "video_assets",
            ),
            "audio": (
                """SELECT aa.id, aa.status, p.user_id AS owner_id
                   FROM audio_assets aa INNER JOIN projects p ON p.id = aa.project_id
                   WHERE aa.id = %s LIMIT 1""",
                "audio_assets",
            ),
        }

    def list_project_audio(self, project_id: int, user_id: int) -> list[dict[str, Any]] | None:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id FROM projects WHERE id = %s AND user_id = %s LIMIT 1",
                    (project_id, user_id),
                )
                if cursor.fetchone() is None:
                    return None
                cursor.execute(
                    """SELECT aa.*,
                              sc.scene_no,
                              sc.title AS scene_title,
                              sb.shot_no,
                              c.name AS character_name
                       FROM audio_assets aa
                       LEFT JOIN script_scenes sc ON sc.id = aa.scene_id
                       LEFT JOIN storyboards sb ON sb.id = aa.storyboard_id
                       LEFT JOIN characters c ON c.id = aa.character_id
                       WHERE aa.project_id = %s
                       ORDER BY CASE aa.track_type
                                  WHEN 'dialogue' THEN 1
                                  WHEN 'narration' THEN 2
                                  WHEN 'music' THEN 3
                                  WHEN 'sfx' THEN 4
                                  ELSE 99
                                END ASC,
                                aa.scene_id ASC,
                                aa.character_id ASC,
                                aa.version_no DESC,
                                aa.id DESC""",
                    (project_id,),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def create_audio_assets(self, project_id: int, user_id: int, values: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
        """Persist one generated candidate batch with a serialized track version."""
        if not values:
            return []
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id FROM projects WHERE id = %s AND user_id = %s LIMIT 1 FOR UPDATE",
                    (project_id, user_id),
                )
                if cursor.fetchone() is None:
                    connection.rollback()
                    return None
                first = values[0]
                cursor.execute(
                    """SELECT COALESCE(MAX(version_no), 0) AS max_version
                       FROM audio_assets
                       WHERE project_id = %s AND track_type = %s
                         AND (scene_id <=> %s) AND (character_id <=> %s)""",
                    (project_id, first.get("track_type"), first.get("scene_id"), first.get("character_id")),
                )
                version_no = int((cursor.fetchone() or {}).get("max_version") or 0) + 1
                inserted_ids = []
                for item in values:
                    audio_url = str(item.get("audio_url") or "").replace("{version}", str(version_no))
                    cursor.execute(
                        """INSERT INTO audio_assets
                           (project_id, track_type, scene_id, storyboard_id, character_id, version_no,
                            start_offset_seconds, title, audio_url, storage_key, duration_seconds,
                            voice_name, model_name, voice_profile_key, voice_instructions, status)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'candidate')""",
                        (
                            project_id, item.get("track_type"), item.get("scene_id"),
                            item.get("storyboard_id"), item.get("character_id"), version_no,
                            item.get("start_offset_seconds", 0), item.get("title"), audio_url,
                            item.get("storage_key"), item.get("duration_seconds"), item.get("voice_name"),
                            item.get("model_name"), item.get("voice_profile_key"), item.get("voice_instructions"),
                        ),
                    )
                    inserted_ids.append(int(cursor.lastrowid))
                placeholders = ", ".join(["%s"] * len(inserted_ids))
                cursor.execute(
                    f"""SELECT aa.*, sc.scene_no, sc.title AS scene_title,
                              sb.shot_no, c.name AS character_name
                       FROM audio_assets aa
                       LEFT JOIN script_scenes sc ON sc.id = aa.scene_id
                       LEFT JOIN storyboards sb ON sb.id = aa.storyboard_id
                       LEFT JOIN characters c ON c.id = aa.character_id
                       WHERE aa.id IN ({placeholders})
                       ORDER BY aa.version_no DESC, aa.id ASC""",
                    tuple(inserted_ids),
                )
                rows = list(cursor.fetchall())
            connection.commit()
            return rows
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()
        if asset_type not in table_queries:
            return None

        query, table = table_queries[asset_type]
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(query, (asset_id,))
                asset = cursor.fetchone()
                if not asset or int(asset["owner_id"]) != int(user_id):
                    return None
                previous_status = str(asset.get("status") or "").strip().lower()
                if previous_status not in {"archived", "confirmed", "finalized", "done"}:
                    cursor.execute(f"UPDATE {table} SET status = 'archived' WHERE id = %s", (asset_id,))
            connection.commit()
            return {"id": int(asset_id), "status": "archived" if previous_status not in {"archived", "confirmed", "finalized", "done"} else previous_status, "previous_status": previous_status}
        finally:
            connection.close()

    def confirm_audio_asset(self, audio_id: int, user_id: int) -> dict[str, Any] | None:
        """Confirm one owned audio candidate and demote the prior track version atomically."""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT aa.*
                       FROM audio_assets aa INNER JOIN projects p ON p.id = aa.project_id
                       WHERE aa.id = %s AND p.user_id = %s LIMIT 1 FOR UPDATE""",
                    (audio_id, user_id),
                )
                audio = cursor.fetchone()
                if audio is None:
                    connection.rollback()
                    return None
                cursor.execute(
                    """UPDATE audio_assets
                       SET status = 'candidate', confirmed_at = NULL
                       WHERE project_id = %s AND track_type = %s
                         AND (scene_id <=> %s) AND (storyboard_id <=> %s)
                         AND (character_id <=> %s) AND id <> %s AND status = 'confirmed'""",
                    (
                        audio["project_id"], audio["track_type"], audio.get("scene_id"),
                        audio.get("storyboard_id"), audio.get("character_id"), audio_id,
                    ),
                )
                cursor.execute(
                    """UPDATE audio_assets SET status = 'confirmed', confirmed_at = NOW()
                       WHERE id = %s""",
                    (audio_id,),
                )
                cursor.execute(
                    """SELECT aa.*, sc.scene_no, sc.title AS scene_title,
                              sb.shot_no, c.name AS character_name
                       FROM audio_assets aa
                       LEFT JOIN script_scenes sc ON sc.id = aa.scene_id
                       LEFT JOIN storyboards sb ON sb.id = aa.storyboard_id
                       LEFT JOIN characters c ON c.id = aa.character_id
                       WHERE aa.id = %s LIMIT 1""",
                    (audio_id,),
                )
                confirmed = cursor.fetchone()
            connection.commit()
            return confirmed
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def archive_audio_asset(self, audio_id: int, user_id: int) -> dict[str, Any]:
        """Archive an owned audio candidate while protecting the confirmed version."""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT aa.id, aa.project_id, aa.status
                       FROM audio_assets aa INNER JOIN projects p ON p.id = aa.project_id
                       WHERE aa.id = %s AND p.user_id = %s LIMIT 1 FOR UPDATE""",
                    (audio_id, user_id),
                )
                audio = cursor.fetchone()
                if audio is None:
                    connection.rollback()
                    return {"outcome": "not_found"}
                if audio.get("status") == "confirmed":
                    connection.rollback()
                    return {"outcome": "protected"}
                cursor.execute("UPDATE audio_assets SET status = 'archived' WHERE id = %s", (audio_id,))
                cursor.execute(
                    """SELECT aa.*, sc.scene_no, sc.title AS scene_title,
                              sb.shot_no, c.name AS character_name
                       FROM audio_assets aa
                       LEFT JOIN script_scenes sc ON sc.id = aa.scene_id
                       LEFT JOIN storyboards sb ON sb.id = aa.storyboard_id
                       LEFT JOIN characters c ON c.id = aa.character_id
                       WHERE aa.id = %s LIMIT 1""",
                    (audio_id,),
                )
                archived = cursor.fetchone()
            connection.commit()
            return {"outcome": "archived", "audio": archived}
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def update_audio_placement(self, audio_id: int, user_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT aa.* FROM audio_assets aa
                       INNER JOIN projects p ON p.id = aa.project_id
                       WHERE aa.id = %s AND p.user_id = %s LIMIT 1 FOR UPDATE""",
                    (audio_id, user_id),
                )
                audio = cursor.fetchone()
                if audio is None:
                    connection.rollback()
                    return {"outcome": "not_found"}

                storyboard_id = audio.get("storyboard_id")
                scene_id = audio.get("scene_id")
                if "storyboardId" in payload:
                    try:
                        storyboard_id = int(payload.get("storyboardId") or 0) or None
                    except (TypeError, ValueError):
                        storyboard_id = None
                    if storyboard_id is not None:
                        cursor.execute(
                            """SELECT sb.id, sb.scene_id FROM storyboards sb
                               INNER JOIN script_scenes sc ON sc.id = sb.scene_id
                               WHERE sb.id = %s AND sc.project_id = %s LIMIT 1""",
                            (storyboard_id, audio["project_id"]),
                        )
                        storyboard = cursor.fetchone()
                        if storyboard is None:
                            connection.rollback()
                            return {"outcome": "storyboard_not_found"}
                        scene_id = storyboard["scene_id"]

                if "startOffsetSeconds" in payload:
                    try:
                        offset = max(0.0, min(60.0, float(payload.get("startOffsetSeconds") or 0)))
                    except (TypeError, ValueError):
                        offset = 0.0
                    cursor.execute(
                        """UPDATE audio_assets SET storyboard_id = %s, scene_id = %s,
                                  start_offset_seconds = %s WHERE id = %s""",
                        (storyboard_id, scene_id, offset, audio_id),
                    )
                else:
                    cursor.execute(
                        "UPDATE audio_assets SET storyboard_id = %s, scene_id = %s WHERE id = %s",
                        (storyboard_id, scene_id, audio_id),
                    )
                cursor.execute(
                    """SELECT aa.*, sc.scene_no, sc.title AS scene_title,
                              sb.shot_no, c.name AS character_name
                       FROM audio_assets aa
                       LEFT JOIN script_scenes sc ON sc.id = aa.scene_id
                       LEFT JOIN storyboards sb ON sb.id = aa.storyboard_id
                       LEFT JOIN characters c ON c.id = aa.character_id
                       WHERE aa.id = %s LIMIT 1""",
                    (audio_id,),
                )
                updated = cursor.fetchone()
            connection.commit()
            return {"outcome": "updated", "audio": updated}
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def confirm_image_asset(self, image_id: int, user_id: int) -> dict[str, Any] | None:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT ia.* FROM image_assets ia
                       INNER JOIN storyboards sb ON sb.id = ia.storyboard_id
                       INNER JOIN script_scenes sc ON sc.id = sb.scene_id
                       INNER JOIN projects p ON p.id = sc.project_id
                       WHERE ia.id = %s AND p.user_id = %s LIMIT 1 FOR UPDATE""",
                    (image_id, user_id),
                )
                image = cursor.fetchone()
                if image is None:
                    connection.rollback()
                    return None
                role_value = str(image.get("frame_role") or "").strip().lower()
                frame_role = role_value if role_value in {"start", "end"} else "primary"
                cursor.execute(
                    """UPDATE image_assets
                       SET status = 'candidate', confirmed_at = NULL
                       WHERE storyboard_id = %s
                         AND CASE WHEN LOWER(TRIM(COALESCE(frame_role, ''))) IN ('start', 'end')
                                  THEN LOWER(TRIM(frame_role)) ELSE 'primary' END = %s
                         AND id <> %s""",
                    (image["storyboard_id"], frame_role, image_id),
                )
                cursor.execute(
                    """UPDATE image_assets SET status = 'confirmed', confirmed_at = NOW()
                       WHERE id = %s""",
                    (image_id,),
                )
                storyboard_column = "end_image_url" if frame_role == "end" else "image_url"
                cursor.execute(
                    f"UPDATE storyboards SET {storyboard_column} = %s, updated_at = NOW() WHERE id = %s",
                    (image.get("image_url"), image["storyboard_id"]),
                )
                cursor.execute("SELECT * FROM image_assets WHERE id = %s LIMIT 1", (image_id,))
                confirmed = cursor.fetchone()
            connection.commit()
            return confirmed
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def list_storyboard_images(self, storyboard_id: int, user_id: int) -> list[dict[str, Any]] | None:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT sb.id
                       FROM storyboards sb
                       INNER JOIN script_scenes sc ON sc.id = sb.scene_id
                       INNER JOIN projects p ON p.id = sc.project_id
                       WHERE sb.id = %s AND p.user_id = %s LIMIT 1""",
                    (storyboard_id, user_id),
                )
                if cursor.fetchone() is None:
                    return None
                cursor.execute(
                    """SELECT * FROM image_assets
                       WHERE storyboard_id = %s
                       ORDER BY version_no DESC, id DESC""",
                    (storyboard_id,),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def reorder_storyboards(self, orders: list[dict[str, int]], user_id: int) -> dict[str, str]:
        ids = [item["id"] for item in orders]
        placeholders = ", ".join(["%s"] * len(ids))
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"""SELECT sb.id, sb.scene_id
                        FROM storyboards sb
                        INNER JOIN script_scenes sc ON sc.id = sb.scene_id
                        INNER JOIN projects p ON p.id = sc.project_id
                        WHERE sb.id IN ({placeholders}) AND p.user_id = %s
                        ORDER BY sb.id FOR UPDATE""",
                    (*ids, user_id),
                )
                rows = list(cursor.fetchall())
                if len(rows) != len(ids):
                    connection.rollback()
                    return {"outcome": "not_found"}
                if len({row["scene_id"] for row in rows}) != 1:
                    connection.rollback()
                    return {"outcome": "cross_scene"}
                for item in orders:
                    cursor.execute(
                        "UPDATE storyboards SET sort_order = %s, updated_at = NOW() WHERE id = %s",
                        (item["sortOrder"], item["id"]),
                    )
            connection.commit()
            return {"outcome": "updated"}
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def list_scenes(self, project_id: int, user_id: int) -> list[dict[str, Any]] | None:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT sc.*
                       FROM script_scenes sc
                       INNER JOIN projects p ON p.id = sc.project_id
                       WHERE sc.project_id = %s AND p.user_id = %s
                       ORDER BY sc.sort_order ASC, sc.scene_no ASC, sc.id ASC""",
                    (project_id, user_id),
                )
                rows = list(cursor.fetchall())
                cursor.execute("SELECT id FROM projects WHERE id = %s AND user_id = %s LIMIT 1", (project_id, user_id))
                return rows if cursor.fetchone() else None
        finally:
            connection.close()

    def get_project_workflow_readiness_context(self, project_id: int, user_id: int) -> dict[str, Any] | None:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT id FROM projects WHERE id = %s AND user_id = %s LIMIT 1", (project_id, user_id))
                if cursor.fetchone() is None:
                    return None
                cursor.execute(
                    """SELECT id, episode_no, scene_no, title, summary, content, time_of_day
                       FROM script_scenes WHERE project_id = %s
                       ORDER BY episode_no ASC, sort_order ASC, scene_no ASC, id ASC""",
                    (project_id,),
                )
                scenes = list(cursor.fetchall())
                cursor.execute(
                    "SELECT parsed_script_fingerprint FROM project_workflow_states WHERE project_id = %s LIMIT 1",
                    (project_id,),
                )
                state = cursor.fetchone() or {}
                cursor.execute(
                    "SELECT id FROM characters WHERE project_id = %s AND status <> 'archived'",
                    (project_id,),
                )
                characters = list(cursor.fetchall())
                cursor.execute(self.workflow_asset_nodes_query(), (project_id,))
                return {
                    "scenes": scenes,
                    "parsed_fingerprint": state.get("parsed_script_fingerprint") or "",
                    "characters": characters,
                    "asset_nodes": list(cursor.fetchall()),
                }
        finally:
            connection.close()

    def persist_parsed_script_fingerprint(self, project_id: int, user_id: int) -> str:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT id FROM projects WHERE id = %s AND user_id = %s FOR UPDATE", (project_id, user_id))
                if cursor.fetchone() is None:
                    connection.rollback()
                    return "not_found"
                cursor.execute(
                    """SELECT id, episode_no, scene_no, title, summary, content, time_of_day
                       FROM script_scenes WHERE project_id = %s
                       ORDER BY episode_no ASC, sort_order ASC, scene_no ASC, id ASC""",
                    (project_id,),
                )
                scenes = list(cursor.fetchall())
                if not scenes or any(not str(scene.get("content") or "").strip() for scene in scenes):
                    connection.rollback()
                    return "script_incomplete"
                cursor.execute("SELECT id FROM characters WHERE project_id = %s AND status <> 'archived'", (project_id,))
                characters = list(cursor.fetchall())
                cursor.execute(
                    "SELECT node_type, ref_id, group_key, label FROM asset_nodes WHERE project_id = %s AND status <> 'archived'",
                    (project_id,),
                )
                nodes = list(cursor.fetchall())
                missing_character = any(not any(
                    node.get("node_type") == "character" and int(node.get("ref_id") or 0) == int(character["id"])
                    for node in nodes
                ) for character in characters)
                missing_scene = any(not any(
                    find_scene_node_match(node, [scene]) is not None for node in nodes if node.get("node_type") == "scene"
                ) for scene in scenes)
                if missing_character or missing_scene:
                    connection.rollback()
                    return "assets_incomplete"
                fingerprint = create_script_fingerprint(scenes)
                cursor.execute(
                    """INSERT INTO project_workflow_states (project_id, parsed_script_fingerprint, parsed_at)
                       VALUES (%s, %s, NOW())
                       ON DUPLICATE KEY UPDATE parsed_script_fingerprint = VALUES(parsed_script_fingerprint), parsed_at = NOW()""",
                    (project_id, fingerprint),
                )
            connection.commit()
            return "saved"
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def generate_project_scenes(
        self, project_id: int, user_id: int, outline_id: int | None, specs: list[dict[str, Any]]
    ) -> list[dict[str, Any]] | None:
        """在项目行锁内原子创建场景草稿；已有场景时不覆盖任何用户数据。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id FROM projects WHERE id = %s AND user_id = %s FOR UPDATE",
                    (project_id, user_id),
                )
                if cursor.fetchone() is None:
                    connection.rollback()
                    return None
                cursor.execute("SELECT id FROM script_scenes WHERE project_id = %s LIMIT 1", (project_id,))
                if cursor.fetchone() is not None:
                    connection.rollback()
                    return None
                for index, spec in enumerate(specs):
                    cursor.execute(
                        """INSERT INTO script_scenes
                           (project_id, episode_no, outline_id, scene_no, title, summary, location,
                            time_of_day, estimated_duration, sort_order, status)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'draft')""",
                        (project_id, spec["episode_no"], outline_id, spec["scene_no"], spec["title"],
                         spec["summary"], spec.get("location"), spec.get("time_of_day"),
                         spec["estimated_duration"], index),
                    )
                cursor.execute(
                    "UPDATE projects SET status = 'scripting', updated_at = NOW() WHERE id = %s AND user_id = %s",
                    (project_id, user_id),
                )
                cursor.execute(
                    """SELECT * FROM script_scenes WHERE project_id = %s
                       ORDER BY episode_no ASC, sort_order ASC, scene_no ASC, id ASC""",
                    (project_id,),
                )
                rows = list(cursor.fetchall())
            connection.commit()
            return rows
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def get_scene(self, scene_id: int, user_id: int) -> dict[str, Any] | None:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT sc.*
                       FROM script_scenes sc
                       INNER JOIN projects p ON p.id = sc.project_id
                       WHERE sc.id = %s AND p.user_id = %s LIMIT 1""",
                    (scene_id, user_id),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def update_scene(self, scene_id: int, user_id: int, updates: dict[str, Any]) -> dict[str, Any] | None:
        """Update an owned scene using a caller-validated column map."""
        allowed_columns = {
            "title": "title",
            "summary": "summary",
            "location": "location",
            "time_of_day": "time_of_day",
            "estimated_duration": "estimated_duration",
        }
        safe_updates = {
            allowed_columns[key]: value
            for key, value in updates.items()
            if key in allowed_columns
        }
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT sc.*
                       FROM script_scenes sc
                       INNER JOIN projects p ON p.id = sc.project_id
                       WHERE sc.id = %s AND p.user_id = %s LIMIT 1""",
                    (scene_id, user_id),
                )
                if cursor.fetchone() is None:
                    return None
                if safe_updates:
                    assignments = ", ".join(f"{column} = %s" for column in safe_updates)
                    cursor.execute(
                        f"UPDATE script_scenes SET {assignments}, updated_at = NOW() WHERE id = %s",
                        (*safe_updates.values(), scene_id),
                    )
                cursor.execute("SELECT * FROM script_scenes WHERE id = %s LIMIT 1", (scene_id,))
                row = cursor.fetchone()
            connection.commit()
            return row
        finally:
            connection.close()

    def update_scene_spatial_anchors(
        self, scene_id: int, project_id: int, user_id: int, manifest_json: str
    ) -> bool:
        """按归属写入场景空间锚点并提交；行不存在或越权返回 False。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """UPDATE script_scenes sc
                       INNER JOIN projects p ON p.id = sc.project_id
                       SET sc.spatial_anchors_json = %s, sc.updated_at = NOW()
                       WHERE sc.id = %s AND sc.project_id = %s AND p.user_id = %s""",
                    (manifest_json, scene_id, project_id, user_id),
                )
                updated = cursor.rowcount > 0
            connection.commit()
            return updated
        finally:
            connection.close()

    def save_scene_script(
        self,
        scene_id: int,
        user_id: int,
        content: str | None,
        mood: str | None,
        title: str | None,
    ) -> dict[str, Any] | None:
        """Save the editable script fields and mark the scene as revised."""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT sc.id
                       FROM script_scenes sc
                       INNER JOIN projects p ON p.id = sc.project_id
                       WHERE sc.id = %s AND p.user_id = %s LIMIT 1""",
                    (scene_id, user_id),
                )
                if cursor.fetchone() is None:
                    return None
                cursor.execute(
                    """UPDATE script_scenes
                       SET content = %s, mood = %s, title = %s, status = 'revised', updated_at = NOW()
                       WHERE id = %s""",
                    (content, mood, title, scene_id),
                )
                cursor.execute("SELECT * FROM script_scenes WHERE id = %s LIMIT 1", (scene_id,))
                row = cursor.fetchone()
            connection.commit()
            return row
        finally:
            connection.close()

    def list_storyboards(self, scene_id: int, user_id: int) -> list[dict[str, Any]] | None:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT sb.*
                       FROM storyboards sb
                       INNER JOIN script_scenes sc ON sc.id = sb.scene_id
                       INNER JOIN projects p ON p.id = sc.project_id
                       WHERE sb.scene_id = %s AND p.user_id = %s
                       ORDER BY sb.sort_order ASC, sb.id ASC""",
                    (scene_id, user_id),
                )
                rows = list(cursor.fetchall())
                cursor.execute(
                    """SELECT sc.id
                       FROM script_scenes sc
                       INNER JOIN projects p ON p.id = sc.project_id
                       WHERE sc.id = %s AND p.user_id = %s LIMIT 1""",
                    (scene_id, user_id),
                )
                return rows if cursor.fetchone() else None
        finally:
            connection.close()

    def get_storyboard(self, storyboard_id: int, user_id: int) -> dict[str, Any] | None:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT sb.*, sc.project_id
                       FROM storyboards sb
                       INNER JOIN script_scenes sc ON sc.id = sb.scene_id
                       INNER JOIN projects p ON p.id = sc.project_id
                       WHERE sb.id = %s AND p.user_id = %s LIMIT 1""",
                    (storyboard_id, user_id),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def get_storyboard_detail(self, storyboard_id: int, user_id: int) -> dict[str, Any] | None:
        """单分镜详情联查（对齐 Node GET /api/storyboards/{id} 的归属查询）。

        与 Node 逐字一致：LEFT JOIN characters 用 ``COALESCE(c.name,
        s.character_name)`` 覆盖 character_name（绑定的角色名优先于快照文本），
        同时带出 project_id 供 frameCharacterContext 的角色库查询使用。

        :param storyboard_id: 分镜 id。
        :param user_id: 当前用户 id（owner 校验）。
        :returns: 分镜行（含 project_id）；分镜不存在或非本人返回 None。
        :raises pymysql.MySQLError: 查询失败时原样抛出（网关兜底 500/5001）。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT s.*,
                              COALESCE(c.name, s.character_name) AS character_name,
                              sc.project_id,
                              p.user_id AS ownerId
                       FROM storyboards s
                       INNER JOIN script_scenes sc ON sc.id = s.scene_id
                       INNER JOIN projects p ON p.id = sc.project_id
                       LEFT JOIN characters c ON c.id = s.character_id
                       WHERE s.id = %s LIMIT 1""",
                    (storyboard_id,),
                )
                row = cursor.fetchone()
                if row is None or int(row.get("ownerId") or 0) != int(user_id):
                    return None
                return row
        finally:
            connection.close()

    def list_frame_characters(self, project_id: int) -> list[dict[str, Any]]:
        """项目角色库（frameCharacterContext 输入，对齐 Node L16125 列集）。

        列集与 Node 逐字一致：id, name, role_tag, personality, appearance,
        age_group, gender, reference_image_url/reference_image_storage_key, status；排除 archived。

        :param project_id: 项目 id。
        :returns: 角色行列表（ORDER BY id ASC）。
        :raises pymysql.MySQLError: 查询失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT id, name, role_tag, personality, appearance, age_group, gender,
                              reference_image_url, reference_image_storage_key, status
                       FROM characters
                       WHERE project_id = %s AND status <> 'archived'
                       ORDER BY id ASC""",
                    (project_id,),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()


    def character_in_project(self, character_id: int, project_id: int) -> dict[str, Any] | None:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                # 对齐 Node storyboard PUT：按 id+项目查角色，不过滤 archived
                # （Node L16151-16155 无 status 条件，已归档角色仍可保持既有绑定）。
                cursor.execute(
                    "SELECT id, name FROM characters WHERE id = %s AND project_id = %s LIMIT 1",
                    (character_id, project_id),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def find_character_by_name(self, project_id: int, name: str) -> dict[str, Any] | None:
        """按名称在同项目内解析角色（对齐 Node storyboard PUT 的 characterName 分支）。

        :param project_id: 项目 id。
        :param name: 角色名（调用方保证已 strip；空名由调用方短路）。
        :returns: {"id", "name"}；未命中返回 None。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id, name FROM characters WHERE project_id = %s AND name = %s ORDER BY id ASC LIMIT 1",
                    (project_id, name),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def update_storyboard(self, storyboard_id: int, user_id: int, updates: dict[str, Any]) -> dict[str, Any] | None:
        allowed_columns = {
            "shotType": "shot_type",
            "cameraAngle": "camera_angle",
            "composition": "composition",
            "durationSeconds": "duration_seconds",
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
        safe_updates = {
            allowed_columns[key]: value
            for key, value in updates.items()
            if key in allowed_columns
        }
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT sb.id
                       FROM storyboards sb
                       INNER JOIN script_scenes sc ON sc.id = sb.scene_id
                       INNER JOIN projects p ON p.id = sc.project_id
                       WHERE sb.id = %s AND p.user_id = %s LIMIT 1""",
                    (storyboard_id, user_id),
                )
                if cursor.fetchone() is None:
                    return None
                if safe_updates:
                    assignments = ", ".join(f"{column} = %s" for column in safe_updates)
                    cursor.execute(
                        f"UPDATE storyboards SET {assignments}, updated_at = NOW() WHERE id = %s",
                        (*safe_updates.values(), storyboard_id),
                    )
                cursor.execute("SELECT * FROM storyboards WHERE id = %s LIMIT 1", (storyboard_id,))
                row = cursor.fetchone()
            connection.commit()
            return row
        finally:
            connection.close()

    def get_generation_job(self, job_id: int, user_id: int) -> dict[str, Any] | None:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT gj.*
                       FROM generation_jobs gj
                       INNER JOIN projects p ON p.id = gj.project_id
                       WHERE gj.id = %s AND p.user_id = %s LIMIT 1""",
                    (job_id, user_id),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def retry_generation_job(self, job_id: int, user_id: int) -> dict[str, Any]:
        """Atomically reset an owned terminal generation job for Worker polling."""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT gj.*
                       FROM generation_jobs gj INNER JOIN projects p ON p.id = gj.project_id
                       WHERE gj.id = %s AND p.user_id = %s LIMIT 1 FOR UPDATE""",
                    (job_id, user_id),
                )
                job = cursor.fetchone()
                if job is None:
                    connection.rollback()
                    return {"outcome": "not_found"}
                if str(job.get("status") or "").lower() not in {"failed", "canceled"}:
                    connection.rollback()
                    return {"outcome": "conflict", "status": job.get("status")}
                request = job.get("request_json") or {}
                if isinstance(request, str):
                    try:
                        request = json.loads(request)
                    except (TypeError, ValueError):
                        request = {}
                if not isinstance(request, dict):
                    request = {}
                request = _repair_video_retry_request(cursor, job, request)
                request_json = _retry_request_snapshot({**job, "request_json": request})
                cursor.execute(
                    """UPDATE generation_jobs
                       SET status = 'queued', progress_percent = 0, result_json = NULL,
                           error_text = NULL, request_json = %s, updated_at = NOW()
                       WHERE id = %s AND status IN ('failed', 'canceled')""",
                    (request_json, job_id),
                )
                if cursor.rowcount != 1:
                    connection.rollback()
                    return {"outcome": "conflict", "status": job.get("status")}
                cursor.execute("SELECT * FROM generation_jobs WHERE id = %s LIMIT 1", (job_id,))
                updated = cursor.fetchone()
            connection.commit()
            return {"outcome": "queued", "job": updated}
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def enqueue_subtitle_cleanup(self, video_id: int, user_id: int) -> dict[str, Any] | None:
        """Create or reuse an active subtitle cleanup job for an owned video."""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT va.id, va.storyboard_id, va.video_url, va.storage_key,
                              va.thumbnail_url, va.duration_seconds, va.model_name,
                              sc.project_id
                       FROM video_assets va
                       INNER JOIN storyboards sb ON sb.id = va.storyboard_id
                       INNER JOIN script_scenes sc ON sc.id = sb.scene_id
                       INNER JOIN projects p ON p.id = sc.project_id
                       WHERE va.id = %s AND p.user_id = %s
                       LIMIT 1 FOR UPDATE""",
                    (video_id, user_id),
                )
                video = cursor.fetchone()
                if video is None:
                    connection.rollback()
                    return None

                cursor.execute(
                    """SELECT * FROM generation_jobs
                       WHERE project_id = %s AND job_type = 'subtitle_cleanup'
                         AND source_id = %s AND status IN ('queued', 'running')
                       ORDER BY id DESC LIMIT 1 FOR UPDATE""",
                    (video["project_id"], video_id),
                )
                job = cursor.fetchone()
                if job is None:
                    request = {
                        "projectId": int(video["project_id"]),
                        "storyboardId": int(video["storyboard_id"]),
                        "sourceVideoId": video_id,
                        "sourceStorageKey": video.get("storage_key"),
                        "sourceVideoUrl": video.get("video_url"),
                        "thumbnailUrl": video.get("thumbnail_url"),
                        "durationSeconds": video.get("duration_seconds"),
                        "modelName": video.get("model_name"),
                    }
                    cursor.execute(
                        """INSERT INTO generation_jobs
                           (job_key, project_id, job_type, source_id, status, progress_percent, request_json)
                           VALUES (%s, %s, 'subtitle_cleanup', %s, 'queued', 0, %s)""",
                        (
                            f"subtitle_cleanup-{video_id}-{secrets.token_hex(12)}",
                            video["project_id"],
                            video_id,
                            json.dumps(request, ensure_ascii=False),
                        ),
                    )
                    cursor.execute("SELECT * FROM generation_jobs WHERE id = %s LIMIT 1", (cursor.lastrowid,))
                    job = cursor.fetchone()
            connection.commit()
            return job
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    # ------------------------------------------------------------------
    # 鉴权组扩展（阶段 8.1）：滑块验证码会话 / 短信验证码 / 用户注册与改密。
    # 时间基准统一使用数据库时钟（NOW(3) / DATE_ADD），与 sms_codes 的 Node 语义一致，
    # 避免应用容器与 DB 容器时区/时钟漂移影响 TTL 判定。
    # ------------------------------------------------------------------

    def create_user(self, phone: str, nickname: str, password: str) -> dict[str, Any]:
        """创建新用户（对齐 Node createUser：SHA-256 哈希落库 + 返回 insertId 与 ISO 时间）。

        :param phone: 11 位标准化手机号（唯一性由调用方先经 fetch_user_by_phone 校验）。
        :param nickname: 已 strip 的昵称。
        :param password: 明文密码（函数内部哈希，不落库明文）。
        :returns: ``{"id", "phone", "nickname", "createdAt"}``；createdAt 为 UTC ISO 字符串
           （对齐 Node createUser 返回 ``new Date().toISOString()``）。
        :raises pymysql.MySQLError: 写入失败时原样抛出（网关兜底 500/5001）。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO users (phone, nickname, password_hash) VALUES (%s, %s, %s)",
                    (phone, nickname, hash_password(password)),
                )
                user_id = int(cursor.lastrowid)
            connection.commit()
            created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            return {"id": user_id, "phone": phone, "nickname": nickname, "createdAt": created_at}
        finally:
            connection.close()

    def update_user_password(self, user_id: int, new_password: str) -> None:
        """更新用户密码哈希（对齐 Node updateUserPassword：SHA-256 后 UPDATE）。

        :param user_id: 用户 id。
        :param new_password: 新明文密码（函数内部哈希）。
        :raises pymysql.MySQLError: 写入失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE users SET password_hash = %s WHERE id = %s",
                    (hash_password(new_password), user_id),
                )
            connection.commit()
        finally:
            connection.close()

    def save_sms_code_record(self, phone: str, code_type: str, code: str, provider: str | None, expires_in_seconds: int) -> None:
        """写入短信验证码记录（对齐 Node saveCodeRecord：先清理过期行再插入）。

        :param phone: 11 位标准化手机号。
        :param code_type: 验证码用途（login / register / reset）。
        :param code: 6 位数字验证码明文。
        :param provider: 供应商标识（mock / tencent；空则落 NULL，与 Node 一致）。
        :param expires_in_seconds: 有效期秒数（取自供应商返回的 expiresIn）。
        :raises pymysql.MySQLError: 写入失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("DELETE FROM sms_codes WHERE expires_at <= NOW()")
                cursor.execute(
                    """INSERT INTO sms_codes (phone, code_type, code, provider, expires_at)
                       VALUES (%s, %s, %s, %s, DATE_ADD(NOW(), INTERVAL %s SECOND))""",
                    (phone, code_type, code, provider or None, expires_in_seconds),
                )
            connection.commit()
        finally:
            connection.close()

    def verify_sms_code(self, phone: str, code_type: str, code: str) -> dict[str, Any]:
        """消费短信验证码（对齐 Node consumeCode 的事务语义，供 login/register/reset 使用）。

        语义逐项对齐：取该手机号+用途的最新一条记录（FOR UPDATE 行锁）；
        不存在 → 「验证码不存在或已过期」；已使用 → 「验证码已失效，请重新获取」；
        已过期 → 删除该行并返回「验证码已过期，请重新获取」；验证码不匹配 →
        「验证码错误」（不标记已用，可重试）；匹配 → 置 used_at 一次性消费。

        :param phone: 11 位标准化手机号。
        :param code_type: 验证码用途（login / register / reset）。
        :param code: 用户提交的验证码（4-8 位数字字符串，调用方已做格式校验）。
        :returns: ``{"ok": bool, "message": str|None}``；ok=False 时 message 为 Node 原文文案。
        :raises pymysql.MySQLError: 数据库故障时原样抛出（网关兜底 500/5001）。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("DELETE FROM sms_codes WHERE expires_at <= NOW()")
                cursor.execute(
                    """SELECT id, code, expires_at, used_at
                       FROM sms_codes
                       WHERE phone = %s AND code_type = %s
                       ORDER BY created_at DESC, id DESC
                       LIMIT 1
                       FOR UPDATE""",
                    (phone, code_type),
                )
                record = cursor.fetchone()
                if record is None:
                    connection.rollback()
                    return {"ok": False, "message": "验证码不存在或已过期"}
                if record.get("used_at"):
                    connection.rollback()
                    return {"ok": False, "message": "验证码已失效，请重新获取"}
                expires_at = record.get("expires_at")
                if expires_at is not None and expires_at <= datetime.now():
                    cursor.execute("DELETE FROM sms_codes WHERE id = %s", (record["id"],))
                    connection.commit()
                    return {"ok": False, "message": "验证码已过期，请重新获取"}
                if str(record.get("code") or "") != str(code or ""):
                    connection.rollback()
                    return {"ok": False, "message": "验证码错误"}
                cursor.execute("UPDATE sms_codes SET used_at = NOW() WHERE id = %s", (record["id"],))
            connection.commit()
            return {"ok": True, "message": None}
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def prune_auth_captcha_sessions(self) -> None:
        """清理过期的滑块验证码会话（对齐 Node createChallenge/verify 前置的 pruneExpired）。

        ``expires_at`` 在 verify 通过时会被改写为 token 有效期，因此单一条件即可
        同时覆盖「过期挑战」与「过期未消费 token」两类行。

        :raises pymysql.MySQLError: 删除失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("DELETE FROM auth_captcha_sessions WHERE expires_at <= NOW(3)")
            connection.commit()
        finally:
            connection.close()

    def create_auth_captcha_session(self, challenge_id: str, phone: str, ip: str, target_x: int, ttl_seconds: int) -> None:
        """写入一个待校验的滑块挑战会话（对应 Node challenges Map.set）。

        :param challenge_id: 挑战 id（randomBytes(12) hex）。
        :param phone: 签发时绑定的标准化手机号（可为空串）。
        :param ip: 签发时绑定的来源 IP（可为空串）。
        :param target_x: 缺口正确位置 x 坐标（答案只落 DB，不出现在响应里）。
        :param ttl_seconds: 有效期秒数（expires_at = NOW(3) + ttl）。
        :raises pymysql.MySQLError: 写入失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """INSERT INTO auth_captcha_sessions
                       (challenge_id, phone, ip, target_x, attempts, verified, captcha_token, consumed_at, issued_at, expires_at)
                       VALUES (%s, %s, %s, %s, 0, 0, NULL, NULL, NOW(3), DATE_ADD(NOW(3), INTERVAL %s SECOND))""",
                    (challenge_id, phone, ip, target_x, ttl_seconds),
                )
            connection.commit()
        finally:
            connection.close()

    def fetch_auth_captcha_session(self, challenge_id: str) -> dict[str, Any] | None:
        """读取滑块挑战会话（verify 阶段使用，过期标记由 DB 时钟计算）。

        :param challenge_id: 挑战 id。
        :returns: ``{"phone", "ip", "target_x", "attempts", "verified", "is_expired"}``；
            不存在返回 None。is_expired 为 1/0（expires_at <= NOW(3)）。
        :raises pymysql.MySQLError: 查询失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT phone, ip, target_x, attempts, verified,
                              (expires_at <= NOW(3)) AS is_expired
                       FROM auth_captcha_sessions WHERE challenge_id = %s LIMIT 1""",
                    (challenge_id,),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def delete_auth_captcha_session(self, challenge_id: str) -> None:
        """删除滑块挑战会话（对应 Node 校验失败超限/过期后的 challenges.delete）。

        :param challenge_id: 挑战 id。
        :raises pymysql.MySQLError: 删除失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("DELETE FROM auth_captcha_sessions WHERE challenge_id = %s", (challenge_id,))
            connection.commit()
        finally:
            connection.close()

    def increment_auth_captcha_attempts(self, challenge_id: str) -> int | None:
        """尝试次数 +1 并返回新值（对应 Node record.attempts += 1，失败重试计数持久化）。

        :param challenge_id: 挑战 id。
        :returns: 自增后的尝试次数；行已被并发删除时返回 None（调用方按「已使用或不存在」处理）。
        :raises pymysql.MySQLError: 更新失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                affected = cursor.execute(
                    "UPDATE auth_captcha_sessions SET attempts = attempts + 1 WHERE challenge_id = %s",
                    (challenge_id,),
                )
                if affected == 0:
                    connection.rollback()
                    return None
                cursor.execute(
                    "SELECT attempts FROM auth_captcha_sessions WHERE challenge_id = %s LIMIT 1",
                    (challenge_id,),
                )
                row = cursor.fetchone()
            connection.commit()
            return int(row["attempts"]) if row else None
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def mark_auth_captcha_verified(self, challenge_id: str, captcha_token: str, ttl_seconds: int) -> bool:
        """verify 通过：原子置 verified=1、写入 token 并把 expires_at 改写为 token 有效期。

        对应 Node「challenges.delete + consumed.set(id, now + ttl)」；``verified = 0``
        条件保证并发 verify 只有一方成功（幂等的防重放闸门）。

        :param challenge_id: 挑战 id。
        :param captcha_token: 签发的一次性验证 token（``<id>.<hmac>``）。
        :param ttl_seconds: token 有效期秒数（expires_at = NOW(3) + ttl）。
        :returns: 更新成功返回 True；挑战已被并发消费返回 False。
        :raises pymysql.MySQLError: 更新失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                affected = cursor.execute(
                    """UPDATE auth_captcha_sessions
                       SET verified = 1, captcha_token = %s,
                           expires_at = DATE_ADD(NOW(3), INTERVAL %s SECOND)
                       WHERE challenge_id = %s AND verified = 0""",
                    (captcha_token, ttl_seconds, challenge_id),
                )
            connection.commit()
            return affected == 1
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def consume_auth_captcha_token(self, challenge_id: str, captcha_token: str) -> bool:
        """一次性消费验证 token（send-code 专用；原子 UPDATE 防重放）。

        条件覆盖：verified=1、token 匹配、未消费（consumed_at IS NULL）、未过期
        （expires_at > NOW(3)，对应 Node consumed Map 的 TTL 清理）。

        :param challenge_id: 挑战 id。
        :param captcha_token: 待消费的完整 token 串。
        :returns: 消费成功返回 True；无效/已消费/已过期返回 False。
        :raises pymysql.MySQLError: 更新失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                affected = cursor.execute(
                    """UPDATE auth_captcha_sessions SET consumed_at = NOW(3)
                       WHERE challenge_id = %s AND captcha_token = %s AND verified = 1
                         AND consumed_at IS NULL AND expires_at > NOW(3)""",
                    (challenge_id, captcha_token),
                )
            connection.commit()
            return affected == 1
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    # ------------------------------------------------------------------
    # 剧本/分镜组 generate 端点（第三阶段第三组）：AI 生成链路的只读/写入方法。
    # SQL 与 Node index.mjs 对应查询逐字对齐；事务方法（承接上一镜、拆分子分镜、
    # 重排分镜、入队生成任务）内聚归属校验与 rollback，路由层只做形态编排。
    # ------------------------------------------------------------------

    def get_scene_with_project(self, scene_id: int, user_id: int) -> dict[str, Any] | None:
        """场景 + 项目字段联查（对齐 Node L15535 / L15700 的场景生成前置查询）。

        :param scene_id: 场景 id。
        :param user_id: 当前用户 id。
        :returns: 场景行（附 projectName/category/narrative_vision/visual_style）；
            场景不存在或非本人返回 None。
        :raises pymysql.MySQLError: 查询失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT s.*, p.user_id AS ownerId, p.name AS projectName, p.category,
                              p.narrative_vision, p.visual_style
                       FROM script_scenes s
                       INNER JOIN projects p ON p.id = s.project_id
                       WHERE s.id = %s LIMIT 1""",
                    (scene_id,),
                )
                row = cursor.fetchone()
                if row is None or int(row.get("ownerId") or 0) != int(user_id):
                    return None
                return row
        finally:
            connection.close()

    def _latest_row(self, table: str, project_id: int) -> dict[str, Any] | None:
        """按项目取最新一行（story_bibles/season_structures/story_outlines 共用）。"""
        if table not in {"story_bibles", "season_structures", "story_outlines"}:
            raise ValueError("Unsupported table")
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"SELECT * FROM {table} WHERE project_id = %s ORDER BY version_no DESC, id DESC LIMIT 1",
                    (project_id,),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def latest_story_bible_row(self, project_id: int) -> dict[str, Any] | None:
        """项目最新故事设定行（generate 链路内部使用，不经 user 校验——归属已在路由前置）。"""
        return self._latest_row("story_bibles", project_id)

    def latest_season_structure_row(self, project_id: int) -> dict[str, Any] | None:
        """项目最新分集大纲行。"""
        return self._latest_row("season_structures", project_id)

    def latest_outline_row(self, project_id: int) -> dict[str, Any] | None:
        """项目最新总纲行。"""
        return self._latest_row("story_outlines", project_id)

    def has_modern_outline_script(self, project_id: int, user_id: int) -> bool:
        """检测是否已有分集结构与正文场景，保护新工作台数据不被旧版总纲清理。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT 1 FROM projects p
                       INNER JOIN script_scenes sc ON sc.project_id = p.id
                       INNER JOIN season_structures ss ON ss.project_id = p.id
                       WHERE p.id = %s AND p.user_id = %s LIMIT 1""",
                    (project_id, user_id),
                )
                return cursor.fetchone() is not None
        finally:
            connection.close()

    def save_generated_outline(
        self, project_id: int, user_id: int, outline: dict[str, Any]
    ) -> dict[str, Any] | None:
        """原子保存新版总纲并清理旧版场景；新式分集剧本出现时拒绝覆盖。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id, visual_style FROM projects WHERE id = %s AND user_id = %s FOR UPDATE",
                    (project_id, user_id),
                )
                project = cursor.fetchone()
                if project is None:
                    connection.rollback()
                    return None
                cursor.execute(
                    """SELECT 1 FROM script_scenes sc
                       INNER JOIN season_structures ss ON ss.project_id = sc.project_id
                       WHERE sc.project_id = %s LIMIT 1 FOR UPDATE""",
                    (project_id,),
                )
                if cursor.fetchone() is not None:
                    connection.rollback()
                    return None
                cursor.execute(
                    "SELECT COALESCE(MAX(version_no), 0) AS max_version FROM story_outlines WHERE project_id = %s",
                    (project_id,),
                )
                version_no = int((cursor.fetchone() or {}).get("max_version") or 0) + 1
                cursor.execute("DELETE FROM script_scenes WHERE project_id = %s", (project_id,))
                acts = outline.get("acts") if isinstance(outline.get("acts"), list) else []
                scenes = outline.get("scenes") if isinstance(outline.get("scenes"), list) else []
                cursor.execute(
                    """INSERT INTO story_outlines
                       (project_id, version_no, title, logline, premise, act1_text, act2_text,
                        act3_text, visual_style, raw_json)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (project_id, version_no, outline.get("title"), outline.get("logline"), outline.get("premise"),
                     acts[0].get("summary", "") if len(acts) > 0 else "",
                     acts[1].get("summary", "") if len(acts) > 1 else "",
                     acts[2].get("summary", "") if len(acts) > 2 else "",
                     outline.get("visual_style") or project.get("visual_style"),
                     json.dumps({"acts": acts, "scenes": scenes}, ensure_ascii=False)),
                )
                outline_id = int(cursor.lastrowid)
                cursor.execute(
                    "UPDATE projects SET status = 'outlined', updated_at = NOW() WHERE id = %s AND user_id = %s",
                    (project_id, user_id),
                )
                cursor.execute("SELECT * FROM story_outlines WHERE id = %s LIMIT 1", (outline_id,))
                row = cursor.fetchone()
            connection.commit()
            return row
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def save_generated_scene_script(self, scene_id: int, fields: dict[str, Any]) -> dict[str, Any] | None:
        """AI 剧本回写（对齐 Node L15582：多字段 UPDATE + status='generated'）。

        :param scene_id: 场景 id。
        :param fields: title/summary/content/mood/location/time_of_day/estimated_duration。
        :returns: 更新后的场景行；场景不存在返回 None。
        :raises pymysql.MySQLError: 写入失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT id FROM script_scenes WHERE id = %s LIMIT 1", (scene_id,))
                if cursor.fetchone() is None:
                    return None
                cursor.execute(
                    """UPDATE script_scenes
                       SET title = %s, summary = %s, content = %s, mood = %s, location = %s,
                           time_of_day = %s, estimated_duration = %s, status = 'generated', updated_at = NOW()
                       WHERE id = %s""",
                    (
                        fields.get("title"), fields.get("summary"), fields.get("content"), fields.get("mood"),
                        fields.get("location"), fields.get("time_of_day"), fields.get("estimated_duration"),
                        scene_id,
                    ),
                )
                cursor.execute("SELECT * FROM script_scenes WHERE id = %s", (scene_id,))
                row = cursor.fetchone()
            connection.commit()
            return row
        finally:
            connection.close()

    def persist_story_bible(self, project_id: int, values: dict[str, Any]) -> dict[str, Any]:
        """新增一版故事设定（对齐 Node persistStoryBible：version_no 递增 + INSERT）。

        :param project_id: 项目 id。
        :param values: ``storyBibleDbValues`` 形态的列值（status/qualityReport/lockedAt 已含）。
        :returns: 插入后的完整行。
        :raises pymysql.MySQLError: 写入失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT COALESCE(MAX(version_no), 0) AS maxVersion FROM story_bibles WHERE project_id = %s",
                    (project_id,),
                )
                version_no = int(cursor.fetchone()["maxVersion"] or 0) + 1
                cursor.execute(
                    """INSERT INTO story_bibles
                       (project_id, version_no, status, title, logline, audience, emotional_promise,
                        world_rules_json, timeline_json, locations_json, characters_json, relationships_json,
                        props_json, main_plot, subplots_json, foreshadowing_json, locked_facts_json,
                        flexible_facts_json, visual_symbols_json, quality_report_json, locked_at)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (
                        project_id, version_no, values.get("status"), values.get("title"), values.get("logline"),
                        values.get("audience"), values.get("emotionalPromise"), values.get("worldRules"),
                        values.get("timeline"), values.get("locations"), values.get("characters"),
                        values.get("relationships"), values.get("props"), values.get("mainPlot"),
                        values.get("subplots"), values.get("foreshadowing"), values.get("lockedFacts"),
                        values.get("flexibleFacts"), values.get("visualSymbols"), values.get("qualityReport"),
                        values.get("lockedAt"),
                    ),
                )
                cursor.execute("SELECT * FROM story_bibles WHERE id = %s", (cursor.lastrowid,))
                row = cursor.fetchone()
            connection.commit()
            return row
        finally:
            connection.close()

    def persist_season_structure(self, project_id: int, story_bible_id: int | None, values: dict[str, Any]) -> dict[str, Any]:
        """新增一版分集大纲（对齐 Node persistSeasonStructure）。

        :param project_id: 项目 id。
        :param story_bible_id: 关联的故事设定 id（可为 None）。
        :param values: ``seasonStructureDbValues`` 形态的列值。
        :returns: 插入后的完整行。
        :raises pymysql.MySQLError: 写入失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT COALESCE(MAX(version_no), 0) AS maxVersion FROM season_structures WHERE project_id = %s",
                    (project_id,),
                )
                version_no = int(cursor.fetchone()["maxVersion"] or 0) + 1
                cursor.execute(
                    """INSERT INTO season_structures
                       (project_id, story_bible_id, version_no, status, season_theme, core_conflict,
                        structure_type, episode_count, episodes_json, foreshadowing_plan_json,
                        character_arcs_json, quality_report_json, locked_at)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (
                        project_id, story_bible_id, version_no, values.get("status"), values.get("seasonTheme"),
                        values.get("coreConflict"), values.get("structureType"), values.get("episodeCount"),
                        values.get("episodes"), values.get("foreshadowingPlan"), values.get("characterArcs"),
                        values.get("qualityReport"), values.get("lockedAt"),
                    ),
                )
                cursor.execute("SELECT * FROM season_structures WHERE id = %s", (cursor.lastrowid,))
                row = cursor.fetchone()
            connection.commit()
            return row
        finally:
            connection.close()

    def load_storyboard_director_context(self, storyboard_id: int, user_id: int) -> dict[str, Any] | None:
        """分镜导演上下文联查（对齐 Node loadStoryboardDirectorContext，L3550）。

        :param storyboard_id: 分镜 id。
        :param user_id: 当前用户 id。
        :returns: ``{"storyboard", "project", "scene", "characters", "project_id"}``；
            分镜不存在或非本人返回 None。
        :raises pymysql.MySQLError: 查询失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT s.*, sc.project_id, sc.outline_id, sc.scene_no, sc.title AS scene_title,
                              sc.summary AS scene_summary, sc.content AS scene_content, sc.mood AS scene_mood,
                              sc.location, sc.time_of_day, sc.estimated_duration AS scene_estimated_duration,
                              p.user_id AS ownerId, p.name AS project_name, p.category AS project_category,
                              p.visual_style AS project_visual_style, p.narrative_vision AS project_narrative_vision
                       FROM storyboards s
                       INNER JOIN script_scenes sc ON sc.id = s.scene_id
                       INNER JOIN projects p ON p.id = sc.project_id
                       WHERE s.id = %s LIMIT 1""",
                    (storyboard_id,),
                )
                shot = cursor.fetchone()
                if shot is None or int(shot.get("ownerId") or 0) != int(user_id):
                    return None
                cursor.execute(
                    """SELECT id, name, role_tag, personality, appearance, age_group, gender,
                              reference_image_url, status
                       FROM characters
                       WHERE project_id = %s AND status <> 'archived'
                       ORDER BY id ASC""",
                    (shot["project_id"],),
                )
                characters = list(cursor.fetchall())
            return {
                "storyboard": shot,
                "project": {
                    "id": int(shot["project_id"]),
                    "name": shot.get("project_name"),
                    "category": shot.get("project_category"),
                    "visualStyle": shot.get("project_visual_style"),
                    "narrativeVision": shot.get("project_narrative_vision"),
                },
                "scene": {
                    "id": int(shot["scene_id"]),
                    "sceneNo": shot.get("scene_no"),
                    "title": shot.get("scene_title"),
                    "summary": shot.get("scene_summary"),
                    "content": shot.get("scene_content"),
                    "mood": shot.get("scene_mood"),
                    "location": shot.get("location"),
                    "timeOfDay": shot.get("time_of_day"),
                    "estimatedDuration": shot.get("scene_estimated_duration"),
                },
                "characters": characters,
                "project_id": int(shot["project_id"]),
            }
        finally:
            connection.close()

    def load_frame_rewrite_context(self, storyboard_id: int, user_id: int) -> dict[str, Any] | None:
        """静帧提示词重写上下文（对齐 Node buildFramePromptRewriteContext，L3491）。

        相比 director context 额外 LEFT JOIN story_outlines 带出总纲字段。

        :param storyboard_id: 分镜 id。
        :param user_id: 当前用户 id。
        :returns: ``{"project", "outline", "scene", "storyboard", "characters",
            "frameCharacterContext", "project_id"}``；不存在或非本人返回 None。
        :raises pymysql.MySQLError: 查询失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT s.*, sc.project_id, sc.outline_id, sc.scene_no, sc.title AS scene_title,
                              sc.summary AS scene_summary, sc.content AS scene_content, sc.mood AS scene_mood,
                              sc.location, sc.time_of_day, sc.estimated_duration AS scene_estimated_duration,
                              p.user_id AS ownerId, p.name AS project_name, p.category AS project_category,
                              p.visual_style AS project_visual_style, p.narrative_vision AS project_narrative_vision,
                              so.title AS outline_title, so.summary AS outline_summary,
                              so.premise AS outline_premise, so.content AS outline_content
                       FROM storyboards s
                       INNER JOIN script_scenes sc ON sc.id = s.scene_id
                       INNER JOIN projects p ON p.id = sc.project_id
                       LEFT JOIN story_outlines so ON so.id = sc.outline_id
                       WHERE s.id = %s LIMIT 1""",
                    (storyboard_id,),
                )
                shot = cursor.fetchone()
                if shot is None or int(shot.get("ownerId") or 0) != int(user_id):
                    return None
                cursor.execute(
                    """SELECT id, name, role_tag, personality, appearance, age_group, gender,
                              reference_image_url, status
                       FROM characters
                       WHERE project_id = %s AND status <> 'archived'
                       ORDER BY id ASC""",
                    (shot["project_id"],),
                )
                characters = list(cursor.fetchall())
            return {
                "project": {
                    "id": int(shot["project_id"]),
                    "name": shot.get("project_name"),
                    "category": shot.get("project_category"),
                    "visualStyle": shot.get("project_visual_style"),
                    "narrativeVision": shot.get("project_narrative_vision"),
                },
                "outline": {
                    "title": shot.get("outline_title"),
                    "summary": shot.get("outline_summary"),
                    "premise": shot.get("outline_premise"),
                    "content": shot.get("outline_content"),
                },
                "scene": {
                    "id": int(shot["scene_id"]),
                    "scene_no": shot.get("scene_no"),
                    "title": shot.get("scene_title"),
                    "summary": shot.get("scene_summary"),
                    "content": shot.get("scene_content"),
                    "mood": shot.get("scene_mood"),
                    "location": shot.get("location"),
                    "time_of_day": shot.get("time_of_day"),
                    "estimated_duration": shot.get("scene_estimated_duration"),
                },
                "storyboard": shot,
                "characters": characters,
                "project_id": int(shot["project_id"]),
            }
        finally:
            connection.close()

    def update_storyboard_keyframes(self, storyboard_id: int, start_prompt: str, end_prompt: str) -> dict[str, Any] | None:
        """回写两帧提示词（对齐 Node optimizeStoryboardKeyframes 的 UPDATE）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """UPDATE storyboards
                       SET start_visual_prompt = %s, end_visual_prompt = %s, updated_at = NOW()
                       WHERE id = %s""",
                    (start_prompt, end_prompt, storyboard_id),
                )
                cursor.execute("SELECT * FROM storyboards WHERE id = %s LIMIT 1", (storyboard_id,))
                row = cursor.fetchone()
            connection.commit()
            return row
        finally:
            connection.close()

    def copy_previous_frame(self, storyboard_id: int, user_id: int) -> dict[str, Any]:
        """承接上一镜头确认画面为起始帧（对齐 Node copyPreviousFrameToStoryboard，L3697）。

        事务内完成：旧起始帧降级 candidate → 插入 confirmed 起始帧 → 回写
        storyboards.image_url/start_visual_prompt。

        :param storyboard_id: 当前分镜 id。
        :param user_id: 当前用户 id。
        :returns: ``{"outcome": "no_shot"|"no_source"|"copied", "storyboard"?, "image"?,
            "sourceStoryboardId"?, "sourceShotNo"?}``。
        :raises pymysql.MySQLError: 写入失败时 rollback 后原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT s.*, sc.project_id, p.user_id AS ownerId
                       FROM storyboards s
                       INNER JOIN script_scenes sc ON sc.id = s.scene_id
                       INNER JOIN projects p ON p.id = sc.project_id
                       WHERE s.id = %s LIMIT 1""",
                    (storyboard_id,),
                )
                shot = cursor.fetchone()
                if shot is None or int(shot.get("ownerId") or 0) != int(user_id):
                    connection.rollback()
                    return {"outcome": "no_shot"}
                cursor.execute(
                    """SELECT ps.*, ia.id AS image_asset_id, ia.image_url, ia.thumbnail_url,
                              ia.prompt_snapshot, ia.negative_prompt, ia.character_snapshot,
                              ia.model_name, ia.frame_role
                       FROM storyboards ps
                       INNER JOIN image_assets ia ON ia.storyboard_id = ps.id AND ia.status = 'confirmed'
                       WHERE ps.scene_id = %s AND ps.sort_order < %s
                       ORDER BY ps.sort_order DESC,
                         CASE ia.frame_role WHEN 'end' THEN 0 WHEN 'start' THEN 1 ELSE 2 END ASC,
                         ia.confirmed_at DESC, ia.id DESC
                       LIMIT 1""",
                    (shot["scene_id"], shot.get("sort_order")),
                )
                source = cursor.fetchone()
                if source is None:
                    connection.rollback()
                    return {"outcome": "no_source"}
                cursor.execute(
                    "SELECT COALESCE(MAX(version_no), 0) AS maxVersion FROM image_assets WHERE storyboard_id = %s",
                    (storyboard_id,),
                )
                next_version = int(cursor.fetchone()["maxVersion"] or 0) + 1
                role_label = {"end": "结束帧", "start": "起始帧"}.get(
                    str(source.get("frame_role") or "").strip().lower(), "普通静帧"
                )
                prompt_snapshot = " ".join(
                    part
                    for part in (
                        f"承接上一镜头 {source.get('shot_no') or ''} 的{role_label}作为本镜头起始帧。",
                        source.get("prompt_snapshot"),
                    )
                    if part
                )
                character_snapshot = source.get("character_snapshot")
                if isinstance(character_snapshot, (dict, list)):
                    character_snapshot = json.dumps(character_snapshot, ensure_ascii=False)
                cursor.execute(
                    """UPDATE image_assets SET status = 'candidate', confirmed_at = NULL
                       WHERE storyboard_id = %s AND frame_role = 'start'""",
                    (storyboard_id,),
                )
                cursor.execute(
                    """INSERT INTO image_assets
                       (storyboard_id, version_no, image_url, thumbnail_url, prompt_snapshot,
                        frame_role, negative_prompt, character_snapshot, model_name, status, confirmed_at)
                       VALUES (%s, %s, %s, %s, %s, 'start', %s, %s, %s, 'confirmed', NOW())""",
                    (
                        storyboard_id, next_version, source.get("image_url"), source.get("thumbnail_url"),
                        prompt_snapshot, source.get("negative_prompt") or None, character_snapshot,
                        source.get("model_name") or None,
                    ),
                )
                inserted_id = cursor.lastrowid
                cursor.execute(
                    """UPDATE storyboards
                       SET image_url = %s, start_visual_prompt = %s, updated_at = NOW()
                       WHERE id = %s""",
                    (source.get("image_url"), prompt_snapshot, storyboard_id),
                )
                cursor.execute("SELECT * FROM image_assets WHERE id = %s LIMIT 1", (inserted_id,))
                image = cursor.fetchone()
                cursor.execute("SELECT * FROM storyboards WHERE id = %s LIMIT 1", (storyboard_id,))
                updated = cursor.fetchone()
            connection.commit()
            return {
                "outcome": "copied",
                "storyboard": updated,
                "image": image,
                "sourceStoryboardId": int(source["id"]),
                "sourceShotNo": source.get("shot_no"),
            }
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def count_storyboard_generated_assets(self, storyboard_id: int) -> dict[str, int]:
        """统计分镜已生成素材数（对齐 Node assertStoryboardHasNoGeneratedAssets，L3975）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT
                         (SELECT COUNT(*) FROM image_assets WHERE storyboard_id = %s) AS imageCount,
                         (SELECT COUNT(*) FROM image_assets
                          WHERE storyboard_id = %s AND frame_role = 'start'
                            AND prompt_snapshot LIKE '承接上一镜头%%') AS continuityStartImageCount,
                         (SELECT COUNT(*) FROM video_assets WHERE storyboard_id = %s) AS videoCount,
                         (SELECT COUNT(*) FROM audio_assets WHERE storyboard_id = %s) AS audioCount""",
                    (storyboard_id, storyboard_id, storyboard_id, storyboard_id),
                )
                row = cursor.fetchone() or {}
            return {
                "imageCount": int(row.get("imageCount") or 0),
                "continuityStartImageCount": int(row.get("continuityStartImageCount") or 0),
                "videoCount": int(row.get("videoCount") or 0),
                "audioCount": int(row.get("audioCount") or 0),
            }
        finally:
            connection.close()

    def split_storyboard_in_place(
        self,
        *,
        storyboard_id: int,
        scene_id: int,
        sort_order: int,
        first_update: dict[str, Any],
        extra_rows: list[dict[str, Any]],
        override_first_character: bool,
    ) -> None:
        """拆分子分镜事务（对齐 Node splitStoryboardIntoSubShots / splitDialogueTurns，L4063）。

        事务内完成：后续镜头 sort_order 整体后移 → 首条子分镜 UPDATE 原行 →
        其余子分镜 INSERT。

        :param storyboard_id: 原分镜 id（首条子分镜复用该行）。
        :param scene_id: 场景 id。
        :param sort_order: 原分镜 sort_order。
        :param first_update: 首条子分镜字段（snake_case 列名 → 值）。
        :param extra_rows: 其余子分镜字段列表。
        :param override_first_character: 对白拆分时首条同步覆盖 character_id/character_name。
        :raises pymysql.MySQLError: 写入失败时 rollback 后原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                increment = len(extra_rows)
                cursor.execute(
                    """UPDATE storyboards SET sort_order = sort_order + %s
                       WHERE scene_id = %s AND sort_order > %s""",
                    (increment, scene_id, sort_order),
                )
                first_columns = [
                    "shot_type", "camera_angle", "composition", "duration_seconds",
                    "action_text", "dialogue_text", "visual_prompt",
                    "start_visual_prompt", "end_visual_prompt", "asset_reference_json",
                ]
                if override_first_character:
                    first_columns += ["character_id", "character_name"]
                assignments = ", ".join(f"{column} = %s" for column in first_columns)
                cursor.execute(
                    f"""UPDATE storyboards
                        SET {assignments},
                            image_url = %s, end_image_url = NULL, video_url = NULL,
                            status = 'pending', updated_at = NOW()
                        WHERE id = %s""",
                    (
                        *[first_update.get(column) for column in first_columns],
                        first_update.get("image_url"),
                        storyboard_id,
                    ),
                )
                for row in extra_rows:
                    cursor.execute(
                        """INSERT INTO storyboards
                           (scene_id, shot_no, shot_type, camera_angle, composition, duration_seconds,
                            character_id, character_name, action_text, dialogue_text, visual_prompt,
                            start_visual_prompt, end_visual_prompt, asset_reference_json, sort_order, status)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'pending')""",
                        (
                            scene_id, row.get("shot_no"), row.get("shot_type"), row.get("camera_angle"),
                            row.get("composition"), row.get("duration_seconds"), row.get("character_id"),
                            row.get("character_name"), row.get("action_text"), row.get("dialogue_text"),
                            row.get("visual_prompt"), row.get("start_visual_prompt"),
                            row.get("end_visual_prompt"), row.get("asset_reference_json"),
                            row.get("sort_order"),
                        ),
                    )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def list_scene_storyboard_rows(self, scene_id: int) -> list[dict[str, Any]]:
        """按场景读全部分镜行（ORDER BY sort_order ASC, id ASC，对齐 Node 返回查询）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM storyboards WHERE scene_id = %s ORDER BY sort_order ASC, id ASC",
                    (scene_id,),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def list_project_characters_with_assets(self, project_id: int) -> list[dict[str, Any]]:
        """项目角色 + 已确认定妆图版本（对齐 Node L15727 的角色查询）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT c.id, c.name, c.role_tag, c.personality, c.appearance, c.voice_setting,
                              c.age_group, c.gender, c.voice_profile_key, c.voice_locked,
                              c.reference_image_url, c.status,
                              COALESCE((SELECT MAX(ci.version_no) FROM character_images ci
                                        WHERE ci.character_id = c.id AND ci.status = 'confirmed'), 1) AS asset_version,
                              (SELECT ci.id FROM character_images ci
                               WHERE ci.character_id = c.id AND ci.status = 'confirmed'
                               ORDER BY ci.version_no DESC, ci.id DESC LIMIT 1) AS confirmed_image_id
                       FROM characters c WHERE c.project_id = %s ORDER BY c.id ASC""",
                    (project_id,),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def list_storyboard_asset_rows(self, project_id: int, *, include_missing_vision: bool = False) -> list[dict[str, Any]]:
        """资产节点 + 已确认图联查（分镜生成的资产门禁输入）。

        :param project_id: 项目 id。
        :param include_missing_vision: 事务期查询允许 vision_status IS NULL
            （对齐 Node L15841 的第二段查询差异）。
        :returns: asset_node 行（附 image 字段）。
        :raises pymysql.MySQLError: 查询失败时原样抛出。
        """
        vision_condition = (
            """AND (ai.vision_status = 'passed' OR ai.vision_status IS NULL
                   OR (an.node_type = 'scene' AND ai.vision_status = 'skipped'))"""
            if include_missing_vision
            else """AND (ai.vision_status = 'passed'
                 OR (an.node_type = 'scene' AND ai.vision_status = 'skipped'))"""
        )
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"""SELECT an.id AS asset_node_id, an.node_type, an.ref_id, an.label,
                               an.prompt_text AS asset_prompt,
                               ai.id AS image_id, ai.version_no, ai.view_set_version, ai.view_index,
                               ai.view_key, ai.view_set_type, ai.status, ai.vision_status
                        FROM asset_nodes an
                        LEFT JOIN asset_node_images ai
                          ON ai.asset_node_id = an.id
                         AND ai.status = 'confirmed'
                         {vision_condition}
                        WHERE an.project_id = %s AND an.status <> 'archived'
                        ORDER BY an.id ASC, ai.id ASC""",
                    (project_id,),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def replace_scene_storyboards(self, scene_id: int, project_id: int, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """整场分镜替换事务（对齐 Node L15827-L16046：DELETE + INSERT + 状态推进）。

        :param scene_id: 场景 id。
        :param project_id: 项目 id。
        :param rows: 新分镜行（列名 → 值；sort_order 由调用方给定）。
        :returns: 插入后的全部分镜行（ORDER BY sort_order ASC, id ASC）。
        :raises pymysql.MySQLError: 写入失败时 rollback 后原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("DELETE FROM storyboards WHERE scene_id = %s", (scene_id,))
                for row in rows:
                    cursor.execute(
                        """INSERT INTO storyboards
                           (scene_id, shot_no, shot_type, camera_angle, composition, duration_seconds,
                            character_id, character_name, action_text, dialogue_text, visual_prompt,
                            start_visual_prompt, end_visual_prompt, asset_reference_json, sort_order, status)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'pending')""",
                        (
                            scene_id, row.get("shot_no"), row.get("shot_type"), row.get("camera_angle"),
                            row.get("composition"), row.get("duration_seconds"), row.get("character_id"),
                            row.get("character_name"), row.get("action_text"), row.get("dialogue_text"),
                            row.get("visual_prompt"), row.get("start_visual_prompt"),
                            row.get("end_visual_prompt"), row.get("asset_reference_json"),
                            row.get("sort_order"),
                        ),
                    )
                cursor.execute(
                    "UPDATE script_scenes SET status = 'storyboard_ready', updated_at = NOW() WHERE id = %s",
                    (scene_id,),
                )
                cursor.execute(
                    "UPDATE projects SET status = 'storyboarding', updated_at = NOW() WHERE id = %s",
                    (project_id,),
                )
                cursor.execute(
                    "SELECT * FROM storyboards WHERE scene_id = %s ORDER BY sort_order ASC, id ASC",
                    (scene_id,),
                )
                rows_out = list(cursor.fetchall())
            connection.commit()
            return rows_out
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def get_shot_for_frame_job(self, shot_id: int, user_id: int) -> dict[str, Any] | None:
        """静帧入队前置查询（对齐 Node enqueueFrameImageJob 的 shot 查询，L2865）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT s.*, sc.project_id, p.visual_style AS project_visual_style,
                              p.user_id AS ownerId
                       FROM storyboards s
                       INNER JOIN script_scenes sc ON sc.id = s.scene_id
                       INNER JOIN projects p ON p.id = sc.project_id
                       WHERE s.id = %s LIMIT 1""",
                    (shot_id,),
                )
                row = cursor.fetchone()
                if row is None or int(row.get("ownerId") or 0) != int(user_id):
                    return None
                return row
        finally:
            connection.close()

    def next_image_version(self, storyboard_id: int) -> int:
        """下一静帧版本号（MAX(version_no) + 1，对齐 Node L2919）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT COALESCE(MAX(version_no), 0) AS maxVersion FROM image_assets WHERE storyboard_id = %s",
                    (storyboard_id,),
                )
                return int(cursor.fetchone()["maxVersion"] or 0) + 1
        finally:
            connection.close()

    def create_generation_job(self, project_id: int, job_type: str, source_id: int, request: dict[str, Any]) -> dict[str, Any]:
        """创建/复用生成任务（对齐 Node createGenerationJob，L1001）。

        幂等语义与 Node 一致：同 project + job_type + source_id 存在 queued/running
        的活动任务时直接复用返回；否则 INSERT 新任务（job_key 带随机后缀）。

        :param project_id: 项目 id。
        :param job_type: 任务类型（frame_image / subtitle_cleanup / …）。
        :param source_id: 业务主键（分镜 id 等）。
        :param request: 请求快照（自动并入 projectId，与 Node 一致）。
        :returns: generation_jobs 行。
        :raises pymysql.MySQLError: 写入失败时原样抛出。
        """
        request_snapshot = {**(request or {}), "projectId": int(project_id)}
        request_json = json.dumps(request_snapshot, ensure_ascii=False)
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT * FROM generation_jobs
                       WHERE project_id = %s AND job_type = %s AND source_id = %s
                         AND status IN ('queued', 'running')
                       ORDER BY id DESC LIMIT 1""",
                    (project_id, job_type, source_id),
                )
                active = cursor.fetchone()
                if active:
                    connection.commit()
                    return active
                job_key = f"{job_type}-{source_id}-{__import__('uuid').uuid4()}"
                cursor.execute(
                    """INSERT INTO generation_jobs
                       (job_key, project_id, job_type, source_id, status, progress_percent, request_json)
                       VALUES (%s, %s, %s, %s, 'queued', 0, %s)""",
                    (job_key, project_id, job_type, source_id, request_json),
                )
                cursor.execute("SELECT * FROM generation_jobs WHERE id = %s LIMIT 1", (cursor.lastrowid,))
                row = cursor.fetchone()
            connection.commit()
            return row
        finally:
            connection.close()

    # ------------------------------------------------------------------
    # 生成任务组扩展（阶段 7.4 后续）：视频 / 口型入队查询 + 视频确认事务。
    # SQL 与归属链路逐条对照 Node index.mjs（只读复刻，不改语义）。
    # ------------------------------------------------------------------

    def get_shot_for_video_job(self, storyboard_id: int, user_id: int) -> dict[str, Any] | None:
        """视频入队用分镜行（对齐 Node enqueueStoryboardVideoJob 首查，L2945）。

        :param storyboard_id: 分镜 id。
        :param user_id: 当前用户 id（ownerId 归属判定）。
        :returns: 分镜行（含 project_id / ownerId / aspect_ratio）；不存在或非本人返回 None。
        :raises pymysql.MySQLError: 读取失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT s.*, sc.project_id, p.user_id AS ownerId, p.aspect_ratio
                       FROM storyboards s
                       INNER JOIN script_scenes sc ON sc.id = s.scene_id
                       INNER JOIN projects p ON p.id = sc.project_id
                       WHERE s.id = %s LIMIT 1""",
                    (storyboard_id,),
                )
                row = cursor.fetchone()
                if row is None or int(row.get("ownerId") or 0) != int(user_id):
                    return None
                return row
        finally:
            connection.close()

    def update_storyboard_visual_prompt(self, storyboard_id: int, visual_prompt: str) -> None:
        """入队期间回写清洗后的分镜视觉提示词（对齐 Node L3157）。

        :param storyboard_id: 分镜 id。
        :param visual_prompt: 清洗后的提示词（Node 侧仅在清洗结果与原值不同时调用）。
        :raises pymysql.MySQLError: 写入失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE storyboards SET visual_prompt = %s, updated_at = NOW() WHERE id = %s",
                    (visual_prompt, storyboard_id),
                )
            connection.commit()
        finally:
            connection.close()

    def get_continuity_previous_shot(
        self, scene_id: int, requested_shot_no: str | None, sort_order: int
    ) -> dict[str, Any] | None:
        """片段衔接上一镜行（对齐 Node L2992，含上一镜确认视频尾帧联查）。

        :param scene_id: 场景 id。
        :param requested_shot_no: 请求的来源镜号（``@片段衔接[镜头X]``）；空串走 sort_order 兜底。
        :param sort_order: 当前镜排序（requested_shot_no 为空时取同场景更早镜头）。
        :returns: 上一镜行（id/shot_no/end_image_url/sort_order/end_frame_url/end_frame_storage_key）；无命中 None。
        :raises pymysql.MySQLError: 读取失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT s.id, s.shot_no, s.end_image_url, s.sort_order,
                              va.end_frame_url, va.end_frame_storage_key
                       FROM storyboards s
                       LEFT JOIN video_assets va
                         ON va.id = (
                           SELECT candidate.id FROM video_assets candidate
                           WHERE candidate.storyboard_id = s.id AND candidate.status = 'confirmed'
                           ORDER BY candidate.confirmed_at DESC, candidate.id DESC LIMIT 1
                         )
                       WHERE s.scene_id = %s
                         AND ((%s <> '' AND s.shot_no = %s) OR (%s = '' AND s.sort_order < %s))
                       ORDER BY s.sort_order DESC, s.id DESC
                       LIMIT 1""",
                    (scene_id, requested_shot_no or "", requested_shot_no or "", requested_shot_no or "", sort_order),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def get_confirmed_end_frame_image(self, storyboard_id: int) -> dict[str, Any] | None:
        """当前镜已确认结束帧（对齐 Node L3019）。

        :param storyboard_id: 分镜 id。
        :returns: image_assets 行（image_url/storage_key）；无命中 None。
        :raises pymysql.MySQLError: 读取失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT image_url, storage_key
                       FROM image_assets
                       WHERE storyboard_id = %s AND frame_role = 'end' AND status = 'confirmed'
                       ORDER BY confirmed_at DESC, id DESC LIMIT 1""",
                    (storyboard_id,),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def list_referenced_asset_node_images(
        self, asset_ids: list[int], project_id: int, user_id: int
    ) -> list[dict[str, Any]]:
        """请求显式引用的资产图行（对齐 Node L3073；不做状态过滤）。

        :param asset_ids: 资产图 id 列表（空列表直接返回空）。
        :param project_id: 项目 id。
        :param user_id: 当前用户 id。
        :returns: 资产图行列表（id/label/status/storage_key/image_url/thumbnail_url），按 id 升序。
        :raises pymysql.MySQLError: 读取失败时原样抛出。
        """
        if not asset_ids:
            return []
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                placeholders = ", ".join(["%s"] * len(asset_ids))
                cursor.execute(
                    f"""SELECT ai.id, an.label, ai.status, ai.storage_key,
                               COALESCE(ai.image_url, '') AS image_url,
                               ai.thumbnail_url
                        FROM asset_node_images ai
                        INNER JOIN asset_nodes an ON an.id = ai.asset_node_id
                        INNER JOIN projects p ON p.id = an.project_id
                        WHERE ai.id IN ({placeholders}) AND p.id = %s AND p.user_id = %s
                        ORDER BY ai.id ASC""",
                    (*asset_ids, project_id, user_id),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def list_locked_reference_rows(
        self, node_ids: list[int], project_id: int, user_id: int
    ) -> list[dict[str, Any]]:
        """分镜资产引用锁定的已确认资产图行（对齐 Node L3097 的门禁查询）。

        只取角色资产板 / 道具单图 / 场景视角三类引用，且要求视觉检查通过
        （场景九宫格视角允许 skipped）。

        :param node_ids: 资产节点 id 列表（空列表直接返回空）。
        :param project_id: 项目 id。
        :param user_id: 当前用户 id。
        :returns: 锁定引用行列表（含 node_type/label/view_key/version_no 等），按资产图 id 升序。
        :raises pymysql.MySQLError: 读取失败时原样抛出。
        """
        if not node_ids:
            return []
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                placeholders = ", ".join(["%s"] * len(node_ids))
                cursor.execute(
                    f"""SELECT ai.id, an.id AS asset_node_id, an.ref_id, an.label, an.node_type,
                               an.prompt_text AS asset_prompt, an.environment_prompt_text AS environment_prompt,
                               ai.status, ai.storage_key, ai.prompt_snapshot AS image_prompt,
                               ai.view_set_type, ai.view_key, ai.view_set_version, ai.version_no,
                               ai.vision_status, COALESCE(ai.image_url, '') AS image_url, ai.thumbnail_url
                        FROM asset_node_images ai
                        INNER JOIN asset_nodes an ON an.id = ai.asset_node_id
                        INNER JOIN projects p ON p.id = an.project_id
                        WHERE an.id IN ({placeholders}) AND p.id = %s AND p.user_id = %s
                          AND ai.status = 'confirmed'
                          AND ((an.node_type = 'character'
                                AND ai.view_set_type IN ('single', 'character-asset-pack', 'character-face-closeup', 'character-turnaround'))
                            OR (an.node_type IN ('prop', 'tool', 'material') AND ai.view_set_type = 'single' AND ai.view_key IS NULL)
                            OR an.node_type = 'scene')
                          AND (ai.vision_status = 'passed' OR ai.vision_status IS NULL
                               OR (an.node_type = 'scene' AND ai.vision_status = 'skipped'))
                        ORDER BY ai.id ASC""",
                    (*node_ids, project_id, user_id),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def get_character_constraint_name(self, character_id: int, project_id: int) -> dict[str, Any] | None:
        """连续性约束角色名（对齐 Node L3207；归档角色不算命中）。

        :param character_id: 角色 id。
        :param project_id: 项目 id。
        :returns: ``{"name": ...}``；无命中 None。
        :raises pymysql.MySQLError: 读取失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT name FROM characters
                       WHERE id = %s AND project_id = %s AND status <> 'archived' LIMIT 1""",
                    (character_id, project_id),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def list_character_voice_rows(self, character_ids: list[int], project_id: int) -> list[dict[str, Any]]:
        """分镜引用角色的音色行（对齐 Node L3245）。

        :param character_ids: 角色 id 列表（空列表直接返回空）。
        :param project_id: 项目 id。
        :returns: 音色行列表（character_id/character_name/voice_profile_key/reference_audio_url/
            reference_audio_storage_key/voice_locked）。
        :raises pymysql.MySQLError: 读取失败时原样抛出。
        """
        if not character_ids:
            return []
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                placeholders = ", ".join(["%s"] * len(character_ids))
                cursor.execute(
                    f"""SELECT id AS character_id, name AS character_name,
                               voice_profile_key, reference_audio_url, reference_audio_storage_key, voice_locked
                        FROM characters
                        WHERE id IN ({placeholders}) AND project_id = %s""",
                    (*character_ids, project_id),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def next_video_version(self, storyboard_id: int) -> int:
        """下一视频版本号（MAX(version_no) + 1，对齐 Node L3388）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT COALESCE(MAX(version_no), 0) AS maxVersion FROM video_assets WHERE storyboard_id = %s",
                    (storyboard_id,),
                )
                return int(cursor.fetchone()["maxVersion"] or 0) + 1
        finally:
            connection.close()

    def get_shot_for_lip_sync_job(self, storyboard_id: int, user_id: int) -> dict[str, Any] | None:
        """口型入队用分镜行（对齐 Node enqueueLipSyncJob 首查，L4382，含说话角色名解析）。

        :param storyboard_id: 分镜 id。
        :param user_id: 当前用户 id。
        :returns: 分镜行（含 project_id / ownerId / resolved_character_name）；不存在或非本人 None。
        :raises pymysql.MySQLError: 读取失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT s.*, sc.project_id, p.user_id AS ownerId, c.name AS resolved_character_name
                       FROM storyboards s
                       INNER JOIN script_scenes sc ON sc.id = s.scene_id
                       INNER JOIN projects p ON p.id = sc.project_id
                       LEFT JOIN characters c ON c.id = s.character_id
                       WHERE s.id = %s LIMIT 1""",
                    (storyboard_id,),
                )
                row = cursor.fetchone()
                if row is None or int(row.get("ownerId") or 0) != int(user_id):
                    return None
                return row
        finally:
            connection.close()

    def get_confirmed_storyboard_image(self, storyboard_id: int) -> dict[str, Any] | None:
        """口型入队用已确认静帧（对齐 Node L4400，confirmed_at 优先）。

        :param storyboard_id: 分镜 id。
        :returns: image_assets 行；无命中 None。
        :raises pymysql.MySQLError: 读取失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT * FROM image_assets
                       WHERE storyboard_id = %s AND status = 'confirmed'
                       ORDER BY confirmed_at DESC, id DESC LIMIT 1""",
                    (storyboard_id,),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def get_confirmed_dialogue_audio(self, storyboard_id: int, character_id: int) -> dict[str, Any] | None:
        """口型入队用已确认对白音频（对齐 Node L4408：本镜角色优先 → 无主音频 → 其他角色）。

        :param storyboard_id: 分镜 id。
        :param character_id: 分镜绑定说话角色 id（排序优先级依据）。
        :returns: audio_assets 行；无命中 None。
        :raises pymysql.MySQLError: 读取失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT * FROM audio_assets
                       WHERE storyboard_id = %s AND track_type = 'dialogue' AND status = 'confirmed'
                       ORDER BY CASE
                         WHEN character_id = %s THEN 0
                         WHEN character_id IS NULL THEN 1
                         ELSE 2
                       END ASC,
                         confirmed_at DESC, id DESC
                       LIMIT 1""",
                    (storyboard_id, character_id),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def get_lip_sync_source_video(self, storyboard_id: int) -> dict[str, Any] | None:
        """口型入队用源视频（对齐 Node L4436：confirmed 优先于 archived，排除口型产物）。

        :param storyboard_id: 分镜 id。
        :returns: video_assets 行；无命中 None。
        :raises pymysql.MySQLError: 读取失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT * FROM video_assets
                       WHERE storyboard_id = %s
                         AND status IN ('confirmed', 'archived')
                         AND COALESCE(source_type, 'generated_video') <> 'lip_sync'
                         AND video_url IS NOT NULL
                         AND video_url <> ''
                       ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END ASC,
                         confirmed_at DESC, id DESC LIMIT 1""",
                    (storyboard_id,),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def get_video_for_confirm(self, video_id: int, user_id: int) -> dict[str, Any] | None:
        """视频确认的归属行（对齐 Node L16891：视频 → 分镜 → 场景 → 项目归属链）。

        :param video_id: 视频 id。
        :param user_id: 当前用户 id。
        :returns: 视频行（id/storyboard_id/version_no/video_url/storage_key/quality_report_json）；
            不存在或非本人 None。
        :raises pymysql.MySQLError: 读取失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT va.id, va.storyboard_id, va.version_no, va.video_url, va.storage_key,
                              va.quality_report_json, p.user_id AS ownerId
                       FROM video_assets va
                       INNER JOIN storyboards s ON s.id = va.storyboard_id
                       INNER JOIN script_scenes sc ON sc.id = s.scene_id
                       INNER JOIN projects p ON p.id = sc.project_id
                       WHERE va.id = %s LIMIT 1""",
                    (video_id,),
                )
                row = cursor.fetchone()
                if row is None or int(row.get("ownerId") or 0) != int(user_id):
                    return None
                return row
        finally:
            connection.close()

    def touch_video_url(self, video_id: int, video_url: str) -> None:
        """确认前的视频地址规范化回写（对齐 Node L16909，事务外 autocommit）。

        Node 怪癖按原样保留：该回写发生后，事务内的条件更新
        （``WHERE video_url = 原始地址``）必然 0 行命中并抛「确认期间已发生变化」。
        仅当规范化结果与原值不同时才会走到这里（存量脏数据场景）。

        :param video_id: 视频 id。
        :param video_url: 规范化后的视频地址。
        :raises pymysql.MySQLError: 写入失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("UPDATE video_assets SET video_url = %s WHERE id = %s", (video_url, video_id))
            connection.commit()
        finally:
            connection.close()

    def confirm_video_asset_txn(
        self,
        video_id: int,
        storyboard_id: int,
        original_video_url: str | None,
        confirmed_video_url: str | None,
        quality_report_json: str | None,
    ) -> dict[str, Any]:
        """视频确认事务（对齐 Node L16954：并发条件更新 → 归档旧确认 → 置确认 → 回写分镜）。

        :param video_id: 视频 id。
        :param storyboard_id: 所属分镜 id。
        :param original_video_url: 归属行读到的原始视频地址（条件更新乐观锁依据）。
        :param confirmed_video_url: 确认后地址（与原始地址不同才执行条件更新）。
        :param quality_report_json: 标注 accepted_by_user 后的质量报告 JSON（None 保留原值）。
        :returns: 确认后的完整 video_assets 行。
        :raises RuntimeError: 条件更新 0 行命中（确认期间记录变化，Node 同文案）。
        :raises pymysql.MySQLError: 写入失败时回滚并原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                if confirmed_video_url != original_video_url:
                    cursor.execute(
                        "UPDATE video_assets SET video_url = %s WHERE id = %s AND video_url = %s",
                        (confirmed_video_url, video_id, original_video_url),
                    )
                    if int(cursor.rowcount or 0) != 1:
                        raise RuntimeError("视频记录在确认期间已发生变化，请刷新后重试")
                cursor.execute(
                    """UPDATE video_assets
                       SET status = CASE WHEN status = 'confirmed' THEN 'archived' ELSE status END,
                           confirmed_at = NULL
                       WHERE storyboard_id = %s AND id <> %s""",
                    (storyboard_id, video_id),
                )
                cursor.execute(
                    """UPDATE video_assets
                       SET status = 'confirmed', confirmed_at = NOW(),
                           quality_report_json = COALESCE(%s, quality_report_json)
                       WHERE id = %s""",
                    (quality_report_json, video_id),
                )
                cursor.execute(
                    "UPDATE storyboards SET video_url = %s, updated_at = NOW() WHERE id = %s",
                    (confirmed_video_url, storyboard_id),
                )
                cursor.execute("SELECT * FROM video_assets WHERE id = %s LIMIT 1", (video_id,))
                row = cursor.fetchone()
            connection.commit()
            return row
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    # ------------------------------------------------------------------
    # 项目/资产组剩余（阶段 3.5）：资产画布、角色库、项目删除/导出包。
    # SQL 与归属链路逐条对照 Node index.mjs（行号基准 2026-10-17）。
    # ------------------------------------------------------------------

    def fetch_project_by_id(self, project_id: int) -> dict[str, Any] | None:
        """按 id 读项目行（对齐 Node fetchProjectById，L10685）。

        :param project_id: 项目 id。
        :returns: projects 行；不存在 None。
        :raises pymysql.MySQLError: 读取失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT * FROM projects WHERE id = %s LIMIT 1", (project_id,))
                return cursor.fetchone()
        finally:
            connection.close()

    def list_asset_canvas_nodes(self, project_id: int) -> list[dict[str, Any]]:
        """画布节点行（对齐 Node L13492，附图片计数，排除归档）。

        :param project_id: 项目 id。
        :returns: asset_nodes 行列表（含 image_count）。
        :raises pymysql.MySQLError: 读取失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT n.*,
                              (SELECT COUNT(*) FROM asset_node_images ai WHERE ai.asset_node_id = n.id) AS image_count
                       FROM asset_nodes n
                       WHERE n.project_id = %s AND n.status <> 'archived' ORDER BY n.id ASC""",
                    (project_id,),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def archive_asset_nodes(self, project_id: int, node_ids: list[int]) -> None:
        """批量归档画布节点（读时自愈：旧场景壳/重复节点，Node L13510）。

        :param project_id: 项目 id（限定范围防越界）。
        :param node_ids: 待归档节点 id 列表。
        :raises pymysql.MySQLError: 写入失败时原样抛出。
        """
        if not node_ids:
            return
        placeholders = ", ".join(["%s"] * len(node_ids))
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"UPDATE asset_nodes SET status = 'archived', updated_at = NOW() "
                    f"WHERE project_id = %s AND id IN ({placeholders})",
                    (project_id, *node_ids),
                )
            connection.commit()
        finally:
            connection.close()

    def list_asset_node_images_by_nodes(self, node_ids: list[int]) -> list[dict[str, Any]]:
        """按节点批量读形象行（对齐 Node L13666）。

        :param node_ids: 节点 id 列表。
        :returns: asset_node_images 行列表（按 id 升序）。
        :raises pymysql.MySQLError: 读取失败时原样抛出。
        """
        if not node_ids:
            return []
        placeholders = ", ".join(["%s"] * len(node_ids))
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"SELECT * FROM asset_node_images WHERE asset_node_id IN ({placeholders}) ORDER BY id ASC",
                    tuple(node_ids),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def list_asset_node_images(self, node_id: int) -> list[dict[str, Any]]:
        """单节点形象行列表（对齐 Node L14056）。

        :param node_id: 节点 id。
        :returns: asset_node_images 行列表（按 id 升序）。
        :raises pymysql.MySQLError: 读取失败时原样抛出。
        """
        return self.list_asset_node_images_by_nodes([node_id])

    def get_asset_node_full(self, node_id: int) -> dict[str, Any] | None:
        """画布节点归属行（对齐 Node fetchAssetNodeForUser 首查，L9810）。

        :param node_id: 节点 id。
        :returns: 节点行（含 ownerId/project_visual_style/project_category）；不存在/归档 None。
        :raises pymysql.MySQLError: 读取失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT n.*, p.user_id AS ownerId, p.visual_style AS project_visual_style,
                              p.category AS project_category
                       FROM asset_nodes n
                       INNER JOIN projects p ON p.id = n.project_id
                       WHERE n.id = %s AND n.status <> 'archived' LIMIT 1""",
                    (node_id,),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def get_asset_node_raw(self, node_id: int) -> dict[str, Any] | None:
        """按 id 读节点原始行（无归属过滤，回读用）。

        :param node_id: 节点 id。
        :returns: asset_nodes 行。
        :raises pymysql.MySQLError: 读取失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT * FROM asset_nodes WHERE id = %s LIMIT 1", (node_id,))
                return cursor.fetchone()
        finally:
            connection.close()

    def list_project_scene_rows(self, project_id: int, *, with_anchors: bool = False) -> list[dict[str, Any]]:
        """项目场景行（对齐 Node 画布/relink/hydrate 的场景查询）。

        :param project_id: 项目 id。
        :param with_anchors: 是否包含 spatial_anchors_json 列。
        :returns: 场景行列表。
        :raises pymysql.MySQLError: 读取失败时原样抛出。
        """
        anchor_column = ", spatial_anchors_json" if with_anchors else ""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"""SELECT id, episode_no, scene_no, title, summary, content, location, time_of_day{anchor_column}
                       FROM script_scenes
                       WHERE project_id = %s
                       ORDER BY episode_no ASC, scene_no ASC, id ASC""",
                    (project_id,),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def list_project_character_rows(self, project_id: int, *, with_anchors: bool = False) -> list[dict[str, Any]]:
        """项目角色行（对齐 Node L13537；with_anchors 供提示词构建取 reference 列）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT * FROM characters
                       WHERE project_id = %s AND status <> 'archived' ORDER BY id ASC""",
                    (project_id,),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def list_project_character_names(self, project_id: int) -> list[str]:
        """项目角色名列表（对齐 Node L9926）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT name FROM characters WHERE project_id = %s AND status <> 'archived'",
                    (project_id,),
                )
                return [row["name"] for row in cursor.fetchall() if row.get("name")]
        finally:
            connection.close()

    def update_asset_node_fields(self, node_id: int, assignments: dict[str, Any]) -> dict[str, Any] | None:
        """按白名单列更新画布节点并回读（对齐 Node PATCH L14013 / hydrate L13944）。

        :param node_id: 节点 id。
        :param assignments: ``{列名: 值}``（路由侧已完成白名单过滤）。
        :returns: 更新后的节点原始行。
        :raises pymysql.MySQLError: 写入失败时原样抛出。
        """
        if not assignments:
            return self.get_asset_node_raw(node_id)
        set_clause = ", ".join(f"{column} = %s" for column in assignments)
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"UPDATE asset_nodes SET {set_clause}, updated_at = NOW() WHERE id = %s",
                    (*assignments.values(), node_id),
                )
                cursor.execute("SELECT * FROM asset_nodes WHERE id = %s LIMIT 1", (node_id,))
                row = cursor.fetchone()
            connection.commit()
            return row
        finally:
            connection.close()

    def create_asset_node(self, project_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        """创建画布节点并回读（对齐 Node L13775）。

        :param project_id: 项目 id。
        :param payload: ``{nodeType, refId, label, appearanceLabel, promptText,
            turnaroundPromptText, environmentPromptText, negativePrompt, x, y, width, height, groupKey}``。
        :returns: 新建节点原始行。
        :raises pymysql.MySQLError: 写入失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """INSERT INTO asset_nodes
                      (project_id, node_type, ref_id, label, appearance_label, prompt_text, turnaround_prompt_text,
                       environment_prompt_text, negative_prompt,
                       x, y, width, height, group_key, status)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'active')""",
                    (
                        project_id,
                        payload.get("nodeType"),
                        payload.get("refId"),
                        payload.get("label"),
                        payload.get("appearanceLabel"),
                        payload.get("promptText"),
                        payload.get("turnaroundPromptText"),
                        payload.get("environmentPromptText"),
                        payload.get("negativePrompt"),
                        payload.get("x"),
                        payload.get("y"),
                        payload.get("width"),
                        payload.get("height"),
                        payload.get("groupKey"),
                    ),
                )
                cursor.execute("SELECT * FROM asset_nodes WHERE id = %s LIMIT 1", (cursor.lastrowid,))
                row = cursor.fetchone()
            connection.commit()
            return row
        finally:
            connection.close()

    def archive_asset_node(self, node_id: int) -> None:
        """软删画布节点（status=archived，对齐 Node DELETE L14039）。"""
        self.update_asset_node_fields(node_id, {"status": "archived"})

    def list_passed_single_prop_images(self, node_ids: list[int]) -> list[int]:
        """道具/素材单视角通过视觉检查的图 id（读时自愈自动采用输入，Node L13549）。"""
        if not node_ids:
            return []
        placeholders = ", ".join(["%s"] * len(node_ids))
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"""SELECT id FROM asset_node_images
                       WHERE asset_node_id IN ({placeholders})
                         AND view_set_type = 'single' AND status = 'candidate' AND vision_status = 'passed'""",
                    tuple(node_ids),
                )
                return [int(row["id"]) for row in cursor.fetchall()]
        finally:
            connection.close()

    def get_asset_node_image_full(self, image_id: int) -> dict[str, Any] | None:
        """画布形象归属行（对齐 Node confirm/vision-check 联查，L14085）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT ai.*, n.project_id, n.node_type, n.ref_id, n.label,
                              n.status AS node_status, n.character_identity_lock_json,
                              p.user_id AS ownerId
                       FROM asset_node_images ai
                       INNER JOIN asset_nodes n ON n.id = ai.asset_node_id
                       INNER JOIN projects p ON p.id = n.project_id
                       WHERE ai.id = %s LIMIT 1""",
                    (image_id,),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def get_asset_node_image(self, image_id: int) -> dict[str, Any] | None:
        """按 id 读形象原始行（回读用）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT * FROM asset_node_images WHERE id = %s LIMIT 1", (image_id,))
                return cursor.fetchone()
        finally:
            connection.close()

    def update_asset_node_image_fields(self, image_id: int, assignments: dict[str, Any]) -> dict[str, Any] | None:
        """按白名单列更新形象行并回读。"""
        if not assignments:
            return self.get_asset_node_image(image_id)
        set_clause = ", ".join(f"{column} = %s" for column in assignments)
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"UPDATE asset_node_images SET {set_clause} WHERE id = %s",
                    (*assignments.values(), image_id),
                )
            # This adapter opens a short-lived connection per call; without an
            # explicit commit the confirmation update is rolled back on close.
            connection.commit()
            with connection.cursor() as cursor:
                cursor.execute("SELECT * FROM asset_node_images WHERE id = %s LIMIT 1", (image_id,))
                return cursor.fetchone()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def supersede_asset_node_images(
        self,
        *,
        node_id: int,
        keep_image_id: int,
        view_set_types: list[str],
        view_key: str | None = None,
        source_image_id: int | None = None,
        exclude_matching_source: bool = False,
    ) -> None:
        """同视角 superseded（对齐 Node confirm 各分支 L14223-L14291）。

        :param node_id: 节点 id。
        :param keep_image_id: 保留（当前确认）图 id。
        :param view_set_types: 视图类型列表。
        :param view_key: 视角键（None 不过滤）。
        :param source_image_id: 母图 id（scene-nine-grid 溯源）。
        :param exclude_matching_source: True 时仅 supersede source 与当前图不一致的行。
        :raises pymysql.MySQLError: 写入失败时原样抛出。
        """
        placeholders = ", ".join(["%s"] * len(view_set_types))
        sql = (
            f"UPDATE asset_node_images SET status = 'superseded' "
            f"WHERE asset_node_id = %s AND view_set_type IN ({placeholders}) AND id <> %s "
        )
        params: list[Any] = [node_id, *view_set_types, keep_image_id]
        if view_key is not None:
            sql += "AND view_key = %s "
            params.append(view_key)
        if source_image_id is not None:
            if exclude_matching_source:
                sql += "AND (source_image_id IS NULL OR source_image_id <> %s) "
            else:
                sql += "AND source_image_id = %s "
            params.append(source_image_id)
        sql += "AND status IN ('candidate', 'confirmed')"
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(sql, tuple(params))
            connection.commit()
        finally:
            connection.close()

    def supersede_confirmed_single_images(self, node_id: int, keep_image_id: int) -> None:
        """single 同视角旧确认降级（对齐 Node L14224：仅 confirmed，无 view_key 条件）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """UPDATE asset_node_images SET status = 'superseded'
                       WHERE asset_node_id = %s AND view_set_type = 'single'
                         AND status = 'confirmed' AND id <> %s""",
                    (node_id, keep_image_id),
                )
            connection.commit()
        finally:
            connection.close()

    def commit_asset_adoption_txn(
        self, candidate_ids: list[int], node_type: str, asset_node_id: int, view_type: str | None = None
    ) -> bool:
        """资产采纳事务（对齐 Node commitAssetAdoption，L2327：FOR UPDATE 计划化采纳）。

        :param candidate_ids: 候选图 id 列表。
        :param node_type: 节点类型（character 走板升级/整板采纳，其余单图采纳）。
        :param asset_node_id: 节点 id。
        :param view_type: 非角色采纳的视图类型过滤。
        :returns: 是否完成采纳。
        :raises pymysql.MySQLError: 事务失败时回滚并原样抛出。
        """
        from .domain.asset_canvas import plan_asset_pack_adoption, plan_single_asset_adoption

        ids = sorted({value for value in (_safe_int_param(value) for value in candidate_ids) if value})
        if not ids:
            return False
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                id_placeholders = ", ".join(["%s"] * len(ids))
                cursor.execute(
                    f"SELECT * FROM asset_node_images WHERE asset_node_id = %s AND id IN ({id_placeholders}) FOR UPDATE",
                    (asset_node_id, *ids),
                )
                candidate_rows = list(cursor.fetchall())
                if node_type == "character":
                    legacy_board_ids = [
                        int(row["id"])
                        for row in candidate_rows
                        if str(row.get("view_set_type") or "") == "single" and _is_pack_row(row)
                    ]
                    if legacy_board_ids:
                        board_placeholders = ", ".join(["%s"] * len(legacy_board_ids))
                        cursor.execute(
                            f"""UPDATE asset_node_images
                               SET view_set_type = 'character-asset-pack', view_key = NULL,
                                   view_index = NULL, view_label = '角色资产板'
                               WHERE id IN ({board_placeholders})""",
                            tuple(legacy_board_ids),
                        )
                        for row in candidate_rows:
                            if int(row.get("id") or 0) in legacy_board_ids:
                                row["view_set_type"] = "character-asset-pack"
                                row["view_key"] = None
                                row["view_index"] = None
                                row["view_label"] = "角色资产板"
                    cursor.execute(
                        """SELECT * FROM asset_node_images
                           WHERE asset_node_id = %s AND view_set_type IN
                             ('single', 'character-asset-pack', 'character-face-closeup', 'character-turnaround')
                           FOR UPDATE""",
                        (asset_node_id,),
                    )
                    existing_rows = list(cursor.fetchall())
                    plan = plan_asset_pack_adoption(candidate_rows, existing_rows)
                    if not plan["ready"]:
                        connection.rollback()
                        return False
                else:
                    cursor.execute(
                        "SELECT * FROM asset_node_images WHERE asset_node_id = %s AND view_set_type = %s FOR UPDATE",
                        (asset_node_id, view_type),
                    )
                    existing_rows = list(cursor.fetchall())
                    candidate = next((row for row in candidate_rows if int(row.get("id") or 0) == ids[0]), None)
                    plan = plan_single_asset_adoption(candidate, existing_rows)
                    if not plan["ready"]:
                        connection.rollback()
                        return False
                replace_ids = plan["replaceIds"]
                if replace_ids:
                    replace_placeholders = ", ".join(["%s"] * len(replace_ids))
                    cursor.execute(
                        f"UPDATE asset_node_images SET status = 'superseded' "
                        f"WHERE id IN ({replace_placeholders}) AND status IN ('candidate', 'confirmed')",
                        tuple(replace_ids),
                    )
                adopt_ids = plan.get("adoptIds") or [plan.get("adoptId")]
                adopt_placeholders = ", ".join(["%s"] * len(adopt_ids))
                cursor.execute(
                    f"UPDATE asset_node_images SET status = 'confirmed', confirmed_at = NOW() "
                    f"WHERE id IN ({adopt_placeholders})",
                    tuple(adopt_ids),
                )
            connection.commit()
            return True
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def save_character_identity_lock(self, node_id: int, image_id: int, snapshot_json: str) -> None:
        """确认角色图时写入身份锁快照（对齐 Node L14214）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE asset_nodes SET character_identity_lock_json = %s, updated_at = NOW() WHERE id = %s",
                    (snapshot_json, node_id),
                )
                cursor.execute(
                    "UPDATE asset_node_images SET character_identity_lock_json = %s WHERE id = %s",
                    (snapshot_json, image_id),
                )
            connection.commit()
        finally:
            connection.close()

    def export_package_rows(self, project_id: int, episode_no: int | None = None) -> list[dict[str, Any]]:
        """导出包主查询（对齐 Node buildExportPackage，L10691）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT sc.id AS scene_id,
                              sc.episode_no,
                              sc.scene_no,
                              sc.title AS scene_title,
                              s.id AS storyboard_id,
                              s.shot_no,
                              s.shot_type,
                              s.dialogue_text,
                              s.duration_seconds AS storyboard_duration_seconds,
                              s.image_url,
                              s.video_url,
                              cva.id AS confirmed_video_asset_id,
                              cva.video_url AS confirmed_video_url,
                              cva.thumbnail_url AS confirmed_thumbnail_url,
                              cva.duration_seconds AS confirmed_video_duration_seconds
                       FROM script_scenes sc
                       LEFT JOIN storyboards s ON s.scene_id = sc.id
                       LEFT JOIN (
                         SELECT va.id,
                                va.storyboard_id,
                                va.video_url,
                                va.thumbnail_url,
                                va.duration_seconds
                         FROM video_assets va
                         INNER JOIN (
                           SELECT storyboard_id, MAX(id) AS latest_id
                           FROM video_assets
                           WHERE status = 'confirmed'
                           GROUP BY storyboard_id
                         ) latest_confirmed ON latest_confirmed.latest_id = va.id
                       ) cva ON cva.storyboard_id = s.id
                       WHERE sc.project_id = %s AND (%s IS NULL OR sc.episode_no = %s)
                       ORDER BY sc.scene_no ASC, s.sort_order ASC, s.id ASC""",
                    (project_id, episode_no, episode_no),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def fetch_final_edit_draft(self, project_id: int) -> dict[str, Any] | None:
        """成片编辑草稿行（对齐 Node fetchFinalEditDraft，L8966）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM final_edit_drafts WHERE project_id = %s LIMIT 1",
                    (project_id,),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def get_final_edit_context(
        self, project_id: int, user_id: int, episode_no: int | None = None
    ) -> dict[str, Any] | None:
        """读取 owner 可见的成片编辑聚合输入，不触发媒体生成或写操作。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id, name FROM projects WHERE id = %s AND user_id = %s LIMIT 1",
                    (project_id, user_id),
                )
                project = cursor.fetchone()
                if project is None:
                    return None
                cursor.execute(
                    """SELECT COUNT(s.id) AS total_storyboard_count,
                              COALESCE(SUM(CASE WHEN s.id IS NULL THEN 1 ELSE 0 END), 0)
                                  AS missing_storyboard_scene_count
                       FROM script_scenes sc
                       LEFT JOIN storyboards s ON s.scene_id = sc.id
                       WHERE sc.project_id = %s AND (%s IS NULL OR sc.episode_no = %s)""",
                    (project_id, episode_no, episode_no),
                )
                completeness = cursor.fetchone() or {}
                cursor.execute(
                    """SELECT sc.id AS scene_id, sc.episode_no, sc.scene_no, sc.title AS scene_title,
                              s.id AS storyboard_id, s.shot_no, s.shot_type, s.dialogue_text,
                              s.duration_seconds AS storyboard_duration_seconds, s.sort_order,
                              va.id AS video_asset_id, va.video_url,
                              va.storage_key AS video_storage_key, va.thumbnail_url,
                              va.duration_seconds AS video_duration_seconds,
                              va.version_no AS video_version_no, va.confirmed_at AS video_confirmed_at,
                              ia.id AS image_asset_id, ia.image_url AS confirmed_image_url,
                              ia.storage_key AS image_storage_key,
                              ia.thumbnail_url AS confirmed_image_thumbnail_url
                       FROM script_scenes sc
                       INNER JOIN storyboards s ON s.scene_id = sc.id
                       LEFT JOIN (
                         SELECT v1.* FROM video_assets v1
                         INNER JOIN (
                           SELECT storyboard_id, MAX(id) AS latest_id FROM video_assets
                           WHERE status = 'confirmed' GROUP BY storyboard_id
                         ) latest_video ON latest_video.latest_id = v1.id
                       ) va ON va.storyboard_id = s.id
                       LEFT JOIN (
                         SELECT i1.* FROM image_assets i1
                         INNER JOIN (
                           SELECT storyboard_id, MAX(id) AS latest_id FROM image_assets
                           WHERE status = 'confirmed' GROUP BY storyboard_id
                         ) latest_image ON latest_image.latest_id = i1.id
                       ) ia ON ia.storyboard_id = s.id
                       WHERE sc.project_id = %s AND (%s IS NULL OR sc.episode_no = %s)
                         AND (va.id IS NOT NULL OR ia.id IS NOT NULL)
                       ORDER BY sc.scene_no ASC, s.sort_order ASC, s.id ASC""",
                    (project_id, episode_no, episode_no),
                )
                video_rows = list(cursor.fetchall())
                cursor.execute(
                    """SELECT aa.*, sb.shot_no AS storyboard_shot_no,
                              sb.duration_seconds AS storyboard_duration_seconds,
                              sc.scene_no, sc.title AS scene_title, c.name AS character_name
                       FROM audio_assets aa
                       LEFT JOIN storyboards sb ON sb.id = aa.storyboard_id
                       LEFT JOIN script_scenes sc ON sc.id = aa.scene_id
                       LEFT JOIN characters c ON c.id = aa.character_id
                       WHERE aa.project_id = %s AND aa.status = 'confirmed'
                         AND (%s IS NULL OR sc.episode_no = %s)
                       ORDER BY CASE aa.track_type WHEN 'dialogue' THEN 1 WHEN 'narration' THEN 2
                                  WHEN 'music' THEN 3 WHEN 'sfx' THEN 4 ELSE 99 END ASC,
                                aa.scene_id ASC, aa.id ASC""",
                    (project_id, episode_no, episode_no),
                )
                audio_rows = list(cursor.fetchall())
                cursor.execute(
                    "SELECT * FROM final_edit_drafts WHERE project_id = %s LIMIT 1",
                    (project_id,),
                )
                draft = cursor.fetchone()
            return {
                "project": project,
                "completeness": completeness,
                "videoRows": video_rows,
                "audioRows": audio_rows,
                "draft": draft,
            }
        finally:
            connection.close()

    def save_final_edit_draft(self, project_id: int, user_id: int, draft_json: str) -> bool:
        """锁定 owner 项目后原子 upsert 成片编辑草稿。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id FROM projects WHERE id = %s AND user_id = %s LIMIT 1 FOR UPDATE",
                    (project_id, user_id),
                )
                if cursor.fetchone() is None:
                    connection.rollback()
                    return False
                cursor.execute(
                    """INSERT INTO final_edit_drafts (project_id, draft_json)
                       VALUES (%s, %s)
                       ON DUPLICATE KEY UPDATE draft_json = VALUES(draft_json), updated_at = NOW()""",
                    (project_id, draft_json),
                )
            connection.commit()
            return True
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def delete_project_txn(self, project_id: int, user_id: int) -> bool:
        """项目永久删除事务（对齐 Node L15172：归属条件删除，级联靠 FK）。

        :returns: 是否删除成功（0 行命中 False）。
        :raises pymysql.MySQLError: 事务失败时回滚并原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM projects WHERE id = %s AND user_id = %s",
                    (project_id, user_id),
                )
                deleted = int(cursor.rowcount or 0) > 0
            connection.commit()
            return deleted
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    # -- 角色库 ----------------------------------------------------------

    def list_project_characters(self, project_id: int) -> list[dict[str, Any]]:
        """项目角色列表（对齐 Node L17538，排除归档）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM characters WHERE project_id = %s AND status <> 'archived' ORDER BY id ASC",
                    (project_id,),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def upsert_generated_characters(self, project_id: int, characters: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """按当前解析结果 upsert 角色，并将已不在剧本中的旧角色软归档。"""
        connection = self._connection()
        desired_names = {str(item.get("name") or "").strip().casefold() for item in characters}
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT id FROM projects WHERE id = %s FOR UPDATE", (project_id,))
                for item in characters:
                    cursor.execute(
                        "SELECT id FROM characters WHERE project_id = %s AND name = %s ORDER BY id ASC LIMIT 1 FOR UPDATE",
                        (project_id, item["name"]),
                    )
                    existing = cursor.fetchone()
                    values = (
                        item.get("role_tag"), item.get("personality"), item.get("appearance"),
                        item.get("costume"), item.get("voice_setting"), item.get("age_group"),
                        item.get("gender"), item.get("voice_style"),
                    )
                    if existing:
                        cursor.execute(
                            """UPDATE characters
                               SET role_tag = COALESCE(NULLIF(role_tag, ''), %s),
                                   personality = COALESCE(NULLIF(personality, ''), %s),
                                   appearance = COALESCE(NULLIF(appearance, ''), %s),
                                   costume = COALESCE(NULLIF(costume, ''), %s),
                                   voice_setting = COALESCE(NULLIF(voice_setting, ''), %s),
                                   age_group = COALESCE(NULLIF(age_group, ''), %s),
                                   gender = COALESCE(NULLIF(%s, ''), gender),
                                   voice_style = COALESCE(NULLIF(voice_style, ''), %s),
                                   status = IF(status = 'archived', 'draft', status), updated_at = NOW()
                               WHERE id = %s""",
                            (*values, existing["id"]),
                        )
                    else:
                        cursor.execute(
                            """INSERT INTO characters
                               (project_id, name, role_tag, personality, appearance, costume,
                                voice_setting, age_group, gender, voice_style, status)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'draft')""",
                            (project_id, item["name"], *values),
                        )
                cursor.execute("SELECT id, name, status FROM characters WHERE project_id = %s FOR UPDATE", (project_id,))
                for row in cursor.fetchall():
                    if str(row.get("status") or "draft") != "archived" and str(row.get("name") or "").casefold() not in desired_names:
                        cursor.execute("UPDATE characters SET status = 'archived', updated_at = NOW() WHERE id = %s", (row["id"],))
                cursor.execute(
                    """UPDATE storyboards sb
                       INNER JOIN script_scenes sc ON sc.id = sb.scene_id
                       INNER JOIN characters c ON c.project_id = sc.project_id AND c.name = sb.character_name
                       SET sb.character_id = c.id
                       WHERE sc.project_id = %s AND sb.character_id IS NULL AND c.status <> 'archived'""",
                    (project_id,),
                )
                cursor.execute(
                    "SELECT * FROM characters WHERE project_id = %s AND status <> 'archived' ORDER BY id ASC",
                    (project_id,),
                )
                rows = list(cursor.fetchall())
            connection.commit()
            return rows
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def get_character_for_user(self, character_id: int, extra_project_columns: str = "") -> dict[str, Any] | None:
        """角色归属行（对齐 Node 各 characters/{id} 路由首查，L18179）。"""
        project_select = f", p.{extra_project_columns}" if extra_project_columns else ""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"""SELECT c.*, p.user_id AS ownerId{project_select}
                       FROM characters c
                       INNER JOIN projects p ON p.id = c.project_id
                       WHERE c.id = %s AND c.status <> 'archived' LIMIT 1""",
                    (character_id,),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def character_name_exists(self, project_id: int, name: str, exclude_id: int = 0) -> bool:
        """同项目同名角色存在性（对齐 Node 4009 分支查询）。

        :param project_id: 项目 id。
        :param name: 角色名。
        :param exclude_id: 排除自身（改名场景）。
        :returns: 存在同名（未归档）True。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id FROM characters WHERE project_id = %s AND name = %s AND id <> %s "
                    "AND status <> 'archived' LIMIT 1",
                    (project_id, name, exclude_id),
                )
                return cursor.fetchone() is not None
        finally:
            connection.close()

    def insert_character(self, project_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        """手工新建角色并回读（对齐 Node L17584）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """INSERT INTO characters
                      (project_id, name, role_tag, personality, appearance, voice_setting,
                       age_group, gender, voice_style, reference_image_url, status)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'draft')""",
                    (
                        project_id,
                        payload.get("name"),
                        payload.get("roleTag"),
                        payload.get("personality"),
                        payload.get("appearance"),
                        payload.get("voiceSetting"),
                        payload.get("ageGroup"),
                        payload.get("gender"),
                        payload.get("voiceStyle"),
                        payload.get("referenceImageUrl"),
                    ),
                )
                cursor.execute("SELECT * FROM characters WHERE id = %s LIMIT 1", (cursor.lastrowid,))
                row = cursor.fetchone()
            connection.commit()
            return row
        finally:
            connection.close()

    def archive_character(self, character_id: int) -> None:
        """软删角色（status=archived + 解锁音色，对齐 Node DELETE L18198）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE characters SET status = 'archived', voice_locked = 0, updated_at = NOW() WHERE id = %s",
                    (character_id,),
                )
            connection.commit()
        finally:
            connection.close()

    def update_character_txn(
        self,
        character_id: int,
        assignments: dict[str, Any],
        *,
        rename_plan: dict[str, Any] | None = None,
        require_same_owner: int | None = None,
    ) -> dict[str, Any] | None:
        """角色更新事务（对齐 Node PUT L18264：FOR UPDATE + 改名计划应用）。

        :param character_id: 角色 id。
        :param assignments: 白名单列更新。
        :param rename_plan: 改名计划（非空时事务内应用项目文本同步）。
        :param require_same_owner: 归属校验用户 id（None 跳过）。
        :returns: 更新后的角色行。
        :raises RuntimeError: 行不存在/归属不符/重名（CHARACTER_NAME_CONFLICT）。
        :raises pymysql.MySQLError: 事务失败时回滚并原样抛出。
        """
        from .domain.character_rename import apply_character_rename_plan

        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT c.*, p.user_id AS ownerId
                       FROM characters c
                       INNER JOIN projects p ON p.id = c.project_id
                       WHERE c.id = %s AND c.status <> 'archived' LIMIT 1 FOR UPDATE""",
                    (character_id,),
                )
                locked = cursor.fetchone()
                if locked is None or (require_same_owner is not None and int(locked.get("ownerId") or 0) != int(require_same_owner)):
                    raise RuntimeError("角色不存在或无权访问")
                if assignments:
                    set_clause = ", ".join(f"{column} = %s" for column in assignments)
                    cursor.execute(
                        f"UPDATE characters SET {set_clause}, updated_at = NOW() WHERE id = %s",
                        (*assignments.values(), character_id),
                    )
                if rename_plan is not None:
                    apply_character_rename_plan(cursor, rename_plan, character_id)
                cursor.execute("SELECT * FROM characters WHERE id = %s LIMIT 1", (character_id,))
                row = cursor.fetchone()
            connection.commit()
            return row
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def list_character_images(self, character_id: int) -> list[dict[str, Any]]:
        """角色定妆图列表（对齐 Node L17769，版本倒序）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM character_images WHERE character_id = %s ORDER BY version_no DESC, id ASC",
                    (character_id,),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def get_character_image_full(self, image_id: int) -> dict[str, Any] | None:
        """定妆图归属行（对齐 Node character-images confirm 联查，L17619）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT ci.*, c.project_id, p.user_id AS ownerId
                       FROM character_images ci
                       INNER JOIN characters c ON c.id = ci.character_id
                       INNER JOIN projects p ON p.id = c.project_id
                       WHERE ci.id = %s AND c.status <> 'archived' LIMIT 1""",
                    (image_id,),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def confirm_character_image_txn(
        self, image_id: int, character_id: int, image_url: str | None, storage_key: str | None = None
    ) -> dict[str, Any] | None:
        """定妆图确认事务（对齐 Node L17633：旧确认降级 + 确认 + 角色 finalized）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """UPDATE character_images SET status = 'candidate', confirmed_at = NULL
                       WHERE character_id = %s AND status = 'confirmed'""",
                    (character_id,),
                )
                cursor.execute(
                    "UPDATE character_images SET status = 'confirmed', confirmed_at = NOW() WHERE id = %s",
                    (image_id,),
                )
                cursor.execute(
                    """UPDATE characters
                       SET reference_image_url = %s, reference_image_storage_key = %s,
                           status = 'finalized', updated_at = NOW()
                       WHERE id = %s""",
                    (image_url, storage_key, character_id),
                )
                cursor.execute("SELECT * FROM character_images WHERE id = %s LIMIT 1", (image_id,))
                row = cursor.fetchone()
            connection.commit()
            return row
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def update_character_voice_binding(
        self, character_id: int, assignments: dict[str, Any]
    ) -> dict[str, Any] | None:
        """音色绑定/参考音频写回并回读（对齐 Node L17327 / L17361）。"""
        return self.update_character_fields(character_id, assignments)

    def update_character_fields(self, character_id: int, assignments: dict[str, Any]) -> dict[str, Any] | None:
        """按白名单列更新角色并回读。"""
        if not assignments:
            return self.get_character_for_user(character_id)
        set_clause = ", ".join(f"{column} = %s" for column in assignments)
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"UPDATE characters SET {set_clause}, updated_at = NOW() WHERE id = %s",
                    (*assignments.values(), character_id),
                )
                cursor.execute("SELECT * FROM characters WHERE id = %s LIMIT 1", (character_id,))
                row = cursor.fetchone()
            connection.commit()
            return row
        finally:
            connection.close()

    def list_rename_context_rows(self, project_id: int, character_id: int) -> dict[str, Any]:
        """改名计划所需行集合（Node buildCharacterRenamePlan L9490 的查询块）。

        :param project_id: 项目 id。
        :param character_id: 改名角色 id（历史媒体计数用）。
        :returns: ``{project, outline, scenes, storyboards, characters, media_counts}``。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT id, narrative_vision FROM projects WHERE id = %s LIMIT 1", (project_id,))
                project_rows = list(cursor.fetchall())
                cursor.execute(
                    """SELECT id, title, logline, premise, act1_text, act2_text, act3_text, raw_json
                       FROM story_outlines WHERE project_id = %s
                       ORDER BY version_no DESC, id DESC LIMIT 1""",
                    (project_id,),
                )
                outline_rows = list(cursor.fetchall())
                cursor.execute(
                    """SELECT id, title, summary, content FROM script_scenes WHERE project_id = %s
                       ORDER BY sort_order ASC, scene_no ASC, id ASC""",
                    (project_id,),
                )
                scene_rows = list(cursor.fetchall())
                cursor.execute(
                    """SELECT s.id, s.character_id, s.character_name, s.action_text, s.dialogue_text, s.visual_prompt
                       FROM storyboards s
                       INNER JOIN script_scenes sc ON sc.id = s.scene_id
                       WHERE sc.project_id = %s
                       ORDER BY s.id ASC""",
                    (project_id,),
                )
                storyboard_rows = list(cursor.fetchall())
                cursor.execute(
                    "SELECT id, name FROM characters WHERE project_id = %s ORDER BY id ASC",
                    (project_id,),
                )
                project_character_rows = list(cursor.fetchall())
                cursor.execute(
                    """SELECT
                         (SELECT COUNT(*) FROM character_images WHERE character_id = %(character_id)s) AS character_images,
                         (SELECT COUNT(*) FROM audio_assets WHERE character_id = %(character_id)s) AS audio_assets,
                         (SELECT COUNT(*) FROM image_assets ia
                            INNER JOIN storyboards s ON s.id = ia.storyboard_id
                            WHERE s.character_id = %(character_id)s) AS image_assets,
                         (SELECT COUNT(*) FROM video_assets va
                            INNER JOIN storyboards s ON s.id = va.storyboard_id
                            WHERE s.character_id = %(character_id)s) AS video_assets""",
                    {"character_id": character_id},
                )
                media_counts = cursor.fetchone()
                return {
                    "project": project_rows,
                    "outline": outline_rows,
                    "scenes": scene_rows,
                    "storyboards": storyboard_rows,
                    "characters": project_character_rows,
                    "media_counts": media_counts or {},
                }
        finally:
            connection.close()

    def next_asset_node_image_version(self, node_id: int) -> int:
        """画布形象下一版本号（MAX(version_no)+1，对齐 Node L10006）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT COALESCE(MAX(version_no), 0) AS maxVersion FROM asset_node_images WHERE asset_node_id = %s",
                    (node_id,),
                )
                return int(cursor.fetchone()["maxVersion"] or 0) + 1
        finally:
            connection.close()

    def next_character_image_version(self, character_id: int) -> int:
        """定妆图下一版本号（MAX(version_no)+1，对齐 Node L4343）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT COALESCE(MAX(version_no), 0) AS maxVersion FROM character_images WHERE character_id = %s",
                    (character_id,),
                )
                return int(cursor.fetchone()["maxVersion"] or 0) + 1
        finally:
            connection.close()

    def count_scene_nine_grid_complete_batches(self, node_id: int, panorama_image_id: int) -> int:
        """九宫格完整批次的最大视角数（对齐 Node L10129；≥9 视为整组已生成）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT COALESCE(MAX(view_count), 0) AS view_count
                       FROM (
                         SELECT view_set_version, COUNT(DISTINCT view_key) AS view_count
                         FROM asset_node_images
                         WHERE asset_node_id = %s AND view_set_type = 'scene-nine-grid'
                           AND view_key IS NOT NULL AND source_image_id = %s
                           AND status IN ('candidate', 'confirmed')
                           AND vision_status IN ('passed', 'skipped')
                         GROUP BY view_set_version
                       ) AS complete_batches""",
                    (node_id, panorama_image_id),
                )
                return int((cursor.fetchone() or {}).get("view_count") or 0)
        finally:
            connection.close()

    # ------------------------------------------------------------------
    # 运维端点组（阶段 3.2.5）：health / model-settings / script-agent /
    # storyboard videos / exports 只读。
    # ------------------------------------------------------------------

    def get_user_count(self) -> int:
        """用户总数（对齐 Node getUserCount，/api/health 健康摘要用）。

        :returns: users 表行数；表不可用时由上层捕获为 None。
        :raises pymysql.MySQLError: 查询失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT COUNT(*) AS userCount FROM users")
                return int((cursor.fetchone() or {}).get("userCount") or 0)
        finally:
            connection.close()

    def get_model_settings_map(self) -> dict[str, str]:
        """model_settings 表的 ``{setting_key: setting_value}`` 映射（对齐 Node getPersistedModelSettingMap）。

        :returns: 键值映射（空值为空串）。
        :raises pymysql.MySQLError: 查询失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT setting_key, setting_value FROM model_settings")
                return {row["setting_key"]: (row.get("setting_value") or "") for row in cursor.fetchall()}
        finally:
            connection.close()

    def upsert_model_setting(self, key: str, value: str, user_id: int | None) -> None:
        """单条设置 upsert（对齐 Node saveModelSettings 的 INSERT ... ON DUPLICATE KEY UPDATE）。

        :param key: 设置键（须在 MODEL_SETTING_FIELD_MAP 内，路由层已过滤）。
        :param value: 归一化后的值。
        :param user_id: 操作用户 id（可为 None）。
        :raises pymysql.MySQLError: 写入失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """INSERT INTO model_settings (setting_key, setting_value, updated_by)
                       VALUES (%s, %s, %s)
                       ON DUPLICATE KEY UPDATE
                         setting_value = VALUES(setting_value),
                         updated_by = VALUES(updated_by),
                         updated_at = NOW()""",
                    (key, value, user_id),
                )
            connection.commit()
        finally:
            connection.close()

    def list_script_agent_activities(self, project_id: int, user_id: int, limit: int) -> list[dict[str, Any]]:
        """Script Agent 活动列表（对齐 Node listScriptAgentActivities，id 倒序 LIMIT）。

        :param project_id: 项目 id（归属已由路由前置校验）。
        :param user_id: 用户 id。
        :param limit: 已钳位的条数（1-100）。
        :returns: 活动原始行列表。
        :raises pymysql.MySQLError: 查询失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT * FROM script_agent_activities
                       WHERE project_id = %s AND user_id = %s
                       ORDER BY id DESC LIMIT %s""",
                    (project_id, user_id, limit),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def enqueue_agent_pipeline_run(
        self, *, project_id: int, user_id: int, episode_no: int,
        idempotency_key: str, regenerate: bool,
    ) -> dict[str, Any]:
        """Persist an owner-scoped Agent Pipeline run for the Node Worker to execute."""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT p.id FROM projects p WHERE p.id = %s AND p.user_id = %s LIMIT 1 FOR UPDATE",
                    (project_id, user_id),
                )
                if not cursor.fetchone():
                    connection.rollback()
                    return {"outcome": "not_found"}
                cursor.execute(
                    "SELECT id FROM agent_pipeline_runs WHERE project_id = %s AND user_id = %s "
                    "AND idempotency_key = %s LIMIT 1 FOR UPDATE",
                    (project_id, user_id, idempotency_key),
                )
                existing = cursor.fetchone()
                if existing:
                    connection.rollback()
                    return {"outcome": "existing", "run_id": int(existing["id"])}
                cursor.execute(
                    "SELECT id, content FROM script_scenes WHERE project_id = %s AND episode_no = %s "
                    "ORDER BY sort_order ASC, id ASC",
                    (project_id, episode_no),
                )
                scenes = list(cursor.fetchall())
                if not any(str(scene.get("content") or "").strip() for scene in scenes):
                    connection.rollback()
                    return {"outcome": "script_missing"}
                input_snapshot = {
                    "projectId": project_id,
                    "episodeNo": episode_no,
                    "regenerate": regenerate,
                    "sourceSceneIds": [int(scene["id"]) for scene in scenes],
                }
                cursor.execute(
                    """INSERT INTO agent_pipeline_runs
                       (project_id, user_id, episode_no, status, current_stage, input_snapshot_json, idempotency_key)
                       VALUES (%s, %s, %s, 'queued', 'asset-parse', %s, %s)""",
                    (project_id, user_id, episode_no, json.dumps(input_snapshot, ensure_ascii=False), idempotency_key),
                )
                run_id = int(cursor.lastrowid)
            connection.commit()
            return {"outcome": "queued", "run_id": run_id}
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def list_agent_pipeline_views(self, project_id: int, user_id: int) -> list[dict[str, Any]] | None:
        """读取项目下的 Agent Pipeline 运行、执行记录和事件（owner-scoped）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT apr.*
                       FROM agent_pipeline_runs apr
                       INNER JOIN projects p ON p.id = apr.project_id
                       WHERE apr.project_id = %s AND apr.user_id = %s AND p.user_id = %s
                       ORDER BY apr.updated_at DESC, apr.id DESC""",
                    (project_id, user_id, user_id),
                )
                runs = list(cursor.fetchall())
                if not runs:
                    cursor.execute(
                        "SELECT id FROM projects WHERE id = %s AND user_id = %s LIMIT 1",
                        (project_id, user_id),
                    )
                    return [] if cursor.fetchone() else None

                run_ids = [int(row["id"]) for row in runs]
                placeholders = ", ".join(["%s"] * len(run_ids))
                cursor.execute(
                    f"""SELECT ape.*
                        FROM agent_pipeline_executions ape
                        INNER JOIN agent_pipeline_runs apr ON apr.id = ape.pipeline_run_id
                        WHERE ape.pipeline_run_id IN ({placeholders})
                          AND apr.project_id = %s AND apr.user_id = %s
                        ORDER BY ape.id ASC""",
                    (*run_ids, project_id, user_id),
                )
                executions = list(cursor.fetchall())
                cursor.execute(
                    f"""SELECT ape.*
                        FROM agent_pipeline_events ape
                        INNER JOIN agent_pipeline_runs apr ON apr.id = ape.pipeline_run_id
                        WHERE ape.pipeline_run_id IN ({placeholders})
                          AND apr.project_id = %s AND apr.user_id = %s
                        ORDER BY ape.id ASC""",
                    (*run_ids, project_id, user_id),
                )
                events = list(cursor.fetchall())

            executions_by_run: dict[int, list[dict[str, Any]]] = {run_id: [] for run_id in run_ids}
            events_by_run: dict[int, list[dict[str, Any]]] = {run_id: [] for run_id in run_ids}
            for row in executions:
                executions_by_run[int(row["pipeline_run_id"])].append(row)
            for row in events:
                events_by_run[int(row["pipeline_run_id"])].append(row)
            return [
                {
                    "run": run,
                    "executions": executions_by_run[int(run["id"])],
                    "events": events_by_run[int(run["id"])],
                }
                for run in runs
            ]
        finally:
            connection.close()

    def get_agent_pipeline_view(self, run_id: int, user_id: int) -> dict[str, Any] | None:
        """读取单次 Agent Pipeline 运行及其执行、事件记录（owner-scoped）。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT apr.*
                       FROM agent_pipeline_runs apr
                       INNER JOIN projects p ON p.id = apr.project_id
                       WHERE apr.id = %s AND apr.user_id = %s AND p.user_id = %s
                       LIMIT 1""",
                    (run_id, user_id, user_id),
                )
                run = cursor.fetchone()
                if not run:
                    return None
                cursor.execute(
                    """SELECT ape.*
                       FROM agent_pipeline_executions ape
                       INNER JOIN agent_pipeline_runs apr ON apr.id = ape.pipeline_run_id
                       WHERE ape.pipeline_run_id = %s AND apr.user_id = %s
                       ORDER BY ape.id ASC""",
                    (run_id, user_id),
                )
                executions = list(cursor.fetchall())
                cursor.execute(
                    """SELECT ape.*
                       FROM agent_pipeline_events ape
                       INNER JOIN agent_pipeline_runs apr ON apr.id = ape.pipeline_run_id
                       WHERE ape.pipeline_run_id = %s AND apr.user_id = %s
                       ORDER BY ape.id ASC""",
                    (run_id, user_id),
                )
                events = list(cursor.fetchall())
            return {"run": run, "executions": executions, "events": events}
        finally:
            connection.close()

    def apply_agent_pipeline_decision(
        self, run_id: int, user_id: int, stage_key: str, decision: str, note: str = ""
    ) -> dict[str, str]:
        """Atomically apply a checkpoint decision and queue its next stage."""
        import json as _json

        scripting_next = {
            "asset-parse": "character-lock",
            "character-lock": "scene-lock",
            "scene-lock": "storyboard",
        }
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT apr.* FROM agent_pipeline_runs apr
                       INNER JOIN projects p ON p.id = apr.project_id
                       WHERE apr.id = %s AND apr.user_id = %s AND p.user_id = %s
                       LIMIT 1 FOR UPDATE""",
                    (run_id, user_id, user_id),
                )
                run = cursor.fetchone()
                if not run:
                    connection.rollback()
                    return {"outcome": "not_found"}
                if run.get("status") != "waiting_approval" or run.get("current_stage") != stage_key:
                    connection.rollback()
                    return {"outcome": "not_waiting"}
                cursor.execute(
                    """SELECT * FROM agent_pipeline_executions
                       WHERE pipeline_run_id = %s AND stage_key = %s AND status = 'waiting_approval'
                       ORDER BY id DESC LIMIT 1 FOR UPDATE""",
                    (run_id, stage_key),
                )
                execution = cursor.fetchone()
                if not execution:
                    connection.rollback()
                    return {"outcome": "not_waiting"}

                if decision == "reject":
                    error_text = note or "人工检查点未通过"
                    cursor.execute(
                        """UPDATE agent_pipeline_runs
                           SET status = 'paused', error_text = %s, updated_at = NOW()
                           WHERE id = %s AND user_id = %s""",
                        (error_text, run_id, user_id),
                    )
                    event_status = "rejected"
                    outcome = "paused"
                    payload = {"decision": decision, "note": error_text}
                else:
                    output = execution.get("output_snapshot_json") or "{}"
                    try:
                        output_snapshot = _json.loads(output) if isinstance(output, (str, bytes, bytearray)) else output
                    except (TypeError, ValueError):
                        output_snapshot = {}
                    if not isinstance(output_snapshot, dict):
                        output_snapshot = {}
                    try:
                        all_outputs = _json.loads(run.get("output_snapshot_json") or "{}")
                    except (TypeError, ValueError):
                        all_outputs = {}
                    if not isinstance(all_outputs, dict):
                        all_outputs = {}
                    all_outputs[stage_key] = output_snapshot
                    next_stage = scripting_next.get(stage_key)
                    if next_stage:
                        cursor.execute(
                            """UPDATE agent_pipeline_executions
                               SET status = 'completed', finished_at = NOW(), updated_at = NOW()
                               WHERE id = %s AND status = 'waiting_approval'""",
                            (int(execution["id"]),),
                        )
                        cursor.execute(
                            """UPDATE agent_pipeline_runs
                               SET status = 'queued', current_stage = %s, output_snapshot_json = %s,
                                   error_text = '', updated_at = NOW()
                               WHERE id = %s AND user_id = %s""",
                            (next_stage, _json.dumps(all_outputs, ensure_ascii=False), run_id, user_id),
                        )
                        event_status = "approved"
                        outcome = "queued"
                    elif stage_key == "storyboard":
                        cursor.execute(
                            """UPDATE agent_pipeline_executions
                               SET status = 'completed', finished_at = NOW(), updated_at = NOW()
                               WHERE id = %s AND status = 'waiting_approval'""",
                            (int(execution["id"]),),
                        )
                        cursor.execute(
                            """UPDATE agent_pipeline_runs
                               SET status = 'completed', current_stage = 'storyboard', output_snapshot_json = %s,
                                   error_text = '', updated_at = NOW()
                               WHERE id = %s AND user_id = %s""",
                            (_json.dumps(all_outputs, ensure_ascii=False), run_id, user_id),
                        )
                        event_status = "approved"
                        outcome = "completed"
                    else:
                        error_text = note or "当前阶段已确认，但后续阶段需要由对应业务页面的真实操作触发"
                        cursor.execute(
                            """UPDATE agent_pipeline_runs
                               SET status = 'paused', output_snapshot_json = %s, error_text = %s, updated_at = NOW()
                               WHERE id = %s AND user_id = %s""",
                            (_json.dumps(all_outputs, ensure_ascii=False), error_text, run_id, user_id),
                        )
                        event_status = "approved"
                        outcome = "paused"
                    payload = {"decision": decision, "outputSnapshot": output_snapshot}

                cursor.execute(
                    """INSERT INTO agent_pipeline_events
                       (pipeline_run_id, execution_id, stage_key, agent_key, attempt, status, payload_json)
                       VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                    (run_id, int(execution["id"]), stage_key, execution.get("agent_key"),
                     int(execution.get("attempt") or 1), event_status,
                     _json.dumps(payload, ensure_ascii=False)),
                )
            connection.commit()
            return {"outcome": outcome}
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def register_agent_pipeline_stage_action(
        self, run_id: int, user_id: int, action: dict[str, Any]
    ) -> dict[str, str]:
        """Atomically register a caller-supplied Pipeline stage result, without invoking an Agent."""
        import json as _json

        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT apr.* FROM agent_pipeline_runs apr
                       INNER JOIN projects p ON p.id = apr.project_id
                       WHERE apr.id = %s AND apr.user_id = %s AND p.user_id = %s
                       LIMIT 1 FOR UPDATE""",
                    (run_id, user_id, user_id),
                )
                run = cursor.fetchone()
                if not run:
                    connection.rollback()
                    return {"outcome": "not_found"}
                if run.get("status") not in {"completed", "waiting_approval", "running", "paused"}:
                    connection.rollback()
                    return {"outcome": "not_allowed"}

                idempotency_key = action["idempotencyKey"]
                cursor.execute(
                    """SELECT * FROM agent_pipeline_executions
                       WHERE idempotency_key = %s LIMIT 1 FOR UPDATE""",
                    (idempotency_key,),
                )
                if cursor.fetchone():
                    connection.rollback()
                    return {"outcome": "existing"}

                stage_key = action["stageKey"]
                agent_key = action["agentKey"]
                input_snapshot = action.get("inputSnapshot") or {}
                output_snapshot = action.get("outputSnapshot") or {}
                blockers = action.get("blockers") or []
                status = action.get("status") or "waiting_approval"
                error_text = action.get("errorText") or ""
                allowed_statuses = {"completed", "waiting_approval", "blocked", "retryable_failed", "failed", "canceled"}
                if status not in allowed_statuses:
                    invalid_status = status
                    status = "retryable_failed"
                    error_text = f"Agent 返回了无效状态：{invalid_status}"
                cursor.execute(
                    """INSERT INTO agent_pipeline_executions
                       (pipeline_run_id, stage_key, agent_key, status, attempt, idempotency_key, input_snapshot_json)
                       VALUES (%s, %s, %s, 'queued', 1, %s, %s)""",
                    (run_id, stage_key, agent_key, idempotency_key, _json.dumps(input_snapshot, ensure_ascii=False)),
                )
                execution_id = int(cursor.lastrowid)
                event_base = {
                    "projectId": int(run["project_id"]), "episodeNo": int(run.get("episode_no") or 1),
                    "pipelineId": str(run_id), "pipelineRunId": run_id, "stageKey": stage_key,
                    "agentKey": agent_key, "attempt": 1, "idempotencyKey": idempotency_key,
                }

                def append_event(event_status: str, extra: dict[str, Any] | None = None) -> None:
                    payload = {**event_base, "status": event_status, "executionId": execution_id, **(extra or {})}
                    cursor.execute(
                        """INSERT INTO agent_pipeline_events
                           (pipeline_run_id, execution_id, stage_key, agent_key, attempt, status, payload_json)
                           VALUES (%s, %s, %s, %s, 1, %s, %s)""",
                        (run_id, execution_id, stage_key, agent_key, event_status,
                         _json.dumps(payload, ensure_ascii=False)),
                    )

                append_event("queued")
                cursor.execute(
                    """UPDATE agent_pipeline_executions SET status = 'running', started_at = NOW(),
                       updated_at = NOW() WHERE id = %s""",
                    (execution_id,),
                )
                append_event("running")
                cursor.execute(
                    """UPDATE agent_pipeline_executions
                       SET status = %s, output_snapshot_json = %s, blockers_json = %s, error_text = %s,
                           finished_at = NOW(), updated_at = NOW()
                       WHERE id = %s""",
                    (status, _json.dumps(output_snapshot, ensure_ascii=False),
                     _json.dumps(blockers, ensure_ascii=False), error_text or None, execution_id),
                )
                append_event(status, {
                    "outputSnapshot": output_snapshot, "blockers": blockers, "errorText": error_text,
                })
                try:
                    output_snapshot_json = _json.loads(run.get("output_snapshot_json") or "{}")
                except (ValueError, TypeError):
                    output_snapshot_json = {}
                if not isinstance(output_snapshot_json, dict):
                    output_snapshot_json = {}
                output_snapshot_json[stage_key] = output_snapshot
                error_text = error_text or "；".join(
                    str(item.get("message") or "") for item in blockers if isinstance(item, dict)
                )
                cursor.execute(
                    """UPDATE agent_pipeline_runs
                       SET status = %s, current_stage = %s, output_snapshot_json = %s,
                           error_text = %s, updated_at = NOW()
                       WHERE id = %s AND user_id = %s""",
                    (status, stage_key, _json.dumps(output_snapshot_json, ensure_ascii=False),
                     error_text, run_id, user_id),
                )
            connection.commit()
            return {"outcome": "saved"}
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def list_production_run_rows(self, project_id: int, user_id: int) -> list[dict[str, Any]]:
        """读取用户项目的 ProductionRun 列表，按最近更新时间倒序。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT pr.*, p.name AS project_name
                       FROM production_runs pr
                       INNER JOIN projects p ON p.id = pr.project_id
                       WHERE pr.project_id = %s AND pr.user_id = %s AND p.user_id = %s
                       ORDER BY pr.updated_at DESC, pr.id DESC""",
                    (project_id, user_id, user_id),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def get_production_run_view(self, run_id: int, user_id: int) -> dict[str, Any] | None:
        """读取 owner 可见的 ProductionRun 及阶段、检查点、执行和最新蓝图。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT pr.*, p.name AS project_name
                       FROM production_runs pr
                       INNER JOIN projects p ON p.id = pr.project_id
                       WHERE pr.id = %s AND p.user_id = %s LIMIT 1""",
                    (run_id, user_id),
                )
                run = cursor.fetchone()
                if not run:
                    return None
                cursor.execute(
                    """SELECT * FROM production_stage_runs
                       WHERE production_run_id = %s ORDER BY sequence_no ASC, id ASC""",
                    (run_id,),
                )
                stages = list(cursor.fetchall())
                cursor.execute(
                    """SELECT * FROM production_checkpoints
                       WHERE production_run_id = %s ORDER BY id ASC""",
                    (run_id,),
                )
                checkpoints = list(cursor.fetchall())
                cursor.execute(
                    """SELECT id, agent_key, status, model_name, output_json
                       FROM production_agent_executions
                       WHERE production_run_id = %s ORDER BY id ASC""",
                    (run_id,),
                )
                executions = list(cursor.fetchall())
                cursor.execute(
                    """SELECT * FROM episode_blueprints
                       WHERE production_run_id = %s ORDER BY version_no DESC, id DESC LIMIT 1""",
                    (run_id,),
                )
                blueprint = cursor.fetchone()
                beats = []
                if blueprint:
                    cursor.execute(
                        """SELECT * FROM production_emotion_beats
                           WHERE blueprint_id = %s ORDER BY sequence_no ASC, id ASC""",
                        (blueprint["id"],),
                    )
                    beats = list(cursor.fetchall())
            return {
                "run": run,
                "stages": stages,
                "checkpoints": checkpoints,
                "agentExecutions": executions,
                "blueprint": {"row": blueprint, "emotionBeats": beats} if blueprint else None,
            }
        finally:
            connection.close()

    def find_production_run_by_idempotency(self, project_id: int, user_id: int, key: str) -> dict[str, Any] | None:
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id FROM production_runs WHERE project_id = %s AND user_id = %s AND idempotency_key = %s LIMIT 1",
                    (project_id, user_id, key),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    @staticmethod
    def _production_json(value: Any, fallback: Any) -> Any:
        if isinstance(value, (dict, list)):
            return value
        try:
            decoded = json.loads(value) if value else fallback
            return decoded if isinstance(decoded, type(fallback)) else fallback
        except (TypeError, ValueError):
            return fallback

    def get_production_story_sources(self, project_id: int, episode_no: int) -> dict[str, Any]:
        """读取 ProductionRun 蓝图使用的最新故事资料与分集剧本。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT * FROM story_bibles WHERE project_id = %s ORDER BY version_no DESC, id DESC LIMIT 1", (project_id,))
                bible_row = cursor.fetchone() or {}
                cursor.execute("SELECT * FROM season_structures WHERE project_id = %s ORDER BY version_no DESC, id DESC LIMIT 1", (project_id,))
                season_row = cursor.fetchone() or {}
                cursor.execute(
                    """SELECT ss.scene_no, ss.title AS scene_title, sb.id AS storyboard_id,
                              sb.shot_no, sb.shot_type, sb.duration_seconds, sb.action_text,
                              sb.dialogue_text, sb.visual_prompt, sb.start_visual_prompt, sb.end_visual_prompt
                       FROM script_scenes ss LEFT JOIN storyboards sb ON sb.scene_id = ss.id
                       WHERE ss.project_id = %s AND ss.episode_no = %s
                       ORDER BY ss.scene_no ASC, sb.sort_order ASC, sb.id ASC""",
                    (project_id, episode_no),
                )
                rows = list(cursor.fetchall())
            bible = {key: value for key, value in bible_row.items() if key not in {"id", "project_id", "user_id"}}
            for key in ("world_rules", "timeline", "locations", "characters", "relationships", "props", "subplots",
                        "foreshadowing", "locked_facts", "flexible_facts", "visual_symbols"):
                if key in bible:
                    bible[key] = self._production_json(bible[key], [])
            bible = {
                **bible,
                "emotionalPromise": bible.get("emotional_promise") or "",
                "lockedFacts": bible.get("locked_facts", []),
            }
            episodes = self._production_json(season_row.get("episodes_json"), [])
            episodes = episodes if isinstance(episodes, list) else []
            episode = next((item for index, item in enumerate(episodes, 1)
                            if int(item.get("episodeNo") or item.get("episode_no") or index) == episode_no), {})
            scenes: dict[int, dict[str, Any]] = {}
            shot_map: dict[tuple[int, int], dict[str, Any]] = {}
            first_scene_no = (episode_no - 1) * 2 + 1
            last_scene_no = first_scene_no + 1
            for row in rows:
                number = int(row.get("scene_no") or 0)
                if number < first_scene_no or number > last_scene_no:
                    continue
                if row.get("storyboard_id"):
                    try:
                        shot_no = int(str(row.get("shot_no") or "").split(".", 1)[0])
                    except ValueError:
                        continue
                    if project_id == 12 and episode_no == 1 and (
                        (number == 1 and not 1 <= shot_no <= 5) or (number == 2 and not 6 <= shot_no <= 24)
                    ):
                        continue
                    if number:
                        scenes.setdefault(number, {"sceneNo": number, "title": row.get("scene_title") or ""})
                    candidate = {
                        "storyboardId": int(row["storyboard_id"]), "sceneNo": number,
                        "shotNo": row.get("shot_no"), "shotType": row.get("shot_type"),
                        "durationSeconds": row.get("duration_seconds"), "actionText": row.get("action_text"),
                        "dialogueText": row.get("dialogue_text"), "visualPrompt": row.get("visual_prompt"),
                        "startVisualPrompt": row.get("start_visual_prompt"), "endVisualPrompt": row.get("end_visual_prompt"),
                    }
                    key = (number, shot_no)
                    def richness(item: dict[str, Any]) -> int:
                        return sum(bool(str(item.get(field) or "").strip()) for field in (
                            "actionText", "dialogueText", "visualPrompt", "actingBeat", "audioDirection",
                            "startVisualPrompt", "endVisualPrompt",
                        ))
                    if key not in shot_map or richness(candidate) > richness(shot_map[key]):
                        shot_map[key] = candidate
            shots = sorted(shot_map.values(), key=lambda item: (item["sceneNo"], int(str(item["shotNo"]).split(".", 1)[0])))
            return {"bible": bible, "episode": episode, "season": {"episodes": episodes},
                    "sourceScript": {"scenes": list(scenes.values()), "shots": shots,
                                     "version": f"database-script-project-{project_id}-episode-{episode_no}"}}
        finally:
            connection.close()

    def create_production_run(self, *, project_id: int, user_id: int, project_name: str,
                              seed: dict[str, Any], blueprint: dict[str, Any], quality_report: dict[str, Any],
                              idempotency_key: str | None) -> int:
        """原子创建 ProductionRun、阶段、检查点、执行记录与首版蓝图。"""
        connection = self._connection()
        run = seed["run"]
        try:
            with connection.cursor() as cursor:
                if idempotency_key:
                    cursor.execute("SELECT id FROM production_runs WHERE project_id = %s AND idempotency_key = %s LIMIT 1",
                                   (project_id, idempotency_key))
                    existing = cursor.fetchone()
                    if existing:
                        connection.rollback()
                        return int(existing["id"])
                cursor.execute(
                    """INSERT INTO production_runs
                       (project_id, user_id, episode_no, platform, name, status, current_stage, current_checkpoint,
                        pilot_mode, pilot_scene_count, budget, candidate_policy_json, success_metrics_json,
                        input_snapshot_json, output_snapshot_json, idempotency_key)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (project_id, user_id, run["episodeNo"], run["platform"],
                     f"{project_name or '项目'} · 第 {run['episodeNo']} 集黄金样片", run["status"],
                     run["currentStage"], run["currentCheckpoint"], run["pilotMode"], run["pilotSceneCount"],
                     run["budget"], json.dumps(run["candidatePolicy"], ensure_ascii=False),
                     json.dumps(run["successMetrics"], ensure_ascii=False), json.dumps(run["inputSnapshot"], ensure_ascii=False),
                     json.dumps({"blueprint": blueprint}, ensure_ascii=False), idempotency_key),
                )
                run_id = int(cursor.lastrowid)
                for stage in seed["stages"]:
                    cursor.execute(
                        """INSERT INTO production_stage_runs
                           (production_run_id, stage_key, sequence_no, agent_key, status, input_snapshot_json)
                           VALUES (%s, %s, %s, %s, %s, %s)""",
                        (run_id, stage["stageKey"], stage["sequenceNo"], stage["agentKey"], stage["status"],
                         json.dumps(stage["inputSnapshot"], ensure_ascii=False) if stage["inputSnapshot"] else None),
                    )
                for checkpoint in seed["checkpoints"]:
                    cursor.execute(
                        "INSERT INTO production_checkpoints (production_run_id, checkpoint_key, stage_key, status, decision_note) VALUES (%s, %s, %s, %s, %s)",
                        (run_id, checkpoint["checkpointKey"], checkpoint["stageKey"], checkpoint["status"], checkpoint["decisionNote"]),
                    )
                first = seed["stages"][0]
                cursor.execute("INSERT INTO production_agent_executions (production_run_id, stage_key, agent_key, status) VALUES (%s, %s, %s, 'pending')",
                               (run_id, first["stageKey"], first["agentKey"]))
                cursor.execute(
                    """INSERT INTO episode_blueprints
                       (production_run_id, project_id, episode_no, version_no, status, blueprint_json, quality_report_json)
                       VALUES (%s, %s, %s, 1, 'draft', %s, %s)""",
                    (run_id, project_id, run["episodeNo"], json.dumps(blueprint, ensure_ascii=False),
                     json.dumps(quality_report, ensure_ascii=False)),
                )
            connection.commit()
            return run_id
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def save_production_blueprint(self, run_id: int, user_id: int, blueprint: dict[str, Any],
                                  quality_report: dict[str, Any]) -> int | None:
        """owner-scoped 保存蓝图新版本并同步运行输出快照。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT project_id, episode_no FROM production_runs WHERE id = %s AND user_id = %s FOR UPDATE",
                               (run_id, user_id))
                run = cursor.fetchone()
                if not run:
                    connection.rollback()
                    return None
                cursor.execute("SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no FROM episode_blueprints WHERE production_run_id = %s", (run_id,))
                version = int(cursor.fetchone()["version_no"])
                cursor.execute(
                    """INSERT INTO episode_blueprints
                       (production_run_id, project_id, episode_no, version_no, status, blueprint_json, quality_report_json)
                       VALUES (%s, %s, %s, %s, 'draft', %s, %s)""",
                    (run_id, run["project_id"], run["episode_no"], version, json.dumps(blueprint, ensure_ascii=False),
                     json.dumps(quality_report, ensure_ascii=False)),
                )
                blueprint_id = int(cursor.lastrowid)
                cursor.execute("UPDATE production_runs SET output_snapshot_json = %s, updated_at = NOW() WHERE id = %s",
                               (json.dumps({"blueprint": blueprint}, ensure_ascii=False), run_id))
            connection.commit()
            return blueprint_id
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def apply_production_transition(self, run_id: int, user_id: int, transition: dict[str, Any], *,
                                    checkpoint: bool = False) -> bool:
        """锁定运行行并在单事务中持久化阶段/检查点/运行状态变更。"""
        connection = self._connection()
        run_update = transition["runUpdate"]
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT id, current_stage, current_checkpoint FROM production_runs WHERE id = %s AND user_id = %s FOR UPDATE", (run_id, user_id))
                locked_run = cursor.fetchone()
                if (not locked_run
                    or locked_run.get("current_stage") != transition.get("expectedCurrentStage")
                    or locked_run.get("current_checkpoint") != transition.get("expectedCurrentCheckpoint")):
                    connection.rollback()
                    return False
                if checkpoint:
                    item = transition["checkpointUpdate"]
                    cursor.execute(
                        """UPDATE production_checkpoints SET status = %s, decision_note = %s, reviewed_at = NOW()
                           WHERE production_run_id = %s AND checkpoint_key = %s AND status = 'pending'""",
                        (item["status"], item.get("decisionNote"), run_id, item["checkpointKey"]),
                    )
                    if cursor.rowcount != 1:
                        connection.rollback()
                        return False
                    if transition.get("nextCheckpoint"):
                        item = transition["nextCheckpoint"]
                        cursor.execute("UPDATE production_checkpoints SET status = %s WHERE production_run_id = %s AND checkpoint_key = %s AND status = 'blocked'",
                                       (item["status"], run_id, item["checkpointKey"]))
                for item in transition.get("stageUpdates", []):
                    cursor.execute(
                        """UPDATE production_stage_runs SET status = %s,
                           output_snapshot_json = %s,
                           error_text = CASE WHEN %s = 'completed' THEN NULL ELSE error_text END,
                           started_at = CASE WHEN %s IN ('ready', 'running', 'waiting_approval') THEN COALESCE(started_at, NOW()) ELSE started_at END,
                           finished_at = CASE WHEN %s = 'completed' THEN NOW() ELSE finished_at END
                           WHERE production_run_id = %s AND stage_key = %s""",
                        (item["status"], json.dumps(item.get("outputSnapshot"), ensure_ascii=False) if "outputSnapshot" in item and item.get("outputSnapshot") is not None else None,
                         item["status"], item["status"], item["status"], run_id, item["stageKey"]),
                    )
                for item in transition.get("checkpointUpdates", []):
                    cursor.execute("UPDATE production_checkpoints SET status = %s WHERE production_run_id = %s AND checkpoint_key = %s AND status = 'blocked'",
                                   (item["status"], run_id, item["checkpointKey"]))
                assignments = ["status = %s"]
                params: list[Any] = [run_update["status"]]
                for input_key, column in (("currentStage", "current_stage"), ("currentCheckpoint", "current_checkpoint"),
                                          ("failureCode", "failure_code"), ("failureText", "failure_text")):
                    if input_key in run_update:
                        assignments.append(f"{column} = %s")
                        params.append(run_update[input_key])
                assignments.append("updated_at = NOW()")
                params.extend((run_id, user_id))
                cursor.execute(
                    f"UPDATE production_runs SET {', '.join(assignments)} WHERE id = %s AND user_id = %s",
                    params,
                )
            connection.commit()
            return True
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def load_script_agent_activity(self, activity_id: int, project_id: int, user_id: int) -> dict[str, Any] | None:
        """按 id 加载单条 Script Agent 活动（对齐 Node loadScriptAgentActivity）。

        :param activity_id: 活动 id。
        :param project_id: 项目 id。
        :param user_id: 用户 id。
        :returns: 活动原始行；不存在返回 None。
        :raises pymysql.MySQLError: 查询失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT * FROM script_agent_activities
                       WHERE id = %s AND project_id = %s AND user_id = %s
                       LIMIT 1""",
                    (activity_id, project_id, user_id),
                )
                return cursor.fetchone()
        finally:
            connection.close()

    def insert_script_agent_activity(self, project_id: int, user_id: int, values: dict[str, Any]) -> dict[str, Any]:
        """插入 Script Agent 活动（对齐 Node L13005 INSERT 列族）。

        :param project_id: 项目 id。
        :param user_id: 用户 id。
        :param values: ``stage_key/action_key/agent_key/source/status/title/summary/
                       context/result/reaction/idempotency_key``（context/result/reaction 为对象）。
        :returns: 插入后的完整行。
        :raises pymysql.MySQLError: 写入失败时原样抛出（含 idempotency_key 唯一冲突）。
        """
        import json as _json

        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """INSERT INTO script_agent_activities
                      (project_id, user_id, stage_key, action_key, agent_key, source, status,
                       title, summary, context_json, result_json, reaction_json, idempotency_key)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (
                        project_id,
                        user_id,
                        values.get("stageKey"),
                        values.get("actionKey"),
                        values.get("agentKey"),
                        values.get("source"),
                        values.get("status"),
                        values.get("title"),
                        values.get("summary") or None,
                        _json.dumps(values.get("context") or {}),
                        _json.dumps(values.get("result") or {}),
                        _json.dumps(values.get("reaction") or {}),
                        values.get("idempotencyKey") or None,
                    ),
                )
                cursor.execute("SELECT * FROM script_agent_activities WHERE id = %s", (cursor.lastrowid,))
                row = cursor.fetchone()
            connection.commit()
            return row
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def update_script_agent_activity(
        self, activity_id: int, project_id: int, user_id: int, values: dict[str, Any]
    ) -> dict[str, Any] | None:
        """更新 Script Agent 活动终态（对齐 Node L13076 UPDATE 列族 + finished_at）。

        :param activity_id: 活动 id。
        :param project_id: 项目 id。
        :param user_id: 用户 id。
        :param values: ``status/title/summary/context/result/reaction/error_text``。
        :returns: 更新后的完整行；行不存在返回 None。
        :raises pymysql.MySQLError: 写入失败时原样抛出。
        """
        import json as _json

        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """UPDATE script_agent_activities
                       SET status = %s, title = %s, summary = %s, context_json = %s, result_json = %s,
                           reaction_json = %s, error_text = %s, finished_at = CURRENT_TIMESTAMP
                       WHERE id = %s AND project_id = %s AND user_id = %s""",
                    (
                        values.get("status"),
                        values.get("title"),
                        values.get("summary") or None,
                        _json.dumps(values.get("context") or {}),
                        _json.dumps(values.get("result") or {}),
                        _json.dumps(values.get("reaction") or {}),
                        values.get("errorText") or None,
                        activity_id,
                        project_id,
                        user_id,
                    ),
                )
                cursor.execute(
                    """SELECT * FROM script_agent_activities
                       WHERE id = %s AND project_id = %s AND user_id = %s""",
                    (activity_id, project_id, user_id),
                )
                row = cursor.fetchone()
            connection.commit()
            return row
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def list_storyboard_video_assets(self, storyboard_id: int) -> list[dict[str, Any]]:
        """分镜视频候选列表（对齐 Node L16830：version_no DESC, id DESC）。

        :param storyboard_id: 分镜 id。
        :returns: video_assets 原始行列表。
        :raises pymysql.MySQLError: 查询失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT * FROM video_assets
                       WHERE storyboard_id = %s
                       ORDER BY version_no DESC, id DESC""",
                    (storyboard_id,),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def supersede_storyboard_video_candidates(self, storyboard_id: int) -> None:
        """保留旧未采用结果作为历史，但仅让最新一次生成结果处于待采用状态。"""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """UPDATE video_assets
                       SET status = 'superseded'
                       WHERE storyboard_id = %s AND status = 'candidate'""",
                    (storyboard_id,),
                )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def list_export_records(self, project_id: int) -> list[dict[str, Any]]:
        """项目导出记录列表（对齐 Node L15058：id 倒序）。

        :param project_id: 项目 id。
        :returns: export_records 原始行列表。
        :raises pymysql.MySQLError: 查询失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM export_records WHERE project_id = %s ORDER BY id DESC",
                    (project_id,),
                )
                return list(cursor.fetchall())
        finally:
            connection.close()

    def create_export_record(self, project_id: int, values: dict[str, Any]) -> dict[str, Any]:
        """Persist a queued export for the isolated Worker runtime to consume."""
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """INSERT INTO export_records
                       (project_id, status, video_url, cover_url, duration_seconds, config_json,
                        source_count, ready_count, missing_count)
                       VALUES (%s, 'queued', %s, %s, NULL, %s, %s, %s, %s)""",
                    (
                        project_id,
                        values["video_url"],
                        values.get("cover_url"),
                        values["config_json"],
                        values["source_count"],
                        values["ready_count"],
                        values["missing_count"],
                    ),
                )
                cursor.execute("SELECT * FROM export_records WHERE id = %s LIMIT 1", (cursor.lastrowid,))
                row = cursor.fetchone()
            connection.commit()
            if row is None:
                raise RuntimeError("导出队列记录写入后无法读取")
            return row
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def get_export_record_with_owner(self, export_id: int) -> dict[str, Any] | None:
        """导出记录 + 项目归属（对齐 Node L17208 联查，owner 校验在路由层）。

        :param export_id: 导出记录 id。
        :returns: ``er.* + ownerId`` 行；不存在返回 None。
        :raises pymysql.MySQLError: 查询失败时原样抛出。
        """
        connection = self._connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """SELECT er.*, p.user_id AS ownerId
                       FROM export_records er
                       INNER JOIN projects p ON p.id = er.project_id
                       WHERE er.id = %s LIMIT 1""",
                    (export_id,),
                )
                return cursor.fetchone()
        finally:
            connection.close()


def _safe_int_param(value: Any) -> int:
    """入参安全整数（非正/非法归 0）。"""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0
    return int(parsed) if parsed > 0 and parsed.is_integer() else 0


def _is_pack_row(row: dict[str, Any]) -> bool:
    """事务内复用的角色资产板行判定（导入延迟避免循环依赖）。"""
    from .domain.asset_canvas import is_character_asset_pack_row

    return is_character_asset_pack_row(row)
