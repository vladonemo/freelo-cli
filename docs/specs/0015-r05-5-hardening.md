# Spec 0015 — R05.5 Hardening: schema null/number tolerance + Windows libuv exit (round 2)

**Status:** Draft → ready for plan
**Tier:** Yellow
**Run:** `2026-04-26-1848-r05-5-hardening`
**Branch:** `fix/r05-5-hardening`

Three real-world bugs reproduced on `freelo-cli@0.7.0` and `0.8.0` against
a live Freelo account on 2026-04-26. All three land in the same patch
release `0.8.1`. Mirrors the shape of spec 0010 (the 0.5.1 patch); same
class of "schema is stricter than the wire" + "exit path is unsafe on
Windows".

---

## 1. Bug #1 — `UserBasic.fullname` declared `z.string()` but the API can omit it

### 1.1 Root cause

`src/api/schemas/project.ts:17-20` declares `UserBasicSchema` with
`fullname: z.string()` (required, non-nullable). The live Freelo API
sometimes returns user objects without `fullname` (deleted users,
externally-invited users in pending state, system actors). The schema
rejects on these payloads.

The same risk lives on every other "complex field declared with
`.optional()`" — Freelo treats `null` and absent interchangeably across
the wire shape, exactly the class spec 0010 already documented. We have
spot-fixed it; we now sweep for stragglers.

### 1.2 Fix

Two-part:

1. **`UserBasicSchema.fullname` becomes `.nullable().optional()`.** Wherever
   we render the human label, fall back to `String(id)` when fullname is
   missing — but the renderers already do that today (they read
   `worker?.fullname ?? worker?.id`). Worth a quick grep to confirm.

2. **Sweep all `src/api/schemas/*.ts` for required-or-strict fields that
   are not explicitly required by the OpenAPI spec.** Concretely:
   - `UserBasicSchema.fullname` → `.nullable().optional()`
   - `WorkerWithHourRateSchema.fullname` → `.nullable().optional()`
   - `HourRateSchema.amount` / `.currency` / `.is_fixed` → all
     `.nullable().optional()` (the live API has been observed to drop
     individual fields on partial-rate records).
   - `TasklistBasicSchema` and `ProjectRefSchema` — already required `id`
     and `name`; leave alone unless we have evidence otherwise.
   - `StateSchema.id` and `.state` — required per OpenAPI; leave alone.

Rationale: spec 0010 §1.3 already established the convention "every
optional field on an inbound API response schema is also nullable."
This run extends the same defensive policy one level deeper: also
relax fields that we *thought* were universally present but a real
report shows otherwise. We are not loosening `id` (the row primary key
is genuinely required); we are loosening any field that the wire shape
admits as missing or null.

### 1.3 Test plan

- New unit cases in `test/api/schemas/project.test.ts` asserting
  `UserBasicSchema.parse({ id: 99 })` succeeds (no fullname) and
  `UserBasicSchema.parse({ id: 99, fullname: null })` succeeds.
- One new fixture-style case in `test/api/projects.test.ts` (or
  `test/api/schemas/project.test.ts`) using a `ProjectFull` payload with
  `owner: { id: 9 }` (no fullname) — the parse must succeed and the
  envelope must carry `owner.fullname: undefined`.

---

## 2. Bug #2 — `CurrencySchema.amount` rejects numeric amounts from the live API

### 2.1 Root cause

`src/api/schemas/project.ts:43-46` and `src/api/schemas/tasklist.ts:22-25`
both declare:

```ts
const CurrencySchema = z.object({
  amount: z.string(),
  currency: z.enum(['CZK', 'EUR', 'USD']),
});
```

Three reproducers on 2026-04-26 against a live account confirm Freelo
returns `amount: <number>` (e.g. `2000`, `15000.5`) for `real_cost`,
`budget` on `ProjectFull`, and `budget` / `real_cost` on `TasklistFull`.
Every consumer of `CurrencySchema` is affected. The live wire shape
varies by endpoint — possibly even by record — so a one-off fix at
each consumer would miss future ones.

### 2.2 Fix — schema-level, normalize to string

```ts
const CurrencySchema = z.object({
  amount: z
    .union([z.string(), z.number()])
    .refine((v) => typeof v === 'string' || (Number.isFinite(v) && !Number.isNaN(v)), {
      message: 'amount must be a finite number or string',
    })
    .transform((v) => String(v)),
  currency: z.enum(['CZK', 'EUR', 'USD']),
});
```

The transform produces a stable string output for both wire shapes.

**Design decision — canonical envelope shape:** **(b) normalize to string.**

Three options were considered:
- **(a) preserve as-is** — agents see what Freelo sent (string|number per
  record). Rejected: forces every downstream agent to handle both shapes;
  contradicts our envelope schema-stability promise; the human renderer
  in `src/ui/human/projects-list.ts:79` already concatenates with
  `${b.amount} ${b.currency}` and would format slightly differently per
  record (no spacing differences but type-checking would diverge).
- **(b) normalize to string** — chosen. Backwards-compatible: every
  envelope already in the wild carries `amount: string`. Agents that
  parsed `Currency.amount` as a string still get a string. Matches
  what OpenAPI documents (`type: string`) and matches the existing
  R03/R04/R05 envelope contracts.
- **(c) normalize to number** — rejected. Smallest payloads, but a
  breaking change to anyone who pinned the shape, and JS `number`
  loses precision past 2^53 (irrelevant for cents-as-int but a
  poor general policy for a money type).

### 2.3 Edge cases

- `String(NaN)` → `"NaN"` and `String(Infinity)` → `"Infinity"` — neither
  is a real amount. The `.refine()` rejects `NaN`/`Infinity` before the
  transform. `null`/`undefined` for `amount` itself is rejected today
  and we keep that behavior (the *containing* `CurrencySchema` is what
  gets `.nullable().optional()` on each consumer; a present amount
  must be a finite value).
- `String(123.45)` → `"123.45"` — fine.
- Freelo's amounts are always cents-as-int or X.XX; precision concerns
  past 15 significant digits are theoretical. We document this in the
  spec but do not add bigint plumbing.
- The `currency` enum is unchanged. If Freelo ever returns a code we
  don't list, the parser fails — we'd want to know. (This is not new
  behavior introduced here; it's the existing posture.)

### 2.4 Test plan

- New unit cases in `test/api/schemas/project.test.ts` and
  `test/api/schemas/tasklist.test.ts` (latter to be added if missing)
  asserting `CurrencySchema.parse({ amount: 2000, currency: 'CZK' })`
  yields `{ amount: '2000', currency: 'CZK' }` and the same with
  `15000.5` yields `'15000.5'`.
- Reject-case for `NaN` and `Infinity`.
- New MSW-driven case (or fixture update) in `test/api/projects.test.ts`
  exercising `getAllProjects` with `real_cost.amount` as a number —
  parse must succeed, envelope must carry `amount: '2000'`.

### 2.5 Schema-stability statement

`freelo.projects.list/v1`, `freelo.projects.show/v1`,
`freelo.tasklists.list/v1` all keep `Currency.amount: string` on the
output. **Inbound parser is widened**, output envelope is unchanged.
No `/v(n+1)` bump.

---

## 3. Bug #3 — Windows libuv `UV_HANDLE_CLOSING` (round 2 — the 0.5.1 fix is incomplete)

### 3.1 Root cause

Spec 0010 fixed the original report by adding `await drainDispatcher()`
before `process.exit()` in `src/errors/handle.ts:75-118`. That helper
calls `getGlobalDispatcher().close()` — a **graceful** shutdown that
waits for in-flight requests.

Live testing on 2026-04-26 against `freelo-cli@0.7.0` and `0.8.0` shows
the assertion still fires on **any** zod-validation failure on Windows,
in:
- `freelo projects show 235826` (zod fails on `real_cost.amount` number)
- `freelo projects list --scope all` (zod fails on multiple records)
- `freelo tasklists list` (zod fails on `Tasklist.budget.amount`)

Hypothesis on why `.close()` is insufficient on Windows:
- `.close()` waits for active sockets to finish their *current* exchange
  before closing. The pool may still hold a socket where the response
  body is being **drained but the socket-close handle has not yet been
  signalled to libuv**. On POSIX, the handle close is synchronous-enough
  that `process.exit` after the `await` is safe. On Windows, the
  `UV_HANDLE_CLOSING` flag is set when `uv_close()` was called on the
  handle but the close callback hasn't fired yet — synchronous
  `process.exit` from inside the same tick observes the half-closed
  handle and asserts.

### 3.2 Fix — three layered defenses

We apply all three because each addresses a distinct half of the race;
together they make the exit path safe on Windows without changing
behavior on macOS/Linux.

**(a) Use `destroy()`, not `close()`, on error paths.** `close()` is
graceful; we don't need graceful — by the time `handleTopLevelError`
runs, the error envelope is already on stderr and we have nothing
in-flight worth saving. `destroy()` aborts pending requests
(harmless: there are none to abort) and tears down sockets immediately.

**(b) Bound the drain with a timeout.** A pathological undici state
must not hang the CLI on exit. Race the destroy with a 250 ms timeout;
on timeout we exit anyway (the original libuv crash is no worse than
a stalled exit).

**(c) Defer `process.exit` via `setImmediate`.** After `await
destroyDispatcher()` resolves, schedule `process.exit` on the next
turn of the event loop. This gives libuv one full event-loop tick to
process pending close callbacks (`UV_HANDLE_CLOSING` → handle freed)
before the synchronous `exit` jumps off the cliff.

```ts
// src/errors/handle.ts — sketch of the new shape
import { getGlobalDispatcher } from 'undici';

const DRAIN_TIMEOUT_MS = 250;

export async function drainDispatcher(): Promise<void> {
  try {
    const dispatcher = getGlobalDispatcher();
    // Forceful destroy — error-path cleanup, not a graceful close.
    const destroyPromise = dispatcher.destroy();
    const timeoutPromise = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, DRAIN_TIMEOUT_MS);
      // Do not keep the loop alive solely for this timer.
      t.unref?.();
    });
    await Promise.race([destroyPromise, timeoutPromise]);
  } catch {
    // best-effort cleanup; never mask the original exit code
  }
}

function exitDeferred(code: number): never {
  // Defer to next event-loop tick so libuv can finalize close callbacks
  // before the synchronous process.exit. Critical on Windows.
  setImmediate(() => process.exit(code));
  // Block until exit fires. Returning from this function would let the
  // caller resume; we don't want that. Use a never-resolving promise.
  return new Promise<never>(() => {}) as never;
}

export async function handleTopLevelError(err: unknown, mode: OutputMode): Promise<never> {
  // ... classify + emit envelope ...
  await drainDispatcher();
  return exitDeferred(typed.exitCode);
}
```

The signature stays `Promise<never>`. Existing callers (`bin/freelo.ts:127,
183, 245`) need no change.

**SIGINT handler (`bin/freelo.ts:235`)** keeps its fire-and-forget
pattern but uses the same `setImmediate` defer:

```ts
process.on('SIGINT', () => {
  abortController.abort();
  void drainDispatcher().finally(() => {
    setImmediate(() => process.exit(130));
  });
});
```

### 3.3 Why not other approaches

- **`Promise.race(destroy, timeout)` alone** — fails to address the
  `UV_HANDLE_CLOSING` race directly; we still synchronously exit
  inside the same tick.
- **`setImmediate(exit)` alone, no destroy** — only marginally better
  than today; `close()` is already attempted but the issue isn't
  graceful-vs-forceful, it's the synchronous-exit-after-await timing.
- **Switching to a per-request agent (`new Agent()` per `httpRequest`)** —
  architectural; would require teardown after every command. Saves
  the "global pool still has live sockets" problem but at the cost of
  losing keep-alive across pages and subcommands. Out of scope for a
  patch release. (Marked as a possible follow-up.)
- **Removing `pino-pretty` from the error path** — pino is silent by
  default; the error path goes via `process.stderr.write` directly
  in `src/errors/handle.ts:113`. pino is not in this hot path. Not
  the bug.

### 3.4 Test plan — the calibration-log §1 trap

The 0.5.1 test asserted `getGlobalDispatcher().close()` was called
before `process.exit`. The bug shipped because that's a proxy, not the
real condition. **The new test asserts the real condition:** the
spawned CLI exits cleanly on a forced zod-validation failure, with
**zero `UV_HANDLE_CLOSING` or `Assertion failed:` strings on stderr**,
on the Windows matrix row.

Two new tests:

1. **Unit — `drainDispatcher` calls `.destroy()` (not `.close()`) and
   bounds the wait.** `test/errors/handle.test.ts` already mocks
   `getGlobalDispatcher`; adapt the existing tests so the mock exposes
   `.destroy` instead of `.close`. Add a case where `.destroy()` hangs
   and the timeout-race kicks in (uses `vi.useFakeTimers()`).

2. **Integration — Windows-matrix subprocess regression.** New file
   `test/integration/windows-libuv-exit.test.ts`. Runs only on the
   Windows matrix row (`describe.runIf(process.platform === 'win32')`).
   Spawns the CLI binary as a real child process via `node:child_process`
   with `FREELO_API_KEY` set to a sentinel value, MSW-equivalent flag
   off, and points at a controlled URL where the response is malformed
   JSON to force a zod failure. Asserts:
   - Exit code 4 (FreeloApiError) — clean exit, not 134/3221225477.
   - stderr does **not** contain `UV_HANDLE_CLOSING`.
   - stderr does **not** contain `Assertion failed:`.
   - stderr **does** contain a parseable `freelo.error/v1` envelope.

   Implementation note: the test uses a tiny `node:http` stub server
   inside the test file (not MSW — MSW runs in-process; we need a real
   process boundary for the libuv assertion to be meaningful). The
   stub returns 200 with a JSON body that fails zod parsing for `whoami`
   (the simplest read command — `users-me.ts` schema requires `id` and
   we omit it). The CLI is invoked as `node dist/freelo.js auth whoami
   --output json` with `FREELO_API_BASE_URL=http://127.0.0.1:<port>`
   and `FREELO_API_KEY=test FREELO_EMAIL=t@x`.

   On non-Windows matrix rows, the test is skipped (the assertion is
   Windows-only).

---

## 4. API surface

None. No new commands, no new flags, no new endpoints called.

## 5. Data model — schema diffs

| File | Field | Before | After |
|---|---|---|---|
| `src/api/schemas/project.ts` | `UserBasicSchema.fullname` | `z.string()` | `z.string().nullable().optional()` |
| `src/api/schemas/project.ts` | `WorkerWithHourRateSchema.fullname` | `z.string()` | `z.string().nullable().optional()` |
| `src/api/schemas/project.ts` | `HourRateSchema.amount` | `z.number().int()` | `z.number().int().nullable().optional()` |
| `src/api/schemas/project.ts` | `HourRateSchema.currency` | `z.string()` | `z.string().nullable().optional()` |
| `src/api/schemas/project.ts` | `HourRateSchema.is_fixed` | `z.boolean()` | `z.boolean().nullable().optional()` |
| `src/api/schemas/project.ts` | `CurrencySchema.amount` | `z.string()` | `z.union([z.string(), z.number()]).refine(...).transform(String)` |
| `src/api/schemas/tasklist.ts` | `CurrencySchema.amount` | (same) | (same) |

## 6. Edge cases (consolidated)

- `UserBasic` with `fullname: null` and `UserBasic` with `fullname` absent
  both parse → `fullname` is `null` or `undefined` accordingly. Renderers
  fall back to `id` for the human label.
- `Currency.amount` as `0` (integer zero) parses to `'0'`. As `'0.00'`
  parses to `'0.00'`. As `''` (empty string) parses to `''` — agents
  see what Freelo sent if it's a string. We do not invent shape.
- `HourRate` with all-null fields is accepted; `HourRate` is itself
  already wrapped `.nullable().optional()` on its parent.
- The libuv fix has no effect on macOS/Linux — `setImmediate` and
  `destroy()` are well-behaved on every platform; we just don't need
  them outside Windows. Universal application is simpler than a
  platform check and pays a sub-millisecond exit-time penalty at most.

## 7. Non-goals

- **Broader OpenAPI-vs-live-API audit.** This run targets the three
  observed bugs and one defensive sweep around them. A systematic
  field-by-field reconciliation against `docs/api/freelo-api.yaml`
  is a separate run. Tracked informally as a follow-up; no roadmap
  entry until a fourth schema bug appears.
- **Per-request undici agents.** Architectural change; would touch
  `src/api/client.ts` and every command. Out of scope for a patch.
- **Adopting bigint for currency amounts.** The cents-as-int-or-X.XX
  shape is fine as a string. Defer until a real-world precision
  report arrives.
- **Changing the `currency` enum.** Tracked separately; not observed
  in this round of reports.

## 8. Open questions

None blocking. The architect makes three calls autonomously, each
recorded in `docs/decisions/<run>-<n>-<slug>.md`:

1. **Currency canonical shape:** normalize to string (per §2.2 above).
2. **Libuv fix layering:** `destroy()` + 250ms timeout race +
   `setImmediate` defer (per §3.2 above). Not architectural — keeps
   the global dispatcher and existing per-command code paths intact.
3. **Bug #1 sweep depth:** relax `UserBasic.fullname`,
   `WorkerWithHourRate.fullname`, and `HourRate.{amount,currency,is_fixed}`.
   Anything deeper is the broader audit (§7 non-goal).

---

## 9. Risk

- **Schema relaxation (Bugs #1, #2):** widening only. Cannot regress
  any payload that parses today.
- **`CurrencySchema` transform:** changes the *output type* of
  `z.infer<typeof CurrencySchema>['amount']` from `string` (input
  type was string) to `string` (output type is string). No TS
  consumer change.
- **Libuv fix (`destroy` + `setImmediate`):** behavioral change is
  bounded — slight delay (≤250ms typical, 0ms when sockets idle) on
  every error exit, *no change* on success exit. The only risk is a
  hung process if `destroy()` hangs *and* `setImmediate` doesn't fire,
  which is contradictory (the timeout race resolves first). Tests
  cover both arms.
- **The Windows-only crash:** still fundamentally observable only on
  Windows. CI runs the regression test on the Windows matrix row
  (`describe.runIf`). On macOS/Linux the test is skipped, not
  asserting anything weaker — we trust the unit-level mock test
  on those platforms.

---

## 10. Plan

### 10.1 Files to touch

| File | Change |
|---|---|
| `src/api/schemas/project.ts` | Relax `UserBasicSchema.fullname`, `WorkerWithHourRateSchema.fullname`, `HourRateSchema.{amount,currency,is_fixed}`; rewrite `CurrencySchema.amount` as union+refine+transform. |
| `src/api/schemas/tasklist.ts` | Rewrite local `CurrencySchema.amount` identically. (Or import from a shared module — see 10.2.) |
| `src/errors/handle.ts` | Replace `dispatcher.close()` with `dispatcher.destroy()` + timeout race; introduce `exitDeferred(code)` helper using `setImmediate`; route every `process.exit` call site through it. |
| `src/bin/freelo.ts` | SIGINT handler: defer `process.exit(130)` via `setImmediate` after `drainDispatcher`. Bootstrap `.catch`: same defer for `process.exit(1)`. |
| `test/api/schemas/project.test.ts` | New cases for relaxed `UserBasic.fullname`, relaxed `HourRate`, and the `CurrencySchema` numeric/string accept + finite-only refine. |
| `test/api/schemas/tasklist.test.ts` | (Create if missing.) Cases for `CurrencySchema.amount` widened in the local tasklist module. |
| `test/api/projects.test.ts` | One MSW case using a `ProjectFull`-shaped fixture with `real_cost.amount` as a number — parse succeeds, envelope carries string. |
| `test/errors/handle.test.ts` | Update mocks: spy on `.destroy` (not `.close`); add cases for the timeout-race arm. Existing call-order assertions still hold. |
| `test/integration/windows-libuv-exit.test.ts` | **New.** `describe.runIf(process.platform === 'win32')` subprocess test (see §3.4). |
| `test/fixtures/projects/all-with-numeric-amounts.json` | **New.** `/all-projects` fixture with `real_cost.amount: <number>` and `budget.amount: <number>` across multiple records. |
| `.changeset/fix-r05-5-hardening.md` | **New.** Patch changeset listing all three fixes. |
| `docs/roadmap.md` | Already edited (queued R05.5 entry). Carries into commit 1. |

### 10.2 Shared `CurrencySchema`?

The spec stops short of refactoring `CurrencySchema` into a shared
module (`src/api/schemas/common.ts` or similar). Rationale: `tasklist.ts`
duplicates the schema today; pulling it out cleanly would touch import
graphs and be a small refactor. We fix the two duplicates identically,
log a decision, and defer the refactor to its own PR. Future schema
additions (R07 task budgets) are flagged in the changeset to use the
same pattern until the refactor lands.

### 10.3 Dependencies

None. `undici` is already a direct dep at `^7.24.0`. `node:child_process`
and `node:http` are stdlib.

### 10.4 Test strategy

- **Unit (schema):** at least 3 cases for `UserBasic.fullname` (absent,
  null, present), 3 for `CurrencySchema` (string, number, NaN-reject),
  1 for `HourRate` partials.
- **Unit (handle):** existing tests adapted to mock `.destroy`. New case
  for the timeout race (use `vi.useFakeTimers()`).
- **Integration (api):** one MSW case parsing a numeric-amount fixture
  cleanly through `getAllProjects`.
- **Integration (subprocess):** the Windows-matrix subprocess regression
  test in `test/integration/`. Skipped on macOS/Linux.

Coverage thresholds (from `.claude/docs/conventions.md`): existing
threshold for `src/commands/**` is 85% branches; we add no new
command-handler code. `src/errors/**` and `src/api/schemas/**` need
to stay green. The new `exitDeferred` helper is short and fully covered
by the existing handle tests once they're updated.

### 10.5 Commits (proposed)

Three commits:

1. `fix(api): tolerate null fullname and numeric currency amounts in response schemas`
   - `src/api/schemas/project.ts`
   - `src/api/schemas/tasklist.ts`
   - `test/api/schemas/project.test.ts`
   - `test/api/schemas/tasklist.test.ts` (new)
   - `test/api/projects.test.ts`
   - `test/fixtures/projects/all-with-numeric-amounts.json` (new)
   - `docs/roadmap.md` (queued R05.5 entry travels into this commit)
   - `.changeset/fix-r05-5-hardening.md`

2. `fix(errors): destroy undici dispatcher and defer exit to fix Windows libuv crash`
   - `src/errors/handle.ts`
   - `src/bin/freelo.ts`
   - `test/errors/handle.test.ts`

3. `test(integration): regression for Windows libuv UV_HANDLE_CLOSING on zod-fail exit`
   - `test/integration/windows-libuv-exit.test.ts` (new)

### 10.6 Verification gate

After each commit, before `git push`:

```
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme
```

All five pass on the **committed** tree (per calibration §3 — no
working-tree-snapshot lies).

### 10.7 Rollout

Single-PR rollout. Auto-merge enabled iff:
- Triage stays Yellow.
- All 7 CI status checks pass on the committed tree.
- Code reviewer reports no Blocking findings.
- Coverage thresholds hold.

Patch changeset → `0.8.1` on next release-please run.
