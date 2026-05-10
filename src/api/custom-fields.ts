import { type ApiResponse, type HttpClient } from './client.js';
import {
  CreateCustomFieldResponseSchema,
  DeleteCustomFieldResponseSchema,
  FindCustomFieldsByProjectResponseSchema,
  GetCustomFieldTypesResponseSchema,
  RenameCustomFieldResponseSchema,
  RestoreCustomFieldResponseSchema,
  type CreateCustomFieldResponse,
  type DeleteCustomFieldResponse,
  type FindCustomFieldsByProjectResponse,
  type GetCustomFieldTypesResponse,
  type RenameCustomFieldResponse,
  type RestoreCustomFieldResponse,
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
