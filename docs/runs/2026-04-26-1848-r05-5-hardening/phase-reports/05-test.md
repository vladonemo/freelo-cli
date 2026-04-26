# Phase 5 — Test

**Run:** 2026-04-26-1848-r05-5-hardening

## New tests added

| Layer | File | Cases |
|---|---|---|
| Unit (schema) | `test/api/schemas/project.test.ts` | +14 cases — UserBasic.fullname null/missing; ProjectFull.owner without fullname; ProjectDetail workers with partial hour_rate; CurrencySchema string/number/NaN/Infinity/mixed |
| Unit (schema) | `test/api/schemas/tasklist.test.ts` | +15 cases (new file) — minimal shape, null tolerance, Currency string/number normalization, TasklistListData round-trip |
| Integration (api) | `test/api/projects.test.ts` | +1 case — getAllProjects parses fixture with numeric real_cost / budget |
| Unit (errors) | `test/errors/handle.test.ts` | +1 case (timeout-race arm); 3 existing cases updated to mock `.destroy` instead of `.close` |
| Integration (subprocess) | `test/integration/windows-libuv-exit.test.ts` | +1 case (new file) — Windows-matrix subprocess regression for Bug #3 |

Total: **+31 new tests, +1 fixture**. All passing locally on Windows.

## Coverage / thresholds

Verified `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm check:readme`
clean on the committed tree. `pnpm test` passes 700/702 — 1 pre-existing
Windows-local flake (see implement-phase report), 1 long-standing skip.

## Calibration log compliance

- §1 (don't skip test phase): all three bugs have at least one test case;
  Bug #3 has both unit + integration coverage.
- §2 (exit codes asserted on error paths): handle.test.ts asserts exit
  codes 2/3/4/5/6/130 across error classes; the libuv subprocess test
  also asserts `result.status === 4` after the forced FreeloApiError.
- §3 (gates after commit on clean tree): all five gates run on the
  committed tree at HEAD = `4aad2ad`.
- §4 (new try/catch wrappers tested): `drainDispatcher` swallows errors
  inside try/catch — covered by the destroy-rejects test case.
- §5 (CI required status checks): branch protection gates auto-merge.

## Known follow-ups (non-gating)

- Pull `CurrencySchema` into a shared module to avoid duplication
  between `project.ts` and `tasklist.ts`. Tracked informally; defer
  to a refactor PR.
- Broader OpenAPI-vs-live-API audit for required-vs-optional drift.
  Tracked informally.
