# Spec 0025 — `freelo subtasks list` / `subtasks add` (R14)

**Status:** Draft → Implement
**Run:** 2026-04-27-2300-subtasks-list-add
**Tier:** Yellow
**Roadmap:** R14 (`docs/roadmap.md`:303-315)
**Depends on:** R08 (`SubtaskSchema` in `src/api/schemas/task.ts`, `getTaskSubtasks` in `src/api/tasks.ts`), R09 (write infra: `--dry-run`, `dryRunEnvelope`), R12.5 (`--stdin` per-row pattern)

---

## 1. Problem

R14 is the first vertical slice for the **subtasks** resource. Today an agent driving the CLI can only **see** subtasks via the `--with subtasks` side-car of `freelo tasks show <id>` (R08). There is no way to list them as a primary view, and no way to **create** a subtask at all without falling back to raw REST. R14 closes both gaps:

- `freelo subtasks list --task <id>` — a primary view that paginates subtasks for one parent task, identical-shape envelope across pages.
- `freelo subtasks add --task <id> --name <str> [--worker <id>] [--due YYYY-MM-DD]` — a write that creates one subtask per invocation, surfacing the **smart-vs-simple fallback** (the API auto-degrades from a smart taskcheck to a simple checklist row when the parent's tasklist can't host smart ones).

This is also the first slice under the brand-new top-level `subtasks` subcommand. Wave 2 deferred subtask delete to a later slice; R14 is read + add only.

## 2. API surface

### 2.1 `GET /task/{task_id}/subtasks` (`getSubtasksInTask`)

OpenAPI :2380-2415.

- **Path:** `/task/{task_id}/subtasks`
- **Query:** `p=N` (0-indexed page), wrapped in `PaginatedResponse` shape (`{ total, count, page, per_page, data: { subtasks: Subtask[] } }`).
- **Response shape:** `Subtask` items per OpenAPI :5482-5530. Already declared in code as `SubtaskSchema` (`src/api/schemas/task.ts:373`); R08 ships it.
- **Existing wire wrapper:** `getTaskSubtasks(client, taskId, { page, signal?, requestId? })` (`src/api/tasks.ts:208-222`). **No change needed** — R14 reuses it byte-for-byte.

### 2.2 `POST /task/{task_id}/subtasks` (`createSubtask`)

OpenAPI :2416-2443.

- **Path:** `/task/{task_id}/subtasks`
- **Body** (`SubtaskCreate`, OpenAPI :5450-5481):
  ```yaml
  required: [name]
  properties:
    name: string
    due_date: string (date-time)
    due_date_end: string (date-time)
    worker: integer
    priority_enum: l|m|h
    comment: { content: string }
    labels: TaskLabelAddInput[]
    tracking_users_ids: integer[]
  ```
- **Response:** `Subtask` (the same shape returned by GET).

#### 2.2.1 Smart-vs-simple fallback (the headline UX feature)

OpenAPI :2425 documents the server behavior verbatim:

> The server first attempts to create a **smart taskcheck** — a full-featured subtask with worker, due date, tracking users, etc. If the parent task is not eligible for smart taskchecks (e.g. it's a multi-project parent, or a nested smart taskcheck), the code catches `SmartTaskcheckCanNotBeCreatedException` and silently falls back to creating a **simple taskcheck** (a checkbox item with just a name). The body you sent may be partially discarded in that case — extra fields like `worker`, `due_date`, `tracking_users_ids` are ignored for simple taskchecks.

The CLI must:

1. Mention this in `freelo subtasks add --help` (roadmap-mandated UX requirement).
2. Surface the **observed storage form** in the response envelope so agents can route on it.

The challenge: the API does not return an explicit `kind` / `storage_form` field. We infer it from the response `Subtask` — a **smart** taskcheck has the rich fields populated (`worker`, `due_date`, `state`, `tasklist`, `project`); a **simple** taskcheck typically returns only `id` + `name` + `task_id` (and possibly `date_add`). See decision 3 for the exact heuristic.

#### 2.2.2 ACL-filtered tracking users

OpenAPI :2426 — `tracking_users_ids` is silently filtered server-side. R14 v1 does **not expose `--tracking-user`** (decision 7), so this quirk doesn't surface; documented for the future.

### 2.3 No new wire schemas

`SubtaskSchema` already exists. We add **only** envelope-data schemas (CLI-side) and a SubtaskCreate body type — no new entity wire schemas.

## 3. CLI surface

### 3.1 New top-level subcommand

```
freelo subtasks list --task <id> [--page N|--all]
freelo subtasks add  --task <id> --name <str> [--worker <id>] [--due YYYY-MM-DD]
                                              [--dry-run]
                                              [--stdin]            # NDJSON batch
```

The parent `subtasks` is registered exactly like `tasks` / `tasklists` / `projects`: a thin `register(program, getConfig, env)` in `src/commands/subtasks.ts` that creates the `subtasks` subcommand and delegates each leaf to a `register*` factory.

### 3.2 `freelo subtasks list --task <id>`

#### Flags

- `--task <id>` — required; positive-integer parent task id.
- `--page <N>` — optional; 0-indexed page, mutually exclusive with `--all`. Default: 0 (matches R03/R04 paging convention).
- `--all` — optional; iterate `?p=0,1,…` until exhausted. Mutex with `--page`.

#### Output schema: `freelo.subtasks.list/v1`

Envelope `data`:

```jsonc
{
  "task_id": 9012,             // parent task id (echoed for round-trip clarity)
  "subtasks": [Subtask, ...]   // entity shape per SubtaskSchema (R08)
}
```

Envelope-level fields:

- `paging`: present on every response (mirrors R03 behavior, even single-page).
  - When `--page N` (default-0 included): the `paging` object reflects the actual fetched page.
  - When `--all`: a synthesized object with `page: 0, per_page: <merged-length>, total: <observed-total>, next_cursor: null` (mirrors R03 `--all` convention).
- `rate_limit`: from the last GET (last fetched page when `--all`).

#### Human renderer

`cli-table3` with columns `id`, `name`, `worker`, `due_date`, `state`. Empty list → "No subtasks." line.

### 3.3 `freelo subtasks add --task <id> --name <str> [...]`

#### Flags

| Flag | Required? | Type | Notes |
|---|---|---|---|
| `--task <id>` | yes | positive int | Parent task id. |
| `--name <str>` | yes (single mode) | non-empty string | Subtask title. Forbidden in batch mode (per-line `name` only). |
| `--worker <id>` | no | positive int | Worker user id. May be ignored on the smart→simple fallback path (surfaced in envelope). |
| `--due <YYYY-MM-DD>` | no | ISO date | Mapped to `<date>T00:00:00Z` on the wire (mirrors R09 / spec 0019 §5). |
| `--dry-run` | no | boolean | Skip the POST; envelope echoes the body. |
| `--stdin` | no | boolean | Read NDJSON from stdin (one `{"name": …, …}` per line). Mutex with `--name`. |

`--worker` is **not** repeatable in v1 (decision 5). Roadmap text uses singular `--worker <id>` so we honor that contract; if a user wants multiple workers they should ride R10 (`tasks edit`) on a follow-up.

#### Output schema: `freelo.subtasks.add/v1`

Envelope `data`:

```jsonc
{
  "task_id": 9012,                // parent task id (echoed)
  "subtask": Subtask,             // server response, validated through SubtaskSchema
  "storage_form": "smart" | "simple",  // inferred from response (decision 3)
  "input_ignored": ["worker", "due"],  // optional — fields the user passed that the server discarded (only present when storage_form === 'simple' AND those fields were set in the request)
  "would": {                      // only in --dry-run
    "method": "POST",
    "path": "/task/9012/subtasks",
    "body": { "name": "...", ... }
  },
  "line_index": 0                 // only in --stdin batch mode (0-indexed across non-empty lines)
}
```

`storage_form`:

- `"smart"` — response carries any of: `worker.id != null`, `due_date != null`, `state` (with `state: 'active'`), `tasklist.id`, `project.id`. Detection heuristic in §4.4.
- `"simple"` — response is the lean `{ id, task_id, name, date_add? }` shape (decision 3). The body the server *received* may have included `worker` / `due` / `priority` / `description`, but those are silently discarded.

> **Corrected 2026-08-30 (R14).** The lean shape above is wrong about `task_id`. A live
> capture shows a *simple* taskcheck returns `task_id: null`; a populated `task_id` means
> the subtask is **smart** (`type: 'subtask'`). The error was harmless in practice only
> because `inferStorageForm` never inspects `task_id`. See
> `docs/runs/2026-08-29-2230-r14-subtask-type/fixture-capture.md`. The same capture shows
> `type` is returned by `GET` but **not** by `POST`, which is why §4.4's heuristic stays.

`input_ignored` is **only** populated on the `simple` path AND only for fields the user actually set — never echoes flags the user didn't pass. Empty array is omitted (not emitted as `[]`).

#### Help text (roadmap-mandated)

The command's `--help` output ends with a paragraph (description suffix) saying:

> Note: Freelo's API auto-falls-back from a **smart subtask** (full task with worker, due date, etc.) to a **simple taskcheck** (a checkbox row with only a name) when the parent's tasklist can't host smart ones. The response envelope's `data.storage_form` field reflects which form was actually persisted; `data.input_ignored[]` lists fields you set that the server discarded on the simple path.

#### Confirmation gate

**None.** `subtasks add` is **additive**, not destructive (CLAUDE.md "Writes are agent-safe" — destructive ops require `--yes`; additive writes do not). No `confirmDestructive` call. Mirrors R09 (`tasks create`).

### 3.4 Batch input (`--stdin` NDJSON)

Mirrors `tasks create --stdin` and `tasks move --stdin` (R09 / R12.5). Per-line schema (zod-strict):

```jsonc
{
  "name": "string (required, non-empty)",
  "worker": 123,            // optional positive int
  "due": "YYYY-MM-DD"        // optional ISO date
}
```

Continue-on-error semantics (matches R09 / R11 / R12.5 default):

- Each line independently validates → POST → emits one envelope.
- A bad line emits a `freelo.error/v1` envelope with `context.line_index` and the run continues.
- Final exit code = max of all observed exit codes (success=0, validation=2, network=5, etc.).

`--task` is shared per-batch (single value on the command line, applied to every row). Per-line `task` is **rejected** (mirrors R09's per-line `tasklist` rejection).

### 3.5 Single-id vs. multi-id error semantics

Mirrors R09:

- Single-mode (no `--stdin`): errors bubble to top-level → one error envelope on stderr.
- `--stdin`: per-line error envelopes on stdout (the success stream); highest exit code wins at end-of-loop.

## 4. Data model

### 4.1 Wire — already declared

- `SubtaskSchema` (`src/api/schemas/task.ts:373`) — response shape for both GET and POST.
- The paginated wrapper for GET is handled by `normalizePaginated(raw, 'subtasks', SubtaskSchema)` already in `getTaskSubtasks` (`src/api/tasks.ts:208`).

### 4.2 New CLI-side types

In `src/api/schemas/subtask.ts` (new file — keeps R14's surface scoped, mirrors `tasks-delete` pattern that lives in `task.ts` only because it's a tiny addendum):

```ts
import { z } from 'zod';
import { SubtaskSchema } from './task.js';

/**
 * `freelo.subtasks.list/v1` envelope `data` shape.
 *
 *   - `task_id`: parent task id (echoed for round-trip clarity).
 *   - `subtasks`: zero-or-more `Subtask` records (R08 SubtaskSchema).
 */
export const SubtasksListDataSchema = z.object({
  task_id: z.number().int(),
  subtasks: z.array(SubtaskSchema),
});

export type SubtasksListData = z.infer<typeof SubtasksListDataSchema>;

/**
 * Storage form of a created subtask, inferred from the response shape.
 * See spec 0025 §4.4 for the inference heuristic.
 */
export const SubtaskStorageFormSchema = z.enum(['smart', 'simple']);
export type SubtaskStorageForm = z.infer<typeof SubtaskStorageFormSchema>;

/**
 * `freelo.subtasks.add/v1` envelope `data` shape.
 *
 *   - `task_id`: parent task id (echoed).
 *   - `subtask`: server response, validated through SubtaskSchema.
 *   - `storage_form`: `'smart' | 'simple'`. Inferred from response (§4.4).
 *   - `input_ignored`: only present on `simple` path AND only for fields the
 *     user set that the server discarded. Always a non-empty array when
 *     present.
 *   - `would`: only in `--dry-run` envelopes.
 *   - `line_index`: only in `--stdin` batch mode.
 */
export const SubtasksAddDataSchema = z.object({
  task_id: z.number().int(),
  subtask: SubtaskSchema,
  storage_form: SubtaskStorageFormSchema,
  input_ignored: z.array(z.enum(['worker', 'due'])).optional(),
  would: z
    .object({
      method: z.literal('POST'),
      path: z.string(),
      body: z.unknown(),
    })
    .optional(),
  line_index: z.number().int().nonnegative().optional(),
});

export type SubtasksAddData = z.infer<typeof SubtasksAddDataSchema>;

/**
 * CLI-side input shape passed to `buildCreateSubtaskBody`.
 */
export type CreateSubtaskInput = {
  name: string;
  due?: string;          // YYYY-MM-DD, mapped to `<date>T00:00:00Z`
  worker?: number;
};

/**
 * Wire-shape of the POST body. Subset of `SubtaskCreate` (OpenAPI :5450-5481)
 * for the v1-supported flag set.
 */
export type CreateSubtaskBody = {
  name: string;
  due_date?: string;
  worker?: number;
};
```

**Note:** for `--dry-run`, the `subtask` field would not be present (no server response). The Schema has `subtask: SubtaskSchema` (required) which would fail in a dry-run envelope. **Resolution:** make `subtask` `.optional()` and document that it is **always** present in live envelopes and **never** present in dry-run envelopes (mirrors R09 `TasksCreateDataSchema.task: TaskCreatedSchema.optional()`). Updated schema — single change to the snippet above:

```ts
  subtask: SubtaskSchema.optional(),    // present in live; absent in --dry-run
```

Similarly `storage_form` is **omitted** in `--dry-run` envelopes (we do not pretend to know which form the server would pick). Schema becomes `.optional()` for both `subtask` and `storage_form`.

### 4.3 Wire wrappers

New file `src/api/subtasks.ts`:

```ts
import { type ApiResponse, type HttpClient } from './client.js';
import { SubtaskSchema, type Subtask } from './schemas/task.js';
import { type CreateSubtaskBody, type CreateSubtaskInput } from './schemas/subtask.js';

/**
 * `POST /task/{task_id}/subtasks` — create a subtask. Server may transparently
 * fall back from a smart taskcheck to a simple taskcheck (OpenAPI :2425).
 * The CLI infers the storage form from the response shape (§4.4); this
 * wrapper only validates and returns the raw response.
 */
export type CreateSubtaskOpts = {
  taskId: number;
  body: CreateSubtaskBody;
  signal?: AbortSignal;
  requestId?: string;
};

export type CreateSubtaskResult = {
  subtask: Subtask;
  raw: ApiResponse<Subtask>;
};

export async function createSubtask(
  client: HttpClient,
  opts: CreateSubtaskOpts,
): Promise<CreateSubtaskResult> {
  const raw = await client.request({
    method: 'POST',
    path: createSubtaskPath(opts.taskId),
    body: opts.body,
    schema: SubtaskSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { subtask: raw.data, raw };
}

export function createSubtaskPath(taskId: number): string {
  return `/task/${taskId}/subtasks`;
}

/**
 * Map CLI input → wire body. Same `due → due_date + T00:00:00Z` mapping
 * as `tasks create`.
 */
export function buildCreateSubtaskBody(input: CreateSubtaskInput): CreateSubtaskBody {
  const body: CreateSubtaskBody = { name: input.name };
  if (input.due !== undefined) body.due_date = `${input.due}T00:00:00Z`;
  if (input.worker !== undefined) body.worker = input.worker;
  return body;
}
```

`getTaskSubtasks` is reused as-is from `src/api/tasks.ts:208` — already written for R08.

### 4.4 Storage-form inference heuristic

**Decision 3.** The Freelo response does not include an explicit `kind` field. We infer:

```ts
function inferStorageForm(s: Subtask): SubtaskStorageForm {
  // Smart taskcheck → response carries rich task fields. Any one is enough.
  if (
    s.worker != null ||
    s.due_date != null ||
    s.due_date_end != null ||
    s.state != null ||
    s.tasklist != null ||
    s.project != null
  ) {
    return 'smart';
  }
  return 'simple';
}
```

The `SubtaskSchema` (R08) makes all these `.nullable().optional()`, so a simple-shape response (e.g. `{ id, task_id, name, date_add }`) will pass validation with the rich fields absent → `inferStorageForm` returns `'simple'`. A smart-shape response will have at least `worker` or `state` populated → `'smart'`.

**Limitation accepted in v1:** if the server ever returns a smart-shape response with **all** worker/due/state/tasklist/project null (e.g. a smart subtask created with only `--name` and no worker), our heuristic mis-classifies it as `'simple'`. This is the only known false-negative; we surface a notice in §10 but accept it for v1 because (a) the only way to falsify the smart-form post-creation is to have set no rich fields up front, and (b) when the user passes only `--name` and the server returns a lean shape, calling it "simple" is *functionally* correct — there is no rich data to expose either way. Documented in decision 3.

### 4.5 `input_ignored[]` derivation

Computed only when `storage_form === 'simple'` AND the user set the corresponding CLI flag:

```ts
const inputIgnored: ('worker' | 'due')[] = [];
if (storageForm === 'simple') {
  if (input.worker !== undefined) inputIgnored.push('worker');
  if (input.due !== undefined) inputIgnored.push('due');
}
// Emit data.input_ignored only when non-empty.
```

## 5. Edge cases

| Case | Behaviour |
|---|---|
| `--task` missing | `ValidationError` (exit 2) at parse-time. |
| `--task` non-numeric / zero / negative | `ValidationError` (exit 2). |
| `--name` missing in single mode | `ValidationError` (exit 2). |
| `--name` empty string | `ValidationError` (exit 2). |
| `--name` + `--stdin` | `ValidationError` — `--name` belongs to single mode. |
| `--page` and `--all` together | `ValidationError` (exit 2). |
| `--due` invalid format | `ValidationError` (exit 2). |
| `--worker` non-numeric / zero / negative | `ValidationError` (exit 2). |
| `subtasks list`, parent task 404 | `FreeloApiError` `code: NOT_FOUND` with hint rewrite ("Task X not found, or your account does not have access."). Exit 4. |
| `subtasks list`, parent task 403 | `FreeloApiError` `code: FORBIDDEN` with hint rewrite. Exit 4. |
| `subtasks list --all`, mid-stream failure after 1+ pages | `PartialPagesError` propagates → command emits success envelope with the partial accumulator + sets `notice` on the envelope (mirrors R03 / R04). Exit code derived from the inner cause. |
| `subtasks add` to a parent that already has a smart subtask in its lineage | Server falls back → response is `simple` shape → CLI emits `storage_form: 'simple'` and `input_ignored[]` if applicable. Exit 0 (this is success). |
| `subtasks add --stdin` empty | Silent success exit 0 (matches R09 / R11 / R12.5). |
| `subtasks add --stdin` all-bad lines | Per-line error envelopes, exit 2. No client built (lazy — mirrors R09). |
| `subtasks add` 401 / 403 / 404 / 429 / 5xx / network | Standard error mapping per `src/api/client.ts`. Exit codes 3/4/4/6/4/5 respectively. |

## 6. Non-goals

- No `subtasks delete`, `subtasks edit`, `subtasks finish` in v1. Tracked for future slices.
- No `--worker` repetition (singular per roadmap; multiple workers via R10).
- No `--priority`, `--description`, `--label`, `--tracking-user` flags. SubtaskCreate accepts them, but the roadmap explicitly lists only `--worker` and `--due` for v1; richer flags can land later as a strict additive expansion (no schema bump — `data.subtask.*` already passes through anything the API returns).
- No `subtasks show` (single-subtask detail). Subtasks are addressable through `tasks show <id> --with subtasks` already.
- No idempotency for `subtasks add` (creating two subtasks with the same name is intentionally allowed — it's not an absorbing-state op).

## 7. Open questions

None. The OpenAPI spec resolves the smart-vs-simple question (§2.2.1, OpenAPI :2425); the storage-form inference heuristic in §4.4 is decided autonomously per `.claude/docs/autonomous-sdlc.md` "Zod schema shape when spec is present → Decide, log".

## 8. Mandatory tests

Per Calibration §1-4. **Every error path that the spec assigns an exit code MUST have a test asserting that exit code.**

### 8.1 `subtasks list --task <id>` (mirrors `tasks/show.test.ts` paginated subtasks pattern)

Happy paths:

1. Single page, default `--page 0`: envelope `schema: 'freelo.subtasks.list/v1'`, `data.task_id`, `data.subtasks` array, `paging.page: 0`, `paging.next_cursor: null` (when fewer than per_page items). Exit 0.
2. Single page, `--page 1`: envelope reflects `paging.page: 1`.
3. `--all`, two pages: merged `data.subtasks.length === sum`, `paging.page: 0`, `paging.next_cursor: null`, `paging.total === 2nd-page-total`. Exit 0.
4. Empty subtasks (zero items): `data.subtasks: []`, `paging.total: 0`, no notice. Exit 0.
5. Human renderer: `cli-table3` table on TTY, "No subtasks." line on empty.

Validation:

6. `--task` missing → `VALIDATION_ERROR` (exit 2).
7. `--task` non-numeric → `VALIDATION_ERROR` (exit 2).
8. `--task` zero / negative → `VALIDATION_ERROR` (exit 2).
9. `--page` and `--all` together → `VALIDATION_ERROR` (exit 2).
10. `--page <neg>` → `VALIDATION_ERROR` (exit 2).

HTTP errors:

11. GET 401 → `AUTH_EXPIRED`, exit 3.
12. GET 403 → `FORBIDDEN`, exit 4. Hint mentions "permission to view subtasks for task X".
13. GET 404 → `NOT_FOUND`, exit 4. Hint mentions "Task X not found, or no access".
14. GET 429 (no retry on writes; reads retry up to 3 — see client.ts) → after retry exhaustion, `RATE_LIMITED`, exit 6.
15. GET 5xx → `SERVER_ERROR`, exit 4.
16. GET network failure → `NETWORK_ERROR`, exit 5.

Pagination edge:

17. `--all`, mid-stream 5xx after 1 successful page → success envelope with partial data + notice; exit code derived from the inner cause (5xx → 4).

Introspect:

18. `freelo --introspect` shows `subtasks list` with `output_schema: 'freelo.subtasks.list/v1'` and `destructive: false`.

### 8.2 `subtasks add --task <id> --name <str>` (mirrors `tasks/create.test.ts` shape)

Happy paths (single):

19. Smart-shape response (`{id, name, worker, due_date, state: {state: 'active'}, …}`) → `data.storage_form: 'smart'`, `data.subtask` populated, no `input_ignored`. Exit 0.
20. Simple-shape response (`{id, task_id, name, date_add}`) with no extra flags → `data.storage_form: 'simple'`, no `input_ignored`. Exit 0.
21. Simple-shape response, user passed `--worker` and `--due` → `data.storage_form: 'simple'`, `data.input_ignored: ['worker', 'due']`. Exit 0.
22. `--dry-run`: no POST, envelope has `dry_run: true`, `data.would.method: 'POST'`, `data.would.path: '/task/9012/subtasks'`, `data.would.body.name: ...`. `data.subtask` and `data.storage_form` absent. Exit 0.
23. Human renderer: "Created subtask #N." on smart, "Created simple taskcheck #N (storage form 'simple'; ignored: worker, due)." on fallback.

Validation (single):

24. `--task` missing → exit 2.
25. `--name` missing → exit 2.
26. `--name` empty → exit 2.
27. `--worker` non-positive → exit 2.
28. `--due` invalid format → exit 2.
29. `--name` + `--stdin` → exit 2.

HTTP errors (single):

30. POST 401 → exit 3.
31. POST 403 → exit 4.
32. POST 404 (parent task gone) → exit 4. Hint mentions "Task X not found, or no access".
33. POST 429 → exit 6.
34. POST 5xx → exit 4.
35. POST network failure → exit 5.

Body builder (unit):

36. `buildCreateSubtaskBody({ name: 'a' })` → `{ name: 'a' }` only.
37. `buildCreateSubtaskBody({ name: 'a', due: '2026-05-01' })` → `due_date: '2026-05-01T00:00:00Z'`.
38. `buildCreateSubtaskBody({ name: 'a', worker: 7 })` → `worker: 7`.

Storage-form inference (unit):

39. `inferStorageForm({ id, task_id, name })` (lean) → `'simple'`.
40. `inferStorageForm({ id, name, worker: { id: 7 } })` → `'smart'`.
41. `inferStorageForm({ id, name, due_date: '2026-05-01T00:00:00Z' })` → `'smart'`.
42. `inferStorageForm({ id, name, state: { id: 1, state: 'active' } })` → `'smart'`.

Batch `--stdin` mode:

43. `--stdin` happy: 2 valid lines → 2 success envelopes, each with `line_index`, exit 0.
44. `--stdin` empty input → silent success exit 0.
45. `--stdin` all-bad lines (malformed JSON) → 2 error envelopes with `context.line_index`, exit 2. No client built (lazy).
46. `--stdin` mixed valid + bad-JSON: per-line outputs, exit 2.
47. `--stdin` with `--name` set → exit 2 (validation; mutex).
48. Per-line `task` key in NDJSON → per-line `VALIDATION_ERROR`, exit 2 (mirrors R09's per-line `tasklist` rejection).
49. Per-line missing `name` → per-line `VALIDATION_ERROR`, exit 2.
50. Per-line extra unknown key (zod `.strict`) → per-line `VALIDATION_ERROR`, exit 2.

Introspect:

51. `freelo --introspect` shows `subtasks add` with `output_schema: 'freelo.subtasks.add/v1'` and `destructive: false`.

## 9. Decisions (autonomous)

1. **Top-level subcommand path**: `subtasks` (per roadmap text; mirrors `tasks` / `tasklists` precedent — plural noun for resource collections).
2. **Schema names**: `freelo.subtasks.list/v1`, `freelo.subtasks.add/v1`. Decided per CLAUDE.md envelope contract.
3. **Storage-form inference via response shape**, not a server `kind` field (which doesn't exist). Heuristic: any rich-task field present → `smart`, otherwise `simple`. Limitation: a smart subtask created with no rich fields can mis-classify as `simple`; accepted for v1 (§4.4). Rationale: the only practical signal is the wire-shape difference; the alternative (round-trip GET to confirm) costs an extra request per add and still wouldn't be authoritative.
4. **`input_ignored[]` only on `simple` path**: empty array is omitted (not emitted as `[]`). Matches `paging` / `rate_limit` "absent ⇔ unknown" precedent.
5. **`--worker` is singular, not repeatable**: roadmap text specifies `--worker <id>` (one). Repeating would require a `pickWorkerWithNotice`-style discard policy (R09); not justified for an additive-only v1 slice. Documented as non-goal §6.
6. **No confirmation gate for `subtasks add`**: it's additive, not destructive (CLAUDE.md "destructive ops require `--yes`"). Mirrors R09 / R10.
7. **No `--tracking-user`, `--priority`, `--label`, `--description` flags**: roadmap explicitly lists only `--worker` and `--due` for v1. Strict-additive future expansion is fine; v1 stays minimal.
8. **`--page` defaults to 0** (not omitted): R03 sets the precedent. Always emit `paging`.
9. **`--all` synthesizes `paging`**: `page: 0, per_page: <merged-length>, total: <observed-total>, next_cursor: null`. Matches R03 convention.
10. **NDJSON `--stdin` for `subtasks add`** (optional v1): mirrors `tasks create --stdin` (R09). Per-line schema is `z.object({ name, worker?, due? }).strict()`. Per-line `task` is rejected (mirrors R09's per-line `tasklist` rejection). Continue-on-error semantics. **Decision to ship batch in v1**: yes — the `Writes are agent-safe` working agreement (CLAUDE.md) requires `--stdin` on every write, with NDJSON precedent set in R09. Skipping it would be the anomaly.
11. **Batch confirmation gate**: N/A. `subtasks add` is additive, no confirmation in any mode.
12. **`SubtaskSchema` reused as-is**: R08 has it; no changes. Wire-shape additions (e.g. priority_enum) future-proofed via `.passthrough()`.
13. **No new dependencies**. Lazy `cli-table3` for the human renderer of `list` (existing pattern from R03).
14. **File layout**: `src/commands/subtasks.ts` (parent); `src/commands/subtasks/list.ts`, `src/commands/subtasks/add.ts` (leaves); `src/api/subtasks.ts` (wire wrappers); `src/api/schemas/subtask.ts` (envelope-data schemas). Wire `getTaskSubtasks` reused from `src/api/tasks.ts`. Mirrors `tasks/...` decomposition.
15. **Help-text smart-vs-simple paragraph**: appended to the `add` command's `description`. Visible via `freelo subtasks add --help`. Roadmap-mandated.
16. **`storage_form` absent in `--dry-run` envelopes**: we cannot honestly predict which form the server will pick. The schema marks `storage_form` as `.optional()`. Live envelopes always have it.
17. **Hint rewriter**: `subtasks list` 404/403 → "Task X not found / no access" (mirrors R08's `rewriteDetailHint`). `subtasks add` 404 → same hint (parent task missing). Lives in `src/commands/subtasks/<file>.ts` per existing convention.
18. **Pagination `--all` on `subtasks list`**: reuse `fetchAllPages` from `src/api/pagination.ts` (R03). On mid-stream failure, accumulate partial + notice, mirroring R03.
19. **`request_id` plumbing**: thread through both list and add via `appConfig.requestId`. Mirrors all prior commands.
20. **Test fixtures**: inline `HttpResponse.json(...)` bodies in MSW handlers (mirrors R13). No on-disk JSON fixtures.

## 10. Plan

### 10.1 Files to create

- `src/api/schemas/subtask.ts` (~80 lines) — `SubtasksListDataSchema`, `SubtasksAddDataSchema`, `SubtaskStorageFormSchema`, types.
- `src/api/subtasks.ts` (~70 lines) — `createSubtask(client, opts)`, `createSubtaskPath(taskId)`, `buildCreateSubtaskBody(input)`. `getTaskSubtasks` is reused from `src/api/tasks.ts`, no duplicate.
- `src/commands/subtasks.ts` (~25 lines) — parent registrar mirroring `src/commands/tasks.ts`.
- `src/commands/subtasks/list.ts` (~200 lines) — Commander registration + `--task` parsing + `--page/--all` mutex + paginated fetch via `fetchAllPages` + envelope build.
- `src/commands/subtasks/add.ts` (~280 lines) — Commander registration + flag validation + single-mode + `--stdin` batch (mirrors `tasks/create.ts` shape) + storage-form inference + envelope build.
- `src/ui/human/subtasks-list.ts` (~50 lines) — `cli-table3` renderer with lazy import (matches `projects-list.ts` pattern).
- `src/ui/human/subtasks-add.ts` (~30 lines) — single-line and batch line renderers.
- `test/commands/subtasks/list.test.ts` (~600 lines) — tests 1-18.
- `test/commands/subtasks/add.test.ts` (~900 lines) — tests 19-51 (inc. body builder + inferStorageForm unit tests in same file or a sibling).
- `test/api/subtasks.test.ts` (~120 lines) — body builder + inferStorageForm pure-function tests (37-42 if we split them out; otherwise inline in add.test.ts).
- `.changeset/r14-subtasks-list-add.md` — `freelo-cli: minor`. Mentions the two new schemas as additive surface.
- `docs/commands/subtasks-list.md` — user-facing doc.
- `docs/commands/subtasks-add.md` — user-facing doc, includes the smart-vs-simple paragraph.

### 10.2 Files to modify

- `src/bin/freelo.ts` — register the new top-level `subtasks` command (one-line `register` call alongside the `tasks` registration).
- `test/msw/handlers.ts` — append `subtasksListHandlers` (paginated GET) and `subtasksAddHandlers` (POST returning either smart or simple shape). Pattern mirrors `tasksMoveHandlers` / `tasksCreateHandlers`.
- `README.md` — auto-regenerated by `pnpm fix:readme`.

### 10.3 No new dependencies

`cli-table3`, `chalk` already in package.json (lazy-imported). `zod` for the new schema. Nothing else needed.

### 10.4 Test strategy

- **Unit (no I/O):** `buildCreateSubtaskBody`, `inferStorageForm` — pure functions in `src/api/subtasks.ts` / `src/api/schemas/subtask.ts`. MSW server **not** started for these.
- **Integration (MSW):** `list` and `add` command tests use `runCli(run, [...])` with `captureOutput()`. Spy `process.exit` to throw `EXIT:N`. TTY state mocked via `Object.defineProperty(process.stdout, 'isTTY', ...)`.
- **Coverage**: 80% lines overall, 90% on `src/api/` and `src/commands/`. New `src/api/subtasks.ts` and `src/api/schemas/subtask.ts` need ≥90%; commander registrations need full happy-path + every typed-error path with `exitCode` assertion (Calibration §2).
- **Pagination**: same `fetchAllPages` + `PartialPagesError` recovery pattern as R03 / R04. Test #17 covers partial + notice path.

### 10.5 Rollout order (one PR, one commit recommended)

Single squash commit: `feat(commands): r14 — \`freelo subtasks list\` + \`freelo subtasks add\` (smart-vs-simple)`. Optionally split into:

1. `feat(commands): r14a — \`freelo subtasks list\``
2. `feat(commands): r14b — \`freelo subtasks add\` (smart-vs-simple fallback surfaced)`

Single commit is fine for Yellow — review burden is the same and the two leaves share so much (parent, schemas file, MSW handler bag) that splitting is friction without value.

### 10.6 Risks / mitigations

- **R: storage-form inference false-negative.** A smart subtask with all rich fields null mis-classifies as `simple`. Mitigation: documented in §4.4; agents that rely on the form should pass `--worker` or `--due` to make the form unambiguous. Test #20 explicitly covers the lean-shape simple case to lock the heuristic.
- **R: NDJSON `--stdin` for an additive write may seem heavy.** Mitigation: it mirrors R09 / R12.5 — established precedent. The "writes are agent-safe" rule (CLAUDE.md) effectively requires it. Skipping batch would be the anomaly.
- **R: `subtask: SubtaskSchema.optional()` could let live envelopes drop `subtask` accidentally.** Mitigation: tests #19/#20 explicitly assert `data.subtask` presence on live envelopes; #22 asserts absence on dry-run. The shape is locked by the test pair.
- **R: paginated `--all` on a task with 100+ subtasks could be slow.** Acceptable for v1 — same trade-off as R03 / R04. Cancel-via-Ctrl-C path goes through `AbortSignal` already wired in pagination.ts.
- **R: lazy `cli-table3` import for human mode lands in agent cold path.** Mitigation: existing pattern (`src/ui/human/projects-list.ts` — already audited). Check via grep test.
- **R: branch coverage on new try/catch arms (Calibration §4).** Adding catch arms in `subtasks/list.ts` (rewriteHint) and `subtasks/add.ts` (per-line error in batch). Each arm gets a dedicated test (#11-16, #43-50).
