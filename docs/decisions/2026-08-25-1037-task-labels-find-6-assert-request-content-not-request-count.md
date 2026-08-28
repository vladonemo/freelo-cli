# Decision 6 — Query-param tests assert request *content*, not request *count*

**Run:** 2026-08-25-1037-task-labels-find
**Phase:** test
**Agent:** orchestrator (test-writer mandate)

**Question:** Two tests asserted `expect(seen).toHaveLength(1)` on a capturing MSW handler and failed with 2. Is the command issuing a duplicate request?

**Decision:** No — it's a harness artifact. Rewrote both tests to assert that *every* captured request has the correct pathname and query string, dropping the count assertion.

**Alternatives considered:**

- `toHaveLength(2)`. Rejected: hard-codes an incidental harness behavior into an assertion that would break the moment MSW or undici changes, and it documents nothing about the command.
- Investigate and fix the duplicate at the client layer. Rejected after evidence showed there is nothing to fix in `src/api/client.ts`: its `attempt` loop issues exactly one `fetch` and only re-attempts on 429.
- Drop the query-param tests entirely. Rejected: they're the tests that prove `/task-labels/find-available` — not the `/project-labels/find-available` sibling — is the endpoint being called, which is the single most likely wiring mistake in this slice.

**Rationale:** Reproduced the same doubling on the **pre-existing** `freelo labels list` path with a hand-rolled capturing handler: 2 captured requests there too, on code this run never touched. So the duplication predates this change and lives in the MSW/undici test interception layer, not in the command. Asserting the count would be testing the harness; asserting that every outbound request carries the right path and the right (or absent) `project_id` still fully guards the wiring. The `toHaveLength(0)` assertions in the flag-validation tests are kept — "no request at all" is a real property of the command, not a harness artifact.

**Follow-up candidate (not actioned here):** worth a standalone look at why GET resolvers fire twice under this harness, since it silently doubles the request count in every MSW-backed GET test in the repo. Out of scope for a Yellow feature slice.
