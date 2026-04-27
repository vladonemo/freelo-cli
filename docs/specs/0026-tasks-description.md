# Spec 0026 — `freelo tasks description` (get/set) — R15

**Status:** Draft → Implement
**Run:** 2026-04-27-2330-tasks-description
**Tier:** Yellow
**Roadmap:** R15 (`docs/roadmap.md`:317-327)
**Depends on:** R08 (`getTaskDescription` already in `src/api/tasks.ts:187`, `TaskCommentSchema` in `src/api/schemas/task.ts:404`), R09 (write infra: `--dry-run`, `dryRunEnvelope`, top-level `try/catch` shape)

---

## 1. Problem

Today `freelo tasks show <id> --with description` is the **only** way to see a task description from the CLI, and there is no way to **set** one — agents must POST raw JSON. R15 closes both gaps:

- `freelo tasks description get <id>` — read the rich-text body of one task.
- `freelo tasks description set <id> (--from-file <path> | --editor | -)` — replace the body from a file, an interactive editor, or stdin.

Crucially, R15 also **lands the shared `src/lib/input.ts` helper** (per `docs/roadmap.md:686`) so future write commands (R17 `comments add`, R22 `reports edit`, etc.) can reuse the same `--from-file` / `--editor` / `-` (stdin) input pattern.

## 2. API surface

### 2.1 `GET /task/{task_id}/description`

`docs/api/freelo-api.yaml:2002-2025`. Returns a single `Comment` `{ id, content, date_add, files[] }`. Empty descriptions still 200 with `id`/`content` empty/null (yaml :2015).

**Already wrapped:** `getTaskDescription(client, taskId, opts) → ApiResponse<TaskComment>` in `src/api/tasks.ts:187`. Validated via `TaskCommentSchema` (`src/api/schemas/task.ts:404`, all fields nullable+optional, passthrough). **No change to wrappers/schemas needed for `get`.**

### 2.2 `POST /task/{task_id}/description` (upsert)

`docs/api/freelo-api.yaml:2026-2065`. Body:

```yaml
required: [content]
properties:
  content: string
  files: FileUpload[]
```

Response: `Comment` (same shape as GET). **Upsert semantics:** first call creates, second call **replaces** entirely (yaml :2039). No append, no history.

We add a new wire wrapper `setTaskDescription(client, { taskId, body, ... }) → { comment: TaskComment, raw: ApiResponse<TaskComment> }` in a new file **`src/api/tasks-description.ts`** (mirrors `src/api/tasks-create.ts`/`tasks-edit.ts` shape).

`files[]` is **out of scope for R15 v1** (multipart upload helper lands at R25, `docs/roadmap.md:687`). The CLI sends `{ content }` only.

## 3. CLI surface

### 3.1 New nested subcommand: `tasks description`

Mirrors the `subtasks list` / `subtasks add` nesting (R14). The `tasks` command grows a child `description`, which itself has two leaves: `get` and `set`.

```
freelo tasks description get <id>
freelo tasks description set <id> (--from-file <path> | --editor | -)
                                  [--dry-run]
```

**Shape:**

- `src/commands/tasks/description.ts` — registers the `description` parent subcommand (no `meta`, no action — just children).
- `src/commands/tasks/description/get.ts` — leaf, `outputSchema: 'freelo.tasks.description.get/v1'`, `destructive: false`.
- `src/commands/tasks/description/set.ts` — leaf, `outputSchema: 'freelo.tasks.description.set/v1'`, `destructive: false` (additive write — even though it overwrites, it doesn't delete user-visible content; mirrors R09 `tasks create` policy).

`src/commands/tasks.ts` adds one import + one register call.

### 3.2 `tasks description get <id>`

#### Flags / args

- `<id>` — positive-integer task id (parsed via `parseTaskId` mirroring R08 / R10 / R12 / R13).

No additional flags in v1.

#### Output schema: `freelo.tasks.description.get/v1`

Envelope `data`:

```jsonc
{
  "task_id": 9012,
  "description": Comment   // TaskCommentSchema (id, content, date_add, files[]); fields nullable per OpenAPI :2015
}
```

`description` is **always present** (the API returns 200 even for empty descriptions — see decision 1).

#### Human renderer

Two-line block:

```
Task #9012 description:
<content body — empty descriptions render "(empty)">
```

`date_add` is included only when non-null, on a third line as `Updated <iso>`.

### 3.3 `tasks description set <id>`

#### Flags / args

- `<id>` — positive-integer task id (same parser as `get`).
- One **mutually-exclusive required** input source:
  - `--from-file <path>` — UTF-8 file read.
  - `--editor` — spawn `$EDITOR` (or platform fallback) with a temp file, wait for exit, read result.
  - `-` (literal `-` as a positional after `<id>`) — read stdin until EOF.
- `--dry-run` — skip the POST; envelope echoes the body that would have been sent.

The `-` is **not** a Commander option but a positional argument. Commander pattern: declare a second positional `<input>` whose only legal value is `-`; reject any other value via the parser. (See decision 2.)

#### Output schema: `freelo.tasks.description.set/v1`

Envelope `data`:

```jsonc
{
  "task_id": 9012,
  "description": Comment,                 // server response (post-replace); absent in --dry-run
  "source": "file" | "editor" | "stdin",  // which input source produced the content
  "byte_length": 1234,                    // length of the content (UTF-8 bytes) — useful for agents to verify against the source file
  "would": {                              // only in --dry-run
    "method": "POST",
    "path": "/task/9012/description",
    "body": { "content": "..." }
  }
}
```

`description` and `source` are **always present** in live envelopes; **absent** in `--dry-run` envelopes. `byte_length` is **always present** (even in `--dry-run`).

#### Human renderer

`Updated description for task #9012 (1234 bytes from <source>).` Dry-run: `(dry-run) Would POST /task/9012/description (1234 bytes from <source>).`

#### Confirmation gate

**None.** Even though the API semantics are "overwrite previous content with no history", `tasks description set` is **not flagged destructive in v1**: it has the same agent-safety profile as `tasks edit --description` (R10), which is also non-destructive. The CLAUDE.md "destructive ops require `--yes`" rule applies to `delete`/`remove` semantics; **upsert** does not qualify. (See decision 3 — flagged for human-review attention.)

`--dry-run` is the agent's safety net.

### 3.4 No batch input

`set` is **single-mode-only** in v1 (no `--stdin` NDJSON of `{id, content}`). The shared `src/lib/input.ts` reads **content** from one source; there's no precedent for multiplexing it across many task ids in a single invocation, and the roadmap's R15 line doesn't ask for it. Future work can add a batch shell (`--ids` + `--from-file` for the same body across many tasks); not in v1.

## 4. Data model

### 4.1 Wire — already declared

- `TaskCommentSchema` (`src/api/schemas/task.ts:404`) — both GET and POST responses validate against it (passthrough, all fields nullable+optional).

### 4.2 New CLI-side types

In a new file `src/api/schemas/task-description.ts`:

```ts
import { z } from 'zod';
import { TaskCommentSchema } from './task.js';

export const SetDescriptionSourceSchema = z.enum(['file', 'editor', 'stdin']);
export type SetDescriptionSource = z.infer<typeof SetDescriptionSourceSchema>;

export const TasksDescriptionGetDataSchema = z.object({
  task_id: z.number().int(),
  description: TaskCommentSchema,
});
export type TasksDescriptionGetData = z.infer<typeof TasksDescriptionGetDataSchema>;

export const TasksDescriptionSetDataSchema = z.object({
  task_id: z.number().int(),
  description: TaskCommentSchema.optional(),  // present in live; absent in --dry-run
  source: SetDescriptionSourceSchema.optional(),  // present in live; absent in --dry-run
  byte_length: z.number().int().nonnegative(),
  would: z.object({
    method: z.literal('POST'),
    path: z.string(),
    body: z.unknown(),
  }).optional(),
});
export type TasksDescriptionSetData = z.infer<typeof TasksDescriptionSetDataSchema>;

export type SetDescriptionInput = { content: string };
export type SetDescriptionBody = { content: string };
```

### 4.3 Wire wrapper

New file `src/api/tasks-description.ts`:

```ts
import { type ApiResponse, type HttpClient } from './client.js';
import { TaskCommentSchema, type TaskComment } from './schemas/task.js';
import { type SetDescriptionBody, type SetDescriptionInput } from './schemas/task-description.js';

export type SetDescriptionOpts = {
  taskId: number;
  body: SetDescriptionBody;
  signal?: AbortSignal;
  requestId?: string;
};

export type SetDescriptionResult = {
  comment: TaskComment;
  raw: ApiResponse<TaskComment>;
};

export function setDescriptionPath(taskId: number): string {
  return `/task/${taskId}/description`;
}

export function buildSetDescriptionBody(input: SetDescriptionInput): SetDescriptionBody {
  return { content: input.content };
}

export async function setTaskDescription(
  client: HttpClient,
  opts: SetDescriptionOpts,
): Promise<SetDescriptionResult> {
  const raw = await client.request({
    method: 'POST',
    path: setDescriptionPath(opts.taskId),
    body: opts.body,
    schema: TaskCommentSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { comment: raw.data, raw };
}
```

`getTaskDescription` is reused from `src/api/tasks.ts:187` byte-for-byte.

## 5. Shared `src/lib/input.ts` helper

This is the headline cross-cutting deliverable of R15. The helper accepts a **declarative source spec** and returns the resolved UTF-8 string, throwing typed `ValidationError` on failure paths.

### 5.1 Public API

```ts
export type InputSource =
  | { kind: 'file'; path: string }
  | { kind: 'stdin' }
  | { kind: 'editor'; templatePath?: string; initialContent?: string };

export type ReadInputOptions = {
  signal?: AbortSignal;
};

export type ReadInputResult = {
  content: string;
  source: 'file' | 'editor' | 'stdin';
};

/**
 * Read a UTF-8 string from one of three sources. Pure dispatch; no command-
 * level concerns leak in. Errors are typed `ValidationError` (exitCode 2)
 * with hint_next pointing at the source's flag.
 *
 * - `kind: 'file'` — readFile(path, 'utf8'). ENOENT / EACCES / EISDIR → ValidationError.
 * - `kind: 'stdin'` — reuses readStdinToString from src/lib/stdin.ts; trimTrailingNewline=false.
 * - `kind: 'editor'` — writes initialContent to a temp file, spawns $EDITOR (or platform fallback),
 *   waits for clean exit, reads result. Exit-code != 0 / signal-killed → ValidationError.
 *
 * Caller is responsible for choosing the source — this helper does not parse flags.
 */
export async function readInput(source: InputSource, opts?: ReadInputOptions): Promise<ReadInputResult>;
```

### 5.2 Editor resolution (decision 4)

Resolution order:

1. `process.env.VISUAL` — POSIX convention, takes precedence over `EDITOR`.
2. `process.env.EDITOR` — universal fallback.
3. Platform default:
   - `process.platform === 'win32'` → `notepad.exe`
   - else → `vi`

Empty-string env values are **ignored** (treated as unset). The chosen command is split on whitespace (no shell interpolation, no quoting) — the first token is the executable, the rest are leading args; the temp file path is appended last. This is intentionally simple; users with editors that need `--wait` (VS Code, Sublime) set it themselves: `EDITOR='code --wait'`.

### 5.3 Editor temp-file lifecycle

- `mkdtempSync(join(tmpdir(), 'freelo-input-'))` for an isolated dir.
- File path: `<dir>/edit.txt` (`.txt` so editors load with sensible defaults; the API expects plain text).
- If `initialContent` is set, write it before spawning the editor (so users editing an existing description see the existing content).
- After read, `rm(dir, { recursive: true, force: true })` in a `finally` block. Failure to clean up is best-effort — never masks the original result/error.

### 5.4 Editor spawn (sync, blocking)

Use `child_process.spawnSync` (NOT `spawn`) — we want to **block** the main loop until the editor exits. The editor takes over the TTY; nothing else should be writing to stdout/stderr while it runs. Inherit stdio so the editor can paint. Honor `opts.signal` via post-spawn check (`spawnSync` doesn't natively accept `AbortSignal` on Node 20; we check `.signal` and treat any non-zero exit / signal kill as `ValidationError`).

If `process.stdin.isTTY` is **false**, `--editor` errors out with `ValidationError` ("--editor requires an interactive terminal; pipe via `-` or use --from-file in non-TTY environments."). This guards against agents accidentally invoking `--editor`.

### 5.5 Stdin

`readStdinToString({ trimTrailingNewline: false })` — preserve the user's exact bytes. The existing helper already handles the empty-stdin case (returns ""), abort, etc.

### 5.6 File read

`readFile(path, 'utf8')`. ENOENT → `ValidationError` "File not found: <path>". EACCES → "Cannot read file (permission denied): <path>". EISDIR → "Path is a directory, not a file: <path>". All carry `hintNext: 'Pass --from-file with a readable UTF-8 file path.'`.

### 5.7 Empty content

`set` with empty content **is allowed** at the helper layer — the helper just returns `''`. The `set` command **rejects** empty content with `ValidationError` (it would be a no-op replace; the user almost certainly didn't mean to clear the description silently). Hint suggests: "Pass non-empty content; to clear the description, use `freelo tasks edit <id> --description ''` (R10)."

(Decision 5 — accepted because empty descriptions on a task that *had* one are a clear destructive accident class; the user can still bypass via `--from-file /dev/null` if they truly mean it. R10 already provides the clearing path.)

## 6. Edge cases

| Case | Behaviour |
|---|---|
| `<id>` non-numeric / zero / negative | `ValidationError` exit 2. |
| `set` with no source flag | `ValidationError` exit 2. ("Specify exactly one of --from-file <path>, --editor, or - (stdin).") |
| `set` with two source flags | `ValidationError` exit 2. ("Specify exactly one input source.") |
| `set --from-file <path>` ENOENT | `ValidationError` exit 2 with file-not-found message. |
| `set --from-file <dir>` | `ValidationError` exit 2 (EISDIR mapped). |
| `set --from-file <unreadable>` | `ValidationError` exit 2 (EACCES mapped). |
| `set --editor` non-TTY | `ValidationError` exit 2. |
| `set --editor` editor exits non-zero | `ValidationError` exit 2 ("Editor exited with status N; aborting."). |
| `set -` empty stdin | `ValidationError` exit 2 (empty-content rule §5.7). |
| `set` with non-empty content (any source) | POST → success → render. |
| `set --dry-run` (any source) | No POST, no auth resolve only if source is `--editor` (we still need to read the editor's temp file before deciding to skip the network call); echo `would` envelope. |
| `get`, task 404 | `FreeloApiError` `code: NOT_FOUND` with hint rewrite ("Task X not found, or your account does not have access."). Exit 4. |
| `get`, task 403 | `FreeloApiError` `code: FORBIDDEN` with hint rewrite. Exit 4. |
| `set`, task 404 | Same — `FreeloApiError` with rewrite. Exit 4. |
| `set`, 422 (server validation) | `FreeloApiError` exit 4 (no hint rewrite — server message passes through). |
| 401 / 429 / 5xx / network | Standard mappings. Exits 3 / 6 / 4 / 5. |

## 7. Non-goals

- No `tasks description delete` (use `tasks edit <id> --description ''` via R10 → tracked separately).
- No `--files` / multipart attachments on `set` (R25 — multipart helper).
- No batch `set` across multiple task ids.
- No append / patch semantics — Freelo's API is upsert-only (yaml :2039). The CLI doesn't pretend otherwise.
- No diff / preview UI for `set --editor` (just write-and-replace).

## 8. Open questions

None. The API contract is unambiguous (yaml :2002-2065). The editor UX choices (decisions 4-7) are made autonomously per `.claude/docs/autonomous-sdlc.md` ("Small UX choices with a clear precedent in the codebase / language ecosystem → Decide, log").

## 9. Mandatory tests (Calibration §1-4)

### 9.1 `src/lib/input.ts` — direct unit tests (`test/lib/input.test.ts`)

| # | Scenario | Assertion |
|---|---|---|
| 1 | `readInput({ kind: 'file', path: <utf8 file> })` | content matches file body, source='file' |
| 2 | `readInput({ kind: 'file', path: <missing> })` | throws `ValidationError`, `exitCode === 2`, message mentions "not found" |
| 3 | `readInput({ kind: 'file', path: <dir> })` | throws `ValidationError`, `exitCode === 2`, message mentions "directory" |
| 4 | `readInput({ kind: 'stdin' })` with piped text | content matches, source='stdin' |
| 5 | `readInput({ kind: 'stdin' })` with empty stdin | content === '', source='stdin' |
| 6 | `readInput({ kind: 'editor' })` non-TTY | throws `ValidationError`, exit 2, message mentions "interactive" |
| 7 | `readInput({ kind: 'editor' })` editor success | content matches what editor "wrote"; source='editor'; cleanup ran |
| 8 | `readInput({ kind: 'editor' })` editor non-zero exit | throws `ValidationError`, exit 2 |
| 9 | Editor resolution: `VISUAL` beats `EDITOR` | ✓ (env permutations) |
| 10 | Editor resolution: empty `EDITOR` falls through to platform default | ✓ |
| 11 | Editor resolution: Windows platform default | `notepad.exe` (mock platform) |

The editor tests use a **fake editor** — a tiny Node script that writes a known string to its argv[1] file then exits 0 (or non-zero for the failure case). This avoids spawning real editors in CI.

### 9.2 `tasks description get` integration (`test/commands/tasks/description-get.test.ts`)

| # | Scenario | Assertion |
|---|---|---|
| 1 | 200 with content | exit 0, envelope schema='freelo.tasks.description.get/v1', `data.description.content === <body>` |
| 2 | 200 empty description | exit 0, `data.description.content` is null/empty (passthrough) |
| 3 | 401 | exit 3, AUTH_EXPIRED |
| 4 | 403 | exit 4, FORBIDDEN, hint mentions "permission" |
| 5 | 404 | exit 4, NOT_FOUND, hint mentions "not found" |
| 6 | 5xx | exit 4, SERVER_ERROR |
| 7 | 429 | exit 6, RATE_LIMITED |
| 8 | network | exit 5, NETWORK_ERROR |
| 9 | `<id>` non-numeric | exit 2, VALIDATION_ERROR |
| 10 | human renderer | renders "Task #N description:" and the body |
| 11 | introspect lists `tasks description get` | output_schema present, destructive: false |

### 9.3 `tasks description set` integration (`test/commands/tasks/description-set.test.ts`)

| # | Scenario | Assertion |
|---|---|---|
| 1 | `--from-file` happy path | exit 0, schema correct, `source='file'`, byte_length matches |
| 2 | `-` (stdin) happy path | exit 0, `source='stdin'`, content matches piped |
| 3 | `--editor` happy path (fake editor) | exit 0, `source='editor'` |
| 4 | `--dry-run --from-file` | no POST, `dry_run: true`, `would.path === '/task/9012/description'`, `would.body.content === <body>`, byte_length present |
| 5 | no source | exit 2 VALIDATION_ERROR, message mentions "exactly one" |
| 6 | `--from-file` + `-` | exit 2 (mutex) |
| 7 | `--from-file` ENOENT | exit 2, message mentions "not found" |
| 8 | `--editor` non-TTY | exit 2, message mentions "interactive" |
| 9 | `-` empty stdin | exit 2, message mentions "empty" |
| 10 | 401 | exit 3 |
| 11 | 403 | exit 4, hint mentions "permission" |
| 12 | 404 | exit 4, hint mentions "not found" |
| 13 | 422 (server validation pass-through) | exit 4 |
| 14 | 5xx | exit 4 |
| 15 | 429 | exit 6 |
| 16 | network | exit 5 |
| 17 | `<id>` non-numeric | exit 2 |
| 18 | wire body matches | predicate captures `{ content: <body> }` |
| 19 | human renderer | "Updated description for task #N (X bytes from <source>)." |
| 20 | introspect lists `tasks description set` | output_schema present, destructive: false |

### 9.4 Calibration §2 coverage

Every typed error class triggered:
- `ValidationError` (exit 2) — get §9.2 #9; set §9.3 #5/6/7/8/9/17; helper §9.1 #2/3/6/8.
- `FreeloApiError` (exit 3 for 401, 4 for others) — get §9.2 #3-6; set §9.3 #10-15.
- `RateLimitedError` (exit 6) — get §9.2 #7; set §9.3 #15.
- `NetworkError` (exit 5) — get §9.2 #8; set §9.3 #16.

### 9.5 Calibration §4 — every new try/catch arm has a test

`src/lib/input.ts` adds catch arms for: file ENOENT/EISDIR/EACCES, editor spawn-failure, editor non-zero-exit, stdin abort. All covered in §9.1. `set.ts` wraps the wire call in a hint-rewriter `try/catch`; the rewrite test covers it (§9.3 #11/12). `get.ts` mirrors `tasks/show.ts`'s rewriter — already-tested pattern.

## 10. Decisions

1. **`get` always emits `description` field.** The API returns 200 with `id/content` empty/null for "no description set" tasks (yaml :2015). The CLI does not synthesize a "missing" sentinel; the agent reads `data.description.content` directly (`null` or `""` → no description). Mirrors R08's `--with description` behavior.

2. **`-` is a positional, not a flag.** Commander natively treats `-` as positional; we declare `set`'s second positional as `<input>` with parser that accepts only `-` (else `ValidationError`). Alternatives: `--stdin` flag (rejected — roadmap explicitly says `-`), or accept any positional and route through readInput (rejected — too magical).

3. **`set` is `destructive: false`.** Same precedent as R10 (`tasks edit --description`). `--dry-run` is the safety net; `--yes` is reserved for true delete-class ops (R13). PR body will call this out for human review.

4. **Editor resolution order: `VISUAL` → `EDITOR` → platform default.** POSIX convention. Empty env vars treated as unset.

5. **Empty content rejected at the command layer.** Helper returns `''`, command throws `ValidationError`. Hint points to R10's clearing path.

6. **`--editor` spawns synchronously via `spawnSync`.** Editor takes over the TTY; we must block. Stdio inherited.

7. **Editor temp file is `<tmpdir>/freelo-input-XXXXXX/edit.txt`.** `.txt` so editors load with text defaults. Best-effort cleanup in `finally`.

8. **No `--files` in v1.** Multipart upload is R25 (`docs/roadmap.md:687`).

9. **`set --editor` is forbidden in non-TTY.** Agents that try it get a clear `ValidationError` pointing them at `-` (stdin) or `--from-file`.

## 11. PR body callouts (Yellow review prompts)

- **Schema additions:** `freelo.tasks.description.get/v1`, `freelo.tasks.description.set/v1`. Both new — additive, no schema bump elsewhere.
- **`destructive: false` on `set`** — overwrite-class but not delete-class; same precedent as R10. Confirm the policy interpretation.
- **`src/lib/input.ts`** — first introduction of editor / stdin / `--from-file` shared input. Reusable for R17 / R22.
- **No `--files`** in v1; tracked for R25.

---

## Plan

### Files to create

| Path | Purpose |
|---|---|
| `src/lib/input.ts` | Cross-cutting shared helper: `readInput({ kind: 'file'\|'stdin'\|'editor', ... })` → `{ content, source }`. Pure dispatch + typed `ValidationError` failures. |
| `src/api/schemas/task-description.ts` | Envelope-data schemas: `TasksDescriptionGetData`, `TasksDescriptionSetData`, `SetDescriptionSource`. |
| `src/api/tasks-description.ts` | Wire wrapper: `setTaskDescription`, `setDescriptionPath`, `buildSetDescriptionBody`. |
| `src/commands/tasks/description.ts` | Parent `description` subcommand on `tasks`; registers `get` and `set`. No `meta`, no action. |
| `src/commands/tasks/description/get.ts` | Leaf `get <id>` — reuses `getTaskDescription`. |
| `src/commands/tasks/description/set.ts` | Leaf `set <id> (--from-file <path> \| --editor \| -)` — uses `readInput` + `setTaskDescription`. |
| `src/ui/human/tasks-description-get.ts` | Human renderer for `get`. |
| `src/ui/human/tasks-description-set.ts` | Human renderer for `set` (live + dry-run). |
| `docs/commands/tasks-description-get.md` | User docs. |
| `docs/commands/tasks-description-set.md` | User docs. |
| `test/lib/input.test.ts` | Unit tests for the shared helper. |
| `test/commands/tasks/description-get.test.ts` | Integration tests for `get`. |
| `test/commands/tasks/description-set.test.ts` | Integration tests for `set`. |
| `test/api/tasks-description.test.ts` | Unit tests for the wire wrapper (`setDescriptionPath`, `buildSetDescriptionBody`, error mapping). |
| `test/fixtures/fake-editor.mjs` | Helper editor script for `--editor` tests (writes a known string to argv[1]). |
| `.changeset/r15-tasks-description.md` | Changeset (minor). |

### Files to modify

| Path | Change |
|---|---|
| `src/commands/tasks.ts` | Add `import { registerDescription } from './tasks/description.js'` + `registerDescription(tasks, getConfig, env)` after `registerDelete`. |
| `test/msw/handlers.ts` | Add `tasksDescriptionHandlers` block — POST 200/401/403/404/422/429/5xx/network + `okWhenBody` predicate. (GET handlers already exist on `tasksShowHandlers.descriptionOk` etc.) |
| `README.md` | Regenerate the autogen `<!-- BEGIN AUTOGEN COMMANDS -->` block via `pnpm fix:readme`. |
| `test/fixtures/introspect-golden.json` | Regenerate via the existing fixture-update script (or manually mirror the new entries — fixture-snapshot tests detect drift). |

### No new dependencies

- `node:fs/promises`, `node:os`, `node:child_process`, `node:url`, `node:path` are stdlib.
- `readStdinToString` already exists in `src/lib/stdin.ts`.
- No new npm packages.

### Test strategy

- **Unit (fast, no I/O):** `test/lib/input.test.ts` covers `readInput` directly with temp dirs, mocked stdin, and a fake-editor script. `test/api/tasks-description.test.ts` covers `setDescriptionPath`/`buildSetDescriptionBody`/wire-call shape.
- **Integration (MSW):** `test/commands/tasks/description-{get,set}.test.ts` drive the full CLI through `run(...)`. Every typed error class gets an exit-code assertion (Calibration §2). Every new `try/catch` arm has a triggering test (Calibration §4).

### Rollout

Single commit, single PR (Yellow). All slices land together — the helper and the two leaf commands are interdependent (the `set.ts` command imports `readInput`).

### Order of work

1. `src/lib/input.ts` + `test/lib/input.test.ts` + fake-editor fixture.
2. `src/api/schemas/task-description.ts` + `src/api/tasks-description.ts`.
3. `src/commands/tasks/description/get.ts` + `set.ts` + parent `description.ts`.
4. `src/ui/human/tasks-description-{get,set}.ts`.
5. Wire `src/commands/tasks.ts`.
6. MSW handlers.
7. Integration tests.
8. Docs (`docs/commands/...`).
9. `pnpm fix:readme` to regenerate the README block.
10. Changeset (minor).
11. Run all gates on the committed tree.

### Acceptance gate

All five must pass on the **committed** tree (Calibration §3) before push:

```
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm check:readme
```

