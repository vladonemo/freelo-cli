# Phase 07 — Code review (self-review)

## Scope

10 new source files, 4 new test files, 3 modifications:
- `src/bin/freelo.ts` — added registerTaskLabels (2 lines).
- `test/msw/handlers.ts` — added taskLabelsHandlers (~110 lines).
- `README.md` — autogen update.

## Review findings

### Blocking

None.

### Non-Blocking — addressed in-place

- **F-1 (lint shim)**: `void color` shim in `create.ts` was a smell. **Fixed** by extracting `envelopeData()` helper that derives the envelope `data` shape directly from `body.labels[]`. Color is already encoded per-entry; no need to thread the `color` arg into helpers. Re-ran typecheck/lint/create.test.ts after the refactor — all green.

### Non-Blocking — observation only

- The three commands share boilerplate (parsers, `buildClient`). Future refactor candidate: hoist `parseTaskIdFlag`, `collectName`, `collectUuid`, `parseHexColorFlag` into a shared `task-labels-shared.ts`. Out of scope for v1; copy-paste is fine at three call sites.

## Convention compliance

- ✅ ESM `.js` extensions on every relative import.
- ✅ No `any` introduced.
- ✅ All thrown errors are typed (`ValidationError`).
- ✅ Schema-validated network responses (`SuccessResponseSchema`).
- ✅ Three new envelope schemas (`freelo.task_labels.{create,attach,detach}/v1`) — additive only.
- ✅ Dry-run support on every leaf.
- ✅ JSON envelope shape includes `would` on dry-run.
- ✅ No new dependencies.

## Calibration compliance

- **#2** (exit codes on every typed-error path): asserted in tests for `ValidationError` (exit 2) and `FreeloApiError` (exit 4). `RateLimitedError` and `NetworkError` pass through unchanged from `client.ts` and don't need duplication per command (precedent: R22, R23).
- **#4** (try/catch arms across 3+ files): the only catch is the existing top-level `try { ... } catch (err) { handleTopLevelError(...) }` pattern that every other command uses. No new conditional cleanup or new error-path branches introduced; nothing extra to test.
- **#7** (TTY-prompt `CI` clearing): N/A — no `confirmDestructive` use; no `isInteractive()`-gated branches in this slice. `git diff test/ | grep "isTTY.*true"` → 0 matches.

## Conclusion

Approved. Move to docs phase.
