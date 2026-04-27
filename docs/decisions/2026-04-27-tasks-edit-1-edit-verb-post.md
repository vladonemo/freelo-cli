# Decision 1 — Edit verb is POST, not PATCH

**Run:** 2026-04-27-tasks-edit
**Phase:** Spec
**Agent:** orchestrator (delegated to architect)

**Question:** Roadmap says "PATCH /task/{task_id} (or the spec's edit verb)". Which verb does R10 use?

**Decision:** POST.

**Alternatives considered:**
- PATCH — implied by REST conventions and roadmap text.
- POST — what `docs/api/freelo-api.yaml` :1690-1762 actually documents.

**Rationale:** The OpenAPI is the authoritative contract. It documents `POST /task/{task_id}` for partial edits with the editable-fields whitelist. PATCH is not exposed. The roadmap text explicitly defers to the spec's verb.
