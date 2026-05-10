# Spec 0054 — `freelo custom-fields types` / `freelo custom-fields list` (R40, Wave 7)

**Status:** Draft
**Owner:** orchestrator (run `2026-05-10-r40-custom-fields-types-list`)
**Roadmap:** R40 (opens Wave 7)
**Date:** 2026-05-10
**Depends on:** R04 (`projects show` — established the project-id parsing convention).

## 1. Problem

Freelo lets project commanders define **custom fields** on a project — typed
columns (text, number, enum) that tasks in that project then expose. The web
UI surfaces them in the task list / detail view; the matching REST endpoints
are documented at `docs/api/freelo-api.yaml:4012-4042` (`GET /custom-field/get-types`)
and `docs/api/freelo-api.yaml:4529-4561` (`GET /custom-field/find-by-project/{project_id}`).

Today, agents and shell scripts cannot:

1. Discover the catalog of custom-field type UUIDs (text / number / enum) needed
   to call `POST /custom-field/create/{project_id}` (R41) without hard-coding
   the three UUIDs from the OpenAPI description.
2. List the custom fields configured on a given project — to know what UUIDs
   to read or write, or to render the field-column board for a project.
3. Detect (programmatically) whether the caller is the project commander —
   the boolean Freelo returns alongside the field list, which gates R41+
   mutation endpoints.

R40 closes both gaps with two read-only commands. This is the **first slice
of Wave 7** (custom fields, notes, pinned items); it lays down the
`custom-fields` parent that R41 (create/rename/delete/restore), R42
(value set/clear), and R43 (enum) will hang their leaves on.

## 2. Proposal

### 2.1 CLI surface (additive — one new parent + two new leaves)

```
freelo custom-fields types
freelo custom-fields list --project <id>
```

Both leaves are read-only. No `--dry-run` (decision 5 — pure GET, dry-run on
a read is a no-op surprise; mirrors spec 0052 / R38 `tasks relations`). No
`--yes` (non-destructive). Standard global flags (`--output`, `--profile`,
`--request-id`, `-v`/`-vv`) inherit from the root.

Pagination: not applicable. Both endpoints return the full list in one
response — `get-types` because there are exactly three documented type UUIDs
(text / number / enum), and `find-by-project` because Freelo's documented
shape is a flat array (yaml :4554-4558) with no pagination envelope, page
parameter, or cursor.

### 2.2 Wire mappings

#### `GET /custom-field/get-types` (yaml :4012-4042)

Request: no body, no query, no path params.

Response (yaml :4029-4041):

```jsonc
{
  "custom_field_types": [
    { "uuid": "2f7bfe3a-c950-470e-b910-95b4caf5dc4f", "name": "text" },
    { "uuid": "b1e56fa9-a97a-429b-8ab4-82bebe58933a", "name": "number" },
    { "uuid": "f9729a8f-d340-40e4-b2c0-dc46c37e18ce", "name": "enum" }
  ]
}
```

The three documented UUIDs are referenced in `docs/api/freelo-api.yaml:4081-4085`
as the canonical type-uuid set. The server may add more in the future
(`.passthrough()` defends against unknown types).

#### `GET /custom-field/find-by-project/{project_id}` (yaml :4529-4561)

Request: `project_id` path param (positive integer).

Response (yaml :4548-4560):

```jsonc
{
  "custom_fields": [
    {
      "uuid": "<uuid>",
      "custom_fields_types_uuid": "<uuid>",
      "project_id": <int>,
      "author_id": <int>,
      "name": "<str>",
      "date_add": "<iso-8601>",
      "priority": <int>
    }
  ],
  "is_commander": true
}
```

Per `CustomField` schema (yaml :6054-6073). All seven fields are documented
without `required:` markers — applied `.nullable().optional()` defensively
per the project's schema convention, except `uuid` and `name` which we treat
as required-on-the-wire (a custom-field row without a uuid or a name is
unusable; if the server returns one we want to know — surface as a zod
validation error, exit 4).

### 2.3 Output schemas

#### `freelo.custom-fields.types/v1` (new)

| Field | Type | Always present | Notes |
| --- | --- | --- | --- |
| `types` | `CustomFieldType[]` | yes | One row per documented type. `[{ uuid, name }]`. |

`CustomFieldType` = `{ uuid: string; name: string }` (passthrough for
forward-compatibility).

#### `freelo.custom-fields.list/v1` (new)

| Field | Type | Always present | Notes |
| --- | --- | --- | --- |
| `project_id` | int | yes | Echo of `--project <id>` (agent self-correlation). |
| `custom_fields` | `CustomField[]` | yes | Server-returned array. May be empty `[]` (no fields configured). |
| `is_commander` | boolean | yes | Server signal — true if the caller can call R41+ mutation endpoints on this project. |

### 2.4 Validation rules

#### `custom-fields types`

- No flags, no positional args. Help text only.

#### `custom-fields list`

- `--project <id>` is **required**. Missing → `ValidationError` (exit 2)
  with hint pointing at `freelo projects list` for ids.
- `--project <id>` must be a positive integer. Reject via `ValidationError`
  (exit 2) — Commander's `InvalidArgumentError` falls through to exit 1
  (calibration §1-2). Hint: "Pass `--project <id>` where `<id>` is the
  numeric project id."

All validation lives in Commander parser callbacks AND a final
`validateFlags(opts)` for "missing required" detection — same shape as
spec 0053 §2.4 / spec 0052 / spec 0049.

### 2.5 Hint mapping (4xx)

#### `custom-fields types`

- **401** → top-level `AUTH_EXPIRED` exit 3 (no special hint).
- **403** → unlikely (the endpoint has no project-scoped permissions);
  default `FreeloApiError` message.
- **5xx / 429 / network** → standard error envelopes (no command-specific
  hint).

#### `custom-fields list`

- **400** with `project_id` mention → "`--project <id>` must reference a
  project the caller can access. Run `freelo projects list` for ids."
- **400** generic → "Server-side validation rejected the request."
- **403** → "Account does not have permission to read custom fields on this
  project."
- **404** → "Project not found. Run `freelo projects list` for ids."
- **5xx / 429 / network** → standard error envelopes.

The same `rewriteApiHint` idiom from spec 0053 §2.7 / spec 0052 — inline in
the command file, not extracted (decision 3 below).

### 2.6 Help text

#### `custom-fields types`

```
Usage: freelo custom-fields types [options]

List the catalog of custom-field type definitions (text, number, enum)
available for use when creating a custom field. Each type's `uuid` is
the value passed to `POST /custom-field/create/{project_id}` (the future
`freelo custom-fields create` command, R41).

Options:
  -h, --help              display help for command
```

#### `custom-fields list`

```
Usage: freelo custom-fields list [options]

List all custom-field definitions configured on a project, plus the
caller's commander status. Soft-deleted fields are excluded by Freelo.
The `is_commander` boolean tells you whether the caller can call the
R41+ mutation endpoints on this project (create / rename / delete / restore).

Options:
  --project <id>          Project id (required, positive integer).
  -h, --help              display help for command
```

### 2.7 Examples

```bash
# List the type catalog
$ freelo custom-fields types
text     2f7bfe3a-c950-470e-b910-95b4caf5dc4f
number   b1e56fa9-a97a-429b-8ab4-82bebe58933a
enum     f9729a8f-d340-40e4-b2c0-dc46c37e18ce

# JSON for agents
$ FREELO_API_KEY=… FREELO_EMAIL=… freelo custom-fields types --output json
{"schema":"freelo.custom-fields.types/v1","data":{"types":[{"uuid":"2f7bfe3a-...","name":"text"}, ...]}}

# List the custom fields configured on project 100
$ freelo custom-fields list --project 100
Project #100 — 2 custom field(s), is_commander=true:
  Severity      type=2f7bfe3a-...  priority=1  uuid=11111111-...
  Story Points  type=b1e56fa9-...  priority=2  uuid=22222222-...

# Empty project
$ freelo custom-fields list --project 200
Project #200 — no custom fields, is_commander=false.

# JSON for agents
$ freelo custom-fields list --project 100 --output json
{"schema":"freelo.custom-fields.list/v1","data":{"project_id":100,"custom_fields":[…],"is_commander":true}}
```

## 3. Data model

### 3.1 New file: `src/api/schemas/custom-field.ts`

```ts
import { z } from 'zod';

/**
 * `CustomFieldType` — one row of `GET /custom-field/get-types`
 * (yaml :4029-4041). The OpenAPI marks the two fields without
 * `required:`; we treat both as required-on-the-wire — a type row
 * without a uuid is unusable. `.passthrough()` keeps unknown future
 * fields (e.g. `priority`, localised name) instead of stripping them.
 */
export const CustomFieldTypeSchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
  })
  .passthrough();
export type CustomFieldType = z.infer<typeof CustomFieldTypeSchema>;

export const GetCustomFieldTypesResponseSchema = z
  .object({
    custom_field_types: z.array(CustomFieldTypeSchema),
  })
  .passthrough();
export type GetCustomFieldTypesResponse = z.infer<typeof GetCustomFieldTypesResponseSchema>;

/**
 * `CustomField` — one custom-field definition (yaml :6054-6073).
 * Documented fields: `uuid, custom_fields_types_uuid, project_id,
 * author_id, name, date_add, priority`.
 *
 * Per project schema convention: any optional field on an inbound
 * response is also nullable. `uuid` and `name` are treated as
 * required-on-the-wire — a custom-field row without one is unusable.
 */
export const CustomFieldSchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
    custom_fields_types_uuid: z.string().nullable().optional(),
    project_id: z.number().int().nullable().optional(),
    author_id: z.number().int().nullable().optional(),
    date_add: z.string().nullable().optional(),
    priority: z.number().int().nullable().optional(),
  })
  .passthrough();
export type CustomField = z.infer<typeof CustomFieldSchema>;

export const FindCustomFieldsByProjectResponseSchema = z
  .object({
    custom_fields: z.array(CustomFieldSchema),
    is_commander: z.boolean(),
  })
  .passthrough();
export type FindCustomFieldsByProjectResponse = z.infer<
  typeof FindCustomFieldsByProjectResponseSchema
>;

/* ---------------------------------------------------------------------------
 *  Envelope `data` types (consumed by `src/commands/custom-fields/{types,list}.ts`).
 * ------------------------------------------------------------------------- */

export type CustomFieldsTypesData = {
  types: CustomFieldType[];
};

export type CustomFieldsListData = {
  project_id: number;
  custom_fields: CustomField[];
  is_commander: boolean;
};
```

### 3.2 New file: `src/api/custom-fields.ts`

Mirrors `src/api/tasks-relations.ts` one-for-one (read-only, two endpoints,
opt-spread for `signal` / `requestId`):

- `getCustomFieldTypesPath()` — `'/custom-field/get-types'` constant.
- `findCustomFieldsByProjectPath(projectId)` — `/custom-field/find-by-project/${projectId}`.
- `getCustomFieldTypes(client, opts)` — GET + zod validate.
- `findCustomFieldsByProject(client, projectId, opts)` — GET + zod validate.

Each function uses the conditional `signal` / `requestId` opt-spread
(`exactOptionalPropertyTypes` requires the `... !== undefined ? { signal: opts.signal } : {}`
shape). Both branches per spread are tested in the sibling
`test/api/custom-fields.test.ts` — mandatory per calibration §4.

### 3.3 New file: `src/commands/custom-fields/types.ts`

Same shape as `src/commands/tasks/relations.ts` (read-only, no positional
arg, no flags):

- `meta.outputSchema = 'freelo.custom-fields.types/v1'`, `destructive: false`.
- Calls `getCustomFieldTypes(client, opts)`.
- Builds envelope, renders human via `renderCustomFieldsTypesHuman(data)`.
- Top-level error handler.

### 3.4 New file: `src/commands/custom-fields/list.ts`

Mirrors `src/commands/tasks/find-relations.ts` shape (read-only, flag-based,
required `--project <id>`):

- `meta.outputSchema = 'freelo.custom-fields.list/v1'`, `destructive: false`.
- `--project <id>` (required, positive int, `parsePositiveIntFlag` callback).
- `validateFlags` checks `opts.project` is set; throws
  `ValidationError` exit 2 if missing.
- `rewriteApiHint(err)` per §2.5.
- Builds envelope (echoes `project_id` from the input), renders human via
  `renderCustomFieldsListHuman(data)`.

### 3.5 New file: `src/commands/custom-fields.ts`

Parent registrar — mirrors `src/commands/tasks/project.ts`:

```ts
import { type Command } from 'commander';
import { type GetAppConfig } from '../config/schema.js';
import { registerTypes } from './custom-fields/types.js';
import { registerList } from './custom-fields/list.js';

export function register(
  program: Command,
  getConfig: GetAppConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const customFields = program
    .command('custom-fields')
    .description(
      'Inspect Freelo custom-field type definitions and the custom fields configured on a project. Read-only — write commands (create / rename / delete / restore / value set) land in later Wave 7 slices.',
    );

  registerTypes(customFields, getConfig, env);
  registerList(customFields, getConfig, env);
}
```

### 3.6 New files: `src/ui/human/custom-fields-types.ts`, `src/ui/human/custom-fields-list.ts`

Plain-text renderers, no chalk (read commands echo to stdout — colors only
when `wantsColor`, but the renderer returns a string and the wrapper applies
the color policy; mirrors spec 0052 / R38 renderers).

`custom-fields-types.ts`:
```
text     2f7bfe3a-c950-470e-b910-95b4caf5dc4f
number   b1e56fa9-a97a-429b-8ab4-82bebe58933a
enum     f9729a8f-d340-40e4-b2c0-dc46c37e18ce
```

Two columns, name left-aligned, uuid right-padded. Width-aware.

`custom-fields-list.ts`:

- Empty: `Project #<id> — no custom fields, is_commander=<bool>.`
- Non-empty:
  ```
  Project #<id> — N custom field(s), is_commander=<bool>:
    <name>  type=<short-uuid>  priority=<n>  uuid=<short-uuid>
  ```

### 3.7 Modify: `src/bin/freelo.ts`

Add the `customFields` import + register call alongside the other registrars:

```ts
const { register: registerCustomFields } = await import('../commands/custom-fields.js');
// ...
registerCustomFields(program, getAppConfig, env);
```

Place after `registerNotifications` (alphabetical-ish ordering ignored — chronologically by wave).

### 3.8 No changes to introspect-golden

The introspect-golden test compares specific subtrees by command name. Adding
`custom-fields types` / `custom-fields list` does not alter any locked
subtree. Verify by grep before commit; re-run `pnpm fix:readme` to regen the
README's autogen Commands block.

## 4. Edge cases

| Edge case | Handling |
|---|---|
| `custom-fields types` no flags | OK; emits envelope. |
| `custom-fields list` missing `--project` | `ValidationError` exit 2 with hint. |
| `--project abc` | `ValidationError` exit 2 (parsePositiveIntFlag rejects). |
| `--project 0` / negative | `ValidationError` exit 2. |
| `custom-fields list` returns `custom_fields: []` | OK; empty array preserved in envelope; human renderer prints "no custom fields" line. |
| `custom-fields list` returns extra fields beyond documented seven | `.passthrough()` carries them; envelope contract unchanged for known fields. |
| `is_commander: false` | OK; surfaced verbatim; human renderer reflects in trailer. |
| Server returns `custom_fields_types_uuid: null` | OK; schema is nullable.optional. |
| 400 with `project_id` mention | hintNext per §2.5. |
| 400 generic | Generic server-side validation hint. |
| 401 | `AUTH_EXPIRED` exit 3 (top-level handler). |
| 403 | `FreeloApiError` exit 4 with permission hint. |
| 404 | `FreeloApiError` exit 4 with "Project not found" hint. |
| 429 | `RATE_LIMITED` exit 6 retryable. |
| 5xx | `SERVER_ERROR` exit 4. |
| Network failure | `NETWORK_ERROR` exit 5. |

## 5. Non-goals

- **No `--show-deleted` flag.** Soft-deleted fields excluded server-side; we
  do not add a flag for the absent surface.
- **No filtering by type.** `custom-fields list --type enum` is not in scope —
  no server-side filter, and client-side filter is trivial via `jq`.
- **No `enum_options` data on the list response.** Description at yaml :4543
  claims options are "embedded" but the documented schema (`:6054`) has no
  such field. We do not invent fields. `--with enum-options` is tracked as
  R43 (which has its own `/custom-field-enum/get-for-custom-field/{uuid}`
  endpoint).
- **No write commands.** R41 (create / rename / delete / restore), R42 (value
  set / clear), R43 (enum CRUD) are separate slices.
- **No envelope changes elsewhere.** No bumps to `freelo.projects.show/v1`
  or any other existing schema.
- **No `--include-types` side-car on `list`.** The two commands are sibling,
  not chained — agents call `types` once, `list` per project.

## 6. Open questions

None. All decisions resolved in §7.

## 7. Decisions made autonomously

### Decision 1 — Parent-without-action shape; two leaves

**Question:** Should `custom-fields` be a flat parent with two siblings
(`custom-fields types`, `custom-fields list`) or a leaf with a
discriminator flag (`custom-fields --target types|list`)?

**Decision:** Parent + two leaves. Parent has no `meta`, no action — only children.

**Alternatives considered:**

- Single leaf `custom-fields list [--project <id>]` where omitting
  `--project` lists types — rejected; conflates two distinct outputs
  (different envelope schemas, different cardinality), inflates the help
  text, and doesn't extend cleanly to R41+ siblings (`create`, `rename`,
  `value set`, etc).
- Mode flag `custom-fields list --types` — rejected; same reason. Mode flags
  are an antipattern when the operation is genuinely different.

**Rationale:** Mirrors `tasks remind {set,clear}`, `tasks estimate {set,clear}`,
`tasks project {add,remove}` — every parent-with-related-leaves precedent in
this codebase. Wave 7 will keep adding leaves under `custom-fields` (R41
adds `create / rename / delete / restore`; R42 adds `value set / value clear`;
R43 adds `enum {list, add, rename, delete}`). The parent-without-action shape
scales with no rework.

### Decision 2 — `--project <id>` flag (not positional)

**Question:** Should `custom-fields list` take `<project_id>` as a positional
arg or `--project <id>` as a flag?

**Decision:** Flag.

**Alternatives considered:**

- Positional `custom-fields list <project_id>` — rejected; future leaves
  in the parent (`custom-fields create-from-template <template_id>`-style
  hypotheticals) might want a positional for a different id (e.g. a field
  uuid), and a positional `<id>` would be ambiguous. Flag is unambiguous.

**Rationale:** Mirrors `freelo tasks list --project <id>...`,
`freelo tasklists list --project <id>`, `freelo files list --project <id>` —
every project-scoped list in this codebase uses the flag. Stays consistent.

### Decision 3 — Inline `rewriteApiHint` (not extracted)

**Question:** Where should the 4xx → `hintNext` mapping live?

**Decision:** Inline `rewriteApiHint(err)` helper in
`src/commands/custom-fields/list.ts`. `types` doesn't need one (no
project-scoped errors).

**Alternatives considered:**

- Shared `src/lib/custom-fields-hint.ts` — rejected; one consumer in this
  slice, premature DRY.

**Rationale:** Mirrors spec 0052 / 0053 inline-helper precedent. Audit-friendly.

### Decision 4 — Exposed path helpers

**Question:** Should `getCustomFieldTypesPath()` and
`findCustomFieldsByProjectPath(projectId)` be exported helpers, or built
inline?

**Decision:** Exported helpers.

**Alternatives considered:**

- Inline string interpolation in the wrapper — rejected; two sources of
  truth if used elsewhere (e.g. dry-run path echo in a future slice).

**Rationale:** Mirrors `taskRelationsPath` / `findTaskRelationsPath`
precedent in `src/api/tasks-relations.ts`. Lets the API-level unit test
assert the path string in isolation.

### Decision 5 — No `--dry-run`, no `--yes`

**Question:** Should the read commands accept `--dry-run` for symmetry with
the write commands in Wave 6?

**Decision:** No. Both leaves omit `--dry-run` and `--yes`.

**Alternatives considered:**

- Add `--dry-run` for shape-stability — rejected; `--dry-run` on a pure GET
  is a no-op surprise that mirrors no precedent.

**Rationale:** Mirrors spec 0052 / R38 `tasks relations` decision 5 verbatim
("No `--dry-run` (decision 5 — pure GET, dry-run on a read is a no-op
surprise"). Read-only commands in this codebase do not carry write-mode
flags.

### Decision 6 — `is_commander` exposed verbatim in envelope, surfaced in human trailer

**Question:** What format should `is_commander` take in the human render?

**Decision:**

- Envelope: top-level boolean field `is_commander: true|false`.
- Human renderer: include in the trailer line — `Project #N — M custom field(s), is_commander=true:`.

**Alternatives considered:**

- Drop from envelope, prefix human output with `[admin]` indicator —
  rejected; agents drive this CLI primarily, structural data > visual cues.
- Surface as a separate flag-able view (`custom-fields list --check-commander`) —
  rejected; one extra flag for one boolean is overkill.

**Rationale:** The Freelo API explicitly returns it (yaml :4559) because it
gates the R41+ mutation endpoints on the same project. Agents need the bit
to decide whether `freelo custom-fields create --project <id>` will be
accepted before sending it. Keeping it in the envelope makes that one HTTP
call instead of two (call create, parse 403, then check this — two RTTs
becomes one).

### Decision 7 — Treat `uuid` and `name` as required-on-the-wire

**Question:** OpenAPI marks neither field `required:`. Treat them as
required (zod-validate, exit 4 if missing) or apply `.nullable().optional()`?

**Decision:** Required (`z.string()` without `.nullable().optional()`).

**Alternatives considered:**

- Apply `.nullable().optional()` to both — rejected; a custom-field row
  without a uuid is unusable for the R41+ mutation endpoints (they
  identify the field by uuid). A row without a name is unrenderable.
  Defensive-nullable hides bugs we want to see.

**Rationale:** Mirrors spec 0052 `TaskRelation` decision (`type` and
`related_task_id` required, `related_task_name` nullable.optional). The
defensive-nullable rule is for fields that *could* legitimately be null —
not for the row's identifying fields. Calibration §1: hide fewer bugs.

## Plan

### Branch

`feat/r40-custom-fields-types-list` (from `main`).

### Files to create

| Path | Intent |
| --- | --- |
| `src/api/schemas/custom-field.ts` | Zod schemas for `CustomFieldType` + `CustomField` + both response shapes + envelope `data` types. |
| `src/api/custom-fields.ts` | Path helpers + `getCustomFieldTypes()` + `findCustomFieldsByProject()` wire wrappers. |
| `src/commands/custom-fields.ts` | Parent registrar (no action, two children). |
| `src/commands/custom-fields/types.ts` | `custom-fields types` leaf. |
| `src/commands/custom-fields/list.ts` | `custom-fields list --project <id>` leaf. |
| `src/ui/human/custom-fields-types.ts` | Human renderer for the type catalog. |
| `src/ui/human/custom-fields-list.ts` | Human renderer for the per-project list. |
| `test/api/custom-fields.test.ts` | **Mandatory per calibration §4** — covers `signal` / `requestId` opt-spread branches AND path helper output. |
| `test/commands/custom-fields/types.test.ts` | Integration tests with MSW: happy path, empty, JSON envelope, human, errors, introspect. |
| `test/commands/custom-fields/list.test.ts` | Integration tests with MSW: happy path, empty, JSON envelope, human, validation, errors, introspect. |
| `docs/commands/custom-fields-types.md` | User-facing docs (synopsis, examples, errors). |
| `docs/commands/custom-fields-list.md` | User-facing docs (synopsis, options, examples, errors). |
| `.changeset/r40-custom-fields-types-list.md` | `freelo-cli: minor` (new commands + new envelope schemas). |

### Files to modify

| Path | Change |
| --- | --- |
| `src/bin/freelo.ts` | Import + call `registerCustomFields(program, getAppConfig, env)`. |
| `test/msw/handlers.ts` | Add `customFieldsTypesHandlers` (~5-handler set: ok, unauthorized, rateLimited, serverError, network already covered by client default) + `customFieldsListHandlers` (~7-handler set: ok, okEmpty, badRequest, unauthorized, forbidden, notFound, serverError). |
| `README.md` | Autogen Commands block — `pnpm fix:readme` regenerates. |

### Files NOT modified

- `src/api/client.ts`, `src/errors/handle.ts`, `src/config/**` — Yellow tier; untouched.
- `src/lib/` — no helper extraction (decision 3).
- `test/fixtures/introspect-golden.json` — verified via grep that the new leaves are not in the golden's locked subset. If they are, regen via `pnpm fix:readme`.

### New runtime dependencies

**None.**

### Test strategy

#### Unit tests — `test/api/custom-fields.test.ts` (mandatory per calibration §4)

Pattern: `fakeClient` that records `request()` opts, no MSW. Copy
`test/api/tasks-relations.test.ts`. Covers:

- `getCustomFieldTypesPath()` returns `/custom-field/get-types` (constant).
- `findCustomFieldsByProjectPath(100)` returns `/custom-field/find-by-project/100`.
- `getCustomFieldTypes(client)` GETs the right path, returns parsed body.
- `findCustomFieldsByProject(client, 100)` GETs the right path, returns parsed body.
- **Branch-coverage hardening (calibration §4):**
  - `signal` is threaded through when defined (each function).
  - `requestId` is threaded through when defined (each function).
  - Both are absent from the request when not provided (covered by the
    "GETs the right path" tests above — the `request()` opts assert no
    `signal` / `requestId` keys present).

Total: ~10 tests, ~120 lines.

#### Integration tests — `test/commands/custom-fields/types.test.ts`

Use MSW (`customFieldsTypesHandlers`). Cover:

**Happy paths:**

- 200 with three documented type rows → JSON envelope, exit 0, schema
  `freelo.custom-fields.types/v1`, `data.types[0].uuid` populated.
- 200 with empty `custom_field_types: []` → envelope's `data.types` is `[]`.
- Human mode: stdout contains all three names.

**HTTP errors (every one asserts the documented exit code per calibration §2):**

- 401 → exit 3 `AUTH_EXPIRED`.
- 429 → exit 6 `RATE_LIMITED` retryable.
- 5xx → exit 4 `SERVER_ERROR`.
- Network failure → exit 5 `NETWORK_ERROR`.

**Introspection:**

- `freelo --introspect` lists `custom-fields types` with `output_schema:
  'freelo.custom-fields.types/v1'` and `destructive: false`.

Total: ~9 tests, ~250 lines.

#### Integration tests — `test/commands/custom-fields/list.test.ts`

Use MSW (`customFieldsListHandlers`). Cover:

**Happy paths:**

- 200 with two custom-field rows + `is_commander: true` → JSON envelope
  carries them; exit 0; schema `freelo.custom-fields.list/v1`.
- 200 with empty `custom_fields: []` + `is_commander: false` → envelope
  preserves both.
- 200 with row having `custom_fields_types_uuid: null` → schema parses;
  envelope preserves null.
- Human mode (with rows): stdout contains "Project #100", "2 custom field(s)",
  "is_commander=true", and each row's name.
- Human mode (empty): stdout contains "no custom fields", "is_commander=false".

**Validation errors (every one asserts `exitCode: 2` per calibration §2):**

- Missing `--project` → `VALIDATION_ERROR` (message matches
  `/--project is required/`).
- `--project abc` → `VALIDATION_ERROR`.
- `--project 0` → `VALIDATION_ERROR`.
- `--project -1` → `VALIDATION_ERROR`.

**HTTP errors (every one asserts the documented exit code per calibration §2):**

- 400 with `project_id` reference → exit 4, hint mentions "must reference
  a project".
- 400 generic → exit 4, hint mentions "Server-side validation".
- 401 → exit 3 `AUTH_EXPIRED`.
- 403 → exit 4 with permission hint.
- 404 → exit 4 with "Project not found" hint.
- 429 → exit 6 `RATE_LIMITED`.
- 5xx → exit 4 `SERVER_ERROR`.
- Network failure → exit 5 `NETWORK_ERROR`.

**Introspection:**

- `freelo --introspect` lists `custom-fields list` with `output_schema:
  'freelo.custom-fields.list/v1'` and `destructive: false`. `flags[]`
  includes `--project` with `required: true`.

Total: ~17 tests, ~450 lines.

#### Coverage callouts

- **Calibration §1:** test phase runs to completion before commit.
- **Calibration §2:** every error-class path asserts `exitCode`
  (`ValidationError` 2, `FreeloApiError` 4 / 3 for AUTH_EXPIRED,
  `RateLimitedError` 6, `NetworkError` 5).
- **Calibration §3:** five-gate before push (`pnpm typecheck && pnpm lint
  && pnpm test && pnpm build && pnpm check:readme`).
- **Calibration §4 (R38 PR #96 finding):** `test/api/custom-fields.test.ts`
  covers both `signal`-defined and `requestId`-defined opt-spread branches
  in the new `src/api/custom-fields.ts`. Without this file, the new
  wrapper drops `src/api/**` branch coverage below the 80% threshold.
- **Calibration §7:** no new TTY-prompt code path here — both leaves are
  read-only, no `confirmDestructive`.

#### Five-gate before push

`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`
must all pass on the **committed** tree before `git push -u`.

### Rollout

Single landable slice. Squash on PR merge:

`feat(commands): custom-fields types and list (R40)`

### Opens Wave 7

After this PR merges, Wave 7's foundation is in place (the `custom-fields`
parent + two read leaves). R41 (create / rename / delete / restore) hangs
its leaves on the same parent.
