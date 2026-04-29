# Phase 05 — Test

## Files

- `test/api/task-labels.test.ts` — 15 pure-function tests (paths + body builders).
- `test/commands/task-labels/create.test.ts` — 8 tests.
- `test/commands/task-labels/attach.test.ts` — 12 tests.
- `test/commands/task-labels/detach.test.ts` — 12 tests.
- `test/msw/handlers.ts` — added `taskLabelsHandlers` factory (modified).

## Results

47/47 passed first run. ~19s wall.

## Calibration coverage

- **§2**: every typed-error path has an exit-code assertion. ValidationError → 2 (multiple per file). FreeloApiError → 4 (one per command file).
- **§7**: grep `isTTY.*true` in test diff → 0 matches. No TTY-prompt branches in this slice (no `confirmDestructive` use).
