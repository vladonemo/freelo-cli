# Decision 1 — Hoist the `--order-by` value list to one exported const

**Run:** 2026-08-25-0909-tasks-list-order-by-due-date
**Phase:** plan / implement
**Agent:** orchestrator (acting as architect + implementer; sub-agent delegation unavailable this session)

**Question:** The five-literal `order_by` union appears in five places across three modules. Repeat
the widening in each, or introduce a single source of truth?

**Decision:** Added `TASK_ORDER_BY_VALUES` (a frozen `as const` tuple) and the derived
`TaskOrderBy` type to `src/api/schemas/task.ts`, and pointed all five sites at it —
`ListOpts.orderBy`, the Commander `parseEnumFlag` allow-list, the `--order-by` help string,
`AllTasksFilters.orderBy`, and `TasklistTasksOpts.orderBy`. The help text is now interpolated
(`` `Order results by: ${TASK_ORDER_BY_VALUES.join(', ')}.` ``) rather than hand-written.

**Alternatives considered:**

- Repeat the five literals in all five spots (smallest diff, matches what's there today).
- Put the const in `src/commands/tasks/list.ts` and import upward from `src/api/`.
- Derive it from a zod enum.

**Rationale:** Four of the five sites are compile-time only; exactly one (`parseEnumFlag`) is the
runtime gate, and the help string was a third, independent copy that could silently drift from both.
Hoisting makes drift impossible and makes the next widening a one-line change. House precedent
exists (`src/commands/comments/list.ts:59` `ORDER_BY_VALUES`); this puts it in the schema module
instead of the command module because three modules consume it and `src/api/` must not import from
`src/commands/`. A zod enum was rejected as overkill — nothing here parses an API response; these
are input types and an echo.
