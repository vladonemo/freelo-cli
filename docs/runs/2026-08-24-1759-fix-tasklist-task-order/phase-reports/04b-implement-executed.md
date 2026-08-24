# Phase 4 — Implement (executed after resume)

**Status:** complete
**Source files changed:** 1 (`src/api/tasks.ts`)
**Contract files changed:** 1 (`docs/api/freelo-api.yaml`)
**Retries:** 1 (lint — `@typescript-eslint/no-unnecessary-type-assertion` on two redundant
`as const` suffixes; fixed by deleting them, `const` already narrows a string literal)

## What landed

**`src/api/tasks.ts` — `getTasklistActiveTasks` (TODO-1).**

```ts
if (opts.orderBy === undefined && opts.order === undefined) {
  params['order_by'] = TASKLIST_TASKS_DEFAULT_ORDER_BY; // 'priority'
  params['order'] = TASKLIST_TASKS_DEFAULT_ORDER;       // 'asc'
} else {
  if (opts.orderBy !== undefined) params['order_by'] = opts.orderBy;
  if (opts.order !== undefined) params['order'] = opts.order;
}
```

Deviation from the plan's literal text, per decision 4: the plan proposed `opts.orderBy ?? 'priority'`
per half; the implementation gates on **both** being absent. Rationale in decision 4 — defaulting a
direction the user never chose is a second, unrequested behavior change.

The `qs.length > 0` ternary on the path was collapsed as planned. Every branch above writes at least
one parameter, so `qs` can no longer be empty and the second arm would have been permanently
uncovered (calibration entry #4).

The two default values are named exports so the intent is greppable and a future test or caller
can't drift from them.

JSDoc records what `priority` means on this endpoint, the name collision with `priority_enum`, the
live evidence, and the partial-supply rule.

**`src/commands/tasks/list.ts` — untouched** (TODO-2 dropped, decision 4 / §8b). `buildAppliedFilters`
and the call site are unchanged, so `freelo.tasks.list/v1` is byte-identical for every existing
caller. No `/v2` bump, no envelope callout needed in the changeset beyond stating the non-change.

**`docs/api/freelo-api.yaml` — `order_by` / `order` on this path (TODO-3, amended by decision 5).**
`default: priority` was confirmed correct and left alone; the missing `description` was added.

## Gates

`pnpm typecheck` clean · `pnpm lint` clean (after the one retry) · `pnpm format:check` clean for
every file this run touched. Two files fail `format:check` on `main` already
(`docs/commands/custom-fields-rename.md`, `scripts/check-readme.mjs`) — pre-existing, not in CI, not
touched here.

## Budget at end of phase

Agent invocations: 0 sub-agent dispatches (see `summary.md` §Run mechanics — no dispatch tool was
available in the resumed session; phases were executed inline against each agent's checklist).
Files touched so far: 4 source/doc + run artifacts. No new dependencies.
