# Decision 10 — Ran over the 30-minute wall-clock budget rather than shortcutting the test discipline

**Run:** 2026-08-29-0921-tasklists-edit
**Phase:** 6 (test / gates)
**Agent:** orchestrator

**Question:** The run passed the 30-minute wall-clock cap during the gate phase. `autonomous-sdlc.md` §Budget caps says to finish the current agent call, write a pause report, and stop. Do that, or continue to a complete PR?

**Decision:** **Continue and finish properly**, logging the overrun here. The human's run parameters explicitly pre-authorized this: *"If you run over budget, finish properly and log it as a decision rather than cutting corners."*

**Where the time went:**

| Phase | Approx. elapsed |
|---|---|
| Triage (OpenAPI verification, precedent survey) | 09:21-09:31 |
| Spec + plan + 9 decision records | 09:31-09:38 |
| Implement (schemas, API module, renderer, command) | 09:38-09:45 |
| Tests written + first run | 09:45-09:52 |
| Docs, changeset, README regen, commit | 09:52-10:00 |
| **Gate runs and flake triage** | **10:00-10:20** |

The dominant cost was not the feature — it was **verifying the local test failures were not regressions**, which took five separate suite runs (full `test:cov`, a 4-file serial re-run, an isolated single-file run, the same combo on `main`, then the same combo again on the branch). That verification is exactly what the run parameters asked for, and it is what established the failures were environmental.

**Alternatives considered:**

- **Pause at the cap with partial work on the branch.** Rejected: the work was complete and green; pausing would have handed the human an un-reviewed branch and no PR, forcing a `/resume` to do nothing but re-run gates.
- **Skip the `main`-comparison run and call the failures flaky on the strength of the serial re-run alone.** Rejected: the serial re-run still showed `tasks/move.test.ts` failing, so at that moment a real regression had *not* been ruled out. Stopping there would have been the corner-cutting the run parameters forbade — and would have shipped a PR asserting "all flakes" without evidence.
- **Reduce scope (e.g. drop the human-renderer tests) to fit the clock.** Rejected: that would have left a new source file at 65% coverage, which is calibration §4's exact failure mode.

**Rationale:** The budget exists to stop runaway loops, not to force an incomplete handoff on a run that is converging. There was no stuck loop here — every retry made progress (one lint fix, one commitlint scope fix, one coverage gap closed), and the stuck-loop detector (identical failure twice) never fired. Spending the extra time on flake triage produced a concrete, defensible finding rather than a hedge.

**Flake evidence recorded for the next run** (this is the third consecutive sibling run to hit it — see decision 11).
