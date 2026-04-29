# Decision 2 — No pre-check GET; envelope omits `already_in_target_state`

**Run:** 2026-04-29-2030-r28-notifications
**Phase:** spec / implement
**Agent:** orchestrator (architect role)

**Question:** R11 `tasks finish` emits `already_in_target_state: true` when a pre-check GET reveals the task is already finished. Should `notifications read` / `unread` do the same?

**Decision:** No. The CLI always POSTs (the server is idempotent). The envelope omits `already_in_target_state` entirely.

**Alternatives considered:**

- **A. Pre-fetch the unread feed and intersect with input ids** — adds an extra GET + paging burden for the common case (mark-by-id). For an id-mode call with N ids and an unread feed of M items, that's M/per_page extra paged GETs to determine which N are already-read. Net negative for the common case.
- **B. Skip pre-check; emit `already_in_target_state: false` always** — misleading. Agents would treat the field as load-bearing when it carries no information.
- **C. Skip pre-check; omit the field entirely; document server-side idempotency in envelope schema comments (chosen).** Honest about what the CLI knows.

**Rationale:** Freelo does not expose a `GET /notification/{id}` endpoint. The list endpoint (`GET /all-notifications`) only accepts a unread-only filter, not an id-list filter, so we can't cheaply fetch a single id's current state. The server is documented idempotent (yaml :3709, :3739) and surfaces the post-state implicitly via the next `notifications list --unread` call. Agents that need the signal observe `is_unread` before/after.
