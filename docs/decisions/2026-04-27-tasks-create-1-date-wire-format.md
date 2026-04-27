# Decision 1 — `due_date` wire format

**Run:** 2026-04-27-tasks-create
**Phase:** spec
**Agent:** orchestrator (acting as architect)

**Question:** The OpenAPI declares `due_date` as `format: date-time` but the CLI flag is `--due YYYY-MM-DD`. Send what on the wire?

**Decision:** Append `T00:00:00Z` and send `YYYY-MM-DDT00:00:00Z`.

**Alternatives considered:**
- Send the raw `YYYY-MM-DD` and let Freelo coerce — fragile if the server tightens the parser.
- Send local-time-of-day (e.g. user's TZ midnight) — introduces TZ pitfalls; CLI user has not specified a TZ.

**Rationale:** Predictable, matches how Freelo echoes `due_date` back in `TaskCreated`, no TZ guess.
