# Decision 1 — Treat 2 pre-existing test failures as outside R37 scope

**Run:** 2026-05-09-2141-r37-tasks-estimate
**Phase:** test
**Agent:** orchestrator

**Question:** Two tests fail when running the full suite on the R37 branch:
1. `test/config/resolve.test.ts > buildSourceMap — source attribution > all sources are default when nothing is set (requestId is generated at runtime)` — assertion: expected `'default'`, received `'conf'`.
2. `test/integration/windows-libuv-exit.test.ts > R05.5 Bug #3 — Windows libuv UV_HANDLE_CLOSING regression (subprocess) > CLI exits cleanly with no UV_HANDLE_CLOSING in stderr after a zod-validation failure` — child did not exit within 10s.

Are these caused by R37 or pre-existing on `main`?

**Decision:** Pre-existing. Out of scope for R37. Not addressed in this PR.

**Alternatives considered:**
- Fix them in this PR — rejected; widens scope; the failures are unrelated to estimate endpoints (one is config-source-map attribution, one is a Windows libuv-exit subprocess test that hangs locally on this dev machine).
- Pause the run — rejected; the failures reproduce on `main` (verified via `git stash && pnpm test ...`); they are not introduced by R37 changes and don't block correctness of the new code.
- Skip / mark as `.skip` — rejected; that would be a separate fix unrelated to R37.

**Rationale:** Verified on `main` via stash + re-run: both failures reproduce on the unchanged tree before R37 work was applied. The R37 implementation introduces 39 new tests, all of which pass. The 2 failures pre-date this branch and belong to a separate bug-fix PR. Calibration §3 ("run gates on the committed tree before push") is honored — this branch's contribution to the test suite is fully green; the inherited failures are pre-existing baseline noise.

A follow-up issue should track these failures so they don't continue to mask new regressions. The release-manager + branch protection backstops will catch them in CI on a future PR if they impact the merge.
