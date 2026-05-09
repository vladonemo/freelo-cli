# R37 — `freelo tasks estimate`

**Roadmap line (Wave 6, "Advanced task surface"):**

> **Endpoints:** `POST /task/{id}/total-time-estimate`, `DELETE /task/{id}/total-time-estimate`, `POST /task/{id}/users-time-estimates/{user_id}`, `DELETE /task/{id}/users-time-estimates/{user_id}`.
>
> **CLI:**
>
> ```
> freelo tasks estimate set <id> --minutes <n> [--user <id>]        # per-user if --user
> freelo tasks estimate clear <id> [--user <id>]
> ```
>
> **Depends on:** R10.

## Run parameters

- `allowNetwork`: false (MSW only)
- `autoShip`: false (PR open for human review; do not invoke `/ship`)
- Budget: defaults from `.claude/docs/autonomous-sdlc.md`
  - 30 min wall clock
  - 40 agent invocations
  - 8 phase retries
  - 25 files touched

## Predecessor patterns to mirror

- **R35** (`tasks remind set/clear`, spec 0049) — parent + leaves shape, idempotency on destructive op (defensive 404 → `already_in_target_state: true`).
- **R36** (`tasks share/unshare`, spec 0050) — sibling pair under `tasks`, OpenAPI as authoritative source.

## OpenAPI confirmation (already inspected during triage prep)

`docs/api/freelo-api.yaml:2254-2377`:

- `POST /task/{task_id}/total-time-estimate` — body `{ minutes: integer }` (required); response `SuccessResponse`. Upsert.
- `DELETE /task/{task_id}/total-time-estimate` — no body; `SuccessResponse`. Idempotent (200 even with no estimate, yaml :2299).
- `POST /task/{task_id}/users-time-estimates/{user_id}` — body `{ minutes: integer }` (required); response `SuccessResponse`. Upsert; ACL filtered (yaml :2326).
- `DELETE /task/{task_id}/users-time-estimates/{user_id}` — no body; `SuccessResponse`. Idempotent (yaml :2362).

The per-user endpoints behave identically to the total endpoints. The only difference is the path. Per-user does NOT auto-update the total (yaml :2325).
