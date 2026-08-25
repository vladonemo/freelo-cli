# 0061 — `tasks list --order-by due_date`

**Run:** 2026-08-25-0909-tasks-list-order-by-due-date
**Roadmap slice:** M08 (`docs/roadmap-migration-2026-08.md` §M08)
**Tier:** Yellow (`docs/runs/2026-08-25-0909-tasks-list-order-by-due-date/triage.md`)
**Extends:** R07 (spec 0017, shipped) · follows spec 0060 / issue #108 (`freelo-cli@0.20.2`, shipped)
**Commit type:** `feat` · **Changeset:** minor

---

## Problem

`freelo tasks list --order-by due_date` fails today with

```
--order-by must be one of: priority, name, date_add, date_edited_at.
```

exit 2, before a request is ever made. The client-side whitelist at
`src/commands/tasks/list.ts:280` mirrors what the Freelo contract documented at the time R07 shipped.
PR #112 refreshed the cached contract and both task-listing routes now document a fifth `order_by`
value, `due_date`. Sorting a tasklist by deadline is one of the most obvious things to want from a
task list, and the API supports it — only the CLI's own validation stands in the way.

## Contract evidence (`docs/api/freelo-api.yaml`)

| Path | Path line | `order_by` line | Enum | Default |
|---|---|---|---|---|
| `/project/{project_id}/tasklist/{tasklist_id}/tasks` | 1498 | 1522 | `[priority, name, date_add, date_edited_at, due_date]` | `priority` |
| `/all-tasks` | 1581 | 1639 | `[priority, name, date_add, date_edited_at, due_date]` | `date_add` |

**Both** routes gained the value — the roadmap's open question ("confirm whether `/all-tasks`'s
`order_by` enum also gained `due_date` … the aggregate route's enum wasn't part of this diff pass")
resolves to **yes, both**. This spec therefore widens both code paths. Verified by direct read, not
assumed.

Documented semantics, quoted from the contract:

> When `due_date`, tasks without a due date are always last; all-day tasks sort at the start of their
> day (00:00).

`/all-tasks` (line 1641-1644) adds one sentence the tasklist route does not carry:

> Results are tie-broken by task id for stable pagination.

That extra sentence is real and route-specific — `/all-tasks` is paginated and needs a total order for
stable page boundaries; the tasklist route is unpaginated and doesn't. The docs must not flatten this
difference.

Every other `order_by` enum in the file (lines 208, 298, 458, 544, 1342, 3270 — projects, tasklists,
files, comments, time entries) is unrelated and stays at its current value set.

## Proposal

Widen the accepted value set of the **existing** `--order-by` flag from four values to five. No new
flag, no new command, no new endpoint, no new call site.

```bash
# per-tasklist route — board sorted by deadline
freelo tasks list --project 42 --tasklist 101 --order-by due_date
# wire: GET /v1/project/42/tasklist/101/tasks?order_by=due_date

# aggregate route — everything due soonest-first across all visible projects
freelo tasks list --order-by due_date --order asc --all
# wire: GET /v1/all-tasks?p=0&order_by=due_date&order=asc
```

### Interaction with the spec 0060 board-order default (load-bearing)

`getTasklistActiveTasks` injects `order_by=priority&order=asc` **only** when the caller supplies
neither `orderBy` nor `order` (`src/api/tasks.ts:159-165`). `due_date` is opaque to that branch — it
is just another caller-supplied value — so `--order-by due_date` alone must send `order_by=due_date`
and **no** `order` parameter, exactly as `--order-by name` does today (test `4a`). No change to the
defaulting logic is required or permitted. This is pinned by a new test rather than assumed.

The `priority` default is unchanged: a user who passes no order flags still gets the manual board
order that #108 fixed.

## API surface

No change. `getAllTasks` already forwards `filters.orderBy` verbatim to `params['order_by']`
(`src/api/tasks.ts:100`); `getTasklistActiveTasks` already forwards `opts.orderBy`
(`src/api/tasks.ts:163`). Both are string passthroughs. Only the **types** guarding those call sites
narrow the value set, and only those types change.

## Data model

Five type-level unions widen from 4 to 5 members. All are inputs or echoes; none is a parsed API
response, so no zod response schema changes and no validation of Freelo's output is affected.

| File | Line | Symbol |
|---|---|---|
| `src/commands/tasks/list.ts` | 63 | `ListOpts.orderBy` |
| `src/commands/tasks/list.ts` | 280 | Commander `parseEnumFlag` allow-list (runtime gate) |
| `src/api/tasks.ts` | 51 | `AllTasksFilters.orderBy` |
| `src/api/tasks.ts` | 126 | `TasklistTasksOpts.orderBy` |
| `src/api/schemas/task.ts` | 149 | `AppliedFilters.order_by` |

Only line 280 is a **runtime** gate; the other four are compile-time only. All five must move together
or `tsc` fails — which is the desired property.

### Envelope: no bump

`freelo.tasks.list/v1` stays `/v1`. `applied_filters.order_by` is not added, removed, renamed, or
retyped — its value domain widens by one string literal. `applied_filters` echoes only user-supplied
flags (`buildAppliedFilters`, `src/commands/tasks/list.ts:212`), so a consumer can observe
`"due_date"` only in response to its own `--order-by due_date`. No existing caller's payload changes.
Same reasoning spec 0060's changeset used. The changeset must state this explicitly.

## Edge cases

1. **`--order-by due_date` alone, per-tasklist route** → `order_by=due_date`, no `order` param
   (0060 default suppressed for both halves). Test.
2. **`--order-by due_date` on `/all-tasks`** → forwarded verbatim; no `order_by` default exists on
   that route in the CLI. Test.
3. **Invalid value still rejected** → `--order-by due` / `--order-by duedate` must still throw
   `ValidationError`, **exit 2**, and the error message must now enumerate five values. Test, with an
   explicit exit-code assertion (calibration #2 — no such test exists today for this flag).
4. **Null-due tasks** sort last, server-side. Not reconstructable client-side and not something the
   CLI enforces or verifies — documentation only. The CLI never re-sorts.
5. **`--order-by due_date --all`** → pagination unaffected; the contract's "tie-broken by task id"
   note is what makes page boundaries stable on `/all-tasks`. No client-side change.
6. **Help text / introspect.** `--order-by`'s description string enumerates the values, so it changes.
   `freelo --introspect` emits it. `README.md` does not enumerate per-command options, so
   `pnpm check:readme` is expected to be unaffected — **verify by running it**, do not assume.

## Non-goals

- Not widening any other command's `--order-by` (`comments list` keeps `date_add|date_edited_at`;
  its contract enums at lines 208/298/458/544/1342/3270 did not change).
- Not client-side sorting, and not normalizing the server's null-last placement.
- Not changing the `priority` default on the per-tasklist route (that is spec 0060's, shipped).
- Not a live-API verification of the sort semantics. `allowNetwork: false` for this run; the behavior
  is documented upstream and the CLI does not depend on it being true — we forward a string and
  render what comes back. The docs attribute the semantics to Freelo rather than asserting them as
  CLI behavior.

## Open questions

None. The roadmap's single open question (does `/all-tasks` also carry `due_date`?) was resolved by
direct contract read at triage: yes.

---

## Plan

**No new dependencies.** No new files under `src/`.

### Files to modify

| # | File | Intent |
|---|---|---|
| 1 | `src/api/schemas/task.ts` | Add `TASK_ORDER_BY_VALUES` (frozen `as const` tuple of the five values) + `TaskOrderBy` derived type; retype `AppliedFilters.order_by` to `TaskOrderBy`. Single source of truth. |
| 2 | `src/api/tasks.ts` | Retype `AllTasksFilters.orderBy` (line 51) and `TasklistTasksOpts.orderBy` (line 126) to `TaskOrderBy`. |
| 3 | `src/commands/tasks/list.ts` | Retype `ListOpts.orderBy` (63) to `TaskOrderBy`; feed `TASK_ORDER_BY_VALUES` to `parseEnumFlag` (280); widen the `--order-by` help string (276). |
| 4 | `docs/commands/tasks-list.md` | Synopsis (17), Options table row (60), and §Ordering (67-98): new value + null-last / all-day-00:00 semantics, per route. |
| 5 | `test/commands/tasks/list.test.ts` | New cases 4d/4e/4f (see below). |
| 6 | `.changeset/<name>.md` | `minor`, `feat(commands):`, with the explicit no-envelope-bump note. |

Decision (logged): introduce **one** exported const rather than repeating the five-literal union in
five places. Rationale in `docs/decisions/`. House precedent exists at
`src/commands/comments/list.ts:59` (`ORDER_BY_VALUES`); this hoists the same pattern to the schema
module because three modules need it, not one.

### Test strategy

All integration-level, MSW-mocked, in the existing `test/commands/tasks/list.test.ts` (numbering
continues the 0060 block so the ordering story reads top-to-bottom):

- **4d.** `--project 42 --tasklist 101 --order-by due_date` → URL contains `order_by=due_date`, does
  **not** match `/[?&]order=/`, does not contain `order_by=priority`; `applied_filters.order_by ===
  'due_date'`, no `order` key. (Pins edge case 1 + the 0060 interaction.)
- **4e.** `--order-by due_date --order asc` with no project/tasklist → `/all-tasks` receives
  `order_by=due_date&order=asc`; both echoed in `applied_filters`. (Pins edge case 2 — the
  `/all-tasks` half of the widening, which is the part the roadmap wasn't sure about.)
- **4f.** `--order-by duedate` → `exitCode` **2**, error `code === 'VALIDATION_ERROR'`, message
  enumerates all five accepted values including `due_date`. (Calibration #2: exit-code assertion on
  the error path; also guards the help/error copy against drifting out of sync with the enum.)

No new MSW handlers or fixtures — cases 4d/4f reuse `tasklist-tasks.json` and the existing per-test
`server.use` override pattern; 4e reuses the `/all-tasks` fixture already used by case 4c.

No new `try/catch` and no new error-path branches are introduced, so calibration #4 (coverage drift)
does not apply. Branch coverage should be neutral-to-up: 4f covers the `parseEnumFlag` throw arm for
this flag, which is currently uncovered.

### Rollout order

Single landable slice — steps 1-3 must land together (`tsc` won't compile otherwise), and 4-6 in the
same PR. No staging needed.

### Gates before push (calibration #3, run on the committed tree)

`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`
plus `pnpm test:cov` for the branch-coverage threshold that plain `pnpm test` does not enforce.
