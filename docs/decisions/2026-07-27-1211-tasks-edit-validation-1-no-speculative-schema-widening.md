# Decision 1 — Do not widen `TaskDetailSchema` to clear the symptom

**Run:** 2026-07-27-1211-tasks-edit-validation
**Phase:** Triage / Spec
**Agent:** orchestrator

**Question:** Should the run apply the `MinutesSchema` / `CurrencySchema.amount`
union-and-coerce precedent to the fields named in issue #105 hypotheses 2-6 so
`tasks edit --name` stops failing?

**Decision:** No. Pause instead.

**Alternatives considered:**

- Widen all six suspect spots (`state`, `labels[].uuid`, `priority_enum`, `cost`, id
  types, top-level wrapper) at once.
- Widen only the single highest-ranked field.
- Make `TaskDetailSchema` match the OpenAPI literally — the YAML declares no `required`
  list on `TaskDetail`, `State`, `TaskLabel`, or `Currency`, so strictly every property
  is optional and our zod is stricter than the documented contract.

**Rationale:** The pre-POST lookup GET at `src/commands/tasks/edit.ts:331` uses the same
schema on the same task and did not fail, which eliminates hypotheses 2-6 — widening
them would fix nothing while degrading validation on `tasks show`, `tasks move`, and the
refresh GET. The third alternative is provable but re-litigates a deliberate design
decision (specs 0009/0017: "only `id` and `name` are universally required"), and is
exactly the "widen until the symptom disappears" the requirement forbids. The
union-and-coerce precedent does not transfer because both prior widenings were anchored
to an observed concrete divergence; here there is no observation to anchor to.
