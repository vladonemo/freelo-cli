# Spec 0049 — `freelo tasks remind` (R35, Wave 6)

**Status:** Draft
**Owner:** orchestrator (run `2026-05-09-1200-tasks-remind`)
**Roadmap:** R35
**Date:** 2026-05-09
**Depends on:** R10 (`tasks edit`, spec 0020) — for the task-id parsing pattern; R13 (`tasks delete`, spec 0024) — for the destructive `clear` pattern; R19.5 (spec 0031) — for `parseIsoTimestampFlag`.

## 1. Problem

Freelo lets each user attach a **personal reminder** to any task — "ping me about this at 09:00 tomorrow". The reminder fires a notification at the chosen instant. Today the only way to set or clear a personal reminder is through the Freelo web UI; agents and shell scripts have no terminal-native way to:

1. Schedule a self-ping at a specific UTC time as part of a workflow (`gh pr review` → `freelo tasks remind set <id> --at 2026-05-10T09:00:00Z`).
2. Clear a stale reminder programmatically when a workflow concludes.
3. Round-trip a reminder via dry-run to inspect what would be sent before committing.

The Freelo API has the matching endpoints — `POST /task/{task_id}/reminder` and `DELETE /task/{task_id}/reminder` (`docs/api/freelo-api.yaml:2067-2135`). They've simply never been exposed.

## 2. Proposal

### 2.1 CLI surface (additive — two new sibling subcommands)

```
freelo tasks remind set <id> --at <ISO> [--dry-run]
freelo tasks remind clear <id> [--yes] [--dry-run]
```

Both are **single-id v1**. Batch (`--ids` / `--stdin`) is deferred to a future R35.5 if demand emerges — `set` requires a per-row `--at`, which would force NDJSON anyway, and the slice is small without it. Mirrors the `tasks description get/set` shape from R15: the parent (`tasks remind`) carries no action and no `meta`; only the leaves do.

**`tasks remind set <id> --at <ISO>`** — non-destructive upsert. Sets (or replaces) the caller's personal reminder on the task at the supplied UTC ISO 8601 timestamp.

**`tasks remind clear <id>`** — destructive. Removes the caller's personal reminder on the task. Reuses the R13 `confirmDestructive` gate: `--yes` bypasses, TTY without `--yes` prompts, non-TTY without `--yes` throws `ConfirmationError` (exit 2). Idempotent: server returns 200 even when no reminder is set (`docs/api/freelo-api.yaml:2125`); we surface this as `already_in_target_state: true` based on the **HTTP body**, not status — see §3.4.

### 2.2 Wire mapping

#### `set`

```
POST /task/{task_id}/reminder
Content-Type: application/json
{ "remind_at": "2026-05-10T09:00:00Z" }
```

Response (yaml :2098-2115):

```jsonc
{
  "remind_at": "2026-05-10T09:00:00Z",
  "task": { "id": <int>, "name": "<str>" }
}
```

The CLI canonicalizes any `--at` input to second-precision UTC `YYYY-MM-DDTHH:MM:SSZ` via `parseIsoTimestampFlag` (decision 1 below) before sending — same canonicalization rule as R19.5's `time start --at`.

#### `clear`

```
DELETE /task/{task_id}/reminder
(no body)
```

Response (yaml :2129-2135): `SuccessResponse` (`{ "result": "success" }`). 200 even when there was no reminder to delete (yaml :2125).

### 2.3 Output schemas

Two new envelope schemas, one per leaf:

#### `freelo.tasks.remind.set/v1`

| field         | type     | always present | notes                                                                |
| ------------- | -------- | -------------- | -------------------------------------------------------------------- |
| `task_id`     | int      | yes            | echo of `<id>` positional                                            |
| `task_name`   | string \| null | live only | from server response `task.name`; null if server omits         |
| `remind_at`   | string   | yes            | canonical UTC ISO from the response (live) or from input (dry-run) |
| `would`       | object   | dry-run only   | `{ method, path, body }`                                             |

#### `freelo.tasks.remind.clear/v1`

| field                       | type     | always present | notes                                                                              |
| --------------------------- | -------- | -------------- | ---------------------------------------------------------------------------------- |
| `task_id`                   | int      | yes            | echo of `<id>` positional                                                          |
| `already_in_target_state`   | boolean  | yes            | `true` if the server's response indicated no reminder was present (decision 4). For dry-run, always `false`. |
| `would`                     | object   | dry-run only   | `{ method, path, body: {} }`                                                       |

### 2.4 Validation rules

- `<id>` must be a positive integer. Rejected via `ValidationError` (exit 2) — not Commander's `InvalidArgumentError` (calibration §1-2).
- `--at` must parse via `parseIsoTimestampFlag('--at', ...)` — same RFC 3339 / ISO 8601 / bare-date acceptance + 60 s clock-skew clamp as R19.5.
- `--at` is **required** on `set`; missing → `ValidationError` (exit 2). Surfaced explicitly because Commander's "missing required option" message routes through stderr without our envelope.
- `set` does not accept `--yes` (non-destructive); the global `--yes` is silently ignored on this leaf.
- `clear` does not accept `--at` (no body).

### 2.5 Confirmation policy (`clear` only — `set` skips entirely)

Mirrors R13 `tasks delete` byte-for-byte for the single-id flow:

- `--yes` → unconditional proceed.
- `--dry-run` → unconditional proceed (no destructive effect).
- TTY without `--yes` → prompt: `"Clear reminder on task #<id>?"`. Decline → `ConfirmationError` (exit 2).
- Non-TTY without `--yes` → throw `ConfirmationError` (exit 2) immediately (fail closed).

Single-id only, so `confirmDestructive` is called once per invocation, not aggregated across N ids.

### 2.6 Idempotency (`clear`)

The server returns 200 even when no reminder exists (yaml :2125). The HTTP path is therefore not the signal — we cannot distinguish "had a reminder, deleted it" from "had no reminder, no-op" by status alone. Decision 4 below resolves this: `already_in_target_state` is **always `false`** on the live path because the server's `SuccessResponse` does not distinguish the two cases. A defensive 404 catch maps to `already_in_target_state: true` for forward-compat (in case Freelo tightens the endpoint). Dry-run is always `false` (no wire call happened).

This is honest about the wire ambiguity; agents reading the envelope see what we know, not what we'd like to assume.

### 2.7 Dry-run behavior

Both leaves support `--dry-run`. In dry-run mode:

- No wire call.
- Envelope carries `dry_run: true`.
- `data.would.method`, `data.would.path`, `data.would.body` echo what would have been sent.
- For `set`: `would.body = { remind_at: <canonical UTC> }`; `data.remind_at` echoes the canonical input; `data.task_name` is omitted (no server response to draw from).
- For `clear`: `would.body = {}`; `data.already_in_target_state = false`.

### 2.8 Help text

```
Usage: freelo tasks remind [options] [command]

Manage your personal reminder on a task. Reminders are per-user — they only ping you, not other workers on the task.

Commands:
  set <id>      Schedule (or overwrite) your personal reminder for a task.
  clear <id>    Remove your personal reminder for a task.

Options for `set`:
  --at <iso>    UTC ISO 8601 timestamp when the reminder should fire (required).
                Accepts dates with timezone offsets and bare YYYY-MM-DD; normalized to UTC.
  --dry-run     Skip the POST; envelope echoes the body that would have been sent.

Options for `clear`:
  --yes         Bypass the confirmation prompt (required in non-TTY mode).
  --dry-run     Skip the DELETE; envelope echoes the path that would have been called.
```

### 2.9 Examples

```bash
# Set a reminder at 09:00 UTC tomorrow:
$ freelo tasks remind set 4567 --at 2026-05-10T09:00:00Z --output json
{"schema":"freelo.tasks.remind.set/v1","data":{"task_id":4567,"task_name":"Review PR","remind_at":"2026-05-10T09:00:00Z"}}

# Local-time input is normalized to UTC on the wire:
$ freelo tasks remind set 4567 --at 2026-05-10T11:00:00+02:00 --dry-run --output json
{"schema":"freelo.tasks.remind.set/v1","dry_run":true,"data":{"task_id":4567,"remind_at":"2026-05-10T09:00:00Z","would":{"method":"POST","path":"/task/4567/reminder","body":{"remind_at":"2026-05-10T09:00:00Z"}}}}

# Clear a reminder (TTY, prompts):
$ freelo tasks remind clear 4567
? Clear reminder on task #4567? (y/N) y
{"schema":"freelo.tasks.remind.clear/v1","data":{"task_id":4567,"already_in_target_state":false}}

# Clear a reminder (agent-style):
$ freelo tasks remind clear 4567 --yes --output json
{"schema":"freelo.tasks.remind.clear/v1","data":{"task_id":4567,"already_in_target_state":false}}

# Validation: missing --at on set:
$ freelo tasks remind set 4567
# stderr: { "schema":"freelo.error/v1", "error": { "code":"VALIDATION_ERROR", ... } }
# exit 2

# Validation: --at in the future:
$ freelo tasks remind set 4567 --at 2099-01-01T00:00:00Z
# stderr: VALIDATION_ERROR — too far in the future. exit 2.

# But a near-future is the normal use case:
$ freelo tasks remind set 4567 --at $(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)
# OK — server accepts; live envelope returned.
```

Wait — `--at` must be a *future* time for a reminder to be useful. The R19.5 helper rejects futures. **This is a contradiction.** See decision 2 below for resolution.

## 3. Data model

### 3.1 New file: `src/api/schemas/task-reminder.ts`

```ts
import { z } from 'zod';

/**
 * `POST /task/{task_id}/reminder` response (yaml :2098-2115).
 *
 * `task` is documented as a thin reference object; `id` is documented as
 * required, `name` is optional in spirit (yaml :2114 lists it without
 * `required:`). Apply the project-wide `.passthrough()` + nullable.optional
 * convention.
 */
export const SetReminderResponseSchema = z
  .object({
    remind_at: z.string(),
    task: z
      .object({
        id: z.number().int(),
        name: z.string().nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type SetReminderResponse = z.infer<typeof SetReminderResponseSchema>;

/**
 * `DELETE /task/{task_id}/reminder` response (yaml :2129-2135) — generic
 * `SuccessResponse`. Same shape we use in `tasks-delete.ts`.
 */
export const ClearReminderResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();

/* ---- envelope `data` types -------------------------------------------- */

export type RemindWould = {
  method: 'POST' | 'DELETE';
  path: string;
  body: Record<string, unknown>;
};

export type TasksRemindSetData = {
  task_id: number;
  task_name?: string | null;
  remind_at: string;
  would?: RemindWould;
};

export type TasksRemindClearData = {
  task_id: number;
  already_in_target_state: boolean;
  would?: RemindWould;
};
```

### 3.2 New file: `src/api/tasks-reminder.ts`

Two thin wrappers + path helpers, mirroring `src/api/tasks-delete.ts`:

```ts
import { type ApiResponse, type HttpClient } from './client.js';
import {
  ClearReminderResponseSchema,
  SetReminderResponseSchema,
  type SetReminderResponse,
} from './schemas/task-reminder.js';

export type SetReminderOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type SetReminderResult = {
  raw: ApiResponse<SetReminderResponse>;
  body: SetReminderResponse;
};

export type ClearReminderResult = {
  raw: ApiResponse<unknown>;
};

export function reminderPath(taskId: number): string {
  return `/task/${taskId}/reminder`;
}

export async function setReminder(
  client: HttpClient,
  taskId: number,
  remindAt: string,
  opts: SetReminderOpts = {},
): Promise<SetReminderResult> {
  const raw = await client.request({
    method: 'POST',
    path: reminderPath(taskId),
    body: { remind_at: remindAt },
    schema: SetReminderResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

export async function clearReminder(
  client: HttpClient,
  taskId: number,
  opts: SetReminderOpts = {},
): Promise<ClearReminderResult> {
  const raw = await client.request({
    method: 'DELETE',
    path: reminderPath(taskId),
    schema: ClearReminderResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}
```

### 3.3 New files: `src/commands/tasks/remind.ts` (parent), `src/commands/tasks/remind/set.ts`, `src/commands/tasks/remind/clear.ts`

Mirror the `tasks/description` shape exactly. Parent has no `meta`/action; leaves do.

### 3.4 New files: `src/ui/human/tasks-remind-set.ts`, `src/ui/human/tasks-remind-clear.ts`

One-line human-mode renderers (TTY mode):

```
Reminder set on task #4567 ("Review PR") for 2026-05-10T09:00:00Z.
Reminder cleared on task #4567.
Reminder on task #4567 was already cleared.   # if already_in_target_state
```

### 3.5 New file: `src/lib/iso-timestamp-future.ts`

**Decision 2 (resolution of the contradiction noted above):** R35 `--at` must accept *future* times — that's the whole point of a reminder. The R19.5 helper rejects futures (it was tailored to backdating start times). Solution: a thin sibling parser, `parseIsoTimestampFutureFlag`, that uses the same canonicalization but **inverts the clock-skew direction**: rejects timestamps more than 60 s **in the past**, accepts arbitrary futures.

```ts
import { ValidationError } from '../errors/validation-error.js';
import { ISO_TIMESTAMP_FUTURE_SKEW_MS } from './iso-timestamp.js';

/**
 * Sibling of `parseIsoTimestampFlag` for *future* timestamps (reminders, etc.).
 * Same RFC 3339 / ISO 8601 acceptance + canonicalization to second-precision
 * UTC. Rejects values more than 60 s **in the past** (clock-skew clamp,
 * inverted from the backdating helper).
 */
export function parseIsoTimestampFutureFlag(
  label: string,
  raw: string,
  now: number = Date.now(),
): string {
  const t = Date.parse(raw);
  if (Number.isNaN(t)) {
    throw new ValidationError(`${label} must be an ISO 8601 / RFC 3339 timestamp.`, {
      hintNext: `Use ISO 8601 in UTC, e.g. ${label} YYYY-MM-DDTHH:MM:SSZ.`,
    });
  }
  if (now - t > ISO_TIMESTAMP_FUTURE_SKEW_MS) {
    throw new ValidationError(`${label} is in the past.`, {
      hintNext: `Use a UTC ISO 8601 timestamp in the future, e.g. ${label} YYYY-MM-DDTHH:MM:SSZ. Reminders only make sense for upcoming instants.`,
    });
  }
  const iso = new Date(t).toISOString();
  return `${iso.slice(0, 19)}Z`;
}
```

The 60 s past-tolerance window keeps "set this for the soonest moment" workflows working (NTP drift / handoff lag).

## 4. Edge cases

| edge case                                                  | handling                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `set --at 2026-05-10T09:00:00Z` (future UTC)               | OK; sent as-is on the wire                                                        |
| `set --at 2026-05-10T11:00:00+02:00` (offset)              | Normalized to `2026-05-10T09:00:00Z` on the wire                                  |
| `set --at 2026-05-10` (date-only)                          | Treated as `2026-05-10T00:00:00Z` — likely past if today is later in 2026-05-10; rejected by clock-skew clamp accordingly |
| `set --at <past>` (>60 s ago)                              | `ValidationError` exit 2 with past-clamp hint                                     |
| `set --at <within 60 s past>`                              | Accepted (server-side decides if it fires immediately or rejects)                 |
| `set --at <empty>`                                         | `ValidationError` exit 2 (parser rejects empty string)                            |
| `set` without `--at`                                       | `ValidationError` exit 2 — `--at` is required (decision 3)                        |
| `set <id>` with non-numeric `<id>`                         | `ValidationError` exit 2 (calibration §2)                                         |
| `set` + 401 / 5xx                                          | `FreeloApiError` / `NetworkError` — top-level handler emits `freelo.error/v1`   |
| `set` + 404 (task not found)                               | `FreeloApiError` exit 4 (`code: 'NOT_FOUND'`)                                     |
| `set` + `--dry-run`                                        | No wire call; envelope `dry_run: true`; `data.would.body.remind_at` carries canonical UTC |
| `clear <id>`                                               | DELETE; `already_in_target_state: false` (we cannot distinguish — see §2.6)       |
| `clear` + 404 (defensive future-proof)                     | Re-classify as `already_in_target_state: true` (mirrors R13 §3.4)                |
| `clear` + non-TTY without `--yes`                          | `ConfirmationError` exit 2 immediately, no DELETE                                 |
| `clear` + TTY without `--yes`, user declines               | `ConfirmationError` exit 2, no DELETE                                             |
| `clear` + TTY without `--yes`, user accepts                | DELETE proceeds                                                                   |
| `clear` + `--yes`                                          | DELETE proceeds, no prompt                                                        |
| `clear` + `--dry-run`                                      | No DELETE, no prompt; envelope `dry_run: true`                                    |
| `--at` with fractional seconds (`.500Z`)                   | Stripped during canonicalization (second precision)                               |
| Set called twice on the same task                          | Server overwrites silently (yaml :2081 — upsert); CLI envelope shape identical    |
| Server response missing `task.name`                        | `task_name: null` (schema is nullable.optional)                                   |

## 5. Non-goals

- **No batch (`--ids` / `--stdin`).** Single-id v1; revisit as R35.5 if demand.
- **No reminder-listing.** No documented `GET /task/{task_id}/reminder` exists in `docs/api/freelo-api.yaml`. To inspect, use `freelo tasks show <id> --output json` and look for `caller_reminder` if Freelo surfaces it (out of scope here).
- **No envelope changes elsewhere.** No bumps to `freelo.tasks.show/v1`; no reminder field added to existing envelopes.
- **No `--note` flag on `set`.** Freelo's POST body schema documents only `remind_at` (yaml :2086-2097). We do not invent fields.
- **No introspect golden update.** Verified by grep — `tasks` is in the golden, but the golden snapshots only specific subtrees. A fresh introspect run will be regenerated by `pnpm fix:readme` if the README autogen needs it.

## 6. Open questions

None. All decisions resolved in §7.

## 7. Decisions made autonomously

### Decision 1 — Reuse `parseIsoTimestampFlag` infrastructure, not the helper itself

**Question:** Should `set --at` reuse `parseIsoTimestampFlag` (from R19.5) directly?

**Decision:** No. Introduce a sibling helper `parseIsoTimestampFutureFlag` in a new file `src/lib/iso-timestamp-future.ts`. Both helpers share the same canonicalization rule (UTC second-precision); the only difference is the clock-skew clamp direction.

**Alternatives considered:**
- Reuse `parseIsoTimestampFlag` as-is → rejected; it rejects futures, which is exactly the input we need.
- Add a `direction: 'past' | 'future' | 'any'` parameter to the existing helper → rejected; widens the existing surface (used by R19.5 only) and mixes responsibilities.
- Pass `now = Number.POSITIVE_INFINITY` to bypass the clamp → rejected; loses the clamp entirely (we still want a *past* clamp here, just inverted).
- Validate after canonicalization in the command layer → rejected; spreads parsing logic across two locations, weakens the "Commander parser handles validation" pattern.

**Rationale:** Two narrow, single-direction helpers are clearer than one bidirectional helper with a mode flag. The shared canonicalization (`new Date(t).toISOString().slice(0, 19) + 'Z'`) is a few lines of duplication — acceptable cost for clarity. The shared `ISO_TIMESTAMP_FUTURE_SKEW_MS` constant is exported and reused. If a third direction surfaces (e.g. "any"), refactor to a single helper at that point, not before.

### Decision 2 — 60 s past-skew clamp on `--at` (mirrors R19.5's 60 s future clamp)

**Question:** What's N in "refuse `--at` more than N seconds in the past"?

**Decision:** 60 seconds.

**Alternatives considered:**
- 0 seconds (strict) → rejected; harmless clock skew between machines + sub-minute event handoff lag (e.g. CI runner takes 30 s to fire).
- 5 minutes → rejected; too lenient; a 5-min-past reminder is almost certainly a typo.
- No clamp at all → rejected; lets users send obvious mistakes like `--at 2020-01-01` to the server.

**Rationale:** Symmetry with R19.5 is the simplest defensible choice — both helpers use a 60 s tolerance window. Server-side will independently reject anything it deems invalid; the clamp is a convenience.

### Decision 3 — `--at` is required on `set` (no nullable / no upsert-without-time)

**Question:** Should `set` allow `--at` to be omitted (and implicitly mean "now"-ish)?

**Decision:** No. `--at` is required.

**Alternatives considered:**
- Allow `set` without `--at` → "now" → rejected; meaningless to set a reminder for "now".
- Allow `set` without `--at` → "tomorrow at 09:00 local" → rejected; magic defaulting; UX surprise.

**Rationale:** A reminder needs a time. Forcing `--at` makes the contract explicit and matches the OpenAPI body's `required: [remind_at]` (yaml :2092-2094). Agents can compose `--at $(date -u -d '+9 hours' +%Y-%m-%dT%H:%M:%SZ)`.

### Decision 4 — `clear` always sets `already_in_target_state: false` on the live path

**Question:** Should the `clear` envelope distinguish "had a reminder, deleted it" from "had no reminder, no-op"?

**Decision:** No. Always `false` on the live success path; `true` only on a defensive 404 catch.

**Alternatives considered:**
- GET pre-check before DELETE to learn the prior state → rejected; double round-trip for marginal info; matches R13 decision 4.
- Parse `result: 'success'` vs other body shapes → rejected; the OpenAPI documents `SuccessResponse` for both cases; we'd be inventing a semantic distinction Freelo doesn't make.
- Always set to `true` → rejected; lies; may have actually deleted a real reminder.

**Rationale:** Be honest about what the wire tells us. The server collapses both cases into a single 200; we surface that with `already_in_target_state: false` (we don't know it was already cleared) and let agents decide what to do. The defensive 404 catch keeps us forward-compatible if Freelo tightens the endpoint.

### Decision 5 — Two new envelope schemas (`set/v1`, `clear/v1`), not one combined `tasks.remind/v1`

**Question:** Should `set` and `clear` share an envelope schema?

**Decision:** No. Two separate schemas: `freelo.tasks.remind.set/v1` and `freelo.tasks.remind.clear/v1`.

**Alternatives considered:**
- Single `freelo.tasks.remind/v1` with a discriminator field (`action: 'set' | 'clear'`) → rejected; mixes schemas with different shapes (`set` has `remind_at`, `clear` doesn't).
- Reuse `freelo.tasks.edit/v1` since reminders are conceptually a task edit → rejected; reminders are a separate Freelo resource (separate endpoint), not a task field.

**Rationale:** Mirrors `tasks.description.get/v1` vs `tasks.description.set/v1` precedent (R15). Each leaf gets its own schema. Clear discriminator: schema name itself.

### Decision 6 — Single-id v1; no batch in this slice

**Question:** Should `set` / `clear` support batch input (`--ids` / `--stdin`)?

**Decision:** No. Single-id only.

**Alternatives considered:**
- Mirror `tasks delete` (R13) batch shape → rejected for `set`; per-row `--at` would force NDJSON anyway, doubling complexity.
- Ship `clear --ids` / `--stdin` only → rejected; asymmetric surface across the two siblings is a UX surprise.

**Rationale:** Keep the slice small and landable. Roadmap line for R35 is single-id; batch is not asked for. If demand emerges, R35.5 can add NDJSON-batch with clear semantics for both leaves at once.

### Decision 7 — `clear` confirmation message uses `task #<id>`, no name lookup

**Question:** Should the confirmation prompt include the task name (requires a GET pre-check) or just the id?

**Decision:** Just the id: `"Clear reminder on task #<id>?"`.

**Alternatives considered:**
- Pre-fetch `tasks show <id>` to populate the name → rejected; double round-trip on a destructive path; matches R13 decision 4.
- Generic prompt without the id → rejected; the id is critical context for the user.

**Rationale:** Mirror R13's "Delete N tasks?" precedent — terse, informative, no extra round-trip. Agents bypassing with `--yes` never see the prompt.

## Plan

### Branch

`feat/tasks-remind` (from `main`).

### Files to create

| Path                                                    | Intent                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| `src/lib/iso-timestamp-future.ts`                       | `parseIsoTimestampFutureFlag(label, raw, now?)` — sibling of R19.5 helper, rejects past >60 s. |
| `src/api/schemas/task-reminder.ts`                      | Zod response schemas for set/clear + envelope `data` types.          |
| `src/api/tasks-reminder.ts`                             | `setReminder()` / `clearReminder()` / `reminderPath()` wire wrappers. |
| `src/commands/tasks/remind.ts`                          | Parent `tasks remind` subcommand registrar.                          |
| `src/commands/tasks/remind/set.ts`                      | `tasks remind set <id> --at <ISO> [--dry-run]` leaf.                |
| `src/commands/tasks/remind/clear.ts`                    | `tasks remind clear <id> [--yes] [--dry-run]` leaf (destructive).    |
| `src/ui/human/tasks-remind-set.ts`                      | Human-mode renderer for `set`.                                       |
| `src/ui/human/tasks-remind-clear.ts`                    | Human-mode renderer for `clear`.                                     |
| `test/lib/iso-timestamp-future.test.ts`                 | Unit tests for the new helper (mirror `iso-timestamp.test.ts`).      |
| `test/commands/tasks/remind-set.test.ts`                | Integration tests for `tasks remind set` (MSW).                      |
| `test/commands/tasks/remind-clear.test.ts`              | Integration tests for `tasks remind clear` (MSW + confirm helper).  |
| `docs/commands/tasks-remind.md`                         | User-facing docs for both leaves.                                    |
| `.changeset/r35-tasks-remind.md`                        | `freelo-cli: minor` — new subcommands.                              |

### Files to modify

| Path                              | Change                                                                  |
| --------------------------------- | ----------------------------------------------------------------------- |
| `src/commands/tasks.ts`           | Import + call `registerRemind`.                                         |
| `README.md`                       | Autogen Commands block — regenerate via `pnpm fix:readme`.              |

### Files NOT modified

- `src/lib/iso-timestamp.ts` — only the `ISO_TIMESTAMP_FUTURE_SKEW_MS` export is reused; helper itself unchanged.
- `src/api/schemas/task.ts` — no envelope shape change.
- `test/fixtures/introspect-golden.json` — verify by grep that `remind` isn't in the golden's locked subset; if it is, regenerate.

### New runtime dependencies

**None.** All needed primitives present.

### Test strategy

#### Unit tests (`test/lib/iso-timestamp-future.test.ts`) — new

- Accepts `2099-01-01T00:00:00Z` (future) → `2099-01-01T00:00:00Z`.
- Accepts `2099-01-01T01:00:00+02:00` → `2098-12-31T23:00:00Z` (UTC normalize).
- Accepts `now + 1 hour` → canonical UTC (deterministic via injected `now`).
- Accepts `now + 30s` (within tolerance, but in future) — passes.
- Accepts `now - 30s` (within 60 s past tolerance) — passes.
- Rejects `now - 61s` → `ValidationError` "in the past".
- Rejects `1970-01-01T00:00:00Z` (far past) → `ValidationError`.
- Rejects `not a date` → `ValidationError`.
- Rejects empty string → `ValidationError`.
- Rejects `2099-01-01T00:00:00.500Z` is **not** rejected — millis stripped, value still future.
- Custom `label` propagates into error message + hint.

#### Integration tests (`test/commands/tasks/remind-set.test.ts`) — new

Use MSW to mock `POST /task/4567/reminder`. Mirror the `tasks/edit.test.ts` shape.

- **Happy path live**: `set 4567 --at 2099-01-01T09:00:00Z` →
  - exit 0
  - wire body captured: `{ remind_at: '2099-01-01T09:00:00Z' }`
  - envelope `freelo.tasks.remind.set/v1`: `{ task_id: 4567, task_name: 'Review PR', remind_at: '2099-01-01T09:00:00Z' }`
- **UTC normalization**: `--at 2099-01-01T11:00:00+02:00` → wire body's `remind_at = 2099-01-01T09:00:00Z`.
- **Dry-run**: `--at 2099-01-01T09:00:00Z --dry-run` →
  - exit 0, no wire call, envelope `dry_run: true`, `data.would.body.remind_at = '2099-01-01T09:00:00Z'`.
- **Validation: malformed `--at`** → exit 2.
- **Validation: empty `--at`** → exit 2.
- **Validation: `--at` in the past** → exit 2.
- **Validation: missing `--at`** → exit 2 (Commander's required-option mapped to ValidationError).
- **Validation: non-numeric `<id>`** → exit 2.
- **HTTP error: 404** → exit 4 (`FreeloApiError` `NOT_FOUND`).
- **HTTP error: 401** → exit 4.
- **HTTP error: 500** → exit 4.
- **Server response missing `task.name`** → envelope `task_name: null`.

#### Integration tests (`test/commands/tasks/remind-clear.test.ts`) — new

Use MSW to mock `DELETE /task/4567/reminder`. Mirror the `tasks/delete.test.ts` shape.

- **Happy path live + `--yes`**: `clear 4567 --yes` → exit 0, envelope `{ task_id: 4567, already_in_target_state: false }`.
- **Dry-run**: `clear 4567 --dry-run` → no wire call, envelope `dry_run: true`, `would.method = 'DELETE'`, `would.body = {}`.
- **Non-TTY without `--yes`** → exit 2 `CONFIRMATION_REQUIRED`, no wire call. (Calibration §7: clear `CI` env, spoof `isTTY = false`.)
- **TTY accepts** → exit 0; `confirmDestructive` gets `isInteractive: () => true`, prompt mock returns `true`.
- **TTY declines** → exit 2 `CONFIRMATION_REQUIRED`. (Calibration §7: clear `CI`, spoof `isTTY = true`, mock `confirm` to return `false`.)
- **Defensive 404 → idempotent** → exit 0, `already_in_target_state: true`.
- **Validation: non-numeric `<id>`** → exit 2.
- **HTTP error: 401** → exit 4.
- **HTTP error: 500** → exit 4.

#### Coverage callouts

- Calibration §1 — full test phase before commit.
- Calibration §2 — every error-class path has an explicit `exitCode` assertion: `ValidationError` (2), `ConfirmationError` (2), `FreeloApiError` (4).
- Calibration §3 — five-gate before push.
- Calibration §4 — the only new `try/catch` is in `clear.ts` (defensive 404 → already-cleared); covered by mandatory test.
- Calibration §7 — TTY-prompt tests in `remind-clear.test.ts` clear `CI` env around the test body.

#### Five-gate before push

`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme` must all pass on the committed tree before `git push -u`.

### Rollout

Single landable slice. Squash on PR merge:

`feat(commands): tasks remind set / clear (R35)`
