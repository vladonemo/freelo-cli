# Spec 0024 — `freelo tasks delete <id>` (R13)

**Status:** Draft → Implement
**Run:** 2026-04-27-1947-tasks-delete
**Tier:** Yellow
**Roadmap:** R13 (`docs/roadmap.md` :291-301)
**Depends on:** R09 (write infra), R11 (idempotency helper, `src/lib/idempotency.ts`)

---

## 1. Problem

The CLI has no way to delete a task. Agents that drive Freelo (cleanup scripts, archive flows, test-data teardown) currently must call the REST API directly, bypassing the CLI's structured error envelopes, dry-run support, and batch ergonomics. R13 closes the gap and — equally important — establishes the **first destructive-op confirmation flow** that every later destructive command (`tasks archive`, `subtasks delete`, `comments delete`, `files delete`, `projects delete`, `tasklists delete`, …) will reuse byte-for-byte.

## 2. API surface

### 2.1 Wire endpoint

`DELETE /task/{task_id}` — soft-delete a task. OpenAPI :1697-1714.

- Empty request body.
- Response 200: `SuccessResponse` (`{ result: 'success' }` or 204; both treated as success — the CLI does not surface the body).
- Response 404 after a prior delete: the CLI treats this as **idempotent already-deleted** (decision 3).
- Response 401/403/429/5xx: standard error mapping per `src/api/client.ts`.

### 2.2 Why DELETE method (not POST)

Freelo's contract uses `DELETE` for task deletion (OpenAPI :1697). The CLI's `HttpClient` already accepts `'DELETE'` in `RequestOptions['method']` (client.ts:36). No client changes required.

## 3. CLI surface

### 3.1 Subcommand shape

```
freelo tasks delete <id>...   [--yes] [--dry-run]
freelo tasks delete --ids "1,2,3"   [--yes] [--dry-run]
freelo tasks delete --stdin   [--yes] [--dry-run]
```

- `<id>...`: variadic positional (one or more positive integers).
- `--ids <list>`: comma- or space-separated list, mutex with positional and `--stdin` (mirrors R11 `tasks finish/reopen`).
- `--stdin`: NDJSON input, one `{"id": <int>}` per line, mutex with positional and `--ids`.
- `--yes`: bypass the confirmation prompt. Required in non-TTY mode.
- `--dry-run`: skip the DELETE wire call. Envelope still emitted with `dry_run: true` and a `would` block. Confirmation is **not** required for `--dry-run` (decision 8).

The flag set is intentionally identical to `tasks finish`/`tasks reopen` (R11). No new shape.

### 3.2 Output schema

`freelo.tasks.delete/v1`. Envelope `data` shape:

```jsonc
{
  "task_id": 9012,
  "previous_state": "active",         // observed state before delete (when known)
  "current_state": "deleted",         // target state
  "already_in_target_state": false,   // true ⇔ DELETE was skipped (404 or stdin retry)
  "would": {                          // only in --dry-run AND when DELETE would have run
    "method": "DELETE",
    "path": "/task/9012",
    "body": {}
  },
  "line_index": 0                     // only in --stdin batch mode
}
```

- `previous_state`: present when known. **Unlike `tasks move`/`tasks finish`, R13 does NOT pre-fetch via GET** (decision 5 — we do not pay 2 round-trips per delete; the DELETE response is authoritative). When the wire call is the only HTTP call, `previous_state` is emitted as `null` (we don't claim to know).
- `current_state`: literal `'deleted'` (success path) or whatever the previous state was (idempotent skip when input is given but already-deleted).
- `already_in_target_state`: `true` only when DELETE returned 404 (the task was already deleted).
- `line_index`: 0-indexed across non-empty NDJSON lines. Absent in single/positional/`--ids` envelopes (R11 v1 byte-compat convention).

### 3.3 Confirmation flow (the cross-cutting bit)

This is **the** reason R13 is Yellow. Every later destructive command pulls in the same logic:

| Mode | `--yes`? | Behaviour |
|---|---|---|
| TTY, no `--yes` | no | Prompt via `await import('@inquirer/prompts')` `confirm({ message: 'Delete task #9012?', default: false })`. User answers `n` → `ConfirmationError` (exit 2, code `CONFIRMATION_REQUIRED`). |
| TTY, `--yes` | yes | Bypass; proceed to wire call. |
| Non-TTY, no `--yes` | no | **Throw `ConfirmationError`** immediately. `code: CONFIRMATION_REQUIRED`, `exitCode: 2`. **Never** prompt (would hang waiting on stdin). |
| Non-TTY, `--yes` | yes | Bypass; proceed. |
| `--dry-run` (any mode) | n/a | Skip confirmation entirely. No wire call → no destructive effect (decision 8). |

`src/lib/confirm.ts` exposes:

```ts
export type ConfirmOptions = {
  /** What's being confirmed — used in both TTY prompt and the error message. */
  promptMessage: string;
  /** When `--yes` was passed by the user. */
  yes: boolean;
  /** When `--dry-run` was passed (skip confirmation entirely). */
  dryRun: boolean;
  /**
   * Optional override for TTY detection. Defaults to `isInteractive()`.
   * Tests use this to drive both branches without mucking with global TTY state.
   */
  isInteractive?: () => boolean;
};

/**
 * Returns void on confirmation (proceed). Throws `ConfirmationError`
 * (exit 2) when:
 *   - non-TTY and `yes === false` (no chance to prompt → fail closed);
 *   - TTY user answered no.
 *
 * Never returns false — the contract is "either proceed, or throw".
 */
export async function confirmDestructive(opts: ConfirmOptions): Promise<void>;
```

The function is `async` because the TTY prompt is async. The non-TTY path resolves synchronously (no pending I/O) but must still match the async signature so callers `await` uniformly.

### 3.4 Per-id flow

For each id (whether single, batch, or stdin):

1. **Confirm** (or skip on `--dry-run`). On `ConfirmationError`: in single mode, propagate; in batch mode, emit per-line error + record exit 2, continue. (Decision 9 — confirmation is per-run, NOT per-id; see §3.5.)
2. **Dry-run branch**: emit `dry_run: true` envelope with `would: { method: 'DELETE', path: '/task/{id}', body: {} }`, `previous_state: null`, `current_state: 'deleted'`, `already_in_target_state: false`. Skip the wire call.
3. **Live DELETE**: `client.request({ method: 'DELETE', path: '/task/{id}', body: undefined, schema: SuccessResponseSchema })`.
4. **404 handling**: catch `FreeloApiError` with `code: 'NOT_FOUND'` and re-emit as success envelope: `previous_state: null, current_state: 'deleted', already_in_target_state: true`. (Decision 3.)
5. **Other errors**: bubble up via the standard top-level handler in single mode, or the per-line writer in batch mode.

### 3.5 Confirmation in batch mode

**Decision 9: confirmation is per-run, not per-id.**

In batch mode (positional `<id>...`, `--ids`, or `--stdin`), the prompt fires **once** before the first wire call:

```
About to delete N task(s). Continue? (y/N)
```

- N is known up-front for positional and `--ids` (parsed into an array); for `--stdin`, N is computed by buffering all lines first (matches the existing R12.5 stdin pattern — `tasks-move.ts:240`).
- TTY user answers no → `ConfirmationError` thrown, no per-id loop runs at all, exit 2.
- Non-TTY without `--yes` → `ConfirmationError` thrown before any wire call; exit 2.
- `--yes` → no prompt; proceed.
- `--dry-run` → no prompt; proceed (no destructive effect).

This matches user expectations (one prompt per invocation) and prevents prompt fatigue.

### 3.6 Human renderer

```
Deleted task #9012.                                       (live success)
Task #9012 was already deleted.                            (idempotent — 404)
(dry-run) Would delete task #9012.                         (dry-run)
```

### 3.7 Single-id vs. multi-id error semantics

Mirrors R11 (`transition.ts:315`):

- **Single id (one positional, no `--ids`/`--stdin`)**: errors bubble to the top-level handler → one envelope on stderr. No per-line stream.
- **Multi id (multiple positional, `--ids`, or `--stdin`)**: per-id errors go to stdout (the success stream); highest exit code wins at end-of-loop.

## 4. Data model

### 4.1 Wire — DELETE response

Reuse `SuccessResponseSchema` (z.object({ result: z.string().nullable().optional() }).passthrough()). Used by every other write wrapper. No new schema in `src/api/schemas/`.

### 4.2 Envelope `data` schema

`TasksDeleteDataSchema` in `src/api/schemas/task.ts`:

```ts
export const TaskDeleteStateSchema = z
  .enum(['active', 'archived', 'finished', 'deleted', 'template'])
  .nullable();

export const TasksDeleteDataSchema = z.object({
  task_id: z.number().int(),
  previous_state: TaskDeleteStateSchema,        // null when not pre-fetched
  current_state: z.enum(['active', 'archived', 'finished', 'deleted', 'template']),
  already_in_target_state: z.boolean(),
  would: z.object({
    method: z.literal('DELETE'),
    path: z.string(),
    body: z.unknown(),
  }).optional(),
  line_index: z.number().int().nonnegative().optional(),
});

export type TasksDeleteData = z.infer<typeof TasksDeleteDataSchema>;
```

### 4.3 Wire wrapper

`src/api/tasks-delete.ts` — `deleteTask(client, taskId, opts)` returns `{ raw }`. Calls `client.request({ method: 'DELETE', path: deletePath(taskId), schema: SuccessResponseSchema })`. Exposes `deletePath(taskId)` for `--dry-run`.

## 5. Edge cases

| Case | Behaviour |
|---|---|
| Empty stdin | Silent success exit 0 (matches R09/R11/R12.5 precedent). No prompt — N=0 short-circuits the confirm step. |
| All-bad NDJSON lines | Per-line error envelopes, exit 2. No client built (lazy). No confirm prompt — confirmation runs **after** parsing all lines, so a 0-valid stdin never prompts. (Decision 7.) |
| Non-TTY, no `--yes`, with `--dry-run` | Proceeds (no destructive effect). |
| Non-TTY, no `--yes`, no `--dry-run` | `ConfirmationError` (exit 2) before any wire call. |
| `<id>` invalid (non-numeric / zero / negative) | `ValidationError` (exit 2) at parse time. |
| Repeated id in input (e.g. `--ids "9012,9012"`) | Both rows attempt DELETE. The second is most likely to 404 → idempotent skip. No de-duplication in v1 (decision 11). |
| `<id>` of a finished/archived task | Endpoint accepts; soft-deletes anyway. No special CLI handling. |
| Network failure mid-batch | Per-line `NETWORK_ERROR` envelope, continue to next line. Exit 5 if no later error elevates above. |
| Confirmation prompt aborted via Ctrl-C | inquirer throws `ExitPromptError`; bubbles up as a generic Error → SIGINT-shaped path → exit 130. (Already supported by `handleTopLevelError`.) |

## 6. Non-goals

- No "trash" listing / restore. Freelo's UI handles restore; out of scope.
- No `--cascade` for child subtasks. The wire endpoint already cascades (see OpenAPI :1697); mention in help, do not add a flag.
- No `--ids-from-query` (e.g. delete every task matching a filter). Compose `freelo tasks list --output json | jq | freelo tasks delete --stdin` instead.
- No batch confirmation per-id ("Delete task #X? (y/N)" looped). One prompt per run; that's it.

## 7. Open questions

None. The CLAUDE.md and roadmap text explicitly resolve the confirm policy and idempotency expectations. Decisions captured below in §9.

## 8. Mandatory tests

Per Calibration §1-4. **Every error path that the spec assigns an exit code MUST have a test asserting that exit code.**

### 8.1 Confirm helper unit tests (`src/lib/confirm.ts`)

1. `--yes`: returns void, no prompt, no throw (TTY and non-TTY, two rows).
2. `--dry-run`: returns void, no prompt, no throw.
3. Non-TTY, no `--yes`, no `--dry-run`: throws `ConfirmationError` with `code: 'CONFIRMATION_REQUIRED'`, `exitCode: 2`.
4. TTY, no `--yes`, no `--dry-run`, user accepts: returns void.
5. TTY, no `--yes`, no `--dry-run`, user declines: throws `ConfirmationError` with the same code and exit code.
6. Lazy import discipline: confirm.ts contains no top-level static `import` of `@inquirer/prompts` (grep assertion).

### 8.2 Command-level (mirrors `move.test.ts` shape)

Happy paths:

7. Single id, `--yes`, JSON envelope: `schema: 'freelo.tasks.delete/v1'`, `data.current_state: 'deleted'`, `data.already_in_target_state: false`, exit 0.
8. Single id, `--yes`, human mode: stdout contains `Deleted task #9012.`, exit 0.
9. `--dry-run` (no `--yes`, non-TTY): `dry_run: true`, `data.would.method: 'DELETE'`, `data.would.path: '/task/9012'`, no DELETE handler hit (would surface via `onUnhandledRequest: 'error'`). Exit 0.
10. Multi id positional + `--yes`: NDJSON output, two success envelopes, both have `current_state: 'deleted'`, no `line_index`. Exit 0.
11. `--ids "9012,9013"` + `--yes`: equivalent shape.
12. `--stdin` + `--yes`: NDJSON input/output, each row carries `line_index`, exit 0.
13. `--stdin` empty: silent success, no prompt, exit 0.

Idempotency:

14. Single id, DELETE returns 404 → `already_in_target_state: true`, `current_state: 'deleted'`, exit 0. Calibration §2 (FreeloApiError NOT_FOUND mapped to success envelope).
15. Batch with one row 404: success envelope on that row with `already_in_target_state: true`, exit 0 overall.

Confirmation:

16. **Non-TTY without `--yes`**: `CONFIRMATION_REQUIRED`, exit 2 — single id. Stderr carries the error envelope. No DELETE handler hit.
17. **Non-TTY without `--yes`** + `--ids`: confirmation fires once for the whole batch, throws, no per-id loop runs.
18. **Non-TTY without `--yes`** + `--dry-run`: no confirmation needed, dry envelope emitted, exit 0.

Validation:

19. Non-numeric `<id>` → `VALIDATION_ERROR`, exit 2.
20. Zero `<id>` → `VALIDATION_ERROR`, exit 2.
21. `--ids ""` (empty after split) → `VALIDATION_ERROR`, exit 2.
22. Mutex: positional `<id>` + `--stdin` → `VALIDATION_ERROR`, exit 2.
23. Mutex: positional `<id>` + `--ids` → `VALIDATION_ERROR`, exit 2.
24. Mutex: `--ids` + `--stdin` → `VALIDATION_ERROR`, exit 2.
25. No source at all (no positional, no `--ids`, no `--stdin`) → `VALIDATION_ERROR`, exit 2.
26. NDJSON line missing `id` → per-line `VALIDATION_ERROR`, exit 2.
27. NDJSON line with extra key → per-line `VALIDATION_ERROR` (zod `.strict`).
28. NDJSON line with non-positive `id` → per-line `VALIDATION_ERROR`.

HTTP errors (calibration §2 — every typed error class must trigger):

29. DELETE 401 → `AUTH_EXPIRED`, exit 3.
30. DELETE 403 → `FORBIDDEN`, exit 4.
31. DELETE 5xx → `SERVER_ERROR`, exit 4.
32. DELETE 429 (no retry on writes — see client.ts:147) → `RATE_LIMITED`, exit 6.
33. DELETE network failure → `NETWORK_ERROR`, exit 5.

Batch continue-on-error:

34. valid + bad-JSON + valid: 2 success + 1 error envelope, exit 2 (NDJSON via `--stdin`).
35. valid + 401 mid-batch: per-line errors carry `http_status: 401`, exit 3 (auth dominates).
36. mixed exit codes: max wins (e.g. validation 2 + 5xx 4 → exit 4).

Single-mode regression:

37. Single-mode envelope has no `line_index` field (R11/R12 byte-compat convention).

Introspect:

38. `freelo --introspect` shows `tasks delete` with `output_schema: 'freelo.tasks.delete/v1'` and `destructive: true`.

## 9. Decisions (autonomous)

1. **Subcommand path**: `tasks delete` (mirrors finish/reopen/move). Decided.
2. **Schema name**: `freelo.tasks.delete/v1`. Decided per roadmap.
3. **404-after-DELETE = idempotent**: a DELETE that returns 404 means the task was already gone. Treat as success with `already_in_target_state: true`. **Cannot rely on a pre-check GET** because (a) the task may be deleted between the GET and the DELETE, and (b) we'd pay 2 round-trips per delete. The DELETE response is the authoritative truth.
4. **No pre-check GET**: do **not** mirror `tasks move`'s pre-check GET pattern. Two reasons: (a) GET would double the API load on a destructive op; (b) a `previous_state` field is informational at best — the user is deleting on faith of the id. Trade-off: `previous_state` is `null` in success envelopes. Acceptable; documented in §3.2.
5. **`previous_state: null`**: a deliberate "we did not pre-fetch" signal. Tests assert this explicitly.
6. **Empty body on DELETE**: send `body: undefined` (no Content-Type header — see client.ts:114). The OpenAPI spec does not document a DELETE body.
7. **Confirmation runs after stdin parse**: in `--stdin` mode, we buffer all lines first (mirrors `tasks-move.ts:240`), THEN show the confirmation count. Empty stdin → 0 valid lines → no prompt → silent success. Spec §5.
8. **Confirmation skipped for `--dry-run`**: explicit. `--dry-run` has no destructive effect, so requiring confirmation would be friction with no security benefit.
9. **Confirmation is per-run, not per-id**: one prompt per invocation, regardless of N. Matches user expectations and prevents prompt fatigue.
10. **Lazy `@inquirer/prompts` import**: matches existing pattern (`src/commands/auth/login.ts:74`). Cold path never imports it.
11. **No de-duplication of input ids**: repeats are fine; the second DELETE will 404 → idempotent skip. Documented in §5.
12. **`isInteractive()` injection point**: `confirm.ts` accepts an optional `isInteractive: () => boolean` injection. Default is the real one from `src/lib/env.ts`. Tests use the override to drive both branches deterministically without globally mucking with `process.stdout.isTTY`.
13. **`destructive: true`** in introspect meta. First command to set this. Asserted in test #38.
14. **NDJSON `--stdin` schema**: `z.object({ id: ... }).strict()` (matches R11's `BatchLineSchema`). No additional fields permitted.
15. **`previous_state` in dry-run**: `null` (we did not GET). Consistent with §5 / §4.
16. **Top-level `dry_run: true`**: emitted via `dryRunEnvelope(...)` from `src/lib/dry-run.ts` (already exists, R09).
17. **Reuse `tasksShowHandlers` for nothing**: this command has NO pre-check GET. We register only `tasksDeleteHandlers` MSW factories.

## 10. Plan

### 10.1 Files to create

- `src/lib/confirm.ts` (~70 lines) — `confirmDestructive({ promptMessage, yes, dryRun, isInteractive? })`. Lazy-imports `@inquirer/prompts` only on TTY-prompt path. Throws `ConfirmationError` (exit 2) on non-TTY-no-yes or user-declines. Pure of any HTTP/config dependencies.
- `src/api/tasks-delete.ts` (~50 lines) — `deleteTask(client, taskId, opts)` returning `{ raw }`. `deletePath(taskId)` exposed for `--dry-run`. Reuses the `SuccessResponseSchema` pattern from `tasks-transition.ts` / `tasks-move.ts`.
- `src/commands/tasks/delete.ts` (~250 lines) — Commander registration + per-id flow + batch-from-positional/--ids + batch-from-stdin. Mirrors `tasks/move.ts` shape (single-id and `--stdin` paths) and `tasks/transition.ts` (positional `<id>...` collector + `--ids` parser + mutex validation). One `confirmDestructive` call per invocation, fired once after id resolution.
- `src/ui/human/tasks-delete.ts` (~30 lines) — `renderTasksDeleteHuman(data)` returns the live/dry-run/idempotent line per §3.6.
- `test/commands/tasks/delete.test.ts` (~900 lines, mirrors `move.test.ts` shape) — 32 of the 38 mandatory tests (the 6 confirm-helper unit tests live in their own file).
- `test/lib/confirm.test.ts` (~150 lines) — the 6 confirm-helper unit tests.
- `test/fixtures/tasks/delete-9012-success.json` — minimal `{result: 'success'}` (used in human-mode test #8 if needed; most tests can use the inline `HttpResponse.json` body).
- `.changeset/r13-tasks-delete.md` — `freelo-cli: minor` entry, prose follows R12.5's pattern.
- `docs/commands/tasks-delete.md` — user-facing doc, mirrors `docs/commands/tasks-move.md`.

### 10.2 Files to modify

- `src/api/schemas/task.ts` — append the R13 section: `TasksDeleteDataSchema`, `TasksDeleteData` type. Additive only (no existing schema touched).
- `src/commands/tasks.ts` — `import { registerDelete } from './tasks/delete.js'` and add `registerDelete(tasks, getConfig, env);` to the `register(...)` body.
- `test/msw/handlers.ts` — append `tasksDeleteHandlers` factory bag (`deleteOk`, `deleteNotFound`, `deleteUnauthorized`, `deleteForbidden`, `deleteServerError`, `deleteRateLimited`, `deleteNetworkError`). Pattern: `http.delete(...)` against `${API_BASE}/task/${taskId}`. Mirrors `tasksMoveHandlers` shape.
- `README.md` — auto-regenerated by `pnpm fix:readme` (autogen Commands block).

### 10.3 No new dependencies

`@inquirer/prompts` is already in `package.json` (used by `auth login`). Nothing else needed.

### 10.4 Test strategy

- **Unit (no I/O):** `confirm.ts` (6 cases). MSW server **not** started for these tests.
- **Integration (MSW):** all command-level tests (~32). Pattern: `runCli(run, [...])` with `captureOutput()` capturing stdout/stderr/exit. Spy `process.exit` to throw `EXIT:N` so `exitCode` is observable. TTY state mocked via `Object.defineProperty(process.stdout, 'isTTY', ...)` per existing test pattern.
- **Confirmation prompt:** simulate via mocking `@inquirer/prompts` module dynamically inside the test (vi.doMock before `vi.resetModules()`) — but only in confirm.ts unit tests. The command-level tests drive the confirmation paths via `--yes` / non-TTY-throw / `--dry-run`-skip; we do NOT need to mock the live prompt at the command-level (test #16/17 covers non-TTY-throw, the only TTY path that matters is "user declines" which is exercised by the unit test).

### 10.5 Rollout order (one PR, two commits)

1. **Commit 1 — `feat(commands): r13 — \`freelo tasks delete\` + shared confirm helper`**: adds `confirm.ts`, `tasks-delete.ts` (api), `delete.ts` (command), human renderer, schema, MSW handlers, all tests, register in tasks tree, changeset entry. CI must be green.
2. **Commit 2 — `docs: tasks delete page + autogen README`**: adds `docs/commands/tasks-delete.md`, runs `pnpm fix:readme`, commits the regenerated `README.md`. Must keep `pnpm check:readme` green.

(Can be squash-merged as one Conventional Commit on PR merge — interim commits give us a clean revert surface.)

### 10.6 Risks / mitigations

- **R: lazy `@inquirer/prompts` import lands in agent cold path.** Mitigated by hard test #6 (grep assertion for static-import).
- **R: stdin batch confirmation timing — buffering all lines BEFORE prompt is the right order, but a typo could prompt on N=0 stdin.** Mitigated by test #13 (empty stdin → no prompt assertion via MSW unhandled-request).
- **R: `previous_state: null` may surprise consumers expecting `move`/`finish` shape.** Mitigated by spec §3.2 narrative + zod `.nullable()` typing + dedicated test asserting `null`.
- **R: confirmation prompt uses `default: false`.** This means hitting Enter aborts — the safest default for a destructive op. Documented; the prompt copy says `(y/N)` so the default is visually clear.
- **R: branch coverage on `confirm.ts` (Calibration §4).** 4 paths: (yes), (dryRun), (TTY+accept), (TTY+decline), (non-TTY+throw). All 5 covered in the 6-test unit file.

