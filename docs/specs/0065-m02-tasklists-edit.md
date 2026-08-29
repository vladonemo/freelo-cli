# 0065 — M02 `freelo tasklists edit <id>`

**Run:** 2026-08-29-0921-tasklists-edit
**Tier:** Yellow
**Roadmap slice:** `docs/roadmap-migration-2026-08.md` §M02
**Endpoint:** `POST /tasklist/{tasklist_id}/edit` (`operationId: editTasklist`, `docs/api/freelo-api.yaml:1235-1305`)
**Depends on:** R06 (`tasklists show`), R34 (`tasklists create`), R10 (`tasks edit`), R13 (`src/lib/confirm.ts`)

---

## 1. Problem

`freelo tasklists` today supports `list`, `show`, `create`, and `create-from-template`. There is **no way to modify an existing tasklist**. A user who typos a tasklist name, needs to set a budget after the fact, wants to change who follows a tasklist, or wants to reorder tasklists inside a project must leave the terminal and use the web UI.

This is the first write command on `tasklists` other than `create`.

## 2. Proposal — CLI surface

```
freelo tasklists edit <id> [--name <str>]
                           [--budget <amount> | --clear-budget]
                           [--time-budget-minutes <n> | --clear-time-budget]
                           [--worker <id> | --clear-worker]
                           [--tracking-users <id> (repeatable) | --clear-tracking-users]
                           [--should-change-existing-tasks]
                           [--priority <n>]
                           [--dry-run]
```

`--yes` / `-y` is the **global** root flag (not re-registered here); it is read by walking the Commander tree, mirroring `src/commands/files/delete.ts:216-225`.

### 2.1 Flag semantics

| Flag | Wire field | Notes |
|---|---|---|
| `<id>` | path `tasklist_id` | Positive integer. `ValidationError` (exit 2) otherwise. |
| `--name <str>` | `name` | Non-empty after trim (spec `minLength: 1`). |
| `--budget <amount>` | `budget` (string) | **Minor currency units, digits only.** `"100000"` = 1000.00. Decimal strings rejected client-side with a `ValidationError` before the request, because the server rejects them with a 400 that does not explain why. |
| `--clear-budget` | `budget: null` | Mutex with `--budget`. |
| `--time-budget-minutes <n>` | `time_budget_minutes` (int) | **`>= 0`** — `0` is legal and distinct from `null` (spec `minimum: 0`). |
| `--clear-time-budget` | `time_budget_minutes: null` | Mutex with `--time-budget-minutes`. |
| `--worker <id>` | `worker_id` (int) | `>= 1` (spec `minimum: 1`). |
| `--clear-worker` | `worker_id: null` | Mutex with `--worker`. |
| `--tracking-users <id>` | `tracking_users_ids` (int[]) | **Repeatable**, not variadic (decision 7). Deduped, first-seen order preserved. |
| `--clear-tracking-users` | `tracking_users_ids: []` | Mutex with `--tracking-users`. |
| `--should-change-existing-tasks` | `should_change_existing_tasks: true` | Omitted entirely when not passed (server default `false`). **Requires a follower change** and is **confirmation-gated** (decision 5). |
| `--priority <n>` | `priority` (int) | **Positional order within the project**, `>= 1`. NOT importance (decision 2). |
| `--dry-run` | — | No HTTP at all. Envelope echoes `would`. |

### 2.2 The `priority` naming trap — required copy

`priority` here is the **third** distinct meaning of "priority" in this API surface (after task `order_by=priority`, issue #108, and `priority_enum` l/m/h). Every user-facing string for this flag must disambiguate. Binding copy:

- **Flag description:** `"Move the tasklist to position <n> within its project (1 = first). POSITIONAL ORDER, NOT IMPORTANCE — this is unrelated to task priority (low/normal/high). Other tasklists shift to fill the gap; values past the end clamp to last."`
- **Validation error message:** `"--priority must be a positive integer (1 = first position in the project)."`
- **Validation `hintNext`:** `"--priority is the tasklist's POSITION within its project, not an importance level. For task importance see \`freelo tasks edit --priority low|normal|high\`."`

### 2.3 Examples

```bash
# Rename
freelo tasklists edit 9001 --name "QA checklist (v2)"

# Set a 1000.00 budget (minor units) and a 480-minute time fund
freelo tasklists edit 9001 --budget 100000 --time-budget-minutes 480

# Clear both
freelo tasklists edit 9001 --clear-budget --clear-time-budget

# Move this tasklist to the top of its project
freelo tasklists edit 9001 --priority 1

# Replace followers AND push the change down to every existing task (gated)
freelo tasklists edit 9001 --tracking-users 12 --tracking-users 34 \
                           --should-change-existing-tasks --yes

# Preview without calling the API
freelo tasklists edit 9001 --clear-tracking-users --should-change-existing-tasks --dry-run
```

## 3. Envelope contract — `freelo.tasklists.edit/v1`

```ts
type TasklistsEditData = {
  tasklist_id: number;              // always — path positional, echoed for agents
  priority_requested: boolean;      // always — did the user pass --priority?
  priority_applied: boolean;        // always — REQUIRED, see §3.1
  applied_changes: EditTasklistBody;// always — the wire body that was sent (live) or would be (dry-run)
  would?: {                         // dry-run only
    method: 'POST';
    path: string;                   // /tasklist/{id}/edit
    body: EditTasklistBody;
  };
};
```

`would` is present **iff** `--dry-run`. On dry-run, `priority_applied` mirrors `priority_requested === false` (i.e. `true` when no priority change was asked for, and `true` optimistically otherwise — dry-run makes no claim about a call it did not make; the `would` key is the signal that nothing happened).

### 3.1 `priority_applied` — the partial-success contract

`priority_applied` is **always present and non-optional**. Three states an agent can distinguish:

| `priority_requested` | `priority_applied` | Meaning |
|---|---|---|
| `false` | `true` | No reorder asked for. Server returned `priorityApplied: true` trivially. |
| `true` | `true` | Reorder asked for and committed. |
| `true` | `false` | **Partial success.** Every other field committed. The reorder did not. Retry the priority alone. |

In the third case the envelope also carries a `notice`:

```
Tasklist updated, but the priority reorder was NOT applied (server reported priorityApplied=false).
All other fields committed. Retry the reorder alone with:
  freelo tasklists edit <id> --priority <n>
```

**Exit code is 0 in all three cases.** Rationale and the rejected alternative are in decision 4 — this is the load-bearing design call of the slice.

Human mode prints the warning on its own line, prefixed, so it is not lost in a scrollback.

## 4. API surface

Single call. No lookup GET, no refresh GET (decision 6).

```
POST /tasklist/{tasklist_id}/edit
Body: { name?, budget?, time_budget_minutes?, priority?,
        tracking_users_ids?, should_change_existing_tasks?, worker_id? }
200 → { priorityApplied: boolean }   // required; nothing else documented
```

Only keys the user actually set are emitted. `undefined` is never serialized.

### 4.1 Zod schemas

```ts
// Response — `priorityApplied` REQUIRED (spec `required: [priorityApplied]`).
export const EditTasklistResponseSchema = z
  .object({ priorityApplied: z.boolean() })
  .passthrough();
```

`.passthrough()` per repo convention so future Freelo additions survive to `data`. `priorityApplied` is **not** `.optional()` — the OpenAPI contract marks it required, so a response missing it is a genuine contract break and must fail fast at the HTTP layer (same reasoning as `TasklistDetail.project_id` in `src/api/schemas/tasklist.ts:118-122`).

Input/wire types are plain TS (not zod) — matching `CreateTasklistInput` / `CreateTasklistBody`, since request bodies are built, not parsed.

```ts
export type EditTasklistInput = {
  name?: string;
  budget?: string;        // digits-only, validated upstream
  clearBudget?: true;
  timeBudgetMinutes?: number;
  clearTimeBudget?: true;
  worker?: number;
  clearWorker?: true;
  trackingUsers?: readonly number[];
  clearTrackingUsers?: true;
  shouldChangeExistingTasks?: true;
  priority?: number;
};

export type EditTasklistBody = {
  name?: string;
  budget?: string | null;
  time_budget_minutes?: number | null;
  priority?: number;
  tracking_users_ids?: number[];
  should_change_existing_tasks?: boolean;
  worker_id?: number | null;
};
```

## 5. Validation rules (all → `ValidationError`, exit 2)

1. `<id>` not a positive integer.
2. **Four mutex pairs:** `--budget`/`--clear-budget`, `--time-budget-minutes`/`--clear-time-budget`, `--worker`/`--clear-worker`, `--tracking-users`/`--clear-tracking-users`.
3. `--name` empty after trim.
4. `--budget` not `^[0-9]+$` (explicitly catches `"100.50"` and negatives; message names the minor-units convention).
5. `--time-budget-minutes` not an integer `>= 0`.
6. `--worker` not an integer `>= 1`.
7. `--tracking-users` value not an integer `>= 1`.
8. `--priority` not an integer `>= 1`.
9. **At-least-one-mutating-flag** — mirrors R10 decision 3. `--should-change-existing-tasks` alone does **not** count as mutating.
10. `--should-change-existing-tasks` without `--tracking-users` or `--clear-tracking-users` → rejected. The spec defines it only as a modifier on a follower change ("Combine with…"); alone it is a no-op the server would silently ignore.

## 6. Confirmation gate

`confirmDestructive` (`src/lib/confirm.ts`) is invoked **only when `--should-change-existing-tasks` is passed**. Everything else about `tasklists edit` is ungated. See decision 5.

Prompt copy (blast radius stated explicitly, and it names the *clear* case separately because that is the worst one):

```
--should-change-existing-tasks will propagate this follower change to EVERY existing
task in tasklist #<id>. Continue?
```

…and when combined with `--clear-tracking-users`:

```
--should-change-existing-tasks with --clear-tracking-users will REMOVE ALL FOLLOWERS
from EVERY existing task in tasklist #<id>. Continue?
```

Standard R13 contract applies unchanged: `--yes` proceeds; `--dry-run` proceeds without prompting; TTY prompts (default No); **non-TTY without `--yes` → `ConfirmationError`, exit 2**.

`meta.destructive` stays **`false`** — the command does not delete anything, and `--introspect` consumers use that flag to decide whether an operation destroys data. The confirmation gate is conditional on one flag, which `destructive: true` cannot express. Noted in decision 5.

## 7. Error mapping

`rewriteApiHint` mirrors `src/commands/tasklists/create.ts:227-258`:

| Status | `hintNext` |
|---|---|
| 400 | `Server-side validation rejected the edit. If you passed --budget, it must be digits-only minor units (e.g. 100000 for 1000.00), not a decimal.` |
| 403 | `Account does not have permission to edit this tasklist.` |
| 404 | `Tasklist not found, or your account does not have access.` |

401/429/5xx/network fall through to the standard classes (`AUTH_EXPIRED` exit 3, `RateLimitedError` exit 6, `NetworkError` exit 5).

A 2xx body that fails `EditTasklistResponseSchema` surfaces as `FreeloApiError` `VALIDATION_ERROR` exit 4 via the existing client path.

## 8. Edge cases

- **Silent filtering of inaccessible follower ids.** The spec states ids for users without tasklist access are dropped server-side without error. The response carries no follower echo, so the CLI **cannot** detect or report this. Documented in help text and the command docs page rather than guessed at.
- **`--priority` clamping.** Out-of-range values clamp to last, server-side. Not an error. Not simulated client-side.
- **Empty follower list vs. absent.** `--clear-tracking-users` emits `tracking_users_ids: []`; omitting both flags omits the key entirely. Distinct.
- **`--time-budget-minutes 0`** is a real value (set fund to zero), *not* a clear. `--clear-time-budget` sends `null`.
- **Idempotency.** Re-running the same edit is a success; Freelo applies the same values again. No special-casing needed.
- **Batch input.** Deliberately out of scope — see Non-goals.

## 9. Non-goals

- Batch input (`--ids` / `--stdin` NDJSON / repeated `<id>`). `tasklists edit` is a per-resource partial update with 10 interacting flags; a batch surface would need a per-line body and is a slice of its own. Single `<id>` positional only.
- Reading back the tasklist after the edit (decision 6).
- Extracting a shared `src/lib/money.ts` (decision 3).
- A `--strict-priority` flag that would make `priority_applied: false` exit non-zero (considered and rejected in decision 4).
- `tasklists delete` — still undocumented in the OpenAPI spec.

## 10. Open questions

**None.** All six design questions raised at triage were resolved — see decisions 3-8.

---

# Plan

## Files to create

| File | Intent |
|---|---|
| `src/api/tasklists-edit.ts` | `buildEditTasklistBody()` (pure), `editTasklistPath()`, `editTasklist()` (HTTP + schema validation), `isEmptyEditBody()`. |
| `src/commands/tasklists/edit.ts` | Commander registration, all flag parsers, validation, confirm gate, dry-run/live dispatch, envelope emission. |
| `src/ui/human/tasklists-edit.ts` | `renderTasklistsEditHuman()` — success line, dry-run line, priority-not-applied warning line. |
| `test/commands/tasklists/edit.test.ts` | End-to-end tests (harness copied from `create.test.ts`). |
| `test/api/tasklists-edit.test.ts` | Unit tests for the pure body builder + path builder. |
| `test/fixtures/tasklists/edit-priority-applied.json` | `{ "priorityApplied": true }` |
| `test/fixtures/tasklists/edit-priority-not-applied.json` | `{ "priorityApplied": false }` |
| `docs/commands/tasklists.md` (append) or new section | User-facing docs for the subcommand. |
| `.changeset/<name>.md` | `minor` — new command + new envelope schema. |

## Files to modify

| File | Change |
|---|---|
| `src/api/schemas/tasklist.ts` | Append M02 block: `EditTasklistResponseSchema`, `EditTasklistInput`, `EditTasklistBody`, `TasklistsEditData`. |
| `src/commands/tasklists.ts` | `registerEdit(tasklists, getConfig, env)`. |
| `test/msw/handlers.ts` | Append `tasklistsEditHandlers` (ok / okWhenBody / badRequest / unauthorized / forbidden / notFound / rateLimited / networkError / malformed). |
| `README.md` | Regenerated autogen Commands block via `pnpm fix:readme`. |

**Estimated files touched: ~13** (budget 25). ✅

## New dependencies

**None.**

## Test strategy

Unit (`test/api/tasklists-edit.test.ts`), no I/O:
- Body builder emits only set keys; `undefined` never serialized.
- Each clear-flag maps to its documented wire value (`budget: null`, `time_budget_minutes: null`, `worker_id: null`, `tracking_users_ids: []`).
- `--time-budget-minutes 0` emits `0`, not `null`, and is not confused with a clear.
- `should_change_existing_tasks` omitted when not passed.
- Tracking-user dedupe preserves first-seen order.
- `editTasklistPath()` output.
- `isEmptyEditBody()`.

Integration (`test/commands/tasklists/edit.test.ts`), MSW-backed:
- Happy path JSON envelope: `schema`, `data.tasklist_id`, `data.priority_applied`, `data.applied_changes`.
- Wire-body assertion via `okWhenBody` for a maximal flag set — **assert body content, never request counts** (M07 decision 6 / `docs/decisions/2026-08-28-2039-files-delete-6-no-wire-level-request-count-assertions.md`).
- `priorityApplied: false` → exit **0**, `data.priority_applied === false`, `notice` present and mentions the retry command.
- `priorityApplied: true` → no `notice`.
- Human mode: success line; and the priority-not-applied warning line.
- `--dry-run`: `would.method/path/body` correct, `dry_run: true`, **zero HTTP** (asserted by registering a handler that fails the test if hit — content-based, not count-based).
- Confirmation gate: non-TTY + `--should-change-existing-tasks` without `--yes` → `ConfirmationError`, **exit 2**; with `--yes` → proceeds; with `--dry-run` → proceeds without `--yes`.
- **Calibration §7**: any TTY-prompt-path test must `delete process.env['CI']` and restore in `finally`.
- **Calibration §2** — one test per typed error class asserting its exit code:
  - `ValidationError` → 2 (several: mutex, bad budget decimal, bad priority, no-mutating-flag, orphan `--should-change-existing-tasks`)
  - `ConfirmationError` → 2
  - `FreeloApiError` 401 → 3, 403 → 4, 404 → 4, 400 → 4, malformed 2xx body → 4
  - `RateLimitedError` → 6
  - `NetworkError` → 5
- Error-message assertions that `--priority`'s copy says "position"/"not importance" (decision 2 is a user-facing contract, so it gets a test).

Coverage targets: `src/commands/**` 90 lines / 85 branches; `src/api/**` 90 lines / 80 branches.

## Rollout order

Single landable slice.

1. Schemas + API module (`src/api/schemas/tasklist.ts`, `src/api/tasklists-edit.ts`)
2. Human renderer
3. Command + registration
4. MSW handlers + fixtures
5. Tests
6. `pnpm lint && pnpm typecheck && pnpm test:cov && pnpm build && pnpm check:readme`
7. Docs + `pnpm fix:readme` + changeset
