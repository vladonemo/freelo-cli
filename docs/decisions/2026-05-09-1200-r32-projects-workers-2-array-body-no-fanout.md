# Decision 2 — One invocation = one HTTP request

**Run:** 2026-05-09-1200-r32-projects-workers
**Phase:** spec
**Agent:** orchestrator

**Question:** The endpoints accept array bodies. Should `--user`/`--email` (repeatable at the CLI) fan out into N HTTP calls, or send all values in one call?

**Decision:** Send all values in one call. The bodies are documented as `users_ids: integer[]` / `users_emails: string[]` (yaml :705-709 / :745-749) and the server explicitly checks the entire batch up-front: "All given IDs are checked at once… if the caller lacks rights to remove any single user, the whole request fails (no partial removal)" (yaml :689-690).

**Alternatives considered:**
- Fan out into N POSTs. Rejected — would change atomicity from server-defined ("all or none") to client-defined ("partial allowed"). The server's atomicity is intentional; surfacing it preserves the contract.
- Cap the array size. Rejected — the OpenAPI documents no cap, and capping would silently change behavior on large inputs.

**Rationale:** The atomic semantics ARE the contract; the CLI surface should reflect them. Keeping one POST per invocation also avoids partial-success NDJSON output (which we'd need a new envelope for).
