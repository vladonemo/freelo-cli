# Decision 3 — Single-row CI job for `check:readme`

**Run:** 2026-04-25-2034-readme-autocheck
**Phase:** spec (architect)
**Agent:** orchestrator (delegated)

**Question:** Should `pnpm check:readme` run on the full 9-cell test matrix, or a single row?
**Decision:** Single row — `ubuntu-latest` + Node 24, separate `check-readme` job.
**Alternatives considered:**
- Add to the existing matrix — burns 9 jobs for a deterministic string check.
- Add to a single matrix cell with `if:` — clutters the test job with a conditional.
**Rationale:** The renderer is a pure JSON-to-string transform with sorted output and LF line endings. There is no OS- or Node-version-dependent behavior. The matrix already validates the build on every cell; a separate, dedicated job keeps the signal clean and saves CI minutes.
