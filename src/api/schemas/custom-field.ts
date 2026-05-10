import { z } from 'zod';
import { type Would } from '../../lib/dry-run.js';

/**
 * Zod schemas + envelope `data` types for the `custom-fields` family.
 *
 * R40 (spec 0054) — read-only:
 *   - `GET /custom-field/get-types`                    (yaml :4012-4042)
 *   - `GET /custom-field/find-by-project/{project_id}` (yaml :4529-4561)
 *
 * R41 (spec 0055) — CRUD on a per-project basis:
 *   - `POST   /custom-field/create/{project_id}`       (yaml :4043-4095)
 *   - `POST   /custom-field/rename/{uuid}`             (yaml :4097-4136)  — POST not PATCH; OpenAPI is authoritative.
 *   - `DELETE /custom-field/delete/{uuid}`             (yaml :4138-4166)
 *   - `POST   /custom-field/restore/{uuid}`            (yaml :4168-4196)
 *
 * The OpenAPI does NOT document any endpoint that lets the caller mutate
 * the type catalog; types are server-curated.
 */

/**
 * `CustomFieldType` — one row of `GET /custom-field/get-types`
 * (yaml :4029-4041). The OpenAPI marks both fields without `required:`;
 * we treat both as required-on-the-wire — a type row without a uuid
 * is unusable. `.passthrough()` keeps unknown future fields (e.g.
 * a localised name) instead of stripping them. (Spec 0054 decision 7.)
 */
export const CustomFieldTypeSchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
  })
  .passthrough();
export type CustomFieldType = z.infer<typeof CustomFieldTypeSchema>;

/** `GET /custom-field/get-types` response (yaml :4029-4041). */
export const GetCustomFieldTypesResponseSchema = z
  .object({
    custom_field_types: z.array(CustomFieldTypeSchema),
  })
  .passthrough();
export type GetCustomFieldTypesResponse = z.infer<typeof GetCustomFieldTypesResponseSchema>;

/**
 * `CustomField` — one custom-field definition (yaml :6054-6073). Documented
 * fields: `uuid, custom_fields_types_uuid, project_id, author_id, name,
 * date_add, priority`.
 *
 * Per project schema convention (`.claude/docs/conventions.md` §API client):
 * any optional field on an inbound response is also nullable. `uuid` and
 * `name` are treated as required-on-the-wire — a custom-field row without
 * one is unusable for the R41+ mutation endpoints (which identify the field
 * by uuid) and unrenderable. (Spec 0054 decision 7.)
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

/** `GET /custom-field/find-by-project/{project_id}` response (yaml :4548-4560). */
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

/**
 * `freelo.custom-fields.types/v1` envelope `data`. Read-only — no `would`,
 * no `already_in_target_state`.
 *
 * - `types` — server-returned type catalog. Currently three documented types
 *   (text / number / enum) but `.passthrough()` keeps unknowns. Always present.
 */
export type CustomFieldsTypesData = {
  types: CustomFieldType[];
};

/**
 * `freelo.custom-fields.list/v1` envelope `data`. Read-only.
 *
 * - `project_id`     — echo of `--project <id>` (agent self-correlation). Always present.
 * - `custom_fields`  — server-returned array. May be empty `[]`. Always present.
 * - `is_commander`   — server signal — true if the caller can call R41+
 *                      mutation endpoints on this project. Always present.
 */
export type CustomFieldsListData = {
  project_id: number;
  custom_fields: CustomField[];
  is_commander: boolean;
};

/* ---------------------------------------------------------------------------
 *  R41 — wire response schemas (spec 0055).
 *
 *  All four endpoints in this slice return JSON. `create` / `rename` /
 *  `restore` wrap a `CustomField` under `custom_field`. `delete` returns the
 *  generic `SuccessResponse` shape (`{ result: 'success' }`). Each schema
 *  uses `.passthrough()` to forward unknown future fields without stripping.
 * ------------------------------------------------------------------------- */

/** `POST /custom-field/create/{project_id}` response (yaml :4086-4095). */
export const CreateCustomFieldResponseSchema = z
  .object({ custom_field: CustomFieldSchema })
  .passthrough();
export type CreateCustomFieldResponse = z.infer<typeof CreateCustomFieldResponseSchema>;

/** `POST /custom-field/rename/{uuid}` response (yaml :4127-4136). */
export const RenameCustomFieldResponseSchema = z
  .object({ custom_field: CustomFieldSchema })
  .passthrough();
export type RenameCustomFieldResponse = z.infer<typeof RenameCustomFieldResponseSchema>;

/**
 * `DELETE /custom-field/delete/{uuid}` response (yaml :4160-4166). Generic
 * Freelo `SuccessResponse` (`{ result: 'success' }`); we accept any string
 * (or null/absent) for `result` and tolerate other fields.
 */
export const DeleteCustomFieldResponseSchema = z
  .object({ result: z.string().nullable().optional() })
  .passthrough();
export type DeleteCustomFieldResponse = z.infer<typeof DeleteCustomFieldResponseSchema>;

/** `POST /custom-field/restore/{uuid}` response (yaml :4187-4196). */
export const RestoreCustomFieldResponseSchema = z
  .object({ custom_field: CustomFieldSchema })
  .passthrough();
export type RestoreCustomFieldResponse = z.infer<typeof RestoreCustomFieldResponseSchema>;

/* ---------------------------------------------------------------------------
 *  R41 — envelope `data` types (consumed by `src/commands/custom-fields/{create,rename,delete,restore}.ts`).
 * ------------------------------------------------------------------------- */

/**
 * `freelo.custom-fields.create/v1` envelope `data`.
 *
 * - `project_id`   — echo of `--project <id>`. Always present.
 * - `custom_field` — server-returned full definition. Present on live
 *                    success; absent on `dry_run`.
 * - `would`        — present on `dry_run`; absent on live success.
 */
export type CustomFieldsCreateData = {
  project_id: number;
  custom_field?: CustomField;
  would?: Would;
};

/**
 * `freelo.custom-fields.rename/v1` envelope `data`.
 *
 * - `uuid`            — echo of positional `<uuid>`. Always present.
 * - `applied_changes` — `{ name: <new-name> }` for now. Future fields
 *                       (priority, etc.) would extend this object — backwards
 *                       compatible per the public-contract policy.
 * - `would`           — present on `dry_run`; absent on live success.
 */
export type CustomFieldsRenameData = {
  uuid: string;
  applied_changes: { name?: string };
  would?: Would;
};

/**
 * `freelo.custom-fields.delete/v1` envelope `data`.
 *
 * - `previous_state`           — reserved (always `null` v1; mirrors R13/R23).
 * - `current_state`            — constant `'deleted'`.
 * - `already_in_target_state`  — true iff 404 idempotent skip.
 * - `would`                    — present on `dry_run`.
 * - `line_index`               — present in `--stdin` batch mode.
 */
export type CustomFieldsDeleteData = {
  uuid: string;
  previous_state: null;
  current_state: 'deleted';
  already_in_target_state: boolean;
  would?: Would;
  line_index?: number;
};

/**
 * `freelo.custom-fields.restore/v1` envelope `data`.
 *
 * - `previous_state`           — reserved (always `null` v1).
 * - `current_state`            — constant `'active'`.
 * - `already_in_target_state`  — true iff 404 idempotent skip.
 * - `custom_field`             — server-returned full definition. Present on
 *                                live success; absent on `dry_run` AND on the
 *                                404-skip path (no follow-up GET — defeats the
 *                                idempotent skip).
 * - `would`                    — present on `dry_run`.
 * - `line_index`               — present in `--stdin` batch mode.
 */
export type CustomFieldsRestoreData = {
  uuid: string;
  previous_state: null;
  current_state: 'active';
  already_in_target_state: boolean;
  custom_field?: CustomField;
  would?: Would;
  line_index?: number;
};
