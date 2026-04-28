# Spec 0030 — `freelo time start` / `time status`

**Status:** Draft
**Owner:** orchestrator (run `2026-04-28-1628-r19-time-start-status`)
**Roadmap:** R19
**Date:** 2026-04-28

## 1. Problem

Wave 3 of the roadmap brings collaboration to the CLI. Time-tracking is the second sub-thread, after comments. Today an agent or human who wants to start a timer or check whether one is running has to leave the terminal and use the Freelo web UI. The Freelo public API exposes a clean three-endpoint singleton-per-user flow:

- `POST /timetracking/start` — start a session (max one per user).
- `POST /timetracking/stop` — stop and convert to a work report (R20).
- `GET /timetracking/status` — read the active session, returning HTTP **204 No Content** when no timer is running.

This slice ships **start** and **status**. It is the **first slice in Wave 3's time-tracking sub-thread** and the **first command under a new top-level `time` resource**. Two subcommands ship together because `status` is the natural pair of `start` for an agent verifying state before issuing the start; shipping them separately would force a no-value gap where users could start but not check.

The roadmap explicitly calls out the "already tracking X since Y" failure mode as the ship condition: when a user attempts a second start while a timer is already running, the API returns **HTTP 409** with body `"Timetracking is already running."` (yaml :2742, :2773-2778). The CLI must surface this as a typed `FreeloApiError` with a friendly hint pointing at `time stop` / `time edit` (R20) — agents must be able to branch on this without parsing free-text. `time status` is the verify-before-start companion.

## 2. Proposal

### 2.1 CLI surface

```
# Start a timer (singleton per user). --task is optional — Freelo permits
# task-less general work. --note is the optional free-form note.
freelo time start [--task <id>] [--note <str>] [--dry-run]

# Read the current timer state.
freelo time status
```

**No batch / no `--ids` / no `--stdin`** for either command. Justification (decision 5):

- `time start` is **singleton per user** by API contract — only one in-flight start per user account, period. A batch invocation could not produce more than one successful start; the second would 409. Batch input is therefore semantically meaningless and is rejected at the spec level (no precedent in the CLI for batch-of-1 writes).
- `time status` is a single-resource read of the caller's own session — no id, no list, no batch.

### 2.2 Endpoints

#### `POST /timetracking/start` (yaml :2729-2778)

Request body — all fields **optional**:

```json
{ "task_id": 123, "note": "Investigating bug #4567" }
```

- `task_id`: integer, **nullable** — omit for general work.
- `note`: string, nullable.

Responses:

- **200 OK** — `{ "uuid": "<uuid v4>" }` of the new running-work record.
- **409 Conflict** — `ErrorResponse` body, message `"Timetracking is already running."` This is the singleton enforcement; CLI **must** rewrite the hint here (decision 2).
- 400 / 401 / 404 (task not found) / 5xx — standard `FreeloApiError` paths.

The CLI's `--task` flag maps to the wire `task_id`. `--note` maps to the wire `note`.

#### `GET /timetracking/status` (yaml :2863-2944)

Response **shape branches on HTTP status**:

- **200 OK** — JSON body with the active session:

  ```yaml
  uuid: <uuid>
  date_reported: <ISO 8601>     # session start timestamp
  task:                         # nullable — null when general work
    id: <int>
    name: <string>
    project: { id, name } | null
    tasklist: { id, name } | null
  note: <string|null>
  cost: { ...object... }
  is_cost_fixed: <bool>
  labels: [{ name }]
  is_billable: <bool>
  project_setting: { ... } | null
  ```

- **204 No Content** — no active session. Empty body. CLI **must not** error; emits an envelope with `data.active: false` and exit 0 (decision 3).

The 204 path is the load-bearing UX edge — most user-facing tools botch this by treating "no body" as a network failure.

### 2.3 Output schemas

#### `freelo.time.start/v1`

Live response (`data`):

| field         | type         | always present | notes                                                                |
| ------------- | ------------ | -------------- | -------------------------------------------------------------------- |
| `uuid`        | string       | live only      | server-side UUID of the new running record                           |
| `task_id`     | int \| null  | yes            | echo of the `--task` flag (null when omitted)                        |
| `note`        | string \| null | yes          | echo of the `--note` flag (null when omitted)                        |
| `would`       | object       | dry-run only   | `{ method: 'POST', path: '/timetracking/start', body: {...} }`       |

Top-level envelope: `schema`, `data`, optional `rate_limit`, optional `request_id`. `dry_run: true` on dry-run; absent on live.

#### `freelo.time.status/v1`

`data` is a **discriminated union** keyed on `active`:

When **active** (200 path):

```json
{
  "active": true,
  "session": {
    "uuid": "...",
    "started_at": "<ISO 8601>",
    "elapsed_seconds": <int>,
    "task": { "id": <int>, "name": <str>, "project": {...} | null, "tasklist": {...} | null } | null,
    "note": <string|null>,
    "is_billable": <bool>,
    "is_cost_fixed": <bool>,
    "labels": [{ "name": <str> }],
    "cost": {...passthrough...},
    "project_setting": {...passthrough...} | null
  }
}
```

When **inactive** (204 path):

```json
{ "active": false }
```

Notes on the active shape (decision 4):

- `started_at` is the rename of the wire `date_reported` to a CLI-friendly name. Agents read `started_at`; we keep the wire name internal.
- `elapsed_seconds` is a **derived** integer — the CLI computes `Math.floor((Date.now() - Date.parse(date_reported)) / 1000)` at envelope-build time. This is the "since Y" signal users will branch on. Negative values clamp to 0 (clock skew defense).
- The session block is `.passthrough()` on `cost` and `project_setting` so future Freelo additions don't break validation.
- Top-level `active: true|false` is a literal-typed discriminant — agents `switch` on it without nullish checks.

### 2.4 Singleton-409 hint (the ship condition)

When `POST /timetracking/start` returns 409, the CLI catches `FreeloApiError` (httpStatus 409) **and rewrites `hintNext`** to mention the active session. We do **not** introduce a new error code — `FreeloApiError` already carries `httpStatus` for typed branching, and adding a custom code (`TIMER_ALREADY_RUNNING`) would expand the public error-code surface without enabling any branching that `httpStatus === 409` doesn't already enable (decision 1).

**Friendly copy** (per the roadmap's "already tracking X since Y" wording): the rewriter performs a single follow-up `GET /timetracking/status` call so the hint can name the active task and start time. This is opportunistic — if the follow-up fails, the rewriter falls back to the generic copy (decision 2). The follow-up is not retried and uses the same client.

Hint formats:

- With session context (status 200 follow-up succeeded):
  > `A time tracking session is already running (started <ISO> on task #<id> "<name>"). Use \`freelo time stop\` to finalize it as a work report, or \`freelo time edit\` to reassign the task / note (R20).`
- Without session context (follow-up failed):
  > `A time tracking session is already running for your account. Use \`freelo time stop\` to finalize it, or \`freelo time edit\` to reassign the task / note (R20).`

The 409 still maps to exit code **4** (`FREELO_API_ERROR`) per the existing taxonomy. The hint is the only delta. R20 will validate this hint copy aligns with the actual `stop` / `edit` UX.

### 2.5 204 No Content — client extension

The shared `HttpClient.request` always calls `response.json()` on 2xx, which throws on a 204 empty body. Today no command needs 204 — `time status` is the first.

**Minimal, surgical extension:** in `src/api/client.ts`, when `response.status === 204`, **skip the JSON parse** and feed `null` to the supplied schema. The schema for the status call will accept `null` as the "inactive" shape and any object as the "active" shape, then transform to the discriminated-union output type.

This is additive — no existing caller passes a schema that accepts `null`, so no behavior changes for any existing command. It does NOT touch auth, retry, redirect, rate-limit, or 4xx/5xx logic. Yellow tier preserved (decision 6).

### 2.6 Examples

```
# Agent — start a timer, --output json, no prompts:
$ FREELO_EMAIL=me@x FREELO_API_KEY=... freelo time start --task 4567 --note "WIP" --output json
{"schema":"freelo.time.start/v1","data":{"uuid":"f...","task_id":4567,"note":"WIP"},"rate_limit":{...}}

# Agent — verify state:
$ freelo time status --output json
{"schema":"freelo.time.status/v1","data":{"active":true,"session":{"uuid":"...","started_at":"2026-04-28T14:02:11Z","elapsed_seconds":1738,"task":{"id":4567,"name":"Investigate bug","project":{"id":11,"name":"Web"},"tasklist":{"id":22,"name":"Backend"}},"note":"WIP","is_billable":true,...}}}

# Inactive:
$ freelo time status --output json
{"schema":"freelo.time.status/v1","data":{"active":false}}

# Singleton conflict (409 → friendly hint):
$ freelo time start --task 4567 --output json
{"schema":"freelo.error/v1","error":{"code":"FREELO_API_ERROR","message":"...","http_status":409,"hint_next":"A time tracking session is already running (started 2026-04-28T14:02:11Z on task #4567 \"Investigate bug\"). Use `freelo time stop` ...","retryable":false}}
# exit code: 4

# Dry-run:
$ freelo time start --task 4567 --note hi --dry-run --output json
{"schema":"freelo.time.start/v1","data":{"task_id":4567,"note":"hi","would":{"method":"POST","path":"/timetracking/start","body":{"task_id":4567,"note":"hi"}}},"dry_run":true}
```

## 3. Data model

### 3.1 New file: `src/api/schemas/time.ts`

```ts
import { z } from 'zod';

// Wire → live (200) — passthrough on the loose substructures so we stay
// forward-compatible with future Freelo fields.
const TimeProjectRefSchema = z.object({
  id: z.number().int(),
  name: z.string().nullable().optional(),
}).passthrough();

const TimeTasklistRefSchema = z.object({
  id: z.number().int(),
  name: z.string().nullable().optional(),
}).passthrough();

const TimeTaskRefSchema = z.object({
  id: z.number().int(),
  name: z.string().nullable().optional(),
  project: TimeProjectRefSchema.nullable().optional(),
  tasklist: TimeTasklistRefSchema.nullable().optional(),
}).passthrough();

const TimeLabelSchema = z.object({
  name: z.string(),
}).passthrough();

export const TimeStatusActiveWireSchema = z.object({
  uuid: z.string(),
  date_reported: z.string(),
  task: TimeTaskRefSchema.nullable().optional(),
  note: z.string().nullable().optional(),
  cost: z.unknown().optional(),
  is_cost_fixed: z.boolean().optional(),
  labels: z.array(TimeLabelSchema).optional(),
  is_billable: z.boolean().optional(),
  project_setting: z.unknown().nullable().optional(),
}).passthrough();
export type TimeStatusActiveWire = z.infer<typeof TimeStatusActiveWireSchema>;

// Discriminated union: `null` = 204 inactive; object = 200 active.
export const TimeStatusWireSchema = z.union([z.null(), TimeStatusActiveWireSchema]);
export type TimeStatusWire = z.infer<typeof TimeStatusWireSchema>;

// `freelo.time.start/v1` envelope `data` — live shape (no `would`).
export const TimeStartLiveDataSchema = z.object({
  uuid: z.string(),
  task_id: z.number().int().nullable(),
  note: z.string().nullable(),
});
export type TimeStartLiveData = z.infer<typeof TimeStartLiveDataSchema>;

// Dry-run shape (no `uuid`).
export const TimeStartDryRunDataSchema = z.object({
  task_id: z.number().int().nullable(),
  note: z.string().nullable(),
});
export type TimeStartDryRunData = z.infer<typeof TimeStartDryRunDataSchema>;

// Wire response for POST /timetracking/start success.
export const TimeStartResponseSchema = z.object({
  uuid: z.string(),
}).passthrough();
export type TimeStartResponse = z.infer<typeof TimeStartResponseSchema>;

// `freelo.time.status/v1` envelope `data` — discriminated union.
const TimeStatusSessionSchema = z.object({
  uuid: z.string(),
  started_at: z.string(),
  elapsed_seconds: z.number().int().nonnegative(),
  task: z.object({
    id: z.number().int(),
    name: z.string().nullable(),
    project: z.object({ id: z.number().int(), name: z.string().nullable() }).nullable(),
    tasklist: z.object({ id: z.number().int(), name: z.string().nullable() }).nullable(),
  }).nullable(),
  note: z.string().nullable(),
  is_billable: z.boolean(),
  is_cost_fixed: z.boolean(),
  labels: z.array(z.object({ name: z.string() })),
  cost: z.unknown(),
  project_setting: z.unknown().nullable(),
});

export const TimeStatusDataSchema = z.discriminatedUnion('active', [
  z.object({ active: z.literal(true), session: TimeStatusSessionSchema }),
  z.object({ active: z.literal(false) }),
]);
export type TimeStatusData = z.infer<typeof TimeStatusDataSchema>;
```

### 3.2 New file: `src/api/time.ts`

```ts
import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';
import {
  TimeStartResponseSchema,
  TimeStatusWireSchema,
  type TimeStartResponse,
  type TimeStatusWire,
} from './schemas/time.js';

export type FetchOpts = { signal?: AbortSignal; requestId?: string };

export type StartTimerBody = {
  task_id?: number | null;
  note?: string | null;
};

export type StartTimerOpts = FetchOpts & { body: StartTimerBody };

export type StartTimerResult = {
  response: TimeStartResponse;
  raw: ApiResponse<TimeStartResponse>;
};

export const START_TIMER_PATH = '/timetracking/start';
export const TIMER_STATUS_PATH = '/timetracking/status';

export async function startTimer(
  client: HttpClient,
  opts: StartTimerOpts,
): Promise<StartTimerResult> {
  const raw = await client.request({
    method: 'POST',
    path: START_TIMER_PATH,
    body: opts.body,
    schema: TimeStartResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { response: raw.data, raw };
}

export type GetTimerStatusOpts = FetchOpts;

export type GetTimerStatusResult = {
  status: TimeStatusWire;     // null when 204
  raw: ApiResponse<TimeStatusWire>;
};

export async function getTimerStatus(
  client: HttpClient,
  opts: GetTimerStatusOpts = {},
): Promise<GetTimerStatusResult> {
  const raw = await client.request({
    method: 'GET',
    path: TIMER_STATUS_PATH,
    schema: TimeStatusWireSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { status: raw.data, raw };
}

export function buildStartTimerBody(input: { taskId?: number; note?: string }): StartTimerBody {
  const body: StartTimerBody = {};
  if (input.taskId !== undefined) body.task_id = input.taskId;
  if (input.note !== undefined) body.note = input.note;
  return body;
}
```

### 3.3 Client extension (additive)

In `src/api/client.ts`, immediately before the 2xx JSON parse:

```ts
// 204 No Content — feed null to the schema. (R19, spec 0030 §2.5.)
if (response.status === 204) {
  const parsed = schema.safeParse(null);
  if (!parsed.success) {
    throw new FreeloApiError(
      `Unexpected 204 No Content from ${method} ${path}: ${parsed.error.message}`,
      'VALIDATION_ERROR',
      { ...(requestId !== undefined ? { requestId } : {}) },
    );
  }
  return { data: parsed.data as z.output<S>, rateLimit, requestId: requestId ?? '' };
}
```

This is the only diff to `client.ts`. Existing tests stay green because no current schema accepts `null`. A regression test in `test/api/client.204.test.ts` covers the new branch.

## 4. Edge cases

| edge case                                              | handling                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Singleton 409 on second start                          | Hint rewriter (§2.4) does opportunistic `GET /status` to enrich `hintNext`; falls back if status fails |
| 204 on `time status` (no active timer)                 | Envelope `data.active: false`, exit 0                                                                  |
| `--task` non-integer / zero / negative                 | `ValidationError`, exit 2                                                                              |
| `--task` not found (404)                               | `FreeloApiError`, exit 4, hint `"Task <id> not found, or your account does not have access to it."`    |
| `--note` empty string                                  | Sent as-is — Freelo accepts empty notes (no client-side rejection)                                     |
| Both `--task` and `--note` omitted                     | Allowed — Freelo permits taskless general-work timers (yaml :2756)                                     |
| `--dry-run` with `--task` and `--note`                 | Skip POST; envelope echoes `would.body = { task_id, note }`                                            |
| 401 on either command                                  | `FreeloApiError`, exit 3 (auth) — standard taxonomy                                                    |
| 5xx on either command                                  | `FreeloApiError`, exit 4 — standard taxonomy                                                           |
| Network error                                          | `NetworkError`, exit 5                                                                                 |
| Rate-limit 429 on POST                                 | `RateLimitedError`, exit 6 (writes don't auto-retry)                                                   |
| Clock skew makes `elapsed_seconds` negative            | Clamp to 0 in envelope builder                                                                         |
| `date_reported` malformed ISO                          | `Date.parse` returns NaN → emit `elapsed_seconds: 0` (defensive — server contract guarantees ISO)      |

## 5. Non-goals

- `time stop`, `time edit` — R20.
- Work-report listing (`reports list`) — R21.
- Work-report logging without timer (`reports log`) — R22.
- Switching the active task mid-session via `time edit` — R20.
- Showing per-project time totals — outside scope.
- Batch start — see §2.1 decision 5.
- A `--watch` mode that polls status — outside the scope of the agent-first contract; agents poll on their own schedule.
- Color/spinner UX — `time status` in human mode prints a single-line summary; no live elapsed clock.

## 6. Open questions

None. Roadmap entry + `freelo-api.yaml` :2729-2944 cover every behavioral edge identified during triage. The only design choice (singleton-409 hint rewriter) is captured in decision 2 (§7).

## 7. Decisions made autonomously

### Decision 1 — No new error code; reuse `FREELO_API_ERROR` + `httpStatus: 409` for the singleton conflict

**Question:** Should the singleton-409 path get its own error code (e.g. `TIMER_ALREADY_RUNNING`)?
**Decision:** No. `FreeloApiError` with `httpStatus: 409` is sufficient for branching; agents already key on `httpStatus` for retryable / not-retryable decisions. Adding a custom code expands the public error-code surface without enabling new branching.
**Alternatives considered:**
- New `TIMER_ALREADY_RUNNING` code on `FreeloApiError` — rejected; adds a one-off public surface.
- New `FreeloDomainError` class — rejected; over-engineered for one case.
**Rationale:** Codebase precedent (R17/R18 hint-rewriter pattern) — rewrite `hintNext`, keep the code stable.

### Decision 2 — Singleton-409 hint enriches with an opportunistic `GET /status` follow-up

**Question:** Should the 409 hint name the active task / start time, requiring a second API call?
**Decision:** Yes — the rewriter does one `GET /timetracking/status` follow-up; if it succeeds (200), it splices the active task name and `started_at` into the hint; if it fails (204 inactive after a 409? unexpected; or 401 / 5xx), the hint falls back to the generic copy.
**Alternatives considered:**
- Static hint, no follow-up — rejected; the roadmap explicitly calls for "already tracking X since Y" copy, which requires the data.
- Force the user to run `time status` themselves — rejected; agents would have to chain calls just to get the hint.
**Rationale:** One extra GET on an error path is cheap; the UX win is significant and the roadmap pinned it as the ship condition.

### Decision 3 — 204 No Content on `time status` is a success envelope, exit 0

**Question:** How to treat a 204 from `GET /timetracking/status`?
**Decision:** Success envelope `{ active: false }`, exit 0.
**Alternatives considered:**
- Treat 204 as a `FreeloApiError` ("no active timer") — rejected; "no timer running" is a normal state, not an error.
- Empty envelope (`data: {}`) — rejected; agents would have to check key absence.
**Rationale:** Discriminated union with literal `active` is the agent-friendly shape; both branches carry the discriminant explicitly.

### Decision 4 — Rename wire `date_reported` → CLI `started_at`; compute `elapsed_seconds` client-side

**Question:** Should the envelope mirror the wire field name `date_reported`, or rename it to `started_at`?
**Decision:** Rename to `started_at`, and add a derived `elapsed_seconds` integer.
**Alternatives considered:**
- Keep wire name `date_reported` — rejected; agents reading the envelope shouldn't have to know Freelo's internal vocabulary.
- Add `elapsed_seconds` to the wire (server-side) — out of scope; not our API.
**Rationale:** `started_at` is the CLI's public contract; we own the envelope shape. `elapsed_seconds` is the field most agents will branch on ("am I tracking for >8h?"); deriving it removes a parsing step.

### Decision 5 — No batch / `--ids` / `--stdin` for `time start` (singleton-per-user precludes it)

**Question:** Should `time start` ship batch input for parity with R09/R11/R13/R18?
**Decision:** No. Document the omission explicitly in the spec.
**Alternatives considered:**
- Ship `--stdin` accepting a single line — rejected; batch-of-1 is API noise without value.
- Ship `--stdin` with all-but-the-first failing — rejected; useless UX and 409-error spam.
**Rationale:** API-level singleton — a successful batch can never have more than one row. Batch input would mislead agents into thinking otherwise.

### Decision 6 — 204 handling lives in `src/api/client.ts` (additive, no defaults change)

**Question:** Where to handle the 204 No Content body?
**Decision:** Extend `client.request` with a `response.status === 204 → schema.safeParse(null)` short-circuit before the 2xx JSON parse.
**Alternatives considered:**
- Bypass `client.request` for `time status` and call `fetch` directly in `src/api/time.ts` — rejected; loses 401/4xx/rate-limit/abort handling.
- Add an `allowEmpty: true` option to `request()` — rejected; YAGNI given no other 204 endpoint in v1 (`docs/api/freelo-api.yaml` grep `204:` returns only `/timetracking/status`).
**Rationale:** The `null`-accepting schema is the natural carrier for "no body"; no existing schema accepts `null`, so the change is fully additive. Tier stays Yellow.

### Decision 7 — `time` parent command lives at `src/commands/time.ts`; subcommands at `src/commands/time/{start,status}.ts`

**Question:** File layout for the new `time` command tree.
**Decision:** Mirror `comments` (R16/R17/R18) precedent: `src/commands/time.ts` re-exports `register(...)`, which composes `registerStart` and `registerStatus` from `src/commands/time/{start,status}.ts`. Each leaf has `meta` for introspect.
**Alternatives considered:**
- Single-file `src/commands/time.ts` with both commands inlined — rejected; doesn't scale to R20 (`stop`, `edit`).
- Subdirectory only (no parent re-export) — rejected; breaks the registration symmetry in `src/bin/freelo.ts`.
**Rationale:** Codebase precedent (`comments`, `subtasks`); R20 will reuse the parent and add `stop` / `edit` siblings.

## Plan

### Branch

`feat/time-start-status` (already created from `main` at HEAD `409a784`).

### Files to create

| Path                                            | Intent                                                                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/schemas/time.ts`                       | Zod schemas: wire shapes (`TimeStartResponseSchema`, `TimeStatusWireSchema`), envelope `data` shapes, derived `elapsed_seconds` computation. |
| `src/api/time.ts`                               | Wire wrappers: `startTimer`, `getTimerStatus`, `buildStartTimerBody`, exported path constants.                                               |
| `src/commands/time.ts`                          | Parent command — wires `registerStart` + `registerStatus` onto root program.                                                                 |
| `src/commands/time/start.ts`                    | Leaf — `--task`, `--note`, `--dry-run`. Calls `startTimer`, rewrites singleton-409 hint via opportunistic `getTimerStatus`.                   |
| `src/commands/time/status.ts`                   | Leaf — no flags. Calls `getTimerStatus`, projects wire shape → discriminated-union envelope.                                                 |
| `src/ui/human/time-start.ts`                    | Human-mode renderer for `time start` (single-line summary).                                                                                  |
| `src/ui/human/time-status.ts`                   | Human-mode renderer for `time status` (active vs. inactive copy).                                                                            |
| `test/api/client.204.test.ts`                   | Regression: client extension for 204 No Content + null-schema parse.                                                                         |
| `test/api/time.test.ts`                         | Unit: `buildStartTimerBody`, `startTimer`, `getTimerStatus` against MSW (200, 204, 409, 401, 404).                                            |
| `test/commands/time-start.test.ts`              | Integration: happy path, `--dry-run`, singleton-409 hint rewriter (with + without status follow-up), missing `--task` (allowed), bad `--task`. |
| `test/commands/time-status.test.ts`             | Integration: 200 active (with task / without task), 204 inactive, 401 auth, `elapsed_seconds` clock-skew clamp.                              |
| `docs/commands/time-start.md`                   | User-facing docs.                                                                                                                            |
| `docs/commands/time-status.md`                  | User-facing docs.                                                                                                                            |
| `.changeset/r19-time-start-status.md`           | Minor changeset.                                                                                                                             |

### Files to modify

| Path                              | Change                                                                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/client.ts`               | Insert 204 short-circuit before 2xx JSON parse (§2.5). Pure addition; no other behavior change.                                               |
| `src/bin/freelo.ts`               | Wire `registerTime` import + call (mirror `registerComments`).                                                                                |
| `src/commands/help.ts`            | If the help command lists known top-level commands, add `time` (likely auto via Commander tree — verify).                                     |
| `README.md`                       | Re-run `pnpm fix:readme` to refresh the autogen Commands block (between markers).                                                             |
| `docs/getting-started.md`         | Add a `time start` / `time status` blurb to the walkthrough — only if the existing doc lists individual commands; otherwise skip (verify).    |

### New runtime dependencies

**None.** All needed primitives (`zod`, `commander`, `undici`, `pino`) are already present.

### Test strategy

#### Unit tests

- `test/api/client.204.test.ts` — drive `HttpClient.request` with an MSW handler that returns 204; assert the schema's `null`-branch is taken; assert error path when schema rejects null.
- `test/api/time.test.ts` — `buildStartTimerBody` (with/without taskId/note); `startTimer` happy path (200 → uuid); `startTimer` 409 (assert raw `FreeloApiError` propagates); `getTimerStatus` 200 → active wire shape; `getTimerStatus` 204 → null.

#### Integration tests (vitest + MSW, command-level)

- `test/commands/time-start.test.ts`:
  - happy path: `--task 4567 --note hi --output json` → envelope shape correct, exit 0.
  - taskless: no flags → envelope `task_id: null, note: null`, exit 0.
  - `--dry-run`: no MSW POST hit; envelope carries `dry_run: true` and `data.would.body`.
  - singleton 409 with status follow-up succeeding: hint mentions `started <ISO> on task #<id> "<name>"`.
  - singleton 409 with status follow-up failing (e.g. 5xx on follow-up): falls back to generic hint.
  - `--task abc` → `ValidationError`, exit 2 (Calibration §1, §2).
  - `--task -3` → `ValidationError`, exit 2.
  - 401 → `FreeloApiError`, exit 3.
  - 5xx → `FreeloApiError`, exit 4.
- `test/commands/time-status.test.ts`:
  - 200 active with task: envelope `data.active: true, data.session.{uuid, started_at, elapsed_seconds, task: {...}}`, exit 0.
  - 200 active without task (general work): `data.session.task: null`.
  - 204 inactive: `data.active: false`, exit 0.
  - 401 → `FreeloApiError`, exit 3.
  - clock-skew (started_at in future) → `elapsed_seconds: 0`.

#### Coverage targets

`src/api/`, `src/commands/` ≥ 90% per `.claude/docs/sdlc.md` Phase 4. `src/api/client.ts` 204 branch covered by `client.204.test.ts`.

#### Calibration callouts

- Calibration §1 — full test phase will run before commit; no shortcuts.
- Calibration §2 — every error-class path has an explicit `exitCode` assertion: `ValidationError` (2), `FreeloApiError` (3, 4), `NetworkError` (5).
- Calibration §3 — gates run on the committed tree before push.
- Calibration §4 — only minor `try/catch` additions in `time/start.ts` (around the singleton-409 follow-up); covered by the two 409-rewriter tests.

### Rollout order

Single landable slice. Conventional Commits squash on the merging PR:

`feat(commands): r19 — freelo time start + time status (POST /timetracking/start, GET /timetracking/status)`

### Decision-log links

- `docs/runs/2026-04-28-1628-r19-time-start-status/triage.md`
- Decisions 1-7 captured in spec §7 above; per-decision files under `docs/decisions/2026-04-28-1628-r19-time-start-status-<n>-<slug>.md` will be written during implement.
