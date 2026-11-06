# ProjectDream FastAPI API Gateway

FastAPI is the public `/api` entry point for the staged backend migration.

## Migration boundary

Native routes in this stage:

- `POST /api/auth/login-password`
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/{project_id}`
- `GET /api/projects/{project_id}/outline`
- `GET /api/projects/{project_id}/story-bible`
- `GET /api/projects/{project_id}/season-structure`
- `PATCH /api/projects/{project_id}`
- `GET /api/projects/{project_id}/assets`
- `GET /api/voice-profiles`
- `POST /api/project-assets/{character|image|video|audio}/{asset_id}/archive`
- `GET /api/projects/{project_id}/scenes`
- `GET /api/scenes/{scene_id}`
- `PUT /api/scenes/{scene_id}`
- `PUT /api/scenes/{scene_id}/script`
- `GET /api/scenes/{scene_id}/storyboards`
- `GET /api/storyboards/{storyboard_id}`
- `POST /api/storyboards/reorder`
- `GET /api/generation-jobs/{job_id}`
- `POST /api/videos/{video_id}/subtitles/remove`
- `POST /api/audio-assets/{audio_id}/confirm`
- `POST /api/audio-assets/{audio_id}/archive`
- `PUT /api/audio-assets/{audio_id}`
- `POST /api/images/{image_id}/confirm`
- `GET /api/shots/{shot_id}/images`
- `GET /api/projects/{project_id}/tasks`
- `POST /api/project-tasks/generation-{job_id}/retry`
- `POST /api/project-tasks/generation-{job_id}/cancel` (compatibility 409)

The task-center read route aggregates generation jobs, image/video/audio assets,
exports, and persisted task-runtime states under an owner-scoped project query.
The outline read returns the latest version ordered by version and ID, preserves
`null` when an owned project has no outline, and safely defaults malformed
structured outline JSON to empty `acts` and `scenes` arrays.
Story-bible read follows the same owner/latest-version boundary and preserves
the Node DTO defaults for all structured arrays and its optional quality report.
Season-structure read returns the latest owner-scoped version, preserves null
when absent, and maps episode, foreshadowing, and character-arc JSON fields with
the existing default values.
Latest outline, story-bible, and season-structure reads use one owner-scoped
`LEFT JOIN` query each, avoiding a separate project ownership round-trip while
preserving the distinction between a missing project and an empty resource.
Project asset listing now uses one owner-scoped query with four JSON aggregates,
preserves Node's per-type and confirmed-asset summary counts, and includes the
audio confirmation timestamp and source-derived title. Aggregated lists are
explicitly sorted to match Node's newest-first ordering. Media URLs pass
through unchanged; this migration does not alter COS signing or storage behavior.
Project listing also carries the most recent completed export and counts that
export in the 5% completion score. Project detail/create/update responses retain
the Node raw-project DTO shape and do not expose list-only progress aggregates.
`GET /api/auth/check-phone` is served directly by FastAPI and MySQL; it
preserves Node's ASCII-digit normalization, HTTP status, and response envelope.
(The former `API_NATIVE_*` rollback flags were removed in phase 4 — routes are
always native now.)
`GET /api/projects/{id}/audio` is served directly by FastAPI with the Node query
ordering, owner check, response DTO, and storage URL behavior. Local storage uses
the same HMAC-SHA256 URL contract; private Tencent COS objects use the official
Python SDK and the existing bucket, domain, protocol, and expiry configuration.
Audio generation and task execution remain with Node/Worker.
Generation-job retry is an atomic owner-scoped database transition back to
`queued`; the existing Worker/Node queue scanners claim it with the existing
conditional `queued` to `running` update. Generation cancellation preserves the
current 409 response because providers cannot be safely interrupted. Ordinary
asset retry/cancel actions persist the Node-compatible mock runtime state in
`task_runtime_states`; they do not enqueue provider work or claim that media was
generated. Cancellation is limited to queued/running mock tasks and remains
owner-scoped.

Subtitle cleanup enqueue is owner-scoped and idempotent for an existing active
job. FastAPI stores the same source-video snapshot and `queued` state consumed by
the existing Worker/Node scanners; it does not execute cleanup inline.

Audio confirmation is an owner-scoped transaction. It demotes the prior
confirmed audio only within the same project/track/scene/storyboard/character
scope, then confirms and returns the selected asset.
Audio archive is also owner-scoped and transactional; it preserves the existing
400 contract for confirmed audio and returns the updated audio asset for other
statuses.
Audio placement updates retain the 0–60 second offset bound and only accept a
storyboard belonging to the audio asset's project.
Image confirmation updates the selected frame role and storyboard start/end
image reference atomically, preserving the separate start, primary, and end
confirmation scopes.
Shot image listing first verifies storyboard ownership, then returns all frame
versions ordered by `version_no DESC, id DESC`, matching the Node API response
shape and preserving unsigned media URLs.
Storyboard reorder validates the entire batch before writing, locks and verifies
all rows belong to the caller and one scene, then commits the updates atomically.
Sort order is a non-negative integer, including zero.

All other `/api/...` routes fall back to an explicit 404/4040 envelope
(`接口不存在`) without forwarding anywhere; unmigrated routes that need a
placeholder are registered as explicit 501/5010 responses. This keeps unknown
paths deterministic now that the Node compatibility proxy is retired.

## Runtime configuration

The service reads `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` from
the runtime environment. MySQL socket timeouts are
bounded by `DB_CONNECT_TIMEOUT` (default 5 seconds), `DB_READ_TIMEOUT` and
`DB_WRITE_TIMEOUT` (default 15 seconds each); each value must be a positive
integer. Override them in seconds when the deployment's network latency requires
different limits. The service never logs credentials.

`GET /ready` checks MySQL only (the Node upstream probe was removed in phase 4)
and is used by the Docker health check so a disconnected dependency is not
reported as ready. `GET /health` reports process liveness and non-sensitive
configuration without depending on MySQL.
FastAPI responses, including the generic unhandled-error response, carry
`X-Request-Id` and `X-API-Gateway` headers so client failures can be correlated
with gateway logs.
