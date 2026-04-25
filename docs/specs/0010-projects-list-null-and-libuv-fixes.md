# Spec 0010 — `freelo projects list` null tolerance + Windows libuv exit fix

**Status:** Draft → ready for plan
**Tier:** Yellow
**Run:** `2026-04-26-0141-r03-null-and-libuv-fixes`
**Branch:** `fix/projects-list-null-and-libuv`

Two unrelated bugs surfaced by the same real-world report on `freelo-cli@0.5.1`
under Windows. Both are patch-tier; both must land in this run.

The reproducing invocation:

```
freelo projects list
freelo: Unexpected response shape from GET /projects: [
  { "code": "invalid_type", "expected": "object", "received": "null", "path": [0, "client"], ... },
  ...
]
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
```

---

## 1. Bug A — schema rejects `null` on optional complex fields

### 1.1 Root cause

`src/api/schemas/project.ts:54` declares `client: ClientSchema.optional()`.
Zod's `.optional()` accepts `undefined` only; it does not accept `null`.
The live Freelo API returns `client: null` (literal JSON null) for projects
without a client. Parse fails on every project — three errors in the user's
report, one per item in the page.

### 1.2 Fix

For every `.optional()` field in `src/api/schemas/` whose value is a complex
type (object/array) **or** could plausibly be `null`-rendered by the server,
chain `.nullable().optional()`. The combination accepts `undefined`, `null`,
and a value, which matches what real APIs actually do.

Sweep targets in `src/api/schemas/project.ts`:

| Field | Before | After |
|---|---|---|
| `ProjectWithTasklists.client` | `.optional()` | `.nullable().optional()` |
| `ProjectWithTasklists.tasklists` | `.optional()` (array) | `.nullable().optional()` |
| `ProjectWithTasklists.date_add` | `.optional()` | `.nullable().optional()` |
| `ProjectWithTasklists.date_edited_at` | `.optional()` | `.nullable().optional()` |
| `ProjectFull.owner` | `.optional()` | `.nullable().optional()` |
| `ProjectFull.state` | `.optional()` | `.nullable().optional()` |
| `ProjectFull.budget` | `.optional()` | `.nullable().optional()` |
| `ProjectFull.real_cost` | `.optional()` | `.nullable().optional()` |
| `ProjectFull.real_minutes_spent` | `.optional()` | `.nullable().optional()` |
| `ProjectFull.date_add` / `date_edited_at` | `.optional()` | `.nullable().optional()` |
| `ClientSchema.email` | `.optional()` (string) | `.nullable().optional()` |
| `ClientSchema.name` | `.optional()` | `.nullable().optional()` |
| `ClientSchema.company` | `.optional()` | `.nullable().optional()` |
| `ClientSchema.company_id` | `.optional()` | `.nullable().optional()` |
| `ClientSchema.company_tax_id` | `.optional()` | `.nullable().optional()` |
| `ClientSchema.street` | `.optional()` | `.nullable().optional()` |
| `ClientSchema.town` | `.optional()` | `.nullable().optional()` |
| `ClientSchema.zip` | `.optional()` | `.nullable().optional()` |

`UserBasicSchema.fullname` is **required** today — leave alone unless a
real-world report says otherwise. Same for `UserBasicSchema.id` and the
`StateSchema` enum (those are spec-required keys).

`ProjectFull.minutes_budget` is already `.nullable().optional()` — fine.

`src/api/schemas/users-me.ts`: `UserMeSchema` uses `.passthrough()` and only
declares `id` as required; no optional fields exist to relax. No change.

`src/api/schemas/error.ts`: the inner-error union is `string | { message }`;
both forms are required where they appear. No change.

### 1.3 Policy

This run treats nullable-vs-optional as a single class. Going forward,
**every optional field on an inbound API response schema should also be
nullable** unless we have a documented reason to enforce absent-vs-null.

Captured in `.claude/docs/conventions.md` (one-liner under "API client").
Decision-log entry records the rationale.

### 1.4 Test plan

- New fixture `test/fixtures/projects/owned-with-null-client.json` — three
  projects, all with `"client": null`. One has a missing `tasklists` (absent),
  one has `"tasklists": null`, one has a normal array. Mirrors the real-world
  shapes the user is hitting.
- New unit test in `test/api/schemas/project.test.ts` asserting the schemas
  accept `null` on each relaxed field.
- New integration test in `test/api/projects.test.ts` — `getOwnedProjects`
  parses the new fixture without throwing and emits an array with three
  items where `client` is `null`.

---

## 2. Bug B — Windows libuv crash on `process.exit()`

### 2.1 Root cause

`src/errors/handle.ts:89` calls `process.exit(typed.exitCode)` synchronously
after writing the error envelope. By the time we reach this line:

- `undici` has performed at least one `GET /projects` request via its global
  dispatcher (a `Pool`/`Agent` with keep-alive sockets).
- The dispatcher still holds open sockets and a per-pool worker.
- On Windows, libuv's strict async-handle teardown asserts
  `!(handle->flags & UV_HANDLE_CLOSING)` when the socket-close path tries to
  signal the main thread mid-exit.

Result: the CLI prints the error envelope correctly, then dies with a libuv
assertion before returning a deterministic exit code to the shell.

The same risk exists for the `process.exit(130)` SIGINT branch in
`handleTopLevelError` (`handle.ts:52`) and the SIGINT handler in
`src/bin/freelo.ts:233`. Both are fixed identically.

### 2.2 Fix

Convert `handleTopLevelError` to `Promise<never>` (returns a never-resolving
promise — it always exits). Before each `process.exit`, drain the global
undici dispatcher with a best-effort `.close()`. Errors from `.close()` are
swallowed; the original exit code is preserved.

```ts
import { getGlobalDispatcher } from 'undici';

async function drainDispatcher(): Promise<void> {
  try {
    await getGlobalDispatcher().close();
  } catch {
    // best-effort cleanup; never mask the original exit code
  }
}

export async function handleTopLevelError(err: unknown, mode: OutputMode): Promise<never> {
  if (isAbortError(err)) {
    await drainDispatcher();
    process.exit(130);
  }
  // ... existing classify + emit logic ...
  await drainDispatcher();
  process.exit(typed.exitCode);
}
```

Callers in `src/bin/freelo.ts:126` and `src/bin/freelo.ts:181` already
`await`-able (they live in async contexts) — add `await`. The bootstrap
`.catch` in `src/bin/freelo.ts:236` calls `process.exit` directly; convert
that path too. The SIGINT handler at line 231 uses sync `process.exit(130)`;
convert to fire-and-forget with `void drainDispatcher().finally(...)` so we
don't block the signal handler (Ctrl-C must still feel snappy).

### 2.3 Out of scope

- `pino-pretty` is loaded as a transport function (`pinoPretty.build(...)`)
  inside the same process — no worker thread. `pino.destination` uses
  `sync: false` but writes to a file descriptor in-process. Neither matches
  the libuv class of bug. **Defer** unless a follow-up report says otherwise.
- `keytar` (native binding) is only used at startup for credential
  resolution; by error-time it is idle. **Defer.**
- `conf` is synchronous and has no async handles. **Skip.**

### 2.4 Test plan

- New unit test in `test/errors/handle.test.ts` that mocks `getGlobalDispatcher`
  via `vi.mock('undici', ...)`. Assert `.close()` is called before
  `process.exit`. The libuv crash itself can't be reproduced in test (needs
  real Windows + real sockets); verifying the close call is the proxy
  assertion.
- Existing handle tests must continue to pass after the async signature
  change. Tests already use `expect(() => handleTopLevelError(...)).toThrow()`
  which is incompatible with an async function; tests are updated to
  `await expect(handleTopLevelError(...)).rejects.toThrow()`.

---

## 3. Edge cases

- A project with `client: null` and a missing `tasklists`: must parse, must
  emit `client: null` and `tasklists: undefined` in the JSON envelope.
- `getGlobalDispatcher().close()` is idempotent in undici; calling it on
  an already-closed dispatcher resolves immediately — no special handling
  needed.
- If `.close()` rejects for any reason, we still exit with the correct code.
- Tests that don't use undici (most of `handle.test.ts`) call
  `getGlobalDispatcher()` for the first time inside the handler. We mock
  the function, not the dispatcher, so test runtime stays fast.

---

## 4. Non-goals

- No change to envelope schema versioning. Field semantics are unchanged;
  we are only widening the input parser. `freelo.projects.list/v1` stays.
- No change to error envelope, exit codes, or hint text.
- No new commands, no new flags.
- No change to `src/api/client.ts` retry logic or dispatcher configuration.
- No changes to pino or pino-pretty.

---

## 5. Open questions

None blocking. The convention update ("optional fields are nullable too")
is captured as a decision-log entry; the architect is empowered to make
this call per the autonomous-SDLC autonomous-decisions table.

---

## 6. Risk

- **Schema relaxation:** widening only. Cannot introduce a regression for
  existing parseable payloads.
- **Async error handler:** the only behavioral change is a sub-millisecond
  delay before exit. Tests for exit codes still hold. The risk is a
  hung process if undici's `.close()` blocks indefinitely; the in-process
  observation is that it resolves in ms when there are no in-flight
  requests, and after the error envelope has been written we have nothing
  in flight by definition.
- **Windows-only crash** is the only thing we can't directly reproduce in
  CI. Test asserts the correct sequence; production validates the fix.

---

## 7. Schema-stability statement

`freelo.projects.list/v1` data shape is unchanged. Inbound parser is more
permissive; outbound envelope still emits the same fields with `null` where
appropriate (which the v1 schema already permits via the `.passthrough()`
on each item).

`freelo.error/v1` envelope unchanged.

No `/v(n+1)` bump required.

---

## 8. Plan

### 8.1 Files to touch

| File | Change |
|---|---|
| `src/api/schemas/project.ts` | Add `.nullable()` to every `.optional()` field per §1.2. |
| `src/errors/handle.ts` | Convert `handleTopLevelError` to `async`. Add `drainDispatcher` helper. Use it before every `process.exit`. |
| `src/bin/freelo.ts` | `await` the new async `handleTopLevelError` at lines 126 and 181. Update SIGINT handler at line 231 to drain dispatcher before exit (fire-and-forget). Update bootstrap `.catch` at line 236 to drain too. |
| `.claude/docs/conventions.md` | One-line addition under "API client": *"Every optional field on an inbound API response schema is also `.nullable()` — Freelo uses `null` and absent interchangeably, and we don't enforce a distinction it doesn't enforce."* |
| `test/fixtures/projects/owned-with-null-client.json` | New fixture — 3 projects with `client: null` plus tasklists in three states (array, null, missing). |
| `test/api/schemas/project.test.ts` | New cases asserting `null` is accepted on relaxed fields. |
| `test/api/projects.test.ts` | New case for `getOwnedProjects` parsing `owned-with-null-client.json`. |
| `test/errors/handle.test.ts` | Update to `await` async `handleTopLevelError`. New case asserting `getGlobalDispatcher().close()` is called before `process.exit`. |
| `.changeset/fix-null-and-libuv.md` | Patch changeset listing both fixes. |

### 8.2 Dependencies

No new dependencies. `undici` is already a direct dep at `^7.24.0`.

### 8.3 Test strategy

- Unit (schema): one `it` per relaxed field accepting `null`, plus one
  combined "all null" case.
- Unit (handle): one `vi.mock('undici', ...)` setup; one new case asserting
  call order. Existing tests updated to async/await pattern.
- Integration (api): one new MSW-driven case that exercises the full parse
  path of `getOwnedProjects` with the new fixture.

### 8.4 Commits

Two commits:

1. `fix(api): tolerate null in optional response fields`
   - `src/api/schemas/project.ts`
   - `.claude/docs/conventions.md` (the new policy line)
   - `test/api/schemas/project.test.ts`
   - `test/api/projects.test.ts`
   - `test/fixtures/projects/owned-with-null-client.json`
   - `.changeset/fix-null-and-libuv.md` (added here, both fixes)

2. `fix(errors): drain undici dispatcher before exit`
   - `src/errors/handle.ts`
   - `src/bin/freelo.ts`
   - `test/errors/handle.test.ts`

### 8.5 Verification gate

After each commit, before `git push`:

```
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme
```

All five must pass on the committed tree.

### 8.6 Rollout

Single-PR rollout. Auto-merge enabled because:

- Real-world breakage on a supported platform.
- Patch-tier with backwards-compatible schema relaxation only.
- Tests cover both fixes.
