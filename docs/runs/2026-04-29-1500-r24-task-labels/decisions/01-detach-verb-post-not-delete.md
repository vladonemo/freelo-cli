# Decision 01 — Detach verb is POST per OpenAPI, not DELETE per roadmap

**Run:** 2026-04-29-1500-r24-task-labels
**Phase:** Spec
**Agent:** orchestrator (architect role)

**Question:** roadmap.md says `DELETE /task-labels/remove-from-task/{task_id}` but OpenAPI yaml :2531 says POST. Which wins?

**Decision:** POST. OpenAPI is the canonical contract per `.claude/docs/autonomous-sdlc.md` ("Spec says something the OpenAPI spec contradicts — Pause — Freelo's contract is authoritative"). The discrepancy is unambiguous (OpenAPI verb is `post:`); no pause needed.

**Alternatives considered:**
- DELETE — would either fail at runtime or hit a different (likely 404) endpoint; would put the CLI out of sync with the documented API.
- Pause and ask — unnecessary; the precedent (R23 spec 0035 decision 02) made the same call for `project-labels` detach with no human input.

**Rationale:** The CLI must reflect the actual API. Roadmap copy is informal and known to drift; OpenAPI is generated/maintained.
