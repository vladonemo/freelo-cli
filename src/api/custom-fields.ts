import { type ApiResponse, type HttpClient } from './client.js';
import { z } from 'zod';
import {
  CreateCustomFieldResponseSchema,
  DeleteCustomFieldResponseSchema,
  FindCustomFieldsByProjectResponseSchema,
  GetCustomFieldTypesResponseSchema,
  RenameCustomFieldResponseSchema,
  RestoreCustomFieldResponseSchema,
  AddOrEditCustomFieldValueResponseSchema,
  AddOrEditCustomFieldEnumValueResponseSchema,
  GetCustomFieldEnumResponseSchema,
  CreateCustomFieldEnumResponseSchema,
  ChangeCustomFieldEnumResponseSchema,
  DeleteCustomFieldEnumResponseSchema,
  type CreateCustomFieldResponse,
  type DeleteCustomFieldResponse,
  type FindCustomFieldsByProjectResponse,
  type GetCustomFieldTypesResponse,
  type RenameCustomFieldResponse,
  type RestoreCustomFieldResponse,
  type AddOrEditCustomFieldValueResponse,
  type AddOrEditCustomFieldEnumValueResponse,
  type GetCustomFieldEnumResponse,
  type CreateCustomFieldEnumResponse,
  type ChangeCustomFieldEnumResponse,
  type DeleteCustomFieldEnumResponse,
} from './schemas/custom-field.js';

/**
 * Wire wrappers for the `custom-fields` resource group.
 *
 * R40 — read-only:
 *   - `GET /custom-field/get-types`                    (yaml :4012-4042)
 *   - `GET /custom-field/find-by-project/{project_id}` (yaml :4529-4561)
 *
 * R41 — CRUD (spec 0055):
 *   - `POST   /custom-field/create/{project_id}`       (yaml :4043-4095)
 *   - `POST   /custom-field/rename/{uuid}`             (yaml :4097-4136)
 *   - `DELETE /custom-field/delete/{uuid}`             (yaml :4138-4166)
 *   - `POST   /custom-field/restore/{uuid}`            (yaml :4168-4196)
 *
 * The rename verb is **POST** per OpenAPI — the roadmap entry's `PATCH`
 * is incorrect. Same call as R23 spec 0035 decision 01.
 *
 * Every wrapper threads `signal` + `requestId` opt-spreads (calibration §4:
 * branch-coverage in the sibling `test/api/custom-fields.test.ts`).
 */

export type CustomFieldsOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type GetCustomFieldTypesResult = {
  raw: ApiResponse<GetCustomFieldTypesResponse>;
  body: GetCustomFieldTypesResponse;
};

export type FindCustomFieldsByProjectResult = {
  raw: ApiResponse<FindCustomFieldsByProjectResponse>;
  body: FindCustomFieldsByProjectResponse;
};

/** Path for `GET /custom-field/get-types`. Constant. */
export function getCustomFieldTypesPath(): string {
  return '/custom-field/get-types';
}

/** Path for `GET /custom-field/find-by-project/{project_id}`. */
export function findCustomFieldsByProjectPath(projectId: number): string {
  return `/custom-field/find-by-project/${projectId}`;
}

/**
 * `GET /custom-field/get-types` — server-curated catalog of custom-field
 * type definitions (text / number / enum). The three documented type UUIDs
 * are referenced in `docs/api/freelo-api.yaml:4081-4085`; passthrough keeps
 * unknown future types instead of stripping them.
 */
export async function getCustomFieldTypes(
  client: HttpClient,
  opts: CustomFieldsOpts = {},
): Promise<GetCustomFieldTypesResult> {
  const raw = await client.request({
    method: 'GET',
    path: getCustomFieldTypesPath(),
    schema: GetCustomFieldTypesResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

/**
 * `GET /custom-field/find-by-project/{project_id}` — list all custom-field
 * definitions configured on a project. Soft-deleted fields are excluded
 * server-side (yaml :4542). `is_commander` boolean gates the R41+ mutation
 * endpoints on the same project.
 */
export async function findCustomFieldsByProject(
  client: HttpClient,
  projectId: number,
  opts: CustomFieldsOpts = {},
): Promise<FindCustomFieldsByProjectResult> {
  const raw = await client.request({
    method: 'GET',
    path: findCustomFieldsByProjectPath(projectId),
    schema: FindCustomFieldsByProjectResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

/* ---------------------------------------------------------------------------
 *  R41 — path helpers (exported so dry-run envelopes can echo the path
 *  without touching the network).
 * ------------------------------------------------------------------------- */

/** Path for `POST /custom-field/create/{project_id}`. */
export function createCustomFieldPath(projectId: number): string {
  return `/custom-field/create/${projectId}`;
}

/** Path for `POST /custom-field/rename/{uuid}`. */
export function renameCustomFieldPath(uuid: string): string {
  return `/custom-field/rename/${uuid}`;
}

/** Path for `DELETE /custom-field/delete/{uuid}`. */
export function deleteCustomFieldPath(uuid: string): string {
  return `/custom-field/delete/${uuid}`;
}

/** Path for `POST /custom-field/restore/{uuid}`. */
export function restoreCustomFieldPath(uuid: string): string {
  return `/custom-field/restore/${uuid}`;
}

/* ---------------------------------------------------------------------------
 *  R41 — `POST /custom-field/create/{project_id}`
 *
 *  Required body: `{ name, type }`. Optional body: `{ uuid }` (server
 *  generates if omitted; honored if supplied — useful for reproducible
 *  provisioning, yaml :4058).
 * ------------------------------------------------------------------------- */

/** Wire-shape of the POST body for `create`. */
export type CreateCustomFieldBody = {
  name: string;
  type: string;
  uuid?: string;
};

/** CLI-side input to `buildCreateCustomFieldBody`. Pure mapper, no I/O. */
export type CreateCustomFieldInput = {
  name: string;
  /** UUID of one of the type rows from `GET /custom-field/get-types`. */
  typeUuid: string;
  /** Optional client-supplied uuid for the new field (idempotent provisioning). */
  uuid?: string;
};

export type CreateCustomFieldOpts = CustomFieldsOpts & {
  body: CreateCustomFieldBody;
};

export type CreateCustomFieldResult = {
  raw: ApiResponse<CreateCustomFieldResponse>;
  body: CreateCustomFieldResponse;
};

/** Map CLI input → wire body. Pure. Omits `uuid` when caller didn't supply it. */
export function buildCreateCustomFieldBody(input: CreateCustomFieldInput): CreateCustomFieldBody {
  const body: CreateCustomFieldBody = {
    name: input.name,
    type: input.typeUuid,
  };
  if (input.uuid !== undefined) body.uuid = input.uuid;
  return body;
}

/**
 * `POST /custom-field/create/{project_id}` — create a custom-field definition
 * on a project.
 *
 * 200 → `{ custom_field: CustomField }`. ACL: caller must be a project
 * commander (yaml :4056); else 403. Plan limits → 402 / 429
 * `PlanExceededException` (yaml :4059).
 */
export async function createCustomField(
  client: HttpClient,
  projectId: number,
  opts: CreateCustomFieldOpts,
): Promise<CreateCustomFieldResult> {
  const raw = await client.request({
    method: 'POST',
    path: createCustomFieldPath(projectId),
    body: opts.body,
    schema: CreateCustomFieldResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

/* ---------------------------------------------------------------------------
 *  R41 — `POST /custom-field/rename/{uuid}`
 *
 *  Verb is POST per OpenAPI (yaml :4097-4098). Roadmap says PATCH; OpenAPI
 *  wins. Body: `{ name }` only (uuid + type are immutable via this endpoint
 *  per yaml :4106-4107).
 * ------------------------------------------------------------------------- */

export type RenameCustomFieldBody = {
  name: string;
};

export type RenameCustomFieldOpts = CustomFieldsOpts & {
  body: RenameCustomFieldBody;
};

export type RenameCustomFieldResult = {
  raw: ApiResponse<RenameCustomFieldResponse>;
  body: RenameCustomFieldResponse;
};

/**
 * `POST /custom-field/rename/{uuid}` — change the display name of an
 * existing custom-field definition. ACL: project commander; else 403.
 */
export async function renameCustomField(
  client: HttpClient,
  uuid: string,
  opts: RenameCustomFieldOpts,
): Promise<RenameCustomFieldResult> {
  const raw = await client.request({
    method: 'POST',
    path: renameCustomFieldPath(uuid),
    body: opts.body,
    schema: RenameCustomFieldResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

/* ---------------------------------------------------------------------------
 *  R41 — `DELETE /custom-field/delete/{uuid}`
 *
 *  Soft-delete. 200 → `{ result: 'success' }`. 404 → idempotent skip
 *  (already-deleted) at the leaf-command layer.
 * ------------------------------------------------------------------------- */

export type DeleteCustomFieldOpts = CustomFieldsOpts;

export type DeleteCustomFieldResult = {
  raw: ApiResponse<DeleteCustomFieldResponse>;
  body: DeleteCustomFieldResponse;
};

/**
 * `DELETE /custom-field/delete/{uuid}` — soft-delete a custom-field definition.
 * Empty body. The leaf command catches `FreeloApiError` and applies the
 * single-arm idempotency heuristic (404 → idempotent skip).
 */
export async function deleteCustomField(
  client: HttpClient,
  uuid: string,
  opts: DeleteCustomFieldOpts = {},
): Promise<DeleteCustomFieldResult> {
  const raw = await client.request({
    method: 'DELETE',
    path: deleteCustomFieldPath(uuid),
    schema: DeleteCustomFieldResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

/* ---------------------------------------------------------------------------
 *  R41 — `POST /custom-field/restore/{uuid}`
 *
 *  Reverses a prior delete. 200 → `{ custom_field: CustomField }`. 404 →
 *  idempotent skip — OpenAPI :4177 says 404 means "doesn't exist OR was
 *  never soft-deleted"; both map to "already in active state" for the CLI.
 * ------------------------------------------------------------------------- */

export type RestoreCustomFieldOpts = CustomFieldsOpts;

export type RestoreCustomFieldResult = {
  raw: ApiResponse<RestoreCustomFieldResponse>;
  body: RestoreCustomFieldResponse;
};

/**
 * `POST /custom-field/restore/{uuid}` — restore a soft-deleted custom-field
 * definition. Empty body. Returns the full `CustomField` on success.
 */
export async function restoreCustomField(
  client: HttpClient,
  uuid: string,
  opts: RestoreCustomFieldOpts = {},
): Promise<RestoreCustomFieldResult> {
  const raw = await client.request({
    method: 'POST',
    path: restoreCustomFieldPath(uuid),
    schema: RestoreCustomFieldResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}
/* ---------------------------------------------------------------------------
 *  R42 — value set / value clear (spec 0056).
 *
 *  Three new wire wrappers:
 *    POST /custom-field/add-or-edit-value          (yaml :4198-4244)  — scalar
 *    POST /custom-field/add-or-edit-enum-value     (yaml :4246-4294)  — enum
 *    DELETE /custom-field/delete-value/{uuid}      (yaml :4296-4324)
 * ------------------------------------------------------------------------- */

/** Path for `POST /custom-field/add-or-edit-value`. Constant. */
export function addOrEditCustomFieldValuePath(): string {
  return '/custom-field/add-or-edit-value';
}

/** Path for `POST /custom-field/add-or-edit-enum-value`. Constant. */
export function addOrEditCustomFieldEnumValuePath(): string {
  return '/custom-field/add-or-edit-enum-value';
}

/** Path for `DELETE /custom-field/delete-value/{uuid}`. */
export function deleteCustomFieldValuePath(valueUuid: string): string {
  return `/custom-field/delete-value/${valueUuid}`;
}

export type AddOrEditCustomFieldValueOpts = {
  taskId: number;
  customFieldUuid: string;
  value: string;
  signal?: AbortSignal;
  requestId?: string;
};

export type AddOrEditCustomFieldValueResult = {
  raw: ApiResponse<AddOrEditCustomFieldValueResponse>;
  body: AddOrEditCustomFieldValueResponse;
};

export type AddOrEditCustomFieldEnumValueResult = {
  raw: ApiResponse<AddOrEditCustomFieldEnumValueResponse>;
  body: AddOrEditCustomFieldEnumValueResponse;
};

/**
 * `POST /custom-field/add-or-edit-value` — scalar (text / number) upsert.
 *
 * Body shape per yaml :4222-4234 — snake_case `custom_field_uuid`. The
 * server matches by `(task_id, custom_field_uuid)`; the resulting record's
 * uuid is server-generated on create and preserved on update (yaml :4211).
 *
 * On success returns `{ custom_field_value: <CustomFieldValue> }`.
 *
 * Spec 0055 §2.2.
 */
export async function addOrEditCustomFieldValue(
  client: HttpClient,
  opts: AddOrEditCustomFieldValueOpts,
): Promise<AddOrEditCustomFieldValueResult> {
  const body = {
    custom_field_uuid: opts.customFieldUuid,
    task_id: opts.taskId,
    value: opts.value,
  };
  const raw = await client.request({
    method: 'POST',
    path: addOrEditCustomFieldValuePath(),
    body,
    schema: AddOrEditCustomFieldValueResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

/**
 * `POST /custom-field/add-or-edit-enum-value` — enum upsert.
 *
 * Body shape per yaml :4270-4283 — **camelCase** `customFieldUuid` (sic).
 * `value` is the **uuid of an enum option** fetched from
 * `/custom-field-enum/get-for-custom-field/{uuid}` (R43, future), NOT the
 * display string.
 *
 * On success returns `{ customFieldEnum: <CustomFieldValue> }` — note the
 * camelCase wrapper key too.
 *
 * Spec 0055 §2.2.
 */
export async function addOrEditCustomFieldEnumValue(
  client: HttpClient,
  opts: AddOrEditCustomFieldValueOpts,
): Promise<AddOrEditCustomFieldEnumValueResult> {
  const body = {
    customFieldUuid: opts.customFieldUuid,
    task_id: opts.taskId,
    value: opts.value,
  };
  const raw = await client.request({
    method: 'POST',
    path: addOrEditCustomFieldEnumValuePath(),
    body,
    schema: AddOrEditCustomFieldEnumValueResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

export type DeleteCustomFieldValueOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type DeleteCustomFieldValueResult = {
  raw: ApiResponse<unknown>;
};

/**
 * Tolerant success envelope for the DELETE response (`{ result: "success" }`
 * per yaml :4318-4324, `SuccessResponse`). `.passthrough()` keeps unknown
 * fields ride-through. Mirrors `tasks-delete.ts` byte-for-byte modulo the
 * comment.
 */
const DeleteValueResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * `DELETE /custom-field/delete-value/{uuid}` — clear.
 *
 * The `uuid` is the **value-uuid** (the uuid of the persisted record), NOT
 * the field-uuid. Callers that have a `(task_id, field_uuid)` resolve via
 * `GET /task/{task_id}` first (see `value clear` command).
 *
 * 404 is mapped to idempotent skip by the command layer; this wrapper does
 * not special-case it — `FreeloApiError` bubbles.
 *
 * Spec 0055 §2.2.
 */
export async function deleteCustomFieldValue(
  client: HttpClient,
  valueUuid: string,
  opts: DeleteCustomFieldValueOpts = {},
): Promise<DeleteCustomFieldValueResult> {
  const raw = await client.request({
    method: 'DELETE',
    path: deleteCustomFieldValuePath(valueUuid),
    schema: DeleteValueResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}

/* ---------------------------------------------------------------------------
 *  R43 — enum option list/add/rename/delete (spec 0057).
 *
 *  Five new endpoints:
 *    GET    /custom-field-enum/get-for-custom-field/{uuid}  (yaml :4326-4359)
 *    POST   /custom-field-enum/create/{uuid}                (yaml :4361-4414)
 *    POST   /custom-field-enum/change/{uuid}                (yaml :4416-4464)
 *    DELETE /custom-field-enum/delete/{uuid}                (yaml :4466-4495)
 *    DELETE /custom-field-enum/force-delete/{uuid}          (yaml :4497-4527)
 *
 *  Verb for `change` is POST per OpenAPI (not PATCH as the roadmap hinted).
 *  The two delete endpoints share the same response shape; they differ only
 *  in path + behaviour (safe vs cascading). One wrapper switches on `force`.
 * ------------------------------------------------------------------------- */

/** Path for `GET /custom-field-enum/get-for-custom-field/{custom_field_uuid}`. */
export function getCustomFieldEnumPath(fieldUuid: string): string {
  return `/custom-field-enum/get-for-custom-field/${fieldUuid}`;
}

/** Path for `POST /custom-field-enum/create/{custom_field_uuid}`. */
export function createCustomFieldEnumPath(fieldUuid: string): string {
  return `/custom-field-enum/create/${fieldUuid}`;
}

/** Path for `POST /custom-field-enum/change/{custom_field_enum_uuid}`. */
export function changeCustomFieldEnumPath(enumUuid: string): string {
  return `/custom-field-enum/change/${enumUuid}`;
}

/**
 * Path for `DELETE /custom-field-enum/{,force-}delete/{custom_field_enum_uuid}`.
 *
 * Switches on `force`:
 *   - `force === false` → `/custom-field-enum/delete/{uuid}`         (safe)
 *   - `force === true`  → `/custom-field-enum/force-delete/{uuid}`   (cascading)
 */
export function deleteCustomFieldEnumPath(enumUuid: string, force: boolean): string {
  if (force) return `/custom-field-enum/force-delete/${enumUuid}`;
  return `/custom-field-enum/delete/${enumUuid}`;
}

export type GetCustomFieldEnumResult = {
  raw: ApiResponse<GetCustomFieldEnumResponse>;
  body: GetCustomFieldEnumResponse;
};

/**
 * `GET /custom-field-enum/get-for-custom-field/{uuid}` — list enum options
 * defined on an enum-typed custom field.
 *
 * 200 → `{ custom_field_enum: CustomFieldEnumOption[] }`. Empty array is a
 * valid 200 (no options yet, or all soft-deleted).
 */
export async function getCustomFieldEnum(
  client: HttpClient,
  fieldUuid: string,
  opts: CustomFieldsOpts = {},
): Promise<GetCustomFieldEnumResult> {
  const raw = await client.request({
    method: 'GET',
    path: getCustomFieldEnumPath(fieldUuid),
    schema: GetCustomFieldEnumResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

/* ---------------------------------------------------------------------------
 *  R43 — `POST /custom-field-enum/create/{custom_field_uuid}`
 *
 *  Required body: `{ value }`. Optional body: `{ uuid }` (server generates
 *  if omitted; honored if supplied — yaml :4374). The CLI does not expose
 *  the optional uuid in this slice (reserved for a future minor bump).
 * ------------------------------------------------------------------------- */

export type CreateCustomFieldEnumBody = {
  value: string;
  /** Optional caller-supplied uuid. Not exposed on the CLI surface in R43. */
  uuid?: string;
};

export type CreateCustomFieldEnumOpts = CustomFieldsOpts & {
  body: CreateCustomFieldEnumBody;
};

export type CreateCustomFieldEnumResult = {
  raw: ApiResponse<CreateCustomFieldEnumResponse>;
  body: CreateCustomFieldEnumResponse;
};

/**
 * `POST /custom-field-enum/create/{custom_field_uuid}` — add an enum option
 * to an enum-typed custom field.
 *
 * 200 → `{ custom_field_enum: CustomFieldEnumOption }`. ACL: project commander.
 * 400 if the target field is not enum-typed (yaml :4375).
 */
export async function createCustomFieldEnum(
  client: HttpClient,
  fieldUuid: string,
  opts: CreateCustomFieldEnumOpts,
): Promise<CreateCustomFieldEnumResult> {
  const raw = await client.request({
    method: 'POST',
    path: createCustomFieldEnumPath(fieldUuid),
    body: opts.body,
    schema: CreateCustomFieldEnumResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

/* ---------------------------------------------------------------------------
 *  R43 — `POST /custom-field-enum/change/{custom_field_enum_uuid}`
 *
 *  Verb is POST per OpenAPI (yaml :4417). Body: `{ value }` only — the uuid
 *  is preserved (yaml :4422), so existing task values that reference this
 *  option continue to work.
 * ------------------------------------------------------------------------- */

export type ChangeCustomFieldEnumBody = {
  value: string;
};

export type ChangeCustomFieldEnumOpts = CustomFieldsOpts & {
  body: ChangeCustomFieldEnumBody;
};

export type ChangeCustomFieldEnumResult = {
  raw: ApiResponse<ChangeCustomFieldEnumResponse>;
  body: ChangeCustomFieldEnumResponse;
};

/**
 * `POST /custom-field-enum/change/{uuid}` — rename an enum option's display
 * value. The uuid is preserved (yaml :4422). Not idempotent — rename of
 * deleted option is a real failure (404 → bubbles).
 */
export async function changeCustomFieldEnum(
  client: HttpClient,
  enumUuid: string,
  opts: ChangeCustomFieldEnumOpts,
): Promise<ChangeCustomFieldEnumResult> {
  const raw = await client.request({
    method: 'POST',
    path: changeCustomFieldEnumPath(enumUuid),
    body: opts.body,
    schema: ChangeCustomFieldEnumResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

/* ---------------------------------------------------------------------------
 *  R43 — `DELETE /custom-field-enum/{,force-}delete/{uuid}`
 *
 *  Single wrapper switches on `force`:
 *    - false → safe endpoint (refuses if the option is in use, yaml :4479)
 *    - true  → cascading endpoint (clears referencing task values, yaml :4510)
 *
 *  Both share the same response shape (`SuccessResponse`). 404 → idempotent
 *  skip at the leaf-command layer (single-arm).
 * ------------------------------------------------------------------------- */

export type DeleteCustomFieldEnumOpts = CustomFieldsOpts & {
  force: boolean;
};

export type DeleteCustomFieldEnumResult = {
  raw: ApiResponse<DeleteCustomFieldEnumResponse>;
  body: DeleteCustomFieldEnumResponse;
};

/**
 * `DELETE /custom-field-enum/{,force-}delete/{uuid}` — delete an enum option.
 *
 * Caller picks the variant via `opts.force`. The leaf command catches
 * `FreeloApiError` and applies the single-arm 404 idempotency heuristic.
 */
export async function deleteCustomFieldEnum(
  client: HttpClient,
  enumUuid: string,
  opts: DeleteCustomFieldEnumOpts,
): Promise<DeleteCustomFieldEnumResult> {
  const raw = await client.request({
    method: 'DELETE',
    path: deleteCustomFieldEnumPath(enumUuid, opts.force),
    schema: DeleteCustomFieldEnumResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}
