# Creative Workflow Readiness API

FastAPI owns the project workflow gate contract used by the script editor and
storyboard workflow. `project_workflow_states` stores the SHA-256 fingerprint
of the last successfully parsed script; migration `0005_project_workflow_states.sql`
creates the table if it is not already present from a Node release.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/projects/{id}/workflow-readiness` | Returns script, asset, and storyboard gates for the authenticated project owner. |
| `POST` | `/api/projects/{id}/workflow-readiness/parse-complete` | Revalidates saved scene text and character/scene nodes under a project lock, persists the current script fingerprint, and returns refreshed gates. |

An empty or incomplete script returns `409/4004`. Missing character or scene
nodes return `409/4004`; no fingerprint is persisted. Script edits invalidate
the fingerprint because the gate compares it with the current scene snapshot.
Storyboard generation remains blocked until required assets are confirmed.
