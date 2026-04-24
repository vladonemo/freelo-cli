# Freelo CLI

A command-line interface for [Freelo.io](https://freelo.io) — a project management tool popular in the Czech/Slovak market. The CLI wraps the Freelo REST API so users can manage projects, tasklists, tasks, comments, time entries, and files without leaving the terminal.

Distributed on npm as `freelo-cli` (binary: `freelo`).

---

## Tech stack

Node.js, TypeScript-first, ESM-only. See `.claude/docs/tech-stack.md` for the full pinned list and rationale.

- **Runtime**: Node.js >= 20 LTS
- **Language**: TypeScript 5.x (strict)
- **CLI framework**: [Commander.js](https://github.com/tj/commander.js)
- **Prompts**: `@inquirer/prompts`
- **HTTP**: `undici` (native `fetch` + pooling)
- **Validation / schemas**: `zod`
- **Config**: `conf` (persistent user config) + `cosmiconfig` (project-level overrides)
- **Output**: `chalk`, `ora`, `cli-table3`, `boxen`
- **Logging**: `pino` (JSON) with pretty transport for TTY
- **Bundling**: `tsup` (esbuild) — single-file ESM bundle with a shebang
- **Testing**: `vitest` + `msw` for HTTP mocking
- **Linting**: ESLint 9 (flat config) + Prettier
- **Commits**: Conventional Commits enforced via `commitlint` + `husky` + `lint-staged`
- **Release**: `changesets` (versioning + changelog + npm publish)
- **CI**: GitHub Actions (test matrix: Node 20, 22 on ubuntu/macos/windows)

---

## Repository layout

```
freelo-cli/
├── .claude/              # Agentic SDLC assets (this folder)
├── src/
│   ├── bin/              # CLI entry: freelo.ts
│   ├── commands/         # One file per top-level subcommand
│   ├── api/              # Freelo REST client, typed endpoints, zod schemas
│   ├── config/           # Auth tokens, profiles, persistent config
│   ├── ui/               # Output renderers (table, json, yaml)
│   ├── errors/           # Error classes + user-facing formatting
│   └── lib/              # Pure utilities
├── test/                 # Vitest tests, MSW handlers, fixtures
├── docs/                 # User-facing docs (VitePress later)
└── .changeset/           # Pending release notes
```

---

## Agentic SDLC at a glance

Every feature flows through these phases. See `.claude/docs/sdlc.md` for the canonical definition.

1. **Discover** → `/spec` — turn a request into a written spec
2. **Plan** → `/plan` — architect-led plan with file-level TODOs
3. **Implement** → `/implement` — write code against the plan
4. **Test** → `/test` — unit + integration with MSW
5. **Review** → `/review` — self-review before PR; `/security-review` for auth/secret paths
6. **Document** → `/document` — update user docs and help text
7. **Release** → `/ship` — changeset, version bump, tag, publish

Each phase has one or more specialized agents in `.claude/agents/` and a matching slash command in `.claude/commands/`.

---

## Working agreements

- **ESM only.** No CommonJS in `src/`. `package.json` has `"type": "module"`.
- **No `any`.** If a Freelo API response is under-typed, add a `zod` schema and infer the type.
- **Every network call is schema-validated** on the way in. Never hand a raw API response to business logic.
- **Commands are thin.** A command file parses args, calls an API function, hands the result to a renderer. Business logic lives outside `src/commands/`.
- **Errors are typed.** Throw `FreeloApiError`, `ConfigError`, `ValidationError` — never bare `Error`. The top-level handler in `src/bin/freelo.ts` formats them.
- **Output respects `--json`.** Every command must support machine-readable output. Default is human-friendly.
- **No telemetry** without an explicit opt-in flag. This is a user-trust boundary.
- **Secrets** (API tokens) are stored via the OS keychain when available (`keytar`), falling back to `conf` with 0600 perms. Never logged, never printed.
- **Conventional Commits** are required — enforced by the commit-msg hook.
- **Every user-visible change** needs a changeset entry (`pnpm changeset`).

---

## Further reading

- `.claude/docs/sdlc.md` — the full SDLC process
- `.claude/docs/architecture.md` — how the CLI is structured
- `.claude/docs/tech-stack.md` — dependency choices and why
- `.claude/docs/conventions.md` — code style and patterns
- `.claude/agents/` — specialized agents
- `.claude/commands/` — slash commands
- `.claude/skills/` — reusable skills
