# Run requirement — R39 `freelo tasks create-from-template`

**Source:** Roadmap §"Wave 6 — Advanced task surface", R39 (the **last** Wave 6 slice).

> **Endpoints:** `POST /task/create-from-template/{template_id}`.
> **CLI:** `freelo tasks create-from-template <template_id> --tasklist <id> [--name <str>]`.
> **Depends on:** R09.

R35, R36, R37, R38 already merged on `main`. R39 completes the wave.

## Run parameters

- allowNetwork: false (MSW only)
- autoShip: false
- budget: defaults from `.claude/docs/autonomous-sdlc.md` (30 min wall, 40 calls, 8 retries, 25 files)

## Hard constraints from invocation

1. Single command, single endpoint — keep it the smallest Wave 6 slice.
2. Non-destructive write (creates a task) — `--dry-run` required, no `--yes` needed.
3. Confirm exact request-body shape via `freelo-api-specialist` (in-spec discovery).
4. Roadmap surface (`--tasklist`, `--name`) is hand-waved — OpenAPI is authoritative.
5. Bake calibration: `test/api/tasks-create-from-template.test.ts` exercises `signal` + `requestId` opt-spread branches (R38 PR #96 finding).
6. Follow precedents from R35–R38 (specs 0049–0052) and especially `tasklists create-from-template` (spec 0047 — same endpoint family).
