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

Every feature flows through seven phases. See `.claude/docs/sdlc.md` for the canonical definition and `.claude/docs/autonomous-sdlc.md` for the autonomous flow.

**Two modes, same phases:**

| Mode | Entry point | Human gates | Use when |
|---|---|---|---|
| Autonomous | `/auto <requirement>` | Pause-on-policy only (see autonomous doc) | Default. Throw in a requirement, get a merged PR or a documented pause. |
| Interactive | `/spec` → `/plan` → `/implement` → `/test` → `/review` → `/document` → `/ship` | Every phase boundary | Risky changes, first-of-a-kind work, or when you want to learn alongside the agents. |

The phases:

1. **Triage + Discover** → spec
2. **Plan** → file-level TODOs
3. **Implement** → code against plan
4. **Test** → vitest + MSW
5. **Review** → code + security
6. **Document** → user docs, help text
7. **Release** → changeset, version, publish

Each phase has one or more specialized agents in `.claude/agents/` and a matching slash command in `.claude/commands/`. In autonomous mode, the `orchestrator` agent invokes them in order.

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

- `.claude/docs/sdlc.md` — the interactive SDLC process
- `.claude/docs/autonomous-sdlc.md` — the autonomous SDLC (risk tiers, orchestrator, pause protocol)
- `.claude/docs/architecture.md` — how the CLI is structured
- `.claude/docs/tech-stack.md` — dependency choices and why
- `.claude/docs/conventions.md` — code style and patterns
- `.claude/agents/` — specialized agents (incl. `orchestrator` and `triage` for autonomous runs)
- `.claude/commands/` — slash commands (incl. `/auto` and `/resume`)
- `.claude/skills/` — reusable skills
