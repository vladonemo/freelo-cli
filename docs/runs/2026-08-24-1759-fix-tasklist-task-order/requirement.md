# Requirement — 2026-08-24-1759-fix-tasklist-task-order

**Source:** GitHub issue #108 — <https://github.com/vladonemo/freelo-cli/issues/108>
**Invoked:** 2026-08-24T15:59:45Z
**Mode:** autonomous (`/auto`)

## Original input (verbatim)

> Fix the tasklist task-order bug documented in GitHub issue #108
> (<https://github.com/vladonemo/freelo-cli/issues/108>): `freelo tasks list --project <p>
> --tasklist <t>` (GET /project/{p}/tasklist/{t}/tasks via getTasklistActiveTasks in
> src/api/tasks.ts) returns tasks ordered by creation date instead of the tasklist's
> explicit/manual order when --order-by/--order are omitted.
>
> Full context (read the issue itself for the complete writeup — repro, ranked hypotheses,
> blast radius):
>
> - src/api/tasks.ts:128-152 `getTasklistActiveTasks()` only sends `order_by`/`order` query
>   params when the caller passes `--order-by`/`--order` explicitly (src/commands/tasks/list.ts).
>   When omitted, no `order_by` is sent — sorting is left to whatever the live server defaults to.
> - docs/api/freelo-api.yaml:1381-1386 documents this endpoint's `order_by` default as
>   `priority` (presumably the manual/drag-and-drop order column), but the reported live symptom
>   (creation-date order) suggests the actual live default may be `date_add`, not `priority` — or,
>   alternatively, `order_by=priority` may not correspond to "manual/explicit order" at all.
> - This is unverifiable from static analysis or the MSW test suite (test/msw/handlers.ts:604-606
>   just echoes back whatever fixture array a test supplies regardless of query string) — it
>   requires a live API check.

## Run parameters

| Parameter | Value | Source |
|---|---|---|
| `allowNetwork` | **false** | default — no `--allow-network` passed |
| `autoShip` | **false** | default |
| Wall clock budget | 30 min | default |
| Agent-invocation budget | 40 | default |
| Phase-retry budget | 8 | default |
| Files-touched budget | 25 | default |

## Standing instruction from the invoker

> Given allowNetwork is false, you will almost certainly hit the "API behavior not in
> `docs/api/freelo-api.yaml` → Pause (don't guess the API)" decision rule when you reach the
> point of needing to confirm the live default `order_by` behavior — that's expected and
> correct; do not guess or speculatively "fix" the default without that confirmation.
>
> Proceed through triage → spec → plan, and as far into implementation as you can without
> needing the live check or without guessing API behavior.

## Orchestration note

This run's orchestrator session had **no `Task` sub-agent delegation tool available**. Each
specialist role (`triage`, `architect`, `code-reviewer`) was executed inline by the orchestrator
against that agent's definition in `.claude/agents/`. Tool budget accounting below counts
inline role executions as agent invocations. This is recorded for audit fidelity — see
`summary.md` §Deviations.
