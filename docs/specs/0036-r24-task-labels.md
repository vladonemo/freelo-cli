# Spec 0036 — R24 `freelo task-labels`

**Run:** 2026-04-29-1500-r24-task-labels
**Tier:** Yellow
**Depends on:** R10 (`freelo tasks` slice — task ids).
**Sibling, NOT shared with:** R23 `freelo labels` (project-labels). Task-labels is a **different Freelo concept** with its own endpoints and resource shape.

---

## 1. Problem & scope

The Freelo API has two distinct label concepts:

1. **Project labels** (`/project-labels/*`) — already shipped as `freelo labels` in R23 (spec 0035). Per-account, attached/detached to **projects**.
2. **Task labels** (`/task-labels/*`) — **R24, this spec**. Per-account label palette, attached/detached to **individual tasks**. Identified by **UUID** (not numeric id) and matched by `name+color`.

R24 surfaces three operations on task-labels:

```
freelo task-labels create --name <str>... [--color <hex>] [--dry-run]
freelo task-labels attach --task <id> (--name <str>|--uuid <uuid>)... [--color <hex>] [--dry-run]
freelo task-labels detach --task <id> (--name <str>|--uuid <uuid>)... [--color <hex>] [--dry-run]
```

### Goals

- Wire-faithful coverage of all three task-labels endpoints, end-to-end (CLI → typed API wrappers → MSW-tested).
- Agent-safe: `--dry-run` echoes wire body; non-zero exit on per-item failure in batches.
- Zero-overlap with R23 — separate api module, separate command file, separate schemas.

### Non-goals (v1)

- A `task-labels list` (no list endpoint exists for this resource — `/project-labels/find-available` covers project-labels only; task-labels surface via task detail).
- A `task-labels delete` global hard-delete (no documented endpoint).
- `--stdin` NDJSON batch input. The selectors are `--name <str>` and `--uuid <id>` repeatable on the CLI; pipelining can come in a follow-up if real workloads need it.
- Surfacing the server-side fetch-or-create distinction on the response (the API doesn't report it).
- Confirmation prompts. None of the three operations are workspace-destructive (definitions are not deleted by `detach`).

---

## 2. OpenAPI verification

Verified `docs/api/freelo-api.yaml` (the canonical Freelo contract) against R24's three endpoints.

### 2.1 `POST /task-labels` (yaml :2446-2482) — bulk-create

**Request body**:
```json
{ "labels": [ { "name": "<str>", "color": "<hex>" }, ... ] }
```

- `labels[]` is an array of `{ name?, color? }` objects (both optional in the schema, but `name` is in practice required).
- **Fetch-or-create**: server reuses an existing label of the same `name` (case-sensitive) instead of duplicating. The API does NOT report which were new vs. reused.
- Scoped to the caller's account.
- No 4xx documented for empty array.
- No path parameter.

**Response**: 200 with `description: Labels created` — body shape unspecified beyond a generic success envelope. We will validate against a permissive `SuccessResponseSchema` (`{ result?: string }.passthrough()`) — same convention as `project-labels`.

### 2.2 `POST /task-labels/add-to-task/{task_id}` (yaml :2484-2528) — attach

**Path param**: `task_id` (integer).

**Request body**:
```json
{ "labels": [ <TaskLabelAddInput>, ... ] }
```

`TaskLabelAddInput` (yaml :5139-5169) is `oneOf`:
- **UUID-mode**: `{ uuid: <uuid> }` (assigns existing label by uuid).
- **Name-mode**: `{ name: <str>, color?: <hex>, uuid?: <uuid> }` (fetch-or-create — server reuses the label when **both name AND color** match, else creates a new one with the given color, defaulting to `#77787a` gray when omitted).

**Behavior notes (verbatim)**:
- Name+color matching is **case-sensitive**.
- Empty `labels` array short-circuits (200, no event).
- Bad colors → 400 `Unsupported color (X) provided.`
- Unknown UUID → `CannotCreateWithProvidedUuidException` (server returns 4xx).

**Response**: 200 generic `SuccessResponse`.

### 2.3 `POST /task-labels/remove-from-task/{task_id}` (yaml :2530-2573) — detach

> NOTE: roadmap says `DELETE /task-labels/remove-from-task/{task_id}`. The OpenAPI says **POST**. **OpenAPI is authoritative.** This is exactly the same divergence as R23 `project-labels` detach (spec 0035 decision 02 — verb is POST, not DELETE). Decision recorded in §10 below.

**Path param**: `task_id` (integer).

**Request body**:
```json
{ "labels": [ <TaskLabelRemoveInput>, ... ] }
```

`TaskLabelRemoveInput` (yaml :5171-5204) is `oneOf`:
- **UUID-mode**: `{ uuid: <uuid> }`
- **Name-only mode**: `{ name: <str> }` — removes ALL labels with that name regardless of color (aggressive).
- **Name+color mode**: `{ name: <str>, color: <hex> }` — removes only the label matching both.

**Behavior notes**:
- Empty `labels` array short-circuits (200, no event).
- Idempotent — removing a label that's not on the task is a 200 no-op.

**Response**: 200 generic `SuccessResponse`.

---

## 3. CLI surface

### 3.1 Command tree (registered in `src/bin/freelo.ts`)

```
freelo task-labels                                              [parent — no meta]
  ├─ create   --name <str>... [--color <hex>] [--dry-run]      [meta: freelo.task_labels.create/v1]
  ├─ attach   --task <id> (--name <str>|--uuid <id>)... [--color <hex>] [--dry-run]
  └─ detach   --task <id> (--name <str>|--uuid <id>)... [--color <hex>] [--dry-run]
```

Parent has description but no `meta` (mirrors `freelo labels`).

### 3.2 Flag specification

#### `task-labels create`

| Flag | Type | Required | Notes |
|---|---|---|---|
| `--name <str>` | repeatable string | yes (≥1) | Each `--name` becomes one entry in `labels[]`. Whitespace-trimmed, must be non-empty. |
| `--color <hex>` | string `#RRGGBB` | no | Applied to **every** name in this invocation. Same color across all names per call (matches roadmap signature `--name <str>... [--color <hex>]`). |
| `--dry-run` | boolean | no | Skip POST; envelope echoes the would-be wire body. |

> Decision: **`--color` (not `--hex`)** for task-labels because the global root flag conflict that drove R23 spec 0035 decision 11 (`labels attach --hex` rename) was specifically about avoiding collision with the existing `program.option('--color <mode>')` flag on the root. We checked: `program` does carry a `--color` global ([src/bin/freelo.ts](../../src/bin/freelo.ts)). **Same conflict applies here**. Rename to `--hex` for all three task-labels subcommands. See decision 02.

#### `task-labels attach`

| Flag | Type | Required | Notes |
|---|---|---|---|
| `--task <id>` | positive int | yes | Path param. |
| `--name <str>` | repeatable string | one of these required | Name-mode entry. |
| `--uuid <id>` | repeatable string (uuid format) | one of these required | UUID-mode entry. |
| `--hex <color>` | string `#RRGGBB` | no | Applied to `--name` entries only (server defaults to `#77787a` if omitted). UUID-mode entries ignore `--hex` (server uses the existing label's color). |
| `--dry-run` | boolean | no | Skip POST. |

At least one of `--name` or `--uuid` is required (cumulatively ≥1 entry). Both can be mixed in one call → one POST with mixed `labels[]`.

#### `task-labels detach`

| Flag | Type | Required | Notes |
|---|---|---|---|
| `--task <id>` | positive int | yes | Path param. |
| `--name <str>` | repeatable string | one required | Name-only mode (aggressive). Combined with `--hex` becomes name+color mode. |
| `--uuid <id>` | repeatable string (uuid) | one required | UUID-mode. |
| `--hex <color>` | string `#RRGGBB` | no | When provided, **all** `--name` entries upgrade from name-only mode → name+color mode. UUID-mode entries ignore `--hex`. |
| `--dry-run` | boolean | no | Skip POST. |

> Decision: a single `--hex` applies to all `--name` entries (we don't surface per-name colors in v1). If you need per-name colors, repeat the call. Recorded in decision 04.

### 3.3 Output

Three new envelope schemas:

- `freelo.task_labels.create/v1`
- `freelo.task_labels.attach/v1`
- `freelo.task_labels.detach/v1`

Live data shape (single-shot — there is one POST per command, with a `labels` array inside):

```ts
// freelo.task_labels.create/v1
type TaskLabelsCreateData = {
  labels: Array<{ name: string; color?: string }>;
  count: number;  // == labels.length, convenience for renderers
  would?: { method: 'POST'; path: '/task-labels'; body: unknown };
};

// freelo.task_labels.attach/v1
type TaskLabelsAttachData = {
  task_id: number;
  labels: Array<{ uuid?: string; name?: string; color?: string }>;
  count: number;
  would?: { method: 'POST'; path: '/task-labels/add-to-task/<id>'; body: unknown };
};

// freelo.task_labels.detach/v1
type TaskLabelsDetachData = {
  task_id: number;
  labels: Array<{ uuid?: string; name?: string; color?: string }>;
  count: number;
  would?: { method: 'POST'; path: '/task-labels/remove-from-task/<id>'; body: unknown };
};
```

Each command makes **one** POST per invocation (the API is bulk by design). No per-item batch error path because there is no per-item error — the whole POST 200s or the whole POST fails with a 4xx/5xx.

### 3.4 Error paths & exit codes

| Scenario | Error class | Exit code |
|---|---|---|
| Missing `--name` and `--uuid` | `ValidationError` | 2 |
| `--task` non-positive / non-integer | `ValidationError` | 2 |
| `--hex`/`--color` not `#RRGGBB` | `ValidationError` | 2 |
| Empty `--name ""` | `ValidationError` | 2 |
| `--uuid` not uuid-shaped | `ValidationError` | 2 |
| 4xx from server (e.g. unknown task, bad color) | `FreeloApiError` | 1 |
| 401 / 403 | `FreeloApiError` | 1 |
| 5xx | `FreeloApiError` | 1 |
| 429 | `RateLimitedError` | 4 |
| Network failure | `NetworkError` | 5 |

Per Calibration §2 the test plan (§7 below) MUST assert each `exitCode` for each typed-error path.

---

## 4. Files & module layout

### 4.1 New files

| File | Purpose |
|---|---|
| `src/api/task-labels.ts` | Wire wrappers + path helpers + body builders for the three endpoints. ~150 LOC. |
| `src/api/schemas/task-label.ts` | Zod schemas: `SuccessResponseSchema` (local), `TaskLabelsCreateDataSchema`, `TaskLabelsAttachDataSchema`, `TaskLabelsDetachDataSchema`. ~70 LOC. |
| `src/commands/task-labels.ts` | Parent registrar (mirrors `src/commands/labels.ts`). ~30 LOC. |
| `src/commands/task-labels/create.ts` | Leaf — bulk create. ~180 LOC. |
| `src/commands/task-labels/attach.ts` | Leaf — attach to a task. ~210 LOC. |
| `src/commands/task-labels/detach.ts` | Leaf — detach from a task. ~210 LOC. |
| `src/ui/human/task-labels-create.ts` | Human renderer. ~25 LOC. |
| `src/ui/human/task-labels-attach.ts` | Human renderer. ~25 LOC. |
| `src/ui/human/task-labels-detach.ts` | Human renderer. ~25 LOC. |
| `test/api/task-labels.test.ts` | Wire-wrapper unit tests (MSW). |
| `test/commands/task-labels/create.test.ts` | Command-level tests + exit codes. |
| `test/commands/task-labels/attach.test.ts` | Command-level tests + exit codes. |
| `test/commands/task-labels/detach.test.ts` | Command-level tests + exit codes. |
| `.changeset/<auto>.md` | Minor bump — three new subcommands. |

### 4.2 Modified files

| File | Change |
|---|---|
| `src/bin/freelo.ts` | Add `import { register: registerTaskLabels } from '../commands/task-labels.js'` and call site. |
| `README.md` | Auto-generated by `pnpm fix:readme` from introspection — no hand edits expected. |

Total new files: 10 source + 4 test + 1 changeset = 15. **Within budget (25).**

---

## 5. Behavioral details

### 5.1 Command shape — one POST per command

Unlike R23 `labels attach`/`detach` (which fans out — one POST per `--name` / `--label`), R24 sends **one POST** per command containing the full `labels[]` array. The API is bulk-by-design. This is simpler and matches the OpenAPI shape literally. **No `ExitCodeAccumulator`, no per-item batch error envelope, no `--stdin` in v1.** If the POST 4xx's, the whole command fails with one typed error.

### 5.2 Mixing `--name` and `--uuid` in attach/detach

Allowed. The CLI builds one mixed `labels[]` array. Each `--name <str>` produces a name-mode entry (with `color` from `--hex` if set); each `--uuid <id>` produces a uuid-mode entry. The server processes them per the `oneOf`.

### 5.3 UUID validation

We accept the standard uuid v4 shape: `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`. Case-insensitive. No version restriction (uuid v1/v3/v4/v5 all accepted) — the server accepts whatever is supplied.

### 5.4 Idempotency

- `create`: server-side fetch-or-create — calling with the same `--name` twice is a no-op the second time. **No CLI surfacing of "already exists"** because the server doesn't tell us. Documented in command help.
- `attach`: server-side fetch-or-create per label entry. Same as above — the CLI cannot tell first-attach from re-attach.
- `detach`: server-side already-idempotent (200 even when label wasn't on the task). No two-arm 404 heuristic needed (different shape than `labels detach`).

### 5.5 Dry-run

Each command's dry-run path emits one envelope with `dry_run: true` and the `would: { method, path, body }` field populated. No POST. Exit 0.

### 5.6 No destructive prompt

None of the three commands are workspace-destructive (the label definitions persist after `detach`). No `--yes`, no `confirmDestructive`. Calibration #7 (TTY-prompt CI gotcha) **does not apply** to this slice.

---

## 6. Conventions touched

- **Error classes**: `ValidationError` (input validation), `FreeloApiError` (server 4xx/5xx — already covered by `client.ts`).
- **Envelope contract**: three new schemas, all additive `vN`. Changeset minor.
- **Lazy-load policy**: command files import `commander`, `zod`, the api wrapper. Human renderers are imported eagerly (small, no human-only deps). `@inquirer/prompts`, `ora` not used.
- **ESM-only**: every import has `.js` extension on relative paths.

---

## 7. Test plan

Coverage targets per project policy: 85% branch on `src/commands/**`. Test count target: **~30 tests** across 4 files.

### 7.1 `test/api/task-labels.test.ts` (~6 tests)

- `createTaskLabels` builds correct POST body, passes through MSW, schema-validates response.
- `addTaskLabelsToTask` builds correct path with `task_id` interpolation, correct body shape for mixed UUID + name entries.
- `removeTaskLabelsFromTask` same shape.
- All three: 4xx → `FreeloApiError` propagation.

### 7.2 `test/commands/task-labels/create.test.ts` (~8 tests)

- happy path (1 name) — exit 0, envelope shape.
- happy path (multiple names + `--hex`) — body has all entries with the same color.
- `--dry-run` — no MSW request fired (verify with handler-call counter); envelope has `dry_run: true` and `would` populated.
- empty `--name ""` → `ValidationError`, exit 2.
- no `--name` at all → `ValidationError`, exit 2.
- `--hex "not-hex"` → `ValidationError`, exit 2 (Commander parser).
- 500 from server → `FreeloApiError`, exit 1.
- human-output formatting smoke test.

### 7.3 `test/commands/task-labels/attach.test.ts` (~10 tests)

- `--task <id> --name foo` — 1-entry name-mode body.
- `--task <id> --uuid <uuid>` — 1-entry uuid-mode body.
- mixed `--name foo --uuid <uuid>` — 2-entry mixed body.
- `--name foo --hex "#abcdef"` — name+color entry.
- `--task` non-integer → `ValidationError`, exit 2.
- `--task` zero/negative → `ValidationError`, exit 2.
- no selectors at all → `ValidationError`, exit 2.
- `--uuid not-a-uuid` → `ValidationError`, exit 2.
- `--dry-run` — no fetch, envelope has `would`.
- 4xx (e.g. 400 bad color) → `FreeloApiError`, exit 1.

### 7.4 `test/commands/task-labels/detach.test.ts` (~10 tests)

- `--task <id> --name foo` (name-only mode) — 1-entry body.
- `--task <id> --name foo --hex "#abcdef"` (name+color mode) — entry has both.
- `--task <id> --uuid <uuid>` — uuid-mode entry.
- mixed `--name foo --uuid <uuid>` — 2-entry mixed.
- multiple `--name foo --name bar` — 2-entry both name-mode.
- `--dry-run` — would echoed.
- no selectors → `ValidationError`, exit 2.
- `--uuid bad-uuid` → `ValidationError`, exit 2.
- `--task` invalid → `ValidationError`, exit 2.
- 4xx → `FreeloApiError`, exit 1.

### 7.5 Coverage of typed-error classes (Calibration §2)

Across the four test files we hit each typed class on at least one path:

- `ValidationError` (exit 2): yes, multiple per file.
- `FreeloApiError` (exit 1): yes, one per command-level file.
- `RateLimitedError` (exit 4) and `NetworkError` (exit 5): covered by api-wrapper tests via MSW (or fall through to client.ts's existing coverage; not duplicated per command).

### 7.6 Calibration #7 check

No `isInteractive()`-gated TTY-prompt branch in this slice → no `delete process.env.CI` needed. Will grep test diff for `isTTY.*true` before submit; expect zero matches.

---

## 8. Open questions

None resolvable only by humans. All API behavior is documented in the OpenAPI yaml, all flag semantics derive from the roadmap signature, all output schema choices follow R23/R22/R21 precedent.

---

## 9. Acceptance criteria

- [ ] All three commands registered and discoverable via `freelo --introspect`.
- [ ] All three commands pass their happy-path test against MSW.
- [ ] Each typed-error path has an exit-code assertion.
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme` green on the committed tree.
- [ ] Changeset entry calls out the three new schemas.
- [ ] No new dependencies.
- [ ] Coverage on `src/commands/task-labels/**` ≥ 85% branch.

---

## 10. Decision log (to be expanded as needed)

### Decision 01 — Detach verb is POST per OpenAPI, not DELETE per roadmap

Roadmap text says `DELETE /task-labels/remove-from-task/{task_id}`. OpenAPI yaml :2531 says POST. Per autonomous-sdlc.md "Spec says something the OpenAPI spec contradicts → Pause — Freelo's contract is authoritative", we follow OpenAPI. R23 (project-labels detach) made the same call (spec 0035 decision 02). No pause needed — the OpenAPI is unambiguous and the precedent is set.

### Decision 02 — `--hex` for color flag (not `--color`)

The roadmap uses `--color <hex>`. The root program already binds `--color <mode>` (auto/always/never) for output colorization. R23 spec 0035 decision 11 renamed `labels attach --color` → `--hex` for exactly this reason. Same conflict here, same resolution. Helps `freelo --color always task-labels create --hex "#abc123" --name foo` parse unambiguously.

### Decision 03 — No `--stdin` in v1

The selectors are short (uuid or name string + optional color). NDJSON would shape rows as `{ uuid?, name?, color? }` and is genuinely useful for bulk-creates from a file, but we punt to a follow-up if real workloads ask for it. Keeps the v1 surface small.

### Decision 04 — Single `--hex` applies to all `--name` entries in one call

The roadmap signature reads `--name <str>... [--color <hex>]` (one color per call, not per name). We honor that: per-name colors require separate invocations. Trade-off: strict literal of roadmap wins over flexibility; flexibility is one CLI loop away.

### Decision 05 — One bulk POST per command (no fan-out)

The API is bulk-by-design (every endpoint takes `{ labels: [...] }`). Unlike R23's project-labels (one POST per `--name`), R24 sends one POST per command. Simpler, matches the OpenAPI literally, no `ExitCodeAccumulator` needed. If an item is malformed in a way only the server can detect, the whole call fails — that's an acceptable trade in v1.

---

## 11. Plan (file-level TODOs)

### Step 1 — API wrappers (no UI dependencies)

**File:** `src/api/schemas/task-label.ts` (new, ~80 LOC)

- Export `SuccessResponseSchema` (local — `{ result?: string }.passthrough()`).
- Export `TaskLabelEntrySchema` — common entry shape `{ uuid?: string; name?: string; color?: string }`.
- Export envelope-data schemas:
  - `TaskLabelsCreateDataSchema` — `{ labels: TaskLabelEntrySchema[]; count: number; would?: WouldShape }` plus type alias.
  - `TaskLabelsAttachDataSchema` — `{ task_id: number; labels: ...; count: number; would? }`.
  - `TaskLabelsDetachDataSchema` — same shape as attach.
- The `would` field follows existing convention: `{ method: 'POST'; path: string; body: unknown }`.

**File:** `src/api/task-labels.ts` (new, ~150 LOC)

- Export path helpers:
  - `TASK_LABELS_PATH = '/task-labels'`
  - `addTaskLabelsPath(taskId: number) = '/task-labels/add-to-task/<id>'`
  - `removeTaskLabelsPath(taskId: number) = '/task-labels/remove-from-task/<id>'`
- Export wire body types: `CreateTaskLabelsBody`, `AddTaskLabelsBody`, `RemoveTaskLabelsBody`.
- Export entry types: `TaskLabelCreateEntry`, `TaskLabelAddEntry`, `TaskLabelRemoveEntry`.
- Export pure builders: `buildCreateTaskLabelsBody`, `buildAddTaskLabelsBody`, `buildRemoveTaskLabelsBody`.
- Export wire-call functions: `createTaskLabels`, `addTaskLabelsToTask`, `removeTaskLabelsFromTask`.
- Each call uses the local `SuccessResponseSchema`.
- `FetchOpts` shape mirrors `src/api/project-labels.ts`.

### Step 2 — Human renderers (3 small files)

**File:** `src/ui/human/task-labels-create.ts`

```ts
export function renderTaskLabelsCreateHuman(d: TaskLabelsCreateData): string {
  return `Created or matched ${d.count} label${d.count === 1 ? '' : 's'}: ${d.labels.map(l => l.name).join(', ')}`;
}
```

**File:** `src/ui/human/task-labels-attach.ts` and `src/ui/human/task-labels-detach.ts` — analogous one-liners.

### Step 3 — Command parent + leaves

**File:** `src/commands/task-labels.ts` (new, ~30 LOC) — mirrors `src/commands/labels.ts` register pattern.

**File:** `src/commands/task-labels/create.ts` (~180 LOC):
- `parseHexColorFlag(raw): string` — `#RRGGBB` validator → `ValidationError` exit 2.
- `collectName(raw, prev)` — non-empty trim → `ValidationError` exit 2.
- Action handler validates ≥1 `--name`, builds entries, dispatches dry-run vs live POST.
- Single envelope output. Uses `buildEnvelope` and `render(mode, envelope, renderer)`.

**File:** `src/commands/task-labels/attach.ts` (~210 LOC):
- `parseTaskIdFlag(raw)` — positive int → `ValidationError`.
- `parseUuidFlag(raw, prev)` — uuid-shaped → `ValidationError`.
- `collectName(raw, prev)` — same as create.
- `parseHexColorFlag(raw)` — same.
- Action validates ≥1 selector across `--name` + `--uuid`; builds mixed `labels[]`; dispatches.

**File:** `src/commands/task-labels/detach.ts` (~210 LOC):
- Same parsers as attach.
- Builds `labels[]` per `oneOf` rules: `--uuid` → `{ uuid }`; `--name` → `{ name }` or `{ name, color }` if `--hex` set; mixed allowed.

### Step 4 — Wire into root

**File:** `src/bin/freelo.ts` (modify):
- `const { register: registerTaskLabels } = await import('../commands/task-labels.js');`
- `registerTaskLabels(program, getAppConfig, env);`
- Place after `registerLabels` (alphabetical-ish per existing order).

### Step 5 — Tests

**File:** `test/api/task-labels.test.ts` (new, ~100 LOC) — wire wrapper tests with MSW.

**File:** `test/commands/task-labels/create.test.ts` (new, ~200 LOC) — happy path, dry-run, validation errors, server error.

**File:** `test/commands/task-labels/attach.test.ts` (new, ~250 LOC) — name-mode, uuid-mode, mixed, validation, server error.

**File:** `test/commands/task-labels/detach.test.ts` (new, ~250 LOC) — name-only, name+color, uuid, mixed, validation, server error.

### Step 6 — Changeset

```
.changeset/r24-task-labels.md (auto-named per `pnpm changeset` convention)
"freelo-cli": minor

feat(commands): r24 — `freelo task-labels` (create / attach / detach) for task-scoped label management.

Adds three new subcommands and three new envelope schemas:
- `freelo.task_labels.create/v1`
- `freelo.task_labels.attach/v1`
- `freelo.task_labels.detach/v1`

These are additive; no existing command, schema, or flag changed.
```

### Step 7 — Doc autogen

- Run `pnpm fix:readme` (regenerates README from introspection — captures three new subcommands).

### File touch budget

- 10 new src files, 4 new test files, 1 changeset, 1 modified (`freelo.ts`), 1 README diff (auto) = **17 files**. Within budget (25).

### Order of work

1. schemas (no deps)
2. api wrappers (deps: schemas)
3. human renderers (deps: schemas only via type imports)
4. command leaves (deps: api + renderers + schemas)
5. parent registrar
6. wire into `bin/freelo.ts`
7. typecheck/lint loop (early — catches type errors before tests are written)
8. tests
9. test loop
10. coverage check
11. doc autogen
12. changeset
13. local gates on committed tree

### No new dependencies. No security review trigger.
