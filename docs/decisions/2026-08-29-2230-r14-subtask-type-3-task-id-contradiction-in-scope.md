# Decision 3 — Treated the `task_id` contradiction as in-scope evidence, not scope creep

**Run:** 2026-08-29-2230-r14-subtask-type
**Phase:** Spec
**Agent:** orchestrator

**Question:** The yaml says `taskcheck` implies `task_id` is null, while spec 0025 and the shipped unit test model the simple shape as carrying `task_id`. The scope boundary excludes unrelated schema work. Is this contradiction in scope?

**Decision:** In scope as evidence, out of scope as a fix. It is recorded in spec 0069 §3.1 and drives OQ-1; no `task_id` code or fixture was changed.

**Alternatives considered:**

- Ignore it as an unrelated contract issue and assess `type` on vocabulary alone.
- Chase it: correct the fixtures and the `task_id` semantics as part of this slice.

**Rationale:** It is not a side issue — it determines whether switching to `type` is a narrow bug fix or a broad behavior change, which is exactly point 3 of the requirement. Without it the pause question would be mis-framed as "rare corner case, probably fine". Fixing it, however, would mean rewriting shipped fixtures on an unverified reading of the yaml, which is the guessing the pause exists to prevent.
