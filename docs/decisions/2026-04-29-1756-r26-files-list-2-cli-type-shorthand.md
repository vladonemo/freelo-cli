# Decision 2 — CLI `--type` accepts short forms; wire enum is full

**Run:** 2026-04-29-1756-r26-files-list
**Phase:** spec
**Agent:** architect

**Question:** The roadmap line says `--type doc|file|link|dir` (CLI short forms). The Freelo wire enum is `document | file | link | directory`. Should the CLI accept the wire forms, the short forms, both, or only the short forms?

**Decision:** Accept **only the short forms** (`doc`, `file`, `link`, `dir`). Map to wire forms in the leaf:

| CLI value | Wire value |
|---|---|
| `doc` | `document` |
| `file` | `file` |
| `link` | `link` |
| `dir` | `directory` |

Reject the wire forms (`document`, `directory`) at parse time with `ValidationError` (exit 2). Hint lists the four valid CLI forms.

**Alternatives considered:**
- **Accept both.** Two ways to say the same thing. Test matrix doubles. Help text gets noisier ("doc | document"). The CLI's general policy (`architecture.md` Audience: "Adding a new dep requires…") is to keep the surface small.
- **Accept wire forms only.** Roadmap line is the contract for CLI ergonomics. `--type document` is uglier in the terminal. Roadmap precedent rules.
- **Hide the mapping behind the enum entirely.** Considered — Commander accepts a `choices()`-equivalent on `.option`, validates at parse time, and we'd map post-parse. This is what we'll implement.

**Rationale:** The roadmap line is the user-facing contract for the CLI surface. The wire enum is an implementation detail. Mapping is one switch; tests cover all four arms; agents introspect via `--introspect` to discover the choices. Cost: ≈8 lines of mapping; benefit: matches the roadmap and stays tidy in `--help`.

The envelope's `applied_filters.type` carries the **wire form** (decision 03), so an agent that reads the envelope and wants to call Freelo directly (bypassing the CLI) gets a string it can pass straight through.
