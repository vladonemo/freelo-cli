# Decision 7 — Batch exit code: 1 > 2 > 0

**Run:** 2026-04-27-tasks-create
**Phase:** spec
**Agent:** orchestrator (acting as architect)

**Question:** When some lines succeed and some fail, what exit code does the process return?

**Decision:** Numerically highest per-line exit code wins. The repo's error hierarchy uses 2 (validation), 3 (auth-expired), 4 (generic HTTP / forbidden / 5xx), 5 (network), 6 (rate-limited). Stream continues regardless of per-line failures.

**Alternatives considered:**
- All-or-nothing (any failure → 1, success → 0): coarser, agents lose the per-class signal.
- Abort on first failure: throws away successful work already streamed.
- Exit 0 always (failures appear in the NDJSON only): silent breakage; agents would have to parse stdout to know.

**Rationale:** Mirrors POSIX practice where the most-severe failure dominates and aligns with the canonical exit-code mapping in `src/errors/*.ts`. Agents that script around exit codes already key off these values; the batch exit becomes a natural max-of-class signal.
