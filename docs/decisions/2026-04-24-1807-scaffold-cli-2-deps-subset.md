# Decision 2 — Defer non-scaffold dependencies

**Run:** 2026-04-24-1807-scaffold-cli
**Phase:** plan
**Agent:** orchestrator (architect role)

**Question:** The pinned tech stack lists ~25 runtime libraries (`@inquirer/prompts`, `undici`, `zod`, `conf`, `cosmiconfig`, `chalk`, `ora`, `cli-table3`, `boxen`, `update-notifier`, `pino`, `pino-pretty`, `keytar`, ...). Should the scaffold install all of them up front, or only what `--version` actually needs?

**Decision:** Install only `commander` as a runtime dep. Other stack entries are added by their first consuming feature spec.

**Alternatives considered:**
- Install everything now. Bloats the install, locks versions prematurely, creates "phantom deps" — libraries imported by nothing are libraries the triage agent can't reason about.
- Install a "UX basics" subset (chalk, ora, cli-table3). Same problem, smaller scale; also means the scaffold ships shadow imports.

**Rationale:** The working agreement in `.claude/docs/conventions.md` says "new dep requires a note in the spec's Plan." A scaffold that wire-includes deps without a feature to justify them violates that principle by default. Tech-stack.md remains the allowlist; this scaffold's Plan explicitly scopes the installed set.
