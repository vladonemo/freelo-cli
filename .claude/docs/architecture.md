# Architecture

High-level structure of the Freelo CLI. Read this before making cross-cutting changes.

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
1. Build the root Commander program
2. Register each subcommand from `src/commands/`
3. Wrap `program.parseAsync` in a try/catch that maps typed errors to exit codes and human-readable output
4. Handle `SIGINT` gracefully (don't leave a spinner running)

Exit codes:
- `0` success
- `1` generic failure
- `2` usage / arg error
- `3` auth error (missing/expired token)
- `4` API error (4xx/5xx from Freelo)
- `5` network error
- `130` SIGINT

## `src/commands/`

One file per top-level subcommand, colocated with its subsubcommands. Each file exports a `register(program: Command)` function.

```
commands/
├── auth.ts       freelo auth login | logout | status
├── projects.ts   freelo projects list | get | create
├── tasks.ts      freelo tasks list | get | create | complete
├── time.ts       freelo time start | stop | list
└── config.ts     freelo config get | set | path
```

A command file is thin: parse → call API → render. No business logic inline; if a command grows past ~100 lines, extract into `src/lib/` or `src/api/`.

## `src/api/`

Typed client for the Freelo REST API.

```
api/
├── client.ts         undici-backed HTTP client with auth, retry, rate-limit handling
├── schemas/          zod schemas per resource
├── projects.ts       listProjects(), getProject(id), ...
├── tasks.ts
├── time.ts
└── errors.ts         FreeloApiError with status, code, requestId
```

Rules:
- **Every response is parsed through a zod schema.** If validation fails, throw `FreeloApiError` with the original payload attached for debugging.
- **Pagination is surfaced explicitly.** List endpoints return `{ data, nextCursor }`; callers decide whether to auto-paginate.
- **Rate limits respected.** On `429`, read `Retry-After` and wait (with a ceiling). Surface to the user via `ora` text.
- **Auth injected by the client, not by callers.** API functions take params, not tokens.

## `src/config/`

Two config sources, merged at startup:

1. **User config** (`conf`) — `~/.config/freelo-cli/config.json`. Profiles, default project, output format.
2. **Project config** (`cosmiconfig`) — picked up from CWD: `freelo.config.{ts,js,json}`, `.freelorc`. Overrides user config for that repo.

Env vars (`FREELO_TOKEN`, `FREELO_PROFILE`) override both.

The resolved config is exposed as a frozen `AppConfig` object. Commands never read env vars directly.

## `src/ui/`

Renderers. Each command picks an output mode (`human` default, `json`, `yaml`) and delegates.

```
ui/
├── render.ts      dispatch on mode
├── table.ts       cli-table3 with sensible defaults
├── json.ts        stdout, newline-terminated
├── yaml.ts
└── styles.ts      chalk palette (one place to tweak)
```

Every command that returns data must support all modes. Rule of thumb: if you `console.log` anywhere outside `ui/`, that's a bug.

## `src/errors/`

Typed error hierarchy:

```
BaseError
├── ConfigError          missing token, malformed config
├── ValidationError      bad user input, failed zod parse of CLI args
├── FreeloApiError       4xx/5xx from the API (has status, code, requestId)
└── NetworkError         undici connection failures
```

`bin/freelo.ts` has a single `handleTopLevelError` that:
- prints a clean message (no stack trace unless `FREELO_DEBUG=1`)
- picks the right exit code
- in `--json` mode, writes `{ error: { code, message } }` to stderr

## `src/lib/`

Pure utilities. No I/O, no global state. Examples: `formatDuration`, `parseHumanDate`, `asyncPool`.

## Testing

Mirrors source:

```
test/
├── commands/*.test.ts       integration tests (spawn-style via programmatic Commander)
├── api/*.test.ts            unit tests with MSW
├── lib/*.test.ts            pure-function unit tests
├── fixtures/*.json          scrubbed Freelo API responses
└── msw/handlers.ts          shared MSW handlers
```

## Observability

- `pino` logger, level via `FREELO_LOG=debug|info|warn|error` (default `warn`).
- Every API call logs at `debug`: method, path, status, duration, requestId.
- **Nothing is sent off the user's machine.** No telemetry.

## Cross-cutting concerns

- **Auth expiry** is detected centrally in `api/client.ts` and rethrown as `ConfigError` with a hint to run `freelo auth login`.
- **Interactive vs non-interactive** is detected once (`process.stdout.isTTY`). Non-TTY = no prompts, no spinners, default to `--json`-friendly output.
- **i18n**: deferred. English only in v1. Design strings so they can be externalized later.
