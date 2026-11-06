"""任务认领租约（阶段 6）：同一 job_key 同一时刻只允许一个执行者持有租约。

用途：多 Worker（或并发重复请求）竞争同一任务时，以租约做"执行权互斥"——
抢到租约者执行任务，未抢到者等待已有 run 落终态后重放，保证副作用（尤其付费
提交）不重复。

表结构（与 migrations 目录同风格，接入时落迁移文件）::

    CREATE TABLE IF NOT EXISTS agent_run_leases (
      job_key     VARCHAR(160) NOT NULL,
      lease_owner VARCHAR(96)  NULL,
      lease_until DATETIME     NULL,
      updated_at  DATETIME     NULL,
      PRIMARY KEY (job_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

原子认领语义：MySQL 实现用单条 UPDATE 的 WHERE 竞态门
（``lease_until IS NULL OR lease_until < now``）+ 受影响行数判定；
InMemory 实现为等价的锁内谓词判定。SQL 全参数化（``%s`` 占位），
duck-typing database 需提供 ``execute(sql, params) -> int``（受影响行数）、
``fetchone``、``fetchall``（与 :mod:`app.agent.run_store` 约定一致）。
"""

from __future__ import annotations

import threading
import time
from abc import ABC, abstractmethod
from datetime import datetime, timedelta, timezone
from typing import Any, Callable


def _naive_utc_now() -> datetime:
    """返回当前 UTC 时间的 naive datetime（与 MySQL DATETIME 语义对齐）。

    :returns: 形如 ``2026-10-16 08:00:00`` 的 naive datetime。
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _shift_naive_utc(moment: datetime, seconds: float) -> datetime:
    """把 naive UTC 时刻推进指定秒数（不做任何本地时区换算）。

    :param moment: naive UTC 时刻。
    :param seconds: 推进秒数。
    :returns: 推进后的 naive UTC 时刻。
    """
    return moment + timedelta(seconds=seconds)


class LeaseStore(ABC):
    """任务认领租约抽象：job_key 维度的持有/续期/释放/超时回收。"""

    @abstractmethod
    def claim(self, job_key: str, owner: str, lease_seconds: float) -> bool:
        """原子认领：仅当该 job_key 无活跃租约（无租约或已过期）时成功。

        :param job_key: 任务键（建议包含业务范围，如 ``invoke:{idempotency_key}``）。
        :param owner: 认领者标识（Worker 名 / 线程名 / 实例 ID）。
        :param lease_seconds: 租约时长（秒）。
        :returns: 认领成功返回 True；已有活跃租约返回 False。
        """

    @abstractmethod
    def renew(self, job_key: str, owner: str, lease_seconds: float) -> bool:
        """续期：仅当前持有者且租约未过期时可续。

        :param job_key: 任务键。
        :param owner: 持有者标识。
        :param lease_seconds: 续期时长（秒，自当前时刻起算）。
        :returns: 续期成功返回 True；非持有者或租约已过期返回 False。
        """

    @abstractmethod
    def release(self, job_key: str, owner: str) -> bool:
        """释放租约：仅当前持有者可释放（清空 owner 与 until，保留行）。

        :param job_key: 任务键。
        :param owner: 持有者标识。
        :returns: 释放成功返回 True；非持有者或无租约返回 False。
        """

    @abstractmethod
    def takeover_if_expired(self, job_key: str, new_owner: str, lease_seconds: float) -> bool:
        """超时回收：仅当租约缺失或已过期时由新持有者接管。

        :param job_key: 任务键。
        :param new_owner: 接管者标识。
        :param lease_seconds: 新租约时长（秒）。
        :returns: 接管成功返回 True；租约仍活跃返回 False。
        """


class InMemoryLeaseStore(LeaseStore):
    """进程内租约存储；threading.Lock 保护谓词判定，行为与 MySQL 实现等价。

    :param clock: 可注入时钟（返回秒值）；缺省 ``time.time``，
        测试注入假时钟即可驱动租约过期，无需 sleep。
    """

    def __init__(self, *, clock: Callable[[], float] = time.time) -> None:
        """初始化租约容器与互斥锁。

        :param clock: 可注入时钟。
        """
        self._clock = clock
        self._lock = threading.Lock()
        # job_key -> {"lease_owner": str|None, "lease_until": float|None, "updated_at": float}
        self._leases: dict[str, dict[str, Any]] = {}

    def _active_exists(self, job_key: str, now: float) -> bool:
        """判定指定 job_key 是否存在活跃租约（锁内调用）。

        :param job_key: 任务键。
        :param now: 当前时钟值。
        :returns: 存在未过期租约返回 True。
        """
        record = self._leases.get(job_key)
        if record is None:
            return False
        lease_until = record.get("lease_until")
        return lease_until is not None and lease_until > now

    def claim(self, job_key: str, owner: str, lease_seconds: float) -> bool:
        """原子认领：无活跃租约时写入 owner 与到期时间。

        :param job_key: 任务键。
        :param owner: 认领者标识。
        :param lease_seconds: 租约时长（秒）。
        :returns: 认领成功返回 True；已有活跃租约返回 False。
        """
        with self._lock:
            now = self._clock()
            if self._active_exists(job_key, now):
                return False
            self._leases[job_key] = {
                "lease_owner": owner,
                "lease_until": now + lease_seconds,
                "updated_at": now,
            }
            return True

    def renew(self, job_key: str, owner: str, lease_seconds: float) -> bool:
        """续期：仅当前持有者且未过期时可续（自当前时刻起算新到期时间）。

        :param job_key: 任务键。
        :param owner: 持有者标识。
        :param lease_seconds: 续期时长（秒）。
        :returns: 续期成功返回 True；非持有者或已过期返回 False。
        """
        with self._lock:
            now = self._clock()
            record = self._leases.get(job_key)
            if record is None or record.get("lease_owner") != owner:
                return False
            lease_until = record.get("lease_until")
            if lease_until is not None and lease_until <= now:
                return False
            record["lease_until"] = now + lease_seconds
            record["updated_at"] = now
            return True

    def release(self, job_key: str, owner: str) -> bool:
        """释放租约：仅持有者可释放（清空 owner/until，保留行供审计）。

        :param job_key: 任务键。
        :param owner: 持有者标识。
        :returns: 释放成功返回 True；非持有者或无租约返回 False。
        """
        with self._lock:
            now = self._clock()
            record = self._leases.get(job_key)
            if record is None or record.get("lease_owner") != owner:
                return False
            record["lease_owner"] = None
            record["lease_until"] = None
            record["updated_at"] = now
            return True

    def takeover_if_expired(self, job_key: str, new_owner: str, lease_seconds: float) -> bool:
        """超时回收：租约缺失或已过期时由新持有者接管（谓词与 claim 一致）。

        :param job_key: 任务键。
        :param new_owner: 接管者标识。
        :param lease_seconds: 新租约时长（秒）。
        :returns: 接管成功返回 True；租约仍活跃返回 False。
        """
        with self._lock:
            now = self._clock()
            if self._active_exists(job_key, now):
                return False
            self._leases[job_key] = {
                "lease_owner": new_owner,
                "lease_until": now + lease_seconds,
                "updated_at": now,
            }
            return True


class MySQLLeaseStore(LeaseStore):
    """MySQL 持久化租约存储（单条 UPDATE 竞态门 + 受影响行数判定，SQL 全参数化）。

    :param database: duck-typing 数据库对象，需提供
        ``execute(sql, params) -> int``（返回受影响行数）、``fetchone``、``fetchall``。
    :param now_fn: 时间注入点，返回 naive UTC datetime；缺省取当前 UTC。
    """

    def __init__(self, database: Any, *, now_fn: Callable[[], datetime] = _naive_utc_now) -> None:
        """注入数据库适配对象与时间源。

        :param database: 提供 execute/fetchone/fetchall 的数据库对象。
        :param now_fn: 返回 naive UTC datetime 的时间注入点。
        """
        self._database = database
        self._now_fn = now_fn

    def ensure_row(self, job_key: str) -> bool:
        """预置 job 行（lease_owner/lease_until 为 NULL，幂等）。

        claim/takeover 的单条 UPDATE 只影响已存在的行：任务入队时应先调用
        本方法预置行，随后 Worker 方可原子认领。行已存在时返回 False。

        :param job_key: 任务键。
        :returns: 本次新建行返回 True；行已存在（幂等跳过）返回 False。
        """
        affected = self._database.execute(
            "INSERT IGNORE INTO agent_run_leases (job_key) VALUES (%s)",
            (job_key,),
        )
        return int(affected) == 1

    def claim(self, job_key: str, owner: str, lease_seconds: float) -> bool:
        """原子认领：单条 UPDATE，WHERE 中 ``lease_until IS NULL OR lease_until < now``
        充当竞态门，受影响行数 1 表示认领成功。

        :param job_key: 任务键。
        :param owner: 认领者标识。
        :param lease_seconds: 租约时长（秒）。
        :returns: 认领成功（rowcount==1）返回 True；已有活跃租约返回 False。
        """
        now = self._now_fn()
        lease_until = _shift_naive_utc(now, lease_seconds)
        affected = self._database.execute(
            """UPDATE agent_run_leases
               SET lease_owner = %s, lease_until = %s
               WHERE job_key = %s AND (lease_until IS NULL OR lease_until < %s)""",
            (owner, lease_until, job_key, now),
        )
        return int(affected) == 1

    def renew(self, job_key: str, owner: str, lease_seconds: float) -> bool:
        """续期：WHERE 同时要求持有者匹配且租约未过期，仅持有者可续。

        :param job_key: 任务键。
        :param owner: 持有者标识。
        :param lease_seconds: 续期时长（秒）。
        :returns: 续期成功（rowcount==1）返回 True；非持有者或已过期返回 False。
        """
        now = self._now_fn()
        lease_until = _shift_naive_utc(now, lease_seconds)
        affected = self._database.execute(
            """UPDATE agent_run_leases
               SET lease_until = %s, updated_at = %s
               WHERE job_key = %s AND lease_owner = %s
                 AND (lease_until IS NULL OR lease_until >= %s)""",
            (lease_until, now, job_key, owner, now),
        )
        return int(affected) == 1

    def release(self, job_key: str, owner: str) -> bool:
        """释放租约：WHERE 要求持有者匹配；释放即清空 owner/until（保留行）。

        :param job_key: 任务键。
        :param owner: 持有者标识。
        :returns: 释放成功（rowcount==1）返回 True；非持有者或无租约返回 False。
        """
        now = self._now_fn()
        affected = self._database.execute(
            """UPDATE agent_run_leases
               SET lease_owner = NULL, lease_until = NULL, updated_at = %s
               WHERE job_key = %s AND lease_owner = %s""",
            (now, job_key, owner),
        )
        return int(affected) == 1

    def takeover_if_expired(self, job_key: str, new_owner: str, lease_seconds: float) -> bool:
        """超时回收：谓词与 claim 一致（``lease_until IS NULL OR lease_until < now``）。

        :param job_key: 任务键。
        :param new_owner: 接管者标识。
        :param lease_seconds: 新租约时长（秒）。
        :returns: 接管成功（rowcount==1）返回 True；租约仍活跃返回 False。
        """
        now = self._now_fn()
        lease_until = _shift_naive_utc(now, lease_seconds)
        affected = self._database.execute(
            """UPDATE agent_run_leases
               SET lease_owner = %s, lease_until = %s
               WHERE job_key = %s AND (lease_until IS NULL OR lease_until < %s)""",
            (new_owner, lease_until, job_key, now),
        )
        return int(affected) == 1
