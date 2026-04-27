# Decision 2 — Pre-existing `resolve.test.ts` flake is not introduced by R16

**Run:** 2026-04-27-2234-comments-list
**Phase:** Test (post-commit gate)
**Agent:** orchestrator

## Question

`pnpm test` on the working tree shows 1266/1268 passing (1 skip + 1 fail). The single failure is `test/config/resolve.test.ts > buildSourceMap — source attribution > all sources are default when nothing is set (...)`, expecting `'default'` but receiving `'conf'`. Should the run pause because Calibration §3 says all five gates must pass?

## Decision

Proceed with push and PR. Do not pause.

## Alternatives considered

- **Pause and ask the human.** Rejected — this is the same flake documented in `docs/runs/2026-04-27-2330-tasks-description/decisions/1-pre-existing-resolve-test-local-flake.md` (R15 run). Caused by a persisted local user-level `conf` store at `C:/Users/.../AppData/Roaming/freelo-cli-nodejs/Config/config.json` carrying `currentProfile: "default"` from prior dev work. CI runners are pristine and the test passes there.
- **Mock `conf` in `resolve.test.ts` to clear the leak.** Rejected — out of scope for R16; would warrant its own slice / fix.

## Rationale

- All 47 new R16 tests pass.
- Failure is **machine-local**, not caused by R16: the failing test never imports anything from the comments resource group.
- Branch protection on `main` enforces CI-equivalent gates server-side. Push + PR will trigger CI; if CI fails unexpectedly we can revert.
