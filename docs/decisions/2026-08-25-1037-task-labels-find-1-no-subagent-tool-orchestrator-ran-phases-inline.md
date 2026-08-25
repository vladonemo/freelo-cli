# Decision 1 — No subagent tool available; phases run inline against agent mandates

**Run:** 2026-08-25-1037-task-labels-find
**Phase:** bootstrap
**Agent:** orchestrator

**Question:** The orchestrator's mandate is to delegate every substantive phase to a specialist agent, but this session was launched without a Task/subagent tool — only file and bash tools. Pause, or run the phases directly?

**Decision:** Run every phase inline, executing each specialist's own mandate file (`.claude/agents/triage.md`, `architect.md`, `implementer.md`, `test-writer.md`, `code-reviewer.md`, `doc-writer.md`) as the instruction set for that phase. All phase gates, artifacts and calibration rules were honored unchanged.

**Alternatives considered:**

- Pause immediately with "cannot delegate". Rejected: delegation is the orchestrator's *mechanism*, not the SDLC's contract. `sdlc.md` defines phases, gates and artifacts; none of those require a separate process. Pausing would have burned the run on a tooling detail with a clear workaround.
- Shell out to a nested `claude -p` per phase. Rejected: slow, unbudgeted, and it would fragment the run's context across processes for no gain in rigor.
- Skip the phases that read most like "agent work" (review, document). Rejected outright — calibration §1 exists precisely because a prior run was tempted to skip phases after an interruption.

**Rationale:** The binding docs make phases and artifacts mandatory and the delegation mechanism incidental. Running inline preserved every gate that actually protects the codebase (lint/typecheck/test on the committed tree, exit-code assertions, review checklist, changeset). Recording it here so the audit trail doesn't imply seven agents were consulted when one process did the work.
