# Decision 1 — Do not fix the pre-existing `resolve.test.ts` failure inside R39

**Run:** 2026-05-09-2300-tasks-create-from-template
**Phase:** test
**Agent:** orchestrator

**Question:** `test/config/resolve.test.ts:278` ("all sources are default when nothing is set") fails on a clean `main` checkout (verified via `git stash` on the parent commit). The test calls `buildSourceMap({ env: {}, flags: {} })` and expects `map.profile === 'default'`, but `safeReadStore()` reads the developer's real `conf` store and returns `currentProfile`, so the result is `'conf'`. Should R39 fix it?

**Decision:** No. Out of scope. Surface as a follow-up.

**Alternatives considered:**

- Fix in this PR: stub `safeReadStore` in the test (e.g. `vi.spyOn` it to return `null`) → rejected; widens the slice and crosses into `src/config/` which is a Red-tier surface (auth/config touch). Tier escalation for an unrelated bug is the wrong trade.
- Add a `vi.doMock('conf')` in the test setup → same objection as above; that test file is currently mock-free, and adding mocks changes test isolation semantics.
- Skip the failing test → rejected; hides the failure, doesn't fix it.

**Rationale:** R39 is a Yellow-tier slice (additive subcommand). The `resolve.test.ts` failure existed on `main` before this PR and exists during it. Fixing it now would either need a `src/config/` change (escalating R39 to Red) or a test-only mock change (still cross-cutting, still off-scope). Best surfaced as a separate `fix(test)` slice.

The full test run for R39 confirms no R39-introduced regression (147 files / 2445 tests / 1 skipped pass; coverage thresholds met).
