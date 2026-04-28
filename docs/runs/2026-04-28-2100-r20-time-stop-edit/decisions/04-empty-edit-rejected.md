# Decision 4 — Reject empty edit at the command layer

**Run:** 2026-04-28-2100-r20-time-stop-edit
**Phase:** spec
**Agent:** orchestrator (architect role)

**Question:** Should `freelo time edit` (no flags) be a no-op success, a server round-trip, or a usage error?
**Decision:** Usage error. `ValidationError` exit 2 with hint about needing at least one flag.
**Alternatives considered:**
- Success exit 0 with `applied_changes: {}` and no POST — rejected; hides typos and accidental flag drops.
- Send `POST {}` and let the server decide — rejected; one round trip per accident, undocumented server response.
**Rationale:** Mirror R10 `tasks edit` precedent (skip-empty-edit decision). Catch boundary errors before the network call.
