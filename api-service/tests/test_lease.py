"""任务认领租约单元测试（阶段 6）。

覆盖：
- InMemoryLeaseStore：双 Worker 竞争同 job 只有一个 claim 成功；租约过期后
  takeover 成功；持有者 renew/release 语义；非持有者 release 失败；
- MySQLLeaseStore：claim 生成单条 UPDATE（WHERE 竞态门）并断言 SQL 与参数；
  rowcount 语义驱动 True/False；renew/release/takeover 的 WHERE 条件与行为。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from app.agent.lease import InMemoryLeaseStore, MySQLLeaseStore

# 固定注入时间源（MySQL store 断言参数用）。
_FIXED_NOW = datetime(2026, 10, 16, 8, 0, 0)


class FakeClock:
    """可手动推进的可注入时钟（InMemory store 驱动过期用）。

    :param start: 初始时刻（秒）。
    """

    def __init__(self, start: float = 1000.0) -> None:
        """初始化当前时刻。

        :param start: 初始时刻（秒）。
        """
        self.now = start

    def __call__(self) -> float:
        """返回当前时刻。

        :returns: 当前时钟值（秒）。
        """
        return self.now

    def advance(self, seconds: float) -> None:
        """推进时钟。

        :param seconds: 推进秒数。
        :returns: 无返回值。
        """
        self.now += seconds


class FakeLeaseDatabase:
    """模拟 agent_run_leases 表的假 database：按 SQL 形状执行谓词并返回行数。

    与 test_paid_submission.py 的 FakePaidSubmissionDatabase 同风格：
    记录全部语句（kind, sql, params），并按语句类型对内存行施加
    WHERE 谓词判定，用受影响行数模拟 MySQL 语义。
    """

    def __init__(self) -> None:
        """初始化语句记录与空表。"""
        self.statements: list[tuple[str, str, tuple]] = []
        # job_key -> {"job_key","lease_owner","lease_until","updated_at"}
        self.rows: dict[str, dict[str, Any]] = {}

    @staticmethod
    def _normalize(sql: str) -> str:
        """归一化 SQL 文本（折叠空白、转大写）。

        :param sql: 原始 SQL。
        :returns: 归一化后的 SQL。
        """
        return " ".join(sql.split()).upper()

    def execute(self, sql: str, params: tuple = ()) -> int:
        """记录写语句并按谓词模拟 UPDATE / INSERT IGNORE 行为。

        :param sql: 参数化 SQL。
        :param params: SQL 参数。
        :returns: 受影响行数（1 或 0，模拟 MySQL rowcount）。
        """
        self.statements.append(("execute", sql, params))
        normalized = self._normalize(sql)
        if "INSERT IGNORE INTO AGENT_RUN_LEASES" in normalized:
            (job_key,) = params
            if job_key not in self.rows:
                self.rows[job_key] = {
                    "job_key": job_key,
                    "lease_owner": None,
                    "lease_until": None,
                    "updated_at": None,
                }
                return 1
            return 0
        if "LEASE_OWNER = NULL" in normalized:
            # release：WHERE job_key 匹配且 lease_owner 匹配。
            now, job_key, owner = params
            row = self.rows.get(job_key)
            if row is not None and row["lease_owner"] == owner:
                row["lease_owner"] = None
                row["lease_until"] = None
                row["updated_at"] = now
                return 1
            return 0
        if "LEASE_OWNER = %S AND" in normalized and "LEASE_UNTIL >= %S" in normalized:
            # renew：WHERE 持有者匹配且未过期。
            lease_until, now, job_key, owner, _now_again = params
            row = self.rows.get(job_key)
            if (
                row is not None
                and row["lease_owner"] == owner
                and (row["lease_until"] is None or row["lease_until"] >= now)
            ):
                row["lease_until"] = lease_until
                row["updated_at"] = now
                return 1
            return 0
        if "LEASE_UNTIL IS NULL OR LEASE_UNTIL < %S" in normalized:
            # claim / takeover：WHERE 无活跃租约（缺失行返回 0 行——行需预置）。
            owner, lease_until, job_key, now = params
            row = self.rows.get(job_key)
            if row is not None and (row["lease_until"] is None or row["lease_until"] < now):
                row["lease_owner"] = owner
                row["lease_until"] = lease_until
                return 1
            return 0
        raise AssertionError(f"未知 SQL 形状: {sql}")

    def fetchone(self, sql: str, params: tuple = ()) -> dict[str, Any] | None:
        """记录读语句并按主键返回行副本。

        :param sql: 参数化 SQL。
        :param params: SQL 参数。
        :returns: 命中行副本或 None。
        """
        self.statements.append(("fetchone", sql, params))
        return None

    def fetchall(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        """记录读语句并返回全部行副本。

        :param sql: 参数化 SQL。
        :param params: SQL 参数。
        :returns: 全部行副本列表。
        """
        self.statements.append(("fetchall", sql, params))
        return [dict(row) for row in self.rows.values()]


# ---------------------------------------------------------------------------
# InMemoryLeaseStore
# ---------------------------------------------------------------------------


def test_inmemory_double_claim_only_one_worker_wins() -> None:
    """双 Worker 竞争同一 job：只有一个 claim 成功，另一个被拒。

    :returns: 无返回值。
    :raises AssertionError: 两个 Worker 同时认领成功时抛出。
    """
    store = InMemoryLeaseStore(clock=FakeClock())
    assert store.claim("invoke:key-1", "worker-a", 30.0) is True
    assert store.claim("invoke:key-1", "worker-b", 30.0) is False


def test_inmemory_takeover_after_lease_expired() -> None:
    """租约过期后新 Worker takeover 成功，原持有者 renew 失效。

    :returns: 无返回值。
    :raises AssertionError: 过期租约未被回收时抛出。
    """
    clock = FakeClock()
    store = InMemoryLeaseStore(clock=clock)
    assert store.claim("invoke:key-2", "worker-a", 30.0) is True
    assert store.renew("invoke:key-2", "worker-a", 30.0) is True
    clock.advance(31.0)  # 租约过期
    assert store.renew("invoke:key-2", "worker-a", 30.0) is False  # 过期不可续
    assert store.takeover_if_expired("invoke:key-2", "worker-b", 30.0) is True
    assert store.claim("invoke:key-2", "worker-c", 30.0) is False  # 新租约活跃


def test_inmemory_renew_only_holder_and_only_active() -> None:
    """renew 语义：仅持有者可续、仅活跃租约可续；续期自当前时刻起算。

    :returns: 无返回值。
    :raises AssertionError: 非持有者续期成功或过期续期成功时抛出。
    """
    clock = FakeClock()
    store = InMemoryLeaseStore(clock=clock)
    assert store.claim("invoke:key-3", "worker-a", 30.0) is True  # 租约至 1030
    assert store.renew("invoke:key-3", "worker-b", 30.0) is False  # 非持有者
    clock.advance(10.0)  # now=1010
    assert store.renew("invoke:key-3", "worker-a", 30.0) is True  # 持有者续期至 1040
    clock.advance(20.0)  # now=1030：已过原始租约期，但续期后仍活跃
    assert store.takeover_if_expired("invoke:key-3", "worker-b", 30.0) is False
    assert store.renew("invoke:key-3", "worker-a", 30.0) is True
    clock.advance(200.0)  # 已过期
    assert store.renew("invoke:key-3", "worker-a", 30.0) is False
    assert store.takeover_if_expired("invoke:key-3", "worker-b", 30.0) is True


def test_inmemory_release_only_holder_and_reclaimable() -> None:
    """release 语义：非持有者释放失败；持有者释放后同 job 可被重新认领。

    :returns: 无返回值。
    :raises AssertionError: 非持有者释放成功或释放后无法认领时抛出。
    """
    clock = FakeClock()
    store = InMemoryLeaseStore(clock=clock)
    assert store.claim("invoke:key-4", "worker-a", 30.0) is True
    assert store.release("invoke:key-4", "worker-b") is False  # 非持有者
    assert store.claim("invoke:key-4", "worker-b", 30.0) is False  # 仍被持有
    assert store.release("invoke:key-4", "worker-a") is True  # 持有者释放
    assert store.claim("invoke:key-4", "worker-b", 30.0) is True  # 可重新认领


# ---------------------------------------------------------------------------
# MySQLLeaseStore（假 database：断言 SQL 形状与参数 + rowcount 行为）
# ---------------------------------------------------------------------------


def test_mysql_claim_single_update_with_race_gate_and_params() -> None:
    """claim 生成单条 UPDATE：WHERE 竞态门参数化，参数为 (owner, until, job_key, now)。

    :returns: 无返回值。
    :raises AssertionError: SQL 形状或参数不符时抛出。
    """
    database = FakeLeaseDatabase()
    database.execute(
        "INSERT IGNORE INTO agent_run_leases (job_key) VALUES (%s)", ("invoke:key-5",)
    )
    store = MySQLLeaseStore(database, now_fn=lambda: _FIXED_NOW)
    assert store.claim("invoke:key-5", "worker-a", 30.0) is True

    kind, sql, params = database.statements[1]
    assert kind == "execute"
    assert "UPDATE agent_run_leases" in sql
    assert "SET lease_owner = %s, lease_until = %s" in sql
    assert "WHERE job_key = %s AND (lease_until IS NULL OR lease_until < %s)" in sql
    assert params == (
        "worker-a",
        datetime(2026, 10, 16, 8, 0, 30),
        "invoke:key-5",
        _FIXED_NOW,
    )
    assert "worker-a" not in sql  # 业务值不出现在 SQL 文本里
    assert database.rows["invoke:key-5"]["lease_owner"] == "worker-a"


def test_mysql_claim_fails_when_lease_active() -> None:
    """活跃租约未过期：claim 的 UPDATE 命中 0 行 → 返回 False。

    :returns: 无返回值。
    :raises AssertionError: 活跃租约被二次认领时抛出。
    """
    database = FakeLeaseDatabase()
    database.execute(
        "INSERT IGNORE INTO agent_run_leases (job_key) VALUES (%s)", ("invoke:key-6",)
    )
    store = MySQLLeaseStore(database, now_fn=lambda: _FIXED_NOW)
    assert store.claim("invoke:key-6", "worker-a", 30.0) is True
    assert store.claim("invoke:key-6", "worker-b", 30.0) is False
    assert database.rows["invoke:key-6"]["lease_owner"] == "worker-a"


def test_mysql_renew_release_and_takeover_semantics() -> None:
    """renew/release/takeover 的 WHERE 条件与行数语义（持有者限定 + 过期回收）。

    :returns: 无返回值。
    :raises AssertionError: 任一语义不符时抛出。
    """
    database = FakeLeaseDatabase()
    database.execute(
        "INSERT IGNORE INTO agent_run_leases (job_key) VALUES (%s)", ("invoke:key-7",)
    )
    store = MySQLLeaseStore(database, now_fn=lambda: _FIXED_NOW)
    assert store.claim("invoke:key-7", "worker-a", 30.0) is True

    # 非持有者 renew / release 均为 0 行。
    assert store.renew("invoke:key-7", "worker-b", 30.0) is False
    assert store.release("invoke:key-7", "worker-b") is False
    # 持有者 renew：1 行，lease_until 前移。
    assert store.renew("invoke:key-7", "worker-a", 30.0) is True
    assert database.rows["invoke:key-7"]["lease_until"] == datetime(2026, 10, 16, 8, 0, 30)
    # 持有者 release：1 行，owner/until 清空。
    assert store.release("invoke:key-7", "worker-a") is True
    assert database.rows["invoke:key-7"]["lease_owner"] is None
    assert database.rows["invoke:key-7"]["lease_until"] is None
    # 释放后重新认领成功；活跃租约下 takeover 失败。
    assert store.claim("invoke:key-7", "worker-b", 30.0) is True
    assert store.takeover_if_expired("invoke:key-7", "worker-c", 30.0) is False


def test_mysql_takeover_after_expiry_succeeds() -> None:
    """过期租约（lease_until < now）可被 takeover 接管。

    :returns: 无返回值。
    :raises AssertionError: 过期租约未被接管时抛出。
    """
    database = FakeLeaseDatabase()
    database.execute(
        "INSERT IGNORE INTO agent_run_leases (job_key) VALUES (%s)", ("invoke:key-8",)
    )
    # 预置一个已过期租约（lease_until 早于 now）。
    store = MySQLLeaseStore(database, now_fn=lambda: _FIXED_NOW)
    assert store.takeover_if_expired("invoke:key-8", "worker-b", 30.0) is True
    assert database.rows["invoke:key-8"]["lease_owner"] == "worker-b"


def test_mysql_ensure_row_bootstraps_lease_row() -> None:
    """ensure_row 预置 job 行（lease_until=NULL）；重复预置为 0 行幂等。

    :returns: 无返回值。
    :raises AssertionError: 预置后行缺失或重复预置非幂等时抛出。
    """
    database = FakeLeaseDatabase()
    store = MySQLLeaseStore(database, now_fn=lambda: _FIXED_NOW)
    assert store.ensure_row("invoke:key-9") is True
    assert store.ensure_row("invoke:key-9") is False
    row = database.rows["invoke:key-9"]
    assert row["lease_owner"] is None and row["lease_until"] is None
    # 预置后 claim 可直接原子认领。
    assert store.claim("invoke:key-9", "worker-a", 30.0) is True
