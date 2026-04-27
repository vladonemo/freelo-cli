# Decision 15 — Skip `POST /task/{id}` when no edit fields are set (label-only mode)

**Run:** 2026-04-27-tasks-edit
**Phase:** Implement
**Agent:** implementer

**Question:** If only `--add-label` and/or `--remove-label` are passed (no name/worker/due/priority), do we still POST to `/task/{id}` with an empty body?

**Decision:** Skip the POST entirely.

**Alternatives considered:**
- Always POST (consistency).
- Skip when body is empty (chosen).
- POST with `{}` and let the server decide (server silently ignores via `array_intersect_key`, so it'd be a no-op anyway).

**Rationale:** The Freelo facade silently ignores unknown keys via `array_intersect_key` against the whitelist; an empty body is a no-op. Saving the round-trip is a free win. Idempotency preserved.
