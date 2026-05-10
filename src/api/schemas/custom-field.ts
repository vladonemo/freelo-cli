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
 *  R42 — value set / value clear (spec 0056).
 *
 *  Three new endpoints:
 *    POST /custom-field/add-or-edit-value          (yaml :4198-4244)  — scalar
 *    POST /custom-field/add-or-edit-enum-value     (yaml :4246-4294)  — enum
 *    DELETE /custom-field/delete-value/{uuid}      (yaml :4296-4324)
 *
 *  Plus `CustomFieldWithValue` for the read-back via `GET /task/{task_id}`
 *  (yaml :6135-6166) — used to resolve a (task_id, field_uuid) pair to a
 *  value_uuid because the DELETE endpoint takes a value_uuid, not a field
 *  uuid (spec 0056 §2.2).
 * ------------------------------------------------------------------------- */

/**
 * `CustomFieldValue` — one persisted value record (yaml :6075-6096). Returned
 * (wrapped) by both the scalar and enum upsert endpoints; the scalar wrapper
 * key is `custom_field_value`, the enum wrapper key is `customFieldEnum`
 * (camelCase). Both response inner shapes match this schema.
 */
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
export type CustomFieldValue = z.infer<typeof CustomFieldValueSchema>;

/** `POST /custom-field/add-or-edit-value` response (yaml :4243-4244). */
export const AddOrEditCustomFieldValueResponseSchema = z
  .object({
    custom_field_value: CustomFieldValueSchema.nullable().optional(),
  })
  .passthrough();
export type AddOrEditCustomFieldValueResponse = z.infer<
  typeof AddOrEditCustomFieldValueResponseSchema
>;

/**
 * `POST /custom-field/add-or-edit-enum-value` response (yaml :4293-4294).
 *
 * Wrapper key is camelCase `customFieldEnum`. Inner shape is byte-identical
 * to `CustomFieldValueSchema` (yaml :6098-6119).
 */
export const AddOrEditCustomFieldEnumValueResponseSchema = z
  .object({
    customFieldEnum: CustomFieldValueSchema.nullable().optional(),
  })
  .passthrough();
export type AddOrEditCustomFieldEnumValueResponse = z.infer<
  typeof AddOrEditCustomFieldEnumValueResponseSchema
>;

/**
 * `CustomFieldWithValue` — one entry in the `TaskDetail.custom_fields[]` array
 * returned by `GET /task/{task_id}` (yaml :6135-6166). The CLI re-validates
 * just this slice locally inside `value clear` to recover the
 * `(field_uuid → value_uuid)` mapping that DELETE needs. Spec 0055 §3.1.
 */
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
export type CustomFieldWithValue = z.infer<typeof CustomFieldWithValueSchema>;

/* ---------------------------------------------------------------------------
 *  Envelope `data` types (R42 / spec 0056).
 * ------------------------------------------------------------------------- */

/**
 * `freelo.custom-fields.value-set/v1` envelope `data`.
 *
 * - `task_id`, `field_uuid`        — echo of the input flags.
 * - `kind`                         — 'scalar' (--value) or 'enum' (--enum).
 *                                   Self-correlation hint for downstream
 *                                   consumers; mirrors which endpoint was hit.
 * - `value_uuid`                   — server-generated/preserved record uuid.
 *                                   Null on dry-run only.
 * - `value`                        — for scalar: the string. For enum: the
 *                                   enum-option uuid.
 * - `previous_value_uuid`          — always null in v1 (we do not pre-GET to
 *                                   discover it; reserved for future bumps).
 * - `would`                        — present on dry-run only (no wire call).
 * - `input_index` / `line_index`   — batch positional / NDJSON index.
 */
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

/**
 * `freelo.custom-fields.value-clear/v1` envelope `data`.
 *
 * - `task_id`, `field_uuid`        — echo of the input flags.
 * - `value_uuid`                   — the record uuid that was (or would be)
 *                                   deleted. Null when the read-back found
 *                                   nothing (already-cleared).
 * - `previous_state`               — 'set' if a value existed; 'absent' otherwise.
 * - `current_state`                — always 'absent' on success.
 * - `already_in_target_state`      — true for the two idempotent arms:
 *                                   (a) read-back found nothing,
 *                                   (b) DELETE returned 404.
 * - `would`                        — present on dry-run only.
 * - `input_index` / `line_index`   — batch positional / NDJSON index.
 */
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

/* ---------------------------------------------------------------------------
 *  R43 — enum option list/add/rename/delete (spec 0057).
 *
 *  Five new endpoints (two for delete — safe + force):
 *    GET    /custom-field-enum/get-for-custom-field/{uuid}  (yaml :4326-4359)
 *    POST   /custom-field-enum/create/{uuid}                (yaml :4361-4414)
 *    POST   /custom-field-enum/change/{uuid}                (yaml :4416-4464)
 *    DELETE /custom-field-enum/delete/{uuid}                (yaml :4466-4495)
 *    DELETE /custom-field-enum/force-delete/{uuid}          (yaml :4497-4527)
 *
 *  The rename verb is **POST** per OpenAPI — the roadmap's `PATCH` is wrong
 *  (decision 1, same as R41 spec 0055 decision 01).
 * ------------------------------------------------------------------------- */

/**
 * One enum option row (yaml `#/components/schemas/CustomFieldEnumOption`).
 * Both fields are required-on-the-wire — a row without a uuid is unaddressable
 * and a row without a value is unrenderable. `.passthrough()` keeps unknown
 * future fields.
 */
export const CustomFieldEnumOptionSchema = z
  .object({
    uuid: z.string(),
    value: z.string(),
  })
  .passthrough();
export type CustomFieldEnumOption = z.infer<typeof CustomFieldEnumOptionSchema>;

/** `GET /custom-field-enum/get-for-custom-field/{uuid}` response (yaml :4353-4359). */
export const GetCustomFieldEnumResponseSchema = z
  .object({
    custom_field_enum: z.array(CustomFieldEnumOptionSchema),
  })
  .passthrough();
export type GetCustomFieldEnumResponse = z.infer<typeof GetCustomFieldEnumResponseSchema>;

/** `POST /custom-field-enum/create/{uuid}` response (yaml :4400-4414). */
export const CreateCustomFieldEnumResponseSchema = z
  .object({ custom_field_enum: CustomFieldEnumOptionSchema })
  .passthrough();
export type CreateCustomFieldEnumResponse = z.infer<typeof CreateCustomFieldEnumResponseSchema>;

/** `POST /custom-field-enum/change/{uuid}` response (yaml :4450-4464). */
export const ChangeCustomFieldEnumResponseSchema = z
  .object({ custom_field_enum: CustomFieldEnumOptionSchema })
  .passthrough();
export type ChangeCustomFieldEnumResponse = z.infer<typeof ChangeCustomFieldEnumResponseSchema>;

/**
 * `DELETE /custom-field-enum/{,force-}delete/{uuid}` response (yaml :4490-4495 /
 * :4521-4527 — both `$ref: '#/components/schemas/SuccessResponse'`).
 *
 * Same shape as R41's `DeleteCustomFieldResponseSchema` (`{ result: 'success' }`);
 * we declare a dedicated alias rather than re-exporting so the import graph
 * reads cleanly per resource.
 */
export const DeleteCustomFieldEnumResponseSchema = z
  .object({ result: z.string().nullable().optional() })
  .passthrough();
export type DeleteCustomFieldEnumResponse = z.infer<typeof DeleteCustomFieldEnumResponseSchema>;

/* ---------------------------------------------------------------------------
 *  R43 — envelope `data` types (consumed by `src/commands/custom-fields/enum/{list,add,rename,delete}.ts`).
 * ------------------------------------------------------------------------- */

/**
 * `freelo.custom-fields.enum-list/v1` envelope `data`. Read-only.
 *
 * - `field_uuid` — echo of `--field <uuid>` for self-correlation. Always present.
 * - `options`    — server-returned array. May be empty `[]`.
 */
export type CustomFieldsEnumListData = {
  field_uuid: string;
  options: CustomFieldEnumOption[];
};

/**
 * `freelo.custom-fields.enum-add/v1` envelope `data`.
 *
 * - `field_uuid` — echo of `--field`. Always present.
 * - `option`     — server-returned full option (uuid + value). Present on live
 *                  success; absent on dry-run.
 * - `would`      — present on dry-run; absent on live success.
 */
export type CustomFieldsEnumAddData = {
  field_uuid: string;
  option?: CustomFieldEnumOption;
  would?: Would;
};

/**
 * `freelo.custom-fields.enum-rename/v1` envelope `data`.
 *
 * - `uuid`            — echo of positional `<enum_uuid>`. Always present.
 * - `applied_changes` — `{ value: <new-display> }`. Future fields would extend
 *                       this object; backwards compatible per the public-contract
 *                       policy.
 * - `would`           — present on dry-run; absent on live success.
 */
export type CustomFieldsEnumRenameData = {
  uuid: string;
  applied_changes: { value?: string };
  would?: Would;
};

/**
 * `freelo.custom-fields.enum-delete/v1` envelope `data`.
 *
 * - `uuid`                     — echo of positional. Always present.
 * - `force`                    — true iff `--force` was passed (i.e. the cascading
 *                                endpoint was hit). Public so consumers know
 *                                which wire endpoint executed.
 * - `previous_state`           — reserved (always `null` v1; mirrors R13/R23/R41).
 * - `current_state`            — constant `'deleted'`.
 * - `already_in_target_state`  — true iff 404 idempotent skip.
 * - `would`                    — present on dry-run.
 * - `line_index`               — present in `--stdin` batch mode.
 */
export type CustomFieldsEnumDeleteData = {
  uuid: string;
  force: boolean;
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
