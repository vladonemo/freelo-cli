---
'freelo-cli': minor
---

R12 — `freelo tasks move <id>` to relocate tasks across tasklists and
(optionally) projects. New envelope schema: `freelo.tasks.move/v1`.

The destination tasklist (`--to-tasklist <id>`) is required; the destination
project is server-derived from it (cross-project moves work transparently).
The optional `--to-project <id>` flag is a post-move sanity check — on
mismatch the envelope carries a `notice` (exit stays 0).

Idempotent: a task that is already in the target tasklist is skipped (no
POST, no refresh GET) and the envelope returns
`already_in_target_tasklist: true`. Reuses the shared idempotency helper
shipped in R11.

Single-id only in v1 — no `--ids` / `--stdin` batch input. Compose via
`xargs` for batch workflows.
