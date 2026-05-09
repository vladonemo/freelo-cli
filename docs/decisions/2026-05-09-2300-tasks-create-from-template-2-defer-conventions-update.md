# Decision 2 — Defer `conventions.md` update on API-level branch tests

**Run:** 2026-05-09-2300-tasks-create-from-template
**Phase:** test (orchestrator-level scoping decision)
**Agent:** orchestrator

**Question:** The invocation note suggested adding the calibration-§4 finding (R38 PR #96 — every API wrapper needs sibling unit tests covering `signal` / `requestId` opt-spread branches) to `.claude/docs/conventions.md` "if it fits without scope creep on R39." Should the conventions file get the update inside this PR?

**Decision:** Defer. Surface as a follow-up.

**Alternatives considered:**

- Add a short paragraph to `conventions.md` in this PR → rejected; adds a docs file outside the spec's plan, requires its own review pass, blends a docs-only change with a feature PR. Yellow-tier discipline keeps the slice tight.
- Inline the convention as a code comment in `tasks-create-from-template.ts` → already done implicitly (the test file's docblock cites calibration §4 explicitly).
- Open a separate `docs(conventions)` PR after this one → recorded here as the recommended path.

**Rationale:** The calibration log in `.claude/docs/autonomous-sdlc.md` §4 already captures this rule; promoting it into `conventions.md` is mostly cosmetic at this point — the orchestrator-level plan now bakes the rule into every "new API wrapper" slice (R37, R38, R39 all carried it explicitly). A dedicated docs slice can elevate it to a code-style rule without scope-creeping a feature PR.

**Follow-up:** open a tiny `docs(conventions): API wrappers must have signal/requestId branch tests` PR off `main` (post-merge of R39). Cite calibration §4, link to R38 PR #96 as the canary.
