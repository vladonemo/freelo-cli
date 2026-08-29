# Decision 1 — Orchestrator ran every phase inline; sub-agent delegation was unavailable

**Run:** 2026-08-29-0921-tasklists-edit
**Phase:** 0 (bootstrap)
**Agent:** orchestrator

**Question:** `.claude/docs/autonomous-sdlc.md` mandates delegation to `triage`, `architect`, `implementer`, `test-writer`, `code-reviewer` and `doc-writer`. The `Task` tool is disabled for this session, in subagents as well as at the top level. Halt, or proceed inline?

**Decision:** Proceed, running every phase inline against each specialist agent's mandate, with all phase gates, artifacts, and the decision log produced exactly as delegation would have.

**Alternatives considered:**

- Pause immediately with "sub-agent delegation unavailable" and hand back to the human.
- Skip phases that are hardest to self-perform (review, security) and ship a shorter pipeline.

**Rationale:** The tooling constraint is environmental, not a signal about the requirement, so a pause would burn a run to report an infrastructure fact the human can already see. Skipping phases is barred by calibration §1 ("when any phase is interrupted... MUST run every remaining phase"). The compensating control is that the *gates* — lint, typecheck, `test:cov` on the committed tree, build, `check:readme`, calibration §2 exit-code assertions and §7 CI-clearing — are mechanical and unaffected by who invokes them. Precedent: M07 made the same call (`2026-08-28-2039-files-delete-1-orchestrator-ran-phases-inline.md`).

**Weakness accepted and logged:** self-review is genuinely weaker than an independent `code-reviewer` pass — the same context that wrote the code judges it. Recorded in the PR body so the human reviewer knows to weight their own review more heavily than usual. Tier is Yellow, so a human reviews before merge regardless.
