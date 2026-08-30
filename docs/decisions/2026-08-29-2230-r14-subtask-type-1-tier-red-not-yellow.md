# Decision 1 — Tier assigned Red, overriding the requirement's Yellow guess

**Run:** 2026-08-29-2230-r14-subtask-type
**Phase:** Triage
**Agent:** orchestrator (no sub-agent delegation available this session — see summary)

**Question:** Is this slice Yellow ("new field added to an envelope schema, backwards-compatible") or Red ("breaking behavior of an existing command")?

**Decision:** Red.

**Alternatives considered:**

- Yellow, as the requirement's own signal suggested — treat declaring `type` as an additive envelope field and the `storage_form` correction as a bug fix that rides along.
- Green for the declaration alone, deferring the derivation entirely without asking.

**Rationale:** Declaring `type` really is at most Yellow — in fact it is observationally a no-op, because `.passthrough()` already emits the field (verified empirically, spec 0069 §2.4). But the slice as scoped also retires `inferStorageForm`, which changes `data.storage_form`, can remove `data.input_ignored`, and flips the human-renderer string for a shipped command. The highest tier wins per `autonomous-sdlc.md` §Risk tiers, and "breaking behavior of an existing command" routes to Pause.
