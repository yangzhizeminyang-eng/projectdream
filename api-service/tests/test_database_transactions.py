import json

from app.database import MySQLDatabase


class RecordingCursor:
    def __init__(self, rows):
        self.rows = rows
        self.statements = []
        self.current_rows = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, sql, params=()):
        self.statements.append((sql, params))
        if sql.lstrip().startswith("SELECT"):
            self.current_rows = self.rows

    def fetchall(self):
        return self.current_rows

    def fetchone(self):
        return self.current_rows[0] if self.current_rows else None


class RecordingConnection:
    def __init__(self, rows):
        self.query = RecordingCursor(rows)
        self.committed = False
        self.rolled_back = False
        self.closed = False

    def cursor(self):
        return self.query

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True

    def close(self):
        self.closed = True


def test_reorder_storyboards_locks_scope_updates_then_commits():
    connection = RecordingConnection([{"id": 11, "scene_id": 5}, {"id": 12, "scene_id": 5}])
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.reorder_storyboards(
        [{"id": 11, "sortOrder": 0}, {"id": 12, "sortOrder": 1}], user_id=7
    )

    assert result == {"outcome": "updated"}
    select_sql, select_params = connection.query.statements[0]
    assert "p.user_id = %s" in select_sql
    assert "ORDER BY sb.id FOR UPDATE" in select_sql
    assert select_params == (11, 12, 7)
    assert connection.query.statements[1:] == [
        ("UPDATE storyboards SET sort_order = %s, updated_at = NOW() WHERE id = %s", (0, 11)),
        ("UPDATE storyboards SET sort_order = %s, updated_at = NOW() WHERE id = %s", (1, 12)),
    ]
    assert connection.committed
    assert not connection.rolled_back
    assert connection.closed


def test_reorder_storyboards_rolls_back_missing_or_foreign_rows_before_updates():
    connection = RecordingConnection([{"id": 11, "scene_id": 5}])
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.reorder_storyboards(
        [{"id": 11, "sortOrder": 0}, {"id": 12, "sortOrder": 1}], user_id=7
    )

    assert result == {"outcome": "not_found"}
    assert len(connection.query.statements) == 1
    assert connection.rolled_back
    assert not connection.committed
    assert connection.closed


def test_mock_task_action_locks_owned_asset_and_upserts_runtime_state_atomically():
    class TaskActionCursor(RecordingCursor):
        def execute(self, sql, params=()):
            self.statements.append((sql, params))
            if "FROM image_assets" in sql:
                self.current_rows = [{"project_id": 8, "status": "candidate", "file_url": None}]
            elif "FROM task_runtime_states" in sql:
                self.current_rows = []

    connection = RecordingConnection([])
    connection.query = TaskActionCursor([])
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.apply_mock_task_action("image", 4, 7, "retry")

    assert result == {"outcome": "updated", "project_id": 8, "runtime_status": "queued"}
    source_sql, source_params = connection.query.statements[0]
    assert "p.user_id = %s FOR UPDATE" in source_sql
    assert source_params == (4, 7)
    assert "FOR UPDATE" in connection.query.statements[1][0]
    upsert_sql, upsert_params = connection.query.statements[2]
    assert "INSERT INTO task_runtime_states" in upsert_sql
    assert "ON DUPLICATE KEY UPDATE" in upsert_sql
    assert upsert_params == ("image-4", 8, "image", 4, "queued", 0)
    assert connection.committed and not connection.rolled_back and connection.closed


def test_mock_task_cancel_rolls_back_when_runtime_state_is_not_active():
    class TaskActionCursor(RecordingCursor):
        def execute(self, sql, params=()):
            self.statements.append((sql, params))
            self.current_rows = ([{"project_id": 8, "status": "candidate", "file_url": "image.png"}]
                                 if "FROM image_assets" in sql else
                                 [{"runtime_status": "success", "progress_percent": 100, "updated_at": None}])

    connection = RecordingConnection([])
    connection.query = TaskActionCursor([])
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.apply_mock_task_action("image", 4, 7, "cancel")

    assert result == {"outcome": "not_cancelable"}
    assert len(connection.query.statements) == 2
    assert connection.rolled_back and not connection.committed and connection.closed

def test_create_export_record_commits_a_queued_row_for_the_worker():
    class ExportCursor(RecordingCursor):
        lastrowid = 42

        def execute(self, sql, params=()):
            self.statements.append((sql, params))
            self.current_rows = ([{
                "id": 42, "project_id": 8, "status": "queued",
                "video_url": "pending://hybrid-export", "config_json": "{}",
            }] if sql.lstrip().startswith("SELECT") else [])

    connection = RecordingConnection([])
    connection.query = ExportCursor([])
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    row = database.create_export_record(8, {
        "video_url": "pending://hybrid-export", "cover_url": None,
        "config_json": "{}", "source_count": 3, "ready_count": 2, "missing_count": 1,
    })

    assert row["id"] == 42
    insert_sql, insert_params = connection.query.statements[0]
    assert "INSERT INTO export_records" in insert_sql
    assert "'queued'" in insert_sql
    assert insert_params == (8, "pending://hybrid-export", None, "{}", 3, 2, 1)
    assert connection.query.statements[1] == (
        "SELECT * FROM export_records WHERE id = %s LIMIT 1", (42,),
    )
    assert connection.committed and not connection.rolled_back and connection.closed


def test_generate_project_scenes_locks_owner_and_commits_scene_rows_atomically():
    class SceneCursor(RecordingCursor):
        def __init__(self):
            super().__init__([])
            self.current_rows = []
            self.insert_count = 0

        def execute(self, sql, params=()):
            self.statements.append((sql, params))
            if "FROM projects" in sql:
                self.current_rows = [{"id": 8}]
            elif "SELECT id FROM script_scenes" in sql:
                self.current_rows = []
            elif "SELECT * FROM script_scenes" in sql:
                self.current_rows = [{"id": 101, "project_id": 8, "scene_no": 1}]
            elif "INSERT INTO script_scenes" in sql:
                self.insert_count += 1

    connection = RecordingConnection([])
    connection.query = SceneCursor()
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    rows = database.generate_project_scenes(8, 7, None, [{
        "episode_no": 1, "scene_no": 1, "title": "开场", "summary": "警报响起",
        "location": None, "time_of_day": None, "estimated_duration": 120,
    }])

    assert rows == [{"id": 101, "project_id": 8, "scene_no": 1}]
    assert "FOR UPDATE" in connection.query.statements[0][0]
    assert connection.query.insert_count == 1
    assert any("UPDATE projects SET status = 'scripting'" in sql for sql, _ in connection.query.statements)
    assert connection.committed and not connection.rolled_back and connection.closed


def test_generate_project_scenes_rolls_back_if_scenes_already_exist():
    class ExistingSceneCursor(RecordingCursor):
        def __init__(self):
            super().__init__([])
            self.current_rows = []

        def execute(self, sql, params=()):
            self.statements.append((sql, params))
            self.current_rows = ([{"id": 8}] if "FROM projects" in sql else
                                 [{"id": 99}] if "SELECT id FROM script_scenes" in sql else [])

    connection = RecordingConnection([])
    connection.query = ExistingSceneCursor()
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    rows = database.generate_project_scenes(8, 7, None, [{
        "episode_no": 1, "scene_no": 1, "title": "不可写入", "summary": "",
        "location": None, "time_of_day": None, "estimated_duration": 120,
    }])

    assert rows is None
    assert len(connection.query.statements) == 2
    assert connection.rolled_back and not connection.committed and connection.closed
def test_save_generated_outline_locks_project_versions_deletes_legacy_scenes_and_commits():
    class OutlineWriteCursor(RecordingCursor):
        lastrowid = 45

        def __init__(self):
            super().__init__([])
            self.current_rows = []

        def execute(self, sql, params=()):
            self.statements.append((sql, params))
            if "FROM projects" in sql:
                self.current_rows = [{"id": 8, "visual_style": "既有视觉"}]
            elif "FROM story_outlines" in sql and "MAX" in sql:
                self.current_rows = [{"max_version": 2}]
            elif "SELECT * FROM story_outlines" in sql:
                self.current_rows = [{"id": 45, "version_no": 3}]
            else:
                self.current_rows = []

    connection = RecordingConnection([])
    connection.query = OutlineWriteCursor()
    database = MySQLDatabase(None)
    database._connection = lambda: connection
    outline = {
        "title": "新总纲", "logline": "一句话", "premise": "前提", "visual_style": "冷色",
        "acts": [{"summary": "幕一"}, {"summary": "幕二"}, {"summary": "幕三"}],
        "scenes": [{"scene_no": 1, "title": "开场"}],
    }

    row = database.save_generated_outline(8, 7, outline)

    assert row == {"id": 45, "version_no": 3}
    statements = connection.query.statements
    assert "FOR UPDATE" in statements[0][0]
    assert "INNER JOIN season_structures" in statements[1][0]
    assert "DELETE FROM script_scenes WHERE project_id = %s" in statements[3][0]
    insert_sql, insert_params = statements[4]
    assert "INSERT INTO story_outlines" in insert_sql
    assert insert_params[:9] == (8, 3, "新总纲", "一句话", "前提", "幕一", "幕二", "幕三", "冷色")
    assert json.loads(insert_params[9]) == {"acts": outline["acts"], "scenes": outline["scenes"]}
    assert any("status = 'outlined'" in sql for sql, _ in statements)
    assert connection.committed and not connection.rolled_back and connection.closed


def test_save_generated_outline_refuses_modern_script_and_rolls_back_before_delete():
    class ModernScriptCursor(RecordingCursor):
        def __init__(self):
            super().__init__([])
            self.current_rows = []

        def execute(self, sql, params=()):
            self.statements.append((sql, params))
            self.current_rows = ([{"id": 8, "visual_style": "既有视觉"}] if "FROM projects" in sql else
                                 [{"id": 99}] if "INNER JOIN season_structures" in sql else [])

    connection = RecordingConnection([])
    connection.query = ModernScriptCursor()
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    row = database.save_generated_outline(8, 7, {"acts": [], "scenes": []})

    assert row is None
    assert len(connection.query.statements) == 2
    assert connection.rolled_back and not connection.committed and connection.closed


class OutlineCursor(RecordingCursor):
    def __init__(self):
        super().__init__([])
        self.current_row = None

    def execute(self, sql, params=()):
        self.statements.append((sql, params))
        self.current_row = {"owner_project_id": 8, "id": 42, "version_no": 3}

    def fetchone(self):
        return self.current_row

    def fetchall(self):
        return [self.current_row] if self.current_row else []


class OutlineConnection(RecordingConnection):
    def __init__(self):
        super().__init__([])
        self.query = OutlineCursor()


def test_latest_outline_checks_owner_and_selects_highest_version_then_id():
    connection = OutlineConnection()
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.latest_outline(project_id=8, user_id=7)

    assert result == {"outcome": "found", "outline": {"id": 42, "version_no": 3}}
    assert len(connection.query.statements) == 1
    sql, params = connection.query.statements[0]
    assert "LEFT JOIN story_outlines o" in sql
    assert "p.user_id = %s" in sql
    assert "ORDER BY latest.version_no DESC, latest.id DESC LIMIT 1" in sql
    assert params == (8, 7)
    assert connection.closed


def test_latest_story_bible_uses_owner_scope_and_latest_version_order():
    connection = OutlineConnection()
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.latest_story_bible(project_id=8, user_id=7)

    assert result == {"outcome": "found", "item": {"id": 42, "version_no": 3}}
    assert len(connection.query.statements) == 1
    sql, params = connection.query.statements[0]
    assert "LEFT JOIN story_bibles o" in sql
    assert "user_id = %s" in sql
    assert "ORDER BY latest.version_no DESC, latest.id DESC LIMIT 1" in sql
    assert params == (8, 7)
    assert connection.closed


def test_latest_season_structure_uses_owner_scope_and_latest_version_order():
    connection = OutlineConnection()
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.latest_season_structure(project_id=8, user_id=7)

    assert result == {"outcome": "found", "item": {"id": 42, "version_no": 3}}
    assert len(connection.query.statements) == 1
    sql, params = connection.query.statements[0]
    assert "LEFT JOIN season_structures o" in sql
    assert "user_id = %s" in sql
    assert "ORDER BY latest.version_no DESC, latest.id DESC LIMIT 1" in sql
    assert params == (8, 7)
    assert connection.closed


def test_latest_content_reads_use_single_owner_scoped_left_join_query():
    from app.database import MySQLDatabase

    for method_name, table, result_key in (
        ("latest_outline", "story_outlines", "outline"),
        ("latest_story_bible", "story_bibles", "item"),
        ("latest_season_structure", "season_structures", "item"),
    ):
        connection = OutlineConnection()
        database = MySQLDatabase(None)
        database._connection = lambda connection=connection: connection

        result = getattr(database, method_name)(project_id=8, user_id=7)

        assert result["outcome"] == "found"
        assert result[result_key] == {"id": 42, "version_no": 3}
        assert len(connection.query.statements) == 1
        sql, params = connection.query.statements[0]
        assert "LEFT JOIN" in sql
        assert f"{table} o" in sql
        assert "p.user_id = %s" in sql
        assert "ORDER BY latest.version_no DESC, latest.id DESC LIMIT 1" in sql
        assert params == (8, 7)
        assert connection.closed


class AgentPipelineCursor(RecordingCursor):
    def __init__(self, result_sets):
        super().__init__([])
        self.result_sets = iter(result_sets)
        self.current_row = None

    def execute(self, sql, params=()):
        self.statements.append((sql, params))
        self.current_rows = next(self.result_sets)
        self.current_row = self.current_rows[0] if self.current_rows else None

    def fetchone(self):
        return self.current_row


class AgentPipelineConnection(RecordingConnection):
    def __init__(self, result_sets):
        super().__init__([])
        self.query = AgentPipelineCursor(result_sets)


def test_agent_pipeline_list_batches_children_and_scopes_every_query_to_owner():
    run = {"id": 10, "project_id": 8, "user_id": 7, "episode_no": 1}
    execution = {"id": 20, "pipeline_run_id": 10, "stage_key": "asset-parse"}
    event = {"id": 30, "pipeline_run_id": 10, "stage_key": "asset-parse"}
    connection = AgentPipelineConnection([[run], [execution], [event]])
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.list_agent_pipeline_views(project_id=8, user_id=7)

    assert result == [{"run": run, "executions": [execution], "events": [event]}]
    assert len(connection.query.statements) == 3
    run_sql, run_params = connection.query.statements[0]
    assert "p.user_id = %s" in run_sql
    assert run_params == (8, 7, 7)
    for sql, params in connection.query.statements[1:]:
        assert "apr.project_id = %s AND apr.user_id = %s" in sql
        assert params == (10, 8, 7)
    assert connection.closed


def test_agent_pipeline_list_returns_empty_only_for_owned_project_without_runs():
    connection = AgentPipelineConnection([[], [{"id": 8}]])
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.list_agent_pipeline_views(project_id=8, user_id=7)

    assert result == []
    assert len(connection.query.statements) == 2
    assert connection.query.statements[1] == (
        "SELECT id FROM projects WHERE id = %s AND user_id = %s LIMIT 1",
        (8, 7),
    )
    assert connection.closed


def test_agent_pipeline_detail_scopes_run_and_children_to_requesting_user():
    run = {"id": 10, "project_id": 8, "user_id": 7}
    execution = {"id": 20, "pipeline_run_id": 10}
    event = {"id": 30, "pipeline_run_id": 10}
    connection = AgentPipelineConnection([[run], [execution], [event]])
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.get_agent_pipeline_view(run_id=10, user_id=7)

    assert result == {"run": run, "executions": [execution], "events": [event]}
    assert len(connection.query.statements) == 3
    run_sql, run_params = connection.query.statements[0]
    assert "p.user_id = %s" in run_sql
    assert run_params == (10, 7, 7)
    for sql, params in connection.query.statements[1:]:
        assert "apr.user_id = %s" in sql
        assert params == (10, 7)
    assert connection.closed


def test_production_run_view_owner_scopes_run_and_all_children():
    from app.database import MySQLDatabase

    run = {"id": 21, "project_id": 8, "user_id": 7, "episode_no": 3}
    stage = {"id": 31, "production_run_id": 21, "stage_key": "candidate-generation"}
    checkpoint = {"id": 41, "production_run_id": 21, "checkpoint_key": "blueprint"}
    execution = {"id": 51, "production_run_id": 21, "agent_key": "story-agent"}
    blueprint = {"id": 61, "production_run_id": 21, "project_id": 8, "version_no": 2}
    beat = {"id": 71, "blueprint_id": 61, "beat_key": "opening", "sequence_no": 1}
    connection = AgentPipelineConnection([[run], [stage], [checkpoint], [execution], [blueprint], [beat]])
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.get_production_run_view(run_id=21, user_id=7)

    assert result == {
        "run": run, "stages": [stage], "checkpoints": [checkpoint],
        "agentExecutions": [execution], "blueprint": {"row": blueprint, "emotionBeats": [beat]},
    }
    assert len(connection.query.statements) == 6
    run_sql, run_params = connection.query.statements[0]
    assert "INNER JOIN projects p ON p.id = pr.project_id" in run_sql
    assert "p.user_id = %s" in run_sql
    assert run_params == (21, 7)
    expected_children = (
        ("production_stage_runs", (21,)),
        ("production_checkpoints", (21,)),
        ("production_agent_executions", (21,)),
        ("episode_blueprints", (21,)),
        ("production_emotion_beats", (61,)),
    )
    for (sql, params), (table, expected_params) in zip(connection.query.statements[1:], expected_children):
        assert table in sql
        assert params == expected_params
        assert "production_run_id = %s" in sql or table == "production_emotion_beats"
    assert "ORDER BY sequence_no ASC, id ASC" in connection.query.statements[1][0]
    assert "ORDER BY id ASC" in connection.query.statements[2][0]
    assert "ORDER BY id ASC" in connection.query.statements[3][0]
    assert "ORDER BY version_no DESC, id DESC LIMIT 1" in connection.query.statements[4][0]
    assert connection.closed


def test_production_run_view_stops_after_owner_scoped_run_miss():
    from app.database import MySQLDatabase

    connection = AgentPipelineConnection([[]])
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.get_production_run_view(run_id=21, user_id=7)

    assert result is None
    assert len(connection.query.statements) == 1
    assert connection.closed


class AgentPipelineStageActionCursor(AgentPipelineCursor):
    def __init__(self, run, existing=None):
        super().__init__([])
        self.run = run
        self.existing = existing
        self.lastrowid = 90

    def execute(self, sql, params=()):
        self.statements.append((sql, params))
        self.current_row = self.run if "SELECT apr.*" in sql else self.existing if "SELECT * FROM agent_pipeline_executions" in sql else None
        self.current_rows = [self.current_row] if self.current_row else []


class AgentPipelineStageActionConnection(RecordingConnection):
    def __init__(self, run, existing=None):
        super().__init__([])
        self.query = AgentPipelineStageActionCursor(run, existing)


def test_agent_pipeline_stage_action_is_owner_scoped_idempotent_and_atomic():
    from app.database import MySQLDatabase

    run = {"id": 10, "project_id": 8, "user_id": 7, "episode_no": 2,
           "status": "paused", "output_snapshot_json": '{"scene-lock":{"ok":true}}'}
    connection = AgentPipelineStageActionConnection(run)
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.register_agent_pipeline_stage_action(
        run_id=10, user_id=7,
        action={"stageKey": "character-lock", "agentKey": "character-agent",
                "idempotencyKey": "character-lock:manual:1", "status": "waiting_approval",
                "inputSnapshot": {"source": "editor"}, "outputSnapshot": {"characters": []},
                "blockers": [], "errorText": ""},
    )

    assert result == {"outcome": "saved"}
    statements = connection.query.statements
    assert "p.user_id = %s" in statements[0][0] and statements[0][1] == (10, 7, 7)
    assert "FOR UPDATE" in statements[0][0]
    assert "idempotency_key = %s" in statements[1][0]
    assert statements[1][1] == ("character-lock:manual:1",)
    assert "INSERT INTO agent_pipeline_executions" in statements[2][0]
    assert "INSERT INTO agent_pipeline_events" in statements[3][0]
    assert statements[3][1][4] == "queued"
    assert "UPDATE agent_pipeline_executions" in statements[4][0]
    assert "INSERT INTO agent_pipeline_events" in statements[5][0]
    assert statements[5][1][4] == "running"
    assert "UPDATE agent_pipeline_executions" in statements[6][0]
    assert "INSERT INTO agent_pipeline_events" in statements[7][0]
    assert statements[7][1][4] == "waiting_approval"
    assert "UPDATE agent_pipeline_runs" in statements[8][0]
    assert '"scene-lock": {"ok": true}' in statements[8][1][2]
    assert '"character-lock": {"characters": []}' in statements[8][1][2]
    assert connection.committed and not connection.rolled_back and connection.closed


def test_agent_pipeline_stage_action_existing_idempotency_key_does_not_write():
    from app.database import MySQLDatabase

    run = {"id": 10, "project_id": 8, "user_id": 7, "status": "paused"}
    existing = {"id": 20, "pipeline_run_id": 10, "status": "completed"}
    connection = AgentPipelineStageActionConnection(run, existing)
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.register_agent_pipeline_stage_action(
        run_id=10, user_id=7, action={"idempotencyKey": "already-used"}
    )

    assert result == {"outcome": "existing"}
    assert len(connection.query.statements) == 2
    assert connection.rolled_back and not connection.committed and connection.closed


def test_production_run_list_is_owner_scoped_and_sorted_by_latest_update():
    rows = [{"id": 10, "project_id": 8, "user_id": 7, "project_name": "Project"}]
    connection = RecordingConnection(rows)
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.list_production_run_rows(project_id=8, user_id=7)

    assert result == rows
    sql, params = connection.query.statements[0]
    assert "pr.project_id = %s AND pr.user_id = %s AND p.user_id = %s" in sql
    assert "ORDER BY pr.updated_at DESC, pr.id DESC" in sql
    assert params == (8, 7, 7)
    assert connection.closed


def test_agent_pipeline_enqueue_is_owner_scoped_idempotent_and_never_executes_inline():
    class PipelineQueueCursor(RecordingCursor):
        def __init__(self):
            super().__init__([])
            self.lastrowid = 55

        def execute(self, sql, params=()):
            self.statements.append((sql, params))
            if "FROM projects p" in sql:
                self.current_rows = [{"id": 8}]
            elif "FROM agent_pipeline_runs" in sql:
                self.current_rows = []
            elif "FROM script_scenes" in sql:
                self.current_rows = [{"id": 31, "content": "角色在雨夜发现未上锁的门。"}]
            else:
                self.current_rows = []

    class PipelineQueueConnection(RecordingConnection):
        def __init__(self):
            super().__init__([])
            self.query = PipelineQueueCursor()

    connection = PipelineQueueConnection()
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.enqueue_agent_pipeline_run(
        project_id=8, user_id=7, episode_no=1,
        idempotency_key="pipeline-demo-1", regenerate=False,
    )

    assert result == {"outcome": "queued", "run_id": 55}
    statements = connection.query.statements
    assert "p.user_id = %s" in statements[0][0] and "FOR UPDATE" in statements[0][0]
    assert "idempotency_key = %s" in statements[1][0]
    assert "episode_no = %s" in statements[2][0] and "ORDER BY sort_order ASC, id ASC" in statements[2][0]
    assert "INSERT INTO agent_pipeline_runs" in statements[3][0]
    assert "'queued', 'asset-parse'" in statements[3][0]
    assert '"sourceSceneIds": [31]' in statements[3][1][3]
    assert connection.committed and not connection.rolled_back and connection.closed


def test_production_transition_rejects_stale_stage_after_locking_run():
    connection = RecordingConnection([{"id": 21, "current_stage": "candidate-generation",
                                      "current_checkpoint": None}])
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.apply_production_transition(
        21, 7,
        {
            "expectedCurrentStage": "emotion-design",
            "expectedCurrentCheckpoint": None,
            "runUpdate": {"status": "running", "currentStage": "candidate-generation",
                          "currentCheckpoint": None},
            "stageUpdates": [{"stageKey": "emotion-design", "status": "completed"}],
            "checkpointUpdates": [],
        },
    )

    assert result is False
    assert len(connection.query.statements) == 1
    assert "FOR UPDATE" in connection.query.statements[0][0]
    assert connection.rolled_back
    assert not connection.committed
    assert connection.closed


def test_pipeline_approval_locks_owner_run_and_queues_next_stage_atomically():
    class PipelineDecisionCursor(RecordingCursor):
        def __init__(self):
            super().__init__([])
            self.current_row = None

        def execute(self, sql, params=()):
            self.statements.append((sql, params))
            if "FROM agent_pipeline_runs apr" in sql:
                self.current_row = {
                    "id": 91, "project_id": 8, "user_id": 7, "status": "waiting_approval",
                    "current_stage": "asset-parse", "output_snapshot_json": "{}",
                }
            elif "FROM agent_pipeline_executions" in sql:
                self.current_row = {
                    "id": 3, "agent_key": "asset-parser-agent", "attempt": 1,
                    "output_snapshot_json": '{"characters": []}',
                }
            else:
                self.current_row = None

        def fetchone(self):
            return self.current_row

    connection = RecordingConnection([])
    connection.query = PipelineDecisionCursor()
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.apply_agent_pipeline_decision(91, 7, "asset-parse", "approve")

    statements = connection.query.statements
    assert result == {"outcome": "queued"}
    assert "p.user_id = %s" in statements[0][0] and "FOR UPDATE" in statements[0][0]
    assert statements[0][1] == (91, 7, 7)
    assert "status = 'waiting_approval'" in statements[1][0] and "FOR UPDATE" in statements[1][0]
    assert statements[1][1] == (91, "asset-parse")
    assert any("status = 'queued', current_stage = %s" in sql for sql, _ in statements)
    assert any(params and params[0] == "character-lock" for sql, params in statements if "UPDATE agent_pipeline_runs" in sql)
    assert any('"asset-parse": {"characters": []}' in params[1] for sql, params in statements if "UPDATE agent_pipeline_runs" in sql)
    assert any("INSERT INTO agent_pipeline_events" in sql and params[5] == "approved" for sql, params in statements)
    assert connection.committed and not connection.rolled_back and connection.closed


def test_pipeline_decision_rolls_back_when_no_matching_approval_execution_exists():
    class PipelineDecisionCursor(RecordingCursor):
        def __init__(self):
            super().__init__([])
            self.current_row = None

        def execute(self, sql, params=()):
            self.statements.append((sql, params))
            self.current_row = ({
                "id": 91, "project_id": 8, "user_id": 7, "status": "waiting_approval",
                "current_stage": "asset-parse", "output_snapshot_json": "{}",
            } if "FROM agent_pipeline_runs apr" in sql else None)

        def fetchone(self):
            return self.current_row

    connection = RecordingConnection([])
    connection.query = PipelineDecisionCursor()
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.apply_agent_pipeline_decision(91, 7, "asset-parse", "approve")

    assert result == {"outcome": "not_waiting"}
    assert len(connection.query.statements) == 2
    assert connection.rolled_back and not connection.committed and connection.closed


def test_project_assets_query_checks_owner_in_same_statement():
    class AssetsCursor(OutlineCursor):
        def execute(self, sql, params=()):
            self.statements.append((sql, params))
            self.current_row = {
                "owner_project_id": 8,
                "characters": "[]", "images": "[]", "videos": "[]", "audios": "[]",
            }

    class AssetsConnection(RecordingConnection):
        def __init__(self):
            super().__init__([])
            self.query = AssetsCursor()

    connection = AssetsConnection()
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.project_assets(project_id=8, user_id=7)

    assert result == {"characters": [], "images": [], "videos": [], "audios": []}
    assert len(connection.query.statements) == 1
    sql, params = connection.query.statements[0]
    assert "FROM projects p" in sql
    assert "p.user_id = %s" in sql
    assert "JSON_ARRAY()" in sql
    assert "ia.updated_at" not in sql
    assert "va.updated_at" not in sql
    assert "aa.updated_at" not in sql
    assert params == (8, 7)
    assert connection.closed


def test_project_assets_returns_none_when_owner_scoped_row_is_missing():
    class MissingAssetsCursor(OutlineCursor):
        def execute(self, sql, params=()):
            self.statements.append((sql, params))
            self.current_row = None

        def fetchone(self):
            return self.current_row

    class MissingAssetsConnection(RecordingConnection):
        def __init__(self):
            super().__init__([])
            self.query = MissingAssetsCursor()

    connection = MissingAssetsConnection()
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    assert database.project_assets(project_id=8, user_id=7) is None
    assert connection.closed


def test_project_assets_restores_per_type_newest_first_order_after_json_aggregation():
    import json

    class OrderedAssetsCursor(OutlineCursor):
        def execute(self, sql, params=()):
            self.statements.append((sql, params))
            self.current_row = {
                "owner_project_id": 8,
                "characters": json.dumps([
                    {"id": 1, "updated_at": "2026-01-01 00:00:00"},
                    {"id": 2, "updated_at": "2026-02-01 00:00:00"},
                ]),
                "images": json.dumps([
                    {"id": 3, "created_at": "2026-01-01 00:00:00"},
                    {"id": 4, "created_at": "2026-02-01 00:00:00"},
                ]),
                "videos": "[]", "audios": "[]",
            }

    class OrderedAssetsConnection(RecordingConnection):
        def __init__(self):
            super().__init__([])
            self.query = OrderedAssetsCursor()

    connection = OrderedAssetsConnection()
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.project_assets(project_id=8, user_id=7)

    assert [row["id"] for row in result["characters"]] == [2, 1]
    assert [row["id"] for row in result["images"]] == [4, 3]


def test_project_audio_query_checks_owner_and_preserves_node_sorting_contract():
    class ProjectAudioCursor(RecordingCursor):
        def __init__(self):
            super().__init__([{"id": 21, "track_type": "dialogue"}])
            self.fetchone_calls = 0

        def fetchone(self):
            self.fetchone_calls += 1
            return {"id": 8} if self.fetchone_calls == 1 else None

    class ProjectAudioConnection(RecordingConnection):
        def __init__(self):
            super().__init__([{"id": 21, "track_type": "dialogue"}])
            self.query = ProjectAudioCursor()

    connection = ProjectAudioConnection()
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    rows = database.list_project_audio(project_id=8, user_id=7)

    assert rows == [{"id": 21, "track_type": "dialogue"}]
    assert len(connection.query.statements) == 2
    owner_sql, owner_params = connection.query.statements[0]
    audio_sql, audio_params = connection.query.statements[1]
    assert "FROM projects WHERE id = %s AND user_id = %s" in owner_sql
    assert owner_params == (8, 7)
    assert "FROM audio_assets aa" in audio_sql
    assert "LEFT JOIN script_scenes sc" in audio_sql
    assert "LEFT JOIN storyboards sb" in audio_sql
    assert "LEFT JOIN characters c" in audio_sql
    assert "WHEN 'dialogue' THEN 1" in audio_sql
    assert "WHEN 'narration' THEN 2" in audio_sql
    assert "WHEN 'music' THEN 3" in audio_sql
    assert "WHEN 'sfx' THEN 4" in audio_sql
    assert "aa.version_no DESC" in audio_sql
    assert "aa.id DESC" in audio_sql
    assert audio_params == (8,)
    assert connection.closed


def test_create_audio_assets_locks_owner_project_versions_and_commits_batch():
    class AudioCreateCursor(RecordingCursor):
        def __init__(self):
            super().__init__([{"id": 8}, {"max_version": 4}, {"id": 91, "version_no": 5}])
            self.rows_call = 0
            self.lastrowid = 90

        def execute(self, sql, params=()):
            super().execute(sql, params)
            if sql.lstrip().startswith("INSERT INTO audio_assets"):
                self.lastrowid += 1

        def fetchone(self):
            self.rows_call += 1
            return self.rows[self.rows_call - 1] if self.rows_call <= 2 else None

        def fetchall(self):
            return [{"id": 91, "version_no": 5}]

    connection = RecordingConnection([])
    connection.query = AudioCreateCursor()
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    rows = database.create_audio_assets(8, 7, [{
        "track_type": "dialogue", "scene_id": 5, "storyboard_id": 21,
        "character_id": 9, "audio_url": "https://cdn.test/audio.wav",
        "title": "对白轨", "duration_seconds": 2.5,
    }])

    assert rows == [{"id": 91, "version_no": 5}]
    assert "FOR UPDATE" in connection.query.statements[0][0]
    assert connection.query.statements[1][1] == (8, "dialogue", 5, 9)
    insert = next(statement for statement in connection.query.statements if statement[0].lstrip().startswith("INSERT INTO audio_assets"))
    assert insert[1][5] == 5
    assert insert[1][8] == "https://cdn.test/audio.wav"
    assert connection.committed and not connection.rolled_back and connection.closed


def test_active_voice_profiles_filter_and_order_in_database():
    connection = RecordingConnection([{"profile_key": "female-a", "status": "active"}])
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    result = database.list_active_voice_profiles()

    assert result == [{"profile_key": "female-a", "status": "active"}]
    assert connection.query.statements == [(
        "SELECT * FROM voice_profiles WHERE status = 'active' ORDER BY sort_order ASC, profile_key ASC",
        (),
    )]
    assert connection.closed


def test_project_list_query_includes_latest_completed_export_per_project():
    connection = RecordingConnection([{"id": 8, "latest_export_id": 91}])
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    rows = database.list_projects(user_id=7)

    assert rows == [{"id": 8, "latest_export_id": 91}]
    assert len(connection.query.statements) == 1
    sql, params = connection.query.statements[0]
    assert "latest_export_video_url" in sql
    assert "FROM export_records er" in sql
    assert "er.status = 'completed'" in sql
    assert "p.user_id = %s" in sql
    assert "ORDER BY p.created_at DESC, p.id DESC" in sql
    assert params == (7,)
    assert connection.closed


def test_mysql_connection_uses_configured_network_timeouts(monkeypatch):
    from types import SimpleNamespace

    from app.database import MySQLDatabase

    captured = {}
    monkeypatch.setattr(
        "app.database.pymysql.connect",
        lambda **kwargs: captured.update(kwargs) or object(),
    )
    settings = SimpleNamespace(
        mysql_host="mysql",
        mysql_port=3306,
        mysql_user="app",
        mysql_password="secret",
        mysql_database="projectdream",
        mysql_connect_timeout=4,
        mysql_read_timeout=9,
        mysql_write_timeout=11,
    )

    MySQLDatabase(settings)._connection()

    assert captured["connect_timeout"] == 4
    assert captured["read_timeout"] == 9
    assert captured["write_timeout"] == 11


class GeneratedCharacterCursor(RecordingCursor):
    def __init__(self, *, fail_on_storyboard_bind=False):
        super().__init__([])
        self.current_row = None
        self.fail_on_storyboard_bind = fail_on_storyboard_bind

    def execute(self, sql, params=()):
        if self.fail_on_storyboard_bind and "UPDATE storyboards sb" in sql:
            raise RuntimeError("simulated storyboard write failure")
        self.statements.append((sql, params))
        if "SELECT id FROM projects" in sql:
            self.current_row = {"id": 8}
        elif "SELECT id FROM characters WHERE" in sql:
            self.current_row = {"id": 12}
        elif "SELECT id, name, status FROM characters" in sql:
            self.current_rows = [
                {"id": 12, "name": "林知夏", "status": "draft"},
                {"id": 13, "name": "旧角色", "status": "draft"},
            ]
        elif "SELECT * FROM characters WHERE" in sql:
            self.current_rows = [{"id": 12, "project_id": 8, "name": "林知夏", "status": "draft"}]
        else:
            self.current_row = None
            self.current_rows = []

    def fetchone(self):
        return self.current_row


class GeneratedCharacterConnection(RecordingConnection):
    def __init__(self, *, fail_on_storyboard_bind=False):
        super().__init__([])
        self.query = GeneratedCharacterCursor(fail_on_storyboard_bind=fail_on_storyboard_bind)


def test_generated_character_upsert_locks_project_and_commits_all_related_writes():
    connection = GeneratedCharacterConnection()
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    rows = database.upsert_generated_characters(8, [{
        "name": "林知夏", "role_tag": "主角", "personality": "克制",
        "appearance": "黑色短发", "costume": "灰色风衣", "gender": "female",
    }])

    assert rows == [{"id": 12, "project_id": 8, "name": "林知夏", "status": "draft"}]
    statements = connection.query.statements
    assert "SELECT id FROM projects WHERE id = %s FOR UPDATE" in statements[0][0]
    assert statements[0][1] == (8,)
    character_select = next(sql for sql, _ in statements if "SELECT id FROM characters WHERE" in sql)
    assert "ORDER BY id ASC LIMIT 1 FOR UPDATE" in character_select
    character_update = next(sql for sql, _ in statements if "UPDATE characters" in sql)
    assert "gender = COALESCE(NULLIF(%s, ''), gender)" in character_update
    assert any("SET status = 'archived'" in sql for sql, _ in statements)
    assert any("UPDATE storyboards sb" in sql and "sb.character_id IS NULL" in sql for sql, _ in statements)
    assert connection.committed and not connection.rolled_back and connection.closed


def test_generated_character_upsert_rolls_back_when_storyboard_binding_fails():
    connection = GeneratedCharacterConnection(fail_on_storyboard_bind=True)
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    try:
        database.upsert_generated_characters(8, [{"name": "林知夏"}])
    except RuntimeError as exc:
        assert str(exc) == "simulated storyboard write failure"
    else:
        raise AssertionError("the simulated write failure must escape")

    assert connection.rolled_back and not connection.committed and connection.closed


def test_create_asset_node_commits_insert_before_return():
    class AssetNodeCursor(RecordingCursor):
        lastrowid = 77

        def execute(self, sql, params=()):
            self.statements.append((sql, params))
            self.current_rows = (
                [{"id": 77, "project_id": 8, "node_type": "character", "label": "林默"}]
                if sql.lstrip().startswith("SELECT") else []
            )

    connection = RecordingConnection([])
    connection.query = AssetNodeCursor([])
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    row = database.create_asset_node(8, {
        "nodeType": "character", "refId": 12, "label": "林默",
        "promptText": "角色提示词", "turnaroundPromptText": "三视图提示词",
    })

    assert row["id"] == 77
    insert_sql, insert_params = connection.query.statements[0]
    assert "INSERT INTO asset_nodes" in insert_sql
    assert insert_params[0] == 8
    assert connection.committed and not connection.rolled_back and connection.closed


def test_update_asset_node_fields_commits_update_before_return():
    class AssetNodeCursor(RecordingCursor):
        def execute(self, sql, params=()):
            self.statements.append((sql, params))
            self.current_rows = (
                [{"id": 77, "label": "更新后的节点"}]
                if sql.lstrip().startswith("SELECT") else []
            )

    connection = RecordingConnection([])
    connection.query = AssetNodeCursor([])
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    row = database.update_asset_node_fields(77, {"label": "更新后的节点"})

    assert row["label"] == "更新后的节点"
    update_sql, update_params = connection.query.statements[0]
    assert "UPDATE asset_nodes SET label = %s" in update_sql
    assert update_params == ("更新后的节点", 77)
    assert connection.committed and not connection.rolled_back and connection.closed


def test_insert_character_commits_insert_before_return():
    class CharacterCursor(RecordingCursor):
        lastrowid = 55

        def execute(self, sql, params=()):
            self.statements.append((sql, params))
            self.current_rows = (
                [{"id": 55, "project_id": 8, "name": "林默", "status": "draft"}]
                if sql.lstrip().startswith("SELECT") else []
            )

    connection = RecordingConnection([])
    connection.query = CharacterCursor([])
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    row = database.insert_character(8, {"name": "林默", "roleTag": "主角"})

    assert row["id"] == 55
    insert_sql, _ = connection.query.statements[0]
    assert "INSERT INTO characters" in insert_sql
    assert connection.committed and not connection.rolled_back and connection.closed


def test_update_character_fields_commits_update_before_return():
    class CharacterCursor(RecordingCursor):
        def execute(self, sql, params=()):
            self.statements.append((sql, params))
            self.current_rows = (
                [{"id": 55, "voice_locked": 1}]
                if sql.lstrip().startswith("SELECT") else []
            )

    connection = RecordingConnection([])
    connection.query = CharacterCursor([])
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    row = database.update_character_fields(55, {"voice_locked": 1})

    assert row["voice_locked"] == 1
    update_sql, update_params = connection.query.statements[0]
    assert "UPDATE characters SET voice_locked = %s" in update_sql
    assert update_params == (1, 55)
    assert connection.committed and not connection.rolled_back and connection.closed


def test_update_scene_spatial_anchors_commits_owner_scoped_update():
    class SceneAnchorCursor(RecordingCursor):
        rowcount = 1

        def execute(self, sql, params=()):
            self.statements.append((sql, params))
            self.rowcount = 1

    connection = RecordingConnection([])
    connection.query = SceneAnchorCursor([])
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    updated = database.update_scene_spatial_anchors(3, 8, 7, '{"version":1,"anchors":[]}')

    assert updated is True
    update_sql, update_params = connection.query.statements[0]
    assert "INNER JOIN projects p" in update_sql
    assert "p.user_id = %s" in update_sql
    assert update_params == ('{"version":1,"anchors":[]}', 3, 8, 7)
    assert connection.committed and not connection.rolled_back and connection.closed


def test_confirm_character_image_persists_the_adopted_storage_key():
    connection = RecordingConnection([{"id": 301, "status": "confirmed"}])
    database = MySQLDatabase(None)
    database._connection = lambda: connection

    row = database.confirm_character_image_txn(
        301, 9, "https://media.example.com/signed.png?expires=1", "characters/9/v2-approved.png"
    )

    assert row["id"] == 301
    character_update = next(
        (sql, params) for sql, params in connection.query.statements
        if sql.lstrip().startswith("UPDATE characters")
    )
    assert "reference_image_storage_key = %s" in character_update[0]
    assert character_update[1] == (
        "https://media.example.com/signed.png?expires=1", "characters/9/v2-approved.png", 9
    )
    assert connection.committed and not connection.rolled_back and connection.closed
