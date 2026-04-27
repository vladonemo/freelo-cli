import { z } from 'zod';
import { SubtaskSchema } from './task.js';

/**
 * Envelope-data schemas for R14 — `freelo subtasks list` / `freelo subtasks add`.
 *
 * Spec 0025 §4.2.
 *
 * The wire-shape `Subtask` is reused from `task.ts` (declared in R08, spec
 * 0018 §4.2). R14 adds CLI-side envelope-data shapes only — it does NOT add
 * any new entity wire schemas.
 */

/**
 * `freelo.subtasks.list/v1` envelope `data` shape.
 *
 *   - `task_id`: parent task id (echoed for round-trip clarity).
 *   - `subtasks`: zero-or-more `Subtask` records (R08 SubtaskSchema).
 *
 * Pagination metadata travels at the envelope level (`paging`, populated by
 * the leaf command from `pagingFromNormalized` / a synthesized `--all` page).
 *
 * Spec 0025 §3.2.
 */
export const SubtasksListDataSchema = z.object({
  task_id: z.number().int(),
  subtasks: z.array(SubtaskSchema),
});

export type SubtasksListData = z.infer<typeof SubtasksListDataSchema>;

/**
 * Storage form of a created subtask, inferred from the response shape.
 *
 *   - `'smart'`  — server returned a smart-taskcheck shape (rich task fields
 *     populated: any of `worker`, `due_date`, `due_date_end`, `state`,
 *     `tasklist`, or `project`).
 *   - `'simple'` — server returned a simple-taskcheck shape (lean
 *     `{ id, task_id, name, date_add? }` with no rich fields).
 *
 * The Freelo API auto-falls-back from smart to simple when the parent's
 * tasklist can't host smart taskchecks (OpenAPI :2425). The CLI infers the
 * resulting form from the response shape — there is no explicit `kind` field.
 *
 * Limitation: a smart subtask created with all rich fields null can mis-
 * classify as `'simple'`. Documented in spec 0025 §4.4 / decision 3.
 */
export const SubtaskStorageFormSchema = z.enum(['smart', 'simple']);
export type SubtaskStorageForm = z.infer<typeof SubtaskStorageFormSchema>;

/**
 * Names of CLI-input fields the server may discard on the smart→simple
 * fallback path. Surfaced in the response envelope's `data.input_ignored[]`
 * so agents can react.
 *
 * In v1 the only fallback-discardable inputs are `worker` and `due` — those
 * are the two non-name flags `subtasks add` accepts. Future expansion (e.g.
 * `--priority`, `--description`, `--label`) will add to this enum.
 */
export const SubtaskIgnoredInputSchema = z.enum(['worker', 'due']);
export type SubtaskIgnoredInput = z.infer<typeof SubtaskIgnoredInputSchema>;

/**
 * `freelo.subtasks.add/v1` envelope `data` shape.
 *
 *   - `task_id`: parent task id (echoed).
 *   - `subtask`: server response, validated through `SubtaskSchema`. **Always
 *     present** in live envelopes; **absent** in `--dry-run` envelopes
 *     (we have no server response to echo).
 *   - `storage_form`: `'smart' | 'simple'`. **Always present** in live
 *     envelopes; **absent** in `--dry-run` envelopes (we don't pretend to
 *     know which form the server would pick).
 *   - `input_ignored`: only present on the `'simple'` path AND only when the
 *     user set the corresponding CLI flag. Always non-empty when present —
 *     an empty array is omitted, mirroring the `paging` / `rate_limit`
 *     "absent ⇔ unknown" precedent.
 *   - `would`: only in `--dry-run` envelopes. Mirrors R09 / R13 shape.
 *   - `line_index`: only in `--stdin` batch mode. 0-indexed across non-empty
 *     input lines (mirrors R09 / R12.5 / R13).
 *
 * Spec 0025 §3.3 / §4.2.
 */
export const SubtasksAddDataSchema = z.object({
  task_id: z.number().int(),
  subtask: SubtaskSchema.optional(),
  storage_form: SubtaskStorageFormSchema.optional(),
  input_ignored: z.array(SubtaskIgnoredInputSchema).optional(),
  would: z
    .object({
      method: z.literal('POST'),
      path: z.string(),
      body: z.unknown(),
    })
    .optional(),
  line_index: z.number().int().nonnegative().optional(),
});

export type SubtasksAddData = z.infer<typeof SubtasksAddDataSchema>;

/**
 * CLI-side input shape passed to `buildCreateSubtaskBody`. Mirrors R09's
 * `CreateTaskInput` (the date-mapping decision + flag→wire convention).
 *
 * Spec 0025 §4.2.
 */
export type CreateSubtaskInput = {
  name: string;
  /** YYYY-MM-DD; mapped to `<date>T00:00:00Z` on the wire (mirrors R09). */
  due?: string;
  worker?: number;
};

/**
 * Wire-shape of `POST /task/{task_id}/subtasks` body. Subset of `SubtaskCreate`
 * (OpenAPI :5450-5481) for the v1-supported flag set.
 *
 * Server may discard `worker` and `due_date` on the simple-taskcheck fallback
 * path (OpenAPI :2425). The CLI surfaces the discarded inputs through
 * `data.input_ignored[]`.
 */
export type CreateSubtaskBody = {
  name: string;
  due_date?: string;
  worker?: number;
};
