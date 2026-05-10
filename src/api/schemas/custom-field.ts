import { z } from 'zod';

/**
 * Zod schemas + envelope `data` types for R40 `freelo custom-fields types`
 * / `freelo custom-fields list` (spec 0054). Both endpoints are read-only:
 *
 *   - `GET /custom-field/get-types`                    (yaml :4012-4042)
 *   - `GET /custom-field/find-by-project/{project_id}` (yaml :4529-4561)
 *
 * The OpenAPI does NOT document any endpoint that lets the caller mutate
 * the type catalog; types are server-curated. Custom-field definitions
 * (per project) are mutated via R41 endpoints — separate slice.
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
