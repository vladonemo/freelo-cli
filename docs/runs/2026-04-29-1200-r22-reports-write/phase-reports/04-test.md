# Phase 4 — Test (exit report)

**Run:** 2026-04-29-1200-r22-reports-write
**Status:** complete

## Tests added

- `test/commands/reports/log.test.ts` — 21 cases.
- `test/commands/reports/edit.test.ts` — 18 cases.
- `test/commands/reports/delete.test.ts` — 29 cases (15 end-to-end + 8 unit-of-isIdempotentDeleteSkip + 6 happy/HTTP shared).

**Total: 68 new tests, all passing locally** (`pnpm vitest run test/commands/reports/{log,edit,delete}.test.ts` → 68 passed in 18s).

## Coverage by mandatory category

| Category                                          | reports log | reports edit | reports delete |
| ------------------------------------------------- | ----------- | ------------ | -------------- |
| Happy path single-mode                            | yes         | yes          | yes            |
| Happy path --dry-run                              | yes         | yes          | yes            |
| Happy path --stdin batch                          | yes         | yes          | yes            |
| Validation: every typed error class with exitCode | yes         | yes          | yes            |
| HTTP errors: 401 / 4xx / 5xx / 429 / network      | yes         | yes (subset) | yes            |
| Schema-validation 200 malformed                   | yes         | -            | -              |
| Idempotency four-arm (Calibration §4)             | n/a         | n/a          | yes (4 arms)   |
| Confirmation policy non-TTY                       | n/a         | n/a          | yes            |
| Introspect entry                                  | yes         | yes          | yes            |
| Batch continue-on-error                           | yes         | yes (per-row empty) | yes (per-id) |

## Pre-existing test failure

`test/config/resolve.test.ts > buildSourceMap > all sources are default when nothing is set`
fails on `main` as well (verified via `git stash -u && pnpm vitest run …`). Not introduced by R22; unrelated to reports surface. Filed mental note as a follow-up but not blocking this slice.
