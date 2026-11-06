"""付费提交决策层单元测试。

覆盖：首次成功、幂等返回（reused=True 且不调 submit_fn）、pending 中断重试（复用现场）、
失败重试路径（failed → 重新 pending → 成功）、submit_fn 计数断言、payload 持久化；
MySQLPaidSubmissionStore 用假 database 断言 SQL 形状与全参数化。全程不触真实供应商。
"""

import json
from typing import Any

from app.agent.pipeline.paid_submission import (
    InMemoryPaidSubmissionStore,
    MySQLPaidSubmissionStore,
    prepare_paid_submission,
)


class FakePaidSubmissionDatabase:
    """模拟 agent_paid_submissions 表的假 database：记录语句 + 行为化 upsert/update。

    与 test_agent_run_store.py 的 FakeAgentDatabase 同风格；为支撑跨实例
    （模拟重启）与状态流转断言，按主键模拟了 pending upsert 与 submitted/failed 更新。
    """

    def __init__(self) -> None:
        """初始化语句记录与空表。"""
        self.statements: list[tuple[str, str, tuple]] = []
        self.rows: dict[str, dict[str, Any]] = {}

    @staticmethod
    def _normalize(sql: str) -> str:
        """归一化 SQL 文本（折叠空白、转大写），便于语句类型判断。

        :param sql: 原始 SQL。
        :returns: 归一化后的 SQL。
        """
        return " ".join(sql.split()).upper()

    def execute(self, sql: str, params: tuple = ()) -> int:
        """记录写语句并模拟 INSERT..ON DUPLICATE KEY UPDATE / UPDATE 行为。

        :param sql: SQL 文本。
        :param params: 参数化参数。
        :returns: 受影响行数（固定 1）。
        """
        self.statements.append(("execute", sql, params))
        normalized = self._normalize(sql)
        if normalized.startswith("INSERT INTO AGENT_PAID_SUBMISSIONS"):
            idempotency_key, project_id, stage_key, provider, payload_json = params
            self.rows[idempotency_key] = {
                "idempotency_key": idempotency_key,
                "project_id": project_id,
                "stage_key": stage_key,
                "provider": provider,
                "submission_state": "pending",
                "provider_task_id": None,
                "payload_json": payload_json,
                "updated_at": "2026-10-16 00:00:00",
            }
        elif "UPDATE AGENT_PAID_SUBMISSIONS" in normalized and "SUBMISSION_STATE = 'SUBMITTED'" in normalized:
            provider_task_id, idempotency_key = params
            self.rows[idempotency_key]["submission_state"] = "submitted"
            self.rows[idempotency_key]["provider_task_id"] = provider_task_id
        elif "UPDATE AGENT_PAID_SUBMISSIONS" in normalized and "SUBMISSION_STATE = 'FAILED'" in normalized:
            (idempotency_key,) = params
            self.rows[idempotency_key]["submission_state"] = "failed"
        return 1

    def fetchone(self, sql: str, params: tuple = ()) -> dict[str, Any] | None:
        """记录读语句并按主键返回行副本。

        :param sql: SQL 文本。
        :param params: 参数化参数。
        :returns: 命中行副本或 None。
        """
        self.statements.append(("fetchone", sql, params))
        (idempotency_key,) = params
        row = self.rows.get(idempotency_key)
        return dict(row) if row is not None else None

    def fetchall(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        """记录读语句并返回全部行副本。

        :param sql: SQL 文本。
        :param params: 参数化参数。
        :returns: 全部行副本列表。
        """
        self.statements.append(("fetchall", sql, params))
        return [dict(row) for row in self.rows.values()]


def make_submit_recorder(provider_task_id: str = "prov-task-1"):
    """构造带调用记录的供应商提交 Fake。

    :param provider_task_id: 恒定返回的供应商任务 ID。
    :returns: ``(submit_fn, calls)`` 二元组；calls 记录每次调用的 (payload, existing)。
    """
    calls: list[tuple[dict, dict | None]] = []

    def submit_fn(payload: dict, existing: dict | None) -> dict:
        """模拟供应商提交。

        :param payload: 提交负载。
        :param existing: 既有记录（pending 现场复用时非 None）。
        :returns: 含 provider_task_id 的结果 dict。
        """
        calls.append((payload, existing))
        return {"provider_task_id": provider_task_id}

    return submit_fn, calls


def prepare_kwargs(**overrides) -> dict:
    """构造 prepare_paid_submission 的默认关键字参数。

    :param overrides: 覆盖默认参数的键值。
    :returns: 关键字参数 dict。
    """
    base = {
        "idempotency_key": "storyboard_pipeline:p7:video:sb-42",
        "project_id": 7,
        "stage_key": "video",
        "provider": "provider-a",
        "payload": {"sceneId": 3, "duration": 12},
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# prepare_paid_submission 决策路径
# ---------------------------------------------------------------------------


def test_first_submission_persists_pending_then_marks_submitted():
    """首次提交：先写 pending 再调 submit_fn，成功后落 submitted。"""
    store = InMemoryPaidSubmissionStore()
    submit_fn, calls = make_submit_recorder()
    result = prepare_paid_submission(store, submit_fn, **prepare_kwargs())
    assert result == {
        "idempotency_key": "storyboard_pipeline:p7:video:sb-42",
        "submission_state": "submitted",
        "provider_task_id": "prov-task-1",
        "reused": False,
    }
    assert len(calls) == 1
    record = store.find_by_key("storyboard_pipeline:p7:video:sb-42")
    assert record["submission_state"] == "submitted"
    assert record["provider_task_id"] == "prov-task-1"


def test_idempotent_replay_returns_existing_without_resubmit():
    """已 submitted 的幂等键重复调用：直接返回原结果，submit_fn 不再被调用。"""
    store = InMemoryPaidSubmissionStore()
    submit_fn, calls = make_submit_recorder()
    first = prepare_paid_submission(store, submit_fn, **prepare_kwargs())
    second = prepare_paid_submission(store, submit_fn, **prepare_kwargs())
    assert first["reused"] is False
    assert second == {**first, "reused": True}
    assert len(calls) == 1  # 计数不增：绝不二次提交


def test_pending_replay_reuses_existing_record():
    """pending 现场（上次提交后中断）：以 existing 重调 submit_fn 复用原任务。"""
    store = InMemoryPaidSubmissionStore()
    submit_fn, calls = make_submit_recorder()
    # 手工预置 pending 现场（模拟 mark_submitted 落库前进程中断）。
    store.upsert_pending(
        idempotency_key="storyboard_pipeline:p7:video:sb-42",
        project_id=7, stage_key="video", provider="provider-a", payload={"sceneId": 3},
    )
    result = prepare_paid_submission(store, submit_fn, **prepare_kwargs())
    assert result == {
        "idempotency_key": "storyboard_pipeline:p7:video:sb-42",
        "submission_state": "submitted",
        "provider_task_id": "prov-task-1",
        "reused": True,  # 复用现场
    }
    assert len(calls) == 1
    assert calls[0][1]["submission_state"] == "pending"  # submit_fn 收到 pending 记录


def test_failed_submission_is_retryable_and_recovered():
    """失败路径：submit_fn 异常 → failed（retryable）；重试重新走 pending → 成功。"""
    store = InMemoryPaidSubmissionStore()
    calls: list[tuple[dict, dict | None]] = []

    def flaky_submit_fn(payload: dict, existing: dict | None) -> dict:
        """首次调用抛异常，此后成功的供应商提交 Fake。

        :param payload: 提交负载。
        :param existing: 既有记录。
        :returns: 含 provider_task_id 的结果 dict。
        :raises RuntimeError: 首次调用时抛出。
        """
        calls.append((payload, existing))
        if len(calls) == 1:
            raise RuntimeError("provider timeout")
        return {"provider_task_id": "prov-task-2"}

    kwargs = prepare_kwargs()
    failed = prepare_paid_submission(store, flaky_submit_fn, **kwargs)
    assert failed == {
        "idempotency_key": kwargs["idempotency_key"],
        "submission_state": "failed",
        "provider_task_id": None,
        "reused": False,
    }
    assert store.find_by_key(kwargs["idempotency_key"])["submission_state"] == "failed"

    recovered = prepare_paid_submission(store, flaky_submit_fn, **kwargs)
    assert recovered == {
        "idempotency_key": kwargs["idempotency_key"],
        "submission_state": "submitted",
        "provider_task_id": "prov-task-2",
        "reused": False,  # failed 后全新提交，非现场复用
    }
    assert len(calls) == 2


def test_submit_fn_without_provider_task_id_maps_failed():
    """submit_fn 返回缺少 provider_task_id 时按失败处理（不落 submitted）。"""
    store = InMemoryPaidSubmissionStore()

    def bad_submit_fn(payload: dict, existing: dict | None) -> dict:
        """返回空结果的供应商提交 Fake。

        :param payload: 提交负载。
        :param existing: 既有记录。
        :returns: 空 dict（违反契约）。
        """
        return {}

    result = prepare_paid_submission(store, bad_submit_fn, **prepare_kwargs())
    assert result["submission_state"] == "failed"
    assert store.find_by_key("storyboard_pipeline:p7:video:sb-42")["submission_state"] == "failed"


def test_payload_is_persisted_for_audit_and_retry():
    """payload 在 pending 阶段即持久化，可支撑重试与审计。"""
    store = InMemoryPaidSubmissionStore()
    payload = {"sceneId": 3, "duration": 12, "voiceRef": "voice-7"}
    store.upsert_pending(
        idempotency_key="storyboard_pipeline:p7:video:sb-42",
        project_id=7, stage_key="video", provider="provider-a", payload=payload,
    )
    record = store.find_by_key("storyboard_pipeline:p7:video:sb-42")
    assert record["payload"] == payload
    assert record["provider"] == "provider-a"
    assert record["stage_key"] == "video"
    assert record["project_id"] == 7


# ---------------------------------------------------------------------------
# MySQLPaidSubmissionStore（假 database：断言 SQL 参数化 + 行为模拟）
# ---------------------------------------------------------------------------


def test_mysql_upsert_pending_uses_parameterized_sql():
    """upsert_pending 生成参数化 INSERT..ON DUPLICATE KEY UPDATE，值不拼接进 SQL。"""
    database = FakePaidSubmissionDatabase()
    store = MySQLPaidSubmissionStore(database)
    record = store.upsert_pending(
        idempotency_key="storyboard_pipeline:p7:video:sb-42",
        project_id=7, stage_key="video", provider="provider-a", payload={"sceneId": 3},
    )
    kind, sql, params = database.statements[0]
    assert kind == "execute"
    assert "INSERT INTO agent_paid_submissions" in sql
    assert "ON DUPLICATE KEY UPDATE" in sql
    assert params == (
        "storyboard_pipeline:p7:video:sb-42",
        7,
        "video",
        "provider-a",
        json.dumps({"sceneId": 3}, ensure_ascii=False),
    )
    assert "sb-42" not in sql  # 业务值不出现在 SQL 文本里
    assert record["submission_state"] == "pending"
    assert record["payload"] == {"sceneId": 3}


def test_mysql_find_by_key_parses_payload_json():
    """find_by_key 断言主键参数化查询并解析 payload_json。"""
    database = FakePaidSubmissionDatabase()
    store = MySQLPaidSubmissionStore(database)
    store.upsert_pending(
        idempotency_key="k1", project_id=7, stage_key="video",
        provider="provider-a", payload={"sceneId": 3},
    )
    found = store.find_by_key("k1")
    kind, sql, params = database.statements[1]
    assert kind == "fetchone"
    assert "SELECT idempotency_key, project_id, stage_key, provider, submission_state" in sql
    assert "WHERE idempotency_key = %s" in sql
    assert params == ("k1",)
    assert found["payload"] == {"sceneId": 3}
    assert found["submission_state"] == "pending"
    assert "payload_json" not in found
    assert store.find_by_key("missing-key") is None


def test_mysql_mark_submitted_and_failed_parameterized_updates():
    """mark_submitted / mark_failed 生成参数化 UPDATE 并驱动状态流转。"""
    database = FakePaidSubmissionDatabase()
    store = MySQLPaidSubmissionStore(database)
    store.upsert_pending(
        idempotency_key="k1", project_id=7, stage_key="video",
        provider="provider-a", payload={"sceneId": 3},
    )
    store.mark_submitted("k1", "prov-task-1")
    assert database.rows["k1"]["submission_state"] == "submitted"
    assert database.rows["k1"]["provider_task_id"] == "prov-task-1"

    store.mark_failed("k1")
    assert database.rows["k1"]["submission_state"] == "failed"

    kinds = [kind for kind, _sql, _params in database.statements]
    assert kinds == ["execute", "execute", "execute"]


def test_mysql_prepare_round_trip_across_instances():
    """同一后端下新实例（模拟重启）先查 pending 再复用提交，幂等语义不变。"""
    database = FakePaidSubmissionDatabase()
    store_a = MySQLPaidSubmissionStore(database)
    submit_fn, calls = make_submit_recorder("prov-task-7")
    first = prepare_paid_submission(store_a, submit_fn, **prepare_kwargs())
    assert first["reused"] is False

    store_b = MySQLPaidSubmissionStore(database)  # 新实例：仅共享数据库后端
    second = prepare_paid_submission(store_b, submit_fn, **prepare_kwargs())
    assert second == {
        "idempotency_key": "storyboard_pipeline:p7:video:sb-42",
        "submission_state": "submitted",
        "provider_task_id": "prov-task-7",
        "reused": True,
    }
    assert len(calls) == 1
