# R19 — `freelo time start` / `time status`

> Verbatim from `docs/roadmap.md`:

**Outcome:** Start tracking on a task; check current status.
**Endpoints:** `POST /timetracking/start`, `GET /timetracking/status`.
**CLI:** `freelo time start --task <id> [--note <str>]` / `freelo time status`.
**Ships with this slice:** friendly formatting of the "already tracking X since Y" error — time tracking is singleton per user.
**Depends on:** R08.

## Run config

- run-id: `2026-04-28-1628-r19-time-start-status`
- branch: `feat/time-start-status`
- allowNetwork: false (MSW only)
- autoShip: false (no publish)
- budget: 30 min wall, 40 agent calls, 8 retries, 25 files

## Constraints

- Yellow tier (additive — two new user-visible commands; no auth/HTTP/config changes; no new deps).
- Singleton-timer 409 from `POST /timetracking/start` must surface as a typed `FreeloApiError` with a friendly hint mentioning the active task and start time.
- `GET /timetracking/status` 204 No Content (no active timer) must NOT error — envelope with `data.active: false`, exit 0.
- New top-level `time` command at `src/commands/time.ts` with subcommands `time start` and `time status` under `src/commands/time/{start,status}.ts`, mirroring `comments` precedent.
- Output schemas: `freelo.time.start/v1`, `freelo.time.status/v1`. Both via `src/ui/envelope.ts`.
- `time start` is a write — supports `--dry-run`. Batch (`--ids`/`--stdin`) is N/A — singleton-per-user, only one in-flight start per call. Spec must rule it out and document why.
- Update README autogen Commands block; add a minor changeset.
