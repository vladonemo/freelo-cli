# 0060 — `tasks list` per-tasklist route does not request an explicit order

**Status:** Implemented — §11 resolved by live verification (see §12); Option A taken
**Run:** 2026-08-24-1759-fix-tasklist-task-order
**Issue:** [#108](https://github.com/vladonemo/freelo-cli/issues/108)
**Type:** fix
**Changeset:** `patch`
**Risk tier:** Red (PR stops for human review — no auto-merge)

---

## 1. Problem

`freelo tasks list --project <p> --tasklist <t>`, with no `--order-by` / `--order`, returns tasks
in creation order (`date_add` ascending) rather than the tasklist's manual / drag-and-drop order
visible on the Freelo web board.

The user-visible consequence: an agent or human mirroring a Freelo tasklist into a terminal view
gets a different ordering than the board shows, with no flag that obviously fixes it and no
indication in the envelope that any ordering was applied at all.

## 2. Where it comes from

`src/api/tasks.ts:132-142`:

```ts
const params: Record<string, string | number | boolean | readonly (string | number)[] | undefined> = {};
if (opts.orderBy !== undefined) params['order_by'] = opts.orderBy;
if (opts.order !== undefined) params['order'] = opts.order;
const qs = buildQuery(params);
const path =
  qs.length > 0
    ? `/project/${opts.projectId}/tasklist/${opts.tasklistId}/tasks?${qs}`
    : `/project/${opts.projectId}/tasklist/${opts.tasklistId}/tasks`;
```

When the user omits both flags, `params` is empty, `qs` is empty, and the request goes out as a
bare path. **The CLI expresses no ordering preference at all** — the result order is whatever the
live server does in the absence of the parameter.

Caller: `src/commands/tasks/list.ts:411-417`, reached only via `resolveRoute()` →
`'tasklist-tasks'` (`src/commands/tasks/list.ts:165-191`), which requires exactly one `--project`,
exactly one `--tasklist`, and none of the eleven filters the endpoint can't honor.

## 3. Blast radius

| Surface | In scope? | Why |
|---|---|---|
| `getTasklistActiveTasks` / route `tasklist-tasks` | **Yes** | The only code path affected |
| `getAllTasks` / route `all-tasks` | **No** | Separate function, separate endpoint. Its documented default *is* `date_add` (`docs/api/freelo-api.yaml:1482-1487`), so creation-order there is correct, documented behavior — not a bug |
| `tasklist-finished-tasks` | **No** | Route still deferred (spec 0017 OQ #4); not implemented |
| Envelope schema `freelo.tasks.list/v1` | **Field-compatible** | No field added, removed, renamed, or retyped. `applied_filters.order_by` / `.order` are already-declared optional fields (`src/api/schemas/task.ts` `AppliedFilters`). At most their *value* changes on an invocation that previously omitted them — additive-value, not a schema break. No `/v2` bump |

## 4. What the cached API contract actually says

This is the crux, and the contract does **not** settle it.

**4.1 The documented default for this endpoint is `priority`.** `docs/api/freelo-api.yaml:1381-1386`:

```yaml
- name: order_by
  in: query
  schema:
    type: string
    enum: [priority, name, date_add, date_edited_at]
    default: priority
```

Note the parameter carries **no `description`** here. Compare `GET /projects`
(`freelo-api.yaml:166-172`), where the identically-named parameter is described only as
`"Order column"` — equally uninformative about semantics.

**4.2 The reported live behavior contradicts 4.1.** The issue reports creation-date order from an
invocation that sends no `order_by`. If the server truly defaulted to `priority`, and if `priority`
meant manual order, the reporter would have seen board order.

**4.3 `TaskSummary` does not expose any ordering field.** `freelo-api.yaml:5244-5298` — the
documented `TaskSummary` properties are `id`, `name`, `date_add`, `date_edited_at`, `due_date`,
`due_date_end`, `count_comments`, `count_subtasks`, `author`, `worker`, `labels`,
`parent_task_id`, `total_time_estimate`, `users_time_estimates`. **There is no `priority`,
`position`, `order`, or `sort` key.** `TaskSummarySchema` (`src/api/schemas/task.ts:70-87`)
mirrors this exactly, and is `.passthrough()` — so an undeclared key *could* be arriving on the
wire, but nothing in the contract says so.

Consequence: **there is no documented way to verify, client-side, what order the server applied**,
and no way to re-sort into manual order locally. Any fix must be a server-side *request*.

**4.4 Freelo has a distinct, unrelated "priority" concept on tasks — and this materially raises
the odds on hypothesis 3.** `POST /task/{id}` accepts `priority_enum`
(`freelo-api.yaml:1735-1739`): *"Allowed options are l, m, h. Set to null to remove priority."*
`priority_enum` also appears on the `TaskDetail`-family response schemas (`:5341`, `:5385`,
`:5434`, `:5491`). So in Freelo's own vocabulary, **"priority" on a task means Low/Medium/High**,
not board position.

The issue's hypothesis 3 ("`order_by=priority` may not mean manual order at all") is therefore not
a long-shot caveat — it is the reading most consistent with the rest of the documented model.
`order_by=priority` plausibly sorts by the L/M/H field. If so, `order_by=priority&order=asc` would
not fix the bug; it would replace creation order with priority-bucket order, which is *also* not
board order, and is arguably a worse default.

**4.5 The API documents no way to read or write manual order.** A grep of the full spec for
`position` / `reorder` / `drag` / `sort_order` returns nothing task-related. The only task-movement
endpoint is `POST /task/{task_id}/move/{tasklist_id}` (`freelo-api.yaml:1842`), which moves a task
*between* tasklists and takes no position argument. There is no documented endpoint to reorder
tasks *within* a tasklist. If the API cannot express manual order on the write side, it is an open
question whether it can express it on the read side.

**Net:** the four hypotheses below are all live, and the cached contract cannot discriminate
between them.

| # | Hypothesis | Supporting evidence | Contradicting evidence |
|---|---|---|---|
| H1 | Live default is `date_add`; doc's `default: priority` is wrong | Reported symptom; this repo has hit doc-vs-live divergence 3× before (`MinutesSchema` `src/api/schemas/task.ts:29-39`, `CurrencySchema.amount` `:256-264`, comment-file `id` in #105) | The doc explicitly says `priority` |
| H2 | Live default *is* `priority`, but `priority` ≠ manual order | §4.4 — `priority_enum` is L/M/H; §4.3 — no position field exists | Would require the reported order to coincidentally look like `date_add` order |
| H3 | The API has no way to request manual order at all | §4.3 + §4.5 — the concept is absent from the read and write model alike | Freelo's own board must persist it somehow |
| H4 | `priority` *is* the internal board-position column, and the live default silently differs | The enum lists `priority` first, which is where a positional column would naturally sit | §4.4 name collision |

**H1 and H2 imply different fixes. H3 implies no code fix at all — it implies a documentation
change plus an upstream question to Freelo. One live request discriminates between all four.**

## 5. Why this is not resolvable offline

**5.1 Static analysis cannot reach it.** The behavior in question is entirely server-side. Nothing
in `src/` decides the order.

**5.2 The MSW suite structurally cannot reproduce it.** `test/msw/handlers.ts:600-607`:

```ts
tasklistTasksOk(projectId, tasklistId, items) {
  return http.get(`${API_BASE}/project/${projectId}/tasklist/${tasklistId}/tasks`, () =>
    HttpResponse.json(items),
  );
}
```

The handler takes no `{ request }` argument and never reads the query string. It returns the
fixture array verbatim, in fixture order, for every query. A mock cannot be authority on a real
server's default — writing one that returns "board order" for `order_by=priority` would be
**encoding the guess we are trying to avoid making**, and would then "prove" it in CI forever.

**The only assertion MSW can honestly make is about the request the client emits, never about the
order the server returns.** The plan in §9 is written accordingly.

**5.3 A live check is blocked this run.** `allowNetwork: false`.
`.claude/docs/autonomous-sdlc.md` §What never runs autonomously: *"Real Freelo API calls against
production data — autonomous runs use MSW for tests and the cached OpenAPI spec for design. A
real-API call requires `--allow-network` plus a dedicated test account."* No `--allow-network` was
passed and no test account was nominated.

## 6. Proposal — deferred, pending §11

No CLI surface change is proposed unconditionally. Which of §11's options is chosen determines
whether there is a proposal at all. Under **Option B** (the only option that produces code), the
change is:

**6.1 Behavior.** On route `tasklist-tasks` only, when the user supplies neither `--order-by` nor
`--order`, the CLI sends `order_by=priority&order=asc` explicitly instead of sending nothing.

**6.2 Rationale for B being no-regret on the *request* axis.** `priority`/`asc` is what
`freelo-api.yaml:1381-1390` declares the server default to be. Sending it explicitly is, per the
contract, a no-op — the request asks for exactly what it would have got by omission. What it buys
is **determinism**: output stops depending on an unstated server default that can change without a
release on our side.

**6.3 What B explicitly does not claim.** B does **not** assert that the resulting order is the
board's manual order. If H2 or H3 holds, B makes output deterministic **without fixing the reported
bug**, and issue #108 must stay open pending §11 Option A. This distinction must survive into the
changeset and PR body — shipping B as "fixes #108" would be false.

**6.4 No flag changes.** No new flag, no renamed flag, no changed enum. `--order-by` /
`--order` keep their current values and meanings, and an explicit user value still wins.

**6.5 Example invocations.**

Human TTY, default (the reported repro):

```bash
freelo tasks list --project 42 --tasklist 101
# wire, before: GET /v1/project/42/tasklist/101/tasks
# wire, after:  GET /v1/project/42/tasklist/101/tasks?order_by=priority&order=asc
```

Agent-style, default:

```bash
FREELO_API_KEY=... FREELO_EMAIL=... freelo tasks list --project 42 --tasklist 101 --output json
```

User override — unchanged in both directions:

```bash
freelo tasks list --project 42 --tasklist 101 --order-by date_add --order desc
# wire: GET /v1/project/42/tasklist/101/tasks?order_by=date_add&order=desc
```

Error path — unchanged:

```bash
freelo tasks list --project 42 --tasklist 101 --order-by nope
# stderr: VALIDATION_ERROR, exit 2, hint_next: "--order-by valid values: priority, name, date_add, date_edited_at."
# (src/commands/tasks/list.ts:143-150 parseEnumFlag; unchanged by this spec)
```

## 7. Error cases

None added. This change introduces no new failure mode: it adds two query parameters whose values
are drawn from the documented enum and are already reachable today via explicit flags. Existing
error behavior on this route (`401` → `FreeloApiError` exit 4, `404` ACL-filtered tasklist →
`FreeloApiError` exit 4, `--order-by <invalid>` → `ValidationError` exit 2, `--cursor <n≠0>` →
`ValidationError` exit 2) is untouched.

## 8. Envelope impact — a real decision inside Option B

`applied_filters` currently echoes **only what the user passed** (`src/commands/tasks/list.ts:197-215`;
`buildAppliedFilters` writes `order_by` / `order` only when `opts.orderBy` / `opts.order` are
defined). If B injects a default, there are two coherent treatments:

- **8a. Echo the injected default.** `applied_filters.order_by: "priority"` appears on invocations
  that previously omitted it. Pro: the envelope truthfully describes the request that was sent —
  which is the whole point of `applied_filters` on an agent-first CLI. Con: existing agents that
  branch on `'order_by' in applied_filters` to mean "user passed a sort flag" change behavior.
- **8b. Keep `applied_filters` user-only.** The wire gets the default, the envelope stays byte-identical
  for existing callers. Pro: zero observable change for existing consumers. Con: the envelope now
  under-reports the request — `applied_filters` stops being a faithful echo.

**Recommendation: 8a**, on the grounds that `applied_filters` exists to tell an agent what actually
happened, and silently sending an unlisted sort parameter is the same class of opacity this fix is
trying to remove. But this is a **user-visible envelope-value change on an already-released
command**, so per `autonomous-sdlc.md` §Autonomous decisions vs. pauses it is not the orchestrator's
call to make alone. It rides along with the §11 decision.

## 9. Test strategy — and its hard ceiling

**Provable in MSW (request shape).** Using the URL-capture pattern already established at
`test/commands/tasks/list.test.ts:234-267`:

1. No `--order-by` / `--order` → captured URL contains `order_by=priority` **and** `order=asc`
   (new; currently the URL has no query string at all).
2. `--order-by name --order desc` → captured URL contains `order_by=name`, `order=desc` and **not**
   `order_by=priority`. (Regression guard: the default must never override an explicit flag.)
3. `--order-by name` alone → `order_by=name`; assert the chosen behavior for the unsupplied `order`
   half (see plan TODO-4 — partial-supply is an undecided sub-case).
4. `/all-tasks` route with no order flags → captured URL still contains **no** `order_by`
   (proves the change is scoped to `tasklist-tasks` and did not leak into `filtersForAllTasks`).
5. `applied_filters` assertion matching whichever of §8a / §8b is chosen.

**Not provable in MSW, at any effort.** That the returned order is the board's manual order. See
§5.2. No test will be written that pretends otherwise, and the plan must not smuggle one in via a
hand-ordered fixture.

**Coverage.** The change is a handful of lines in one function plus its caller; the tests above
keep `src/api/tasks.ts` and `src/commands/tasks/list.ts` at their current branch coverage. No new
`try`/`catch` arms, so calibration-log entry #4 does not apply.

## 10. Non-goals

- Changing `/all-tasks` ordering or its default (§3).
- Adding client-side re-sorting of tasks (impossible — §4.3, no ordering key in the response).
- Adding a new `--order-by` enum value such as `manual` or `board` (would be inventing wire
  vocabulary — exactly the guessing this run must not do).
- Implementing the `tasklist-finished-tasks` route.
- Any change to `docs/api/freelo-api.yaml`'s `default: priority` line. Correcting the cached
  contract requires the same live evidence as the code fix, and editing it on suspicion would
  destroy the only written record of what Freelo claims.

## 11. Open questions — **all blocking**

**OQ-1 (blocking). What does the live endpoint actually return when `order_by` is omitted?**
Discriminates H1 from H2/H4. Requires one authenticated GET.

**OQ-2 (blocking). What does `order_by=priority` sort by — board position, or the L/M/H
`priority_enum`?** Discriminates H2/H3 from H1/H4, and decides whether Option B fixes #108 or
merely makes it deterministic (§6.3). §4.4 makes the L/M/H reading materially plausible.

**OQ-3 (blocking, contingent). If OQ-2 says `priority` is not board order: is there any
`order_by` value that yields board order — and if not, is the correct output of this issue a
documentation change plus an upstream question to Freelo?** §4.5 suggests manual order may not be
in the API's model at all.

Three open questions is the architect's hard cap in autonomous mode
(`.claude/agents/architect.md`: *"three open questions in one spec = pause the run"*), and they are
independently blocking. Combined with *"Freelo API behavior not covered by `docs/api/freelo-api.yaml`
→ pause. Never guess API shape."*, this spec **cannot** proceed to implementation on this run's
parameters.

**Resolution paths are enumerated in `docs/runs/2026-08-24-1759-fix-tasklist-task-order/pause.md`.**

### The one experiment that closes all three

On a tasklist with at least one task manually dragged out of creation order, and with the board
order recorded by hand first:

```bash
BASE=https://api.freelo.io/v1
UA='freelo-cli-issue-108 (you@example.com)'
P=<project_id>; T=<tasklist_id>

for q in "" "?order_by=priority&order=asc" "?order_by=date_add&order=asc"; do
  echo "=== ${q:-<no query>}"
  curl -sS -u "$FREELO_EMAIL:$FREELO_API_KEY" -H "User-Agent: $UA" \
    "$BASE/project/$P/tasklist/$T/tasks$q" \
  | jq -r '.[] | "\(.id)\t\(.date_add)\t\(.name)"'
done
```

Also worth capturing once, to settle §4.3 — whether an undeclared ordering key rides along on the
wire (`TaskSummarySchema` is `.passthrough()`, so one would currently be invisible):

```bash
curl -sS -u "$FREELO_EMAIL:$FREELO_API_KEY" -H "User-Agent: $UA" \
  "$BASE/project/$P/tasklist/$T/tasks" | jq '.[0] | keys'
```

Reading the result:

| Observation | Conclusion |
|---|---|
| no-query order == `date_add` order, and `priority` order == board order | **H1.** Doc's default is wrong; Option B is a true fix. Correct `freelo-api.yaml:1386` in the same PR |
| no-query order == `priority` order, and neither is board order | **H2.** Option B is determinism-only; #108 stays open on OQ-3 |
| no `order_by` value reproduces board order | **H3.** No code fix. Ship a docs note + raise with Freelo |
| no-query order != `priority` order, but `priority` order == board order | **H4.** Doc's default is wrong; Option B is a true fix |
| `keys` includes an undeclared positional field | Re-open §4.3 — client-side ordering may become possible; declare the field in `TaskSummarySchema` |

Capture the raw responses as a fixture under `test/fixtures/` (scrubbed) so the next run has
evidence rather than hypotheses — the precedent is spec 0059's live repro (§2 of that spec).

---

## 12. Resolution of §11 — live verification (2026-08-24)

Option **A** was taken. The human granted a dedicated test account and the coordinating session ran
the §11 experiment out-of-band (no code in this repo made the calls; the key was rotated afterwards).
Project/tasklist ids and raw bodies are deliberately not reproduced here — the account's content was
disposable onboarding-template data and carries no evidence value. The full verbatim answer is in
`docs/runs/2026-08-24-1759-fix-tasklist-task-order/phase-reports/04-implement-resume.md`.

**Observations**

1. No `order_by` and `order_by=priority` returned byte-identical task order.
2. After a task was dragged to the top of the board in the Freelo web UI, both re-fetches showed it
   at index 0 — it moved from index 3 to index 0 in both.
3. `order_by=date_add` returned a genuinely different, distinct order in both pulls.

**Answers**

| OQ | Question | Answer |
|---|---|---|
| OQ-1 | What does the live endpoint return with no `order_by`? | Identical to `order_by=priority` — the doc's `default: priority` is accurate. **H1 refuted.** |
| OQ-2 | What does `order_by=priority` sort by? | The tasklist's manual / drag board order. **H2 refuted** — it is not the L/M/H `priority_enum`, despite the name collision in §4.4. |
| OQ-3 | Is there any `order_by` value that yields board order? | Yes — `priority`. **H3 refuted.** |

**Consequences for the rest of this spec**

- §6.3 no longer applies. This is a **correctness** fix, not determinism-only: the changeset and PR
  say *fixes #108*. **H4 is the closest surviving reading**, minus the "default silently differs"
  half — `priority` is the board-position column *and* the live default matches the doc.
- §10's non-goal "no change to `freelo-api.yaml`" is **lifted for the `description` only**. The
  `default:` line was empirically confirmed correct and is left as-is; what the experiment added is
  the missing *meaning* of `priority`, which is now recorded on the parameter (TODO-3, amended).
- §8's 8a/8b choice and TODO-4 were framed as Option-B-only sub-decisions. They still have to be
  answered by an Option-A implementation; the human delegated both back to the orchestrator. See
  decision 4 — **8b** (`applied_filters` stays user-only) and **partial supply injects nothing**.
- §4.3 stands: no undeclared ordering key was observed to be worth declaring, and no client-side
  re-sort is possible. `TaskSummarySchema` is unchanged.

### 12.1 Out of scope, flagged for a later human decision

The reported symptom only reproduces on the exact route `/project/{p}/tasklist/{t}/tasks` — that
is, `--project` **and** `--tasklist`, and no other filter. Any other invocation shape (`--tasklist`
alone, or any added filter) falls through to `/all-tasks` via `resolveRoute()`
(`src/commands/tasks/list.ts:165-191`), which defaults to `date_add` and has **no concept of manual
order at all**. That silent fallthrough is plausibly the real mechanism behind how #108 was noticed.
It is a routing/UX question, not an ordering bug, and this run deliberately does not touch it.

---

## Plan

**Executed on `/resume` after §12.** Slice 0 resolved out-of-band; slices 1-3 landed as described,
with TODO-2 dropped and TODO-3 amended per §12.

### Slice 0 — resolve §11 (human / networked)

- [x] **TODO-0.** Run the §11 experiment against a dedicated test account, or take the human's
      §11 decision from `pause.md`. **Gates everything below.** No new deps.
      → Done out-of-band; Option A, all three OQs answered (§12).

### Slice 1 — code

- [x] **TODO-1.** `src/api/tasks.ts` — in `getTasklistActiveTasks` (:128-152), replace the
      conditional-only parameter assembly with defaulted assembly:
      `params['order_by'] = opts.orderBy ?? 'priority'`, `params['order'] = opts.order ?? 'asc'`.
      The `qs.length > 0` branch at :139-142 becomes dead (`qs` is now always non-empty) — collapse
      it to the single template-literal form so no uncovered branch is left behind, per calibration
      entry #4's spirit. Update the JSDoc at :122-127 to state that the defaults are sent
      explicitly and **why** (deterministic output; do not rely on an unstated server default), and
      cite this spec.
      → Done, with one amendment from decision 4: the defaults are injected only when **both**
      opts are absent (not `??` per-half), so partial supply stays byte-identical to pre-0060.
      `qs` is still always non-empty in every branch, so the dead ternary was collapsed as
      planned. Values live in `TASKLIST_TASKS_DEFAULT_ORDER_BY` / `TASKLIST_TASKS_DEFAULT_ORDER`.
- [x] ~~**TODO-2.**~~ **Dropped** — §8b chosen (decision 4). `buildAppliedFilters` and
      `filtersForAllTasks` are untouched; the envelope is byte-identical for every existing caller.
      *(original text)* *(Only under §8a.)* `src/commands/tasks/list.ts` — `buildAppliedFilters` (:197-215)
      currently echoes user-supplied flags only. Make the `tasklist-tasks` route echo the effective
      values. Note `buildAppliedFilters` is shared with the `/all-tasks` route, so this must **not**
      be done inside it unconditionally — either pass an effective-defaults argument or apply the
      overlay at the `tasklist-tasks` call site (:396, :418-425). `filtersForAllTasks` (:496-514)
      must remain untouched so `/all-tasks` keeps its own documented default.
- [x] **TODO-3.** *(amended — §12.)* `docs/api/freelo-api.yaml:1381-1392` — `default: priority` was
      empirically **confirmed** and therefore left unchanged; what was added is the missing
      `description:` on `order_by` (and a one-liner on `order`), recording that `priority` is the
      manual board order and explicitly not the L/M/H `priority_enum`, with the capture date and a
      pointer to #108. This is the durable output of the experiment.
- [x] **TODO-4 (decided — decision 4).** Partial supply injects **nothing**: a default is added only
      when both flags are absent. `--order-by name` alone still sends `order_by=name` and no
      `order`, byte-identical to pre-0060. Covered by §9 test 3 (tests `4a` / `4b` in the suite).

### Slice 2 — tests

- [x] **TODO-5.** `test/commands/tasks/list.test.ts` — §9 tests 1-4 added via the URL-capture
      pattern. Existing test `3.` was extended in place (no near-duplicate); new `4a` (order-by
      alone), `4b` (order alone), `4c` (`/all-tasks` leak guard); existing `4.` gained negative
      assertions that the default never overrides an explicit flag.
- [x] ~~**TODO-6.**~~ **Dropped** with TODO-2 (§8b). Instead, test `3.` asserts the *absence* of
      `order_by`/`order` in `applied_filters` — the envelope-stability guarantee, tested directly.
- [x] ~~**TODO-7.**~~ **Skipped** as permitted (cosmetic; would widen the diff into a shared handler
      used by other suites).

### Slice 3 — docs + changeset

- [x] **TODO-8.** `docs/commands/tasks-list.md` — both order rows footnoted, and a new `## Ordering`
      section explains board order, the both-flags-absent trigger, the `priority_enum` name
      collision, and why `/all-tasks` cannot offer board order.
- [x] **TODO-9.** Changeset, `patch`. §6.3 is lifted by §12, so it says **fixes #108** and states
      that the envelope is unchanged (no `applied_filters` value change under §8b).
- [x] **TODO-10.** `pnpm fix:readme` not required — no command added, removed, renamed, or
      re-described. Verified with `pnpm check:readme`.

### New dependencies

**None.**

### Gates before push

`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`, run on the
**committed** tree per calibration entry #3.
