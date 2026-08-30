# Requirement — R14 `Subtask.type` discriminator

**Run:** 2026-08-29-2230-r14-subtask-type
**Base:** `main` @ `32b6ead`
**Mode:** allowNetwork: false (MSW only), autoShip: false
**Recommended branch:** `feat/subtask-type-discriminator`
**Budget:** 90 min wall clock (calibration §8), 40 calls, 8 retries, 25 files

## Original input

Declare `Subtask.type` and retire the `inferStorageForm` heuristic it supersedes.
R14 debt, surfaced by the M03 run, carried in `docs/roadmap-migration-2026-08.md:105`.

- `docs/api/freelo-api.yaml:6375-6381` declares `Subtask.type` (string).
- `SubtaskSchema` (`src/api/schemas/task.ts:438`) does not declare it; it reaches
  `freelo.subtasks.list/v1` only via `.passthrough()`.
- `inferStorageForm` (`src/api/subtasks.ts:121`) infers `'smart' | 'simple'` from which
  fields are populated (spec 0025 §4.4), written before the server exposed `type`.
- That heuristic feeds `storage_form` in the `subtasks add` envelope
  (`src/commands/subtasks/add.ts:421`) — user-visible output, not a dead helper.

## Points to work out

1. Verify the contract: `type`'s permitted values; required or optional.
2. Is `type` (`subtask|taskcheck`) the same distinction as `storage_form` (`smart|simple`)?
3. Does the change break observable output of a shipped command? If yes -> Red, pause.
4. What happens when `type` is absent — heuristic as fallback, or retired entirely?
5. `inferStorageForm` is exported and directly unit-tested; do not leave it exported-but-unused.

## Scope boundary

`Subtask.type` and the `storage_form` derivation that depends on it. No other schema
declarations, no unrelated `.passthrough()` cleanups.

## Stop condition

Open PR and stop before merge. If point 3 resolves as breaking, pause instead of opening a PR.
