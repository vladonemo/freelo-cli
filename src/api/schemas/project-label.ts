/**
 * Zod schemas for the `labels` (project-labels) resource group, R23
 * (spec 0035).
 *
 * Wire shape: `ProjectLabel` from OpenAPI :5025-5044 — used by the
 * `GET /project-labels/find-available` response and as the conceptual
 * shape behind every other label endpoint's path id.
 *
 * Loose by design: every leaf is `.nullable().optional()` per the
 * project's permissive-schema policy (R05.5 lessons), and the outer
 * object is `.passthrough()` so future fields don't break parsing.
 */

import { z } from 'zod';

/**
 * `ProjectLabel` wire shape (OpenAPI :5025-5044).
 *
 * Required field set is just `id` — every other field is optional/nullable
 * to absorb partial responses. Spec 0035 §6.1.
 */
export const ProjectLabelSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    is_private: z.boolean().nullable().optional(),
    users_id: z.number().int().nullable().optional(),
    usage_count: z.number().int().nullable().optional(),
    can_be_public: z.boolean().nullable().optional(),
    can_be_edited: z.boolean().nullable().optional(),
  })
  .passthrough();
export type ProjectLabel = z.infer<typeof ProjectLabelSchema>;

/**
 * Response body of `GET /project-labels/find-available` (yaml :855).
 *
 * Note the singular outer key holding an array — same naming anomaly as
 * other Freelo list endpoints. CLI flips it to `labels` (plural) at the
 * envelope layer.
 */
export const FindAvailableLabelsResponseSchema = z
  .object({
    label: z.array(ProjectLabelSchema),
  })
  .passthrough();
export type FindAvailableLabelsResponse = z.infer<typeof FindAvailableLabelsResponseSchema>;

/* ---------------------------------------------------------------------------
 *  freelo.labels.list/v1
 * ------------------------------------------------------------------------- */

/** Live `data` shape for `freelo.labels.list/v1` (no paging — single-shot). */
export const LabelsListDataSchema = z.object({
  labels: z.array(ProjectLabelSchema),
});
export type LabelsListData = z.infer<typeof LabelsListDataSchema>;

/* ---------------------------------------------------------------------------
 *  freelo.labels.rename/v1
 * ------------------------------------------------------------------------- */

/**
 * Echo of the wire body for `labels rename`. Each key is present iff the
 * user actually passed the corresponding flag. At least one key is
 * always present (empty edit rejected at the command layer per
 * decision 04).
 */
export const LabelsRenameAppliedChangesSchema = z.object({
  name: z.string().optional(),
  color: z.string().optional(),
  is_private: z.boolean().optional(),
});
export type LabelsRenameAppliedChanges = z.infer<typeof LabelsRenameAppliedChangesSchema>;

/** Live `data` shape for `freelo.labels.rename/v1` (post-POST). */
export const LabelsRenameLiveDataSchema = z.object({
  label_id: z.number().int(),
  applied_changes: LabelsRenameAppliedChangesSchema,
});
export type LabelsRenameLiveData = z.infer<typeof LabelsRenameLiveDataSchema>;

/** Dry-run `data` shape for `freelo.labels.rename/v1`. */
export const LabelsRenameDryRunDataSchema = z.object({
  label_id: z.number().int(),
  applied_changes: LabelsRenameAppliedChangesSchema,
});
export type LabelsRenameDryRunData = z.infer<typeof LabelsRenameDryRunDataSchema>;

/* ---------------------------------------------------------------------------
 *  freelo.labels.delete/v1
 *
 *  Mirrors `ReportsDeleteDataSchema` (spec 0034) modulo the field rename
 *  `report_id` → `label_id`. Two-arm idempotency (404 only) per
 *  decision 09 (no documented 400 fallback for already-deleted).
 * ------------------------------------------------------------------------- */

export const LabelsDeleteDataSchema = z.object({
  label_id: z.number().int(),
  previous_state: z.literal(null),
  current_state: z.literal('deleted'),
  already_in_target_state: z.boolean(),
  would: z
    .object({
      method: z.literal('DELETE'),
      path: z.string(),
      body: z.unknown(),
    })
    .optional(),
  line_index: z.number().int().min(0).optional(),
});
export type LabelsDeleteData = z.infer<typeof LabelsDeleteDataSchema>;

/* ---------------------------------------------------------------------------
 *  freelo.labels.attach/v1
 *
 *  No `already_in_target_state` field (decision 08 — server hides the
 *  re-attach signal).
 * ------------------------------------------------------------------------- */

export const LabelsAttachDataSchema = z.object({
  project_id: z.number().int(),
  name: z.string(),
  is_private: z.boolean(),
  color: z.string().optional(),
  would: z
    .object({
      method: z.literal('POST'),
      path: z.string(),
      body: z.unknown(),
    })
    .optional(),
});
export type LabelsAttachData = z.infer<typeof LabelsAttachDataSchema>;

/* ---------------------------------------------------------------------------
 *  freelo.labels.detach/v1
 *
 *  Two-arm idempotency: 404 → already_in_target_state: true (decision 09).
 *  `current_state` literal `"detached"` (NOT `"deleted"` — the label is
 *  preserved at the workspace level).
 * ------------------------------------------------------------------------- */

export const LabelsDetachDataSchema = z.object({
  project_id: z.number().int(),
  label_id: z.number().int(),
  previous_state: z.literal(null),
  current_state: z.literal('detached'),
  already_in_target_state: z.boolean(),
  would: z
    .object({
      method: z.literal('POST'),
      path: z.string(),
      body: z.unknown(),
    })
    .optional(),
  line_index: z.number().int().min(0).optional(),
});
export type LabelsDetachData = z.infer<typeof LabelsDetachDataSchema>;
