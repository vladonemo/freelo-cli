# Decision 8 — Spec numbered 0062 to dodge the sibling runs' 0061 collision

**Run:** 2026-08-25-1037-task-labels-find
**Phase:** spec
**Agent:** orchestrator

**Question:** `main` has specs through 0060, so the next number is 0061 — but both open sibling PRs already claim it. What number does this run take?

**Decision:** `docs/specs/0062-m04-task-labels-find.md`.

**Alternatives considered:**

- Take 0061 as `main` implies. Rejected: it would be the *third* file named `0061-*`, guaranteeing a collision with whichever sibling merges first and turning a docs rename into a merge conflict on an otherwise clean tree.
- Take 0063 to leave room for both siblings. Rejected: PR #113 (`0061-m01-comments-delete`) and PR #114 (`0061-tasks-list-order-by-due-date`) collide with *each other* regardless; whoever merges second must renumber anyway. Reserving 0063 would just strand 0062.
- Pause and ask which number to use. Rejected: pure bookkeeping, no scope or UX content — squarely a "decide, log" per §Autonomous decisions.

**Rationale:** Checked both open PRs' file lists before choosing rather than trusting `main`'s high-water mark, exactly as calibration §6 requires for branch state. 0062 is unclaimed by `main` and by both siblings, so this PR merges cleanly in any order. The #113/#114 collision is theirs to resolve and is called out in the run summary so it isn't discovered at merge time.
