# 0001 — Scaffold the CLI

**Status:** Draft
**Run:** 2026-04-24-1807-scaffold-cli
**Owner:** orchestrator (autonomous)
**Tier:** Yellow

## Problem

The repository contains only the agentic-SDLC assets (`.claude/`), the pinned API spec (`docs/api/freelo-api.yaml`), and `.gitattributes`. There is no `package.json`, no source tree, no build, no test runner, no commit hooks. A contributor cannot run, build, or test anything.

We need a runnable foundation: a TypeScript+ESM project with the full pinned tech stack wired up, the directory layout from `.claude/docs/architecture.md`, an executable `freelo` binary, and a single behavior — printing the package version when invoked with `--version` or `-V`.

## Proposal

### CLI UX

```
$ freelo --version
0.0.0

$ freelo -V
0.0.0

$ freelo --help
Usage: freelo [options] [command]

Command-line interface for Freelo.io.

Options:
  -V, --version  output the version number
  -h, --help     display help for command
```

- `--version` and `-V` are provided automatically by Commander once `program.version()` is called.
- The version string is the value of `version` in `package.json`, inlined at build time by `tsup`'s `define` so the published bundle has no runtime fs lookup and works regardless of CWD or symlink layout.
- Exit code: `0` on `--version` / `--help`, `2` on unknown command (Commander default for usage errors), `0` on the no-arg invocation showing help.
- No subcommands are registered yet. Adding a subcommand is the next contributor's job.

### Files (overview, full list in Plan)

- `package.json` — project manifest, scripts, deps from pinned stack
- `tsconfig.json` — strict TypeScript config
- `tsup.config.ts` — bundle to single ESM file with shebang
- `eslint.config.js` — ESLint 9 flat config
- `.prettierrc.json`, `.prettierignore`
- `vitest.config.ts` — test runner + coverage
- `commitlint.config.js`
- `.husky/commit-msg`, `.husky/pre-commit`
- `.changeset/config.json` + initial changeset
- `.github/workflows/ci.yml` — lint, typecheck, test on Node 20/22 × ubuntu/macos/windows
- `.gitignore`, `.npmignore`
- `src/bin/freelo.ts` — entry, builds program, parses, formats top-level errors
- `src/lib/version.ts` — exposes the inlined version constant
- `src/errors/base.ts` — `BaseError` class (placeholder for the typed hierarchy in spec 0002+)
- empty placeholder folders kept via `.gitkeep` where useful: `src/commands/`, `src/api/`, `src/config/`, `src/ui/`
- `test/bin/version.test.ts` — covers `--version` and `-V`
- `test/msw/handlers.ts` — empty handler array, so future tests have a place to add to
- `docs/getting-started.md`, `docs/commands/version.md`

### API surface

None. No Freelo endpoints touched.

### Data model

None. The only datum is the version string, which is `string` typed by `package.json`.

### Edge cases

- **Bundled bin run via `node dist/freelo.js`** — must work without `__dirname`-based lookups; version is compile-time inlined.
- **Bundled bin run via `pnpm exec freelo`** — `package.json` `bin` field maps `freelo` to `dist/freelo.js`; tsup adds the shebang.
- **Windows execution** — pnpm/npm generates `freelo.cmd` shim automatically. Shebang line is harmless on Windows when invoked through that shim.
- **Husky on a fresh clone without `.git`** — `pnpm prepare` calls `husky` which is no-op when not in a git repo (we wrap with a guard that exits 0 if `.git` is absent so npm-published consumers don't see an error).
- **CI without git hooks** — CI sets `HUSKY=0` to skip the prepare-time install.

### Non-goals

- No subcommands beyond Commander's built-in `--version`/`--help`.
- No Freelo API client implementation. `src/api/` is empty.
- No auth flows. `src/config/` is empty.
- No `--json` output for `--version` (Commander emits the bare string; the `--json` convention applies to commands that return data, of which we have none).
- No keytar wiring yet — added when the auth feature spec lands.
- No update-notifier wiring — added when there is something to notify about.
- No published binary distribution outside npm.

### Open questions

None. The operator context resolved the "release tooling pause" trigger; the rest is mechanical.

---

## Plan

### Files to create

| Path | Intent |
|---|---|
| `package.json` | Manifest. `"type": "module"`, `bin.freelo = ./dist/freelo.js`, scripts (`dev`, `build`, `lint`, `format`, `typecheck`, `test`, `test:cov`, `prepare`, `changeset`), engines, deps. |
| `pnpm-workspace.yaml` | Single-package workspace; future-proofs splitting later. (Optional — skip if it complicates tsup; revisit.) |
| `.npmrc` | Pin `engine-strict=true`, `node-linker=isolated`. |
| `tsconfig.json` | Strict TS, `module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2022`, `noEmit: true` (build is via tsup). |
| `tsup.config.ts` | Bundles `src/bin/freelo.ts` to `dist/freelo.js` ESM, adds `#!/usr/bin/env node` shebang, inlines `__FREELO_VERSION__` from `package.json` via `define`. |
| `eslint.config.js` | ESLint 9 flat config: `@typescript-eslint`, `unicorn`, `n`. Project-aware. |
| `.prettierrc.json` | Standard Prettier (single quotes, semi true, width 100, trailingComma 'all'). |
| `.prettierignore` | Ignore `dist/`, `coverage/`, lockfile. |
| `vitest.config.ts` | Node env, coverage v8, thresholds (lines 80, branches 80) initially permissive — scaffold has only one test. |
| `commitlint.config.js` | Extends `@commitlint/config-conventional`. |
| `.husky/pre-commit` | Runs `pnpm lint-staged`. |
| `.husky/commit-msg` | Runs `pnpm exec commitlint --edit "$1"`. |
| `lint-staged.config.js` | Eslint+Prettier on staged `*.ts`, Prettier on `*.{json,md,yml}`. |
| `.changeset/config.json` | Standard config; `changelog: "@changesets/cli/changelog"`, `access: restricted`, `baseBranch: main`. |
| `.changeset/initial-scaffold.md` | `minor` bump, "Initial CLI scaffold with --version command". |
| `.github/workflows/ci.yml` | Matrix Node 20+22 × ubuntu+macos+windows. Steps: setup pnpm, install, lint, typecheck, build, test --coverage. |
| `.github/workflows/release.yml` | Changesets release action on push to main; **publishes only when a Version PR is merged** — and even that won't trigger anything in this scaffold because no NPM_TOKEN is provisioned yet. Documented as "wired but inert until secrets are set." |
| `.gitignore` | `node_modules/`, `dist/`, `coverage/`, `.DS_Store`, `*.log`. |
| `src/bin/freelo.ts` | Build Commander program, `program.version(VERSION)`, `program.parseAsync(argv)`, top-level error handler stub. |
| `src/lib/version.ts` | `export const VERSION = __FREELO_VERSION__ as string;` (declared as a global by tsup `define`). |
| `src/lib/version.d.ts` not needed — declared inline in `version.ts` via `declare const __FREELO_VERSION__: string;`. |
| `src/errors/base.ts` | Minimal `BaseError extends Error` placeholder. |
| `src/commands/.gitkeep`, `src/api/.gitkeep`, `src/config/.gitkeep`, `src/ui/.gitkeep` | Reserve folders. |
| `test/bin/version.test.ts` | Programmatically invoke the Commander program with `['--version']` and `['-V']`; assert stdout equals `package.json.version`. |
| `test/msw/handlers.ts` | `export const handlers = [];` placeholder. |
| `test/setup.ts` | Configure MSW server (no handlers yet); shared by vitest. |
| `docs/getting-started.md` | Install + first invocation. |
| `docs/commands/version.md` | The single command page. |
| `README.md` | Short pitch + install + dev workflow. |
| `LICENSE` | MIT. |

### New dependencies (all on triage pre-approved list)

**dependencies**
- `commander` — argument parsing

**devDependencies**
- `typescript`, `tsup`, `tsx`
- `vitest`, `@vitest/coverage-v8`, `msw`
- `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-plugin-unicorn`, `eslint-plugin-n`, `globals`
- `prettier`
- `husky`, `lint-staged`
- `@commitlint/cli`, `@commitlint/config-conventional`
- `@changesets/cli`
- `@types/node`

Other pinned-stack deps (`@inquirer/prompts`, `undici`, `zod`, `conf`, `cosmiconfig`, `chalk`, `ora`, `cli-table3`, `boxen`, `update-notifier`, `pino`, `pino-pretty`, `keytar`) are **not** added in this scaffold — they will be added by their first consuming feature spec, per "minimum dep footprint" hygiene.

### Test strategy

- **Unit:** `test/bin/version.test.ts` — builds the same Commander program the binary builds, calls `parseAsync(['--version'], { from: 'user' })` with stdout/stderr captured. Asserts: exit code 0, stdout equals `<version>\n`. Same for `-V`.
- **Coverage thresholds:** keep lenient (lines: 80) to allow future scaffolding without immediate failures. The `--version` test exercises the entry's `register/parse/version` paths.
- **MSW:** wired via `test/setup.ts` but server starts with empty handlers — proves the rig is in place for the first API spec.

### Rollout order (single landable commit, but logical order)

1. Manifest + tsconfig + .gitignore — foundation.
2. ESLint + Prettier + commitlint — quality gates.
3. Husky + lint-staged — local enforcement.
4. tsup config + entry source + version lib — buildable artifact.
5. Vitest config + setup + version test — coverage of the deliverable.
6. Changesets config + initial changeset — release tooling.
7. CI workflow — automation.
8. Docs (`README`, getting-started, commands/version).
9. `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm exec node dist/freelo.js --version` — end-to-end verification.
10. Commit on `chore/scaffold-cli`.
