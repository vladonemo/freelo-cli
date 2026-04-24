# Triage — 2026-04-24-1807-scaffold-cli

**Tier:** Yellow
**Commit type:** chore (scaffold) + feat (--version)

## Summary

Bootstrap the freelo-cli repository: introduce `package.json`, the pinned tech stack, build/test/lint tooling, conventional-commits enforcement, changesets, and a minimal `freelo` binary whose only command is `--version` (printed via Commander from `package.json`). The scaffold itself is the deliverable; no Freelo API surface is exercised yet.

## Signals

- [x] Touches src/commands/ (new — initial commands surface, only built-in --version)
- [x] Touches src/config/ (scaffolded as empty placeholders only — no auth or token logic)
- [ ] Touches src/api/client.ts or HTTP defaults (scaffolded empty; no network code)
- [ ] Touches auth flows
- [x] Adds dependencies (initial — entirely from the pre-pinned `.claude/docs/tech-stack.md` allowlist)
- [ ] Removes a dependency
- [ ] Changes --json output schema (none yet)
- [ ] Changes exit codes
- [ ] Removes/renames an existing flag
- [ ] Requires the Freelo API
- [ ] Docs-only

## Route flags

- requiresFreeloApi: false
- needsSecurityReview: false (no auth/config user-facing surface; secrets storage deferred)
- preApprovedDeps: all entries listed in `.claude/docs/tech-stack.md` (commander, @inquirer/prompts, undici, zod, conf, cosmiconfig, chalk, ora, cli-table3, boxen, update-notifier, pino, pino-pretty, keytar, tsup, tsx, vitest, msw, @vitest/coverage-v8, eslint, @typescript-eslint/*, eslint-plugin-unicorn, eslint-plugin-n, prettier, husky, lint-staged, @commitlint/cli, @commitlint/config-conventional, @changesets/cli, typescript)
- allowNewDeps: true (only from pre-approved set above)

## Rationale

The change introduces the *entire* tooling chain at once, including release tooling (changesets) and CI. Per autonomous-sdlc.md a "touches release tooling" signal would normally force Red — but the operator context explicitly sanctions release-tooling introduction as part of this very scaffold and instructs us not to pause on mechanical scaffold steps. With release-tooling Red overridden by the operator, the dominant remaining signal is "new dependencies + new user-visible flag (--version)" → Yellow. The scaffold introduces no auth/config user-facing surface; `src/config/` is created empty.

## Open concerns

None blocking. Notes for the architect:
- Use the `package.json` version as the single source of truth surfaced by `--version`. Read it at build time (compile-time inline) so the bundled binary stays self-contained.
- The CLI entry must register no real subcommands yet — `--version`/`-V` is provided by Commander itself.
- Husky must be installed via `pnpm prepare` so a clean clone wires hooks automatically (gated on `.git` existing).
- Lockfile (`pnpm-lock.yaml`) **must** be committed.

## Recommended branch name

chore/scaffold-cli
