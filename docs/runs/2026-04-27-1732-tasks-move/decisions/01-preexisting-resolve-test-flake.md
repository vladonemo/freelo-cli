# Decision 1 — Pre-existing flake in `test/config/resolve.test.ts`

**Run:** 2026-04-27-1732-tasks-move
**Phase:** Test (gate run)
**Agent:** orchestrator

**Question:** A test in `test/config/resolve.test.ts` (`buildSourceMap — source
attribution > all sources are default when nothing is set`) fails locally
asserting `map.profile === 'conf'` rather than `'default'`. Is this introduced
by R12 or pre-existing?

**Decision:** **Pre-existing**, machine-state-dependent flake. Not caused by
R12. Proceed with the run; the gates pass on a clean CI runner (no
`freelo-cli-nodejs/Config` directory exists on CI).

**Alternatives considered:**

- Fix the flake as part of this run (`buildSourceMap` should ignore real
  user config when `flags={}` and `env={}` are passed; the test calls the
  pure function directly, which then reads `conf`'s real store from
  `%APPDATA%/freelo-cli-nodejs/Config/`).
  - Rejected: out of scope for R12. Would inflate the diff and risk plan
    drift.
- Pause the run.
  - Rejected: the failure is environmental (Windows dev machine has a real
    freelo config directory; CI doesn't); blocking R12 on this would be
    incorrect.

**Rationale:**

1. Confirmed by `git stash && pnpm test test/config/resolve.test.ts`: same
   failure on a clean `main` checkout (commit `7a1fc54`), without any of my
   changes applied.
2. Confirmed environmental cause: `%APPDATA%/freelo-cli-nodejs/Config`
   exists on this dev machine. `buildSourceMap({env:{}, flags:{}})` reaches
   into `conf`'s default store, which Node's `conf` module resolves
   relative to `%APPDATA%`. CI runners don't have this directory, so the
   test passes there.
3. R12 doesn't touch `src/config/resolve.ts` or
   `test/config/resolve.test.ts`.
4. The `pre-push` and CI gates run on a clean tree with `git status` clean
   and no machine-local config; the failure does NOT replicate there.

The flake should be tracked in a follow-up: the test should mock the `conf`
store-read path the same way `commands/tasks/move.test.ts` does (via
`vi.doMock('conf', ...)`), so it doesn't depend on real `%APPDATA%`. Filed
as a follow-up note in the run summary.
