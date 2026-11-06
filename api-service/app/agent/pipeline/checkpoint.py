"""Pipeline 编排层的检查点存储（thread_id 维度的整状态快照）。

**设计论证**

1. 为何先用"状态快照式"而非 langgraph 官方 ``BaseCheckpointSaver``：
   - 官方 saver 接口面向 LangGraph 内部的 channel 版本向量模型，需要持久化
     checkpoint 元组（channel_values/channel_versions/versions_seen 等内部结构）
     并与其序列化协议强耦合；
   - 本试点的恢复语义只需要"整状态快照 + thread_id 稳定恢复 + 覆盖式回卷"，
     快照式实现足够，并且与六态对账（:mod:`.recovery` 的 reconcile）直接对齐；
   - 后续若需要 mid-run time-travel 或分支恢复，可在 :class:`CheckpointStore`
     之上再包一层 BaseCheckpointSaver 适配器（把快照映射为单 channel checkpoint），
     演进不阻塞试点交付。
2. 为何 MySQL 够用（不引入 Redis/Postgres）：
   - 每次 run 只在暂停/终态边界写 1-2 次 checkpoint，写入量级远低于现有
     ``agent_pipeline_runs`` 的流量；
   - 复用既有 MySQL 基础设施与参数化 SQL 风格即可满足，不新增中间件运维面。

存储约定：试点阶段 ``thread_id`` 即 run_id（与 ``AgentResult.checkpoint_id`` 同源），
``save`` 为覆盖式快照（同 thread_id 反复 save 只保留最新快照），
``load`` 返回 ``{"thread_id","state","status","updated_at"}`` 或 None。
表结构见 ``api-service/migrations/0002_agent_pipeline_checkpoints.sql``。
"""

from __future__ import annotations

import copy
import json
import threading
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any


def _utc_now_iso() -> str:
    """返回当前 UTC 时间的 ISO 字符串（秒级精度）。

    :returns: 形如 ``2026-10-16T08:00:00+00:00`` 的时间字符串。
    """
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class CheckpointStore(ABC):
    """检查点存储抽象：thread_id 维度的覆盖式整状态快照。"""

    @abstractmethod
    def save(self, thread_id: str, state: dict, status: str) -> None:
        """保存（覆盖式）一份编排状态快照。

        :param thread_id: 线程标识（试点语义下即 run_id）。
        :param state: 编排图状态 dict（整体深拷贝后存储，与调用方隔离）。
        :param status: 快照时刻的 run 状态（六态之一或 queued/running）。
        """

    @abstractmethod
    def load(self, thread_id: str) -> dict | None:
        """按 thread_id 读取最新快照。

        :param thread_id: 线程标识。
        :returns: ``{"thread_id","state","status","updated_at"}``；不存在时返回 None。
        """

    @abstractmethod
    def delete(self, thread_id: str) -> None:
        """删除指定 thread_id 的快照。

        :param thread_id: 线程标识；不存在时静默返回。
        """


class InMemoryCheckpointStore(CheckpointStore):
    """进程内检查点存储；threading.Lock 保护，适合测试与单进程试点。"""

    def __init__(self) -> None:
        """初始化空的快照容器与互斥锁。"""
        self._lock = threading.Lock()
        self._snapshots: dict[str, dict[str, Any]] = {}

    def save(self, thread_id: str, state: dict, status: str) -> None:
        """覆盖式保存快照（深拷贝入存，与调用方后续修改隔离）。

        :param thread_id: 线程标识。
        :param state: 编排图状态 dict。
        :param status: 快照时刻状态。
        """
        with self._lock:
            self._snapshots[thread_id] = {
                "thread_id": thread_id,
                "state": copy.deepcopy(state),
                "status": status,
                "updated_at": _utc_now_iso(),
            }

    def load(self, thread_id: str) -> dict | None:
        """读取快照副本。

        :param thread_id: 线程标识。
        :returns: 快照 dict（state 为深拷贝副本）；不存在时返回 None。
        """
        with self._lock:
            snapshot = self._snapshots.get(thread_id)
            if snapshot is None:
                return None
            return {
                "thread_id": snapshot["thread_id"],
                "state": copy.deepcopy(snapshot["state"]),
                "status": snapshot["status"],
                "updated_at": snapshot["updated_at"],
            }

    def delete(self, thread_id: str) -> None:
        """删除快照；不存在时静默返回。

        :param thread_id: 线程标识。
        """
        with self._lock:
            self._snapshots.pop(thread_id, None)


class MySQLCheckpointStore(CheckpointStore):
    """MySQL 持久化检查点存储（SQL 全参数化，duck-typing 注入）。

    :param database: duck-typing 数据库对象，需提供
        ``execute(sql, params) -> int``、``fetchone(sql, params) -> dict | None``、
        ``fetchall(sql, params) -> list[dict]``；SQL 使用 ``%s`` 占位符
        （与 app.database.MySQLDatabase 的参数化风格一致）。
    """

    def __init__(self, database: Any) -> None:
        """注入数据库适配对象。

        :param database: 提供 execute/fetchone/fetchall 的数据库对象。
        """
        self._database = database

    @staticmethod
    def _dumps(state: dict) -> str:
        """把编排状态序列化为 JSON 字符串。

        :param state: 编排图状态 dict。
        :returns: JSON 字符串（保留非 ASCII 字符）。
        """
        return json.dumps(state, ensure_ascii=False)

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

    def save(self, thread_id: str, state: dict, status: str) -> None:
        """覆盖式保存快照：同 thread_id 重复 save 走 ON DUPLICATE KEY UPDATE。

        :param thread_id: 线程标识。
        :param state: 编排图状态 dict（序列化为 state_json）。
        :param status: 快照时刻状态。
        """
        self._database.execute(
            """INSERT INTO agent_pipeline_checkpoints (thread_id, state_json, status, updated_at)
               VALUES (%s, %s, %s, NOW())
               ON DUPLICATE KEY UPDATE
                 state_json = VALUES(state_json),
                 status = VALUES(status),
                 updated_at = NOW()""",
            (thread_id, self._dumps(state), status),
        )

    def load(self, thread_id: str) -> dict | None:
        """按 thread_id 读取最新快照并解析 state_json。

        :param thread_id: 线程标识。
        :returns: ``{"thread_id","state","status","updated_at"}``；无行时返回 None。
        """
        row = self._database.fetchone(
            """SELECT thread_id, state_json, status, updated_at
               FROM agent_pipeline_checkpoints WHERE thread_id = %s LIMIT 1""",
            (thread_id,),
        )
        if row is None:
            return None
        return {
            "thread_id": row.get("thread_id"),
            "state": self._loads(row.get("state_json")),
            "status": row.get("status"),
            "updated_at": row.get("updated_at"),
        }

    def delete(self, thread_id: str) -> None:
        """删除指定快照；不存在时静默返回。

        :param thread_id: 线程标识。
        """
        self._database.execute(
            "DELETE FROM agent_pipeline_checkpoints WHERE thread_id = %s",
            (thread_id,),
        )
