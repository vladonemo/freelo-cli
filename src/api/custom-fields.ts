import { type ApiResponse, type HttpClient } from './client.js';
import {
  FindCustomFieldsByProjectResponseSchema,
  GetCustomFieldTypesResponseSchema,
  type FindCustomFieldsByProjectResponse,
  type GetCustomFieldTypesResponse,
} from './schemas/custom-field.js';

/**
 * Wire wrappers for R40 `custom-fields types` / `custom-fields list`
 * (spec 0054). Both endpoints are read-only:
 *
 *   - `GET /custom-field/get-types`                    — yaml :4012-4042.
 *     Response: `{ custom_field_types: [{ uuid, name }, …] }`.
 *   - `GET /custom-field/find-by-project/{project_id}` — yaml :4529-4561.
 *     Response: `{ custom_fields: CustomField[], is_commander: boolean }`.
 *
 * The CLI does NOT create / rename / delete / restore custom fields — those
 * land in R41 (see `docs/roadmap.md` Wave 7). Both wrappers thread `signal`
 * + `requestId` opt-spreads (calibration §4: branch-coverage in the sibling
 * `test/api/custom-fields.test.ts`).
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
