# Phase 2 — Spec

**Artifact:** `docs/specs/0059-tasks-edit-response-validation.md`
**Result:** Blocked — two unresolvable Open questions → pause per
`.claude/docs/autonomous-sdlc.md:75`.

- **OQ-1** What does `POST /task/{id}` actually return? Unresolvable offline; the
  OpenAPI asserts a shape the evidence contradicts, and no fixture captures a real body.
- **OQ-2** Should `editTask` validate a payload it provably discards? Defensible without
  the body, but it inverts a tested exit-4 contract — a maintainer call.

Two decision records written (`docs/decisions/2026-07-27-1211-tasks-edit-validation-1…`,
`…-2…`). `## Plan` deliberately not appended: the plan is the contract, and a plan built
on an invented response shape is worse than no plan.

Phases 3-9 (implement, test, review, document, commit/push/PR) not entered.
