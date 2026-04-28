---
'freelo-cli': minor
---

R20 — `freelo time stop` / `freelo time edit`. Finish the time-tracking surface: stop the active session and convert it into a finalized work report; edit the active session in flight to switch tracked task or update the note. Closes Wave 3's time-tracking sub-thread.

```
freelo time stop [--dry-run]
freelo time edit [--task <id>] [--clear-task] [--note <str>] [--dry-run]
```

Wraps `POST /timetracking/stop` (OpenAPI `stopTimeTracking`, yaml :2780-2809) and `POST /timetracking/edit` (OpenAPI `editTimeTracking`, yaml :2811-2861).

**No-active-session 409 is the load-bearing UX.** Both endpoints return HTTP 409 with `"Timetracking is not running."` when no session is active. The CLI catches `FreeloApiError(httpStatus: 409)` on either command and rewrites `hint_next` to `"No active time tracking session for your account. Use \`freelo time start\` to begin one."` Symmetric to R19's already-running 409 hint.

**Two new envelope schemas (additive surface):**

- `freelo.time.stop/v1` — `data.work_report: { id, date_add, date_reported, minutes, note, task, cost, worker, author }` on live; `data.would: { method, path, body: null }` on `--dry-run`. The wire `WorkReport` shape is projected to a stable subset; inner refs are tightened (we own the public contract) and `passthrough` is dropped.
- `freelo.time.edit/v1` — `data: { uuid, applied_changes }` on live; `data.applied_changes` mirrors the wire body shape exactly so agents can read `'task_id' in applied_changes` to know whether the user touched the task field. Keys present iff the corresponding flag was passed.

**`time edit` adds `--task` / `--clear-task` mutex.** OpenAPI's edit body documents `task_id: null` as a meaningful "disassociate from task" value (continue as general work). The CLI exposes both directions: `--task <id>` to reassign, `--clear-task` to disassociate. Mutually exclusive — both supplied → `VALIDATION_ERROR` exit 2. The roadmap omitted both flags; we add them so agents can drive the documented capability.

**Empty edit is a usage error.** `freelo time edit` with no flags → `VALIDATION_ERROR` exit 2. Catches typos and accidental flag drops at the boundary, before the network call. Mirrors R10 `tasks edit` precedent.

**Three OpenAPI-vs-roadmap discrepancies resolved.** (See spec 0032 §1, §6, decisions 1, 2, 8.)

1. **`time edit` is POST, not PATCH.** The roadmap text says `PATCH /timetracking/edit`; OpenAPI yaml :2812 says `post:`. Per the orchestrator hard rule "follow the OpenAPI spec when it contradicts the roadmap", we ship POST.
2. **No `--note` on `time stop`.** The roadmap proposed it, but the OpenAPI spec for `/timetracking/stop` documents no request body. Sending one would be guessing API behavior. Workaround: chain `freelo time edit --note "..." && freelo time stop`.
3. **No `--started-at <ISO>` on `time edit`.** Same shape as #2 — OpenAPI body has only `task_id` and `note`. Deferred to a follow-up slice (R20.5), mirroring the R19 → R19.5 deferral pattern for `--at` on `time start`.

**Batch input (`--ids` / `--stdin`) is N/A** for both commands: singleton-per-user precludes batch, same as R19.

**Out of scope for this slice:**

- `--note` on `time stop` (decision 1).
- `--started-at <ISO>` on `time edit` (decision 2 — deferred to R20.5).
- `reports list` (work reports) — R21.
- Retroactive work-report logging without timer — R22.

No new dependencies.
