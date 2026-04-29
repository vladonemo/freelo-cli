# Phase 06 — Local gates

## Result on the working tree (pre-commit)

| Gate | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm test` | **1710/1712 pass** — 1 failure pre-existing on `main` (see below); 1 skipped (existing) |
| `pnpm build` | clean (478 KB bundle) |
| `pnpm check:readme` | clean after `pnpm fix:readme` regenerated the autogen block |

## Pre-existing test failure on `main`

`test/config/resolve.test.ts > buildSourceMap — source attribution > all sources are default when nothing is set`

The test calls `buildSourceMap({ env: {}, flags: {} })` which under the hood calls `safeReadStore()` against the user's actual `conf` store (the test does **not** mock `conf`, unlike the labels/task-labels tests which do). On a developer machine that has a `currentProfile` set in `conf`, the test reads it and gets `'conf'` instead of `'default'`. **Reproduced on `main` (HEAD: 7426315) without any R24 changes** (verified by `git stash && pnpm test -- test/config/resolve.test.ts`).

This is a pre-existing main-branch flaky test, not introduced by R24. CI on `main` was presumed green because R23 just merged; CI runners don't have a developer's `conf` store.

**Decision:** do not block this run on a pre-existing failure. CI on the PR will be the authoritative ground truth. If CI also catches it, that's an existing main-branch issue to address separately. Logged in decision 03.

## Calibration #3 reminder

Final gates will rerun on the **committed** tree before push, per Calibration #3.

## R24-only test count

47 new tests:
- 15 in `test/api/task-labels.test.ts`
- 8 in `test/commands/task-labels/create.test.ts`
- 12 in `test/commands/task-labels/attach.test.ts`
- 12 in `test/commands/task-labels/detach.test.ts`

All pass.
