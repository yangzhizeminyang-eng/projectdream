---
name: cinematic-final-edit
description: Use for episode final-edit planning, cinematic Agent orchestration, non-destructive shot assembly, transition selection, audio bridges, quality gates, blocked/rework handling, and final MP4 export. Trigger whenever a user asks to merge storyboard videos into an episode, smooth scene continuity, add film-like transitions, inspect a finished cut, or repair a cinematic export. Never replace confirmed source videos; produce an auditable edit plan and refuse completion when quality evidence is incomplete.
compatibility: ProjectDream FFmpeg/FFprobe worker, Node service, confirmed storyboard video assets, final-edit draft API, object storage, and the project quality-gate services.
---

# ProjectDream Cinematic Final Edit Agent

This skill is the reusable operating contract for the final-edit Agent. It turns an ordered set of confirmed storyboard videos into one episode deliverable while keeping every confirmed source asset and its start/end-frame evidence intact. It is intentionally a planning and orchestration skill: the Agent may change ordering, trims, transition parameters, audio placement, and mix settings, but it must never rewrite, delete, or silently substitute a confirmed shot.

## Trigger and non-negotiable boundary

Use this skill for any request involving **成片、整集、终剪、合成、转场、镜头衔接、电影级剪辑、导出、final edit、episode render** or a quality report for one of those operations.

The final episode is a derived artifact. The source storyboard video, confirmed image, start-frame continuity reference, exact tail frame, version number, and adoption history are immutable inputs. A failed render or failed quality gate is a `blocked`/`rework` result, never a successful completion.

## Required inputs

Before planning, load and snapshot:

1. Project/episode scope and the ordered storyboard manifest.
2. Only the latest **confirmed** video for each manifest shot, including `videoAssetId`, `storageKey`, duration, scene, shot, and source URL.
3. The previous confirmed shot's exact tail-frame evidence and the current shot's start-frame evidence where continuity is enabled.
4. The episode's confirmed dialogue, narration, music, and SFX tracks plus their storyboard bindings.
5. The saved final-edit draft for this episode, if present, including explicit manual transition choices, trims, enabled state, and order.
6. Provider/model and FFmpeg capability status. If a capability is unavailable, record it as a blocker rather than guessing.

If the manifest is empty, the episode is missing a confirmed video, a draft references another episode, or a source asset cannot be traced, stop and return a structured blocker with the affected storyboard IDs.

## End-to-end operating loop

Run these stages in order and keep the evidence for each stage in the export configuration/report:

1. **Scope lock** — resolve exactly one project and episode. Reject invalid or missing `episodeNo` for an episode export. Never merge clips from another episode.
2. **Manifest audit** — compare every storyboard ID in the episode manifest with a confirmed video asset. Do not silently fall back to a still frame for an episode final cut. Report every missing ID.
3. **Continuity audit** — verify the preserved source asset IDs and the exact start/end-frame evidence. The derived edit may change a transition contact point, but it cannot rewrite the source video or claim source-frame equality after a transition has intentionally overlapped the cut.
4. **Edit-plan generation** — create a versioned, non-destructive plan containing order, trim ranges, transition, transition reason, audio bridge, source asset ID, and `sourceCandidatePreserved: true` for every clip.
5. **Semantic transition planning** — select a transition per boundary, never one global effect:
   - Same scene with action or gaze continuity: hard cut (`cut`, 0 seconds).
   - Same scene without an explicit change: hard cut by default.
   - Explicit location/time/scene change: short dissolve (`xfade=fade`, normally 0.12–0.18 seconds).
   - Use dip-to-black or push only when the story direction explicitly calls for it and the user has accepted the manual choice.
   - Do not add a transition merely because two clips are adjacent.
6. **Audio plan** — preserve source ambience when requested; align shot-bound dialogue/narration to the same storyboard; use hard audio concatenation at cuts and a short `acrossfade` only for a dissolve. Never move unbound speech to time zero. Keep music/SFX placement auditable.
7. **Render** — normalize resolution, frame rate, colour range, and audio format with FFmpeg. Render a derived intermediate per clip, then the timeline. Preserve the boundary evidence and render logs. Prefer fast-start MP4 with a playable video and audio stream.
8. **Machine quality gate** — check output existence, playable streams, duration, media inspection, clip coverage, source references, and rendered issue shots. Save blockers, warnings, evidence, and recommendations.
9. **Human review handoff** — if blocked, display the report and problem shots. Offer exactly two next actions: “按建议重新规划” or “在剪辑页手动调整后重新导出”. Do not silently skip a bad shot or label the episode complete.
10. **Completion** — only set `completed` after the quality gate passes and the derived MP4/subtitle objects are stored. The original confirmed assets remain untouched. A new regeneration creates a new derived export record; it does not overwrite the source video.

## Plan contract

The plan must contain:

```json
{
  "planVersion": "cinematic-edit-plan-v1",
  "mode": "automatic|automatic-with-user-edits",
  "sourceCandidatePreserved": true,
  "clips": [
    {
      "storyboardId": 12,
      "sourceVideoAssetId": 345,
      "order": 2,
      "trimStartSeconds": 0,
      "trimEndSeconds": 4.2,
      "transition": {"type": "cut|fade|dip|push", "durationSeconds": 0},
      "transitionManual": false,
      "audioBridge": {"type": "none|acrossfade", "durationSeconds": 0},
      "sourceCandidatePreserved": true
    }
  ]
}
```

Validate duplicate/missing storyboard IDs, source-asset mismatches, invalid trim ranges, and invalid transition durations before FFmpeg runs. If validation fails, persist the report as `blocked` and do not start a render.

## Error-repair policy

Repair only the derived plan/configuration first. A repair may change ordering, trim, transition, audio bridge, or a user-approved replacement candidate in the edit draft. It may not alter a confirmed source video, its version, its stored tail frame, or its adoption status. After each repair, re-run manifest audit → plan validation → render → quality gate. Stop after a bounded number of attempts and return the remaining blockers with exact shot IDs and the next user action.

Never turn a provider timeout, missing media, FFmpeg error, missing audio, continuity mismatch, or incomplete inspection into a success by weakening the gate. Keep the report and leave the export `blocked`/`failed` according to the actual stage.

## FFmpeg implementation guidance

- Use `concat` for a true hard cut and `xfade` only at an intentional dissolve boundary.
- Use `acrossfade` with the same short duration for a dissolve's audio boundary; do not crossfade every cut.
- Normalize all video inputs before the filter graph so `xfade` receives matching dimensions, frame rate, pixel format, and time base.
- Probe the final output with FFprobe and require both a video stream and an audio stream when the episode requests source audio or confirmed tracks.
- Treat the final output duration as derived evidence, not as an assumed sum; a dissolve reduces the total duration by its overlap.
- When the upstream prompt-vocabulary skill is available, consult it only while preparing or repairing a source-shot generation prompt. It is not an editing authority and must not override confirmed storyboard content, source continuity, user-approved clip intent, or this skill's export gates.

Public references consulted for these rules:

- FFmpeg `xfade`: https://ffmpeg.org/ffmpeg-filters.html#xfade
- FFmpeg `acrossfade`: https://ffmpeg.org/ffmpeg-filters.html#acrossfade
- OpenTimelineIO structure: https://opentimelineio.readthedocs.io/en/latest/tutorials/otio-timeline-structure.html
- SMPTE standards catalogue: https://www.smpte.org/standards
- Upstream prompt vocabulary reference (MIT): https://github.com/Rylaispirit/cinematic-video-prompt-skill
- The reviewed upstream Markdown snapshot and MIT notice are bundled in `references/`; read it only when constructing a per-shot video prompt, not when deciding final-cut transitions.

## Required report shape

Return/store a compact machine-readable report with:

- `status`: `passed` or `blocked`;
- `summary`;
- `blockers[]` and `warnings[]` with stable codes and human messages;
- `issueShots[]` containing storyboard IDs;
- `recommendations[]` describing the next safe edit action;
- `evidence` containing plan version, source count, output existence, duration, and inspection status;
- the derived export URL only when the status is `passed`.

The UI must render `blocked` as “质检阻止完成”, show the report and issue shots, and keep the re-plan/manual-edit actions visible. It must never render a blocked report as a completed episode.

## Verification checklist

Before reporting success, run the smallest applicable checks and record their actual results:

```text
node --test server/services/cinematic-edit-plan.test.mjs
node --test server/services/cinematic-quality-gate.test.mjs
node --test server/services/cinematic-export-state.test.mjs
node --test server/services/episode-export-selection.test.mjs
node --test server/services/cinematic-edit-plan.ffmpeg.test.mjs
npm run type-check
npm run build-only
git diff --check
```

For a production handoff, also run the repository's compose/health/FFmpeg smoke commands and a real authenticated episode export. If Docker, a cloud instance, credentials, or a model endpoint is unavailable, report that exact unverified boundary instead of claiming the full chain passed.

## Three realistic invocation examples

1. “把第 1 集所有已确认分镜合成一条成片，同场景硬切，明确换场用短溶解；出错就列问题镜头，不要标记完成。”
2. “终剪看起来像拼接，检查 Agent 的转场和音频桥接，但不能改写已确认的分镜视频。”
3. “按建议重新规划第 2 集并导出，保留质量报告，验证 FFmpeg 输出有视频和音频流。”
