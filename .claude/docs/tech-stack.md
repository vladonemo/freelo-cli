# Tech Stack

The default answer to "what should we use for X?" If a choice here needs to change, update this doc as part of the change — this is the source of truth.

## Why these choices

Goal: a CLI that feels as polished as `gh`, `stripe`, or `vercel`. That means:
- **Fast startup** — bundled single file, lazy imports for heavy paths
- **Great help text** — auto-generated, but styled
- **Cross-platform** — Linux, macOS, Windows. Tested in CI on all three.
- **Scriptable** — every command has `--json`
- **Boring** — mature libraries with active maintenance, no exotic experiments

## Core

| Area | Choice | Why |
|---|---|---|
| Runtime | Node.js >= 20 LTS | Native `fetch`, stable ESM, `--env-file`, native test runner available as fallback |
| Language | TypeScript 5.x strict | Industry default. `strict: true`, `noUncheckedIndexedAccess: true` |
| Module system | ESM only | Future-proof; `"type": "module"` in `package.json` |
| Package manager | pnpm | Fast, strict, good monorepo support if we split later |

## CLI surface

| Area | Choice | Why |
|---|---|---|
| Argument parsing | `commander` | Mature, composable, good subcommand ergonomics |
| Interactive prompts | `@inquirer/prompts` | Modern, composable, tree-shakeable — the new official `inquirer` |
| Colors | `chalk` v5 (ESM) | De facto standard |
| Spinners | `ora` | Pairs naturally with chalk |
| Tables | `cli-table3` | Good unicode handling |
| Boxes | `boxen` | For first-run banners and upgrade notices |
| Update notifications | `update-notifier` | Non-blocking background check |

## Data / IO

| Area | Choice | Why |
|---|---|---|
| HTTP client | `undici` | Same engine Node uses for `fetch`; pooled agents, retry hooks |
| Schema validation | `zod` v3 | Runtime validation + type inference from one source |
| Persistent config | `conf` | Stores in platform-correct location (`~/Library/Preferences/...` etc.) |
| Project config | `cosmiconfig` | Standard for repo-level `.freelorc`, `freelo.config.ts` etc. |
| Secret storage | `keytar` with `conf` fallback | OS keychain when available; encrypted file otherwise |
| Logging | `pino` + `pino-pretty` | JSON by default, pretty for TTY, levels controllable via `FREELO_LOG` |

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
