# Decision 2 — Defer `--editor` to R15

**Run:** 2026-04-27-tasks-create
**Phase:** spec
**Agent:** orchestrator (acting as architect)

**Question:** Roadmap lists `--editor` for R09 but the invocation says it may be deferred to R15 (`tasks description set`). Include it now or defer?

**Decision:** Defer to R15.

**Alternatives considered:**
- Include `--editor` now — would require introducing terminal-editor I/O (`$EDITOR` discovery, tmpfile, post-edit read) for one slice that has two simpler description paths. Editor I/O is shared infra better introduced where it's most-used (R15 is the natural home — description set is editor-shaped by nature).
- Add a stub now and wire it in R15 — needless complexity.

**Rationale:** The invocation explicitly permits the scope-down. R09 is already shipping the bigger shared write infra; adding terminal-editor I/O on top is over-loaded for one slice.
