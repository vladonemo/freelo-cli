## Paused at phase 4 — Implement (before any source edit)

**Run:** 2026-08-24-1759-fix-tasklist-task-order
**Reason:** The correct fix for #108 depends on live Freelo behavior that the cached OpenAPI
contract actively contradicts, and `allowNetwork: false` forbids the one request that would settle it.
**Risk tier:** Red (expected pause — the trigger was known at triage; see decision 1)

### What happened

Triage, spec (`docs/specs/0060-tasklist-task-order.md`) and plan (§Plan of that spec) all completed.
The bug is confirmed as described: `getTasklistActiveTasks` (`src/api/tasks.ts:132-142`) sends **no**
`order_by` at all when the user omits `--order-by` / `--order`, so ordering is delegated to an
unstated server default.

What the spec phase changed is the *confidence ranking*. Issue #108 treats "the live default is
`date_add`, the doc's `priority` is stale" (H1) as most likely and "`order_by=priority` may not
mean manual order" (H3) as a caveat. Three findings from the cached contract push the other way:

1. `TaskSummary` exposes **no** ordering field — no `priority`, `position`, `order`, or `sort`
   (`docs/api/freelo-api.yaml:5244-5298`, mirrored at `src/api/schemas/task.ts:70-87`).
2. In Freelo's own vocabulary, **"priority" on a task means Low/Medium/High** — `priority_enum`,
   `'l' | 'm' | 'h'` (`docs/api/freelo-api.yaml:1735-1739`, `:5341`, `:5385`, `:5434`, `:5491`).
   So `order_by=priority` may well sort by L/M/H buckets, not board position.
3. **Nothing in the entire API reorders tasks within a tasklist.** The only movement endpoint is
   `POST /task/{task_id}/move/{tasklist_id}` (`:1842`), which moves tasks *between* tasklists and
   takes no position argument. If manual order isn't in the write model, it may not be in the read
   model either.

If that reading is right, `order_by=priority&order=asc` would replace creation order with
**priority-bucket order** — also not board order, and arguably a worse default than today's. That
possibility is what makes this a real decision rather than a formality.

### Evidence

- `src/api/tasks.ts:132-142` — `if (opts.orderBy !== undefined) params['order_by'] = opts.orderBy;`
  → empty query string on the default invocation
- `src/commands/tasks/list.ts:411-417` — the sole caller; route gated by `resolveRoute()` at `:165-191`
- `docs/api/freelo-api.yaml:1381-1386` — `default: priority`, and **no `description`** on the parameter
- `docs/api/freelo-api.yaml:1482-1487` — `/all-tasks` default is `date_add` (out of scope, correct as-is)
- `docs/api/freelo-api.yaml:5244-5298` — `TaskSummary` has no ordering field
- `docs/api/freelo-api.yaml:1735-1739` — `priority_enum`: *"Allowed options are l, m, h."*
- `test/msw/handlers.ts:600-607` — `tasklistTasksOk` takes no `{ request }`; echoes the fixture
  array for every query string. The mock is structurally incapable of catching this class of bug
- `test/commands/tasks/list.test.ts:234-267` — the URL-capture pattern that *can* test the fix
  (request shape only, never response order)

### Decision needed

**Do we spend one live API request to learn what this endpoint actually does, or ship the
determinism-only change blind?**

Concretely, three questions ride on it (spec §11): what the server returns with no `order_by`
(OQ-1); what `order_by=priority` sorts by (OQ-2); and whether *any* `order_by` value yields board
order (OQ-3). One authenticated GET against a tasklist with a manually-dragged task answers all
three — the exact commands are in spec §11 "The one experiment that closes all three".

Options:

**A. Grant `--allow-network` + a dedicated test account, then `/resume`.** — Turns #108 into a
one-line fix with evidence behind it, and produces two durable artifacts the repo doesn't have:
a corrected/annotated `order_by` entry in `freelo-api.yaml` (the 4th doc-vs-live divergence this
project has hit, after `MinutesSchema`, `CurrencySchema.amount`, and the #105 comment-file `id`),
and a scrubbed fixture under `test/fixtures/`. *Cost:* you must nominate a test account and a
tasklist with at least one manually-reordered task, and record its board order by hand first.
Roughly five minutes of setup. This is the only option that can actually **fix** the reported bug
rather than change its shape.

**B. Skip verification; default this route to `order_by=priority&order=asc` as a no-regret change.**
— Defensible on its own terms: per `freelo-api.yaml:1381-1390` this is already what the server
claims to do, so explicitly requesting it is contractually a no-op, and it removes the dependency
on an unstated default that could change without a release on our side. *But be clear on what it
buys:* determinism, not correctness. If OQ-2 resolves to "priority means L/M/H", B does not fix
#108 — it swaps one wrong order for a different wrong order, and #108 stays open. The changeset and
PR body would have to say "always sends an explicit sort order" and must **not** say "fixes #108"
(spec §6.3). Two sub-decisions come with B, both currently unresolved (decision 3): whether
`applied_filters` echoes the injected default (spec §8a vs §8b — 8a is recommended but changes
observable JSON for existing agent callers), and what happens when only one of the two flags is
supplied (plan TODO-4).

**B′. B, but scoped down to the safest reading.** — Inject the default only when **both** flags are
absent, and keep `applied_filters` user-only (§8b). Smallest observable delta; also the least
useful, since the envelope then hides the sort it just requested.

**C. Abort the run.** Leave #108 open with the spec's analysis attached as a comment. The §4
findings — especially the `priority_enum` name collision and the absence of any reorder endpoint —
are worth posting upstream to Freelo regardless of which option you pick; they may be the actual
answer.

*Orchestrator's read:* A. The gap between "makes output deterministic" and "fixes the reported bug"
is exactly the gap that one request closes, and B ships a changeset whose value proposition can't
be stated honestly until OQ-2 is answered.

### Environment note (unrelated to this issue — flagged, not acted on)

`pnpm test` on this branch — a **docs-only diff, zero source files changed** — reported
`11 failed | 3009 passed` across 8 files. This is **not** a regression from this run and **not** a
red `main`: GitHub Actions is green on `d3f34c3` (the commit this branch forks from, 2026-08-24T15:58Z),
i.e. green on a byte-identical source tree.

Re-running one affected file in isolation (`npx vitest run test/commands/tasks/move.test.ts`)
reproduces two failures locally:

- `cross-tasklist within same project` → `Error: Test timed out in 15000ms`
- `cross-project move` → `AssertionError: expected 99 to be 42` at `move.test.ts:272`
  (`from_project_id`) — plausibly cascade state-leak from the timed-out sibling in the same file

Duration was 692s wall for 4227s of test time, and 72s wall for a single 46-test file. The machine
is heavily loaded, and a 15s `testTimeout` is not surviving it. Most likely: local slowness, with a
possible test-isolation weakness exposed underneath (a timed-out test leaving MSW/handler state for
the next one). Worth a separate issue if it recurs on an unloaded machine — it is out of scope for
#108 and was deliberately not investigated further here.

### Resume with

```
/resume 2026-08-24-1759-fix-tasklist-task-order <A|B|B'|C or free-form answer>
```

If **A**, include the project id, tasklist id, and the board order you observe in the web UI, and
re-invoke with `--allow-network`.
If **B** or **B′**, also state the §8a/§8b choice and the TODO-4 partial-supply behavior, or say
"architect's call" and the recommendations in spec §8 will be taken.

---

## RESOLVED — 2026-08-24 (appended on resume; nothing above was altered)

**Answer:** **A**. The human granted a dedicated test account and the live experiment was run
out-of-band by the coordinating session (no code in this repo made the calls; the key was rotated
afterwards). All three §11 open questions are closed:

- **OQ-1** — no `order_by` returns the same order as `order_by=priority`. The doc's
  `default: priority` is accurate. **H1 refuted.**
- **OQ-2** — `order_by=priority` sorts by the tasklist's manual / drag board order, not the L/M/H
  `priority_enum`. **H2 refuted.** A task dragged to the top of the board in the web UI moved from
  index 3 to index 0 in the response.
- **OQ-3** — moot; `priority` *is* the board-order value. **H3 refuted.**

Consequence: this became a **correctness** fix, not the determinism-only change option B would have
shipped. §6.3's prohibition on saying "fixes #108" was lifted.

The verbatim human answer is in `phase-reports/04-implement-resume.md`; the analysis is in spec
§12. The two sub-decisions this report flagged as unresolved (§8a vs §8b, and TODO-4 partial supply)
were delegated back to the orchestrator and answered in
`docs/decisions/2026-08-24-1759-fix-tasklist-task-order-4-envelope-user-only-and-partial-supply.md`
— **8b** and **inject nothing on partial supply**.

The environment note above (local `pnpm test` failures) was re-confirmed unchanged at review time
and is still not a regression from this run. See `phase-reports/06-review.md` §Gates.

**Outcome:** PR https://github.com/vladonemo/freelo-cli/pull/110 — open, awaiting human review
(Red tier, no auto-merge).
