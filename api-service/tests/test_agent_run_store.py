"""RunStore 单元测试。

覆盖：InMemory 全接口 + 幂等查重；MySQLRunStore 用假 database 对象断言
SQL 形状与全参数化（不连真实 MySQL，风格与 test_database_transactions.py 一致）。
"""

from typing import Any

from app.agent.run_store import InMemoryRunStore, MySQLRunStore
from app.agent.schemas import AgentRequest, AgentResult


def make_request(**overrides) -> AgentRequest:
    """构造测试用 AgentRequest。

    :param overrides: 覆盖默认字段的键值。
    :returns: AgentRequest 实例。
    """
    base = {
        "project_id": 8,
        "task_type": "storyboard_quality",
        "payload": {"sceneId": 3},
        "idempotency_key": "p8-storyboard-quality-3",
    }
    base.update(overrides)
    return AgentRequest(**base)


def make_result(run_id: str, status: str = "completed") -> AgentResult:
    """构造测试用 AgentResult。

    :param run_id: 运行 ID。
    :param status: 终态状态。
    :returns: AgentResult 实例。
    """
    return AgentResult(
        run_id=run_id,
        status=status,
        validated_output={"ok": True},
        trace_id="trace-1",
    )


# ---------------------------------------------------------------------------
# InMemoryRunStore
# ---------------------------------------------------------------------------


def test_inmemory_create_run_and_get_run():
    """create_run 默认状态 queued，get_run 能取回完整记录。"""
    store = InMemoryRunStore()
    run_id = store.create_run(make_request(), "trace-1")
    run = store.get_run(run_id)
    assert run is not None
    assert run["status"] == "queued"
    assert run["project_id"] == 8
    assert run["task_type"] == "storyboard_quality"
    assert run["trace_id"] == "trace-1"
    assert run["payload"] == {"sceneId": 3}
    assert run["result"] is None


def test_inmemory_uses_client_run_id_when_given():
    """客户端指定 run_id 时直接采用。"""
    store = InMemoryRunStore()
    run_id = store.create_run(make_request(run_id="custom-run-1"), "trace-1")
    assert run_id == "custom-run-1"


def test_inmemory_create_run_is_idempotent_by_key():
    """同一幂等键重复 create_run 返回同一 run_id 且不新建。"""
    store = InMemoryRunStore()
    first = store.create_run(make_request(), "trace-1")
    second = store.create_run(make_request(), "trace-2")
    assert first == second
    found = store.find_by_idempotency_key("p8-storyboard-quality-3")
    assert found is not None
    assert found["run_id"] == first


def test_inmemory_find_by_idempotency_key_missing_returns_none():
    """未知幂等键返回 None。"""
    store = InMemoryRunStore()
    assert store.find_by_idempotency_key("nope-nope") is None


def test_inmemory_update_status_and_events():
    """update_status 写入终态结果，append/list_events 保持写入顺序。"""
    store = InMemoryRunStore()
    run_id = store.create_run(make_request(), "trace-1")
    store.append_event(run_id, "queued", {"trace_id": "trace-1"})
    store.append_event(run_id, "running", {"trace_id": "trace-1"})
    store.update_status(run_id, "completed", make_result(run_id))
    run = store.get_run(run_id)
    assert run["status"] == "completed"
    assert run["result"]["status"] == "completed"
    events = store.list_events(run_id)
    assert [event["event_type"] for event in events] == ["queued", "running"]
    assert events[0]["payload"] == {"trace_id": "trace-1"}
    assert events[0]["created_at"]


def test_inmemory_update_status_without_result_keeps_result_none():
    """result 为 None 时只更新状态、不覆盖已有 result。"""
    store = InMemoryRunStore()
    run_id = store.create_run(make_request(), "trace-1")
    store.update_status(run_id, "running", None)
    run = store.get_run(run_id)
    assert run["status"] == "running"
    assert run["result"] is None


# ---------------------------------------------------------------------------
# MySQLRunStore（假 database，断言 SQL 与参数化）
# ---------------------------------------------------------------------------


class FakeAgentDatabase:
    """假 database 对象：按记录式风格捕获 SQL 与参数，模拟 SELECT 返回行。

    :param select_rows: SELECT 语句按序返回的行。
    """

    def __init__(self, select_rows: list[dict[str, Any]] | None = None) -> None:
        """初始化语句记录与 SELECT 返回行。

        :param select_rows: SELECT 返回行列表。
        """
        self.statements: list[tuple[str, str, tuple]] = []
        self.select_rows = select_rows or []

    def execute(self, sql: str, params: tuple = ()) -> int:
        """记录写语句。

        :param sql: SQL 文本。
        :param params: 参数化参数。
        :returns: 受影响行数（固定 1）。
        """
        self.statements.append(("execute", sql, params))
        return 1

    def fetchone(self, sql: str, params: tuple = ()) -> dict[str, Any] | None:
        """记录读语句并返回首行。

        :param sql: SQL 文本。
        :param params: 参数化参数。
        :returns: SELECT 返回首行，其余语句返回 None。
        """
        self.statements.append(("fetchone", sql, params))
        if sql.lstrip().upper().startswith("SELECT"):
            return self.select_rows[0] if self.select_rows else None
        return None

    def fetchall(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        """记录读语句并返回全部行。

        :param sql: SQL 文本。
        :param params: 参数化参数。
        :returns: SELECT 返回全部行，其余语句返回空列表。
        """
        self.statements.append(("fetchall", sql, params))
        if sql.lstrip().upper().startswith("SELECT"):
            return list(self.select_rows)
        return []


def test_mysql_create_run_inserts_with_parameterized_sql():
    """create_run 先查幂等键再 INSERT，SQL 全参数化且值不出现在 SQL 文本里。"""
    database = FakeAgentDatabase()
    store = MySQLRunStore(database)
    run_id = store.create_run(make_request(), "trace-1")
    assert run_id
    assert [kind for kind, _sql, _params in database.statements] == ["fetchone", "execute"]
    _kind, sql, params = database.statements[1]
    assert "INSERT INTO agent_runs" in sql
    assert "VALUES (%s, %s, %s, %s, 'queued', %s, %s, NOW(), NOW())" in sql
    assert params == (
        run_id,
        "p8-storyboard-quality-3",
        8,
        "storyboard_quality",
        '{"sceneId": 3}',
        "trace-1",
    )
    assert run_id not in sql
    assert "p8-storyboard-quality-3" not in sql


def test_mysql_create_run_replays_existing_idempotency_hit():
    """幂等键命中时只做 SELECT、不 INSERT，返回已有 run_id。"""
    database = FakeAgentDatabase(
        select_rows=[{"run_id": "existing-run", "idempotency_key": "p8-storyboard-quality-3"}]
    )
    store = MySQLRunStore(database)
    run_id = store.create_run(make_request(), "trace-1")
    assert run_id == "existing-run"
    assert [kind for kind, _sql, _params in database.statements] == ["fetchone"]
    _kind, sql, params = database.statements[0]
    assert "SELECT * FROM agent_runs WHERE idempotency_key = %s" in sql
    assert params == ("p8-storyboard-quality-3",)


def test_mysql_update_status_writes_result_json():
    """update_status 生成 UPDATE 语句，终态结果序列化为 JSON 参数。"""
    database = FakeAgentDatabase()
    store = MySQLRunStore(database)
    store.update_status("run-1", "completed", make_result("run-1"))
    _kind, sql, params = database.statements[0]
    assert "UPDATE agent_runs" in sql
    assert "SET status = %s, result_json = %s, updated_at = NOW()" in sql
    assert "WHERE run_id = %s" in sql
    status, result_json, run_id = params
    assert (status, run_id) == ("completed", "run-1")
    assert '"status": "completed"' in result_json


def test_mysql_update_status_without_result_writes_null():
    """result 为 None 时 result_json 参数为 NULL。"""
    database = FakeAgentDatabase()
    store = MySQLRunStore(database)
    store.update_status("run-1", "running", None)
    _kind, _sql, params = database.statements[0]
    assert params == ("running", None, "run-1")


def test_mysql_append_event_and_list_events_parse_json():
    """append_event 写参数化 INSERT；list_events 断言排序 SQL 并解析 payload_json。"""
    database = FakeAgentDatabase(
        select_rows=[
            {"id": 1, "event_type": "queued", "payload_json": '{"trace_id": "t1"}', "created_at": "2026-01-01 00:00:00"},
            {"id": 2, "event_type": "running", "payload_json": '{"trace_id": "t1"}', "created_at": "2026-01-01 00:00:01"},
        ]
    )
    store = MySQLRunStore(database)
    store.append_event("run-1", "queued", {"trace_id": "t1"})
    _kind, insert_sql, insert_params = database.statements[0]
    assert "INSERT INTO agent_run_events" in insert_sql
    assert insert_params == ("run-1", "queued", '{"trace_id": "t1"}')

    events = store.list_events("run-1")
    _kind, list_sql, list_params = database.statements[1]
    assert "FROM agent_run_events" in list_sql
    assert "WHERE run_id = %s" in list_sql
    assert "ORDER BY id ASC" in list_sql
    assert list_params == ("run-1",)
    assert [event["event_type"] for event in events] == ["queued", "running"]
    assert events[0]["payload"] == {"trace_id": "t1"}


def test_mysql_get_run_parses_json_columns():
    """get_run 解析 payload_json/result_json 为 dict，并断言查询参数化。"""
    database = FakeAgentDatabase(
        select_rows=[
            {
                "run_id": "run-1",
                "idempotency_key": "p8-storyboard-quality-3",
                "project_id": 8,
                "task_type": "storyboard_quality",
                "status": "completed",
                "payload_json": '{"sceneId": 3}',
                "result_json": '{"run_id": "run-1", "status": "completed"}',
                "trace_id": "trace-1",
            }
        ]
    )
    store = MySQLRunStore(database)
    run = store.get_run("run-1")
    _kind, sql, params = database.statements[0]
    assert "SELECT * FROM agent_runs WHERE run_id = %s" in sql
    assert params == ("run-1",)
    assert run["payload"] == {"sceneId": 3}
    assert run["result"]["status"] == "completed"
    assert "payload_json" not in run


def test_mysql_get_run_missing_returns_none():
    """查询无行时 get_run 返回 None。"""
    store = MySQLRunStore(FakeAgentDatabase())
    assert store.get_run("missing") is None
    assert store.find_by_idempotency_key("missing") is None
