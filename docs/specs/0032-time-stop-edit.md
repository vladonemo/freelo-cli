# Spec 0032 — `freelo time stop` / `time edit`

**Status:** Draft
**Owner:** orchestrator (run `2026-04-28-2100-r20-time-stop-edit`)
**Roadmap:** R20
**Date:** 2026-04-28
**Depends on:** R19 (spec 0030), inherits R19.5 helpers (spec 0031)

## 1. Problem

R19 shipped `freelo time start` / `time status`. Agents and humans can begin tracking and verify state, but they cannot finish or modify a running session — they have to leave the terminal and use the Freelo web UI for the most common time-tracking moves.

R20 closes that gap with the two remaining time-tracking endpoints documented in `docs/api/freelo-api.yaml:2780-2861`:

- `POST /timetracking/stop` — finalize the active session as a **work report** and return it.
- `POST /timetracking/edit` — reassign / re-note the active session in flight (no stop / start cycle).

Both target "the caller's own active session" — there is no session ID; singleton-per-user is the API contract, the same one R19 already absorbed. The 409-on-no-active-session edge mirrors R19's 409-on-already-running edge.

## 2. Proposal

### 2.1 CLI surface

```
# Finalize the active session and return the resulting work report.
freelo time stop [--dry-run]

# Reassign / re-note the active session in flight.
freelo time edit [--task <id>] [--clear-task] [--note <str>] [--dry-run]
```

**No batch / `--ids` / `--stdin`** for either command. Same justification as R19 (spec 0030 §2.1 / decision 5): singleton-per-user precludes batch.

**No `--note` on `time stop`.** The roadmap proposed `freelo time stop [--note <str>]`, but the OpenAPI spec for `/timetracking/stop` (yaml :2780-2809) **does not document a request body** — quoting yaml :2793: *"No request body. The endpoint always targets the caller's own active session (one per user)."* Sending a `note` body would be guessing undocumented API behavior. Decision 1 routes `--note` to `time edit` (where it **is** documented) and ships `time stop` with no flags. Users who want to stamp a note set it via `time edit --note "..."` immediately before `time stop`.

**No `--started-at <ISO>` on `time edit`.** The roadmap proposed it, but the OpenAPI request body for `/timetracking/edit` (yaml :2830-2843) documents only `task_id` and `note`. There is no `date_reported` / `started_at` on the wire. Decision 2 defers backdating-mid-flight to a follow-up slice (R20.5), mirroring the R19 → R19.5 pattern that introduced `--at` on `time start`.

**Adds `--task <id>` and `--clear-task` to `time edit`.** The OpenAPI body documents `task_id` as a nullable settable — *"Setting `task_id=null` disassociates the session from any task (continues as general work)."* (yaml :2827). Agents need to reassign the session's task. The CLI exposes both directions: `--task 4567` to assign / reassign, `--clear-task` to disassociate (sends `task_id: null`). Decision 3 covers the flag shape.

### 2.2 Endpoints

#### `POST /timetracking/stop` (yaml :2780-2809)

- **No request body.** The endpoint always targets the caller's own active session.
- **200 OK** — body is a `WorkReport` (yaml :5669-5698): `{ id, date_add, date_reported, note?, minutes, cost, author, worker, task? }`.
- **409 Conflict** — body is `ErrorResponse`, message `"Timetracking is not running."` This is the no-active-session symmetric edge to R19's "already running" 409.
- 401 / 5xx — standard `FreeloApiError` paths.

The CLI captures the work report and surfaces the relevant fields on the envelope.

#### `POST /timetracking/edit` (yaml :2811-2861)

Request body — both fields **optional**, both **nullable**:

```json
{ "task_id": 4567, "note": "Updated note" }
```

- `task_id`: integer, **nullable** — `null` disassociates the session from any task.
- `note`: string, nullable.

Responses:

- **200 OK** — `{ "uuid": "<uuid>" }` of the (now-modified) running session.
- **409 Conflict** — `ErrorResponse`, message `"Timetracking is not running."` Same hint enrichment opportunity as `time stop` 409.
- 401 / 4xx / 5xx — standard `FreeloApiError` paths.

**Empty edit (no flags supplied) is rejected client-side as `ValidationError` (exit 2).** Sending `{}` to the wire would be a no-op POST; we'd rather surface that as a usage error than burn a server round-trip and possibly land an unintended state change. Decision 4.

### 2.3 Output schemas

#### `freelo.time.stop/v1`

Live response (`data`):

| field             | type                              | always present | notes                                                              |
| ----------------- | --------------------------------- | -------------- | ------------------------------------------------------------------ |
| `work_report`     | object                            | live only      | Projected from the wire `WorkReport` — see below                   |
| `would`           | object                            | dry-run only   | `{ method: 'POST', path: '/timetracking/stop', body: null }`        |

`work_report` shape (decision 5):

```jsonc
{
  "id": <int>,                          // Freelo work-report id
  "date_add": "<ISO date-time>",         // when the report was created
  "date_reported": "<ISO date>",         // session start (server-canonical)
  "minutes": <int>,                      // elapsed minutes (server-computed)
  "note": <string|null>,
  "task": { "id": <int>, "name": <str> } | null,
  "cost": { "amount": <str>, "currency": "CZK"|"EUR"|"USD" } | null,
  "worker": { "id": <int>, "fullname": <str> } | null,
  "author": { "id": <int>, "fullname": <str> } | null
}
```

Top-level envelope: `schema`, `data`, optional `rate_limit`, optional `request_id`. `dry_run: true` on dry-run.

#### `freelo.time.edit/v1`

Live response (`data`):

| field              | type                  | always present | notes                                                          |
| ------------------ | --------------------- | -------------- | -------------------------------------------------------------- |
| `uuid`             | string                | live only      | Server-issued UUID of the (still-running) session              |
| `applied_changes`  | object                | yes            | Echo of the wire body — `{ task_id?: int|null, note?: str|null }` |
| `would`            | object                | dry-run only   | `{ method: 'POST', path: '/timetracking/edit', body: {...} }`   |

`applied_changes` keys are present **only** when the corresponding flag was passed (decision 6). Mirrors R10 `tasks edit` precedent — agents read `applied_changes` to know what was sent.

### 2.4 No-active-session 409 hint (the load-bearing UX)

Both `time stop` and `time edit` return HTTP 409 with `"Timetracking is not running."` when no session is active. The CLI catches `FreeloApiError` with `httpStatus === 409` on either endpoint and rewrites `hint_next` to point at `time start`:

> `No active time tracking session for your account. Use \`freelo time start\` to begin one.`

Symmetric to R19's start-409 rewriter (spec 0030 §2.4 / decision 1 — reuse `FREELO_API_ERROR + httpStatus: 409` for branching, no new error code). The 409 still maps to exit code **4** per the existing taxonomy.

**No status follow-up on the 409.** R19's start-409 rewriter does an opportunistic `GET /timetracking/status` to enrich the hint with task/start info. Here that's not useful — the hint is "you have no session", not "you have a session with these details" — so we skip the follow-up. Decision 7.

### 2.5 Empty-edit rejection (client-side)

`freelo time edit` with no flags is a usage error:

```
$ freelo time edit
# stderr: VALIDATION_ERROR — `time edit` requires at least one of --task / --clear-task / --note.
# exit 2
```

Mutex pair `--task` / `--clear-task` is a Commander negatable: passing both is a usage error (exit 2). Decision 4 + decision 3.

### 2.6 Examples

```
# Stop the active timer, get the work report:
$ freelo time stop --output json
{"schema":"freelo.time.stop/v1","data":{"work_report":{"id":987,"date_add":"2026-04-28T15:30:00Z","date_reported":"2026-04-28","minutes":42,"note":"WIP","task":{"id":4567,"name":"Investigate"},"cost":null,"worker":{"id":1,"fullname":"agent"},"author":{"id":1,"fullname":"agent"}}},"rate_limit":{...}}

# Stop with no active session:
$ freelo time stop --output json
{"schema":"freelo.error/v1","error":{"code":"FREELO_API_ERROR","message":"...","http_status":409,"hint_next":"No active time tracking session for your account. Use `freelo time start` to begin one.","retryable":false}}
# exit 4

# Edit the active timer's note and task:
$ freelo time edit --task 4568 --note "switched context" --output json
{"schema":"freelo.time.edit/v1","data":{"uuid":"f...","applied_changes":{"task_id":4568,"note":"switched context"}},"rate_limit":{...}}

# Disassociate from task (continue as general work):
$ freelo time edit --clear-task --output json
{"schema":"freelo.time.edit/v1","data":{"uuid":"f...","applied_changes":{"task_id":null}}}
# Wire body: { "task_id": null }

# Empty edit:
$ freelo time edit
# exit 2 — VALIDATION_ERROR

# Conflict (--task + --clear-task):
$ freelo time edit --task 4567 --clear-task
# exit 2 — VALIDATION_ERROR

# Dry-run:
$ freelo time edit --note hi --dry-run --output json
{"schema":"freelo.time.edit/v1","dry_run":true,"data":{"applied_changes":{"note":"hi"},"would":{"method":"POST","path":"/timetracking/edit","body":{"note":"hi"}}}}
```

## 3. Data model

### 3.1 Extend `src/api/schemas/time.ts`

Add wire-shape and envelope schemas. The `WorkReport` wire schema is internal to this slice (we don't call the work-reports API yet — that's R21+):

```ts
// Wire — POST /timetracking/stop 200 body (WorkReport, yaml :5669-5698).
const TimeStopWireWorkerSchema = z.object({
  id: z.number().int(),
  fullname: z.string().nullable().optional(),
}).passthrough();

const TimeStopWireTaskSchema = z.object({
  id: z.number().int(),
  name: z.string().nullable().optional(),
}).passthrough();

const TimeStopWireCostSchema = z.object({
  amount: z.string(),
  currency: z.string(),
}).passthrough();

export const TimeStopResponseSchema = z.object({
  id: z.number().int(),
  date_add: z.string(),
  date_reported: z.string(),
  minutes: z.number().int(),
  note: z.string().nullable().optional(),
  cost: TimeStopWireCostSchema.nullable().optional(),
  author: TimeStopWireWorkerSchema.nullable().optional(),
  worker: TimeStopWireWorkerSchema.nullable().optional(),
  task: TimeStopWireTaskSchema.nullable().optional(),
}).passthrough();
export type TimeStopResponse = z.infer<typeof TimeStopResponseSchema>;

// Wire — POST /timetracking/edit 200 body.
export const TimeEditResponseSchema = z.object({
  uuid: z.string(),
}).passthrough();
export type TimeEditResponse = z.infer<typeof TimeEditResponseSchema>;

// Envelope `data` — `freelo.time.stop/v1` (live shape).
const TimeStopWorkReportSchema = z.object({
  id: z.number().int(),
  date_add: z.string(),
  date_reported: z.string(),
  minutes: z.number().int(),
  note: z.string().nullable(),
  task: z.object({ id: z.number().int(), name: z.string().nullable() }).nullable(),
  cost: z.object({ amount: z.string(), currency: z.string() }).nullable(),
  worker: z.object({ id: z.number().int(), fullname: z.string().nullable() }).nullable(),
  author: z.object({ id: z.number().int(), fullname: z.string().nullable() }).nullable(),
});
export type TimeStopWorkReport = z.infer<typeof TimeStopWorkReportSchema>;

export const TimeStopLiveDataSchema = z.object({
  work_report: TimeStopWorkReportSchema,
});
export type TimeStopLiveData = z.infer<typeof TimeStopLiveDataSchema>;

// Dry-run shape — no work_report (no POST happened).
export const TimeStopDryRunDataSchema = z.object({});
export type TimeStopDryRunData = z.infer<typeof TimeStopDryRunDataSchema>;

// Envelope `data` — `freelo.time.edit/v1`.
const TimeEditAppliedChangesSchema = z.object({
  task_id: z.number().int().nullable().optional(),
  note: z.string().nullable().optional(),
});
export type TimeEditAppliedChanges = z.infer<typeof TimeEditAppliedChangesSchema>;

export const TimeEditLiveDataSchema = z.object({
  uuid: z.string(),
  applied_changes: TimeEditAppliedChangesSchema,
});
export type TimeEditLiveData = z.infer<typeof TimeEditLiveDataSchema>;

export const TimeEditDryRunDataSchema = z.object({
  applied_changes: TimeEditAppliedChangesSchema,
});
export type TimeEditDryRunData = z.infer<typeof TimeEditDryRunDataSchema>;
```

### 3.2 Extend `src/api/time.ts`

Add wire wrappers + path constants + builders, mirroring `startTimer` / `getTimerStatus`:

```ts
export const STOP_TIMER_PATH = '/timetracking/stop';
export const EDIT_TIMER_PATH = '/timetracking/edit';

// `POST /timetracking/stop` — no body. Returns WorkReport.
export type StopTimerOpts = FetchOpts;
export type StopTimerResult = {
  workReport: TimeStopResponse;
  raw: ApiResponse<TimeStopResponse>;
};
export async function stopTimer(client: HttpClient, opts: StopTimerOpts = {}): Promise<StopTimerResult> {
  const raw = await client.request({
    method: 'POST',
    path: STOP_TIMER_PATH,
    schema: TimeStopResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { workReport: raw.data, raw };
}

// `POST /timetracking/edit` — body { task_id?: int|null, note?: str|null }.
export type EditTimerBody = {
  task_id?: number | null;
  note?: string | null;
};
export type EditTimerInput = {
  /** undefined = don't touch; number = assign; null = disassociate (--clear-task). */
  taskId?: number | null;
  note?: string;
};
export type EditTimerOpts = FetchOpts & { body: EditTimerBody };
export type EditTimerResult = {
  response: TimeEditResponse;
  raw: ApiResponse<TimeEditResponse>;
};
export async function editTimer(client: HttpClient, opts: EditTimerOpts): Promise<EditTimerResult> {
  const raw = await client.request({
    method: 'POST',
    path: EDIT_TIMER_PATH,
    body: opts.body,
    schema: TimeEditResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { response: raw.data, raw };
}

export function buildEditTimerBody(input: EditTimerInput): EditTimerBody {
  const body: EditTimerBody = {};
  if (input.taskId !== undefined) body.task_id = input.taskId; // includes null
  if (input.note !== undefined) body.note = input.note;
  return body;
}
```

### 3.3 New file: `src/commands/time/stop.ts`

Mirror `time/start.ts` shape:

```ts
// Pseudocode.
.command('stop')
  .description('Stop the active time tracking session and emit the resulting work report. Returns 409 with a friendly hint when no session is running.')
  .option('--dry-run', 'Skip the POST; envelope echoes path with body=null.')
  .action(async (opts: { dryRun?: boolean }) => {
    // Dry-run: emit envelope with would.body=null.
    // Live: POST /timetracking/stop, project the WorkReport, emit envelope.
    // 409: rewrite hint via rewriteStopHint() → 'No active session, use `freelo time start`.'
  });
```

### 3.4 New file: `src/commands/time/edit.ts`

Same shape, plus mutex validation between `--task` and `--clear-task`, plus the empty-edit rejection:

```ts
.command('edit')
  .description('Edit the active time tracking session in flight (--task / --clear-task / --note). Returns 409 with a friendly hint when no session is running. At least one of --task / --clear-task / --note is required.')
  .option('--task <id>', '...', parseTaskFlag)        // mutex with --clear-task
  .option('--clear-task', 'Disassociate the session from any task (sends task_id: null).')
  .option('--note <str>', '...')
  .option('--dry-run', '...')
  .action(async (opts: { task?: number; noTask?: boolean; note?: string; dryRun?: boolean }) => {
    // Validate: --task + --clear-task is a usage error (decision 3).
    // Validate: empty edit is a usage error (decision 4).
    // Resolve taskId: opts.task ?? (opts.noTask === true ? null : undefined).
    // Build body via buildEditTimerBody.
    // Dry-run / Live branches mirror time start.
    // 409: same rewriteStopHint() (or a shared rewriteNoActiveHint() helper).
  });
```

### 3.5 Wire `src/commands/time.ts`

Add the two siblings:

```ts
registerStart(time, getConfig, env);
registerStop(time, getConfig, env);     // NEW
registerEdit(time, getConfig, env);     // NEW
registerStatus(time, getConfig, env);
```

### 3.6 Human renderers

```
src/ui/human/time-stop.ts   → renderTimeStopHuman(data)
src/ui/human/time-edit.ts   → renderTimeEditHuman(data)
```

Single-line summaries in the same style as `time-start.ts`:

- Stop, live: `Stopped timer #<id> (<minutes>m on task #<task.id> "<task.name>")` or `(<minutes>m, no task)`.
- Stop, dry-run: `[dry-run] Would stop the active timer.`
- Edit, live: `Edited active timer (uuid <uuid>): <changes summary>` (e.g. `note: "...", task: 4568`).
- Edit, dry-run: `[dry-run] Would edit active timer: <changes summary>`.

## 4. Edge cases

| edge case                                                       | handling                                                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `time stop` with no active session (409)                        | Hint rewriter → `No active time tracking session... Use 'freelo time start'`. exit 4                                |
| `time stop --dry-run`                                           | Skip POST; envelope with `would.body=null`. exit 0                                                                  |
| `time stop` 401                                                  | `FreeloApiError`, exit 3                                                                                            |
| `time stop` 5xx                                                  | `FreeloApiError`, exit 4 (retryable: true)                                                                          |
| `time stop` network error                                        | `NetworkError`, exit 5                                                                                              |
| `time edit` with no flags                                        | `ValidationError` "requires at least one of --task / --clear-task / --note", exit 2 (decision 4)                       |
| `time edit --task 4567 --clear-task`                                | `ValidationError` "--task and --clear-task are mutually exclusive", exit 2 (decision 3)                                |
| `time edit --task <bad>`                                         | `ValidationError`, exit 2 (reuses `parseTaskFlag` from `time start`)                                                |
| `time edit` with no active session (409)                         | Same hint as `time stop`. exit 4                                                                                    |
| `time edit --task 4567` (only)                                   | Wire body: `{ task_id: 4567 }`. envelope `applied_changes.task_id = 4567`, no `note` key. exit 0                    |
| `time edit --clear-task` (only)                                     | Wire body: `{ task_id: null }`. envelope `applied_changes.task_id = null`, no `note` key. exit 0                     |
| `time edit --note ""` (empty string)                             | Wire body: `{ note: "" }`. Server decides — Freelo permits empty notes (R19 precedent).                              |
| `time edit --task 4567 --note hi --dry-run`                      | `would.body = { task_id: 4567, note: 'hi' }`; envelope `applied_changes` likewise; no POST                          |
| `time edit` 401                                                  | `FreeloApiError`, exit 3                                                                                            |
| `time edit` 5xx                                                  | `FreeloApiError`, exit 4                                                                                            |
| `time stop` returns `WorkReport` with `task: null` (general work)| Envelope `data.work_report.task = null`; renderer says "no task". exit 0                                            |
| `time stop` returns `WorkReport` with malformed cost              | Envelope `cost: null`; passthrough on wire schema absorbs unexpected shapes                                          |

## 5. Non-goals

- **`--note` on `time stop`.** Decision 1 — defer to `time edit --note` immediately before stop, since the OpenAPI doesn't document a stop body.
- **`--started-at` / `--at` on `time edit`.** Decision 2 — defer to R20.5 (mirroring R19 → R19.5). OpenAPI doesn't document a backdate field on edit.
- **Work-report listing (`reports list`)** — R21.
- **Retroactive work-report logging without timer (`reports log`)** — R22.
- **Switching `task_id` from null to a number after start** — already covered by `time edit --task <id>`. Not a new feature, just a use case.
- **`time edit` followed by automatic `time stop`** (combined "switch and stop") — out of scope; chain commands.
- **Confirmation prompts.** Neither command is destructive in the agentic-CLI sense — `time stop` is the natural finalize operation, not a delete; `time edit` is a benign update. No `--yes` / TTY prompt.

## 6. Open questions

None. The two contradictions with the roadmap (HTTP verb on edit; `--started-at` on edit; `--note` on stop) are resolved deterministically by following the OpenAPI spec — see decisions 1, 2, and the implicit POST-vs-PATCH decision in decision 8.

## 7. Decisions made autonomously

### Decision 1 — Drop `--note` on `time stop`; route notes through `time edit`

**Question:** The roadmap proposes `freelo time stop [--note <str>]`. Should the CLI ship that flag?

**Decision:** No. Ship `time stop` with no flags except `--dry-run`. Users who want to stamp a final note set it via `time edit --note "..."` immediately before `time stop`.

**Alternatives considered:**

- Send `{ note: "..." }` as a body to `/timetracking/stop` — rejected; OpenAPI documents no body, sending one would be guessing API behavior (orchestrator hard rule).
- Open-question / pause for human guidance — rejected; the alternate path (`time edit --note "..." && time stop`) is composable and obvious; no decision needs human input.
- Add a roadmap note recommending an OpenAPI fix — out of scope here.

**Rationale:** Hard rule violation otherwise. The `time edit --note` path is documented, idempotent, and ships in this same slice — agents have a clean two-call sequence.

### Decision 2 — Defer `--started-at` on `time edit` to R20.5

**Question:** Roadmap proposes `time edit [--started-at <ISO>]`. The OpenAPI body documents only `task_id` and `note`. Ship anyway, pause, or defer?

**Decision:** Defer to R20.5. Ship R20 with the documented edit body (`--task` / `--clear-task` / `--note`).

**Alternatives considered:**

- Ship `--started-at` and POST `{ ..., date_reported: <ISO> }` — rejected; orchestrator hard rule against guessing API behavior.
- Pause and ask the human — rejected; the deferral path is precedent (R19 deferred `--at` to R19.5 with the same rationale).
- Drop `--started-at` permanently — rejected; backdating mid-flight is a real workflow (operator caught a misclick 30 minutes in), worth a tiny follow-up slice.

**Rationale:** Mirror precedent. R19.5 introduced `--at` on `time start` after R19 shipped without it, using `parseIsoTimestampFlag` from `src/lib/iso-timestamp.ts`. R20.5 will do the same on `time edit`, contingent on either an OpenAPI update or a freelo-api-specialist fixture confirming the wire field name.

### Decision 3 — `--task` / `--clear-task` mutex pair on `time edit`

**Question:** OpenAPI documents `task_id` as nullable on edit. How does the CLI surface "set to null"?

**Decision:** Add two flags: `--task <id>` (assign) and `--clear-task` (disassociate, sends `task_id: null`). They are mutually exclusive — both supplied → `ValidationError` exit 2.

**Alternatives considered:**

- Single `--task <id>` flag with sentinel value `0` for null — rejected; sentinel values are footguns.
- Single `--task <id|null>` literal — rejected; "null" as a string clashes with task names that are literally "null".
- Commander's negatable `--no-task` — **prototyped during implement, then rejected**: Commander's `--no-<flag>` form clobbers the same option storage as `--task`, so `--task 4567 --no-task` ends up with `task: false` and the mutex check can't see both signals. A positive-named `--clear-task` flag has independent storage and the mutex check works regardless of argv order. The mid-implementation correction is captured here so future readers don't re-prototype the negatable.

**Rationale:** Independent option storage matters for the mutex check. `--clear-task` is a slightly more explicit name than `--no-task` anyway; it pairs well with `--task <id>` as "set to id" / "clear it back to null".

### Decision 4 — Reject empty edit at the command layer

**Question:** Should `freelo time edit` (no flags) be a no-op success, a server round-trip, or a usage error?

**Decision:** Usage error. `ValidationError` exit 2 with hint `"requires at least one of --task / --clear-task / --note"`.

**Alternatives considered:**

- Success exit 0 with `applied_changes: {}` and no POST — rejected; agents that retry might unintentionally land here, and silent no-ops hide bugs.
- Send `POST {}` and let the server decide — rejected; one round trip per accidentally-empty invocation, and the server's response is undocumented for empty bodies.

**Rationale:** Mirror R10 `tasks edit` precedent (skip-empty-edit decision). Catches typos and accidental flag drops at the boundary, before any network call.

### Decision 5 — Project `WorkReport` to a stable subset on the envelope

**Question:** The wire `WorkReport` schema (`docs/api/freelo-api.yaml:5669-5698`) carries a few fields agents may not need (full `cost` shape, `worker`, `author`). Echo wire shape, or project to a stable subset?

**Decision:** Project to a documented subset: `{ id, date_add, date_reported, minutes, note, task, cost, worker, author }`, with inner refs tightened (e.g. `cost: { amount, currency }` shape only).

**Alternatives considered:**

- Pass wire shape through with `.passthrough()` — rejected; the envelope is a public contract, we own the shape.
- Minimal subset (`{ id, minutes, task }`) — rejected; agents downstream would have to chain a `reports show` call (R21) to get the cost / note, defeating the point of returning the full report.
- Include `WorkReportFull` shape — rejected; that's an `allOf` extension with `date_edited_at` / nested label/estimate detail, not what `/timetracking/stop` returns per OpenAPI.

**Rationale:** Same trade-off the R19 status envelope made — pick the agent-actionable fields, normalize names, drop the rest. Future R21 (`reports list`) will have its own envelope with whatever it wants.

### Decision 6 — `applied_changes` only carries keys the user actually passed

**Question:** Should `applied_changes` always carry both `task_id` and `note` (with nulls for "not set"), or only the keys the user passed?

**Decision:** Only the keys the user passed. Mirrors the wire body shape: if `--task` and `--clear-task` are both omitted, the wire body has no `task_id` key, and the envelope's `applied_changes` has no `task_id` key.

**Alternatives considered:**

- Always echo both, with `null` for "not touched" — rejected; conflates "not touched" with "explicitly set to null" (decision 3 cares about that distinction).
- Always echo both, with the wire-body shape (`task_id` absent if not touched, present-and-null if `--clear-task`, present-and-int if `--task`) — same as the chosen path; just rephrased.

**Rationale:** Wire-clean parity. Agents reading the envelope match exactly what went on the wire. `if ('task_id' in applied_changes)` is the agent's "did the user touch the task?" check.

### Decision 7 — No status follow-up on the no-active-session 409

**Question:** R19's start-409 rewriter does an opportunistic `GET /timetracking/status` to enrich the hint. Should stop-409 / edit-409 do the same?

**Decision:** No. The hint already says "no session is running" — there's nothing useful to enrich with.

**Alternatives considered:**

- Always do a status follow-up for symmetry with start — rejected; one extra network call on every error path with no value-add.
- Conditionally follow up based on... no obvious gating signal.

**Rationale:** YAGNI. The R19 follow-up exists because its hint *needs* current-session details ("you're tracking #X since Y"). Here the hint is "you have nothing"; that's all the info needed.

### Decision 8 — Implement `time edit` as POST (per OpenAPI), not PATCH (per roadmap)

**Question:** Roadmap says `PATCH /timetracking/edit`. OpenAPI says `post:`. Which to implement?

**Decision:** POST. Follow the OpenAPI spec.

**Alternatives considered:**

- PATCH per roadmap — rejected; OpenAPI is authoritative per orchestrator hard rules.
- Pause and ask the human to resolve the discrepancy — rejected; the orchestrator instructions explicitly prescribe the resolution: "If the OpenAPI spec contradicts the roadmap, follow the OpenAPI spec and note the discrepancy."

**Rationale:** Direct rule application. The discrepancy is documented in the changeset and in this spec's §1 / §6 / triage.md.

## Plan

### Branch

`feat/time-stop-edit` — cut from `main` at `3bc38f9` (R19.5 merge SHA, freshly synced).

### Files to create

| Path                                              | Intent                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/commands/time/stop.ts`                       | Leaf — `--dry-run` only. POST `/timetracking/stop`, project WorkReport into envelope, 409 hint rewrite.                          |
| `src/commands/time/edit.ts`                       | Leaf — `--task` / `--clear-task` / `--note` / `--dry-run`. Mutex validation, empty-edit rejection, 409 hint rewrite.               |
| `src/ui/human/time-stop.ts`                       | Human-mode renderer for `time stop`.                                                                                            |
| `src/ui/human/time-edit.ts`                       | Human-mode renderer for `time edit`.                                                                                            |
| `test/commands/time/stop.test.ts`                 | Integration: happy path (with task / no task), `--dry-run`, 409 hint, 401, 5xx.                                                  |
| `test/commands/time/edit.test.ts`                 | Integration: each flag combo, mutex `--task`/`--clear-task` (exit 2), empty-edit (exit 2), `--dry-run`, 409 hint, 401, 5xx.        |
| `docs/commands/time-stop.md`                      | User-facing docs.                                                                                                               |
| `docs/commands/time-edit.md`                      | User-facing docs.                                                                                                               |
| `.changeset/r20-time-stop-edit.md`                | Minor changeset — calls out two new schemas, OpenAPI vs roadmap discrepancy, deferred `--started-at`.                            |
| `docs/runs/2026-04-28-2100-r20-time-stop-edit/decisions/01-no-stop-note.md` ... `08-post-not-patch.md` | One file per spec decision (8 total).                                              |

### Files to modify

| Path                                              | Change                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/schemas/time.ts`                         | Add `TimeStopResponseSchema`, `TimeEditResponseSchema`, envelope `data` schemas (live + dry-run), projected `WorkReport` shape. |
| `src/api/time.ts`                                 | Add `stopTimer`, `editTimer`, `buildEditTimerBody`, `STOP_TIMER_PATH`, `EDIT_TIMER_PATH`.                                       |
| `src/commands/time.ts`                            | Wire `registerStop` + `registerEdit` siblings between `registerStart` and `registerStatus`.                                     |
| `test/msw/handlers.ts`                            | Add `timeHandlers.stopOk(workReport)`, `stopConflict()`, `stopUnauthorized()`, `stopServerError(s)`, `editOk(uuid)`, `editOkWhenBody(predicate, uuid)`, `editConflict()`, `editUnauthorized()`, `editServerError(s)`. |
| `test/api/time.test.ts`                           | Extend with `stopTimer` (200, 409, 401, 5xx) and `editTimer` (200 with body capture, 409, 401, 5xx) cases.                       |
| `README.md`                                       | Re-run `pnpm fix:readme` to refresh autogen Commands block.                                                                     |

### New runtime dependencies

**None.** All needed primitives present.

### Test strategy

#### Unit tests (`test/api/time.test.ts` extension)

- `buildEditTimerBody` — empty input → `{}`; `--task` only → `{ task_id }`; `--clear-task` (taskId: null) → `{ task_id: null }`; `--note` only → `{ note }`; both → both keys.
- `stopTimer` — 200 returns `{ workReport, raw }` with parsed schema; 409 throws `FreeloApiError(httpStatus=409, exitCode=4)`; 401 → exitCode 3; 5xx → retryable.
- `editTimer` — 200 returns `{ response, raw }`; 409 → `FreeloApiError`; 401 → exitCode 3; body capture matches input.

#### Integration tests (`test/commands/time/stop.test.ts`)

- Happy path: `time stop --output json` → exit 0, schema correct, `data.work_report.id`/`minutes`/`task` populated.
- Happy path no task: WorkReport with `task: null` → envelope `data.work_report.task: null`.
- `--dry-run`: no POST, `dry_run: true`, `data.would.method/path/body` populated.
- 409: exit 4, hint mentions `time start` and "no active".
- 401: exit 3.
- 5xx: exit 4, `retryable: true`.

#### Integration tests (`test/commands/time/edit.test.ts`)

- `--task 4567 --note hi`: wire body `{ task_id: 4567, note: 'hi' }`; envelope `applied_changes` matches; exit 0.
- `--task 4567` only: wire body `{ task_id: 4567 }` (no `note` key); envelope mirrors.
- `--clear-task` only: wire body `{ task_id: null }`; envelope mirrors.
- `--note ""`: wire body `{ note: "" }`; exit 0.
- Empty edit: exit 2, `VALIDATION_ERROR`, hint about needing one of the flags (Calibration §2).
- `--task 4567 --clear-task`: exit 2, `VALIDATION_ERROR`, hint about mutex (Calibration §2).
- `--task abc`: exit 2 (reused `parseTaskFlag`).
- `--task 0` / `--task -3`: exit 2.
- `--note hi --dry-run`: no POST, `dry_run: true`, `would.body = { note: 'hi' }`.
- `--task 4567 --clear-task --dry-run`: still exit 2 (mutex check happens before dry-run branch).
- 409: exit 4, hint mentions `time start` and "no active".
- 401: exit 3.
- 5xx: exit 4, retryable.

#### Coverage callouts

- Calibration §1 — full pipeline before commit, no shortcuts.
- Calibration §2 — every error class triggered: `ValidationError` (mutex / empty / bad task), `FreeloApiError` (409 stop / 409 edit / 401 / 5xx). Each gets an explicit `exitCode` assertion.
- Calibration §3 — five-gate (`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`) on the committed tree before push.
- Calibration §4 — both leaves add a single `try/catch` arm around the API call (mirroring `time/start.ts`); each new arm is covered by a 409 test plus the 401/5xx tests.
- Coverage targets ≥ 90% for `src/api/` and `src/commands/`. Both stop and edit leaves have unique 409-rewriter branches plus their own dry-run paths — explicit tests for both.

### Five-gate before push

`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme` — all pass on the committed tree.

### Rollout

Single landable slice. Squash on PR merge:

`feat(commands): r20 — freelo time stop / time edit (POST /timetracking/{stop,edit})`

PR body calls out:

- Two new envelope schemas (`freelo.time.stop/v1`, `freelo.time.edit/v1`) — additive.
- OpenAPI vs. roadmap discrepancies (POST vs. PATCH; deferred `--started-at`; deferred stop `--note`).
- New `--task` / `--clear-task` mutex pair on `time edit` (rationale: capability documented in OpenAPI but missing from roadmap text).

### Decision-log links

Decisions 1-8 captured in §7 above. Per-decision files at `docs/runs/2026-04-28-2100-r20-time-stop-edit/decisions/`.
