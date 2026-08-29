# Requirement — M06 `freelo task-labels merge`

**Run:** `2026-08-29-2050-m06-task-labels-merge`
**Base:** `main` @ `3d87130` (clean, in sync with origin; `pnpm install --frozen-lockfile` exit 0)
**Mode:** `allowNetwork: false` (MSW only), `autoShip: false`
**Branch:** `feat/task-labels-merge`

## Source

`docs/roadmap-migration-2026-08.md` §M06 (line 181) — the last unshipped roadmap item.

## Outcome asked for

Consolidate duplicate / near-duplicate task labels across every task that carries them, in one
server-side operation, instead of manually re-tagging tasks one at a time.

**Endpoint:** `POST /task-labels/merge`
**CLI shape:** `freelo task-labels merge --from <uuid>... --to <uuid> [--yes] [--dry-run]`

## Claims to verify against `docs/api/freelo-api.yaml` (not to be taken on faith)

1. `to_uuid` and every `from_uuids` must be owned by the caller; non-owned → 404, not 403.
2. Replacement applies only to tasks in projects where the caller is a **commander** — silent
   partial success elsewhere.
3. Target label name/colour come from the existing `to_uuid` label; client cannot set them.
4. Source label *definitions* survive; only the task attachments move. Check whether a
   delete-by-uuid endpoint for task labels exists at all.

## Design questions to decide and log

1. What does the success envelope honestly report, given the API returns no per-task detail?
2. Does `--from` take the repo's batch surfaces (`--ids`, `--stdin` NDJSON), or is the merge
   itself already the batch operation?
3. Is a `hint_next` pointing at `task-labels find` (M04) warranted on the not-found path?

## Constraints

- Most destructive slice in the set: irreversible relabeling at scale, no undo endpoint.
- Confirmation gate, `--dry-run`, and envelope honesty are the core of the work.
- R13 / M07 / M03 precedent: destructive → `--yes` or TTY prompt; non-TTY without `--yes` fails
  closed with `CONFIRMATION_REQUIRED` (exit 2).
- Tier: roadmap guesses Yellow. Triage decides independently. Green would auto-merge, which is
  inappropriate for a bulk irreversible write — flag loudly rather than merge.

## Budget

30 min wall clock, 40 agent invocations, 8 retries, 25 files. Wall-clock overrun is logged as a
decision, not a pause (M03 decision 7).

## Stop condition

Open the PR and stop before merge. Never publish.
