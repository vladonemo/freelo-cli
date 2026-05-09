# Spec 0051 — `freelo tasks estimate set` / `clear` (R37, Wave 6)

**Status:** Draft
**Owner:** orchestrator (run `2026-05-09-2141-r37-tasks-estimate`)
**Roadmap:** R37
**Date:** 2026-05-09
**Depends on:** R10 (`tasks edit`, spec 0020) — for the task-id parsing pattern; R13 (`tasks delete`, spec 0024) — for the destructive-flow + idempotent-on-404 pattern; R35 (`tasks remind`, spec 0049) — for the parent + leaves shape and the "honest about wire ambiguity" idempotency pattern; R33 (`projects invite`, spec 0046) — for `--user <id>` numeric flag parsing.

## 1. Problem

Freelo lets project managers attach a **time estimate** (in minutes) to a task — either as a single team-wide total, or as a per-user breakdown for capacity planning. The four endpoints exist (`POST` / `DELETE` on `/task/{task_id}/total-time-estimate` and on `/task/{task_id}/users-time-estimates/{user_id}` — `docs/api/freelo-api.yaml:2254-2377`). The CLI doesn't expose them.

Today an agent or shell script that wants to:

1. Capture a freshly-scoped task's effort budget after a planning session,
2. Refresh an estimate after a re-scope,
3. Assign per-teammate hours for capacity planning or billing,
4. Clear a stale estimate when a task is deferred or cancelled,

…has to leave the terminal and use the Freelo web UI. There's no programmatic surface, so the estimate cannot be set as part of an automated workflow (e.g. a code-review agent that increments the estimate based on discovered scope).

## 2. Proposal

### 2.1 CLI surface (additive — one new parent with two leaves)

```
freelo tasks estimate set   <id> --minutes <n> [--user <id>] [--dry-run]
freelo tasks estimate clear <id>                [--user <id>] [--yes] [--dry-run]
```

Both leaves are **single-id v1**. Batch (`--ids` / `--stdin`) is deferred to a future R37.5 if demand emerges.

The shape is **parent + leaves** (R35 precedent — `tasks remind set/clear`), not sibling pair (R36 precedent — `tasks share/unshare`). Justification:

- The two verbs share a substantial option surface: both accept `<id>` positional and the `--user <id>` toggle. Sharing the option contract under one parent reads cleaner than duplicating "with or without `--user`" in two top-level help blocks.
- The verbs are conceptually one operation in two modes (`set` and `clear` of an estimate), not two unrelated actions on the same noun. R35 (set/clear a reminder) is the precedent that fits.
- The R37 roadmap shorthand uses `tasks estimate set / tasks estimate clear`, signalling the parent intent.

**`tasks estimate set <id> --minutes <n>`** — non-destructive **upsert**. Sets (or replaces) the task's total time estimate. Server upserts (yaml :2267 — `TimeEstimateFacade::createOrUpdate`).

**`tasks estimate set <id> --minutes <n> --user <id>`** — non-destructive upsert, scoped to a single worker. Server upserts (yaml :2324 — `TimeEstimateUserFacade::createOrUpdate`). Does **not** auto-update the team total (yaml :2325).

**`tasks estimate clear <id>`** — destructive. Removes the task's total time estimate. Reuses the R13 `confirmDestructive` gate. Idempotent: server returns 200 even when no estimate is set (yaml :2299).

**`tasks estimate clear <id> --user <id>`** — destructive, scoped. Removes one user's per-user estimate. Same confirmation gate. Idempotent (yaml :2362).

### 2.2 Wire mapping

The `--user <id>` flag is a **path toggle**, not a body field — it changes the URL the request goes to:

| invocation                                  | wire                                                   |
| ------------------------------------------- | ------------------------------------------------------ |
| `set <task> --minutes <n>`                  | `POST /task/{task}/total-time-estimate`                |
| `set <task> --minutes <n> --user <user>`    | `POST /task/{task}/users-time-estimates/{user}`        |
| `clear <task>`                              | `DELETE /task/{task}/total-time-estimate`              |
| `clear <task> --user <user>`                | `DELETE /task/{task}/users-time-estimates/{user}`      |

#### `set` (both modes)

```
POST {chosen-path}
Content-Type: application/json
{ "minutes": <n> }
```

Body schema (yaml :2278-2282 and :2341-2345):

```yaml
required: [minutes]
properties:
  minutes:
    type: integer
```

Response (yaml :2284-2289 and :2346-2352): `SuccessResponse` (`{ result: 'success' }`).

#### `clear` (both modes)

```
DELETE {chosen-path}
(no body)
```

Response (yaml :2304-2309 and :2370-2377): `SuccessResponse`. 200 even when no estimate exists (yaml :2299, :2362).

### 2.3 Output schemas

Two new envelope schemas, one per leaf:

#### `freelo.tasks.estimate.set/v1`

| field        | type     | always present | notes                                                             |
| ------------ | -------- | -------------- | ----------------------------------------------------------------- |
| `task_id`    | int      | yes            | echo of `<id>` positional                                         |
| `user_id`    | int \| null | yes        | `null` for total estimate; numeric for per-user                   |
| `minutes`    | int      | yes            | echo of `--minutes <n>` (server response carries no minutes echo) |
| `scope`      | `'total' \| 'user'` | yes | discriminator — derived from `--user` presence                  |
| `would`      | object   | dry-run only   | `{ method: 'POST', path, body: { minutes } }`                     |

#### `freelo.tasks.estimate.clear/v1`

| field                       | type     | always present | notes                                                                              |
| --------------------------- | -------- | -------------- | ---------------------------------------------------------------------------------- |
| `task_id`                   | int      | yes            | echo of `<id>` positional                                                          |
| `user_id`                   | int \| null | yes        | `null` for total estimate; numeric for per-user                                    |
| `scope`                     | `'total' \| 'user'` | yes | discriminator — derived from `--user` presence                                  |
| `already_in_target_state`   | boolean  | yes            | `true` only on the defensive 404 path; `false` on live 200. Dry-run: `false`.      |
| `would`                     | object   | dry-run only   | `{ method: 'DELETE', path, body: {} }`                                             |

### 2.4 Validation rules

- `<id>` (positional) must be a positive integer. Rejected via `ValidationError` (exit 2) — not Commander's `InvalidArgumentError` (calibration §1-2).
- `--user <id>` (when present) must be a positive integer. Rejected via `ValidationError` (exit 2). Same parser as in `projects/invite.ts:111`.
- `--minutes <n>` (on `set`) must be a positive integer (>= 1). Rejected via `ValidationError` (exit 2). The OpenAPI says `type: integer` without an explicit lower bound, but a zero-or-negative estimate is semantically nonsense. Server-side will likely reject too; we fail fast.
- `--minutes` is **required** on `set`; missing → `ValidationError` (exit 2). Surfaced explicitly because Commander's "missing required option" message routes through stderr without our envelope.
- `set` does not accept `--yes` (non-destructive); the global `--yes` is silently ignored on this leaf (R35 `set` precedent).
- `clear` does not accept `--minutes` (no body to send).
- Both leaves accept `--dry-run`.

### 2.5 Confirmation policy (`clear` only — `set` skips entirely)

Mirrors R35 `clear` / R36 `unshare` byte-for-byte for the single-id flow:

- `--yes` → unconditional proceed.
- `--dry-run` → unconditional proceed (no destructive effect).
- TTY without `--yes` → prompt:
  - total scope: `"Clear total time estimate on task #<id>?"`
  - user scope: `"Clear time estimate for user #<user> on task #<id>?"`
  - Decline → `ConfirmationError` (exit 2).
- Non-TTY without `--yes` → throw `ConfirmationError` (exit 2) immediately (fail closed).

Single-id only, so `confirmDestructive` is called once per invocation.

### 2.6 Idempotency

#### `set`

The server upserts on every call (yaml :2267, :2324). We do not surface an `already_in_target_state` field on `set` — the wire collapses "created" and "updated" into a single 200 with a generic `SuccessResponse`. Mirrors R36 `share` decision 2 (be honest about wire ambiguity; don't lie).

A future improvement could GET pre-check the prior estimate to detect "already at this value" — but the OpenAPI does not document a GET on either endpoint, so we cannot do this without a reverse-engineered shape. Out of scope.

#### `clear`

The OpenAPI **explicitly** documents 200 for the no-estimate case (yaml :2299, :2362). The wire cannot distinguish "had an estimate, deleted it" from "had no estimate, no-op". Mirrors R35 `clear` decision 4: live 200 always emits `already_in_target_state: false` (we don't know it was already cleared); a defensive 404 catch maps to `already_in_target_state: true` (forward-compat in case Freelo tightens the endpoint).

### 2.7 Dry-run behavior

Both leaves support `--dry-run`. In dry-run mode:

- No wire call.
- Envelope carries `dry_run: true`.
- `data.would.method`, `data.would.path`, `data.would.body` echo what would have been sent.
- For `set`: `would.body = { minutes: <n> }`.
- For `clear`: `would.body = {}`.
- `data.scope`, `data.task_id`, `data.user_id`, `data.minutes` (set only) are populated as on the live path.

### 2.8 Help text

```
Usage: freelo tasks estimate [options] [command]

Manage a task's time estimate (total or per-user). Total estimates are the
team-wide effort budget; per-user estimates are individual capacity
allocations. Per-user estimates are independent — setting one does NOT
update the total.

Commands:
  set <id>      Set or update an estimate (upsert).
  clear <id>    Remove an estimate.

Options for `set`:
  --minutes <n>   Estimate in minutes (positive integer). Required.
  --user <id>     Apply to a single user instead of the task total. Optional.
  --dry-run       Skip the POST; envelope echoes the body that would have been sent.

Options for `clear`:
  --user <id>     Clear a single user's estimate instead of the task total. Optional.
  --yes           Bypass the confirmation prompt (required in non-TTY mode).
  --dry-run       Skip the DELETE; envelope echoes the path that would have been called.
```

### 2.9 Examples

```bash
# Set a total estimate of 2 hours:
$ freelo tasks estimate set 4567 --minutes 120 --output json
{"schema":"freelo.tasks.estimate.set/v1","data":{"task_id":4567,"user_id":null,"minutes":120,"scope":"total"}}

# Set a per-user estimate of 90 minutes for user #42:
$ freelo tasks estimate set 4567 --minutes 90 --user 42 --output json
{"schema":"freelo.tasks.estimate.set/v1","data":{"task_id":4567,"user_id":42,"minutes":90,"scope":"user"}}

# Dry-run echoes the canonical body:
$ freelo tasks estimate set 4567 --minutes 120 --dry-run --output json
{"schema":"freelo.tasks.estimate.set/v1","dry_run":true,"data":{"task_id":4567,"user_id":null,"minutes":120,"scope":"total","would":{"method":"POST","path":"/task/4567/total-time-estimate","body":{"minutes":120}}}}

# Clear total estimate (TTY, prompts):
$ freelo tasks estimate clear 4567
? Clear total time estimate on task #4567? (y/N) y
{"schema":"freelo.tasks.estimate.clear/v1","data":{"task_id":4567,"user_id":null,"scope":"total","already_in_target_state":false}}

# Clear a per-user estimate (agent-style):
$ freelo tasks estimate clear 4567 --user 42 --yes --output json
{"schema":"freelo.tasks.estimate.clear/v1","data":{"task_id":4567,"user_id":42,"scope":"user","already_in_target_state":false}}

# Validation: missing --minutes on set:
$ freelo tasks estimate set 4567
# stderr: VALIDATION_ERROR — --minutes is required. exit 2.

# Validation: zero or negative --minutes:
$ freelo tasks estimate set 4567 --minutes 0
# stderr: VALIDATION_ERROR — --minutes must be a positive integer. exit 2.

# HTTP 403 on per-user (user not assignable to task):
$ freelo tasks estimate set 4567 --minutes 60 --user 999
# stderr: FREELO_API_ERROR — Role action forbidden. exit 4.
```

## 3. Data model

### 3.1 New file: `src/api/schemas/task-estimate.ts`

```ts
import { z } from 'zod';

/**
 * `POST` and `DELETE` on `/task/{task_id}/total-time-estimate` and on
 * `/task/{task_id}/users-time-estimates/{user_id}` all return the generic
 * `SuccessResponse` (yaml :2284-2289, :2304-2309, :2346-2352, :2370-2377).
 *
 * Same shape as `tasks-delete.ts` and `tasks-reminder.ts`. Apply the
 * project-wide `.passthrough()` + nullable.optional convention.
 */
export const EstimateResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();

export type EstimateResponse = z.infer<typeof EstimateResponseSchema>;

/* ---- envelope `data` types -------------------------------------------- */

/** Wire echo for `--dry-run` envelopes. */
export type EstimateWould = {
  method: 'POST' | 'DELETE';
  path: string;
  body: Record<string, unknown>;
};

/** Discriminator: total estimate or single-user estimate. */
export type EstimateScope = 'total' | 'user';

/**
 * `freelo.tasks.estimate.set/v1` envelope `data`.
 *
 * - `task_id`  — echo of `<id>` positional. Always present.
 * - `user_id`  — `null` for total scope; numeric for user scope. Always present.
 * - `minutes`  — echo of `--minutes <n>` (server response is `SuccessResponse`,
 *                no minutes echo). Always present.
 * - `scope`    — discriminator derived from `--user` presence. Always present.
 * - `would`    — present iff `--dry-run`.
 */
export type TasksEstimateSetData = {
  task_id: number;
  user_id: number | null;
  minutes: number;
  scope: EstimateScope;
  would?: EstimateWould;
};

/**
 * `freelo.tasks.estimate.clear/v1` envelope `data`.
 *
 * - `task_id`                 — echo of `<id>` positional. Always present.
 * - `user_id`                 — `null` for total scope; numeric for user scope.
 * - `scope`                   — discriminator derived from `--user` presence.
 * - `already_in_target_state` — `true` only on defensive 404 path; `false`
 *                               on live 200 path because the wire cannot
 *                               distinguish "had an estimate" from "had none".
 * - `would`                   — present iff `--dry-run`.
 */
export type TasksEstimateClearData = {
  task_id: number;
  user_id: number | null;
  scope: EstimateScope;
  already_in_target_state: boolean;
  would?: EstimateWould;
};
```

### 3.2 New file: `src/api/tasks-estimate.ts`

Two thin wrappers + path helpers:

```ts
import { type ApiResponse, type HttpClient } from './client.js';
import { EstimateResponseSchema } from './schemas/task-estimate.js';

export type SetEstimateOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type SetEstimateResult = {
  raw: ApiResponse<unknown>;
};

export type ClearEstimateOpts = SetEstimateOpts;
export type ClearEstimateResult = SetEstimateResult;

/**
 * Resolve the wire path for the total estimate. Exposed so `--dry-run`
 * envelopes can echo without re-running the live branch.
 */
export function totalEstimatePath(taskId: number): string {
  return `/task/${taskId}/total-time-estimate`;
}

/** Resolve the wire path for a per-user estimate. */
export function userEstimatePath(taskId: number, userId: number): string {
  return `/task/${taskId}/users-time-estimates/${userId}`;
}

/**
 * `POST` to either the total or per-user path, depending on `userId`.
 * Body: `{ minutes: <n> }`. Server upserts (yaml :2267, :2324).
 */
export async function setEstimate(
  client: HttpClient,
  taskId: number,
  minutes: number,
  userId: number | null,
  opts: SetEstimateOpts = {},
): Promise<SetEstimateResult> {
  const path = userId === null ? totalEstimatePath(taskId) : userEstimatePath(taskId, userId);
  const raw = await client.request({
    method: 'POST',
    path,
    body: { minutes },
    schema: EstimateResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}

/**
 * `DELETE` on either the total or per-user path, depending on `userId`.
 * No body. Server idempotent on missing-estimate (yaml :2299, :2362).
 */
export async function clearEstimate(
  client: HttpClient,
  taskId: number,
  userId: number | null,
  opts: ClearEstimateOpts = {},
): Promise<ClearEstimateResult> {
  const path = userId === null ? totalEstimatePath(taskId) : userEstimatePath(taskId, userId);
  const raw = await client.request({
    method: 'DELETE',
    path,
    schema: EstimateResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}
```

### 3.3 New files: `src/commands/tasks/estimate.ts` (parent), `src/commands/tasks/estimate/set.ts`, `src/commands/tasks/estimate/clear.ts`

Mirror the `tasks/remind` shape exactly. Parent has no `meta`/action; leaves do.

### 3.4 New files: `src/ui/human/tasks-estimate-set.ts`, `src/ui/human/tasks-estimate-clear.ts`

One-line human-mode renderers (TTY mode):

```
Total time estimate set on task #4567 to 120 min.
Time estimate for user #42 set on task #4567 to 90 min.
[dry-run] Total time estimate would be set on task #4567 to 120 min.

Total time estimate cleared on task #4567.
Time estimate for user #42 cleared on task #4567.
Total time estimate on task #4567 was already cleared.
[dry-run] Total time estimate would be cleared on task #4567.
```

## 4. Edge cases

| edge case                                                    | handling                                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `set` total + 200                                            | live envelope; `scope: 'total'`; `user_id: null`                                          |
| `set` per-user + 200                                         | live envelope; `scope: 'user'`; `user_id: <n>`                                            |
| `set` + 401 / 5xx                                            | `FreeloApiError` / `NetworkError` — top-level handler emits `freelo.error/v1`             |
| `set` + 403 (user not assignable, per-user only)             | `FreeloApiError` exit 4 (`code: 'FORBIDDEN'`)                                             |
| `set` + 404 (task not found)                                 | `FreeloApiError` exit 4 (`code: 'NOT_FOUND'`)                                             |
| `set` + 404 (user not assignable, per-user — yaml :2326)     | `FreeloApiError` exit 4 (`code: 'NOT_FOUND'`) — server-defined; same handling             |
| `set` + `--dry-run`                                          | no wire call; envelope `dry_run: true`; `would.body.minutes = <n>`                        |
| `set` without `--minutes`                                    | `ValidationError` exit 2                                                                  |
| `set --minutes 0` / negative                                 | `ValidationError` exit 2 (positive-int parser)                                            |
| `set --minutes 1.5` / non-integer                            | `ValidationError` exit 2                                                                  |
| `set --user 0` / non-numeric                                 | `ValidationError` exit 2                                                                  |
| `set <id>` with non-numeric `<id>`                           | `ValidationError` exit 2                                                                  |
| `clear` total + 200                                          | live envelope; `scope: 'total'`; `already_in_target_state: false`                         |
| `clear` per-user + 200                                       | live envelope; `scope: 'user'`; `already_in_target_state: false`                          |
| `clear` + 404 (defensive future-proof)                       | re-classify as `already_in_target_state: true` (mirrors R13 / R35 / R36)                  |
| `clear` + non-TTY without `--yes`                            | `ConfirmationError` exit 2 immediately, no DELETE                                         |
| `clear` + TTY without `--yes`, user declines                 | `ConfirmationError` exit 2, no DELETE                                                     |
| `clear` + TTY without `--yes`, user accepts                  | DELETE proceeds                                                                           |
| `clear` + `--yes`                                            | DELETE proceeds, no prompt                                                                |
| `clear` + `--dry-run`                                        | no DELETE, no prompt; envelope `dry_run: true`                                            |
| `clear --user 0`                                             | `ValidationError` exit 2                                                                  |
| `clear <id>` with non-numeric `<id>`                         | `ValidationError` exit 2                                                                  |
| `set` called twice with same minutes                         | server upserts silently; CLI envelope identical (no `already_in_target_state` slot on set) |
| Per-user estimate doesn't bump total                         | documented; we don't intervene (yaml :2325 — server-side concern)                         |

## 5. Non-goals

- **No batch (`--ids` / `--stdin`).** Single-id v1; revisit as R37.5 if demand emerges.
- **No bulk per-user set in one call.** `set --user 42 --user 99 --minutes 60` is **not** supported. The wire requires one POST per user; mixing two semantics under one flag invocation is a UX foot-gun. Run two invocations.
- **No estimate-listing.** The OpenAPI does not document a GET on either endpoint. To inspect, use `freelo tasks show <id> --output json` and look for embedded estimate fields if Freelo surfaces them (out of scope here).
- **No envelope changes elsewhere.** No bumps to `freelo.tasks.show/v1`; no estimate field added to existing envelopes.
- **No `--hours` flag.** Wire body is `minutes` per the OpenAPI; we don't invent a unit converter. Agents `--minutes $((H * 60))`.
- **No auto-bumping of total when per-user is set.** Documented server-side behaviour (yaml :2325); the CLI does not aggregate.
- **No introspect golden update.** `tasks` is in the golden but the golden snapshots only specific subtrees; verified by grep. A fresh introspect run will be regenerated by `pnpm fix:readme` if needed.

## 6. Open questions

None. All decisions resolved in §7.

## 7. Decisions made autonomously

### Decision 1 — Parent + leaves shape (`tasks estimate set` / `clear`), not sibling pair

**Question:** R37 has two related verbs. R35 used parent + leaves. R36 used siblings. Which shape for R37?

**Decision:** Parent + leaves — `tasks estimate set` and `tasks estimate clear`.

**Alternatives considered:**
- Sibling pair: `tasks estimate-set` / `tasks estimate-clear` → rejected; hyphenated commands look odd next to single-word siblings.
- Sibling pair: `tasks estimate` (set) / `tasks unestimate` (clear) → rejected; "unestimate" is not a verb people use.
- Single verb with a flag: `tasks estimate <id> --minutes <n>` for set, `tasks estimate <id> --clear` for clear → rejected; mixing destructive and non-destructive under one command.

**Rationale:** Parent + leaves is the right shape when the leaves share a substantial option surface (here: `<id>` positional and `--user <id>` toggle). The shared `--user` flag is the load-bearing case — duplicating "with or without `--user`" in two top-level help blocks would be noisy. R35 (`tasks remind set/clear`) is the precedent.

### Decision 2 — `--user <id>` is a path toggle, not a body field

**Question:** The OpenAPI documents two separate endpoint pairs (total vs. per-user). Should the CLI route via `--user` choosing the path, or via a body field?

**Decision:** Path toggle. `--user <id>` present → per-user path. Absent → total path.

**Alternatives considered:**
- Always send to per-user path with `user_id: null` for total → rejected; the per-user endpoint requires `{user_id}` in the path; not interchangeable.
- Always send to total path with `user_id: <n>` in the body → rejected; the OpenAPI body schema documents only `minutes`. Inventing a `user_id` body field is a forbidden API guess.
- Two top-level commands `tasks total-estimate set` / `tasks user-estimate set --user <id>` → rejected; doubles the command surface for what is conceptually one operation.

**Rationale:** The OpenAPI is unambiguous: two separate endpoints. The path toggle is the natural CLI-side reflection of the wire reality. The boolean-ish "with or without `--user`" maps cleanly to the discriminator field `scope: 'total' | 'user'` in the envelope, which agents can branch on.

### Decision 3 — `--minutes` is required on `set` (no nullable, no defaulting)

**Question:** Should `set` allow `--minutes` to be omitted (and implicitly mean "0", "1 hour", or "use the current value")?

**Decision:** No. `--minutes` is required.

**Alternatives considered:**
- Allow `set` without `--minutes` → "0 minutes (clear)" → rejected; conflates `set` and `clear`.
- Allow `set` without `--minutes` → "1 hour default" → rejected; magic defaulting; UX surprise.
- Allow `set` without `--minutes` → "use current value (no-op upsert)" → rejected; pointless wire call.

**Rationale:** An estimate needs a value. The OpenAPI documents `required: [minutes]` (yaml :2278-2280, :2341-2343), matching this CLI choice. Mirrors R35 decision 3 (`--at` required on `tasks remind set`).

### Decision 4 — `--minutes` must be `>= 1` (positive integer); reject 0 and negative

**Question:** The OpenAPI says `type: integer` without a `minimum:` bound. Should the CLI accept 0 or negative values?

**Decision:** No. Reject `--minutes <= 0` with `ValidationError` (exit 2).

**Alternatives considered:**
- Accept 0 → rejected; semantically meaningless (0-minute estimate ≡ no estimate); ambiguous overlap with `clear`.
- Accept negative → rejected; obviously invalid; will likely 4xx on server side anyway; better to fail fast at parse time.
- Accept any integer (let server decide) → rejected; we have a useful guardrail; the round-trip cost of letting bad input through is greater than the validation cost.

**Rationale:** Fail fast at parse time. The `>= 1` lower bound is defensible (we infer it from the semantics, not the OpenAPI), so this is a "small UX choice with a clear precedent" — log as decision, ship.

### Decision 5 — `set` does not surface `already_in_target_state`

**Question:** Should `set` carry an `already_in_target_state` slot like `clear` does, to signal "this estimate already had this value"?

**Decision:** No. `set` envelope has no `already_in_target_state` field.

**Alternatives considered:**
- GET pre-check the current estimate → rejected; the OpenAPI does not document a GET on either endpoint. We'd be inventing a wire shape — forbidden.
- Always set to `null` like `share`'s `created` field → rejected; speculative; the data isn't on the wire to begin with. Adding a slot for nothing is noise.
- Compare the response body to `{ minutes: <n> }` for an echo → rejected; the OpenAPI documents `SuccessResponse`, no minutes echo.

**Rationale:** Be honest about wire ambiguity (R35/R36 precedent). The wire collapses "created" and "updated"; we don't lie about it. Agents that need this info maintain state externally — the same constraint Freelo's web UI has.

### Decision 6 — `clear` reuses the R35/R36 defensive-404 pattern

**Question:** Should `clear` re-classify a 404 as `already_in_target_state: true`?

**Decision:** Yes. Same pattern as R13 `delete`, R35 `clear`, R36 `unshare`.

**Alternatives considered:**
- Surface 404 as `FreeloApiError` → rejected; "delete-of-already-gone returning success" is the agent-friendly behavior.
- Always emit `already_in_target_state: false` → rejected; loses information when Freelo tightens the endpoint.

**Rationale:** Consistency across destructive idempotent ops. The OpenAPI documents 200 for the no-estimate case (yaml :2299, :2362), so the live path always emits `false`; the 404 catch is purely forward-compat.

### Decision 7 — Confirmation prompt copy distinguishes total vs. per-user

**Question:** Should `clear` use one generic prompt or a scope-specific one?

**Decision:** Scope-specific:
- Total: `"Clear total time estimate on task #<id>?"`
- Per-user: `"Clear time estimate for user #<user> on task #<id>?"`

**Alternatives considered:**
- Generic: `"Clear time estimate on task #<id>?"` → rejected; ambiguous about scope; user may be confused if they pass `--user 42` and the prompt doesn't reflect it.
- Pre-fetch user name → rejected; double round-trip on a destructive path; no GET on `/users/{id}` documented for individual lookup; out of scope.

**Rationale:** The user_id is critical context when the destructive scope is per-user; the prompt should reflect what's about to happen. Agents bypassing with `--yes` never see the prompt either way.

### Decision 8 — Single-id v1; no batch in this slice

**Question:** Should `set` / `clear` support batch input (`--ids` / `--stdin`)?

**Decision:** No. Single-id only.

**Alternatives considered:**
- Mirror `tasks delete` (R13) batch shape → rejected; per-row `--minutes` and `--user` would force NDJSON; doubles complexity.
- Allow `--user <id>` to repeat (e.g. set the same estimate for multiple users in one call) → rejected; the wire requires one POST per user; bundling under one flag-invocation hides N round-trips.

**Rationale:** Keep the slice small and landable. Roadmap line for R37 is single-id. R37.5 can add NDJSON-batch with clear semantics for both leaves at once.

## Plan

### Branch

`feat/tasks-estimate` (from `main`).

### Files to create

| Path                                                    | Intent                                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/api/schemas/task-estimate.ts`                      | Zod response schema for set/clear + envelope `data` types + scope discriminator. |
| `src/api/tasks-estimate.ts`                             | `setEstimate()` / `clearEstimate()` / `totalEstimatePath()` / `userEstimatePath()` wire wrappers. |
| `src/commands/tasks/estimate.ts`                        | Parent `tasks estimate` subcommand registrar.                                |
| `src/commands/tasks/estimate/set.ts`                    | `tasks estimate set <id> --minutes <n> [--user <id>] [--dry-run]` leaf.      |
| `src/commands/tasks/estimate/clear.ts`                  | `tasks estimate clear <id> [--user <id>] [--yes] [--dry-run]` leaf (destructive). |
| `src/ui/human/tasks-estimate-set.ts`                    | Human-mode renderer for `set`.                                               |
| `src/ui/human/tasks-estimate-clear.ts`                  | Human-mode renderer for `clear`.                                             |
| `test/commands/tasks/estimate-set.test.ts`              | Integration tests for `tasks estimate set` (MSW).                            |
| `test/commands/tasks/estimate-clear.test.ts`            | Integration tests for `tasks estimate clear` (MSW + confirm helper).         |
| `docs/commands/tasks-estimate.md`                       | User-facing docs for both leaves.                                            |
| `.changeset/r37-tasks-estimate.md`                      | `freelo-cli: minor` — new subcommands.                                       |

### Files to modify

| Path                              | Change                                                                  |
| --------------------------------- | ----------------------------------------------------------------------- |
| `src/commands/tasks.ts`           | Import + call `registerEstimate`.                                       |
| `test/msw/handlers.ts`            | Append `tasksEstimateSetHandlers` and `tasksEstimateClearHandlers` blocks. |
| `README.md`                       | Autogen Commands block — regenerate via `pnpm fix:readme`.              |

### Files NOT modified

- `src/api/client.ts` — no client changes; reuses POST/DELETE.
- `src/api/schemas/task.ts` — no envelope shape change.
- `src/lib/confirm.ts` — reused as-is.
- `src/lib/dry-run.ts` — reused as-is.
- `src/ui/envelope.ts` — reused as-is.
- `test/fixtures/introspect-golden.json` — only specific subtrees are locked; verify by grep.

### New runtime dependencies

**None.** All needed primitives present.

### Test strategy

#### Integration tests (`test/commands/tasks/estimate-set.test.ts`) — new

Use MSW to mock `POST /task/4567/total-time-estimate` and `POST /task/4567/users-time-estimates/42`. Mirror the `tasks/remind-set.test.ts` shape.

- **Happy path live (total)**: `set 4567 --minutes 120` → exit 0, envelope `freelo.tasks.estimate.set/v1`: `{ task_id: 4567, user_id: null, minutes: 120, scope: 'total' }`. Wire body captured: `{ minutes: 120 }`.
- **Happy path live (per-user)**: `set 4567 --minutes 90 --user 42` → exit 0, envelope `{ task_id: 4567, user_id: 42, minutes: 90, scope: 'user' }`. Wire body: `{ minutes: 90 }` to per-user path.
- **Dry-run (total)**: `set 4567 --minutes 120 --dry-run` → no wire call, envelope `dry_run: true`, `data.would.method = 'POST'`, `would.path = '/task/4567/total-time-estimate'`, `would.body.minutes = 120`.
- **Dry-run (per-user)**: `set 4567 --minutes 90 --user 42 --dry-run` → `would.path = '/task/4567/users-time-estimates/42'`.
- **Validation: missing --minutes** → exit 2 (`ValidationError`, `--minutes is required`).
- **Validation: --minutes 0** → exit 2.
- **Validation: --minutes -5** → exit 2.
- **Validation: --minutes 1.5** (non-integer) → exit 2.
- **Validation: --minutes abc** → exit 2.
- **Validation: --user 0** → exit 2.
- **Validation: --user abc** → exit 2.
- **Validation: non-numeric `<id>`** → exit 2.
- **Validation: zero `<id>`** → exit 2.
- **HTTP 401** → exit 3.
- **HTTP 403** → exit 4.
- **HTTP 404** → exit 4.
- **HTTP 500** → exit 4.
- **Human mode** renders one terse line containing `120 min` (total) or `for user #42` (per-user).

#### Integration tests (`test/commands/tasks/estimate-clear.test.ts`) — new

Use MSW to mock `DELETE /task/4567/total-time-estimate` and `DELETE /task/4567/users-time-estimates/42`. Mirror the `tasks/remind-clear.test.ts` shape.

- **Happy path live + `--yes` (total)**: `clear 4567 --yes` → exit 0, envelope `{ task_id: 4567, user_id: null, scope: 'total', already_in_target_state: false }`.
- **Happy path live + `--yes` (per-user)**: `clear 4567 --user 42 --yes` → exit 0, envelope `{ task_id: 4567, user_id: 42, scope: 'user', already_in_target_state: false }`.
- **Defensive 404 → idempotent (total)** → exit 0, `already_in_target_state: true`.
- **Defensive 404 → idempotent (per-user)** → exit 0, `already_in_target_state: true`, `scope: 'user'`.
- **Dry-run (total)**: `clear 4567 --dry-run` → no wire call, envelope `dry_run: true`, `would.method = 'DELETE'`, `would.path = '/task/4567/total-time-estimate'`, `would.body = {}`.
- **Dry-run (per-user)**: `clear 4567 --user 42 --dry-run` → `would.path = '/task/4567/users-time-estimates/42'`.
- **Non-TTY without `--yes`** → exit 2 `CONFIRMATION_REQUIRED`, no wire call. (Calibration §7: clear `CI` env, spoof `isTTY = false`.)
- **TTY accepts (total)** → exit 0; calibration §7. Assert prompt copy contains `task #4567` and `total time estimate`.
- **TTY declines (per-user)** → exit 2; calibration §7. Assert prompt copy contains `task #4567` and `user #42`.
- **Validation: non-numeric `<id>`** → exit 2.
- **Validation: zero `<id>`** → exit 2.
- **Validation: --user 0** → exit 2.
- **Validation: --user abc** → exit 2.
- **HTTP 401** → exit 3.
- **HTTP 500** → exit 4.
- **Human mode** renders one terse line containing `cleared on task #4567` / `was already cleared` / `[dry-run]`.

#### Coverage callouts

- Calibration §1 — full test phase before commit.
- Calibration §2 — every error-class path has an explicit `exitCode` assertion: `ValidationError` (2), `ConfirmationError` (2), `FreeloApiError` (3 / 4).
- Calibration §3 — five-gate before push.
- Calibration §4 — the only new `try/catch` is in `clear.ts` (defensive 404 → already-cleared); covered by mandatory test.
- Calibration §7 — TTY-prompt tests in `estimate-clear.test.ts` clear `process.env.CI` around the test body.

#### Five-gate before push

`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme` must all pass on the committed tree before `git push -u`.

### Rollout

Single landable slice. Squash on PR merge:

`feat(commands): tasks estimate set / clear (R37)`
