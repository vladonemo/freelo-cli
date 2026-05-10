# Spec 0055 — `freelo custom-fields create` / `rename` / `delete` / `restore` (R41, Wave 7)

**Status:** Draft
**Owner:** orchestrator (run `2026-05-10-r41-custom-fields-crud`)
**Roadmap:** R41 (Wave 7, second slice)
**Date:** 2026-05-10
**Depends on:** R40 (custom-fields types/list — spec 0054), R13 (tasks delete — spec 0024).

## 1. Problem

R40 (`custom-fields types` / `custom-fields list`) gave agents read-only access to
the custom-field type catalog and to the per-project custom-field definitions
configured on a project. Today, agents and shell scripts cannot:

1. **Create** a custom-field definition on a project — needed to provision
   structured columns ("Severity", "Story Points", "Client ID") from CI / scripts.
2. **Rename** a custom-field definition — only `name` mutates; uuid and type
   are immutable per the OpenAPI.
3. **Soft-delete** a custom-field — retire an obsolete column; existing values
   are preserved server-side and hidden until restore.
4. **Restore** a soft-deleted custom-field — undo a prior delete.

R41 closes those four gaps with four small commands hung off the existing
`custom-fields` parent (R40). This is the **second slice of Wave 7**; R42
(`value set` / `value clear`) and R43 (enum CRUD) follow.

## 2. Proposal

### 2.1 CLI surface (additive — four new leaves under `custom-fields`)

```
freelo custom-fields create --project <id> --name <str> --type <type-uuid> [--uuid <uuid>] [--dry-run] [--output <mode>]
freelo custom-fields rename <uuid> --name <str> [--dry-run]
freelo custom-fields delete <uuid>... [--ids <list>] [--stdin] [--yes] [--dry-run]
freelo custom-fields restore <uuid>... [--ids <list>] [--stdin] [--dry-run]
```

- `create` is non-destructive (no `--yes`). Single shot — no batch (no
  `<uuid>...` positional, no `--ids`, no `--stdin`); creating one custom
  field at a time matches the create-from-template precedent (R39 spec 0053).
- `rename` is non-destructive. Single shot — `<uuid>` positional only (no
  batch). Renames are typically one-at-a-time / interactive; matches
  `labels rename` precedent (R23 spec 0035).
- `delete` is **destructive** — `confirmDestructive` gate, `--yes` /
  TTY-prompt / non-TTY-fail-closed. Batch via positional / `--ids` / `--stdin`.
  Idempotent: re-delete on already-deleted returns
  `already_in_target_state: true`.
- `restore` is non-destructive (it brings data back, doesn't destroy).
  Batch via positional / `--ids` / `--stdin` — common to undo a bulk delete.
  Idempotent: restore-of-already-active returns `already_in_target_state: true`
  via the same `404`-as-skip heuristic the `delete` path uses (decision 3).
  No `--yes` (non-destructive).

All four commands inherit the global flags (`--output`, `--profile`,
`--request-id`, `-v`/`-vv`). `delete` additionally honors the global `-y`/`--yes`.

### 2.2 Wire mappings

#### `POST /custom-field/create/{project_id}` (yaml :4043-4095)

Request body (`application/json`):

```jsonc
{
  "name": "Severity",                                            // required
  "type": "2f7bfe3a-c950-470e-b910-95b4caf5dc4f",               // required (text-uuid)
  "uuid": "11111111-2222-3333-4444-555555555555"                // optional — server-generates if omitted
}
```

Response (200):

```jsonc
{ "custom_field": { "uuid": "...", "name": "Severity", "custom_fields_types_uuid": "2f7bfe3a-...", ... } }
```

#### `POST /custom-field/rename/{uuid}` (yaml :4097-4136)

**OpenAPI verb is POST, not PATCH.** Roadmap entry says `PATCH`; OpenAPI
is authoritative (decision 1 — same call as R23 spec 0035 decision 01).

Request body:

```jsonc
{ "name": "New name" }   // required; uuid + type immutable via this endpoint
```

Response: `{ "custom_field": { ... } }` (200).

#### `DELETE /custom-field/delete/{uuid}` (yaml :4138-4166)

No body. Response shape: `SuccessResponse` (`{ result: 'success' }`).

Idempotency: 404 → `already_in_target_state: true` (decision 3 below).

#### `POST /custom-field/restore/{uuid}` (yaml :4168-4196)

No body. Response: `{ "custom_field": { ... } }` (200).

Idempotency: 404 → `already_in_target_state: true` (decision 3). The OpenAPI
documents that restore returns 404 "if the custom field doesn't exist or was
never soft-deleted" — both states map to "already active" for our purposes
(the field is either gone or is already not-deleted; in either case, the user
ran `restore` and got the active end-state they asked for, modulo the field
not existing at all — which is indistinguishable on the wire from already
restored).

### 2.3 Output schemas

#### `freelo.custom-fields.create/v1` (new)

| Field | Type | Always present | Notes |
| --- | --- | --- | --- |
| `project_id` | int | yes | Echo of `--project <id>`. |
| `custom_field` | `CustomField` | yes (live) | Server-returned full definition. Absent in `dry_run`. |
| `would` | `Would` | yes (dry_run) | Method/path/body that would be sent. Absent live. |

#### `freelo.custom-fields.rename/v1` (new)

| Field | Type | Always present | Notes |
| --- | --- | --- | --- |
| `uuid` | string | yes | Echo of positional `<uuid>`. |
| `applied_changes` | `{ name?: string }` | yes | Mirrors `labels rename` shape — for symmetry with future fields. |
| `would` | `Would` | yes (dry_run) | Absent live. |

#### `freelo.custom-fields.delete/v1` (new)

| Field | Type | Always present | Notes |
| --- | --- | --- | --- |
| `uuid` | string | yes | Identifier of the field. |
| `previous_state` | `null` | yes | Reserved for future GET-pre-check; always null v1 (mirrors R13/R23). |
| `current_state` | `'deleted'` | yes | Constant. |
| `already_in_target_state` | boolean | yes | True iff 404 idempotent skip. |
| `would` | `Would` | yes (dry_run) | Absent live. |
| `line_index` | int | when stdin | Per-line correlation in NDJSON batch mode. |

#### `freelo.custom-fields.restore/v1` (new)

| Field | Type | Always present | Notes |
| --- | --- | --- | --- |
| `uuid` | string | yes | Identifier of the field. |
| `previous_state` | `null` | yes | Reserved. |
| `current_state` | `'active'` | yes | Constant. |
| `already_in_target_state` | boolean | yes | True iff 404 idempotent skip. |
| `custom_field` | `CustomField` \| undefined | when live & not skipped | Server-returned full definition. Absent in dry_run AND in 404-skip path. |
| `would` | `Would` | yes (dry_run) | Absent live. |
| `line_index` | int | when stdin | Per-line correlation. |

### 2.4 Validation rules

#### `custom-fields create`

- `--project <id>` required, positive integer (parser callback `parsePositiveIntFlag`).
- `--name <str>` required, non-empty after trim.
- `--type <uuid>` required, must match RFC 4122 v4-ish UUID regex (decision 4).
  The CLI does NOT pre-validate that the UUID is one of the three documented
  type uuids — that's a server-side concern and Freelo may add new types.
- `--uuid <uuid>` optional, must match the same UUID regex if provided.
- All validation errors throw `ValidationError` (exit 2) with hints — not
  Commander's `InvalidArgumentError` (Calibration §1-2).

#### `custom-fields rename`

- `<uuid>` positional, required, must match UUID regex.
- `--name <str>` required, non-empty after trim.

#### `custom-fields delete`

- Mutex inputs: positional `<uuid>...` / `--ids <list>` / `--stdin` (R13 pattern).
- Each uuid (positional, in `--ids`, or in NDJSON `{"uuid": "..."}`) must match
  the UUID regex; otherwise `ValidationError` exit 2.
- NDJSON line schema: `{ "uuid": string }`, `.strict()`.

#### `custom-fields restore`

- Same mutex / batch / NDJSON rules as `delete`. No `--yes` flag (non-destructive).

### 2.5 Hint mapping (4xx)

#### `create`

- 400 mentioning `name` → "Server rejected --name; check it's non-empty and unique on the project."
- 400 mentioning `type` → "Server rejected --type; pass one of the type uuids from `freelo custom-fields types`."
- 400 mentioning `uuid` → "Server rejected --uuid; must be a v4 UUID, unused on this project."
- 400 generic → "Server-side validation rejected the request."
- 402 / `PlanExceeded` → "Plan limit reached — check Freelo subscription tier."
- 403 → "Account is not a project commander on the target project — required to create custom fields."
- 404 → "Project not found. Run `freelo projects list` for ids. Or: --type uuid not in the catalog (`custom-fields types`)."

#### `rename`

- 400 generic → "Server-side validation rejected the request."
- 403 → "Account is not a project commander of the field's project."
- 404 → "Custom field not found. Run `freelo custom-fields list --project <id>` for uuids."

#### `delete`

- 403 → "Account is not a project commander of the field's project."
- 404 → idempotent skip (already-in-target-state).
- 5xx / 429 / network → standard error envelopes.

#### `restore`

- Same shape as `delete`.

The `rewriteApiHint` idiom is inline per file (mirrors R39 spec 0053 §2.7,
R40 spec 0054).

### 2.6 Help text

Each leaf has a one-paragraph description matching the destructive vs.
non-destructive policy. The `delete` leaf description includes
"Destructive — requires --yes (non-TTY) or interactive confirmation (TTY).
404 treated as idempotent (already-deleted)."

### 2.7 Examples

```bash
# Create a Severity field on project 100 (text type)
$ freelo custom-fields create --project 100 \
    --name "Severity" --type "2f7bfe3a-c950-470e-b910-95b4caf5dc4f"
{"schema":"freelo.custom-fields.create/v1","data":{"project_id":100,"custom_field":{"uuid":"...","name":"Severity",...}}}

# Provision with a deterministic uuid (idempotent provisioning script)
$ freelo custom-fields create --project 100 --name "Story Points" \
    --type "b1e56fa9-a97a-429b-8ab4-82bebe58933a" \
    --uuid "11111111-2222-3333-4444-555555555555"

# Rename
$ freelo custom-fields rename "11111111-2222-3333-4444-555555555555" --name "Points"

# Delete (destructive)
$ freelo custom-fields delete "11111111-..." --yes
$ freelo custom-fields delete --ids "uuid-a,uuid-b,uuid-c" --yes
$ cat ids.ndjson | freelo custom-fields delete --stdin --yes

# Restore (non-destructive)
$ freelo custom-fields restore "11111111-..."
$ freelo custom-fields restore --ids "uuid-a,uuid-b" --output ndjson
```

## 3. Data model

### 3.1 Modify: `src/api/schemas/custom-field.ts`

Add the four envelope `data` types AND the wire-response schemas for `create`
and `rename` / `restore`. The existing `CustomFieldSchema` is reused
verbatim.

```ts
// Wire response — POST /custom-field/create/{project_id}
export const CreateCustomFieldResponseSchema = z
  .object({ custom_field: CustomFieldSchema })
  .passthrough();
export type CreateCustomFieldResponse = z.infer<typeof CreateCustomFieldResponseSchema>;

// Wire response — POST /custom-field/rename/{uuid}
export const RenameCustomFieldResponseSchema = z
  .object({ custom_field: CustomFieldSchema })
  .passthrough();
export type RenameCustomFieldResponse = z.infer<typeof RenameCustomFieldResponseSchema>;

// Wire response — DELETE /custom-field/delete/{uuid} (SuccessResponse-shaped)
export const DeleteCustomFieldResponseSchema = z
  .object({ result: z.string().nullable().optional() })
  .passthrough();
export type DeleteCustomFieldResponse = z.infer<typeof DeleteCustomFieldResponseSchema>;

// Wire response — POST /custom-field/restore/{uuid}
export const RestoreCustomFieldResponseSchema = z
  .object({ custom_field: CustomFieldSchema })
  .passthrough();
export type RestoreCustomFieldResponse = z.infer<typeof RestoreCustomFieldResponseSchema>;

// Envelope `data` types
import { type Would } from '../../lib/dry-run.js';

export type CustomFieldsCreateData = {
  project_id: number;
  custom_field?: CustomField;
  would?: Would;
};

export type CustomFieldsRenameData = {
  uuid: string;
  applied_changes: { name?: string };
  would?: Would;
};

export type CustomFieldsDeleteData = {
  uuid: string;
  previous_state: null;
  current_state: 'deleted';
  already_in_target_state: boolean;
  would?: Would;
  line_index?: number;
};

export type CustomFieldsRestoreData = {
  uuid: string;
  previous_state: null;
  current_state: 'active';
  already_in_target_state: boolean;
  custom_field?: CustomField;
  would?: Would;
  line_index?: number;
};
```

### 3.2 Modify: `src/api/custom-fields.ts`

Add four wire-call functions + four path helpers, mirroring `project-labels.ts`:

```ts
export const createCustomFieldPath = (projectId: number) => `/custom-field/create/${projectId}`;
export const renameCustomFieldPath = (uuid: string)     => `/custom-field/rename/${uuid}`;
export const deleteCustomFieldPath = (uuid: string)     => `/custom-field/delete/${uuid}`;
export const restoreCustomFieldPath = (uuid: string)    => `/custom-field/restore/${uuid}`;

export type CreateCustomFieldBody = {
  name: string;
  type: string;        // type uuid
  uuid?: string;
};
export type CreateCustomFieldInput = { name: string; typeUuid: string; uuid?: string };

export function buildCreateCustomFieldBody(input: CreateCustomFieldInput): CreateCustomFieldBody {
  const body: CreateCustomFieldBody = { name: input.name, type: input.typeUuid };
  if (input.uuid !== undefined) body.uuid = input.uuid;
  return body;
}

export async function createCustomField(client, projectId, opts: { body, signal?, requestId? }) { /* POST */ }
export async function renameCustomField(client, uuid,    opts: { body: { name }, signal?, requestId? }) { /* POST */ }
export async function deleteCustomField(client, uuid,    opts: { signal?, requestId? }) { /* DELETE */ }
export async function restoreCustomField(client, uuid,   opts: { signal?, requestId? }) { /* POST */ }
```

Each uses the `signal` / `requestId` opt-spread pattern (Calibration §4: branch
coverage in the sibling `test/api/custom-fields.test.ts`).

### 3.3 New files: `src/commands/custom-fields/{create,rename,delete,restore}.ts`

- `create.ts` — mirrors `tasks/create-from-template.ts` (positional-less,
  required flags, dry-run, `rewriteApiHint`). Single shot.
- `rename.ts` — mirrors `labels/rename.ts` (positional id, optional flags,
  empty-edit rejection, dry-run, single shot). Here `<uuid>` positional, only
  `--name` flag, so empty-edit just means "no `--name`".
- `delete.ts` — mirrors `labels/delete.ts` byte-for-byte modulo:
  (a) `<uuid>` positional instead of integer `<id>`,
  (b) `--ids` parser splits and validates uuids,
  (c) NDJSON line schema `{ uuid: string }`,
  (d) `confirmMessage` says "Delete N custom field(s)?",
  (e) idempotency arm = 404 only (single-arm, mirrors `labels/delete`).
- `restore.ts` — mirrors `delete.ts` shape but:
  (a) verb POST,
  (b) target state `'active'`,
  (c) no `--yes` / no confirmation gate (non-destructive),
  (d) carries `custom_field` in success envelope.

### 3.4 Modify: `src/commands/custom-fields.ts`

Add four `register*` calls alongside `registerTypes` / `registerList`.

### 3.5 Modify: `src/ui/human/custom-fields-*.ts` — four new files

- `custom-fields-create.ts` — one-line "Created custom field <name> uuid=<short>".
- `custom-fields-rename.ts` — one-line "Renamed <short-uuid> → <new-name>".
- `custom-fields-delete.ts` — one-line "Deleted custom field <short-uuid>" or "Already deleted: <short-uuid>".
- `custom-fields-restore.ts` — one-line "Restored custom field <short-uuid>" or "Already active: <short-uuid>".

### 3.6 No changes to `src/bin/freelo.ts`

R40 already wires `registerCustomFields(program, getAppConfig, env)`.

### 3.7 Introspect-golden (`test/fixtures/introspect-golden.json`)

The golden test only registers `auth` + `config` + `help` — adding new
`custom-fields` leaves does NOT alter any locked subtree. Verified by
inspection of `test/ui/introspect.test.ts:28-44` (`buildLiveProgram` registers
only those three).

### 3.8 README autogen

`pnpm fix:readme` regenerates the Commands block. Must run before commit.

## 4. Edge cases

| Edge case | Handling |
|---|---|
| `create` missing `--project` / `--name` / `--type` | `ValidationError` exit 2 with per-flag hint. |
| `create` with malformed `--type uuid` | `ValidationError` exit 2 (UUID regex). |
| `create` with `--uuid <not-a-uuid>` | `ValidationError` exit 2. |
| `create` server returns 402 PlanExceeded | `FreeloApiError` exit 4 with plan-limit hint. |
| `rename` empty `--name` | `ValidationError` exit 2 (non-empty after trim). |
| `rename` 404 | `FreeloApiError` exit 4 with "field not found" hint (NOT idempotent — rename-of-deleted is a real failure). |
| `delete` no input source | `ValidationError` exit 2. |
| `delete` mixed input sources | `ValidationError` exit 2. |
| `delete` 404 | idempotent skip — `already_in_target_state: true`, exit 0. |
| `delete` non-TTY no `--yes` | `ConfirmationError` exit 2 BEFORE any wire call. |
| `delete` empty stdin | silent success exit 0. |
| `delete --dry-run` | no prompt, no wire call, envelope echoes `would`. |
| `restore` 404 | idempotent skip — `already_in_target_state: true`, exit 0 (matches `delete` heuristic; OpenAPI :4177 confirms 404 means "doesn't exist or was never soft-deleted"). |
| `restore` no `--yes` flag | non-destructive — flag is not registered on this command. |

## 5. Non-goals

- **No two-step confirmation for `restore`.** Restore is non-destructive —
  it surfaces hidden data, doesn't destroy anything new. `--yes` is unnecessary.
- **No batch `create`.** Single-shot creates match the create-from-template
  precedent (R39). Multi-create is rare and the per-call body shape is
  different per field; hold for a later slice if demand surfaces.
- **No batch `rename`.** Each rename has a distinct new name; batch wouldn't
  share much. Matches `labels rename` precedent (R23).
- **No GET pre-check.** `delete` and `restore` use the same one-RTT pattern as
  R13 / R23 — the response is the source of truth. Decision 5 below.
- **No interactive type-pick.** R40 surfaces the three uuids; users compose
  with shell `$()`-substitution.

## 6. Decisions

1. **Rename verb is POST, not PATCH.** OpenAPI says POST at `:4097-4136`. Same
   call as R23 spec 0035 decision 01. (See `docs/decisions/<run-id>-1-...md`.)
2. **`delete` is destructive, `restore` is not.** Restore brings hidden data
   back; it doesn't destroy. No `--yes`, no confirmation gate. The shape is
   otherwise identical to `delete` for symmetry.
3. **Single-arm 404 idempotency for `delete` and `restore`.** Matches
   `labels/delete` (spec 0035 decision 09). 404 → `already_in_target_state: true`,
   any other non-2xx → re-throw `FreeloApiError`. For `restore`, 404 means
   either "doesn't exist" or "was never soft-deleted" (OpenAPI :4177); both
   resolve to "user got the active end-state they asked for" (modulo
   non-existence, which the agent can detect via `custom-fields list`). The
   trade-off: `restore` of a totally non-existent uuid silently "succeeds" —
   acceptable because (a) OpenAPI conflates it with the already-active case
   and we cannot disambiguate on the wire, (b) the agent that called restore
   can verify with `custom-fields list` if it needs certainty.
4. **UUID regex validation, not type-uuid catalog validation.** The CLI accepts
   any v4 UUID for `--type` and `--uuid` flags. Server-side enforces "must be
   one of the three documented uuids". The catalog might grow; we don't want
   to gate on a stale list. Server returns 404 `Invalid type uuid` → mapped
   to a friendly hint pointing at `custom-fields types`. Regex pattern:
   `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`
   (relaxed from strict v4 to also accept v1/v3/v5 — Freelo's docs use v4
   but their underlying generator might shift; the server is authoritative).
5. **No GET pre-check on `delete` / `restore`.** Two-RTT for marginal
   "previous_state" info isn't worth it. R13 spec 0024 decision 4 set this
   precedent; reuse here.
6. **`rename` does NOT treat 404 as idempotent.** Rename-of-deleted IS a
   real failure (the user's intent — "rename" — cannot be satisfied on a
   deleted field). `FreeloApiError` exit 4. Matches `labels rename` precedent.
7. **`restore` envelope carries `custom_field` on the live success path,
   omits it on the 404-skip path.** The skip path has nothing to surface from
   the server, and we don't want to issue a follow-up GET (would defeat the
   purpose of the idempotent skip). On the live success path, the server
   returns the full `CustomField` and we forward it (useful for an agent
   that needs the type uuid / project_id to chain into `custom-fields value
   set`).

## 7. Plan

### 7.1 Files to modify / create

**Modify:**
- `src/api/schemas/custom-field.ts` — add four wire schemas + four envelope `data` types.
- `src/api/custom-fields.ts` — add four path helpers + four wire functions + `buildCreateCustomFieldBody`.
- `src/commands/custom-fields.ts` — register four new leaves.
- `test/msw/handlers.ts` — add `customFieldsCrudHandlers` covering all four endpoints (ok / 4xx / 5xx / 429 / network).
- `test/api/custom-fields.test.ts` — extend with branch-coverage tests for the four new wire wrappers (signal / requestId opt-spreads).
- `README.md` — regenerated by `pnpm fix:readme`.

**Create (source):**
- `src/commands/custom-fields/create.ts`
- `src/commands/custom-fields/rename.ts`
- `src/commands/custom-fields/delete.ts`
- `src/commands/custom-fields/restore.ts`
- `src/ui/human/custom-fields-create.ts`
- `src/ui/human/custom-fields-rename.ts`
- `src/ui/human/custom-fields-delete.ts`
- `src/ui/human/custom-fields-restore.ts`

**Create (tests):**
- `test/commands/custom-fields/create.test.ts`
- `test/commands/custom-fields/rename.test.ts`
- `test/commands/custom-fields/delete.test.ts`
- `test/commands/custom-fields/restore.test.ts`

**Create (docs):**
- `docs/commands/custom-fields-create.md`
- `docs/commands/custom-fields-rename.md`
- `docs/commands/custom-fields-delete.md`
- `docs/commands/custom-fields-restore.md`

**Create (changeset):**
- `.changeset/r41-custom-fields-crud.md` (`freelo-cli: minor`).

File count: **8 new src + 4 new test + 4 new doc + 5 modified + 1 changeset = 22 files**, within the 25 budget.

### 7.2 No new dependencies

All needed primitives already exist:
- `confirmDestructive` (`src/lib/confirm.ts`) — destructive gate.
- `iterateLines`, `parseNdjsonLine`, `ExitCodeAccumulator` (`src/lib/batch.ts`) — batch IO.
- `dryRunEnvelope`, `Would` (`src/lib/dry-run.ts`) — dry-run.
- `buildEnvelope` (`src/ui/envelope.ts`) — envelope construction.
- `attachMeta` (`src/lib/introspect.ts`) — introspect.
- `BaseError`, `ValidationError`, `FreeloApiError`, `ConfirmationError` (`src/errors/`).

### 7.3 Test strategy

For each leaf command (4 files, mirror `labels/{rename,delete}` test shape):
- Happy path human + JSON envelope.
- `--dry-run`: skips wire call, emits `would`. (Calibration §2: assert exit code 0.)
- Error paths with **exit code assertions** (Calibration §2):
  - 401 → exit 3, 403 → exit 4, 404 → exit 4 (rename/create) / exit 0 + idempotent (delete/restore), 5xx → exit 4, 429 → exit 6, network → exit 5.
- Validation: bad uuid, missing required flag, empty `--name` (rename).
- `delete`-specific: confirmation policy (non-TTY no-yes → exit 2),
  multi-positional, `--ids`, `--stdin` (with `Readable.from`), idempotency
  (404 → already_in_target_state).
- `restore`-specific: same batch shapes as `delete`, plus the `custom_field`
  presence in live success and absence in 404-skip.
- TTY-prompt copy test (`delete` only, mirrors R23): clear `process.env.CI`
  per Calibration §7.

For `test/api/custom-fields.test.ts`: add ≥4 new describe blocks (`create`,
`rename`, `delete`, `restore`) each asserting:
- Path + method.
- Body sent (where applicable).
- `signal` opt-spread: present-branch and absent-branch.
- `requestId` opt-spread: present-branch and absent-branch.

### 7.4 Rollout order

1. Wire layer — schemas + `src/api/custom-fields.ts` + `test/api/custom-fields.test.ts`.
2. Renderers — `src/ui/human/custom-fields-{create,rename,delete,restore}.ts`.
3. Commands — `src/commands/custom-fields/{create,rename,delete,restore}.ts` + parent registrar update.
4. MSW handlers — `customFieldsCrudHandlers` block.
5. Command tests.
6. `pnpm fix:readme` for README block.
7. Docs.
8. Changeset.

Each step independently keeps `pnpm typecheck && pnpm lint && pnpm test` green.

## 8. Open questions

None. The OpenAPI is unambiguous about all four endpoint shapes; the
roadmap-vs-OpenAPI verb discrepancy on `rename` is resolved by decision 1
(OpenAPI is authoritative — same precedent as R23 spec 0035 decision 01).
