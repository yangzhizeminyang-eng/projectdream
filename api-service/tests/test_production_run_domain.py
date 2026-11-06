from app.domain.production_run import (
    PRODUCTION_RUN_STAGES,
    build_production_checkpoint_transition,
    build_production_run_seed,
    build_production_stage_completion_transition,
    evaluate_episode_blueprint,
    normalize_production_run_input,
)


def test_normalize_production_run_input_matches_first_pilot_defaults():
    normalized = normalize_production_run_input({"projectId": 12, "episodeNo": 2})

    assert normalized == {
        "projectId": 12,
        "platform": "抖音",
        "episodeNo": 2,
        "budget": None,
        "pilotSceneCount": 2,
        "pilotMode": "two-scenes-golden-sample",
        "candidatePolicy": {
            "keyShotVideoCandidates": 3,
            "normalShotVideoCandidates": 2,
            "imageCandidates": 3,
            "audioCandidates": 2,
            "maxCandidateCostMultiplier": 3,
        },
        "successMetrics": ["3秒留存", "完播率", "评论与关注意愿"],
    }


def test_production_run_seed_has_initial_checkpoint_and_blocked_future_stages():
    seed = build_production_run_seed({"projectId": 12, "episodeNo": 1}, blueprint={"title": "样片"})

    assert seed["run"]["status"] == "waiting_approval"
    assert seed["run"]["currentStage"] == "market-validation"
    assert seed["run"]["currentCheckpoint"] == "market-validation"
    assert [item["checkpointKey"] for item in seed["checkpoints"]] == [
        "market-validation", "blueprint", "candidate-selection", "pilot-release"
    ]
    assert seed["stages"][0]["status"] == "waiting_approval"
    assert all(item["status"] == "blocked" for item in seed["stages"][1:])
    assert seed["run"]["outputSnapshot"] == {"blueprint": {"title": "样片"}}


def test_blueprint_quality_gate_requires_real_shot_plan_and_hooks():
    report = evaluate_episode_blueprint({"targetDurationSeconds": 24, "emotionBeats": [], "shotPlan": []})

    assert report["canApprove"] is False
    assert {item["code"] for item in report["blockers"]} >= {
        "emotion-beats-incomplete", "missing-hook-beat", "missing-cliffhanger-beat",
        "missing-continuity-constraints", "missing-shot-plan", "missing-story-hook",
        "candidate-tier-incomplete",
    }


def test_checkpoint_approval_completes_current_stage_and_activates_next_gate():
    stages = [{"stageKey": item[0], "status": "waiting_approval" if index == 0 else "blocked"}
              for index, item in enumerate(PRODUCTION_RUN_STAGES)]
    checkpoints = [{"checkpointKey": key, "status": "pending" if index == 0 else "blocked"}
                   for index, key in enumerate(("market-validation", "blueprint", "candidate-selection", "pilot-release"))]

    transition = build_production_checkpoint_transition(
        run={"currentStage": "market-validation", "currentCheckpoint": "market-validation"},
        stages=stages, checkpoints=checkpoints, checkpoint_key="market-validation", decision="approve",
    )

    assert transition["runUpdate"] == {
        "status": "waiting_approval", "currentStage": "episode-blueprint", "currentCheckpoint": "blueprint",
        "failureCode": None, "failureText": None,
    }
    assert transition["stageUpdates"] == [
        {"stageKey": "market-validation", "status": "completed"},
        {"stageKey": "episode-blueprint", "status": "waiting_approval"},
    ]
    assert transition["nextCheckpoint"] == {"checkpointKey": "blueprint", "status": "pending"}


def test_checkpoint_rejection_pauses_without_activating_a_future_stage():
    stages = [{"stageKey": item[0], "status": "waiting_approval" if index == 0 else "blocked"}
              for index, item in enumerate(PRODUCTION_RUN_STAGES)]
    checkpoints = [{"checkpointKey": key, "status": "pending" if index == 0 else "blocked"}
                   for index, key in enumerate(("market-validation", "blueprint", "candidate-selection", "pilot-release"))]

    transition = build_production_checkpoint_transition(
        run={"currentStage": "market-validation", "currentCheckpoint": "market-validation"},
        stages=stages, checkpoints=checkpoints, checkpoint_key="market-validation", decision="reject", note="需重做",
    )

    assert transition["runUpdate"]["status"] == "paused"
    assert transition["runUpdate"]["failureText"] == "需重做"
    assert transition["stageUpdates"] == []


def test_production_stage_completion_requires_current_ready_stage_and_advances_atomically():
    stages = [{"stageKey": item[0], "status": "ready" if index == 2 else "blocked"}
              for index, item in enumerate(PRODUCTION_RUN_STAGES)]
    checkpoints = [{"checkpointKey": key, "status": "blocked"}
                   for key in ("market-validation", "blueprint", "candidate-selection", "pilot-release")]

    transition = build_production_stage_completion_transition(
        run={"currentStage": "emotion-design", "currentCheckpoint": None}, stages=stages,
        checkpoints=checkpoints, completed_stage_key="emotion-design", output_snapshot={"ok": True},
    )

    assert transition["runUpdate"] == {
        "status": "running", "currentStage": "candidate-generation", "currentCheckpoint": None,
    }
    assert transition["stageUpdates"] == [
        {"stageKey": "emotion-design", "status": "completed", "outputSnapshot": {"ok": True}},
        {"stageKey": "candidate-generation", "status": "ready", "outputSnapshot": None},
    ]

    try:
        build_production_stage_completion_transition(
            run={"currentStage": "emotion-design", "currentCheckpoint": "blueprint"}, stages=stages,
            checkpoints=checkpoints, completed_stage_key="emotion-design",
        )
    except ValueError as error:
        assert "待审批检查点" in str(error)
    else:
        raise AssertionError("pending checkpoint must prevent stage completion")
