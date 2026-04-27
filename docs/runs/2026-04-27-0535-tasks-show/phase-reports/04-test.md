# Phase report — Test

**Run:** 2026-04-27-0535-tasks-show
**Phase:** Test (test-writer + gates)
**Status:** Complete

## Outputs

- `test/commands/tasks/show.test.ts` — 27 end-to-end tests via
  `program.parseAsync`. Mirror of `test/commands/tasklists/show.test.ts`
  (R06) with three side-cars and the projection-not-HTTP variant for
  `--with projects`.
- `test/api/tasks-show.test.ts` — 14 wrapper tests (already on branch
  from prior session, verified clean).

Total new tests: 41. All green on first run.

## Calibration §1-2 enforcement

Every typed error path asserts `process.exit` exit code via
`captureOutput`'s spy and validates the `freelo.error/v1` envelope
shape. No "an error was emitted" assertions.

## Calibration §4 enforcement

Each new `try/catch` arm has at least one test triggering it:

- `rewriteDetailHint` — 4 tests (404, 403, 5xx, 401) on detail call.
- `rewriteDescriptionHint` — 3 tests (404, 403, 5xx) on description call.
- `rewriteSubtasksHint` — 3 tests (404, 403, 5xx mid-stream via
  `PartialPagesError` unwrap) on subtasks call.

## Gate results (committed tree)

```
pnpm typecheck   ✓
pnpm lint        ✓
pnpm build       ✓ (dist/freelo.js 176.45 KB)
pnpm check:readme ✓
pnpm test (R08)  ✓ 41/41 in 12.72s
pnpm test (full) — 838 passed, 1 skipped, 1 failed
```

The single failure is in `test/config/resolve.test.ts >
buildSourceMap > 'all sources are default when nothing is set'`. This
test does **not** mock `conf` and reads from the real Windows user
config store, which on this dev machine has a leaked `currentProfile`
key. The test fails identically on `main` (verified by checkout +
re-run), so this is not a regression introduced by R08. CI runs in
clean containers and is unaffected.

```
TEST phase=test run=2026-04-27-0535-tasks-show status=ok new_tests=41 retries=0
```
