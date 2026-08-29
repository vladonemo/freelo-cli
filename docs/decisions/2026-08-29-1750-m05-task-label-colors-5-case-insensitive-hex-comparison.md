# Decision 5 — Hex comparison is case-insensitive in both directions

**Run:** 2026-08-29-1750-m05-task-label-colors
**Phase:** implement
**Agent:** orchestrator (implementer mandate)

**Question:** The wire sends lowercase hex (`#15acc0`, `yaml` :5964) and `PALETTE` stores uppercase (`#15ACC0`). Which representation wins?

**Decision:** Neither. `paletteNameForHex` and `comparePaletteToServer` lowercase both sides before comparing. `PALETTE` is not rewritten, and the values echoed in the envelope and the table are the server's own strings, unmodified.

**Alternatives considered:**

- Normalise `PALETTE` to lowercase. Rejected: it is a frozen constant with existing tests asserting `/^#[0-9A-F]{6}$/`, and changing it to fix a comparison would be a gratuitous edit to the one file this slice promised not to disturb.
- Normalise the server values to uppercase before echoing. Rejected: the envelope should carry what the server said, so a user copying a hex out of it gets the server's exact string.

**Rationale:** A case-sensitive comparison would have reported all nine colours as drift on the first run against a perfectly current server — the failure would have looked like a real finding, which is worse than an obvious crash. Comparing in a normalised space while echoing the original values keeps both properties. Guarded by a dedicated unit test (lowercase nine-colour payload must yield `matches: true`) and a command-level test, so a future refactor cannot silently reintroduce it.
