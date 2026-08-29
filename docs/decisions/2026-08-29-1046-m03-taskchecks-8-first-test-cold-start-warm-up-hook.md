# Decision 8 — Warm up the CLI module graph in `beforeAll` instead of accepting first-test timeouts

**Run:** 2026-08-29-1046-m03-taskchecks
**Phase:** test
**Agent:** orchestrator (test-writer mandate)

**Question:** The **first** test in each of the three new command suites timed out against the 15 s `testTimeout` whenever the machine was under load — reproducibly the first test, never a later one. Accept it as the known local-flake class and let CI decide, or fix it?

**Decision:** Fix it. `test/commands/taskchecks/harness.ts` exports `warmUpCli()`, and each suite calls it from `beforeAll` with an explicit 60 s hook timeout.

**Alternatives considered:**

- **Accept it as the documented local flake** and let CI be the final word, per the run instructions. Rejected: the run instructions describe *load-dependent* failures that don't reproduce serially. This one had a systematic signature — always the first test in a file, four files out of four — which is a different animal from the cross-test bleed seen elsewhere. "Flaky under load" and "structurally charges a one-off cost to whichever test runs first" deserve different responses.
- **Raise the global `testTimeout` in `vitest.config.ts`.** Rejected: it is shared config, it would mask the same class of problem for every other suite, and the existing 15 s value already carries a comment explaining why it isn't 5 s.
- **Mark the first test `it.slow` / give it a per-test timeout.** Rejected: it moves the cost rather than removing it, and the next person to reorder the file re-introduces the flake.

**Rationale:** Every test does `await import('../../../src/bin/freelo.js')`, and `setUpEach` calls `vi.resetModules()` so the graph re-executes each time. The module *registry* resets but vite's *transform* cache does not, so the first import in a file pays the full ~10 s compile and the rest are fast. Charging that to a test's assertion budget is an accident of ordering. Paying it in `beforeAll`, where a generous timeout is appropriate, is both faster to diagnose when it does fail and stops the suite from being ordering-sensitive. No assertion depends on the warm-up; it is purely a timing fix.

Confirmed: the four suites went from 4 failures to 87/87 passing with no other change.
