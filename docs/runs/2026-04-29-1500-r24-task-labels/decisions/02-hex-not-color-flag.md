# Decision 02 — Color flag named `--hex` (not `--color`)

**Run:** 2026-04-29-1500-r24-task-labels
**Phase:** Spec
**Agent:** orchestrator (architect role)

**Question:** roadmap signature uses `--color <hex>` but the root program already binds `--color <mode>` (auto/always/never) for output colorization. Conflict.

**Decision:** Use `--hex <color>` for all three task-labels subcommands.

**Alternatives considered:**
- Keep `--color <hex>` — conflicts with the global; would either get shadowed or require subcommand-local override semantics that confuse users.
- Use `--label-color <hex>` — verbose; no precedent in the codebase.

**Rationale:** Mirrors R23 spec 0035 decision 11 exactly (same conflict, same resolution). Keeps the global `--color <mode>` semantics intact (`freelo --color always task-labels create --hex "#abc123" --name foo` parses cleanly).
