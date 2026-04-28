# Triage — R21 `freelo reports list`

**Run:** 2026-04-28-2111-r21-reports-list
**Date:** 2026-04-28
**Tier:** **Yellow**

## Rationale

Triggers (any → Yellow):
- New top-level user-visible command namespace `reports` with `list` subcommand. Additive.
- New envelope schema `freelo.reports.list/v1`. Backwards-compatible addition.
- Changeset will be `minor` (new command).

Not Red because:
- No touch on `src/config/`, auth, `src/api/client.ts`, TLS/retry/redirect defaults.
- No breaking change to existing envelope schemas, exit codes, or flag names.
- No dependency removal or major bump.
- Spec scope can be resolved without human input — see scope decision below.

Not Green because:
- New user-visible command (Yellow trigger).

## Route flags

- `requiresFreeloApi`: **true** — invoke `freelo-api-specialist` during spec to confirm endpoint shape.
- `needsSecurityReview`: **false** — read-only endpoint, no auth changes, no config changes, no new HTTP surface.
- `preApprovedDeps`: `[]` (no new deps expected; reuses `undici`, `zod`, `commander`, `cli-table3`).

## Scope-narrowing decision (autonomous, no pause)

The roadmap line names two endpoints:

> **Endpoints:** `GET /work-reports`, `GET /task/{task_id}/work-reports`.

The OpenAPI (`docs/api/freelo-api.yaml`) only defines:

- `GET /work-reports` (`docs/api/freelo-api.yaml:2947-3043`) — paginated, with `tasks_ids[]` filter.
- `POST /task/{task_id}/work-reports` (`:3045-3093`) — **create** a work report, used by R22 (`reports log`). **No GET.**
- `POST /work-reports/{work_report_id}` and `DELETE /work-reports/{work_report_id}` — used by R22.

**Decision:** Ship R21 against `GET /work-reports` only. The `--task <id>` flag is implemented as a wire filter on `tasks_ids[]` (the documented mechanism for task-scoped filtering on the global endpoint). The non-existent task-scoped GET is **deferred** (could be added later as R21.5 if the OpenAPI gets a task-scoped GET).

**Precedent:** R16 (`comments list`) made exactly this call — the roadmap referenced `GET /task/{task_id}/comments` which wasn't in the OpenAPI; the team scoped down to the global endpoint and added a `--task` filter via the documented `?tasks_ids[]=...` parameter (`docs/runs/2026-04-27-2234-comments-list/decisions/01-scope-narrow.md`).

**This is a `decide-and-log` decision per `.claude/docs/autonomous-sdlc.md` "Autonomous decisions vs. pauses" — the documented endpoint provides the same functionality (`tasks_ids[]` accepts a single id), so the user-facing CLI surface (`--task <id>`) lands as specified. No pause needed.**

Decision logged at: `docs/decisions/2026-04-28-2111-r21-reports-list-1-scope-narrow.md`.

## Pre-flight

- main synced, working tree clean.
- `pnpm install` confirmed up to date.
- Branch will be `feat/reports-list`.

## Phase plan

1. ✓ Triage (this doc)
2. Spec — `architect` + `freelo-api-specialist` → `docs/specs/0033-r21-reports-list.md`
3. Plan — `architect` appends `## Plan`
4. Implement — branch `feat/reports-list`
5. Test — vitest + MSW
6. Local gates — `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`
7. Review — `code-reviewer`
8. Document — `doc-writer` + `pnpm fix:readme`
9. Changeset — `freelo-cli: minor`
10. PR — open against `main`, **stop** for human review (Yellow gate)
