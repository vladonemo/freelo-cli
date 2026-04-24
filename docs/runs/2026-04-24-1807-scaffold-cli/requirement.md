# Requirement — 2026-04-24-1807-scaffold-cli

## Original input

> Scaffold the CLI tool. Implement the executable with the only command to return the version of it.

## Operator context

This is the initial scaffold of the Freelo CLI repository. Currently only `.claude/`, `docs/`, `.gitattributes`, and `.git/` exist at the repo root — there is NO `package.json` yet. The tech stack is already pinned in `.claude/docs/tech-stack.md` and `.claude/CLAUDE.md`.

## Acceptance

1. `pnpm install` works from a clean clone.
2. `pnpm build` produces a runnable bundle.
3. The resulting `freelo` binary supports `freelo --version` (and the Commander-conventional `-V`) and prints the version from `package.json`.
4. Conventional Commits tooling, changesets, linting, typecheck, and a basic vitest setup are wired up.
5. Tests cover the `--version` command.
6. A changeset entry exists for the initial scaffold.

## Run parameters

- run-id: `2026-04-24-1807-scaffold-cli`
- budget: default (30 min wall clock, 40 agent calls, 8 retries, 25 files)
- allowNetwork: false (MSW only)
- autoShip: false
- branch: `chore/scaffold-cli`
