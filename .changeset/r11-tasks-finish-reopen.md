---
'freelo-cli': minor
---

feat(commands): R11 — `freelo tasks finish` and `freelo tasks reopen`

Two new write commands for closing and re-opening tasks, plus the shared
idempotency helper that R12+ reuse.

- `freelo tasks finish <id>... [--ids a,b,c] [--stdin] [--dry-run]` —
  closes one or more tasks. Idempotent: tasks already finished are skipped
  via a pre-check `GET /task/{id}` before any POST.
- `freelo tasks reopen <id>... [--ids a,b,c] [--stdin] [--dry-run]` —
  reopens finished tasks (wire endpoint `POST /task/{id}/activate`). Same
  surface, idempotent on already-active.
- New shared helper `src/lib/idempotency.ts` (`checkIdempotency`) — pure
  predicate consumed by R11 and reserved for R12 (move), R13 (delete), and
  R14+ (archive, mark-read/unread, attach/detach-label).
- New schemas (additive, no breaking changes): `freelo.tasks.finish/v1`
  and `freelo.tasks.reopen/v1`. Both share the same `data` payload shape
  (`task_id`, `previous_state`, `current_state`, `already_in_target_state`,
  `verb`, optional `would` for `--dry-run`, optional `line_index` for
  `--stdin`).
- Three input sources (mutually exclusive): variadic `<id>...` positional,
  `--ids <comma-or-space list>`, or NDJSON via `--stdin`. Empty input is
  silent success. Single-id mode bubbles errors to stderr; multi-id mode
  emits per-id error envelopes interleaved with the success stream and
  exits with the highest exit code observed.
- Pre-check refuses to act on `state: 'deleted'` tasks (`VALIDATION_ERROR`,
  exit 2) — the activate endpoint isn't symmetric with the project
  endpoint and won't undelete (per OpenAPI :1802).

Schema bumps:
- ADD `freelo.tasks.finish/v1`
- ADD `freelo.tasks.reopen/v1`

No existing envelope shape changed.
