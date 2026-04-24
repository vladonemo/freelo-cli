# Conventions

Code style and patterns. ESLint + Prettier catch most mechanical things; this doc covers the judgment calls. The CLI is **agent-first** — see `.claude/docs/architecture.md` §Audience for the policy these conventions implement.

## TypeScript

- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.
- **No `any`**, no `as unknown as T`. If you need an escape hatch, add a zod schema and parse.
- Prefer `type` over `interface` unless declaration merging is genuinely needed.
- Exported functions have explicit return types. Internal helpers can infer.
- Discriminated unions over boolean flags: `{ kind: 'ok', value } | { kind: 'err', error }`.

## Imports

- Always use explicit `.js` extensions in relative imports (ESM requirement): `import { foo } from './bar.js'`.
- Order: node builtins, external, internal absolute (`#api/*`), internal relative. ESLint enforces.
- Use `node:` prefix for builtins: `import { readFile } from 'node:fs/promises'`.
- **Lazy-import human-UX deps.** `@inquirer/prompts`, `ora`, `boxen`, `chalk`, `cli-table3`, `pino-pretty` must be loaded via `await import('…')` behind an `isInteractive` check. Top-level static imports of these are a bug — the agent cold path should not pay for them. ESLint rule `no-restricted-imports` enforces.

## Async

- `async`/`await` only. No `.then()` chains.
- Always handle rejection at a boundary. The only place that catches-all is `bin/freelo.ts`.
- Don't await in a loop when the iterations are independent — use `Promise.all` or `asyncPool` for bounded concurrency.
- Every async API call accepts an `AbortSignal` so SIGINT can cancel in-flight work.

## Errors

- Throw typed errors from `src/errors/`. Never `throw new Error('...')` in library code.
- Every error carries `code` (string), `exitCode` (number), `retryable` (boolean), optionally `httpStatus`, `requestId`, `hintNext`.
- `message` is for humans; machine consumers read `code` + `http_status`. Include the offending value when safe.
- Never include tokens or secrets in error messages or logs. The API client scrubs `Authorization` and `x-api-key` before logging.
- `cause:` chains are encouraged — they show up in `--vv` debug output.

## API client

- Every response through a zod schema. No exceptions.
- Endpoints go in `src/api/<resource>.ts` as plain async functions. No classes.
- Functions take a typed params object, not positional args (except a single-id lookup).
- Pagination helpers live next to the endpoint that needs them.
- Every response carries `rateLimit` metadata (parsed from headers); the renderer forwards it into the JSON envelope.
- Writes do **not** auto-retry on 429 — the error surfaces so the caller (or agent) can decide. GETs retry with jittered backoff, max 3.

## Commands

- `register(program)` is the only export.
- Long flag descriptions are sentences, end with a period, no emoji.
- Short flags sparingly: `-h/--help` (free), `-v/-vv` (verbosity), `-y/--yes`, `-o/--output`. Don't invent new short forms without a reason.
- Every command that returns data declares its `outputSchema` (e.g. `freelo.tasks.list/v1`) and routes through `src/ui/envelope.ts`.
- **Output-mode default is `auto`:** JSON when stdout is not a TTY, human when it is. Never human-by-default for automation paths.
- Prompts only when `isInteractive && !opts.yes`. In non-TTY, a destructive op without `--yes` **fails with a `ConfirmationError` (exit 2)** — it never hangs.
- **Idempotent writes** (finish, archive, mark-read, delete-by-id) return success with `already_in_target_state: true` when the target is already in the absorbing state.
- **Every write command supports `--dry-run`** returning a `would` payload with no side-effect HTTP call.
- **Every write command that takes an ID** accepts `--id` (repeatable), `--ids a,b,c`, and `--stdin` (NDJSON). Batch output is NDJSON unless `--output json` forces a single array envelope.

## Output / UX

- Primary output to **stdout**, logs/errors to **stderr**. Don't mix.
- **Colors only when `wantsColor`** (TTY + not `NO_COLOR` + `--color=auto`). `chalk` handles this; don't bypass.
- **Spinners only in `human` mode.** Never attached in `json` / `ndjson` / non-TTY paths — they corrupt structured output.
- Tables: left-align text, right-align numbers, humanize durations (`3h 14m`), ISO for dates unless `--relative`.
- Emoji in output is banned. ASCII symbols (`✓`, `✗`) allowed only in `human` mode.
- No `console.log` outside `src/ui/` or `src/bin/`. Violations are caught by ESLint.

## Output schemas

- Each command that returns data owns a schema name: `freelo.<resource>.<op>/v<n>`.
- The schema name is a string literal in the command file, emitted into every envelope.
- Adding a field to an envelope → minor bump, documented in the changeset.
- Removing, renaming, or retyping a field → breaking. Bump `/v1 → /v2` and include a deprecation note in the help text.
- Reviewer blocks a PR that changes an existing envelope without a version bump + changeset callout.

## Tests

- Filename: `foo.test.ts` next to `foo.ts` where practical, or mirror under `test/` for commands/integration.
- One `describe` per unit. `it` descriptions are sentences starting with the subject: `'returns the parsed project'`.
- No real HTTP — MSW for everything in `src/api/`.
- Fixtures are realistic payloads scrubbed of PII. One fixture per scenario, not mega-fixtures.
- **Every command test** asserts: (a) human output on simulated TTY, (b) JSON envelope shape on non-TTY, (c) structured error envelope on a forced failure.
- Coverage target: **80% lines, 90% on `src/api/` and `src/commands/`**. Don't chase 100%.

## Commits

Conventional Commits, enforced:

```
<type>(<scope>): <subject>

<body>

<footer>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `build`, `ci`.
Scopes mirror top-level folders: `api`, `commands`, `config`, `ui`, `lib`.

Subject imperative, lowercase, no trailing period. Body wraps at 72.

## Changesets

A user-visible change **must** have a changeset:

```bash
pnpm changeset
```

Choose `patch` / `minor` / `major` per SemVer. Pre-1.0, breaking = minor. **Envelope schema changes require an explicit line in the changeset** — either "schema `freelo.X/vN` added" or "schema `freelo.X/vN` bumped, fields removed: …".

## Naming

- Files: `kebab-case.ts`. Exception: React-like components — we don't have those.
- Exports: `camelCase` for functions/values, `PascalCase` for types and classes.
- Zod schemas: `FooSchema`, inferred type `Foo`.
- Env vars: `FREELO_*`, SCREAMING_SNAKE. Secret env vars end in `_KEY` or `_TOKEN`.
- Error codes: SCREAMING_SNAKE strings, stable: `AUTH_EXPIRED`, `AUTH_MISSING`, `FREELO_API_ERROR`, `CONFIRMATION_REQUIRED`, `VALIDATION_ERROR`, `NETWORK_ERROR`, `RATE_LIMITED`, `CONFIG_ERROR`, `INTERNAL_ERROR` (catastrophic last-resort in the CLI bootstrap path).

## Comments

Default to none. Write one when the **why** is non-obvious:
- A workaround for a specific API quirk (link the Freelo docs or issue).
- An invariant the reader can't derive from the code.
- A performance-critical choice that looks wrong.

Don't write comments that restate the code or reference the current task. Those rot.

## Dependencies

- New dep requires a note in the spec's Plan and a line in `.claude/docs/tech-stack.md` (or a deliberate exception).
- Prefer `dependencies` with tight ranges; `devDependencies` can be looser.
- Human-UX deps must be importable lazily — prefer libraries with no top-level side effects.
- Run `pnpm audit` on every PR (CI does this).
