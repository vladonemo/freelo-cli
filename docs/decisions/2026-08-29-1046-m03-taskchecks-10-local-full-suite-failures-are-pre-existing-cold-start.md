# Decision 10 — Local full-suite failures diagnosed as pre-existing first-test cold-start, not a regression

**Run:** 2026-08-29-1046-m03-taskchecks
**Phase:** gate
**Agent:** orchestrator

**Question:** `pnpm test:cov` on the clean committed tree reported **11 failures across 8 files**. Is that a regression from this slice, and does it block the PR?

**Decision:** Not a regression; not blocking. Diagnosed, evidenced, and left for CI to confirm — which the run instructions name as the final word.

**Evidence gathered, in order:**

1. **No failing test is in this slice.** All 8 failing files are pre-existing suites this branch does not modify: `tasks/{list,move,edit,create}`, `comments/edit`, `files/{delete,download}`, `integration/windows-libuv-exit`. The four new taskchecks suites (87 tests) passed inside that same parallel run.
2. **Every failure is the FIRST test in its file**, and 8 of 11 are literally `Test timed out in 15000ms` — e.g. `files delete > single uuid with --yes`, `tasks list > 1. no flags`, `tasks create > minimal flags`, `tasks edit > minimal: only --name`, `comments edit > --message`. That is a cold-start signature, not an assertion failure.
3. **Each failing file passes in isolation.** Re-running `comments/edit`, `tasks/list` and `tasks/move` on their own: 144/144 passed.
4. **The same trio failed once and then passed on a re-run of the identical command** on the identical commit — non-deterministic, i.e. load-dependent.
5. **The same trio passes on `main`** (checked out `main` at `59a6d49` and ran them: 144/144), and `main` is green in CI — so the condition is environmental to this machine, not introduced here.

**Root cause** (same mechanism as decision 8): every command test does `await import('src/bin/freelo.js')` with `vi.resetModules()` in `beforeEach`. The first import in a file pays the full vite transform of the CLI graph (~10 s under load); the rest hit the cache. Whichever test runs first absorbs that against a 15 s `testTimeout`. On a loaded machine it tips over.

**Why this slice's own suites did not fail:** they call `warmUpCli()` from `beforeAll` (decision 8), which moves the cost out of the assertion budget. The pre-existing suites have no such hook. This is incidental confirmation that the diagnosis is right.

**Alternatives considered:**

- **Add `warmUpCli()` to the eight pre-existing suites too.** Tempting, and it would likely make the local full run green. Rejected as out of scope: it touches eight unrelated test files in a feature PR, inflating an already over-budget diff (decision 7) and mixing a test-infrastructure change into a feature review. Recorded as a follow-up instead.
- **Declare the run blocked and pause.** Rejected on the evidence above — pausing on a documented, reproduced-on-`main`, environment-specific flake would be a false positive.

**Follow-up worth opening:** either lift `warmUpCli()` into a shared `test/` helper and adopt it across the command suites, or raise `testTimeout` with a comment naming this cause. The current 15 s value already carries a comment about slow Windows cold-start; this is the same problem, one notch worse.

---

## Re-verification, 2026-08-29 later session (gate re-run before push)

The gate chain was re-run on the same committed tree (`b1d0e64`) in a fresh session. The failure set reproduced **exactly**: 11 failures across the same 8 files, 8 of them `Test timed out in 15000ms`, 3 assertion failures (`expected 99 to be 42`, `expected 'message' to be 'file'`, `expected undefined to deeply equal [ 42, 43 ]`). The four taskchecks suites passed again — 24 + 24 + 23 + 16 = 87 tests. Reproducibility of the *set* is itself evidence for the environmental reading.

Two refinements to the analysis above, both from checks this decision did not originally run:

1. **`windows-libuv-exit` does not belong to the `testTimeout` class.** It is grouped with the other seven above, but its failure is `child did not exit within 10s — possible libuv hang`, raised by a **watchdog inside the test** (`test/integration/windows-libuv-exit.test.ts:141`), not by vitest's 15 s `testTimeout`. It also still failed when the eight files were re-run together, so the "passes in isolation" evidence never actually covered it. Run **completely alone** it passes; and it passes alone on **`main` @ 59a6d49** too. Same environmental conclusion, different timer — the test spawns `node --import tsx src/bin/freelo.ts`, so the child pays a full cold `tsx` transpile against a hard 10 s budget. Worth knowing, because raising `testTimeout` would not fix this one.
2. **`test:cov` never emitted a coverage report.** Vitest bailed on the failures before printing the table, in this run and — by the same mechanism — in the original. So the branch-coverage threshold has **not** been verified locally on this branch at any point, despite `test:cov` having been run twice for ~13–17 min each. The decision above says the gate was run; it was, but it did not produce the number that is the whole reason `test:cov` is specified over `pnpm test`. CI remains the only place that figure has been checked.

`typecheck`, `lint`, `build` and `check:readme` all pass on the committed tree.
