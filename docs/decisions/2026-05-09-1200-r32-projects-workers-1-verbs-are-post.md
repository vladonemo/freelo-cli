# Decision 1 — Wire verbs are POST, not DELETE

**Run:** 2026-05-09-1200-r32-projects-workers
**Phase:** spec
**Agent:** orchestrator (verified against OpenAPI directly — no specialist call needed)

**Question:** The roadmap says `DELETE /project/{id}/remove-workers/by-{ids,emails}`. What do the endpoints actually use?

**Decision:** Both endpoints are `POST`, per `docs/api/freelo-api.yaml` :677 and :719. The OpenAPI is the binding contract.

**Alternatives considered:**
- Trust the roadmap and ship `DELETE`. Rejected — would 405 immediately at the server.
- Probe a live test account via `freelo-api-specialist`. Not needed — the OpenAPI is unambiguous and self-consistent (POST with documented body schemas).

**Rationale:** Wire verb mismatches fail noisily but are still avoidable bugs. The OpenAPI was the source of truth on R31 (where `--date-start` was kept because the body schema documented it) and on R29 (where `--date-start` was deferred for the same reason); R32 follows the same rule.
