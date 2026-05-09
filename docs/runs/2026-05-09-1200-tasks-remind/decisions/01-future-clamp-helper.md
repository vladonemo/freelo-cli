# Decision 1 — New `parseIsoTimestampFutureFlag` helper

**Run:** 2026-05-09-1200-tasks-remind
**Phase:** spec / implement
**Agent:** orchestrator (architect role)

**Question:** Should `tasks remind set --at` reuse `parseIsoTimestampFlag` (R19.5)?

**Decision:** No. Introduced `src/lib/iso-timestamp-future.ts` exporting `parseIsoTimestampFutureFlag` — same canonicalization rule, inverted clamp direction (rejects past >60 s instead of future >60 s). Reuses `ISO_TIMESTAMP_FUTURE_SKEW_MS` from the sibling.

**Alternatives considered:**
- Reuse `parseIsoTimestampFlag` as-is — rejects futures, which is exactly what reminders need.
- Add a `direction` parameter to the existing helper — widens an in-use surface for one new caller.
- Pass `now = +Infinity` to skip the clamp — loses past-direction validation entirely.

**Rationale:** Two narrow single-direction helpers are clearer than one bidirectional helper with a mode flag. ~5 lines of duplication is acceptable cost for clarity.
