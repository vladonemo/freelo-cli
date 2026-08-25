# Requirement — 2026-08-25-0813-comments-delete

**Source:** `docs/roadmap-migration-2026-08.md` §M01 (merged to `main` in PR #112).
**Unblocks:** R18.5 in `docs/roadmap.md`, queued/blocked since 2026-04-28.

## Original input

> **M01 — `freelo comments delete <id>`**, from `docs/roadmap-migration-2026-08.md` (just merged to main).
> Unblocks R18.5 in `docs/roadmap.md`, which has been queued/blocked since 2026-04-28 waiting on exactly this endpoint.
>
> **Endpoint:** `DELETE /comment/{comment_id}` — now documented in `docs/api/freelo-api.yaml` (refreshed today in PR #112).
>
> **Behavior notes from the roadmap slice (docs/roadmap-migration-2026-08.md M01) — load-bearing, re-verify against the actual spec text when you spec this:**
>
> - ACL: only the comment's author can delete. Non-owner attempts return 404, not 403 — deliberately, to avoid leaking
>   existence of an inaccessible comment. Surface this as a plain "not found" error, not a permission error.
> - 15-minute deletion window from post time. After that, the endpoint returns 400. This needs a clear, specific error
>   message (not a generic 400 passthrough) — the user needs to know *why* immediately.
>
> **CLI shape (from the roadmap slice):** `freelo comments delete <id>... [--yes] [--dry-run]` / `--ids` / `--stdin` —
> mirrors the existing `freelo comments edit` (R18, sibling command on the same resource) and reuses `src/lib/confirm.ts`
> (R13, the shared destructive-op confirmation helper) and `src/lib/batch.ts` (R09, the shared batch-input reader).
> Look at how `src/commands/comments/edit.ts` (R18) and an existing R13-pattern delete command
> (e.g. `src/commands/tasks/delete.ts`) are structured before designing this — this should closely mirror both.

## Run parameters

| Parameter      | Value                              |
| -------------- | ---------------------------------- |
| `allowNetwork` | `false` (MSW only — default)       |
| `autoShip`     | `false` (default)                  |
| Wall clock     | 30 min                             |
| Agent calls    | 40                                 |
| Phase retries  | 8                                  |
| Files touched  | 25                                 |

## Sequence context

Part of a three-run sequence requested by Vlado: **M01 → M08 → M04**, run one after another.
This run must complete fully (through PR-open or auto-merge per its risk tier) before M08 starts.
