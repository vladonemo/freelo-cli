# Decision 3 — `applied_filters.type` carries the wire form, not the CLI short form

**Run:** 2026-04-29-1756-r26-files-list
**Phase:** spec
**Agent:** architect

**Question:** When the user passes `--type doc` (CLI short form), the envelope echoes the filter under `data.applied_filters.type`. Should that string be `'doc'` (what the user typed) or `'document'` (the wire enum value)?

**Decision:** Wire form (`'document'`). Same for `dir` → `'directory'`. The other two (`file`, `link`) collide between CLI and wire so there's no observable difference for those.

**Alternatives considered:**
- **CLI form (`'doc'`).** Echoes the user's input verbatim. But agents pin against the envelope schema and frequently round-trip through Freelo's REST directly — the envelope's job is server-shape alignment. Returning `'doc'` forces every consumer to learn the CLI's shorthand vocabulary on top of the wire's.
- **Both (`{ user: 'doc', wire: 'document' }`).** Over-engineered for a single-letter savings. Out.

**Rationale:** Envelope `applied_filters` is a wire-aligned echo, not a CLI-form audit log. R21's `applied_filters.tasks` carries integer IDs that map directly to `tasks_ids[]`; R26's `applied_filters.type` should map directly to wire `type`. Schema docs the wire form explicitly.

If someone later wants the CLI form for some reason, that's an **additive** field (`applied_filters.type_cli: 'doc'`) on a future minor bump — no schema break.
