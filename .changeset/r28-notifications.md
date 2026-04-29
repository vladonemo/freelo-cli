---
'freelo-cli': minor
---

R28 — `freelo notifications list` / `read` / `unread`. First slice in the notifications sub-thread; gives agents a typed, paginated, idempotent surface over the Freelo notification feed.

```
freelo notifications list   [--unread] [--page N | --all] [--project <id>...] [--type <s>...]
freelo notifications read   <id>... | --ids <list> | --stdin | --all-unread   [--dry-run]
freelo notifications unread <id>... | --ids <list> | --stdin                  [--dry-run]
```

Wraps three Freelo endpoints:

- `GET /all-notifications` — paginated list (yaml :3619-3694).
- `POST /notification/{id}/mark-as-read` — flip `is_unread → false` (yaml :3696-3724).
- `POST /notification/{id}/mark-as-unread` — flip `is_unread → true` (yaml :3726-3753).

**Three new envelope schemas (additive surface):**

- `freelo.notifications.list/v1` — `{ applied_filters, items: Notification[] }` plus `paging` and `rate_limit`.
- `freelo.notifications.read/v1` — per-id `{ notification_id, posted: true }` (or `{ notice: 'No unread notifications.', data: {} }` for empty `--all-unread`).
- `freelo.notifications.unread/v1` — per-id `{ notification_id, posted: true }`.

**Server-side idempotent.** Both write endpoints return 200 on already-in-state. There is no `GET /notification/{id}` endpoint, so the CLI cannot pre-check current state per id and never emits `already_in_target_state` — agents that need that signal must observe `is_unread` via `notifications list` before/after.

**Agent-safe writes.** Every write supports `--dry-run` (echoes wire path in `data.would`), `<id>...` positional + `--ids` + `--stdin` NDJSON batch, and per-id error envelopes in batch mode (highest exit code wins). No destructive prompt — marking-as-read is reversible (use `unread` to revert).

**`--all-unread` on `read`** drains the unread feed: lists every unread notification client-side (paged), then POSTs `mark-as-read` for each id. Per-id failures continue with the rest. Empty unread set emits a single `notice` envelope (decision 06). With `--dry-run`, the list call still runs (so the user sees what *would* be POSTed); the per-id POSTs do not. **No `--yes` gate** — the operation is reversible (decision 02).

**v1 list filters surfaced:** `--unread` (→ `only_unread=true`), `--project` (→ `projects_ids[]`, repeatable), `--type` (→ `notification_types[]`, repeatable). Wire-only filters omitted in v1 (decision 04): `users_ids[]`, `teams_uuids[]`, `order`. Add later if real workloads ask.

No new dependencies. No security review trigger.
