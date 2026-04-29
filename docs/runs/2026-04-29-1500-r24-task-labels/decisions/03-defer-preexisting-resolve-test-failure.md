# Decision 03 — Defer pre-existing `resolve.test.ts` failure to a separate fix

**Run:** 2026-04-29-1500-r24-task-labels
**Phase:** Local gates
**Agent:** orchestrator

**Question:** `pnpm test` on the working tree shows 1 failing test in `test/config/resolve.test.ts` ("all sources are default when nothing is set"). Should the run pause to fix it, or proceed?

**Decision:** Proceed.

**Alternatives considered:**
- Fix it in this PR — out of scope; the bug is in `test/config/resolve.test.ts` (it doesn't mock `conf`), unrelated to R24's surface (`task-labels`). Mixing unrelated fixes inflates the PR and obscures review.
- Pause and ask — unnecessary. The failure is reproducible on `main` HEAD (`7426315`) without any R24 changes (verified via `git stash && pnpm test`). CI on `main` was presumed green when R23 merged.

**Rationale:** Per autonomous protocol, pause is the response when a gate fails because of *this run's* changes. A pre-existing flaky test on the developer's machine — caused by reading the user's real `conf` store instead of a mock — is not gating evidence. CI on the PR runs without that contamination and is authoritative. If CI flags the same test, it's a separate maintenance task.

**Followup:** flag as a candidate test-hygiene fix (e.g., add `vi.doMock('conf', …)` to the affected `describe` block in `test/config/resolve.test.ts`).
