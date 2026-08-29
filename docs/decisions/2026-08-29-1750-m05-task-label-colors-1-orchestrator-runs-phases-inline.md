# Decision 1 — Orchestrator executes phases inline (no sub-agent tool available)

**Run:** 2026-08-29-1750-m05-task-label-colors
**Phase:** bootstrap
**Agent:** orchestrator

**Question:** How should the pipeline run when the session exposes no agent-spawning tool, so `triage`, `architect`, `implementer`, `test-writer`, `code-reviewer` and `doc-writer` cannot be invoked as separate agents?

**Decision:** Run every phase inline in the orchestrator, applying each specialist's mandate from `.claude/agents/<name>.md` in sequence, and produce the identical artifact set (triage report, spec, plan, code, tests, docs, changeset, decision log, summary). Phase order, gates and retry semantics are unchanged.

**Alternatives considered:**

- Pause immediately and report the missing capability. Rejected: the requirement is fully specified, the tooling gap is environmental, and pausing would spend the run's budget on nothing.
- Skip the phases whose agent is unavailable (e.g. go straight from spec to implement). Rejected outright — this is exactly the shortcut calibration §1 was written to forbid.

**Rationale:** The agents are mandates, not magic; what makes the SDLC binding is the artifacts and the gate order, both of which are reproducible inline. The one real loss is adversarial independence — a self-review is weaker than a separate reviewer, and that is recorded as a known limitation in the run summary rather than papered over.
