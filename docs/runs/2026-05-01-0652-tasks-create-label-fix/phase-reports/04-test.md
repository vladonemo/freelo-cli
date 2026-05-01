# Phase 4 — Test

**Status:** ok
**Retries:** 1 (two integration tests needed adjustment after first run; both
related to MSW v2 quirk and the existing `three valid lines` test acquiring
a new attach handler — both fixed in the same retry)

## Coverage

40 tests in `test/commands/tasks/create.test.ts` pass (12 unit, 28 integration).
12 tests in `test/api/tasks-create.test.ts` pass.

8 new scenarios added per spec §10:
- 1 label, attach OK
- 2 labels: single batched POST body asserts both names
- Attach 422 → exit 4, dual-emit, applied_labels.failed populated
- Attach 502 → exit 4, retryable: true on stderr envelope
- Attach network error → exit 5, applied_labels.failed populated
- No --label → applied_labels absent (preserve absent-vs-empty)
- Human mode renders "Attached labels: …"
- Dry-run with --label → would array length 2

Plus per-line attach failure scenario in batch mode (4 NDJSON lines for 2
input lines, exit 4).

## Test patterns observed

Per Calibration §2, every error path asserts the `process.exit` code via the
captured spy (2/4/5/6 as appropriate). Per Calibration §4, every new
try/catch arm in `runSingle` and `runBatch` has a dedicated test.

## Local gate

- pnpm typecheck — clean
- pnpm lint — clean
- pnpm test (task scope, 33 files / 646 tests) — green
- pnpm build — success
- pnpm check:readme — up to date

Two pre-existing failures in `test/config/resolve.test.ts` and
`test/integration/windows-libuv-exit.test.ts` confirmed to be on `main`
without my changes (env-specific, Windows + cosmiconfig).
