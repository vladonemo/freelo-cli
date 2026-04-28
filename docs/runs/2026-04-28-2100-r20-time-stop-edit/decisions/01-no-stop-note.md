# Decision 1 — Drop `--note` on `time stop`; route notes through `time edit`

**Run:** 2026-04-28-2100-r20-time-stop-edit
**Phase:** spec
**Agent:** orchestrator (architect role)

**Question:** The roadmap proposes `freelo time stop [--note <str>]`. Should the CLI ship that flag?
**Decision:** No. Ship `time stop` with no flags except `--dry-run`.
**Alternatives considered:**
- Send `{ note: "..." }` body to `/timetracking/stop` — rejected; OpenAPI documents no body, sending one would be guessing API behavior.
- Pause for human guidance — rejected; the alternate path is composable and obvious.
**Rationale:** Hard rule: never guess API behavior. The `time edit --note "..." && time stop` chain is two API calls, both documented, and ships in this same slice.
