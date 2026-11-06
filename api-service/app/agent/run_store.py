"""Agent 运行记录存储。

抽象 :class:`RunStore` 约束 run 生命周期与事件流的读写接口；提供两个实现：
- :class:`InMemoryRunStore`：进程内实现（threading.Lock 保护），用于测试与单进程试点。
- :class:`MySQLRunStore`：MySQL 持久化实现，构造注入 duck-typing 的 database 对象，
  其需提供 ``execute(sql, params) -> int``、``fetchone(sql, params) -> dict | None``、
  ``fetchall(sql, params) -> list[dict]`` 三个方法（与 app.database.MySQLDatabase
  的参数化 SQL 风格一致；真实适配方法在接入时补到 database 层）。

表结构见 ``api-service/migrations/0001_agent_runs.sql``。
"""

from __future__ import annotations

import json
import threading
import uuid
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any

from app.agent.schemas import AgentRequest, AgentResult


def _utc_now_iso() -> str:
    """返回当前 UTC 时间的 ISO 字符串（秒级精度）。

    :returns: 形如 ``2026-10-16T08:00:00+00:00`` 的时间字符串。
    """
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class RunStore(ABC):
    """run 存储抽象：约束 run 生命周期与事件流的读写接口。"""

    @abstractmethod
    def create_run(self, request: AgentRequest, trace_id: str) -> str:
        """创建 run（按 idempotency_key 幂等）。

        :param request: Agent 执行请求。
        :param trace_id: 本次运行的追踪 ID。
        :returns: run_id；幂等命中时返回已有 run_id 且不新建。
        """

    @abstractmethod
    def get_run(self, run_id: str) -> dict[str, Any] | None:
        """按 run_id 读取 run 记录。

        :param run_id: 运行 ID。
        :returns: run 记录 dict（含 status/payload/result 等）；不存在时返回 None。
        """

    @abstractmethod
    def find_by_idempotency_key(self, key: str) -> dict[str, Any] | None:
        """按幂等键查找 run 记录。

        :param key: 幂等键。
        :returns: run 记录 dict；不存在时返回 None。
        """

    @abstractmethod
    def update_status(self, run_id: str, status: str, result: AgentResult | None) -> None:
        """更新 run 状态与终态结果。

        :param run_id: 运行 ID。
        :param status: 新状态。
        :param result: 终态结果；为 None 时仅更新状态、保留原 result。
        """

    @abstractmethod
    def append_event(self, run_id: str, event_type: str, payload: dict[str, Any]) -> None:
        """追加一条 run 事件。

        :param run_id: 运行 ID。
        :param event_type: 事件类型（queued/running/completed/blocked/...）。
        :param payload: 事件负载数据。
        """

    @abstractmethod
    def list_events(self, run_id: str) -> list[dict[str, Any]]:
        """按写入顺序返回 run 的事件列表。

        :param run_id: 运行 ID。
        :returns: 事件 dict 列表（含 event_type/payload/created_at）。
        """


class InMemoryRunStore(RunStore):
    """进程内 run 存储；threading.Lock 保护，适合测试与单进程试点。"""

    def __init__(self) -> None:
        """初始化空的 run/事件/幂等索引容器。"""
        self._lock = threading.Lock()
        self._runs: dict[str, dict[str, Any]] = {}
        self._events: dict[str, list[dict[str, Any]]] = {}
        self._idempotency_index: dict[str, str] = {}

    def create_run(self, request: AgentRequest, trace_id: str) -> str:
        """创建 run；幂等键命中时直接返回已有 run_id。

        :param request: Agent 执行请求。
        :param trace_id: 追踪 ID。
        :returns: run_id。
        """
        with self._lock:
            existing_run_id = self._idempotency_index.get(request.idempotency_key)
            if existing_run_id is not None:
                return existing_run_id
            run_id = request.run_id or uuid.uuid4().hex
            now = _utc_now_iso()
            self._runs[run_id] = {
                "run_id": run_id,
                "idempotency_key": request.idempotency_key,
                "project_id": request.project_id,
                "task_type": request.task_type,
                "status": "queued",
                "payload": request.payload,
                "result": None,
                "trace_id": trace_id,
                "created_at": now,
                "updated_at": now,
            }
            self._idempotency_index[request.idempotency_key] = run_id
            self._events[run_id] = []
            return run_id

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        """按 run_id 读取 run 记录副本。

        :param run_id: 运行 ID。
        :returns: run 记录 dict；不存在时返回 None。
        """
        with self._lock:
            run = self._runs.get(run_id)
            return dict(run) if run is not None else None

    def find_by_idempotency_key(self, key: str) -> dict[str, Any] | None:
        """按幂等键查找 run 记录副本。

        :param key: 幂等键。
        :returns: run 记录 dict；不存在时返回 None。
        """
        with self._lock:
            run_id = self._idempotency_index.get(key)
            if run_id is None:
                return None
            run = self._runs.get(run_id)
            return dict(run) if run is not None else None

    def update_status(self, run_id: str, status: str, result: AgentResult | None) -> None:
        """更新 run 状态与终态结果。

        :param run_id: 运行 ID。
        :param status: 新状态。
        :param result: 终态结果（序列化为 JSON 安全 dict 存储）；None 时保留原 result。
        """
        with self._lock:
            run = self._runs.get(run_id)
            if run is None:
                return
            run["status"] = status
            run["updated_at"] = _utc_now_iso()
            if result is not None:
                run["result"] = result.model_dump(mode="json")

    def append_event(self, run_id: str, event_type: str, payload: dict[str, Any]) -> None:
        """追加一条 run 事件。

        :param run_id: 运行 ID。
        :param event_type: 事件类型。
        :param payload: 事件负载数据。
        """
        with self._lock:
            self._events.setdefault(run_id, []).append(
                {"event_type": event_type, "payload": payload, "created_at": _utc_now_iso()}
            )

    def list_events(self, run_id: str) -> list[dict[str, Any]]:
        """按写入顺序返回 run 的事件列表。

        :param run_id: 运行 ID。
        :returns: 事件 dict 列表。
        """
        with self._lock:
            return [dict(event) for event in self._events.get(run_id, [])]


class MySQLRunStore(RunStore):
    """MySQL 持久化 run 存储（SQL 全参数化）。

    :param database: duck-typing 数据库对象，需提供
        ``execute(sql, params) -> int``、``fetchone(sql, params) -> dict | None``、
        ``fetchall(sql, params) -> list[dict]``；SQL 使用 ``%s`` 占位符。
    """

    def __init__(self, database: Any) -> None:
        """注入数据库适配对象。

        :param database: 提供 execute/fetchone/fetchall 的数据库对象。
        """
        self._database = database

    @staticmethod
    def _dumps(value: Any) -> str | None:
        """把 JSON 值序列化为字符串。

        :param value: 待序列化值（None 原样返回）。
        :returns: JSON 字符串；入参为 None 时返回 None。
        """
        if value is None:
            return None
        return json.dumps(value, ensure_ascii=False)

    @staticmethod
    def _loads(value: Any) -> Any:
        """把 JSON 列值反序列化为 Python 对象。

        :param value: 数据库返回的 JSON 列值（str/bytes/dict/None）。
        :returns: 反序列化结果；解析失败或为 None 时返回 None，非字符串原样返回。
        """
        if value is None:
            return None
        if isinstance(value, (str, bytes, bytearray)):
            try:
                return json.loads(value)
            except (TypeError, ValueError):
                return None
        return value

    @classmethod
    def _row_to_run(cls, row: dict[str, Any] | None) -> dict[str, Any] | None:
        """把数据库行转换为 run 记录（解析 payload_json/result_json 列）。

        :param row: 数据库行 dict 或 None。
        :returns: run 记录 dict（含 payload/result 键）；row 为 None 时返回 None。
        """
        if row is None:
            return None
        record = dict(row)
        record["payload"] = cls._loads(record.pop("payload_json", None))
        record["result"] = cls._loads(record.pop("result_json", None))
        return record

    def create_run(self, request: AgentRequest, trace_id: str) -> str:
        """创建 run；幂等键命中时返回已有 run_id 且不新建。

        :param request: Agent 执行请求。
        :param trace_id: 追踪 ID。
        :returns: run_id（客户端指定或自动生成 uuid4 hex）。
        """
        existing = self.find_by_idempotency_key(request.idempotency_key)
        if existing is not None:
            return str(existing["run_id"])
        run_id = request.run_id or uuid.uuid4().hex
        # 并发竞态由 idempotency_key 的 UNIQUE 约束兜底：重复插入会失败而非产生重复 run。
        self._database.execute(
            """INSERT INTO agent_runs
               (run_id, idempotency_key, project_id, task_type, status, payload_json,
                trace_id, created_at, updated_at)
               VALUES (%s, %s, %s, %s, 'queued', %s, %s, NOW(), NOW())""",
            (
                run_id,
                request.idempotency_key,
                request.project_id,
                request.task_type,
                self._dumps(request.payload),
                trace_id,
            ),
        )
        return run_id

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        """按 run_id 读取 run 记录。

        :param run_id: 运行 ID。
        :returns: run 记录 dict（payload/result 已解析）；不存在时返回 None。
        """
        row = self._database.fetchone(
            "SELECT * FROM agent_runs WHERE run_id = %s LIMIT 1",
            (run_id,),
        )
        return self._row_to_run(row)

    def find_by_idempotency_key(self, key: str) -> dict[str, Any] | None:
        """按幂等键查找 run 记录。

        :param key: 幂等键。
        :returns: run 记录 dict（payload/result 已解析）；不存在时返回 None。
        """
        row = self._database.fetchone(
            "SELECT * FROM agent_runs WHERE idempotency_key = %s LIMIT 1",
            (key,),
        )
        return self._row_to_run(row)

    def update_status(self, run_id: str, status: str, result: AgentResult | None) -> None:
        """更新 run 状态与终态结果。

        :param run_id: 运行 ID。
        :param status: 新状态。
        :param result: 终态结果；None 时 result_json 写 NULL。
        """
        result_json = self._dumps(result.model_dump(mode="json")) if result is not None else None
        self._database.execute(
            """UPDATE agent_runs
               SET status = %s, result_json = %s, updated_at = NOW()
               WHERE run_id = %s""",
            (status, result_json, run_id),
        )

    def append_event(self, run_id: str, event_type: str, payload: dict[str, Any]) -> None:
        """追加一条 run 事件。

        :param run_id: 运行 ID。
        :param event_type: 事件类型。
        :param payload: 事件负载数据。
        """
        self._database.execute(
            """INSERT INTO agent_run_events (run_id, event_type, payload_json, created_at)
               VALUES (%s, %s, %s, NOW())""",
            (run_id, event_type, self._dumps(payload)),
        )

    def list_events(self, run_id: str) -> list[dict[str, Any]]:
        """按写入顺序（id ASC）返回 run 的事件列表。

        :param run_id: 运行 ID。
        :returns: 事件 dict 列表（含 event_type/payload/created_at）。
        """
        rows = self._database.fetchall(
            """SELECT id, event_type, payload_json, created_at
               FROM agent_run_events WHERE run_id = %s ORDER BY id ASC""",
            (run_id,),
        )
        events: list[dict[str, Any]] = []
        for row in rows:
            events.append(
                {
                    "id": row.get("id"),
                    "event_type": row.get("event_type"),
                    "payload": self._loads(row.get("payload_json")),
                    "created_at": row.get("created_at"),
                }
            )
        return events
