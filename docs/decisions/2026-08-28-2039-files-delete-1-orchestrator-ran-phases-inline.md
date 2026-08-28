# Decision 1 — Orchestrator ran every phase inline (sub-agent delegation unavailable)

**Run:** 2026-08-28-2039-files-delete
**Phase:** bootstrap (affects all phases)
**Agent:** orchestrator

**Question:** The `Task` tool — the only mechanism for invoking specialist sub-agents — is disabled in
this session. Should the run pause, or should the orchestrator execute each phase's mandate itself?

**Decision:** Execute every phase inline, reading each specialist's definition in `.claude/agents/` first
and following its mandate and output contract (triage report, spec/plan format, implementer rules,
test-writer calibration checklist, code-reviewer checklist, doc-writer README duty). All phase artifacts
are produced at the same paths a delegated run would produce.

**Alternatives considered:**

- Pause immediately with "cannot delegate". Correct only if delegation were load-bearing for
  *correctness*; it isn't — it is a context-isolation and parallelism mechanism.
- Skip the phases that most depend on an independent reviewer (review, security). Rejected outright:
  calibration §1 is explicit that an interrupted or degraded run must still run every remaining phase.
- Run the pipeline but silently, without noting the degradation. Rejected — the audit trail would
  misrepresent how the work was produced.

**Rationale:** The tool outage is an environmental constraint, not a policy trigger; none of the pause
conditions in `autonomous-sdlc.md` §Pause protocol is met. The phases are gates on *the work*, not on
which process performs it, so running them inline preserves the contract. The material cost is the loss
of independent-reviewer framing in phase 7 — noted honestly in the review report and in the PR body
rather than papered over, so a human reviewer can weight the self-review accordingly.
