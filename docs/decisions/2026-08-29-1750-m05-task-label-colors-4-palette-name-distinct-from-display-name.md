# Decision 4 — Envelope carries `palette_name` as a field distinct from the wire's `display_name`

**Run:** 2026-08-29-1750-m05-task-label-colors
**Phase:** spec
**Agent:** orchestrator (architect mandate)

**Question:** The wire already returns `display_name`. Should the envelope reuse it as the palette name, or add a separate field?

**Decision:** Add `colors[].palette_name`, populated from the local table by case-insensitive hex match, `null` when the CLI has no name for that colour. `display_name` is passed through unchanged alongside it.

**Alternatives considered:**

- Reuse `display_name` as the `--palette` name. Rejected: it is not accepted as input (`yaml` :5968), and presenting it as typeable would be actively misleading.
- Omit `display_name` from the envelope and show only `palette_name`. Rejected: it is real server data, it is useful for recognising a colour, and dropping documented wire fields on the floor is against the passthrough posture.

**Rationale:** The two answer different questions — `palette_name` is "what do I type", `display_name` is "what does Freelo call it" — and they will often look similar enough that collapsing them would hide the distinction exactly where it matters. `palette_name: null` is also the machine-readable signal that a colour needs `--hex`, which is the same information `drift.server_only` carries in aggregate. The human renderer labels the columns `PALETTE` and `DISPLAY NAME` and the docs state which one to type.
