# Triage — 2026-08-24-1759-fix-tasklist-task-order

**Tier:** Red
**Commit type:** fix

## Summary

`freelo tasks list --project <p> --tasklist <t>` (route `tasklist-tasks` →
`GET /project/{p}/tasklist/{t}/tasks`) sends **no** `order_by` / `order` query parameter when the
user omits `--order-by` / `--order`, so result ordering is delegated to whatever the live Freelo
server does by default. The reporter observes creation-date (`date_add`) order where the tasklist's
manual/drag-and-drop order was expected. The cached OpenAPI contract
(`docs/api/freelo-api.yaml:1381-1386`) says this endpoint's default is `priority`, which
**contradicts** the observed live behavior.

## Signals

- [x] Touches `src/commands/` (behavior of an existing subcommand — `tasks list`)
- [x] Touches `src/api/` (`src/api/tasks.ts` — `getTasklistActiveTasks`)
- [ ] Touches `src/config/`
- [ ] Touches `src/api/client.ts` or HTTP defaults
- [ ] Touches auth flows
- [ ] Adds a dependency
- [ ] Removes a dependency
- [ ] Changes an envelope schema (`freelo.*/vN`) — *see note below; a fix may add a field to
      `applied_filters`, which would be an additive change*
- [ ] Changes exit codes
- [ ] Removes/renames an existing flag
- [x] Requires the Freelo API
- [x] **Changes the default observable output of an already-released command**
- [ ] Docs-only

## Route flags

```
requiresFreeloApi: true
needsSecurityReview: false
preApprovedDeps: []
allowNewDeps: false
allowNetwork: false          # hard gate — no live API call permitted this run
```

## Rationale

Two independent Red triggers, and the highest tier wins:

1. **The cached OpenAPI contract contradicts the field report.** `freelo-api.yaml:1381-1386`
   declares `order_by` default `priority` for exactly this endpoint. The bug report says the live
   server returns `date_add` order. Per `autonomous-sdlc.md` §Failure modes, *"Spec says something
   the OpenAPI spec contradicts → Pause — Freelo's contract is authoritative."* Deciding which of
   the two is right is precisely *"API behavior not in `docs/api/freelo-api.yaml` → **Pause**
   (don't guess the API)"* — the doc has an answer, but that answer is under active dispute, so it
   is functionally not-covered.
2. **Changing the default ordering of an already-released command is a behavior change to a public
   contract.** `freelo tasks list` is shipped. Agents scripting against it may (unwisely, but
   really) depend on today's ordering. `autonomous-sdlc.md` §Autonomous decisions vs. pauses lists
   *"Breaking behavior of an existing command → **Pause**"*.

Note this is **not** a pause-at-triage Red. The requirement's scope and success criterion are
unambiguous ("tasks come back in the tasklist's manual order"). The blocker is downstream — an
unverifiable fact about the live API — so per the orchestrator's rule the run proceeds through
spec and plan and pauses at the implement gate, not at intake.

## Open concerns for the architect

1. **Blast radius is genuinely narrow.** `getTasklistActiveTasks` has exactly one caller
   (`src/commands/tasks/list.ts:411`) on exactly one route (`resolveRoute` → `tasklist-tasks`,
   requiring exactly one `--project` + one `--tasklist` and no other filter). `/all-tasks` is a
   separate function with its own documented default (`date_add`,
   `freelo-api.yaml:1482-1487`) and is explicitly **out of scope**.
2. **The bug is not reproducible in the MSW suite.** `test/msw/handlers.ts:600-607`
   (`tasklistTasksOk`) ignores the query string entirely and echoes the fixture array. A test can
   therefore prove *what query string the client sends*, but can never prove *what the server does
   with it*. The architect must be explicit that the testable assertion is request-shape, not
   response-order.
3. **The response schema carries no ordering field.** `TaskSummarySchema`
   (`src/api/schemas/task.ts:70-87`) exposes no `priority` / `order` / `position` key (it is
   `.passthrough()`, so one may exist on the wire but is undeclared). There is no client-side way
   to detect or re-sort into manual order. Any fix must be server-side-requested.
4. **Hypothesis 3 from the issue is unfalsifiable offline.** If `order_by=priority` does not in
   fact mean "manual/drag-and-drop order", the correct output of this run is a docs change plus an
   upstream question to Freelo, not a code change. The architect must carry this as an Open
   question rather than assume it away.
5. **Envelope impact.** If the fix sends a default `order_by`, the architect must decide whether
   `applied_filters.order_by` echoes the injected default or continues to echo only user-supplied
   flags. Echoing the injected default is an additive-value change to an existing optional field
   (not a schema break) but changes observable JSON for existing agent callers — call it out.

## Recommended branch name

`fix/tasklist-task-order`

---

```
TRIAGE run=2026-08-24-1759-fix-tasklist-task-order tier=Red type=fix flags=[requiresFreeloApi,behaviorChangeExistingCommand,openApiContradictsReport,networkBlocked]
```
