"""检查点存储单元测试。

覆盖：InMemoryCheckpointStore 的 save/load/delete/覆盖式快照；
MySQLCheckpointStore 用假 database 断言 SQL 形状与全参数化；
恢复语义——同一后端下新实例（模拟进程重启）load 到同 state。
"""

from __future__ import annotations

import json
from typing import Any

from app.agent.pipeline.checkpoint import InMemoryCheckpointStore, MySQLCheckpointStore


def sample_state() -> dict[str, Any]:
    """构造一份典型编排状态快照。

    :returns: 含 payload/current_stage/status/stage_results 的 state dict。
    """
    return {
        "payload": {"projectId": 7},
        "project_id": 7,
        "current_stage": "scene-lock",
        "status": "waiting_approval",
        "stage_results": {"asset-parse": {}, "character-lock": {}, "scene-lock": {}},
    }


class FakeCheckpointDatabase:
    """模拟 agent_pipeline_checkpoints 表的假 database：记录语句 + 行为化 upsert/delete。

    与 test_agent_run_store.py 的 FakeAgentDatabase 同风格，但为支撑
    "新实例读同后端"的恢复语义测试，模拟了主键 upsert 与按主键删除/查询。
    """

    def __init__(self) -> None:
        """初始化语句记录与空表。"""
        self.statements: list[tuple[str, str, tuple]] = []
        self.rows: dict[str, dict[str, Any]] = {}

    @staticmethod
    def _normalize(sql: str) -> str:
        """归一化 SQL 文本（折叠空白、转大写），便于前缀判断。

        :param sql: 原始 SQL。
        :returns: 归一化后的 SQL。
        """
        return " ".join(sql.split()).upper()

    def execute(self, sql: str, params: tuple = ()) -> int:
        """记录写语句并模拟 upsert/delete 行为。

        :param sql: SQL 文本。
        :param params: 参数化参数。
        :returns: 受影响行数（固定 1）。
        """
        self.statements.append(("execute", sql, params))
        normalized = self._normalize(sql)
        if normalized.startswith("INSERT INTO AGENT_PIPELINE_CHECKPOINTS"):
            thread_id, state_json, status = params
            self.rows[thread_id] = {
                "thread_id": thread_id,
                "state_json": state_json,
                "status": status,
                "updated_at": "2026-10-16 00:00:00",
            }
        elif normalized.startswith("DELETE FROM AGENT_PIPELINE_CHECKPOINTS"):
            (thread_id,) = params
            self.rows.pop(thread_id, None)
        return 1

    def fetchone(self, sql: str, params: tuple = ()) -> dict[str, Any] | None:
        """记录读语句并按主键返回行。

        :param sql: SQL 文本。
        :param params: 参数化参数。
        :returns: 命中行（副本）或 None。
        """
        self.statements.append(("fetchone", sql, params))
        (thread_id,) = params
        row = self.rows.get(thread_id)
        return dict(row) if row is not None else None

    def fetchall(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        """记录读语句并返回全部行副本。

        :param sql: SQL 文本。
        :param params: 参数化参数。
        :returns: 全部行副本列表。
        """
        self.statements.append(("fetchall", sql, params))
        return [dict(row) for row in self.rows.values()]


# ---------------------------------------------------------------------------
# InMemoryCheckpointStore
# ---------------------------------------------------------------------------


def test_inmemory_save_and_load_round_trip():
    """save 后 load 返回同 state 与 status 的快照副本。"""
    store = InMemoryCheckpointStore()
    state = sample_state()
    store.save("run-1", state, "waiting_approval")
    snapshot = store.load("run-1")
    assert snapshot is not None
    assert snapshot["thread_id"] == "run-1"
    assert snapshot["state"] == state
    assert snapshot["status"] == "waiting_approval"
    assert snapshot["updated_at"]


def test_inmemory_save_is_overwrite_semantics():
    """同 thread_id 反复 save 只保留最新快照（覆盖式）。"""
    store = InMemoryCheckpointStore()
    store.save("run-1", {"stage": 1}, "running")
    store.save("run-1", {"stage": 2}, "waiting_approval")
    snapshot = store.load("run-1")
    assert snapshot["state"] == {"stage": 2}
    assert snapshot["status"] == "waiting_approval"


def test_inmemory_snapshot_is_isolated_from_caller_mutation():
    """save 深拷贝入存、load 返回副本：调用方修改不影响存储现场。"""
    store = InMemoryCheckpointStore()
    state = sample_state()
    store.save("run-1", state, "waiting_approval")
    state["status"] = "failed"
    loaded = store.load("run-1")
    loaded["state"]["current_stage"] = "delivery"
    assert store.load("run-1")["state"]["current_stage"] == "scene-lock"
    assert store.load("run-1")["state"]["status"] == "waiting_approval"


def test_inmemory_delete_and_missing_returns_none():
    """delete 后 load 返回 None；未保存的 thread_id load 返回 None。"""
    store = InMemoryCheckpointStore()
    store.save("run-1", {"ok": True}, "running")
    store.delete("run-1")
    assert store.load("run-1") is None
    store.delete("missing-thread")  # 不存在时静默返回
    assert store.load("missing-thread") is None


# ---------------------------------------------------------------------------
# MySQLCheckpointStore（假 database：断言 SQL 参数化 + 行为模拟）
# ---------------------------------------------------------------------------


def test_mysql_save_uses_parameterized_upsert_sql():
    """save 生成参数化 upsert 语句，state/status 以参数传入而非拼接进 SQL。"""
    database = FakeCheckpointDatabase()
    store = MySQLCheckpointStore(database)
    state = sample_state()
    store.save("run-1", state, "waiting_approval")
    kind, sql, params = database.statements[0]
    assert kind == "execute"
    assert "INSERT INTO agent_pipeline_checkpoints" in sql
    assert "ON DUPLICATE KEY UPDATE" in sql
    assert params == ("run-1", json.dumps(state, ensure_ascii=False), "waiting_approval")
    assert '"current_stage": "scene-lock"' not in sql  # 值不出现在 SQL 文本里
    assert "run-1" not in sql


def test_mysql_load_parses_state_json():
    """load 断言主键参数化查询并解析 state_json。"""
    database = FakeCheckpointDatabase()
    store = MySQLCheckpointStore(database)
    state = sample_state()
    store.save("run-9", state, "blocked")
    snapshot = store.load("run-9")
    kind, sql, params = database.statements[1]
    assert kind == "fetchone"
    assert "SELECT thread_id, state_json, status, updated_at" in sql
    assert "WHERE thread_id = %s" in sql
    assert params == ("run-9",)
    assert snapshot["state"] == state
    assert snapshot["status"] == "blocked"


def test_mysql_load_missing_returns_none():
    """查询无行时 load 返回 None。"""
    store = MySQLCheckpointStore(FakeCheckpointDatabase())
    assert store.load("missing-thread") is None


def test_mysql_delete_uses_parameterized_sql():
    """delete 生成参数化 DELETE 并从模拟表中移除行。"""
    database = FakeCheckpointDatabase()
    store = MySQLCheckpointStore(database)
    store.save("run-1", {"ok": True}, "running")
    store.delete("run-1")
    kind, sql, params = database.statements[1]
    assert kind == "execute"
    assert "DELETE FROM agent_pipeline_checkpoints WHERE thread_id = %s" in sql
    assert params == ("run-1",)
    assert store.load("run-1") is None


def test_mysql_checkpoint_survives_new_instance_same_backend():
    """恢复语义：实例 A save 后，同一后端新建实例 B load 到同 state（模拟进程重启）。"""
    database = FakeCheckpointDatabase()
    store_a = MySQLCheckpointStore(database)
    state = sample_state()
    store_a.save("run-restart", state, "waiting_approval")

    store_b = MySQLCheckpointStore(database)  # 新实例：仅共享数据库后端
    snapshot = store_b.load("run-restart")
    assert snapshot is not None
    assert snapshot["thread_id"] == "run-restart"
    assert snapshot["state"] == state
    assert snapshot["status"] == "waiting_approval"


def test_mysql_overwrite_keeps_latest_snapshot_for_new_instance():
    """覆盖式 save 后，新实例读到的也是最新快照。"""
    database = FakeCheckpointDatabase()
    store_a = MySQLCheckpointStore(database)
    store_a.save("run-1", {"stage": 1}, "running")
    store_a.save("run-1", {"stage": 2}, "blocked")

    store_b = MySQLCheckpointStore(database)
    snapshot = store_b.load("run-1")
    assert snapshot["state"] == {"stage": 2}
    assert snapshot["status"] == "blocked"
