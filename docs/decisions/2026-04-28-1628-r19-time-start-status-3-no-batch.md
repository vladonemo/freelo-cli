# Decision 3 — No batch / `--ids` / `--stdin` for `time start`

**Run:** `2026-04-28-1628-r19-time-start-status`
**Phase:** Spec
**Agent:** orchestrator (architect role)

**Question:** Should `time start` ship batch input (`--ids` / `--stdin`) for parity with R09 / R11 / R13 / R18?

**Decision:** No. Document the omission explicitly in the spec.

**Alternatives considered:**
- Ship `--stdin` accepting a single line — rejected; batch-of-1 is API noise without value.
- Ship `--stdin` with all-but-the-first failing 409 — rejected; useless UX and 409-error spam.
- Build `--stdin` to call `time stop` then `time start` per row — rejected; out of scope, not what the user asked for, and conflates two different API contracts.

**Rationale:** API-level singleton constraint (yaml :2735, "at most one running session per user") makes batch input semantically meaningless. A successful batch can never have more than one row. Shipping `--stdin` would mislead agents into thinking otherwise. The CLI's batch convention is for plural-target writes, not singleton ones.
