# Requirement — M07 `freelo files delete <uuid>`

**Run:** 2026-08-28-2039-files-delete
**Source:** `docs/roadmap-migration-2026-08.md` slice M07 (merged to main in PR #112)
**Mode:** autonomous (`/auto`), branching from `main`

## Original input

**M07 — `freelo files delete <uuid>`**, from `docs/roadmap-migration-2026-08.md`. Extends R25 (upload),
R26 (list), R27 (download) — all already shipped — by closing the read/write asymmetry: nothing
currently deletes a file.

**Endpoint:** `DELETE /file/{file_uuid}` — documented in `docs/api/freelo-api.yaml`
(`deleteDocOrFileByUuid`).

**Behavior notes from the roadmap slice** (re-verify against the actual spec text when specced):

- Resolves file vs. document/note automatically from the UUID — one command handles both resource kinds.
- Soft-delete only (marked deleted, not physically removed) — matches every other delete in this API,
  including M01's comment delete (just shipped) and the existing task/tasklist deletes.
- Returns 404 if the UUID doesn't exist or isn't accessible to the caller.

**CLI shape:** `freelo files delete <uuid>... [--yes] [--dry-run]` / `--ids` / `--stdin` — reuses
`src/lib/confirm.ts` (R13, shared destructive-op confirmation helper) and `src/lib/batch.ts` (R09,
shared batch-input reader). Mirror `src/commands/comments/delete.ts` (M01) and the existing
`src/commands/files/` directory (R25-R27).

**Idempotency question to decide independently:** M01 decided a 404 on comment-delete is a real error,
not idempotent success, because Freelo hides "someone else's comment" behind a 404 (ACL-hides-existence).
Check whether `DELETE /file/{file_uuid}` has the same characteristic or whether a 404 here unambiguously
means "already deleted" (in which case the `src/lib/idempotency.ts` / `already_in_target_state: true`
pattern used by every other delete would be right instead). Decide from the actual endpoint description
in `docs/api/freelo-api.yaml`, not from M01's precedent.

**Guardrail:** do NOT touch, remove, or "clean up" `.claude/settings.json` — it is intentionally
committed shared project configuration (PR #109). If the working tree shows it modified/deleted, that
is a staging bug, not a legitimate cleanup — stop and reconcile before committing.

## Run parameters

| Parameter | Value |
|---|---|
| `allowNetwork` | false (MSW only; no live Freelo calls) |
| `autoShip` | false (stop after PR / merge gate) |
| Wall clock budget | 30 min |
| Agent invocation budget | 40 |
| Phase retry budget | 8 |
| Files touched budget | 25 |

Roadmap guessed **Yellow** tier — triage confirms or overrides on its own findings.

## Pre-flight (orchestrator, calibration #6)

- `git rev-parse --abbrev-ref HEAD` → `main`
- `HEAD` == `origin/main` == `ed020809922f2c5f94747301c34cdb3ef60d36dd`
- `git status --short` → clean
