import { z } from 'zod';
import { TaskCommentSchema } from './task.js';

/**
 * Envelope-data schemas for R15 — `freelo tasks description get` /
 * `freelo tasks description set`.
 *
 * Spec 0026 §4.2.
 */

/**
 * Source of the content for `tasks description set`. Echoed in the response
 * envelope so agents can verify which input source produced the body.
 *
 *   - `'file'`   — read from `--from-file <path>`.
 *   - `'editor'` — interactively edited via `--editor`.
 *   - `'stdin'`  — read from stdin (`-`).
 */
export const SetDescriptionSourceSchema = z.enum(['file', 'editor', 'stdin']);
export type SetDescriptionSource = z.infer<typeof SetDescriptionSourceSchema>;

/**
 * `freelo.tasks.description.get/v1` envelope `data` shape.
 *
 *   - `task_id`: task id (echoed).
 *   - `description`: server response (`Comment`), validated through
 *     `TaskCommentSchema`. The Freelo API returns 200 even for tasks with no
 *     description set — the `id` and `content` fields may be `null` or empty
 *     in that case (OpenAPI :2015). Callers should read `data.description.content`
 *     and treat `null`/`""` as "no description".
 *
 * Spec 0026 §3.2.
 */
export const TasksDescriptionGetDataSchema = z.object({
  task_id: z.number().int(),
  description: TaskCommentSchema,
});
export type TasksDescriptionGetData = z.infer<typeof TasksDescriptionGetDataSchema>;

/**
 * `freelo.tasks.description.set/v1` envelope `data` shape.
 *
 *   - `task_id`: task id (echoed).
 *   - `description`: server response, validated through `TaskCommentSchema`.
 *     **Always present** in live envelopes; **absent** in `--dry-run`.
 *   - `source`: `'file' | 'editor' | 'stdin'`. **Always present** in live;
 *     **absent** in `--dry-run`.
 *   - `byte_length`: UTF-8 byte length of the content sent (or that would
 *     have been sent in dry-run). **Always present**.
 *   - `would`: only in `--dry-run` envelopes (mirrors R09 / R13 / R14).
 *
 * Spec 0026 §3.3 / §4.2.
 */
export const TasksDescriptionSetDataSchema = z.object({
  task_id: z.number().int(),
  description: TaskCommentSchema.optional(),
  source: SetDescriptionSourceSchema.optional(),
  byte_length: z.number().int().nonnegative(),
  would: z
    .object({
      method: z.literal('POST'),
      path: z.string(),
      body: z.unknown(),
    })
    .optional(),
});
export type TasksDescriptionSetData = z.infer<typeof TasksDescriptionSetDataSchema>;

/**
 * CLI-side input shape passed to `buildSetDescriptionBody`.
 */
export type SetDescriptionInput = {
  content: string;
};

/**
 * Wire-shape of the POST body for `/task/{task_id}/description`. Subset of
 * the OpenAPI request body (`docs/api/freelo-api.yaml:2044-2058`) for the
 * v1-supported field set — no `files[]` (multipart upload helper lands at
 * R25 per `docs/roadmap.md:687`).
 */
export type SetDescriptionBody = {
  content: string;
};
