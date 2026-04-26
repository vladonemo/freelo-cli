# Requirement — R05 `freelo tasklists list`

**Run:** `2026-04-26-1537-r05-tasklists-list`
**Source:** `docs/roadmap.md:139-143`
**Date:** 2026-04-26 15:37
**Mode:** autonomous

## Roadmap entry (verbatim)

> **Outcome:** List tasklists, scoped to a project or across all projects.
> **Endpoints:** `GET /project/{project_id}/tasklists`, `GET /all-tasklists`.
> **CLI:** `freelo tasklists list [--project <id>] [--page N|--all]`
> **Depends on:** R03.

## Run flags

- Budget: default (30m, 40 calls, 8 retries, 25 files)
- `--allow-network`: false (MSW only — api-specialist works from `docs/api/freelo-api.yaml`)
- `--ship`: false (PR open is end-state)
- Pre-approved deps: none

## Calibration discipline (binding)

1. Don't skip the test phase even if the implement phase looks done.
2. `--project <id>` validation throws `ValidationError` (exit 2), NOT `InvalidArgumentError`.
3. Run all five gates on the **committed** tree before push: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`.
4. Any new `try/catch` arm gets a test case.
5. Branch protection on `main` enforces 7 CI checks; auto-merge waits on green.
