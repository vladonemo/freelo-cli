# Decision 3 — Surface only `--unread`, `--project`, `--type` on list (not `--user`, `--team`, `--order`)

**Run:** 2026-04-29-2030-r28-notifications
**Phase:** spec
**Agent:** orchestrator (architect role)

**Question:** The wire endpoint `GET /all-notifications` documents six query filters: `users_ids[]`, `projects_ids[]`, `teams_uuids[]`, `notification_types[]`, `order`, `only_unread`, plus `p` for paging. Which should the v1 CLI surface?

**Decision:** Surface `--unread` (→ `only_unread=true`), `--project` (→ `projects_ids[]`, repeatable), and `--type` (→ `notification_types[]`, repeatable). Omit `--user`, `--team`, and `--order` from v1.

**Alternatives considered:**

- **A. Surface every documented filter** — expanded surface area, more flags to learn, more flags to test. The OpenAPI documents `users_ids[]` filters by **authors** (not recipients — the recipient is always the calling user); semantics are non-obvious and would warrant additional docs.
- **B. Surface only `--unread`** — strict literal of roadmap signature. Loses `--project` (likely useful for digest / Slack / Teams integrations — yaml :3627-3631 names those as documented use cases) and `--type`.
- **C. Surface `--unread`, `--project`, `--type` (chosen)** — the three most likely-useful filters for the documented integration use cases.

**Rationale:** Keep v1 minimal but useful. `--project` and `--type` are the two filters most agents would reach for (digest by project, mirror specific event types into Slack). `--user` (authors) and `--team` are less common in practice; `--order` defaults sensibly server-side (newest first). Add them in a follow-up if real workloads ask.
