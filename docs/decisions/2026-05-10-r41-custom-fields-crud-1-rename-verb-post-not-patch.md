# Decision 1 — rename verb is POST (not PATCH as the roadmap says)

**Run:** 2026-05-10-r41-custom-fields-crud
**Phase:** triage / spec
**Agent:** orchestrator

**Question:** Roadmap entry says `PATCH /custom-field/rename/{uuid}`. OpenAPI says `POST`. Which is the source of truth?

**Decision:** OpenAPI (`docs/api/freelo-api.yaml:4097-4136`) — verb is `POST`.

**Alternatives considered:**
- Use PATCH → contradicts the binding rule "Never guess API behavior. If `docs/api/freelo-api.yaml` doesn't answer the question, pause and ask `freelo-api-specialist` to capture a fixture." OpenAPI does answer it: POST.
- Pause for human resolution → unnecessary; the OpenAPI is unambiguous and the codebase has clear precedent (R23 labels rename — spec 0035 decision 01 — which made the same call: roadmap-vs-OpenAPI mismatch on rename verb, OpenAPI wins).

**Rationale:** The OpenAPI `paths:` block at `:4097-4136` shows `post:` keyed at `/custom-field/rename/{uuid}`. The roadmap is rough guidance; the OpenAPI is the contract. R23 labels rename hit the identical pattern and resolved it the same way.
