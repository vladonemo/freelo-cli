# 0019 — `freelo tasks create` (R09)

**Status:** Accepted — ready for implementation
**Run:** 2026-04-27-tasks-create
**Tier:** Yellow (additive new command + new envelope schema; first write — ships shared write infra)
**Branch:** `feat/tasks-create`
**Cross-reference:** Patterns inherited from spec 0017 (R07 `tasks list`), spec 0018 (R08 `tasks show`). API endpoint shares the path of R07's `tasklist-tasks` route, only the verb differs.

---

## 1. Problem

Up to R08, the CLI is read-only. R09 is the **first write slice** and unlocks the daily-driver flow `freelo tasks create --tasklist 314 --name "Audit auth"` — a one-line ticket-from-anywhere primitive. It also ships the shared write infrastructure (`src/lib/dry-run.ts`, `src/lib/batch.ts`, NDJSON streamer) that every later write slice (R10 edit, R11 finish/reopen, R12 move, R13 delete) reuses verbatim. Get the foundations right; later slices borrow them as-is.

## 2. Background — what the API gives us

**Endpoint:** `POST /project/{project_id}/tasklist/{tasklist_id}/tasks` — `createTask` (OpenAPI :1402-1434).

**Request body** (`TaskCreate`, OpenAPI :5300-5337):

| Field | Type | Required | CLI flag (R09 scope) |
|---|---|---|---|
| `name` | string | **yes** | `--name <str>` |
| `due_date` | date-time | no | `--due <YYYY-MM-DD>` (sent as `YYYY-MM-DDT00:00:00Z`) |
| `due_date_end` | date-time | no | **out of scope** for R09 (no roadmap flag) |
| `worker` | int (user id) | no | `--worker <id>` (CLI accepts repeats but only **first** is sent — see §3.4) |
| `priority_enum` | string `h|m|l` | no | `--priority low|normal|high` → mapped: low→l, normal→m, high→h |
| `comment.content` | string | no | `--description <text>` or `--description-file <path>` |
| `labels[]` | `TaskLabelAddInput[]` | no | `--label <name>` (repeatable). Each name sent as `{ name, color: '#77787a' }` (API default; spec §5304-5328) |
| `tracking_users_ids[]` | int[] | no | **out of scope** for R09 |
| `turn_off_authors_tracking` | boolean | no | **out of scope** for R09 |
| `subtasks[]` | `SubtaskCreate[]` | no | **out of scope** for R09 |

**Response** (`TaskCreated`, OpenAPI :5339-5380): `{ id, name, date_add, due_date|null, due_date_end|null, worker: UserBasic, priority_enum, labels: TaskLabel[], tracking_users: UserBasic[], subtasks: [{id, task_id, name}] }`.

Side effects on the API side (informational): a `task_created` event fires (webhooks, notifications). `worker` is silently filled from the tasklist's default-worker rules if omitted. A 403 (`WorkerHasNoAccessToTasklistException`) is returned if the caller passes a `worker` outside the tasklist's `assignable-workers`. Dates are `date-time` server-side; CLI input is the calendar-date `YYYY-MM-DD` form for ergonomics — we send `YYYY-MM-DDT00:00:00Z` (decision 1).

## 3. Proposal

### 3.1 Subcommand signature

```
freelo tasks create
  --tasklist <id>                    # required; numeric tasklist id
  --name <str>                       # required (in single mode); free text
  [--worker <id>]                    # numeric user id; sent first-only if repeated (see §3.4)
  [--due <YYYY-MM-DD>]               # ISO calendar date
  [--priority low|normal|high]       # mapped to h/m/l
  [--label <name>]...                # repeatable
  [--description <text>]             # short inline body
  [--description-file <path>]        # mutex with --description; reads UTF-8
  [--dry-run]                        # no HTTP call; envelope echoes the body that *would* go on the wire
  [--stdin]                          # batch mode (NDJSON in → NDJSON out); see §3.5
```

**Out of scope for R09 (deferred — log decisions, do not pause):**
- `--editor` (terminal-editor description input). Defer to **R15** (`tasks description set`) which is the natural home for editor I/O on description bodies. Decision 2.
- `--tasklist` discovery — relies on `freelo tasklists list`. R09 takes the id raw.
- `--project` flag — the project id is **not** a CLI flag in R09. It is **derived from `--tasklist`** via a one-shot `GET /tasklist/{tasklist_id}` lookup (uses the existing `getTasklistDetail` from R06). Decision 3.

**Per-command `meta`:**

```ts
export const meta: CommandMeta = {
  outputSchema: 'freelo.tasks.create/v1',
  destructive: false,
};
```

`destructive: false` — create is additive. Idempotency for create is **not** automatic (POSTing the same body twice yields two tasks). We do not invent a synthetic idempotency key in v1.

### 3.2 Envelope shape — `freelo.tasks.create/v1`

Single mode (one task per invocation):

```jsonc
{
  "schema": "freelo.tasks.create/v1",
  "data": {
    "task": { /* TaskCreated — parsed-and-validated */ },
    "tasklist_id": 314,
    "project_id": 42
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-04-27T20:30:00Z" },
  "request_id": "..."
}
```

`--dry-run`:

```jsonc
{
  "schema": "freelo.tasks.create/v1",
  "dry_run": true,
  "data": {
    "would": {
      "method": "POST",
      "path": "/project/42/tasklist/314/tasks",
      "body": { "name": "Audit auth", "priority_enum": "h", "labels": [{ "name": "blocker", "color": "#77787a" }] }
    },
    "tasklist_id": 314,
    "project_id": 42
  }
}
```

No `rate_limit`, no `request_id` on dry-run (no HTTP happened). The `dry_run: true` flag is a top-level envelope discriminant agents key off (already in `Envelope<T>`).

Batch mode (`--stdin`): one envelope per input line, written as NDJSON (one JSON object per `\n`-terminated line, no surrounding array). Each line is a complete `freelo.tasks.create/v1` envelope (success) or a `freelo.error/v1` envelope (failure, with the input's 0-indexed `line_index` carried in `data.line_index` for success or `error.context.line_index` for failures — see §3.5).

### 3.3 Field naming and rules

- Snake-case in the wire & in the envelope (`tasklist_id`, `project_id`, `priority_enum`, `due_date`).
- `data.task` is the parsed `TaskCreated` shape. Schema fields use `.passthrough()` (R07 convention) — Freelo may add fields and we tolerate them.
- The envelope echoes `tasklist_id` and `project_id` so agents don't have to keep separate state to know where the new task landed.
- Top-level keys agents may key off: `schema`, `data.task.id` (the new task's id), `data.tasklist_id`, `data.project_id`, `dry_run`. None are removed/renamed in subsequent v1 revisions; new fields are additive only (working agreement: "Envelope schemas are a public contract").

### 3.4 Repeatable `--worker`

The `TaskCreate` body accepts a single `worker` (integer id). Roadmap text says `--worker <id>...`; that surface is reused later by R10 `tasks edit` which can change assignment. For R09 we accept `--worker <id>` repeated for forward-compat ergonomics but **only the first occurrence is sent**, with a soft `notice` on the envelope when more than one was provided (`"--worker repeated; only the first id was used. R10 will let you change assignment after creation."`). No error, no exit-code change. Decision 4.

### 3.5 Batch / `--stdin` shape

Input format: NDJSON. One JSON object per line, lines `\n` or `\r\n` terminated, blank lines skipped. Each object's keys mirror the long-form CLI flags — minus the `--` prefix and with `kebab-case → snake_case` conversion:

```jsonc
{ "name": "Audit auth", "worker": 17, "due": "2026-05-01", "priority": "high", "label": ["blocker"], "description": "Investigate the CSRF leak in v3." }
{ "name": "Backfill changelog", "label": ["docs", "chore"] }
```

Validation rules on each line:
- Same as flags: `name` required (string, non-empty); `worker` int >=1; `due` ISO date; `priority` ∈ {low,normal,high}; `label` array of non-empty strings; `description` string; mutually exclusive `description` vs. `description_file` — but **`description_file` is rejected in batch mode** (file paths in NDJSON inputs are an attack surface; agents should pre-resolve to `description`). Decision 5.
- Unknown keys → `ValidationError` for that line (exit code applies only at end-of-stream — see below).
- Empty lines (after trim) skipped silently.
- The shared `--tasklist <id>` flag applies to every input line (the line CANNOT override it; if a line carries `tasklist`, we reject it with `ValidationError` — keeps the project-id lookup deterministic). Decision 6.

Output format: NDJSON. One envelope per input line, written **as the line completes** (streamed, not buffered). Two shapes per line:

- **Success line:**
  ```json
  {"schema":"freelo.tasks.create/v1","data":{"task":{...},"tasklist_id":314,"project_id":42,"line_index":0},"rate_limit":{...}}
  ```
- **Error line:**
  ```json
  {"schema":"freelo.error/v1","error":{"code":"VALIDATION_ERROR","message":"--name is required.","http_status":null,"request_id":null,"retryable":false,"hint_next":null,"docs_url":null,"context":{"line_index":1}}}
  ```

A failed line **does not abort the run**. The streamer continues processing subsequent lines. The process exit code at end-of-stream is the **numerically highest** per-line exit code:
- `0` if all lines succeeded.
- `2` if any line failed validation and **none** failed for an HTTP reason.
- `3` if any line hit auth-expired (401).
- `4` if any line hit a generic API error (`FREELO_API_ERROR` / `FORBIDDEN`, including 403/404/422/5xx).
- `5` if any line hit a network failure.
- `6` if any line hit a rate-limit.

Highest-wins matches POSIX practice (the most-severe failure dominates). Decision 7.

`--dry-run` + `--stdin`: one dry-run envelope per line, no HTTP calls, no project-id lookup either — the dry-run output uses `project_id: null` and a `notice` field on every line. Wait — that contradicts decision 3 (project-id always derived). Refined: `--dry-run` still performs the **one** `GET /tasklist/{id}` lookup at startup so `project_id` is real in the envelope; the per-line creates are skipped. If `--dry-run` is set AND the user wants to skip the lookup too, they pass `--project <id>` (an **escape hatch** added for dry-run only — strictly mutex with normal mode). Decision 8.

Single-mode `--dry-run` likewise performs the one tasklist lookup for `project_id`. (Acceptable: 1 GET to dry-run a write is still cheaper than a real write and gives an accurate envelope.)

### 3.6 Example invocations

**Human (TTY) — single create:**
```bash
$ freelo tasks create --tasklist 314 --name "Audit auth flow" --priority high --label blocker
Created task #9012 in tasklist 314 (project 42).
```

**Agent — JSON, env-var auth:**
```bash
$ FREELO_API_KEY=*** FREELO_EMAIL=bot@example.com \
  freelo tasks create --tasklist 314 --name "Backfill changelog" --output json
{"schema":"freelo.tasks.create/v1","data":{"task":{"id":9012,...},"tasklist_id":314,"project_id":42},"rate_limit":{...}}
```

**Agent — batch from a generator script:**
```bash
$ ./generate-tasks.sh | freelo tasks create --tasklist 314 --stdin --output ndjson
{"schema":"freelo.tasks.create/v1","data":{"task":{...,"id":9012},"tasklist_id":314,"project_id":42,"line_index":0},...}
{"schema":"freelo.error/v1","error":{"code":"VALIDATION_ERROR","message":"--name is required.","context":{"line_index":1},...}}
{"schema":"freelo.tasks.create/v1","data":{"task":{...,"id":9013},"tasklist_id":314,"project_id":42,"line_index":2},...}
$ echo $?
2
```

**Dry-run:**
```bash
$ freelo tasks create --tasklist 314 --name "Test" --dry-run --output json
{"schema":"freelo.tasks.create/v1","dry_run":true,"data":{"would":{"method":"POST","path":"/project/42/tasklist/314/tasks","body":{"name":"Test"}},"tasklist_id":314,"project_id":42}}
```

**Error (worker outside ACL):**
```bash
$ freelo tasks create --tasklist 314 --name "Foo" --worker 9999
freelo: User 9999 has no access to tasklist 314.
  hint: Confirm the worker is on the tasklist's assignable-workers list (`freelo tasklists show 314 --with workers`).
$ echo $?
1
```

## 4. Errors

| Trigger | Class | code | exitCode | retryable | hint_next |
|---|---|---|---|---|---|
| Missing `--tasklist` | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--tasklist is required (numeric tasklist id)." |
| `--tasklist` not a positive integer | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--tasklist takes a positive integer id." |
| Missing `--name` (single mode) | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--name is required, or use --stdin for batch input." |
| `--worker` not positive integer | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--worker is the numeric user id." |
| `--due` not ISO date | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--due must be in YYYY-MM-DD format." |
| `--priority` not in enum | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--priority must be one of: low, normal, high." |
| `--label ""` (empty after trim) | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--label cannot be empty." |
| `--description` AND `--description-file` both set | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "Pass either --description or --description-file, not both." |
| `--description-file` path missing/unreadable | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "Check the path is readable; UTF-8 expected." |
| `--name` AND `--stdin` both set | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--name belongs to single mode; in --stdin batch mode put per-line names in NDJSON." |
| `--description-file` AND `--stdin` both set | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "Inline `description` field per NDJSON line; --description-file is single-mode only." |
| Bad NDJSON line (not parseable) | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "Line N is not valid JSON." |
| NDJSON line with unknown / wrong-type keys | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "Line N: unknown field 'X'" / "Line N: 'name' must be a non-empty string." |
| NDJSON line carries `tasklist` | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "Override --tasklist via the flag, not per-line." |
| HTTP 401 (auth) | `FreeloApiError` (auth-expired path) | `AUTH_EXPIRED` | 3 | false | "Re-authenticate with `freelo auth login`." |
| HTTP 403 (worker out of ACL) | `FreeloApiError` | `FORBIDDEN` | 4 | false | "Confirm the worker is on the tasklist's assignable-workers list." |
| HTTP 404 (tasklist not found / not visible) | `FreeloApiError` | `FREELO_API_ERROR` | 4 | false | "Confirm tasklist id; you may not have access." |
| HTTP 422 (server-side validation) | `FreeloApiError` | `FREELO_API_ERROR` | 4 | false | server message passed through |
| HTTP 429 | `RateLimitedError` | `RATE_LIMITED` | 6 | true | "Retry after `retry_after` seconds." |
| HTTP 5xx | `FreeloApiError` | `FREELO_API_ERROR` | 4 | true | "Retry; if it persists, check Freelo status." |
| Network failure | `NetworkError` | `NETWORK_ERROR` | 5 | true | (existing) |

**Calibration §2:** every typed error class triggered by R09 has at least one exit-code-asserting test (see §6 Plan): `ValidationError` (multiple cases), `FreeloApiError` (404, 403), `NetworkError` (one case), `RateLimitedError` (429 on a write — non-retried per client policy).

## 5. Data model — zod schemas

Reuse `UserBasicSchema` and `TaskLabelSchema` from `src/api/schemas/project.ts` / `task.ts`. New types in `src/api/schemas/task.ts`:

```ts
const TaskCreatedSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    date_add: z.string(),
    due_date: z.string().nullable().optional(),
    due_date_end: z.string().nullable().optional(),
    worker: UserBasicSchema.nullable().optional(),
    priority_enum: z.string().nullable().optional(),
    labels: z.array(TaskLabelSchema).optional(),
    tracking_users: z.array(UserBasicSchema).optional(),
    subtasks: z
      .array(z.object({ id: z.number().int(), task_id: z.number().int(), name: z.string() }).passthrough())
      .optional(),
  })
  .passthrough();

export type TaskCreated = z.output<typeof TaskCreatedSchema>;

// Body-builder input (CLI-side type, not from wire):
export type CreateTaskInput = {
  name: string;
  due?: string;             // YYYY-MM-DD (CLI form; converted to YYYY-MM-DDT00:00:00Z on the wire)
  worker?: number;
  priority?: 'low' | 'normal' | 'high'; // mapped to 'l'|'m'|'h'
  labels?: readonly string[];           // names; sent as TaskLabelAddInput { name }
  description?: string;
};

export type CreateTaskBody = {
  name: string;
  due_date?: string;
  worker?: number;
  priority_enum?: 'h' | 'm' | 'l';
  comment?: { content: string };
  labels?: { name: string }[];
};
```

`buildCreateTaskBody(input: CreateTaskInput): CreateTaskBody` is a pure function — easy to unit-test without MSW.

`createTask(client, opts: { projectId: number, tasklistId: number, body: CreateTaskBody, requestId?: string })` is a thin wrapper that calls `client.request({ method: 'POST', path: '/project/{p}/tasklist/{t}/tasks', body, schema: TaskCreatedSchema })` and returns `{ task: TaskCreated, raw: ApiResponse<unknown> }`.

## 6. Edge cases

- **Tasklist lookup failure** in startup (`GET /tasklist/{id}` returns 404 / 403): mapped to a single `FreeloApiError` and the create is never attempted. In batch mode, this is a startup-time error — emitted once, exit 1, NDJSON stream is never opened.
- **`worker` repeated on CLI**: only the first id is sent; envelope carries a `notice` field listing the discarded ids. (R10 will offer the proper "change assignment" verb.)
- **Empty `--label`** entries (e.g. `--label ""`): rejected with `ValidationError`.
- **Label name trim**: leading/trailing whitespace on `--label foo  ` is preserved (Freelo treats `"foo"` and `"foo "` as different labels). We do not silently trim; if a user wants to clean up, they pass clean strings.
- **`--description-file` not UTF-8 decodable**: caught by Node's read; surfaced as `ValidationError` with the original message.
- **`--description-file` is a directory**: `ValidationError`.
- **Stdin with no lines** (empty input or only blanks): emit nothing and exit 0. Optional: emit a single `notice`-only envelope? **No** — silent success keeps NDJSON consumers happy. Decision 9.
- **Stdin with thousands of lines**: each line is processed sequentially (one in-flight request at a time). Concurrency is left for a future optimization (would need rate-limit-aware queueing); v1 is correct-first.
- **SIGINT mid-batch**: handled by the existing `signal` plumbing on `HttpClient`; in-flight call aborts → 130, no further lines processed. The streamer never re-orders or buffers, so partial output already on stdout is consistent.
- **No `paging`**: writes don't paginate. Field is absent from the envelope.
- **Rate-limit on a write (429)**: `HttpClient` already throws `RateLimitedError` for writes without retry (correct behavior — see `client.ts:142-151`). The CLI surfaces it; the user / agent retries.

## 7. Non-goals (R09 explicit out-of-scope)

- `--editor` flag (deferred to R15 with the rest of the description-set surface).
- `--description-file` in batch mode (the `description` JSON field is the path).
- Subtasks on create (`subtasks[]`) — out of scope.
- `tracking_users_ids[]` and `turn_off_authors_tracking` — out of scope.
- `due_date_end` (range due-dates) — out of scope.
- `--dry-run` skipping the tasklist lookup by default (use `--project` as the dry-run-only escape hatch).
- Concurrent batch mode (parallelism) — sequential only in v1.
- Idempotency keys — no synthetic dedup; create is non-idempotent by definition.
- Discoverability sub-flags (`--tasklist <name>`) — id-only, like every R07/R08 flag.

## 8. Open questions

None. Every open scope-affecting question above has been resolved as a logged decision (decisions 1–9, in `docs/decisions/2026-04-27-tasks-create-N-...md`).

## 9. Decisions log (autonomous)

1. **Date wire-format** — Send `YYYY-MM-DDT00:00:00Z` for `due_date` since the OpenAPI declares `format: date-time`. Alternative: send `YYYY-MM-DD` raw and let Freelo coerce. Chose append-time-Z form for predictability and to match how the API echoes dates back.
2. **`--editor` deferred** — Roadmap permits R09 to scope down; R15 (`tasks description set`) is the better home for terminal-editor I/O. Decision: drop `--editor` from R09.
3. **`project_id` derived from `--tasklist`** — Avoid forcing the user to remember the project id. One-shot `GET /tasklist/{id}` (existing R06 wrapper). Alternative: also accept `--project` always. Chose derive-by-default; `--project` only as a `--dry-run` escape hatch (decision 8).
4. **Repeatable `--worker`, first-only on wire** — Forward-compat with R10's interface. Alternative: `ValidationError` on repeats. Chose silent-first-with-notice for ergonomic alignment with `--label` repeatable.
5. **`description-file` not allowed in `--stdin` mode** — Path-traversal surface; agents should pre-resolve. Alternative: support per-line `description_file`. Chose reject-with-validation-error.
6. **Per-line `tasklist` rejected** — The `--tasklist` flag is the contract for batch. Per-line override would force a project-id lookup per line. Rejecting is simpler.
7. **Batch exit code: numerically highest wins** — Non-zero on any failure. HTTP/network/rate-limit (4/5/6) dominate validation (2). Matches POSIX practice (most-severe wins) and lines up with the canonical exit-code mapping in `src/errors/*.ts`.
8. **`--project` as dry-run escape hatch** — In `--dry-run`, allow `--project` to skip the tasklist lookup. Else `--project` is rejected (the project id is derived). Logged because it's a small UX wart but worth the savings on dry-runs.
9. **Empty stdin = silent success, exit 0** — NDJSON-consuming agents prefer empty over a sentinel envelope.

(Decisions are written individually to `docs/decisions/2026-04-27-tasks-create-<n>-<slug>.md` files at implementation time so each is independently grep-able. The summaries above are the index.)

---

## Plan

> **Plan rule:** the plan is the contract. If implementation deviates, update the plan first.

### 10. File-level TODOs

#### New files

1. **`src/lib/dry-run.ts`** — single export `dryRunEnvelope({ schema, would, extra })` that builds an `Envelope<T>` with `dry_run: true` and the `would` block. Pure, no I/O. Reused by R10–R13.
2. **`src/lib/batch.ts`** — NDJSON streamer:
   - `parseNdjsonLine(line: string, lineIndex: number, schema: ZodTypeAny): { ok: true, value: T } | { ok: false, error: ValidationError }`
   - `streamNdjson(opts: { input: AsyncIterable<string>, lineSchema, perLine: (parsed, idx) => Promise<Envelope<T>|ErrorEnvelope> })` — async generator yielding stringified NDJSON lines. Tracks max-seen exit code and exposes it.
   - `iterateLines(stdin: NodeJS.ReadableStream): AsyncIterable<string>` — reads chunks, splits on `\n`/`\r\n`, yields trimmed non-empty lines.
   - All exports pure (no `process.exit`, no logger). Reused verbatim by R10–R13.
3. **`src/api/tasks-create.ts`** — *(decision: separate file from `src/api/tasks.ts` to keep the read/write surfaces independently scannable and the existing `tasks.ts` unchanged.)*
   - `buildCreateTaskBody(input: CreateTaskInput): CreateTaskBody`
   - `createTask(client, opts): Promise<{ task: TaskCreated, raw: ApiResponse<unknown> }>`
4. **`src/commands/tasks/create.ts`** — Commander leaf. Mirrors structural shape of `src/commands/tasks/list.ts`. Delegates the body-build, the HTTP, and the streaming. Owns:
   - flag parsing & validation
   - mode dispatch (single vs. stdin)
   - tasklist→project lookup (`getTasklistDetail` from R06)
   - dry-run vs. live envelope build
   - human renderer call
5. **`src/ui/human/tasks-create.ts`** — single-task human renderer. Roughly:
   ```
   Created task #9012 (Audit auth flow) in tasklist 314 (project 42).
   ```
   And in `--dry-run`: `(dry-run) Would create task in tasklist 314 (project 42).`
   Batch human-mode: per-line `Created #N` / `Failed line N: <message>` lines.
6. **`test/commands/tasks/create.test.ts`** — vitest + MSW. Covers (one named test per row):
   - happy path: minimal flags, JSON output, schema string
   - happy path: every flag set, body-builder output asserted on the wire
   - happy path: human-mode rendering snapshot
   - happy path: `--description-file` reads UTF-8
   - happy path: `--label` repeated → 2 `TaskLabelAddInput` items on wire
   - happy path: `--worker` repeated → first-only on wire + `notice` in envelope
   - dry-run: no HTTP for create; one HTTP for tasklist lookup; envelope carries `dry_run: true` + `would`
   - dry-run + `--project`: no HTTP at all; envelope carries the user-supplied project id
   - validation: missing `--tasklist` → `VALIDATION_ERROR` exit 2
   - validation: missing `--name` (single mode) → `VALIDATION_ERROR` exit 2
   - validation: `--name` AND `--stdin` → `VALIDATION_ERROR` exit 2
   - validation: bad `--due` → exit 2
   - validation: bad `--priority` → exit 2
   - validation: `--description` AND `--description-file` → exit 2
   - validation: `--description-file` path missing → exit 2
   - validation: `--description-file` AND `--stdin` → exit 2
   - validation: empty `--label` → exit 2
   - api: 404 from tasklist lookup → `FREELO_API_ERROR` exit 1, no second HTTP call
   - api: 403 from POST (worker not assignable) → `FREELO_API_ERROR` exit 1
   - api: 429 from POST → `RATE_LIMITED` exit 1, retryable: true
   - network: fetch throws → `NETWORK_ERROR` exit 1
   - batch: stdin 3 lines, all succeed → 3 NDJSON success envelopes, exit 0, line_index 0/1/2
   - batch: stdin 1 valid + 1 bad-JSON + 1 valid → 2 success + 1 error envelope, exit 2
   - batch: stdin 1 valid + 1 422-from-API → 1 success + 1 error envelope, exit 1
   - batch: stdin line carries `tasklist` field → error envelope for that line
   - batch: stdin empty → exit 0, no output
   - batch: `--description-file` flag rejected with `--stdin` → exit 2
   - introspect: `freelo --introspect` includes `tasks create` with `output_schema: 'freelo.tasks.create/v1'`, `destructive: false`
   - **Calibration §4:** `--all` no, but try/catch points covered: tasklist-lookup catch, per-line parse catch, per-line POST catch — each has its own test row
7. **`test/lib/dry-run.test.ts`** — pure unit tests for `dryRunEnvelope`.
8. **`test/lib/batch.test.ts`** — pure unit tests for `parseNdjsonLine` (good/bad/JSON edge), `iterateLines` (CRLF, empty lines, trailing-no-newline), `streamNdjson` (yields per-line, propagates exit code).
9. **`test/api/tasks-create.test.ts`** — pure unit test for `buildCreateTaskBody` mapping (priority enum mapping, date format, label → TaskLabelAddInput conversion, undefined-field omission).
10. **`test/fixtures/tasks/create-9012.json`** — scrubbed `TaskCreated` response for happy-path tests.
11. **`.changeset/<random-hash>.md`** — `freelo-cli: minor` — "Add `freelo tasks create` (R09). Adds shared write infrastructure (`--dry-run`, `--stdin` NDJSON streaming) reused by all later writes. New envelope schema `freelo.tasks.create/v1` (additive — public contract)."

#### Modified files

12. **`src/api/schemas/task.ts`** — append `TaskCreatedSchema` + `CreateTaskInput` / `CreateTaskBody` types and re-export `TaskCreated`. No changes to existing R07 / R08 types.
13. **`src/commands/tasks.ts`** — register the new `create` leaf (one new line + one import).
14. **`README.md`** — autogen Commands block — regenerated by `pnpm fix:readme` in the doc phase. **Do not hand-edit.**
15. **`docs/commands/tasks-create.md`** — VitePress page: synopsis, flags, NDJSON shape, two real-world examples, link to envelope schema.
16. **`docs/getting-started.md`** — append a one-paragraph "Creating tasks" section with one example.
17. **`docs/specs/0019-tasks-create.md`** — this file.

#### No-touch (paranoia checklist)

- `src/config/**` — none.
- `src/api/client.ts` — none.
- `src/bin/freelo.ts` — none. Top-level handler already supports the new commands automatically.
- `src/errors/*` — no new error classes (every case maps to existing classes per §4).

### 11. Dependencies

**No new runtime deps. No new dev deps.** `zod`, `commander`, `undici` (via `client.ts`) cover the surface.

### 12. Test strategy

- **Unit** layer: `src/lib/dry-run.ts`, `src/lib/batch.ts`, `buildCreateTaskBody`. No I/O, no MSW, no Commander. Fast.
- **Integration** layer: `test/commands/tasks/create.test.ts` boots the program end-to-end with MSW handlers and stdin redirect. Asserts: stdout content (envelope shape), exit code, MSW-recorded request body for the POST.
- **Coverage targets** (project-wide thresholds in `vitest.config.ts`): 80% lines / 90% on `src/api/` and `src/commands/`. Calibration §4: each new try/catch arm has a dedicated test.
- **Snapshot use**: only for human-mode renderers (R09 has one — the create-success line); reviewed on update.
- **Fixture rule**: no real data; the `create-9012.json` fixture uses synthetic ids and synthetic user/label names.

### 13. Slicing

R09 is one slice (~600 LOC including tests). No need to subdivide.

### 14. Implementation order

1. Add the `TaskCreatedSchema` + types to `src/api/schemas/task.ts` (no logic — just shape).
2. Write `src/lib/dry-run.ts` (smallest unit, no deps).
3. Write `src/lib/batch.ts`. Unit-test in isolation.
4. Write `src/api/tasks-create.ts`. Unit-test the body builder.
5. Write `src/commands/tasks/create.ts`. Integration-test against MSW.
6. Wire into `src/commands/tasks.ts`.
7. `pnpm typecheck && pnpm lint && pnpm test --coverage && pnpm build && pnpm check:readme` on a clean tree (calibration §3).
8. Hand off to test-writer for any gaps; then code-reviewer; then doc-writer (regenerates README block via `pnpm fix:readme`).
9. Add changeset, commit, push, open PR.

### 15. Risk callouts for the implementer

- **Calibration §1** — when interrupted, run **every** remaining phase before pushing. No shortcut.
- **Calibration §2** — every typed error class in §4 must have an exit-code-asserting test.
- **Calibration §3** — gates run on the **committed** tree post-commit, not the working tree.
- **Calibration §4** — try/catch arms each get a test row.
- **Calibration §6** — branch from a clean `main`, not from whatever HEAD happens to be.
- **First write** — design `src/lib/dry-run.ts` and `src/lib/batch.ts` to be reusable but *minimal*. Avoid speculative parameters. R10–R13 will tell us what they actually need.

ARCHITECT run=2026-04-27-tasks-create status=ok spec=docs/specs/0019-tasks-create.md open_questions=0 new_deps=0
