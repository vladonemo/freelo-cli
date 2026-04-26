# Phase 4 — Implement

**Run:** 2026-04-26-1848-r05-5-hardening

Three commits landed on `fix/r05-5-hardening`:

- `dacc4bc` fix(api): tolerate null fullname and numeric currency amounts in response schemas
- `0af60de` fix(errors): destroy undici dispatcher and defer exit to fix Windows libuv crash
- `4aad2ad` test: regression for Windows libuv UV_HANDLE_CLOSING on zod-fail exit

## Notable implementation choices

### Type plumbing for `.transform`-aware schemas

`CurrencySchema.amount` now uses `.transform((v) => String(v))`. This makes
`z.input<S>` (string|number) different from `z.output<S>` (string). The
existing `RequestOptions<T>` and `normalizePaginated<T>` typings used
`ZodSchema<T>` which collapses input == output, blocking the transform.

Refactored to `<S extends ZodTypeAny>` plus `Promise<ApiResponse<z.output<S>>>`.
This is a strictly more general typing — all existing callers that don't
use `.transform` are unaffected (`z.output<S> === z.infer<S>` for those).
One unsafe-assignment ESLint warning surfaced and was annotated with a
narrow `as z.output<S>` cast (the value is what `safeParse` returned).

### libuv fix layering

`drainDispatcher` now uses `dispatcher.destroy()` raced against a 250 ms
timeout. New helper `exitDeferred(code)` returns a `Promise<never>` that
resolves never (production: `process.exit` ends the process before the
promise can settle; test: mocked `process.exit` throws, which is caught
inside the setImmediate callback and routed to `reject`, so the existing
`await expect(...).rejects.toThrow('process.exit(N)')` assertions keep
working).

### Self-correction loops triggered

- 1 type-error retry: initial schema edits broke `client.request<T>` and
  `normalizePaginated<T>`. Diagnosed as input-vs-output collision from
  `.transform`; refactored typing.
- 1 lint retry: ESLint `no-unsafe-assignment` on `parsed.data`; resolved
  with a narrow cast.
- 1 commit-msg retry: `test(integration)` rejected by commitlint; the
  allowed-scope list doesn't include `integration`. Switched to plain
  `test:` per Conventional Commits spec.
- 1 test-impl retry: integration test initially used `spawnSync`, which
  blocks the test runner's event loop and starves the in-process stub
  server. Switched to `spawn` (async). Then a deprecation warning around
  `shell: true + args` led to switching from `tsx.cmd` to
  `node --import tsx src/bin/freelo.ts`.

All retries made progress on each iteration (no stuck-loop trigger).

## Pre-existing flake

`test/config/resolve.test.ts` "all sources are default when nothing is
set" fails locally on Windows because the test reads from a real `conf`
store on disk and my user profile has a saved `default` profile state.
Verified the failure exists on `main` (commit `7f9be99`) too. CI on
clean GitHub runners passes it. Not introduced by R05.5 — not gating
this run.
