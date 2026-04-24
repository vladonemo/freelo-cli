# freelo-cli

Command-line interface for [Freelo.io](https://freelo.io) — manage projects, tasklists, tasks, comments, time entries, and files without leaving the terminal.

> Status: **early scaffold.** The only command implemented today is `freelo --version`. Real subcommands land as their feature specs do.

## Install

```bash
npm install -g freelo-cli
# or
pnpm add -g freelo-cli
```

Requires Node.js 20.11 or newer.

## Use

```bash
freelo --version    # prints the installed version
freelo --help       # shows available commands
```

## Develop

```bash
pnpm install
pnpm dev -- --version    # run the entry directly via tsx
pnpm build               # bundle to dist/freelo.js
pnpm test                # vitest
pnpm lint && pnpm typecheck
```

Conventional Commits are enforced by a commit-msg hook. Add a changeset (`pnpm changeset`) for any user-visible change.

## Process

This repository uses an agentic SDLC. See `.claude/docs/sdlc.md` (interactive) and `.claude/docs/autonomous-sdlc.md` (autonomous via `/auto`).

## License

MIT
