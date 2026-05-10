# Decision 1 — Drop `notes list` from R44

**Run:** 2026-05-10-r44-notes-pins
**Phase:** Spec (resume)
**Agent:** orchestrator (resume answer A from human)

**Question:** OpenAPI defines no project-scoped notes/documents listing endpoint. How should the CLI surface for `notes list` reconcile with the contract?
**Decision:** Drop `notes list` from R44; ship 7 commands. Document the gap in spec 0058 §5 Non-goals; reserve for R45+ when an endpoint becomes available.
**Alternatives considered:**
- B. Pause R44 entirely until Freelo provides a listing endpoint.
- C. Pluck `documents`/`notes` from `GET /project/{id}` if they're embedded.
- D. Split into R44a (pins) + R44b (notes minus list) — same outcome, more PRs.
- E. Abort R44 entirely.
**Rationale:** Option A is the safest "ship what the API supports" path. The discoverability gap is real (users must know a note id to use show/edit/delete), but a fragile workaround (Option C) would couple the CLI to an undocumented embed shape, and pausing (B/E) would block Wave 7 closure indefinitely.
