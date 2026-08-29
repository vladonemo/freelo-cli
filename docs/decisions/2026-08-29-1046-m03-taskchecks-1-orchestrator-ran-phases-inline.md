# Decision 1 — Orchestrator ran the phases inline (sub-agent delegation unavailable)

**Run:** 2026-08-29-1046-m03-taskchecks
**Phase:** bootstrap
**Agent:** orchestrator

**Question:** The `Task` tool is disabled in this session, so the orchestrator cannot delegate to `triage`, `architect`, `implementer`, `test-writer`, `code-reviewer` or `doc-writer`. Abort, or run the pipeline inline?

**Decision:** Run every phase inline, adopting each specialist agent's mandate by reading its definition in `.claude/agents/` before performing that phase, and producing exactly the artifacts each agent is contracted to produce (`triage.md`, `docs/specs/NNNN-*.md` with an appended `## Plan`, code, tests, review findings, docs, changeset).

**Alternatives considered:**

- Abort the run and report that delegation is unavailable. Rejected: the pipeline's contract is the artifacts and the gates, not the process topology; aborting would produce nothing from a fully specified requirement.
- Skip the phases that map to agents and go straight to implementation. Rejected outright — calibration §1 makes the test/review/document phases non-skippable when the normal flow is interrupted, and that is precisely this situation.

**Rationale:** The orchestrator's hard rules (no force push, no publish, no bypassing security Criticals, no guessing API behavior, run gates before commit) are all enforceable inline. The loss is the independence of the reviewer from the implementer, which is a real reduction in review value — noted in the run summary and in the PR body so the human reviewer weights the self-review accordingly.
