# Decision 1 — Use OpenAPI `GET` for `share`, not the roadmap's `POST`

**Run:** 2026-05-09-1905-tasks-share
**Phase:** 2 — spec
**Agent:** orchestrator (acting as freelo-api-specialist for endpoint reconciliation)

**Question:** The roadmap line says `POST /public-link/task/{task_id}`. The OpenAPI spec at `docs/api/freelo-api.yaml:2137-2152` documents this as `GET` with explicit "GET that creates" semantics. Which is authoritative?

**Decision:** Use `GET` per the OpenAPI spec.

**Alternatives considered:**
- Implement as `POST` per the roadmap shorthand → the OpenAPI explicitly documents `GET`; sending POST would 404 against a real Freelo server.
- Pause and ask the human → the OpenAPI **does** answer the question (yaml :2137 explicit on the verb). The autonomous-sdlc rule "Never guess API behavior. If `docs/api/freelo-api.yaml` doesn't answer the question, pause" is conditioned on yaml silence. Here the yaml is explicit; pausing would be over-cautious.
- Implement both verbs → speculative; doubles surface; no upside.

**Rationale:** OpenAPI is the authoritative API contract per `.claude/CLAUDE.md`. The roadmap shorthand was written before the API was inspected in detail. Following the yaml is consistent with how every prior R-line has implemented its endpoints. The user-facing CLI surface (`share` / `unshare`) matches the roadmap exactly; only the wire verb changes.

The "GET that creates" pattern is unusual but documented. The CLI wraps Freelo as it is, not as it should be.
