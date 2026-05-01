# Decision 2 — Inline-construct the array-shape dry-run envelope

**Run:** 2026-05-01-0652-tasks-create-label-fix
**Phase:** plan
**Agent:** orchestrator

**Question:** Should `src/lib/dry-run.ts` grow a `dryRunEnvelopeArray<T>`
helper, or should the array-shape `would` be inline-constructed in
`tasks/create.ts`?

**Decision:** Inline-construct.

**Alternatives considered:**
- Add `dryRunEnvelopeArray` to `src/lib/dry-run.ts`.
- Refactor existing `dryRunEnvelope` to accept `Would | Would[]`.

**Rationale:** R10 (`tasks edit`) already constructs an array-shape `would`
inline (the precedent exists). Adding a sibling helper for one new caller
expands the helper's surface for no payoff. Refactoring `dryRunEnvelope` to a
union type would touch every caller (R11/R12/R13) for a strict-superset of
their needs. Single-call dry-runs keep using `dryRunEnvelope`; multi-call
dry-runs (R09 after this fix, R10) build the envelope manually. Cheap and
keeps the helper focused.
