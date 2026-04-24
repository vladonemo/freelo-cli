---
name: cli-design
description: UX and ergonomics patterns for the Freelo CLI — subcommand shape, flag naming, output modes, prompts, exit codes. Load when designing or reviewing a command's surface.
---

# CLI Design — patterns and principles

The Freelo CLI is **agent-first** (Claude, MCP tools, CI drive it by default) with humans as the secondary audience. Benchmarks for "feels professional to humans": `gh`, `stripe`, `vercel`, `aws`, `flyctl`. Benchmarks for "feels correct to an agent": `gh --json`, `kubectl -o json`, `aws --output json`. When in doubt, optimize for the agent path — humans still get parity via TTY detection.

Full policy lives in `.claude/docs/architecture.md`. This doc is the day-to-day checklist.

## Command shape

- `freelo <noun> <verb>` — noun first, then action (`tasks list`, not `list-tasks`).
- Verbs: `list`, `show`, `create`, `edit`, `delete`, `finish`, `reopen`, `move`, `assign`, `attach`, `detach`.
- Hierarchy max two levels: `freelo <noun> <verb>`. No `freelo projects members roles grant`.
- Avoid cute aliases. One name per command, discoverable via `freelo --introspect` or `freelo --help`.

## Flags

- **Long form always.** Short form only when obvious and frequent (`-o` for output, `-y` for yes, `-v/-vv` for verbosity, `-h` for help).
- Boolean flags default to off. If you want `--no-foo`, reconsider the default.
- Flag names use `kebab-case`: `--tasklist-id`, not `--tasklistId`.
- **Global flags** are inherited from the root program:

| Flag | Default | Purpose |
|---|---|---|
| `--output <auto\|human\|json\|ndjson>` | `auto` | Output mode. `auto` = `human` on TTY, `json` otherwise. |
| `--color <auto\|never\|always>` | `auto` | Honors `NO_COLOR` when `auto`. |
| `--profile <name>` | `default` | Selects stored credentials + config scope. |
| `-v / -vv` | silent | Verbosity on stderr. `FREELO_DEBUG=1` ≡ `-vv`. |
| `--request-id <uuid>` | generated | Passthrough; surfaced in error envelope for correlation. |
| `--yes / -y` | false | Skips destructive-op confirmation. Required in non-TTY for any destructive op. |
| `--dry-run` | false | Write commands only. Returns would-be result with no API call. |

## Inputs

- **Positional arg** for the primary object ID when unambiguous: `freelo tasks show 1234`.
- **Required flag** when the object isn't unambiguous from the subcommand: `freelo tasks create --tasklist 7 --name "..."`.
- **Content flags** accept three shapes: inline (`--message "…"`), file (`--message-file path`), stdin sentinel (`--message -`).
- **Batch input** — every write command accepts:
  - `--id <id>` repeatable
  - `--ids a,b,c` comma-separated
  - `--stdin` NDJSON, one object per line with fields matching flag names

## Output

Three machine modes, one human mode, one flag.

- `--output json` — single JSON envelope to stdout, newline-terminated.
- `--output ndjson` — one envelope per record (lists) or per input line (batch writes).
- `--output human` — tables, colors, spinners; TTY-friendly.
- `--output auto` (default) — resolves to `json` when stdout is not a TTY, `human` when it is.

**No YAML.** Two structured modes are enough for agents; humans read `human`.

### Envelope contract

Every machine-mode payload is wrapped:

```jsonc
{
  "schema": "freelo.tasks.list/v1",
  "data": [ /* … */ ],
  "paging":     { "page": 0, "per_page": 25, "total": 137, "next_cursor": 1 },
  "rate_limit": { "remaining": 42, "reset_at": "2026-04-24T18:30:00Z" },
  "request_id": "7e6f0c3e-..."
}
```

- `schema` is mandatory. Format: `freelo.<resource>.<op>/v<n>`.
- `paging` / `rate_limit` / `request_id` omitted when inapplicable.
- Field add = minor (changeset required). Field remove/rename/retype = breaking → bump `/v1 → /v2`.

### Stream / output hygiene

- **Primary output to stdout. Logs and errors to stderr.** Always.
- Never mix a spinner and output on the same stream.
- Never emit ANSI colors or spinner frames in machine modes.
- Exit 0 on success. A list returning zero items is still success. An idempotent no-op (finish an already-finished task) is still success.

## Interactivity

- Prompt only when `isInteractive && !opts.yes`.
- Destructive ops (`delete`, `archive`, `detach`) require confirmation unless `--yes`.
- **Non-TTY + destructive + no `--yes` → fail closed** with a `CONFIRMATION_REQUIRED` structured error (exit 2). Never hang. Never default to "yes."
- Prompts use `@inquirer/prompts`, lazy-imported only in TTY mode.

## Idempotency & dry-run

Agents retry. Every write command must:

- **Treat "already in target state" as success** (`already_in_target_state: true` in the envelope). Applies to finish, reopen, archive, activate, mark-read/unread, delete-by-id, attach/detach label.
- **Support `--dry-run`** returning a `would: { … }` shape under the same schema, with `dry_run: true` on the envelope. No side-effect HTTP call.

## Feedback

- Long operations (>300ms perceived) get a spinner **only in human mode**. Action-oriented text: "Fetching tasks…"
- Machine modes: no spinner, no progress chatter on stderr unless `-v`.
- On completion: human mode prints a one-line status (`✓ 42 tasks fetched`); machine modes emit the envelope and exit.

## Errors

Human mode messages state:

- **What happened**: "Could not fetch project 42."
- **Why (if known)**: "the API returned 403 Forbidden."
- **What to do**: "Run `freelo auth whoami` to verify your token has access."

Machine modes emit a structured envelope on stderr:

```jsonc
{
  "schema": "freelo.error/v1",
  "error": {
    "code": "FREELO_API_ERROR",
    "message": "Could not fetch project 42.",
    "errors": ["Forbidden"],
    "http_status": 403,
    "request_id": "…",
    "retryable": false,
    "hint_next": "Run `freelo auth whoami`.",
    "docs_url": "https://…"
  }
}
```

Stable error codes: `AUTH_EXPIRED`, `AUTH_MISSING`, `FREELO_API_ERROR`, `VALIDATION_ERROR`, `CONFIRMATION_REQUIRED`, `NETWORK_ERROR`, `RATE_LIMITED`, `CONFIG_ERROR`, `INTERNAL_ERROR`. Agents should switch on `code`, not substring-match `message`.

No stack traces unless `FREELO_DEBUG=1` or `-vv`.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success (including idempotent no-op and zero-result list) |
| 1 | Generic failure (last resort) |
| 2 | Usage / arg validation / `CONFIRMATION_REQUIRED` in non-TTY |
| 3 | Auth error — missing or expired credentials |
| 4 | API error — Freelo returned 4xx/5xx |
| 5 | Network error |
| 6 | Rate limited after retry budget (writes only) |
| 130 | SIGINT |

Adding a code is minor. Repurposing an existing one is breaking.

## Help & introspection

- `freelo --help` — human-readable command tree.
- `freelo --introspect` — machine-readable command tree (JSON envelope, `schema: freelo.introspect/v1`), including every flag, arg, output schema name, and `destructive: bool`.
- `freelo help <cmd> --output json` — same as `--introspect` but scoped to one command.
- Help-text first line is a one-sentence summary ending with a period.
- Include at least two realistic examples per command — one minimal, one agent-style (env-var auth + `--output json`).

## Anti-patterns (don't)

- Ask interactive questions when there's no TTY. Scripts hang; agents hang. Fail closed instead.
- Print colored output when `NO_COLOR` is set or `!isTTY`.
- Emit a spinner, banner, or progress message in `json`/`ndjson` mode — it corrupts stdout/stderr contracts.
- Invent new output formats. Four modes (`auto`, `human`, `json`, `ndjson`) is enough.
- Emit un-enveloped JSON in machine mode. Always route through `src/ui/envelope.ts`.
- Print a hundred rows without paginating the API call under the hood.
- Import `@inquirer/prompts`, `ora`, `boxen`, `cli-table3`, `chalk`, `pino-pretty`, or `update-notifier` at the top of a module. Always `await import(...)` behind a TTY check.
