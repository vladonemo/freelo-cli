# Tech Stack

The default answer to "what should we use for X?" If a choice here needs to change, update this doc as part of the change — this is the source of truth.

## Why these choices

Goal: a CLI that's **agent-first** (Claude, MCP tools, CI scripts drive it by default) and still feels as polished as `gh`, `stripe`, or `vercel` when a human uses it. That means:

- **Agent-default output** — JSON envelope when stdout isn't a TTY, no flag needed
- **Fast startup** — bundled single file; human-UX deps lazy-imported so agent cold paths are lean
- **Env-first auth** — `FREELO_API_KEY` bypasses keychain entirely; zero prompts required
- **Stable contract** — versioned envelope schemas, structured errors, introspectable command tree
- **Cross-platform** — Linux, macOS, Windows. Tested in CI on all three.
- **Great help text** — auto-generated, but styled; also machine-readable via `freelo --introspect`
- **Boring** — mature libraries with active maintenance, no exotic experiments

## Core

| Area | Choice | Why |
|---|---|---|
| Runtime | Node.js >= 20 LTS | Native `fetch`, stable ESM, `--env-file`, native test runner available as fallback |
| Language | TypeScript 5.x strict | Industry default. `strict: true`, `noUncheckedIndexedAccess: true` |
| Module system | ESM only | Future-proof; `"type": "module"` in `package.json` |
| Package manager | pnpm | Fast, strict, good monorepo support if we split later |

## CLI surface

All human-UX libraries below are **lazy-loaded** via `await import('…')` behind an `isInteractive` check. They do not appear in the agent cold path.

| Area | Choice | Why | Loaded |
|---|---|---|---|
| Argument parsing | `commander` | Mature, composable, good subcommand ergonomics; introspectable tree for `--introspect` | eager |
| Interactive prompts | `@inquirer/prompts` | Modern, composable, tree-shakeable — the new official `inquirer` | lazy (TTY only) |
| Colors | `chalk` v5 (ESM) | De facto standard | lazy (TTY + `wantsColor`) |
| Spinners | `ora` | Pairs naturally with chalk; never attached in `json`/`ndjson` mode | lazy (TTY only) |
| Tables | `cli-table3` | Good unicode handling; `human` output mode only | lazy (human mode) |
| Boxes | `boxen` | For first-run banners and upgrade notices | lazy (TTY only) |
| Update notifications | `update-notifier` | Non-blocking check; **TTY-only** — disabled when `CI=1` or non-interactive | lazy (TTY only) |

## Data / IO

| Area | Choice | Why |
|---|---|---|
| HTTP client | `undici` | Same engine Node uses for `fetch`; pooled agents, retry hooks |
| Schema validation | `zod` v3 | Runtime validation + type inference from one source |
| Persistent config | `conf` | Stores in platform-correct location (`~/Library/Preferences/...` etc.) |
| Project config | `cosmiconfig` | Standard for repo-level `.freelorc`, `freelo.config.ts` etc. |
| Secret storage | env-var first, then `keytar`, then `conf` | `FREELO_API_KEY` + `FREELO_EMAIL` env vars take precedence and **skip the keychain entirely** so headless agents (CI, Docker, Lambda) never touch OS secret stores. `FREELO_NO_KEYCHAIN=1` forces `conf`-file storage. |
| Logging | `pino` (+ `pino-pretty` for TTY) | Default level **silent**; `-v` → info, `-vv` / `FREELO_DEBUG=1` → debug. stderr only. `pino-pretty` is lazy-loaded and attached only in TTY + `human` mode. |

## Build / Dev

| Area | Choice | Why |
|---|---|---|
| Bundler | `tsup` (esbuild) | Single-file ESM output with shebang, fast |
| Dev runner | `tsx` | Fast TS execution for `pnpm dev` |
| Linter | ESLint 9 (flat config) | Plugins: `@typescript-eslint`, `unicorn`, `n` (node) |
| Formatter | Prettier | Zero-config, run via `lint-staged` |
| Type checker | `tsc --noEmit` in CI | Separate from bundling for fidelity |

## Testing

| Area | Choice | Why |
|---|---|---|
| Test runner | `vitest` | Vite-speed, Jest-compatible API, great TS support |
| HTTP mocking | `msw` v2 | Intercepts at the request layer — tests the real client code |
| Coverage | `vitest --coverage` (v8) | Built in |
| Fixtures | JSON files under `test/fixtures/` | Real API responses scrubbed of PII |

## Quality gates

| Area | Choice | Why |
|---|---|---|
| Git hooks | `husky` | Industry standard, simple |
| Staged linting | `lint-staged` | Run ESLint + Prettier only on changed files |
| Commit linting | `commitlint` + `@commitlint/config-conventional` | Enforces Conventional Commits |
| Release | `changesets` | Decoupled from commits; writers decide the bump; great monorepo story |

## CI / Distribution

| Area | Choice | Why |
|---|---|---|
| CI | GitHub Actions | Free for OSS, matrix is trivial |
| Matrix | Node 20, 22 × ubuntu-latest, macos-latest, windows-latest | Cover supported runtimes and platforms |
| Registry | npm public | Scoped as `freelo-cli` or `@magicsoft/freelo-cli` |
| Binary distribution | `pkg` or `node --experimental-sea-config` | **Deferred**. npm install is the v1 path. |

## Forbidden / avoided

- **No CommonJS** in `src/`. Consumers of the CLI don't `require()` us anyway.
- **No `axios`.** `undici` / native `fetch` suffices and is faster.
- **No `yargs`.** `commander` has cleaner subcommand composition.
- **No `inquirer` v8.** Use `@inquirer/prompts` instead.
- **No `dotenv` as a runtime dep.** Node 20 has `--env-file`; config goes through `conf`/`cosmiconfig`.
- **No `lodash`.** Modern JS has the primitives. If you reach for it, stop and reconsider.
- **No YAML output.** Two structured modes (`json`, `ndjson`) are enough for agents; humans get `human` mode.
- **No top-level imports of human-UX libs** (`chalk`, `ora`, `boxen`, `cli-table3`, `@inquirer/prompts`, `pino-pretty`, `update-notifier`). They must be lazy-loaded. Enforced by ESLint `no-restricted-imports`.
- **No `console.log`** outside `src/ui/` and `src/bin/`. All output routes through `src/ui/envelope.ts`.
