# Getting started

The Freelo CLI is currently in early scaffold. The only working command today is `--version`; this page will grow as features land.

## Install

```bash
npm install -g freelo-cli
```

Requires Node.js 20.11 LTS or newer.

## First invocation

```bash
$ freelo --version
0.0.0

$ freelo --help
Usage: freelo [options] [command]

Command-line interface for Freelo.io project management.

Options:
  -V, --version  output the version number
  -h, --help     display help for command
```

## Designed for agents first, humans second

The CLI is intended to be driven primarily by AI agents (Claude, MCP tools), CI pipelines, and scripts — with humans as a secondary audience that gets the same surface with friendlier defaults on a TTY.

Landing with the first real slice (R01 — auth + infra):

- **Output defaults to JSON** when stdout is not a TTY. A plain `freelo tasks list | jq` will Just Work.
- **Every JSON payload is a versioned envelope** (`schema`, `data`, `paging`, `rate_limit`, `request_id`). Stable across minor versions.
- **Errors are structured** with `code`, `http_status`, `retryable`, and `hint_next` so scripts can branch.
- **Auth works headless via env vars** — no keychain, no prompt required:
  ```bash
  FREELO_EMAIL=you@example.com FREELO_API_KEY=... freelo tasks list
  ```
- **Write commands support `--dry-run`, batch input, and idempotent retries** so agents can safely retry on failure.
- **The command tree is machine-discoverable** via `freelo --introspect` (JSON envelope) — agents can enumerate flags and output schemas without parsing `--help` text.

Humans on a TTY get `--output human` automatically: colored tables, spinners, confirmation prompts. No flag needed either way.

## Next steps

There aren't any user-facing features yet — adding `freelo auth login` (R01) is the next milestone. Watch the changelog.

See [`docs/roadmap.md`](./roadmap.md) for the full incremental delivery plan.
