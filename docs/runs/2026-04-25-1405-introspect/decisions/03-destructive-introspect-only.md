# Decision 3 — `destructive` is introspect-only, no runtime side effects

**Run:** 2026-04-25-1405-introspect
**Phase:** Spec
**Agent:** orchestrator

**Question:** Should `meta.destructive: true` automatically force a confirmation prompt or `--yes` requirement at runtime?

**Decision:** **No.** R02.5 surfaces `destructive` in the introspect envelope only. Runtime confirmation behavior is decided by each command (R09+ scope). Wiring `destructive` into the global preAction hook would be cross-cutting behavior change.

**Alternatives considered:**
- Add a `program.hook('preAction', …)` that intercepts when current command's `meta.destructive === true` and stdin is not a TTY and `--yes` is not set — throw `ConfirmationError`. Rejected as scope creep.

**Rationale:** Roadmap §R02.5 says "introspection only". Coupling runtime behavior to introspection now would also force every later destructive command to declare its policy here, away from the command itself. Captured as an Open question in §6 of the spec instead, deferred to R09+.
