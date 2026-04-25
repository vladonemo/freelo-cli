# Decision 5 — Use `VALIDATION_ERROR` (not a new `INTROSPECT_UNKNOWN_COMMAND` code)

**Run:** 2026-04-25-1405-introspect
**Phase:** Implement
**Agent:** orchestrator

**Question:** Spec §2.2 mentioned `INTROSPECT_UNKNOWN_COMMAND` as the error code for unknown command paths. The existing typed-error hierarchy (`src/errors/base.ts`) makes `code` a fixed `readonly` per error class; `ValidationError.code` is hard-coded to `'VALIDATION_ERROR'`. Adding a new error class (or making `code` overridable) is scope creep.

**Decision:** Use the existing `ValidationError` (`code: 'VALIDATION_ERROR'`, exit 2) for unknown command paths. The `field: 'commandPath'` plus a clear message ("Unknown command 'xxx'.") and `hintNext` give agents enough to react. No new error subclass.

**Alternatives considered:**
- Introduce `IntrospectError extends BaseError`. Rejected: fresh error class for a single error case is overhead.
- Make `BaseError.code` overridable via options. Rejected: would change the typed-error contract across the whole codebase.

**Rationale:** Aligns with `src/commands/config/use.ts` (uses `VALIDATION_ERROR` for "profile not found"). The spec §2.2 wording is updated to reflect this.
