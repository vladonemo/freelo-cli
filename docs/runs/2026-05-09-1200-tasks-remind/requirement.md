# R35 — `freelo tasks remind` (Wave 6)

**Source:** `docs/roadmap.md` §"Wave 6 — Advanced task surface" → R35.

**Endpoints:** `POST /task/{task_id}/reminder`, `DELETE /task/{task_id}/reminder`.

**CLI:**
- `freelo tasks remind set <id> --at <ISO>` — sets a reminder on a task at the given ISO 8601 timestamp.
- `freelo tasks remind clear <id>` — removes the reminder.

**Depends on:** R10 (`tasks edit`).

## Run parameters
- `allowNetwork`: false (MSW only)
- `autoShip`: false (do NOT pass `--ship`; PR open for human review)
- `budget`: defaults from `.claude/docs/autonomous-sdlc.md`

## Hard constraints
- Confirm both reminder endpoints' actual request/response shapes against `docs/api/freelo-api.yaml` (freelo-api-specialist).
- Agent-safe contract for new write commands: envelope, `--dry-run`, idempotency where natural, `--yes` / TTY confirmation if destructive (`clear` removes a resource — match R13 destructive pattern).
- Conventional commits + a `.changeset/` entry mandatory.
