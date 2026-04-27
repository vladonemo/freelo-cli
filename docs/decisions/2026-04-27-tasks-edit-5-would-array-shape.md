# Decision 5 — `data.would` is `Would[]` here, not single `Would`

**Run:** 2026-04-27-tasks-edit
**Phase:** Spec / Implement
**Agent:** orchestrator (delegated to architect)

**Question:** R09's `dryRunEnvelope` types `would` as a single `Would` object. R10's edit fans out across up to 3 endpoints. How do we represent that?

**Decision:** Build R10's dry-run envelope inline. `data.would` is an array. Don't generalize `dryRunEnvelope`.

**Alternatives considered:**
- Generalize `dryRunEnvelope` to accept `Would | Would[]`.
- Build inline (chosen).

**Rationale:** R10 is the only caller that needs an array — R11/R12 are likely single-call again. Generalizing now is premature; we'd be designing for a hypothetical R-future. The shared helper's contract stays small and tested as-is.
