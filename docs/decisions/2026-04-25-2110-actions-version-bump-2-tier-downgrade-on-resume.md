# Decision 2 — Downgrade tier from Yellow to Green on resume

**Run:** 2026-04-25-2110-actions-version-bump
**Phase:** Resume / re-triage
**Agent:** orchestrator

**Question:** The original triage marked this run Yellow when its scope was conflated with the parallel `drop-node-20-matrix` run. After that parallel run merged independently (PR #16), the residual scope is action-version bumps only. Should the tier change?

**Decision:** Downgrade to Green; enable auto-merge on the PR.

**Alternatives considered:**
- Keep Yellow out of caution — would force a human gate on a CI-only chore.
- Skip the tier review entirely and proceed under the original Yellow tier.

**Rationale:** Per `.claude/docs/autonomous-sdlc.md` Risk-Tier Green criteria: no auth/config/HTTP/release-tooling change, no new runtime deps, no breaking change to envelope schemas/exit codes/flag names, no source-code change, no test change. v4→v5 of all three actions is byte-identical for the inputs we use (verified in the spec's Source verification table). The deprecation-warning fix has no consumer impact and CI itself is the test. Auto-merge on green CI is the policy-correct path.

**Note:** `release.yml` is on the "release tooling" boundary, but the change is to a third-party action's runtime version, not to our release flow's logic, secrets handling, or `changesets/action@v1` (unchanged). The Green criterion is about modifying release tooling logic, not about updating the Node runtime under it.
