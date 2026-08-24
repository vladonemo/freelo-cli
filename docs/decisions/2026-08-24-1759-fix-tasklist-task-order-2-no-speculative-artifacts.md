# Decision 2 — Write no artifact that encodes the unverified ordering semantics

**Run:** 2026-08-24-1759-fix-tasklist-task-order
**Phase:** 2 — Spec
**Agent:** architect (executed inline by orchestrator)

**Question:** The spec phase could have produced three plausible-looking artifacts without any live
evidence — a corrected `default:` in `docs/api/freelo-api.yaml`, an MSW handler that sorts its
response by query string, and a test asserting board order from a hand-ordered fixture. Should any
of them be written?

**Decision:** None of the three. Specifically: (a) leave `docs/api/freelo-api.yaml:1386`
`default: priority` untouched; (b) leave `tasklistTasksOk` (`test/msw/handlers.ts:600-607`)
query-blind; (c) write no test that asserts response *order*, only tests that assert the *request*
the client emits.

**Alternatives considered:**

- Correct the yaml default to `date_add` on the strength of the field report and this repo's
  three prior doc-vs-live divergences (`MinutesSchema`, `CurrencySchema.amount`, comment-file `id`).
- Teach the MSW handler to honour `order_by` so the fix is "covered" by a test.
- Ship the fix with a fixture hand-ordered to look like board order.

**Rationale:** Each would convert a hypothesis into a repo artifact that subsequent readers and CI
would treat as established fact — the yaml is cited as authority by the architect and
`freelo-api-specialist` agents, and a query-aware mock would "prove" the guessed semantics in green
CI forever. Editing the yaml would also destroy the only written record of what Freelo *claims*,
which is half the evidence in the OQ-1 comparison. The spec's §4 analysis was strengthened instead:
noting that `TaskSummary` exposes no ordering field at all (`freelo-api.yaml:5244-5298`), that
Freelo's own task vocabulary uses "priority" for the L/M/H `priority_enum` (`:1735-1739`), and that
no endpoint anywhere reorders tasks within a tasklist — which together promote the issue's
hypothesis 3 from a footnote to a leading candidate (spec §4.4, OQ-2).
