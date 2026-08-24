# Phase 5 — Test

**Status:** complete
**Files changed:** 1 (`test/commands/tasks/list.test.ts`)
**New tests:** 3 · **Modified tests:** 2 · **Retries:** 0

## The ceiling, restated

Spec §5.2 stands: MSW cannot reproduce a server-side sort. `tasklistTasksOk`
(`test/msw/handlers.ts:600-607`) echoes its fixture array for every query string, and a handler that
returned "board order" for `order_by=priority` would be encoding the very guess the live check
replaced with evidence — then re-proving it in CI forever. **Every assertion below is about the
request the client emits, or about the envelope. None is about response order.** The evidence that
`priority` == board order lives in the live check (spec §12), the OpenAPI `description`, and the
JSDoc — not in a fixture.

## Tests

All use the URL-capture pattern already established at the old `test/commands/tasks/list.test.ts:234-267`
(inline `http.get` closing over a `capturedUrl` string).

| # | Test | Asserts |
|---|---|---|
| `3.` *(modified in place, not duplicated — TODO-5)* | `--project 42 --tasklist 101`, no order flags | URL contains `order_by=priority` **and** `order=asc`; envelope `endpoint`/`entity_shape`/`tasks`/`paging` unchanged; `applied_filters` has **neither** `order_by` nor `order` (the §8b envelope-stability guarantee, tested directly — this replaces dropped TODO-6) |
| `4.` *(extended)* | `--order-by name --order desc` | existing forwarding assertions, plus `not.toContain('order_by=priority')` / `not.toContain('order=asc')` — the default must never override an explicit flag |
| `4a.` *(new)* | `--order-by name` alone | `order_by=name` present, **no** `order=` parameter at all, no injected `priority`; `applied_filters` echoes `order_by` only |
| `4b.` *(new)* | `--order desc` alone | `order=desc` present, **no** `order_by` at all; `applied_filters` echoes `order` only |
| `4c.` *(new)* | `--project 42` (routes to `/all-tasks`) | URL contains **no** `order_by` and no `order=` — proves the default is scoped to `tasklist-tasks` and did not leak into `filtersForAllTasks` |

`4a` / `4b` also give both arms of the `else` block a covering test, so the new branching adds no
uncovered arm (calibration entry #4).

`4c` is the only one of the five that would also pass against pre-fix `main` — it is a leak guard,
by design. `3.` is the test that fails without the fix (pre-fix the URL has no query string at all).

## Not done

- **TODO-7** (promote `tasklistTasksOk` to expose a captured URL) — skipped as the plan permits.
  It is shared with other suites; rewriting it would widen the diff of a fix PR for cosmetic gain.
- No response fixture was captured from the live check (decision 5) — it would have no consumer.

## Local result

`npx vitest run test/commands/tasks/list.test.ts` → **45/45 passed** before `4b` was added, 46/46
with it; full-suite result recorded in `06-review.md` §Gates.

**Environment note, carried forward unchanged from `pause.md`:** local `pnpm test` on this machine
reports failures in `test/commands/tasks/move.test.ts` (15s `testTimeout` losing to machine load,
plus an assertion that looks like state leak from the timed-out sibling). That was already true on
this branch when the diff was docs-only and zero source files had changed, and CI is green on the
same source tree. It is **not** a result of this change and was deliberately not investigated.
