# Decision 1 — Include `help` in introspect `data.commands`

**Run:** 2026-04-25-2110-help-introspect-meta
**Phase:** Spec (architect)
**Agent:** orchestrator (architect role)

**Question:** Should the `help` subcommand appear in `data.commands` of the
`freelo --introspect` envelope?

**Decision:** Yes — Option A. Attach `meta = { outputSchema:
'freelo.introspect/v1', destructive: false }` to the `help` Commander instance
via `attachMeta()`.

**Alternatives considered:**
- Option B — document the exclusion as intentional; update spec 0004 and
  `docs/commands/introspect.md` to call it out as a non-goal. No source change.

**Rationale:**
- The R02.5 spec is the contract; its §2 example envelope and §8 plan both
  imply `help` is enumerated symmetrically with every other public command.
- Self-referential introspect entries are standard for CLI tools (the `help`
  command emits the introspect envelope; declaring its own `output_schema` as
  `freelo.introspect/v1` is correct, not "muddy").
- Agents that walk `data.commands` and assume completeness — a reasonable
  default — would currently miss `help`. Closing this gap removes a footgun.
- The "would muddy" concern in the original implementer's comment was
  overcautious: the entry is one extra row, sorted alphabetically, and the
  shape is identical to every other leaf.
- Cost is small: one `attachMeta` call, golden-fixture refresh, README autogen
  regeneration, one test inversion. No schema shape change.
