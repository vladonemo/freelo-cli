# Spec 0057 — `freelo custom-fields enum list / add / rename / delete` (R43, Wave 7)

**Status:** Draft
**Owner:** orchestrator (run `2026-05-10-r43-custom-fields-enum`)
**Roadmap:** R43 (third slice of Wave 7; enum-option management)
**Date:** 2026-05-10
**Depends on:** R41 (`custom-fields create / rename / delete / restore` — established the
`custom-fields` parent and the destructive-flow plumbing).

## 1. Problem

R40 shipped read-only access to the custom-fields catalog and per-project field
list. R41 added field-level CRUD. R42 added value set/clear on tasks. The remaining
gap is **enum-option management on enum-typed custom fields**:

1. Agents cannot list the enum options defined on an enum field, so they cannot
   resolve a display string to the enum-option uuid required by `value set --enum`.
2. Agents cannot add a new enum option to an existing enum field.
3. Agents cannot rename (relabel) an enum option.
4. Agents cannot delete an enum option, either safely (refuses if in use) or
   forcefully (clears referencing task values).

R43 closes those four gaps with a new `enum` sub-parent and four leaves.

## 2. Proposal

### 2.1 CLI surface (additive — one new sub-parent + four new leaves)

```
freelo custom-fields enum list   --field <uuid> [--output ...]
freelo custom-fields enum add    --field <uuid> --value <str> [--dry-run]
freelo custom-fields enum rename <enum_uuid> --value <str> [--dry-run]
freelo custom-fields enum delete <enum_uuid>... [--ids <list>] [--stdin] [--force] [--yes] [--dry-run]
```

- `enum list` — read. No `--dry-run` (per R40 precedent: dry-run on a pure GET
  is a no-op surprise).
- `enum add` — single-shot, non-destructive. Standard `--dry-run`.
- `enum rename` — single-shot, non-destructive. Standard `--dry-run`.
- `enum delete` — destructive. `--force` switches the wire call from the safe
  endpoint (`/custom-field-enum/delete/{uuid}`) to the cascading endpoint
  (`/custom-field-enum/force-delete/{uuid}`). Both require `--yes` (non-TTY)
  or interactive confirmation (TTY). Confirmation copy differs by mode
  ("Delete" vs "Force-delete (referencing values will be CLEARED)"). Idempotent
  (single-arm 404 → `already_in_target_state: true`, exit 0). Supports batch
  via positional, `--ids`, and `--stdin` NDJSON.

Standard global flags (`--output`, `--profile`, `--request-id`, `-v`/`-vv`)
inherit from the root.

Pagination: not applicable to any leaf — `list` returns a flat array per
yaml :4356-4359, the others are single-resource.

### 2.2 Wire mappings

#### `GET /custom-field-enum/get-for-custom-field/{custom_field_uuid}` — list

OpenAPI yaml :4326-4359.

Response (yaml :4353-4359):

```jsonc
{
  "custom_field_enum": [
    { "uuid": "<enum-option-uuid>", "value": "<display-string>" },
    ...
  ]
}
```

Empty `custom_field_enum: []` is a valid 200 (field is enum-typed but has no
options yet, or all options were soft-deleted).

#### `POST /custom-field-enum/create/{custom_field_uuid}` — add

OpenAPI yaml :4361-4414.

Request body (yaml :4391-4398):

```jsonc
{
  "value": "<display-string>",
  "uuid": "<optional-client-supplied-uuid>"  // omitted by CLI in this slice
}
```

`uuid` is optional and respected by the server when supplied (yaml :4374). The
CLI does not expose it on the surface in this slice — server generates the uuid.
Reserved for a future minor bump (`enum add --uuid <uuid>`) if a use case
emerges.

Response (yaml :4400-4414):

```jsonc
{
  "custom_field_enum": {
    "uuid": "<enum-option-uuid>",
    "value": "<display-string>"
  }
}
```

ACL: project commander (yaml :4376). 403 otherwise.

Calling on a non-enum field is rejected with HTTP 400 server-side (yaml :4375).

#### `POST /custom-field-enum/change/{custom_field_enum_uuid}` — rename

OpenAPI yaml :4416-4464.

**Verb is POST, not PATCH** (roadmap says PATCH — same situation as R41 spec
0055 decision 01; OpenAPI is canonical).

Request body (yaml :4444-4448):

```jsonc
{
  "value": "<new-display-string>"
}
```

Response (yaml :4450-4464):

```jsonc
{
  "custom_field_enum": {
    "uuid": "<unchanged-enum-option-uuid>",
    "value": "<new-display-string>"
  }
}
```

The uuid is preserved (yaml :4422), so existing task values that reference this
option continue to work after a rename. **No idempotency** — rename of a
deleted enum option is a real failure (404 → bubble).

#### `DELETE /custom-field-enum/delete/{custom_field_enum_uuid}` — safe delete

OpenAPI yaml :4466-4495.

Response (yaml :4490-4495): `{ result: "success" }` (the standard
`SuccessResponse` wrapper — `src/api/schemas/custom-field.ts` already has
`DeleteCustomFieldResponseSchema` which we reuse).

If the option is referenced by any existing task value, the server refuses
with HTTP 4xx (`UserVisibleErrorMessageException` — likely 400 — yaml :4479).
The CLI bubbles this as `FreeloApiError` with a hint to retry with `--force`.

404 → idempotent skip (already-deleted). Single-arm — same as R41 `delete` /
R42 `value clear` decision 3.

#### `DELETE /custom-field-enum/force-delete/{custom_field_enum_uuid}` — cascading delete

OpenAPI yaml :4497-4527.

Response (yaml :4521-4527): identical to safe delete.

**Destructive**: any task value referencing this option is cleared (yaml :4510).
The `custom_field_value_history` row is preserved server-side, but the current
value becomes null. There is no undo.

CLI surface: `enum delete --force <enum_uuid>`. Confirmation copy explicitly
warns about referencing values. Same single-arm 404 idempotency.

### 2.3 Output envelopes

`freelo.custom-fields.enum-list/v1`:

```jsonc
{
  "schema": "freelo.custom-fields.enum-list/v1",
  "data": {
    "field_uuid": "<uuid>",          // echo of --field for self-correlation
    "options": [
      { "uuid": "<enum-option-uuid>", "value": "<display>" },
      ...
    ]
  },
  "rate_limit": { "remaining": 99, "reset_at": "..." },
  "request_id": "..."
}
```

Empty `options: []` is valid.

`freelo.custom-fields.enum-add/v1`:

```jsonc
{
  "schema": "freelo.custom-fields.enum-add/v1",
  "data": {
    "field_uuid": "<uuid>",          // echo of --field
    "option": {                       // server-returned (live success)
      "uuid": "<server-generated-uuid>",
      "value": "<applied-display>"
    },
    "would": { "method": "POST", "path": "<path>", "body": <obj> }  // dry-run only; option absent in dry-run
  }
}
```

`freelo.custom-fields.enum-rename/v1`:

```jsonc
{
  "schema": "freelo.custom-fields.enum-rename/v1",
  "data": {
    "uuid": "<enum-option-uuid>",       // echo of positional <enum_uuid>
    "applied_changes": { "value": "<new-display>" },
    "would": { "method": "POST", "path": "<path>", "body": <obj> }   // dry-run only
  }
}
```

`freelo.custom-fields.enum-delete/v1`:

```jsonc
{
  "schema": "freelo.custom-fields.enum-delete/v1",
  "data": {
    "uuid": "<enum-option-uuid>",
    "force": false,                       // true iff --force was passed
    "previous_state": null,               // reserved (always null v1 — same as R41 delete)
    "current_state": "deleted",
    "already_in_target_state": false,    // true iff 404 idempotent skip
    "would": { "method": "DELETE", "path": "<path>", "body": {} },
    "line_index": 0                       // present in --stdin batch mode
  }
}
```

Notes:
- `force` is a public field on the envelope so consumers know which endpoint
  was hit. Same value present on dry-run and idempotent paths.
- Schema is mostly a clone of `freelo.custom-fields.delete/v1`, plus the `force`
  bool. Future fields (e.g. `cleared_value_count` if Freelo ever returns it)
  are minor bumps per the envelope-stability contract.

### 2.4 Error mapping

Inherits from `FreeloApiError` and the global error handler (typed exit codes).
Per-leaf hint rewrites:

- `enum list`:
  - 400  → "Server-side validation rejected the request; verify --field is a uuid."
  - 403  → "Account cannot read enum options on this custom field."
  - 404  → "Custom field not found. Run `freelo custom-fields list --project <id>` for uuids."
- `enum add`:
  - 400 mentioning `value`  → "--value must be a non-empty string."
  - 400 generic             → server-side validation hint (covers "non-enum field" rejection per yaml :4375).
  - 403                      → "Account is not a project commander on the field's project."
  - 404                      → "Custom field not found."
- `enum rename`:
  - 400  → server-side validation hint.
  - 403  → permission hint.
  - 404  → "Enum option not found. Run `freelo custom-fields enum list --field <uuid>` for uuids."
            **Not idempotent** — rename-of-deleted is a failure.
- `enum delete`:
  - 400 (in-use, safe path) → "Enum option is in use by tasks; retry with --force to cascade-clear referencing values."
  - 403                      → "Account is not a project commander on the field's project."
  - 404                      → idempotent skip (single-arm).

### 2.5 Confirmation copy

- Safe delete (single):  `"Delete 1 enum option?"`
- Safe delete (N):       `"Delete N enum options?"`
- Force delete (single): `"Force-delete 1 enum option? Referencing task values will be CLEARED."`
- Force delete (N):      `"Force-delete N enum options? Referencing task values will be CLEARED."`

The "GLOBALLY" pattern from `labels delete` doesn't apply (these aren't workspace-global).

### 2.6 Batch input

`enum delete` supports the standard three-source batch input
(positional / `--ids` / `--stdin`) — same shape as R41 `custom-fields delete`.
The other three leaves are single-shot:

- `enum list` — single field per call.
- `enum add` — single value per call (positional list of values would be
  ambiguous against `--field` — kept simple).
- `enum rename` — single uuid + value per call.

NDJSON line schema for `enum delete --stdin`:

```jsonc
{ "uuid": "<enum-option-uuid>" }
```

The `--force` flag applies uniformly to all items in the batch — no per-line
override. Mixed mode would invite a footgun where one row force-deletes and
another doesn't.

## 3. Data model

### 3.1 Zod schemas (new in `src/api/schemas/custom-field.ts`)

```ts
/**
 * One enum option row (yaml components #/CustomFieldEnumOption).
 * Both fields are required-on-the-wire; .passthrough() keeps unknown future
 * fields.
 */
export const CustomFieldEnumOptionSchema = z
  .object({
    uuid: z.string(),
    value: z.string(),
  })
  .passthrough();

/** GET /custom-field-enum/get-for-custom-field/{uuid} response. */
export const GetCustomFieldEnumResponseSchema = z
  .object({
    custom_field_enum: z.array(CustomFieldEnumOptionSchema),
  })
  .passthrough();

/** POST /custom-field-enum/create/{uuid} response. */
export const CreateCustomFieldEnumResponseSchema = z
  .object({ custom_field_enum: CustomFieldEnumOptionSchema })
  .passthrough();

/** POST /custom-field-enum/change/{uuid} response. */
export const ChangeCustomFieldEnumResponseSchema = z
  .object({ custom_field_enum: CustomFieldEnumOptionSchema })
  .passthrough();

/**
 * DELETE /custom-field-enum/{,force-}delete/{uuid} response. Reuses the existing
 * `DeleteCustomFieldResponseSchema` shape (`{ result: 'success' }`) — the body
 * is identical for both safe and force endpoints (yaml :4490-4495 / :4521-4527,
 * both `$ref: '#/components/schemas/SuccessResponse'`).
 *
 * To keep the diff small we add a dedicated alias rather than re-exporting the
 * existing schema: `DeleteCustomFieldEnumResponseSchema = z.object({ result:
 * z.string().nullable().optional() }).passthrough();`
 */
```

### 3.2 Envelope `data` types (new)

```ts
export type CustomFieldsEnumListData = {
  field_uuid: string;
  options: Array<{ uuid: string; value: string }>;
};

export type CustomFieldsEnumAddData = {
  field_uuid: string;
  option?: { uuid: string; value: string };  // present on live success; absent on dry-run
  would?: Would;
};

export type CustomFieldsEnumRenameData = {
  uuid: string;
  applied_changes: { value?: string };
  would?: Would;
};

export type CustomFieldsEnumDeleteData = {
  uuid: string;
  force: boolean;
  previous_state: null;
  current_state: 'deleted';
  already_in_target_state: boolean;
  would?: Would;
  line_index?: number;
};
```

## 4. Edge cases

1. **`enum add --value ""`** → `ValidationError` exit 2 (CLI rejects empty
   after trim).
2. **`enum rename` on a non-existent uuid** → 404 → bubbles (NOT idempotent).
3. **`enum delete` safe path on an in-use option** → server 400 → bubbles with
   hint to retry with `--force`.
4. **`enum delete` either path on a non-existent uuid** → 404 → idempotent
   skip; envelope `already_in_target_state: true`, exit 0.
5. **`enum delete --force` race** (option vanishes between the safe attempt and
   force) → not applicable in this slice; we don't auto-fall-back. `--force`
   is a deliberate user choice.
6. **Empty `--stdin`** for `enum delete` → silent success, exit 0
   (mirrors `custom-fields delete`).
7. **NDJSON line with malformed uuid** → per-line `freelo.error/v1` envelope
   with `line_index`; aggregated exit code via `ExitCodeAccumulator`.
8. **Bad uuid in positional / --ids** → exit 2 `VALIDATION_ERROR` before any
   wire call.
9. **Auth (401), forbidden (403), rate limit (429), 5xx, network** → standard
   typed exit codes (3, 4, 6, 4, 4 respectively).
10. **Non-TTY without `--yes` on `enum delete` (with or without `--force`)** →
    `ConfirmationError` exit 2 BEFORE any wire call.
11. **`enum delete --dry-run`** → no wire call, no confirmation prompt; envelope
    carries `would.method = "DELETE"` plus the path that *would* have been
    hit (force vs safe based on the flag). `force: <flag-value>` is emitted.

## 5. Non-goals

- Reordering enum options — there's no documented endpoint.
- Restoring a deleted enum option — there's no documented endpoint
  (force-delete is irreversible per yaml :4511; safe delete is described as
  "Removes" without mention of soft-delete recovery).
- Bulk add (one CLI call adding multiple options at once) — the OpenAPI accepts
  one option per call. Composability is via shell loop or NDJSON-style script.
- Validating the field is enum-typed before calling add/list. The server returns
  a clean error on type mismatch; an extra GET would be wasted on every call.
- Exposing the optional `uuid` body field on `enum add` (caller-supplied uuid).
  Reserved for a future minor bump.

## 6. Open questions

None. The OpenAPI is unambiguous on every contract this slice touches.

## 7. Decisions made autonomously

1. **Verb for `enum rename` is POST.** The roadmap entry says PATCH; the
   OpenAPI says POST (yaml :4417). Same call as R41 spec 0055 decision 01.
2. **`--force` flag for cascading delete.** Not a separate `force-delete`
   sub-command — that would double the test matrix and the help-text surface.
   `--force` is the standard agent-safety pattern (R23 `labels delete --force`
   precedent for global-scope deletes). Confirmation copy diverges to make
   the cascade explicit.
3. **No `--force`-fallback on safe-delete refusal.** If the safe endpoint
   returns 4xx because the option is in use, the CLI bubbles the error with
   a hint to retry with `--force`. Auto-falling-back would mask data
   destruction behind a single command invocation.
4. **Single-arm 404 idempotency on `enum delete` (both endpoints).** Matches
   R41 / R42 / R23 — 404 → already-deleted, exit 0. Other non-2xx → bubble.
5. **No idempotency on `enum rename`.** Same as R41 `rename`: rename-of-deleted
   is a real failure.
6. **`enum delete` supports the full three-source batch input** — positional,
   `--ids`, `--stdin`. The other three leaves are single-shot (rationale in
   §2.6).
7. **`enum list` has no `--dry-run`.** Matches R40 `list` decision 5.
8. **`force` is a public envelope field.** Consumers should know which wire
   endpoint executed; it's load-bearing for audit trails.
9. **Reuse R41's `DeleteCustomFieldResponseSchema` shape** (literal alias —
   we declare `DeleteCustomFieldEnumResponseSchema` for symmetry with the
   wire wrappers and to keep the import graph readable). Body shape is the
   same `SuccessResponse`.
10. **`enum add` does not expose caller-supplied uuid.** Out-of-scope for this
    slice; reserved for a future minor bump.
11. **No client-side validation of enum-option uuid format.** Same precedent
    as R42 `value set --enum`: server returns a clean 404; the CLI surfaces
    a friendlier hint.

## Plan

### Files to create

- `src/commands/custom-fields/enum.ts` — registers the `enum` parent (mirrors
  `custom-fields/value.ts`).
- `src/commands/custom-fields/enum/list.ts` — `enum list --field <uuid>`.
- `src/commands/custom-fields/enum/add.ts` — `enum add --field <uuid> --value <str>`.
- `src/commands/custom-fields/enum/rename.ts` — `enum rename <uuid> --value <str>`.
- `src/commands/custom-fields/enum/delete.ts` — `enum delete <uuid>... [--force] [--yes]`.
- `src/ui/human/custom-fields-enum-list.ts` — empty/non-empty renderer.
- `src/ui/human/custom-fields-enum-add.ts` — live + dry-run.
- `src/ui/human/custom-fields-enum-rename.ts` — live + dry-run.
- `src/ui/human/custom-fields-enum-delete.ts` — live / force / already-deleted / dry-run.
- `test/commands/custom-fields/enum-list.test.ts` — read happy + 4 HTTP error paths.
- `test/commands/custom-fields/enum-add.test.ts` — live + dry-run + 400/403/404/429/5xx/net.
- `test/commands/custom-fields/enum-rename.test.ts` — live + dry-run + 400/403/404/429/5xx/net.
- `test/commands/custom-fields/enum-delete.test.ts` — full pattern from R41 `delete.test.ts`,
  plus the `--force` matrix.
- `docs/commands/custom-fields-enum-list.md`
- `docs/commands/custom-fields-enum-add.md`
- `docs/commands/custom-fields-enum-rename.md`
- `docs/commands/custom-fields-enum-delete.md`
- `.changeset/r43-custom-fields-enum.md` — minor bump.

### Files to modify

- `src/api/custom-fields.ts` — add four new wrappers + `*Path()` exports:
  - `getCustomFieldEnum(client, fieldUuid, opts)` →
    `GET /custom-field-enum/get-for-custom-field/{uuid}`.
  - `createCustomFieldEnum(client, fieldUuid, body, opts)` →
    `POST /custom-field-enum/create/{uuid}`.
  - `changeCustomFieldEnum(client, enumUuid, body, opts)` →
    `POST /custom-field-enum/change/{uuid}`.
  - `deleteCustomFieldEnum(client, enumUuid, force, opts)` — switches between
    `DELETE /custom-field-enum/delete/{uuid}` and `…/force-delete/{uuid}`
    based on the `force: boolean` arg. Single wrapper keeps the API surface
    tighter; the path helper `deleteCustomFieldEnumPath(uuid, force)` mirrors.
- `src/api/schemas/custom-field.ts` — add `CustomFieldEnumOptionSchema`,
  `GetCustomFieldEnumResponseSchema`, `CreateCustomFieldEnumResponseSchema`,
  `ChangeCustomFieldEnumResponseSchema`, `DeleteCustomFieldEnumResponseSchema`,
  plus the four envelope-data types.
- `src/commands/custom-fields.ts` — register the new `enum` parent (one line).
- `test/msw/handlers.ts` — add `customFieldsEnumHandlers` block with one
  factory per (endpoint × status) pair, mirroring `customFieldsCrudHandlers`.
- `test/api/custom-fields.test.ts` — sibling tests for the four new wrappers
  (path helpers + signal/requestId opt-spread coverage per Calibration §4).
- `README.md` autogen Commands block — regenerated via `pnpm fix:readme`.

### Test strategy

Per Calibration §1, §2, §4, §7:

- Every error path with a typed exit code has an exit-code assertion.
- Every command has both `--output json` and `--output human` paths covered.
- `enum delete` covers the multi-id mid-stream-failure case in BOTH json and
  human output modes (R42 lessons learned).
- Sibling api wrapper tests cover both the absent-opts and present-opts spread
  branches.
- No test asserts behavior on the TTY-prompt code path that doesn't also
  clear `process.env.CI` (Calibration §7) — but this slice does not need
  TTY-prompt tests; non-TTY paths (with `--yes`) are sufficient for confirmation
  policy coverage.

### Rollout order

One slice — no need to break further. The four leaves share the parent
registration; landing them together keeps the CLI surface coherent.

### No new deps

All imports come from existing modules.
