# Decision 3 — Single-id v1; no batch in R35

**Run:** 2026-05-09-1200-tasks-remind
**Phase:** spec
**Agent:** orchestrator (architect role)

**Question:** Should `set` / `clear` support batch input (`--ids` / `--stdin`) like `tasks delete` / `tasks finish` etc.?

**Decision:** No. Single-id only.

**Alternatives considered:**
- Mirror `tasks delete` (R13) batch shape on both leaves — `set` requires per-row `--at` so positional `<id>...` doesn't suffice; would force `--stdin` NDJSON only, which is an asymmetric surface vs `clear`.
- Ship batch on `clear` only — asymmetric across two siblings; UX surprise.

**Rationale:** Keep the slice small and landable. The roadmap line for R35 is single-id; batch is not asked for. If demand emerges, R35.5 can add NDJSON-batch with consistent semantics for both leaves at once.
