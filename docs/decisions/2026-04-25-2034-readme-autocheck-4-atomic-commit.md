# Decision 4 — Atomic single-commit rollout

**Run:** 2026-04-25-2034-readme-autocheck
**Phase:** implement (orchestrator)
**Agent:** orchestrator

**Question:** Ship as one commit or two (script first, README+CI second)?
**Decision:** One atomic commit.
**Alternatives considered:**
- Two commits per the plan in `0006-readme-autocheck.md`. Better narrative, but commit 1's tree would fail `pnpm check:readme` (the gate the same commit introduces).
**Rationale:** Every commit on the branch should pass the full gate so bisect stays useful. The script and the README it checks are inherently co-authored — there is no real prior art for either alone in the repo.
