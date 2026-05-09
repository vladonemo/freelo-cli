# Decision 6 — No automatic `already_in_target_state` mapping in v1

**Run:** 2026-05-09-1200-r32-projects-workers
**Phase:** spec
**Agent:** orchestrator

**Question:** R11 (`tasks finish/reopen`) and R30 (`projects delete`) re-classify some HTTP errors as idempotent successes (`already_in_target_state: true`). Should `projects workers remove` do the same — for example, treat "user is no longer in the project" as already-removed?

**Decision:** No. v1 surfaces every HTTP error from the remove endpoints as `FreeloApiError` (no automatic re-classification).

**Alternatives considered:**
- Map 404 to `already_in_target_state: true` (mirror R30's project-delete idempotency). Rejected — the by-ids endpoint isn't documented as returning 404 for "user not in project"; the spec says it returns a 400 from the ACL checker.
- Map by-emails 422 ("email not currently in the project" per yaml :731) to idempotent success. Rejected — same reasoning. The OpenAPI says the request "fails," not "no-ops"; we don't know that subsequent re-calls are safe.
- Probe a live test account to find out. Possible, but not blocking — the conservative default is safer than a probe-derived heuristic baked into v1.

**Rationale:** "Don't guess the API" (autonomous-sdlc decision matrix). The ergonomic cost of *not* mapping is small — a re-removal returns a server error with a clear message; agents can interpret it. The cost of mapping incorrectly would be silently treating real failures (e.g. ACL refusals that *look* like "already not present") as successes. Revisit when `freelo-api-specialist` captures a live fixture for the re-call case.
