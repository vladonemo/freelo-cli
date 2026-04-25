# Decision 1 — HTML-comment markers for the README autogen block

**Run:** 2026-04-25-2034-readme-autocheck
**Phase:** spec (architect)
**Agent:** orchestrator (delegated)

**Question:** What syntax delimits the autogen block in `README.md`?
**Decision:** HTML comments — `<!-- BEGIN AUTOGEN COMMANDS -->` / `<!-- END AUTOGEN COMMANDS -->`.
**Alternatives considered:**
- Fenced code block with a language tag (e.g. ```` ```autogen ````) — visible to readers, ugly.
- A separate file (e.g. `docs/commands.md`) included via a build step — adds dev complexity, doesn't ship to npm consumers as part of `README.md`.
- Front-matter — not portable to Markdown rendered on npmjs.com / GitHub.
**Rationale:** HTML comments are invisible in rendered Markdown on every renderer (npmjs, GitHub, VitePress). They're a well-established convention (used by `markdown-toc`, `actions/toolkit` README, etc.). Splicing is a trivial string operation.
