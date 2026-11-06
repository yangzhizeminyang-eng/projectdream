"""付费节点的提交决策层："先创建幂等任务，再提交供应商"。

适用阶段：``video``（付费提交，worker_owned）等任何会产生外部费用的提交动作。
编排层纪律：voice/video/delivery 等长耗时阶段在编排层只做"准备与提交决策"，
真实执行归 Worker；本模块保证同一幂等键**绝不二次提交**：

1. 幂等键已有 ``submitted`` 记录 → 直接返回（含 provider_task_id），不调 submit_fn；
2. 已有 ``pending`` 记录（上次提交后中断）→ 以 ``existing`` 调 submit_fn，由其自行
   决定复用供应商侧任务或安全重建（层间契约：submit_fn 收到 existing 时必须能
   返回原 provider_task_id，或基于稳定业务键安全重建）；
3. 无记录或上次 ``failed`` → 先写 ``pending``（先创建幂等任务），再调 submit_fn；
   成功 → ``submitted`` + provider_task_id；异常 → ``failed``（retryable，可重试）。
"""

from __future__ import annotations

import json
import threading
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any, Callable

# submit_fn 契约类型：接收 (payload, existing) 返回 {"provider_task_id": ...}。
SubmitFn = Callable[[dict, dict | None], dict]


def _utc_now_iso() -> str:
    """返回当前 UTC 时间的 ISO 字符串（秒级精度）。

    :returns: 形如 ``2026-10-16T08:00:00+00:00`` 的时间字符串。
    """
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class PaidSubmissionStore(ABC):
    """付费提交记录存储抽象：按幂等键记录 pending/submitted/failed 生命周期。"""

    @abstractmethod
    def find_by_key(self, idempotency_key: str) -> dict | None:
        """按幂等键查找提交记录。

        :param idempotency_key: 幂等键。
        :returns: 提交记录 dict（含 submission_state/provider_task_id/payload 等）；
            不存在时返回 None。
        """

    @abstractmethod
    def upsert_pending(
        self,
        *,
        idempotency_key: str,
        project_id: int,
        stage_key: str,
        provider: str,
        payload: dict,
    ) -> dict:
        """写入（或覆盖为）pending 记录。

        :param idempotency_key: 幂等键。
        :param project_id: 项目 ID。
        :param stage_key: 阶段键（如 video）。
        :param provider: 供应商标识。
        :param payload: 提交负载（持久化用于重试/审计）。
        :returns: 写入后的记录 dict（submission_state=pending、provider_task_id=None）。
        """

    @abstractmethod
    def mark_submitted(self, idempotency_key: str, provider_task_id: str) -> None:
        """把记录标记为 submitted 并落供应商任务 ID。

        :param idempotency_key: 幂等键。
        :param provider_task_id: 供应商侧任务 ID。
        """

    @abstractmethod
    def mark_failed(self, idempotency_key: str) -> None:
        """把记录标记为 failed（retryable，后续重试会重新走 pending 流程）。

        :param idempotency_key: 幂等键。
        """


class InMemoryPaidSubmissionStore(PaidSubmissionStore):
    """进程内付费提交记录存储；threading.Lock 保护，适合测试与单进程试点。"""

    def __init__(self) -> None:
        """初始化空的记录容器与互斥锁。"""
        self._lock = threading.Lock()
        self._records: dict[str, dict[str, Any]] = {}

    def find_by_key(self, idempotency_key: str) -> dict | None:
        """按幂等键查找记录副本。

        :param idempotency_key: 幂等键。
        :returns: 记录 dict；不存在时返回 None。
        """
        with self._lock:
            record = self._records.get(idempotency_key)
            return dict(record) if record is not None else None

    def upsert_pending(
        self,
        *,
        idempotency_key: str,
        project_id: int,
        stage_key: str,
        provider: str,
        payload: dict,
    ) -> dict:
        """写入或覆盖为 pending 记录（provider_task_id 清空，payload 持久化）。

        :param idempotency_key: 幂等键。
        :param project_id: 项目 ID。
        :param stage_key: 阶段键。
        :param provider: 供应商标识。
        :param payload: 提交负载。
        :returns: 写入后的记录 dict。
        """
        record = {
            "idempotency_key": idempotency_key,
            "project_id": project_id,
            "stage_key": stage_key,
            "provider": provider,
            "submission_state": "pending",
            "provider_task_id": None,
            "payload": dict(payload),
            "updated_at": _utc_now_iso(),
        }
        with self._lock:
            self._records[idempotency_key] = record
        return dict(record)

    def mark_submitted(self, idempotency_key: str, provider_task_id: str) -> None:
        """标记 submitted 并记录 provider_task_id。

        :param idempotency_key: 幂等键。
        :param provider_task_id: 供应商侧任务 ID。
        """
        with self._lock:
            record = self._records.get(idempotency_key)
            if record is None:
                return
            record["submission_state"] = "submitted"
            record["provider_task_id"] = provider_task_id
            record["updated_at"] = _utc_now_iso()

    def mark_failed(self, idempotency_key: str) -> None:
        """标记 failed（保留原 payload 供审计）。

        :param idempotency_key: 幂等键。
        """
        with self._lock:
            record = self._records.get(idempotency_key)
            if record is None:
                return
            record["submission_state"] = "failed"
            record["updated_at"] = _utc_now_iso()


class MySQLPaidSubmissionStore(PaidSubmissionStore):
    """MySQL 持久化付费提交记录存储（SQL 全参数化，duck-typing 注入）。

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
    def _row_to_record(cls, row: dict[str, Any] | None) -> dict[str, Any] | None:
        """把数据库行转换为提交记录（解析 payload_json 列）。

        :param row: 数据库行 dict 或 None。
        :returns: 记录 dict（payload 已解析）；row 为 None 时返回 None。
        """
        if row is None:
            return None
        record = dict(row)
        record["payload"] = cls._loads(record.pop("payload_json", None))
        return record

    def find_by_key(self, idempotency_key: str) -> dict | None:
        """按幂等键查找提交记录。

        :param idempotency_key: 幂等键。
        :returns: 记录 dict（payload 已解析）；不存在时返回 None。
        """
        row = self._database.fetchone(
            """SELECT idempotency_key, project_id, stage_key, provider, submission_state,
                      provider_task_id, payload_json, updated_at
               FROM agent_paid_submissions WHERE idempotency_key = %s LIMIT 1""",
            (idempotency_key,),
        )
        return self._row_to_record(row)

    def upsert_pending(
        self,
        *,
        idempotency_key: str,
        project_id: int,
        stage_key: str,
        provider: str,
        payload: dict,
    ) -> dict:
        """写入或覆盖为 pending 记录（provider_task_id 置 NULL，先创建幂等任务）。

        :param idempotency_key: 幂等键。
        :param project_id: 项目 ID。
        :param stage_key: 阶段键。
        :param provider: 供应商标识。
        :param payload: 提交负载。
        :returns: 写入后的记录 dict（含持久化的 payload）。
        """
        payload_json = json.dumps(payload, ensure_ascii=False)
        self._database.execute(
            """INSERT INTO agent_paid_submissions
                 (idempotency_key, project_id, stage_key, provider, submission_state,
                  provider_task_id, payload_json, updated_at)
               VALUES (%s, %s, %s, %s, 'pending', NULL, %s, NOW())
               ON DUPLICATE KEY UPDATE
                 project_id = VALUES(project_id),
                 stage_key = VALUES(stage_key),
                 provider = VALUES(provider),
                 submission_state = 'pending',
                 provider_task_id = NULL,
                 payload_json = VALUES(payload_json),
                 updated_at = NOW()""",
            (idempotency_key, project_id, stage_key, provider, payload_json),
        )
        return {
            "idempotency_key": idempotency_key,
            "project_id": project_id,
            "stage_key": stage_key,
            "provider": provider,
            "submission_state": "pending",
            "provider_task_id": None,
            "payload": dict(payload),
        }

    def mark_submitted(self, idempotency_key: str, provider_task_id: str) -> None:
        """标记 submitted 并落 provider_task_id。

        :param idempotency_key: 幂等键。
        :param provider_task_id: 供应商侧任务 ID。
        """
        self._database.execute(
            """UPDATE agent_paid_submissions
               SET submission_state = 'submitted', provider_task_id = %s, updated_at = NOW()
               WHERE idempotency_key = %s""",
            (provider_task_id, idempotency_key),
        )

    def mark_failed(self, idempotency_key: str) -> None:
        """标记 failed（retryable，可重新走 pending 流程）。

        :param idempotency_key: 幂等键。
        """
        self._database.execute(
            """UPDATE agent_paid_submissions
               SET submission_state = 'failed', updated_at = NOW()
               WHERE idempotency_key = %s""",
            (idempotency_key,),
        )


def _submit_once(
    store: PaidSubmissionStore,
    submit_fn: SubmitFn,
    *,
    idempotency_key: str,
    payload: dict,
    existing: dict,
    reused: bool,
) -> dict:
    """执行一次供应商提交决策并回写记录状态。

    :param store: 付费提交记录存储。
    :param submit_fn: 供应商提交函数 ``(payload, existing) -> {"provider_task_id": ...}``；
        收到 existing（pending 记录）时必须复用原任务或安全重建。
    :param idempotency_key: 幂等键。
    :param payload: 提交负载。
    :param existing: 传给 submit_fn 的既有记录（首次为刚写入的 pending 记录）。
    :param reused: 返回结果中 reused 字段的取值（复用现场时为 True）。
    :returns: 决策结果 dict，含 ``idempotency_key/submission_state/provider_task_id/reused``。
    """
    try:
        result = submit_fn(payload, existing)
        provider_task_id = (result or {}).get("provider_task_id")
        if not provider_task_id:
            raise ValueError("submit_fn 必须返回 provider_task_id")
    except Exception:
        # 提交失败：落 failed（retryable，可重试）；异常细节不上抛、不落库（防泄露）。
        store.mark_failed(idempotency_key)
        return {
            "idempotency_key": idempotency_key,
            "submission_state": "failed",
            "provider_task_id": None,
            "reused": reused,
        }
    store.mark_submitted(idempotency_key, str(provider_task_id))
    return {
        "idempotency_key": idempotency_key,
        "submission_state": "submitted",
        "provider_task_id": str(provider_task_id),
        "reused": reused,
    }


def prepare_paid_submission(
    store: PaidSubmissionStore,
    submit_fn: SubmitFn,
    *,
    idempotency_key: str,
    project_id: int,
    stage_key: str,
    provider: str,
    payload: dict,
) -> dict:
    """付费提交决策入口：保证同一幂等键绝不二次提交供应商。

    :param store: 付费提交记录存储。
    :param submit_fn: 供应商提交函数 ``(payload: dict, existing: dict | None) -> dict``，
        返回 ``{"provider_task_id": ...}``；测试可注入 Fake，不触真实供应商。
    :param idempotency_key: 幂等键（见 :mod:`.idempotency`）。
    :param project_id: 项目 ID。
    :param stage_key: 阶段键（如 video）。
    :param provider: 供应商标识。
    :param payload: 提交负载。
    :returns: 决策结果 dict，含 ``idempotency_key/submission_state/provider_task_id/reused``；
        ``reused=True`` 表示命中已有记录（submitted 幂等返回或 pending 现场复用）。
    """
    existing = store.find_by_key(idempotency_key)
    if existing is not None and existing.get("submission_state") == "submitted":
        # 已提交过：直接返回原 provider_task_id，绝不二次提交。
        return {
            "idempotency_key": idempotency_key,
            "submission_state": "submitted",
            "provider_task_id": existing.get("provider_task_id"),
            "reused": True,
        }
    if existing is not None and existing.get("submission_state") == "pending":
        # 上次提交后中断：复用现场交由 submit_fn 决定（复用原任务或安全重建）。
        return _submit_once(
            store,
            submit_fn,
            idempotency_key=idempotency_key,
            payload=payload,
            existing=existing,
            reused=True,
        )
    # 无记录或上次 failed：先创建幂等任务（pending），再提交供应商。
    pending_record = store.upsert_pending(
        idempotency_key=idempotency_key,
        project_id=project_id,
        stage_key=stage_key,
        provider=provider,
        payload=payload,
    )
    return _submit_once(
        store,
        submit_fn,
        idempotency_key=idempotency_key,
        payload=payload,
        existing=pending_record,
        reused=False,
    )
