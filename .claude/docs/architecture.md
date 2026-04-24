# Architecture

High-level structure of the Freelo CLI. Read this before making cross-cutting changes.

## Audience: agents first, humans second

The CLI is designed to be driven primarily by AI agents (Claude, MCP tools, CI scripts), with humans as a secondary audience. Every defaulting decision resolves in the agent's favor; humans get parity via TTY detection.

Concretely, this means:

- **Output defaults to JSON** when stdout is not a TTY. No flag needed.
- **Every JSON payload is a stable, versioned envelope** (`schema`, `data`, `paging`, `rate_limit`, `request_id`). Field removal is a breaking change.
- **Errors are structured** with `code`, `http_status`, `request_id`, `retryable`, `hint_next`, `docs_url` — agents can act on them.
- **Auth works without a keychain and without prompts** via env vars.
- **Write commands support `--dry-run`, batch input (`--ids`, `--stdin` NDJSON), and idempotency** so retries are safe.
- **The command surface is introspectable** as JSON (`freelo --introspect`).
- **Human-mode dependencies (`@inquirer/prompts`, `ora`, `boxen`, `chalk`, `cli-table3`, `pino-pretty`) are lazy-loaded** so agent cold-paths don't pay for them.

If a decision makes life easier for humans at the cost of agent ergonomics, it's the wrong decision.

---

## Layers

```
┌─────────────────────────────────────────────────┐
│  bin/freelo.ts         entry, top-level errors  │
├─────────────────────────────────────────────────┤
│  commands/             arg parsing, flags, UX   │
├─────────────────────────────────────────────────┤
│  api/                  typed Freelo client      │
├─────────────────────────────────────────────────┤
│  config/  ui/  errors/  lib/    cross-cutting   │
└─────────────────────────────────────────────────┘
```

Dependencies only point downward. `api/` never imports from `commands/`. `lib/` imports from nothing project-internal.

## `src/bin/freelo.ts`

The entry point. Minimal:

1. Build the root Commander program.
2. Register global flags (`--output`, `--profile`, `--color`, `-v/-vv`, `--request-id`, `--dry-run` at the command level where applicable).
3. Register each subcommand from `src/commands/`.
4. Wrap `program.parseAsync` in a try/catch that maps typed errors to exit codes and emits either a human-readable message (TTY) or a structured error envelope (non-TTY / `--output json`).
5. Handle `SIGINT` gracefully (abort in-flight requests, don't leave a spinner running).

Exit codes:

- `0` success (including "no results" and "idempotent no-op")
- `1` generic failure
- `2` usage / arg error (including "confirmation required in non-TTY")
- `3` auth error (missing/expired credentials)
- `4` API error (4xx/5xx from Freelo)
- `5` network error
- `6` rate limited (after retry budget exhausted on writes; GETs retry silently)
- `130` SIGINT

## Global flags

Defined on the root program; every subcommand inherits them.

| Flag | Values | Default | Purpose |
|---|---|---|---|
| `--output` | `auto` \| `human` \| `json` \| `ndjson` | `auto` | `auto` = `human` on TTY, `json` otherwise. `ndjson` streams one envelope per record for list ops and per input line for batch writes. |
| `--color` | `auto` \| `never` \| `always` | `auto` | Honors `NO_COLOR` when `auto`. |
| `--profile` | name | `default` | Selects stored credentials + config scope. |
| `-v / -vv` | — | silent | Verbosity. `-v` = info, `-vv` = debug, default silent. `FREELO_DEBUG=1` ≡ `-vv`. |
| `--request-id` | uuid | generated | Passthrough to server logs; surfaced in error envelope for correlation. |
| `--yes / -y` | — | false | Skips destructive-op confirmation. Required in non-TTY for any destructive op. |
| `--dry-run` | — | false | Only on write commands. Returns would-be result without calling the API. |

No `--json` shorthand. It would duplicate `--output json` and create two ways to say the same thing.

## Output modes

### `json` — one envelope

```jsonc
{
  "schema": "freelo.tasks.list/v1",
  "data": [ /* resource(s) */ ],
  "paging": { "page": 0, "per_page": 25, "total": 137, "next_cursor": 1 },
  "rate_limit": { "remaining": 42, "reset_at": "2026-04-24T18:30:00Z" },
  "request_id": "7e6f0c3e-2a..."
}
```

Rules:

- `schema` is mandatory on every envelope; format `freelo.<resource>.<op>/v<n>`.
- `paging`, `rate_limit`, `request_id` are omitted when inapplicable (no HTTP call, non-list op).
- Single-object reads put the object at `data`, not wrapped in an array.
- `dry_run: true` plus a `would` sibling when `--dry-run` is set; no HTTP write is made.
- Field removal or rename = breaking change (bump `schema` version and the changeset type).
- Additions are backwards-compatible; document in the changeset.

### `ndjson` — one envelope per line

Used for large lists (agents stream) and batch writes (one output line per input line). Same envelope shape, newline-separated, no outer array. `paging` omitted per-line; summary envelope may be emitted last with `schema: freelo.*/summary`.

### `human` — tables, colors, spinners

For interactive TTY use. Opt-in via `--output human` or implicit via `auto` + TTY. Never the default under automation.

### Error envelope (all modes)

```jsonc
{
  "schema": "freelo.error/v1",
  "error": {
    "code": "FREELO_API_ERROR",
    "message": "Could not fetch project 42.",
    "errors": ["Forbidden"],
    "http_status": 403,
    "request_id": "7e6f0c3e-...",
    "retryable": false,
    "hint_next": "Run `freelo auth whoami` to verify your token has access.",
    "docs_url": "https://…"
  }
}
```

- Written to **stderr** in `json`/`ndjson` mode.
- In `human` mode, the formatter prints `message` + `hint_next` to stderr; the envelope goes to stderr too when `FREELO_DEBUG=1`.
- Agents get the same shape whether the failure was local validation (`VALIDATION_ERROR`), auth (`AUTH_ERROR`), API (`FREELO_API_ERROR`), or network (`NETWORK_ERROR`).

## `src/commands/`

One file per top-level subcommand, colocated with its subsubcommands. Each file exports a `register(program: Command)` function.

```
commands/
├── auth.ts       freelo auth login | logout | whoami
├── projects.ts   freelo projects list | show | create
├── tasks.ts      freelo tasks list | show | create | finish | …
├── time.ts       freelo time start | stop | status
└── config.ts     freelo config get | set | list | resolve | use
```

A command file is thin: parse → call API → hand to renderer. No business logic inline; if a command grows past ~100 lines, extract into `src/lib/` or `src/api/`.

**Every command that returns data must declare its output schema** — the zod type used by the renderer to emit `schema: "freelo.<resource>.<op>/v1"`. See `.claude/docs/conventions.md` §Output schemas.

### Destructive ops

Any destructive command (`delete`, `archive`, `detach`) must:

1. Require `--yes` to proceed without a prompt, OR prompt interactively on TTY.
2. In non-TTY without `--yes`, **exit 2** with `code: "CONFIRMATION_REQUIRED"` and `hint_next: "re-run with --yes"`. Never hang.
3. Support `--dry-run` returning the target's current state.

### Idempotency policy

Writes that target an absorbing state treat "already in state" as success:

- `tasks finish` on a finished task → `already_in_target_state: true`, exit 0.
- `projects archive` on an archived project → same.
- `notifications read` on a read notification → same.
- `comments delete` on a deleted comment → same (by ID).

Rationale: agents retry. A retry hitting "already done" must not look like failure.

### Batch and stdin input

Every write command that takes an ID supports:

- `--id <id>` (repeatable), or a positional form
- `--ids a,b,c` (comma-separated)
- `--stdin` reading NDJSON, one object per line, with fields named as for the flags

Output in batch mode is NDJSON by default (one envelope per input line) regardless of `--output` unless `--output json` forces a single array envelope.

## `src/api/`

Typed client for the Freelo REST API.

```
api/
├── client.ts        undici HTTP client with auth, UA header, retry, rate-limit parsing
├── pagination.ts    normalizes Freelo's paginated response into { data, page, perPage, total, nextCursor }
├── schemas/         zod schemas per resource (one source of runtime truth)
├── projects.ts      listProjects(), getProject(id), ...
├── tasks.ts
└── errors.ts        FreeloApiError with status, requestId, and raw payload
```

Rules:

- **Every response is parsed through a zod schema.** If validation fails, throw `FreeloApiError` with the raw payload attached.
- **Pagination is surfaced explicitly.** List endpoints return `{ data, page, perPage, total, nextCursor }`; callers decide whether to auto-paginate via `--all` or expose `nextCursor` to the agent.
- **Rate-limit info is captured and returned**, not only acted on. Callers pass it through to the envelope.
- **`429 Too Many Requests`**: GETs retry with jittered exponential backoff (max 3). Writes do **not** auto-retry — the error surfaces so the agent can decide.
- **Auth injected by the client, not by callers.** API functions take params, not tokens.
- **Every call accepts an `AbortSignal`** so SIGINT propagates.

## `src/config/`

Three config sources, merged at startup; first match wins for secrets:

### Credential sources (highest precedence first)

1. CLI flag (`--api-key-stdin`, read from stdin once at startup)
2. Env vars: `FREELO_API_KEY` + `FREELO_EMAIL` (or `FREELO_TOKEN`)
3. OS keychain (`keytar`) — **skipped entirely** when env vars are present or `FREELO_NO_KEYCHAIN=1` is set
4. `conf`-backed config file (0600 perms) — fallback when keychain is unavailable

### Non-secret settings (highest precedence first)

1. CLI flag (`--profile`, `--output`, etc.)
2. Env vars (`FREELO_PROFILE`, `FREELO_OUTPUT`, ...)
3. Project config (`cosmiconfig` — `.freelorc.*`, `freelo.config.ts`)
4. User config (`conf`)
5. Built-in defaults

The resolved config is exposed as a frozen `AppConfig` object. Commands never read env vars directly. `freelo config resolve --output json` emits the merged config minus secrets, annotated with each setting's source (useful for agents debugging drift).

## `src/ui/`

Renderers. The command picks a mode and delegates.

```
ui/
├── render.ts      dispatch on mode (auto | human | json | ndjson)
├── envelope.ts    builds the JSON envelope (schema, data, paging, rate_limit, request_id)
├── table.ts       cli-table3 wrapper — lazy-loaded, human mode only
├── json.ts        stdout, newline-terminated
├── ndjson.ts      one envelope per record
└── styles.ts      chalk palette — lazy-loaded, human mode only
```

Rules:

- Every command that returns data must go through `ui/envelope.ts`. Direct `console.log` of payloads is a bug.
- Human-mode renderers (`table`, `styles`) are behind `await import('…')` so the agent path never loads them.
- No YAML. Two structured modes (json/ndjson) are enough.

## `src/errors/`

Typed error hierarchy:

```
BaseError
├── ConfigError          missing/malformed config, keychain unavailable
├── ValidationError      bad user input, zod parse of CLI args failed
├── FreeloApiError       4xx/5xx (status, errors[], requestId, rawBody)
├── NetworkError         undici connection failures, timeouts
├── ConfirmationError    destructive op in non-TTY without --yes
└── RateLimitedError     429 after retry budget (writes) or explicit caller choice
```

Each error exposes `code` (string), `exitCode` (number), `httpStatus?`, `retryable` (bool), `hintNext?` (string).

`bin/freelo.ts` has a single `handleTopLevelError` that:

- In non-TTY / `json` mode: writes a structured error envelope to **stderr**, exits with the error's `exitCode`.
- In TTY / `human` mode: prints a clean message + `hintNext` to stderr; full envelope only when `FREELO_DEBUG=1`.
- Never prints a stack trace by default. `FREELO_DEBUG=1` or `-vv` enables it.
- **Never** prints a secret or a token — the `FreeloApiError` scrubs Authorization-like fields before logging.

## `src/lib/`

Pure utilities. No I/O, no global state. Examples: `formatDuration`, `parseHumanDate`, `asyncPool`, `money`, `confirm` (wraps prompt + `--yes` logic), `ndjson` (stdin reader), `introspect` (command-tree → JSON).

## Introspection (`freelo --introspect`)

Agents need to enumerate the surface programmatically.

```
freelo --introspect            # prints a single JSON envelope to stdout
freelo help --output json      # same content; human-friendly alias
```

Shape:

```jsonc
{
  "schema": "freelo.introspect/v1",
  "data": {
    "version": "1.2.3",
    "commands": [
      {
        "name": "tasks list",
        "description": "...",
        "args": [ /* positional */ ],
        "flags": [ { "name": "--project", "short": null, "type": "string[]", "required": false, "description": "..." } ],
        "output_schema": "freelo.tasks.list/v1",
        "destructive": false
      }
    ]
  }
}
```

Generated at runtime from the Commander program tree — no hand-maintained list.

## Testing

Mirrors source:

```
test/
├── commands/*.test.ts       integration tests, spawn-style via programmatic Commander
├── api/*.test.ts            unit tests with MSW
├── lib/*.test.ts            pure-function unit tests
├── ui/*.test.ts             envelope shape + non-TTY default behavior
├── fixtures/*.json          scrubbed Freelo API responses
└── msw/handlers.ts          shared MSW handlers
```

Every command test must cover:

- Human output on TTY.
- JSON envelope on non-TTY (assert `schema`, key fields, stable key order isn't required but presence is).
- Error envelope on a forced failure (401 or 500).

## Observability

- `pino` logger on stderr, default **silent**.
- `-v` enables `info` level (one line per API call). `-vv` or `FREELO_DEBUG=1` enables `debug` (full request/response metadata, request IDs).
- `pino-pretty` is lazy-loaded; only attached in TTY + `human` mode.
- **Nothing is sent off the user's machine.** No telemetry, ever.

## Cross-cutting concerns

- **Auth expiry** is detected centrally in `api/client.ts` and rethrown as `ConfigError` with `code: "AUTH_EXPIRED"` and `hint_next: "run \`freelo auth login\`"`.
- **TTY detection** lives in `src/lib/env.ts` — `isInteractive`, `wantsColor`. Nowhere else reads `process.stdout.isTTY`.
- **Rate-limit info** is captured once in `api/client.ts` and attached to every successful response. The renderer drops it into the envelope automatically.
- **Lazy deps** policy: any module whose only purpose is human UX (`@inquirer/prompts`, `ora`, `boxen`, `cli-table3`, `chalk`, `pino-pretty`) must be imported via `await import('…')` behind an `isInteractive` check. ESLint rule enforces.
- **i18n**: deferred. English only in v1. Design strings so they can be externalized later.

## Stability contract

All `schema` values are part of the public API of the CLI.

- **Adding a field** to an envelope is non-breaking (`minor`).
- **Removing or renaming a field, or changing its type** is breaking. Bump the envelope version (`/v2`) and include both versions for one minor release window via `--output-schema-version` if the change is widespread. Callout in the changeset required.
- **Exit codes** are part of the contract. Adding a new code is minor; repurposing an existing one is major.
- **Flag names** are part of the contract. Removing or renaming flags is breaking.

Agents pin a CLI version via `package.json`; schema is stable within a minor.
