# Decision 8 — `--project` allowed only as `--dry-run` escape hatch

**Run:** 2026-04-27-tasks-create
**Phase:** spec
**Agent:** orchestrator (acting as architect)

**Question:** Should `--project` ever be a CLI flag, given decision 3 derives the project id?

**Decision:** Allow `--project <id>` only when `--dry-run` is set; without `--dry-run`, `--project` is a `ValidationError`.

**Alternatives considered:**
- Always allow `--project` and skip the lookup if set: agents could pass mismatched ids; lookup-and-verify defeats the savings.
- Never allow `--project`: loses a lookup-free dry-run path.

**Rationale:** Dry-run is a no-side-effect rehearsal; saving one HTTP round-trip is worth letting the user opt out of the lookup. In live mode the derived value is authoritative. Mismatch is impossible.
