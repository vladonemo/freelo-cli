# Conventions

Code style and patterns. ESLint + Prettier catch most mechanical things; this doc covers the judgment calls.

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

## Async

- `async`/`await` only. No `.then()` chains.
- Always handle rejection at a boundary. The only place that catches-all is `bin/freelo.ts`.
- Don't await in a loop when the iterations are independent — use `Promise.all` or `asyncPool` for bounded concurrency.

## Errors

- Throw typed errors from `src/errors/`. Never `throw new Error('...')` in library code.
- Error messages are for humans. Include the missing/offending value when safe.
- Never include tokens or secrets in error messages.
- `cause:` chains are encouraged — they show up in debug output.

## API client

- Every response through a zod schema. No exceptions.
- Endpoints go in `src/api/<resource>.ts` as plain async functions. No classes.
- Functions take a typed params object, not positional args (except a single-id lookup).
- Pagination helpers live next to the endpoint that needs them.

## Commands

- `register(program)` is the only export.
- Long flag descriptions are sentences, end with a period, no emoji.
- Short flags sparingly: `-h/--help` (free), `-v/--verbose`, `-o/--output`. Don't invent new ones without a reason.
- Every command supports `--output json|yaml|table` (default table for lists, pretty-print for single objects).
- Prompts only when `process.stdout.isTTY && !opts.yes`. `--yes/-y` skips confirmations.

## Output / UX

- Primary output to **stdout**, logs/errors to **stderr**. Don't mix.
- Colors only on TTY. `chalk` handles this; don't bypass.
- Tables: left-align text, right-align numbers, humanize durations (`3h 14m`), ISO for dates unless `--relative`.
- Spinners start on the request, stop before output.

## Tests

- Filename: `foo.test.ts` next to `foo.ts` where practical, or mirror under `test/` for commands/integration.
- One `describe` per unit. `it` descriptions are sentences starting with the subject: `'returns the parsed project'`.
- No real HTTP — MSW for everything in `src/api/`.
- Fixtures are realistic payloads scrubbed of PII. One fixture per scenario, not mega-fixtures.

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

Choose `patch` / `minor` / `major` per SemVer. Pre-1.0, breaking = minor.

## Naming

- Files: `kebab-case.ts`. Exception: React-like components — we don't have those.
- Exports: `camelCase` for functions/values, `PascalCase` for types and classes.
- Zod schemas: `FooSchema`, inferred type `Foo`.
- Env vars: `FREELO_*`, SCREAMING_SNAKE.

## Comments

Default to none. Write one when the **why** is non-obvious:
- A workaround for a specific API quirk (link the Freelo docs or issue).
- An invariant the reader can't derive from the code.
- A performance-critical choice that looks wrong.

Don't write comments that restate the code or reference the current task. Those rot.

## Dependencies

- New dep requires a note in the spec's Plan and a line in `.claude/docs/tech-stack.md` (or a deliberate exception).
- Prefer `dependencies` with tight ranges; `devDependencies` can be looser.
- Run `pnpm audit` on every PR (CI does this).
