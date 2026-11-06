# Douyin Episode Production Skill

## Purpose

Convert a short-drama script into a reproducible vertical episode production plan.

## Required sequence

1. Decompose the script into emotional beats and shots.
2. Confirm character placement, scene geometry, props, and camera direction.
3. Generate prompts with explicit character and scene asset references.
4. Add continuity instructions for motion and 15-second transitions.
5. Gate video generation on asset-reference validation.
6. Keep screen text for post-production overlays whenever exact Chinese text is required.
7. Build a direction contract for every shot: a time-bounded gaze plan and a layered sound plan.
8. Treat video candidates as technically inspectable but semantically pending until a person verifies the visible action, gaze order, asset identity, and audio sync.

## Prompt modules

- `story-breakdown`: shot purpose, subject, action, dialogue, and staging.
- `continuity`: start state, end state, movement, and handoff to the next shot.
- `transition-15s`: a transition suited to the preceding and following shots.
- `post-text`: exact screen copy reserved for subtitle or UI overlay compositing.
- `gaze-direction`: start target, ordered target changes, eye-leading/head-following, and final lock.
- `sound-design`: continuous room bed, action Foley cues, cue timing, mix priority, and intentional silence policy.

## Output contract

Return `episode`, `shots`, `assetReferences`, `continuityChecks`, and `blockers`.

## Direction and candidate acceptance

- The visible prompt stays compact and production-facing. Internal duration evidence, inference reasons, and validation metadata stay in structured fields.
- A shot with gaze movement must name real in-frame targets and time ranges. Use explicit observable actions such as `eyes move first, head follows half a beat later`; do not rely on `look toward` alone.
- A shot without dialogue still keeps a continuous spatial bed unless the script explicitly requests silence. Mechanical actions receive time-linked Foley cues.
- The final video request must carry the structured gaze and sound contracts in addition to the compact prompt. Storing them only in the database is insufficient.
- Technical inspection may flag missing audio, near-silence, frozen motion, or duration drift. It must not claim that gaze semantics or story fidelity passed; those remain `pending_review` until human playback.
