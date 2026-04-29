# Phase 3 — Implement (R23 labels)

**Run:** 2026-04-29-1300-r23-labels

## Files touched

```
src/api/project-labels.ts              285 lines  (pre-takeover, kept)
src/api/schemas/project-label.ts       160 lines  (pre-takeover, kept)
src/commands/labels.ts                  33 lines  (new — parent)
src/commands/labels/attach.ts          ~315 lines  (new)
src/commands/labels/delete.ts          482 lines  (pre-takeover, kept)
src/commands/labels/detach.ts          ~395 lines  (new)
src/commands/labels/list.ts             81 lines  (pre-takeover, kept)
src/commands/labels/rename.ts          ~205 lines  (pre-takeover; renamed --color → --hex)
src/ui/human/labels-attach.ts           16 lines  (pre-takeover)
src/ui/human/labels-delete.ts           23 lines  (pre-takeover)
src/ui/human/labels-detach.ts           21 lines  (pre-takeover)
src/ui/human/labels-list.ts             47 lines  (pre-takeover)
src/ui/human/labels-rename.ts           35 lines  (pre-takeover)
src/bin/freelo.ts                       (small edit — wired registerLabels)
```

## Decisions made during this phase

- **Decision 11 — `--color` flag collision.** See `docs/runs/2026-04-29-1300-r23-labels/decisions/11-color-flag-collision.md`. Renamed the rename/attach color flag from `--color <hex>` to `--hex <color>` to avoid Commander's parent-options-win behavior shadowing the spec's flag.

## Calibration §2 — typed-error coverage on disk

Every typed-error class touched is asserted by at least one test:

| Class                | Triggered by                                    | Test                       |
| -------------------- | ----------------------------------------------- | -------------------------- |
| `ValidationError`    | bad `<id>`, bad `--hex`, empty edit, mutex flags, missing source | rename / delete / attach / detach test files |
| `FreeloApiError`     | 401 / 403 / 404 / 5xx                           | every leaf has its own row |
| `RateLimitedError`   | 429                                             | list / rename / delete     |
| `NetworkError`       | connection-closed                               | list                       |
| `ConfirmationError`  | non-TTY `delete` without `--yes`, TTY decline   | delete                     |

## Calibration §4 — every new try/catch arm has a test

New `try/catch` introductions:

- `src/commands/labels/attach.ts` — outer `try` in `cmd.action`; inner per-name `try/catch` in `runFanOut`. Both covered by validation tests (outer) and the batch continue-on-error test (inner).
- `src/commands/labels/detach.ts` — outer `try`, inner per-id `try/catch` (positional path), inner per-line `try/catch` (stdin path). Outer covered by validation rows; inner covered by mixed-batch idempotency test and the 5xx error row.
- `src/commands/labels/delete.ts` (pre-takeover) — already covered by tests inherited from the spec's plan.

## Local gates run

```
pnpm typecheck   ✓ (pre-commit, on working tree)
pnpm lint        ✓ (pre-commit)
pnpm test        ✓ for labels suite (89 tests across 5 files); 1 pre-existing
                   failure in test/config/resolve.test.ts unrelated to R23
pnpm build       ✓
pnpm check:readme ✓ after pnpm fix:readme
```

The `test/config/resolve.test.ts` failure is pre-existing on `main` (verified by stashing
the labels work and re-running). Out of scope for this slice.
