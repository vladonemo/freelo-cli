/**
 * Zod schemas for the `task-labels` resource group, R24 (spec 0036).
 *
 * Wire endpoints (yaml :2446-2573):
 *   - `POST /task-labels`                                — bulk-create label definitions
 *   - `POST /task-labels/add-to-task/{task_id}`          — attach labels to a task
 *   - `POST /task-labels/remove-from-task/{task_id}`     — detach labels from a task
 *
 * Note: the detach endpoint is **POST** (not DELETE as the roadmap suggests).
 * OpenAPI is authoritative — see spec 0036 decision 01.
 *
 * Loose by design: every leaf is optional/nullable per the project's
 * permissive-schema policy (R05.5 lessons), and `would.body` is `unknown`
 * because dry-run echoes whatever the wire builder emitted.
 */

import { z } from 'zod';

/* ---------------------------------------------------------------------------
 *  Generic Freelo success envelope
 *
 *  Mirrors the local pattern in `src/api/project-labels.ts` and
 *  `src/api/reports.ts`. Tolerates additional fields.
 * ------------------------------------------------------------------------- */

export const SuccessResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();
export type SuccessResponse = z.infer<typeof SuccessResponseSchema>;

/* ---------------------------------------------------------------------------
 *  Common entry shapes (echoed in envelope `data.labels[]`)
 *
 *  Each envelope variant uses the same loose entry shape — `uuid`, `name`,
 *  and `color` are all optional individually. The CLI is responsible for
 *  ensuring the entry conforms to one of the OpenAPI `oneOf` arms before
 *  the wire call (validators in the command layer).
 * ------------------------------------------------------------------------- */

export const TaskLabelEntrySchema = z.object({
  uuid: z.string().optional(),
  name: z.string().optional(),
  color: z.string().optional(),
});
export type TaskLabelEntry = z.infer<typeof TaskLabelEntrySchema>;

/* ---------------------------------------------------------------------------
 *  Shared `would` shape for dry-run envelopes
 * ------------------------------------------------------------------------- */

const WouldSchema = z
  .object({
    method: z.literal('POST'),
    path: z.string(),
    body: z.unknown(),
  })
  .optional();

/* ---------------------------------------------------------------------------
 *  freelo.task_labels.create/v1
 *
 *  Schema string: `freelo.task_labels.create/v1`
 *  Body shape (wire): `{ labels: [{ name, color? }, ...] }`
 *  Idempotent (server-side fetch-or-create — no signal back to CLI).
 * ------------------------------------------------------------------------- */

export const TaskLabelsCreateDataSchema = z.object({
  labels: z.array(TaskLabelEntrySchema),
  count: z.number().int().min(0),
  would: WouldSchema,
});
export type TaskLabelsCreateData = z.infer<typeof TaskLabelsCreateDataSchema>;

/* ---------------------------------------------------------------------------
 *  freelo.task_labels.attach/v1
 * ------------------------------------------------------------------------- */

export const TaskLabelsAttachDataSchema = z.object({
  task_id: z.number().int(),
  labels: z.array(TaskLabelEntrySchema),
  count: z.number().int().min(0),
  would: WouldSchema,
});
export type TaskLabelsAttachData = z.infer<typeof TaskLabelsAttachDataSchema>;

/* ---------------------------------------------------------------------------
 *  freelo.task_labels.detach/v1
 *
 *  Same shape as attach — the CLI emits one envelope per call (one POST
 *  per command, bulk-by-design — spec 0036 decision 05).
 * ------------------------------------------------------------------------- */

export const TaskLabelsDetachDataSchema = z.object({
  task_id: z.number().int(),
  labels: z.array(TaskLabelEntrySchema),
  count: z.number().int().min(0),
  would: WouldSchema,
});
export type TaskLabelsDetachData = z.infer<typeof TaskLabelsDetachDataSchema>;
