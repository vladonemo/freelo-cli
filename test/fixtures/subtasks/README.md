# Subtask fixtures — live capture, 2026-08-30 (R14)

Captured from the real Freelo API against a dedicated test account, not hand-written.
Author name and user id are scrubbed; tasklist names normalised. Full provenance:
`docs/runs/2026-08-29-2230-r14-subtask-type/fixture-capture.md`.

The point of this set is the difference between the two endpoints:

| File | Endpoint | `type` |
|---|---|---|
| `post-subtask.smart.json` | `POST /task/{id}/subtasks` | **absent** |
| `post-subtask.taskcheck-fallback.json` | `POST /task/{id}/subtasks` (server fell back) | **absent** |
| `get-subtasks.smart.json` | `GET /task/{id}/subtasks` | `"subtask"` |

`POST` never returns `type`. Anything that needs the discriminator must read it from a
`GET`, or infer it — see `inferStorageForm` in `src/api/subtasks.ts`.
