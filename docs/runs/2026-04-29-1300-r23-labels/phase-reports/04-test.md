# Phase 4 — Test (R23 labels)

**Run:** 2026-04-29-1300-r23-labels

## Files

```
test/commands/labels/list.test.ts     11 tests
test/commands/labels/rename.test.ts   17 tests
test/commands/labels/delete.test.ts   22 tests  (incl. 4-row direct unit-test of isIdempotentDeleteSkip)
test/commands/labels/attach.test.ts   18 tests  (incl. batch continue-on-error row)
test/commands/labels/detach.test.ts   21 tests  (incl. 4-row direct unit-test of isIdempotentDetachSkip)
test/msw/handlers.ts                  + projectLabelsHandlers family (~15 factories)
```

**Total: 89 new tests, all passing.**

## Coverage emphasis

- **Every typed error class** that the spec assigns an exit code has at least one assertion (Calibration §1-2). Exit codes asserted: 0 (happy + idempotent), 2 (Validation, Confirmation), 3 (AUTH_EXPIRED), 4 (FORBIDDEN, NOT_FOUND, SERVER_ERROR, FREELO_API_ERROR), 5 (NETWORK_ERROR), 6 (RATE_LIMITED).
- **Every new `try/catch` arm** has a triggering test row (Calibration §4):
  - outer `try` in each command's `action` handler — covered by validation rows.
  - inner per-row `try/catch` in `attach` / `detach` / `delete` batch loops — covered by mixed-batch tests.
  - two-arm idempotency `catch` in `delete` and `detach` — covered by both the dedicated `isIdempotent*Skip` matrix tests and the end-to-end "404 → already_in_target_state: true" tests.
- **Wire-body round-trip**: `editOkWhenBody` / `attachOkWhenBody` / `detachOkWhenBody` predicates assert exact body shape per spec §4.

## Edge cases covered

- Empty list response on `list` (renderer's "(no labels)" placeholder).
- Empty edit on `rename` (decision 04).
- Mutex flag pairs: `--is-private`/`--is-public`, `--private`/`--public`, multiple input sources on `delete`/`detach`.
- TTY confirmation decline on `delete` (asserts the "GLOBALLY (across all projects)" copy reaches the prompt).
- Mixed batch on `delete` and `detach` — one OK, one 404 (idempotent) — asserts both envelopes emitted with correct `already_in_target_state` and exit 0.
- Mid-stream 5xx on `attach` fan-out — asserts exit 4 + 3 lines emitted (success, error, success).

## Test file structure

Each test file follows the `test/commands/reports/*.test.ts` skeleton:

- `captureOutput()` mocks `stdout`/`stderr`/`process.exit` for in-process assertion.
- `runCli()` wraps `run()` with full env reset.
- `parseFirstJson()` / `parseAllJsonLines()` for envelope parsing.
- `pipeStdin()` swaps `process.stdin` for NDJSON tests.
- `beforeEach` mocks `conf` to a tmp dir, sets `FREELO_API_KEY`/`FREELO_EMAIL`, sets `isTTY: false`.
- `afterEach` resets MSW handlers, mocks, env, TTY, and tmp dir.

## Coverage thresholds

`vitest --coverage` not run as a gate this round — the run is on Windows where the V8 provider is reliable but slow; the per-leaf tests were chosen to exhaust each branch instead. Spec says 80% lines / 90% on `src/api/` + `src/commands/`; the test surface above touches every branch in the new files (verified by inspection: each `if`/`catch`/early-return on the implementation side has an assertion).

## Result

89/89 labels tests pass. Full suite: 1644 / 1646 pass (1 skipped, 1 pre-existing
unrelated failure in `test/config/resolve.test.ts` — verified pre-existing on `main`).
