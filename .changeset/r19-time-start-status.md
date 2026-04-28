---
'freelo-cli': minor
---

R19 — `freelo time start` / `freelo time status`. Start a time-tracking session on a task (or general work), and check the current state of the running timer. First slice in Wave 3's time-tracking sub-thread, and first command under the new top-level `time` resource.

```
freelo time start [--task <id>] [--note <str>] [--dry-run]
freelo time status
```

Wraps `POST /timetracking/start` (OpenAPI `startTimeTracking`, yaml :2729-2778) and `GET /timetracking/status` (OpenAPI `getTimeTrackingStatus`, yaml :2863-2944).

**Singleton per user.** Freelo enforces "at most one active timer per user account". A second `time start` while one is already running returns HTTP **409 Conflict**. The CLI catches the 409, performs an opportunistic `GET /timetracking/status` follow-up to enrich `hint_next` with the active task and start time ("already tracking X since Y" — the explicit ship condition from the roadmap), and falls back to a generic `time stop` / `time edit` (R20) pointer if the follow-up fails.

**204 No Content is not an error.** `time status` returns HTTP 204 when no timer is running. The CLI translates that into a discriminated-union envelope (`{ active: false }`) with exit 0. Agents `switch` on `data.active` to branch on the timer state without nullish checks.

**Two new envelope schemas (additive surface):**

- `freelo.time.start/v1` — `{ uuid, task_id, note }` on live, `{ task_id, note, would }` on `--dry-run` (no synthesized uuid).
- `freelo.time.status/v1` — discriminated union on `data.active`:
  - `{ active: true, session: { uuid, started_at, elapsed_seconds, task, note, is_billable, is_cost_fixed, labels, cost, project_setting } }`
  - `{ active: false }`

`started_at` is a CLI-friendly rename of the wire `date_reported`; `elapsed_seconds` is derived client-side at envelope-build time and clamped at 0 for clock skew.

**Shared HTTP client extension** (`src/api/client.ts`): added a 204-No-Content branch that feeds `null` to the configured zod schema. Pure addition — no existing schema accepts `null`, so no caller changes behavior. First documented use is `GET /timetracking/status`; future 204 endpoints inherit it.

**Batch input (`--ids` / `--stdin`) is N/A** for `time start`: a successful batch could never have more than one row, since the second start would 409. Documented in spec 0030 §2.1 / decision 5.

**Out of scope for this slice:**

- `time stop`, `time edit` — R20.
- `reports list` (work reports), `reports log` — R21 / R22.
- `--at <timestamp>` backdate flag on start — Freelo supports it via `date_reported`, but the CLI doesn't surface it yet. Most workflows want "now".

No new dependencies.
