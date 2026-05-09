# Run requirement — R36 `freelo tasks share` public link

**Run ID:** `2026-05-09-1905-tasks-share`
**Roadmap line:** R36 (Wave 6 — Advanced task surface)
**Mode:** autonomous (`/auto`)

## Original requirement (verbatim, from roadmap.md §Wave 6)

> ### R36 — `freelo tasks share` (public link)
>
> **Endpoints:** `POST /public-link/task/{task_id}`, `DELETE /public-link/task/{task_id}`.
> **CLI:** `freelo tasks share <id>` (prints URL) / `freelo tasks unshare <id>`.
> **Depends on:** R10.

## Pre-flight (verified by parent)

- on `main`, working tree clean
- `main` even with `origin/main`
- `pnpm install --frozen-lockfile` succeeded
- R35 just merged (commit `f43aa1b`, PR #92)

## Run parameters

- `allowNetwork: false` (MSW only)
- `autoShip: false` (do NOT pass `--ship`; PR open for human review)
- budget: defaults from `.claude/docs/autonomous-sdlc.md`
  - 30 min wall clock
  - 40 agent invocations
  - 8 phase retries cumulative
  - 25 files touched

## Hard rules carried in

- All SDLC phases in order; pause on policy.
- `freelo-api-specialist` involvement at spec time to confirm public-link endpoint shapes against `docs/api/freelo-api.yaml`.
- `share` non-destructive (creates link); `unshare` destructive (revokes link) — match R35 `clear` confirmation pattern.
- Idempotency: already-shared `share` returns existing URL with success; already-unshared `unshare` returns success (with `already_in_target_state: true` if detectable).
- Follow R35 file/schema/MSW handler structure (spec 0049).
- Conventional commit + `.changeset/` entry mandatory.
