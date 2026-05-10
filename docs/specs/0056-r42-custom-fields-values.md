# Spec 0056 — `freelo custom-fields value set` / `freelo custom-fields value clear` (R42, Wave 7)

**Status:** Draft
**Owner:** orchestrator (run `2026-05-10-r42-custom-fields-values`)
**Roadmap:** R42 (second slice of Wave 7; first writeable surface for custom fields)
**Date:** 2026-05-10
**Depends on:** R40 (`custom-fields types` / `custom-fields list` — established the `custom-fields` parent and the `CustomField` schema).

## 1. Problem

R40 shipped read-only commands for the custom-fields catalog and per-project field
list. Agents and shell scripts can now discover what custom fields exist on a
project, but they still cannot **write** values:

1. They cannot set or update a text / number value on a task for a given field.
2. They cannot pick an enum-option for an enum-typed field on a task.
3. They cannot clear (remove) a previously-set value, distinguishing "no value"
   from "empty string".

R42 closes those three gaps with two new leaves — `value set` (upsert) and
`value clear` (delete). It is the first **writeable** surface in the
`custom-fields` tree and unblocks all custom-field automation flows.

## 2. Proposal

### 2.1 CLI surface (additive — one new sub-parent + two new leaves)

```
freelo custom-fields value set --task <id> --field <uuid> (--value <str>|--enum <uuid>)
freelo custom-fields value clear --task <id> --field <uuid> [--yes] [--dry-run]
```

- `value set` — upsert. Creates a value if none exists for `(task_id, field_uuid)`,
  otherwise updates the existing one. Not destructive in the user-data sense
  (history row is written but no other data is lost), so no `--yes` gate on
  the upsert path. Standard `--dry-run` is supported.
- `value clear` — destructive: clears the value record on the task for the
  given field. Requires `--yes` (non-TTY) or interactive confirmation (TTY).
  Same `--dry-run` semantics. **Idempotent**: a `(task, field)` pair with no
  existing value returns `already_in_target_state: true` and exit 0. Same
  applies if the DELETE returns 404 (value vanished mid-flight).

Standard global flags (`--output`, `--profile`, `--request-id`, `-v`/`-vv`,
`--ids`/`--stdin` for batches) inherit from the root.

Pagination: not applicable.

### 2.2 Wire mappings

#### `POST /custom-field/add-or-edit-value` — scalar (text / number)

OpenAPI yaml :4198-4244.

Request body (snake_case — confirmed yaml :4228):

```jsonc
{
  "custom_field_uuid": "<field-uuid>",
  "task_id": <int>,
  "value": "<str>"
}
```

Response (yaml :4243-4244): `{ "custom_field_value": <CustomFieldValue> }` —
upsert returns the resulting record (its uuid, value, task_id, custom_field_uuid,
date_add, date_edited_at, author_id).

Cross-project rule (yaml :4212): the task and the custom field MUST belong
to the same project — otherwise HTTP 409 Conflict with `"Custom field is in
the different project than the task."`.

#### `POST /custom-field/add-or-edit-enum-value` — enum

OpenAPI yaml :4246-4294.

Request body — **note camelCase** key for the field uuid (yaml :4276):

```jsonc
{
  "customFieldUuid": "<field-uuid>",
  "task_id": <int>,
  "value": "<enum-option-uuid>"
}
```

`value` is the **uuid of an enum option**, not the display string. Caller looks
options up via `freelo custom-fields enum list --field <uuid>` (R43, future).
We do not validate the enum-option-uuid client-side; the server returns 404
"Enum was not found." when it doesn't exist or doesn't belong to this field
(yaml :4262).

Response (yaml :4293-4294): `{ "customFieldEnum": <CustomFieldEnumValue> }` —
note camelCase wrapper key too.

#### `DELETE /custom-field/delete-value/{uuid}` — clear

OpenAPI yaml :4296-4324.

Path param: **value-uuid** (NOT field-uuid). 404 if the value uuid doesn't
exist or belongs to a deleted custom field.

Response (yaml :4318-4324): `{ result: "success" }` (the standard
`SuccessResponse` wrapper).

#### Read-back for `value clear` — `GET /task/{task_id}`

OpenAPI yaml :1662-1689. Returns `TaskDetail` (yaml :5407-5474) which contains:

```jsonc
{
  "custom_fields": [
    {
      "field_uuid": "<field-uuid>",
      "custom_fields_types_uuid": "<type-uuid>",
      "value_uuid": "<value-uuid>",
      "value": "<str>",
      ...
    }
  ]
}
```

(`CustomFieldWithValue`, yaml :6135-6166.)

This is **the only documented way** to resolve a `(task_id, field_uuid)` pair
to a `value_uuid`. The CLI's `value clear` performs read-then-delete:

1. `GET /task/{task_id}` → if `custom_fields[]` does not contain an entry with
   `field_uuid === <field>` (or that entry has no `value_uuid`), the value is
   already absent → return `already_in_target_state: true`, exit 0, **no
   DELETE issued** (idempotency arm 1).
2. Otherwise, `DELETE /custom-field/delete-value/{value_uuid}`. On 404 (race
   condition: value vanished between GET and DELETE) → `already_in_target_state: true`,
   exit 0 (idempotency arm 2).
3. Other non-2xx → bubble.

This is one extra round-trip per call but it's the only contract Freelo gives
us. We document the trade-off in the command help and in the user docs.

### 2.3 Mutex semantics

For `value set`:

- Exactly one of `--value <str>` and `--enum <uuid>` MUST be supplied.
  Both → `ValidationError`. Neither → `ValidationError`.
- `--value` selects the scalar endpoint. `--enum` selects the enum endpoint.
- We do NOT consult `GET /custom-field/get-types` to check the type of the
  field client-side. Reasons: extra round-trip on every call, and the server
  already returns a clean error if the wrong endpoint is hit (yaml :4213).

For `value clear`:

- `--task` and `--field` are both required. No mutex.

### 2.4 Output envelopes

`freelo.custom-fields.value-set/v1`:

```jsonc
{
  "schema": "freelo.custom-fields.value-set/v1",
  "data": {
    "task_id": 123,
    "field_uuid": "<uuid>",
    "kind": "scalar" | "enum",
    "value_uuid": "<uuid>",         // server-generated/preserved
    "value": "<raw>",               // for scalar: the string. for enum: the enum-option uuid
    "previous_value_uuid": null,    // best-effort; null when not known
    "would": { "method": "POST", "path": "<path>", "body": <obj> },  // dry-run only
    "input_index": 0,               // batch-positional only
    "line_index": 0                 // --stdin only
  },
  "rate_limit": { "remaining": 99, "reset_at": "..." },
  "request_id": "..."
}
```

Notes:
- `kind` is the dispatcher hint so consumers can reason about what got set.
- `previous_value_uuid` is null in v1 because the upsert endpoint doesn't return
  it; we do not pre-GET to discover it (extra round-trip). Reserved for future
  extension.
- Schema additions later (e.g. `previous_value`) are minor bumps per the
  envelope-stability contract.

`freelo.custom-fields.value-clear/v1`:

```jsonc
{
  "schema": "freelo.custom-fields.value-clear/v1",
  "data": {
    "task_id": 123,
    "field_uuid": "<uuid>",
    "value_uuid": "<uuid>" | null,  // null when read-back found nothing (already-cleared)
    "previous_state": "set" | "absent",
    "current_state": "absent",
    "already_in_target_state": false,  // true when read-back found nothing OR DELETE was 404
    "would": { "method": "DELETE", "path": "<path>", "body": {} },  // dry-run only
    "input_index": 0,
    "line_index": 0
  }
}
```

### 2.5 Error mapping

Inherits from `FreeloApiError` and the global error handler (typed exit codes).
The two new commands add **command-specific hint rewrites** for the well-known
cases:

- `value set` (scalar):
  - 400 mentioning `value`     → "scalar field expects a string. For enum fields use --enum."
  - 400 generic                → server-side validation hint.
  - 404                        → "Task or custom field not found. Run `freelo custom-fields list --project <id>` for ids."
  - 409                        → "Custom field is in a different project than the task."
- `value set` (enum):
  - 404 mentioning "Enum"      → "Enum option uuid not found. Run `freelo custom-fields enum list --field <uuid>` for ids (R43)."
  - 404 generic                → "Task or custom field not found."
  - 409                        → same project-mismatch hint.
- `value clear`:
  - read-back 404 (task gone)  → bubbles as FreeloApiError 404 with hint "Task not found."
  - DELETE 404 (value gone)    → idempotent skip.
  - DELETE 403                 → "Account cannot edit custom-field values on this task."

### 2.6 Batch input

Both commands support `--ids`-style batch via `--stdin` NDJSON (one job per line).
Positional batch (`--ids`-list) does not fit because each job carries multiple
fields (`task`, `field`, value/enum) — NDJSON is the cleaner shape.

Per-line shape for `value set`:

```jsonc
{ "task_id": 123, "field_uuid": "<uuid>", "value": "<str>" }
{ "task_id": 124, "field_uuid": "<uuid>", "enum": "<uuid>" }
```

(Mutex still applies per line.)

Per-line shape for `value clear`:

```jsonc
{ "task_id": 123, "field_uuid": "<uuid>" }
```

## 3. Data model

### 3.1 Zod schemas (new in `src/api/schemas/custom-field.ts`)

```ts
// Server-returned record from POST /custom-field/add-or-edit-value
export const CustomFieldValueSchema = z
  .object({
    uuid: z.string(),
    value: z.string().nullable().optional(),
    task_id: z.number().int().nullable().optional(),
    custom_field_uuid: z.string().nullable().optional(),
    date_add: z.string().nullable().optional(),
    date_edited_at: z.string().nullable().optional(),
    author_id: z.number().int().nullable().optional(),
  })
  .passthrough();

export const AddOrEditCustomFieldValueResponseSchema = z
  .object({ custom_field_value: CustomFieldValueSchema })
  .passthrough();

// Server-returned record from POST /custom-field/add-or-edit-enum-value
// Same shape as scalar but wrapped under camelCase key.
export const CustomFieldEnumValueSchema = CustomFieldValueSchema; // identical fields per yaml :6098-6119
export const AddOrEditCustomFieldEnumValueResponseSchema = z
  .object({ customFieldEnum: CustomFieldEnumValueSchema })
  .passthrough();

// CustomFieldWithValue (for read-back via GET /task/{id})
export const CustomFieldWithValueSchema = z
  .object({
    field_uuid: z.string(),
    custom_fields_types_uuid: z.string().nullable().optional(),
    project_id: z.number().int().nullable().optional(),
    name: z.string().nullable().optional(),
    priority: z.number().int().nullable().optional(),
    field_date_add: z.string().nullable().optional(),
    value_uuid: z.string().nullable().optional(),
    value_author_id: z.number().int().nullable().optional(),
    value: z.string().nullable().optional(),
    value_date_add: z.string().nullable().optional(),
    value_date_edited_at: z.string().nullable().optional(),
  })
  .passthrough();
```

We do NOT widen `TaskDetailSchema.custom_fields` (currently `z.array(z.unknown())`) —
instead, we re-validate just that array with `z.array(CustomFieldWithValueSchema)`
inside the `value clear` command after fetching the task. Reasons: keeps the
diff small, doesn't risk regressing R08 (`tasks show`), and the re-parse is
local to the one place that needs typed access.

### 3.2 Envelope `data` types (new)

```ts
export type CustomFieldsValueSetData = {
  task_id: number;
  field_uuid: string;
  kind: 'scalar' | 'enum';
  value_uuid: string | null;
  value: string;
  previous_value_uuid: string | null;
  would?: { method: 'POST'; path: string; body: Record<string, unknown> };
  input_index?: number;
  line_index?: number;
};

export type CustomFieldsValueClearData = {
  task_id: number;
  field_uuid: string;
  value_uuid: string | null;
  previous_state: 'set' | 'absent';
  current_state: 'absent';
  already_in_target_state: boolean;
  would?: { method: 'DELETE'; path: string; body: Record<string, unknown> };
  input_index?: number;
  line_index?: number;
};
```

## 4. Edge cases

1. **Both `--value` and `--enum`** → `ValidationError` exit 2.
2. **Neither** → `ValidationError` exit 2.
3. **Bad task id** (zero, negative, non-integer) → `ValidationError` exit 2.
4. **Bad field uuid** (empty after trim) → `ValidationError` exit 2 with hint
   "Run `freelo custom-fields list --project <id>` for the field uuid."
   We do NOT regex-check the uuid format; let the server reject typos.
5. **`--enum` value isn't a uuid** (e.g. user pasted the display label) →
   server returns 404 "Enum was not found." → we surface a friendlier hint.
6. **Cross-project task/field mismatch** → server 409 → mapped hint.
7. **`value clear` on a task that has no value for the field** → 0 wire calls
   beyond the read-back; idempotent success. **`previous_state: "absent"`,
   `already_in_target_state: true`.**
8. **`value clear` race condition** (read-back found a value-uuid, DELETE 404) →
   idempotent success.
9. **Auth (401), forbidden (403), rate limit (429), 5xx** → standard typed
   exit codes (3, 4, 6, 4 respectively).
10. **Network error** → `NetworkError`, exit 4, `retryable: true`.
11. **Non-TTY without `--yes` on `value clear`** → `ConfirmationError` exit 2.
    `value set` does NOT confirm (not destructive of user data — upsert).
12. **`--dry-run`** on `value set` → no wire call, envelope carries `would.method = "POST"` and the would-be body. On `value clear` → no wire call, no read-back, envelope carries `would.method = "DELETE"` plus a sentinel value-uuid `:lookup` to indicate the path can't be resolved without the read-back. Decision: dry-run on `value clear` does not perform the read-back either; we emit a placeholder value-uuid `<would-be-resolved-from-task>`. (Decision 3, below.)
13. **Batch via `--stdin`**: per-line errors emit one `freelo.error/v1` envelope with `line_index`; success envelopes interleave normally. Exit code aggregates via `ExitCodeAccumulator`.

## 5. Non-goals

- Looking up the field's type via `GET /custom-field/get-types` to dispatch
  scalar vs enum automatically. The user explicitly picks via `--value` or
  `--enum`; the server returns clear errors on mismatches.
- Renaming or relocating fields — that's R41.
- Listing existing values (a "show me what's set on task X" surface) — out of
  scope; `freelo tasks show <id>` already exposes `custom_fields[]` from the
  R08 envelope.
- Bulk clear of all values on a task — out of scope.
- Looking up enum-option uuids by name — that's R43.

## 6. Open questions

None. The spec is complete.

## 7. Decisions made autonomously

1. **`value clear` performs a read-back.** The DELETE endpoint takes a
   value-uuid, the CLI takes (task, field). Only documented way to resolve.
   Trade-off: 1 extra GET per call. Recorded in command help text.
2. **No client-side type detection.** We do not call `get-types` to dispatch
   `--value` vs `--enum` — the user picks explicitly, the server validates.
3. **Dry-run on `value clear` skips the read-back too.** A pure dry-run
   should not issue wire calls; the placeholder value-uuid `<would-be-resolved>`
   is emitted. Test coverage: dry-run human + json paths.
4. **`previous_value_uuid` always null in v1 for `value set`.** Avoids extra
   pre-GET. Reserved name for future extension; documented in changeset.
5. **NDJSON-only batch shape.** Each job carries multiple fields, so positional
   `--ids` doesn't fit. NDJSON via `--stdin` only (matches `tasks edit` /
   `tasks share` precedent).
6. **Idempotency arms for `value clear`:** (a) read-back finds no value →
   skip DELETE. (b) read-back finds a value-uuid but DELETE returns 404 →
   skip. Both report `already_in_target_state: true`.
7. **`AddOrEditEnumValue` body uses camelCase per OpenAPI** — explicit; no
   transform. The wrapper response key is also `customFieldEnum` (camelCase).
8. **Value response wrapper unwraps to `result.body.custom_field_value`** /
   `customFieldEnum`. We do not flatten; the wrapper preserves forward
   compatibility.

## Plan

### Files to create

- `src/commands/custom-fields/value/set.ts` — registers `custom-fields value set`.
- `src/commands/custom-fields/value/clear.ts` — registers `custom-fields value clear`.
- `src/commands/custom-fields/value.ts` — registers the `value` parent.
- `src/ui/human/custom-fields-value-set.ts` — three lines (live / dry-run / no-op).
- `src/ui/human/custom-fields-value-clear.ts` — three lines (live / already / dry-run).
- `test/commands/custom-fields/value-set.test.ts` — integration + edge cases.
- `test/commands/custom-fields/value-clear.test.ts` — idempotency arms + read-back.
- `docs/commands/custom-fields-value-set.md` — user docs.
- `docs/commands/custom-fields-value-clear.md` — user docs.
- `.changeset/r42-custom-fields-values.md` — minor bump.

### Files to modify

- `src/api/custom-fields.ts` — add `addOrEditCustomFieldValue`,
  `addOrEditCustomFieldEnumValue`, `deleteCustomFieldValue` wrappers + their
  `*Path()` exports.
- `src/api/schemas/custom-field.ts` — add `CustomFieldValueSchema`,
  `AddOrEditCustomFieldValueResponseSchema`, `AddOrEditCustomFieldEnumValueResponseSchema`,
  `CustomFieldWithValueSchema`, plus `CustomFieldsValueSetData` / `…ClearData`
  envelope-data types.
- `src/commands/custom-fields.ts` — register the new `value` parent.
- `test/msw/handlers.ts` — add `customFieldsValueHandlers` block (set scalar OK,
  set scalar 400/409/404/401/403/429/5xx/network; set enum OK, enum 404; delete OK,
  404, forbidden, server-error; per-uuid router; getTaskOk for read-back fixtures).
- `test/api/custom-fields.test.ts` — sibling tests for the three new wrappers
  (paths + happy + 404 + 401 + 403 + 5xx + signal abort + custom requestId).
- `README.md` — autogen Commands block (regenerated by `pnpm fix:readme`).

### No new dependencies

Reuses `zod`, `commander`, existing batch helpers, `confirmDestructive`.

### Test strategy

- Integration tests for both commands per `test/commands/labels/delete.test.ts`
  pattern (which is at 100% branch coverage). Both `--output json` and
  `--output human` happy + error paths. NDJSON batch with mid-stream error in
  both modes.
- For `value set`: scalar and enum dispatch on flag, validation mutex, dry-run,
  401/403/404/409/429/5xx/network, batch via stdin.
- For `value clear`: read-back finds no value → idempotent skip; finds a value
  → DELETE; DELETE 404 → idempotent; non-TTY without `--yes` → exit 2; TTY
  prompt copy contains "value"; dry-run; batch via stdin.
- Sibling `test/api/custom-fields.test.ts` exercises the three new wrappers
  directly (Calibration §4: any new wrapper gets a sibling test).
- Coverage target: branches >= 85% on new files. Mirror labels-delete patterns
  for human-mode tests + writeBatchError tests to ensure coverage hits the
  human branches.

### Rollout order

Single PR, single Conventional Commit (`feat(commands): custom-fields value set / clear (R42)`).
