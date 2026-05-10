# Decision 4 — `pins add` does not surface `was_existing`

**Run:** 2026-05-10-r44-notes-pins
**Phase:** Spec
**Agent:** architect

**Question:** `POST /project/{id}/pinned-items` is a server-side dispatcher: internal-resource URLs are fetch-or-create idempotent; external URLs always create (yaml :1078-1080). Should the envelope flag whether the returned pin pre-existed?
**Decision:** No. Surface only what the server returns — there is no `was_existing` or `created_at_this_call` flag.
**Alternatives considered:**
- Diff `pin.link` vs `applied_link` to infer "this is a fetch-or-create return".
- Issue a `pins list` first, check for existence, branch.
- Surface a heuristic flag based on the URL pattern (internal vs external).
**Rationale:** The fetch-or-create dispatch is server-side; client-side inference would require shadowing Freelo's URL recognizer (prone to drift) or doubling the HTTP cost. Agents who care about deduplication can call `pins list` first. The envelope is honest — the server returned a `PinnedItem`, the CLI surfaces it as-is.
