# Decision 2 — Did not unilaterally ship the safe half of the slice

**Run:** 2026-08-29-2230-r14-subtask-type
**Phase:** Spec / pause
**Agent:** orchestrator

**Question:** The slice decomposes into a non-breaking half (declare `Subtask.type`) and a breaking half (retire `inferStorageForm`). Should the orchestrator land the safe half now and pause only on the second?

**Decision:** No. Pause on the whole slice and offer the split as option A of the pause.

**Alternatives considered:**

- Land the declaration on a branch, open a Yellow PR, and pause separately on the derivation. Delivers something and keeps momentum.
- Pause on everything with no artifacts. Cheapest, least useful.

**Rationale:** Splitting a requirement is a scope decision, and the requirement set an explicit scope boundary ("this slice is `Subtask.type` and the `storage_form` derivation that depends on it") — the two were deliberately paired. Shipping half would also lock in the lenient-vs-strict enum question (spec 0069 §6) before OQ-2 is answered, and a declared-but-unused `type` is a third state nobody asked for. The split is a good option, so it is presented as one rather than taken.
