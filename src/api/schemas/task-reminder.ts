import { z } from 'zod';

/**
 * Zod schemas + envelope `data` types for R35 `freelo tasks remind`
 * (spec 0049). Two endpoints, two response shapes:
 *
 *   - `POST /task/{task_id}/reminder` (yaml :2098-2115) → `SetReminderResponse`
 *   - `DELETE /task/{task_id}/reminder` (yaml :2129-2135) → `SuccessResponse`
 *
 * Both schemas use `.passthrough()` per the project-wide convention (Freelo
 * extends success bodies occasionally without a contract bump). Optional
 * fields use `.nullable().optional()` because Freelo treats null and absent
 * interchangeably.
 */

/**
 * `POST /task/{task_id}/reminder` response. The OpenAPI documents `task` as
 * `{ id: integer, name: string }` without explicit `required:`, so we treat
 * `name` as `.nullable().optional()` per the project-wide null-tolerance
 * convention (calibration: spec 0015 — `UserBasic.fullname` was the same fix).
 */
export const SetReminderResponseSchema = z
  .object({
    remind_at: z.string(),
    task: z
      .object({
        id: z.number().int(),
        name: z.string().nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type SetReminderResponse = z.infer<typeof SetReminderResponseSchema>;

/**
 * `DELETE /task/{task_id}/reminder` response — generic `SuccessResponse`,
 * mirrors `tasks-delete.ts`. Tolerates additional fields via `.passthrough()`.
 */
export const ClearReminderResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();

/* ---------------------------------------------------------------------------
 *  Envelope `data` types (consumed by `src/commands/tasks/remind/*.ts`).
 * ------------------------------------------------------------------------- */

/** Wire echo for `--dry-run` envelopes (`set` and `clear`). */
export type RemindWould = {
  method: 'POST' | 'DELETE';
  path: string;
  body: Record<string, unknown>;
};

/**
 * `freelo.tasks.remind.set/v1` envelope `data`.
 *
 * - `task_id`     — echo of `<id>` positional. Always present.
 * - `task_name`   — from server response `task.name`. Live only; null if
 *                   server omits or returns null.
 * - `remind_at`   — canonical UTC ISO. Live: from server response. Dry-run:
 *                   from canonicalized input.
 * - `would`       — present iff `--dry-run`.
 */
export type TasksRemindSetData = {
  task_id: number;
  task_name?: string | null;
  remind_at: string;
  would?: RemindWould;
};

/**
 * `freelo.tasks.remind.clear/v1` envelope `data`.
 *
 * - `task_id`                 — echo of `<id>` positional. Always present.
 * - `already_in_target_state` — `true` only on the defensive 404 path
 *                               (decision 4); always `false` on the live
 *                               200 path because the wire cannot distinguish
 *                               "had a reminder" from "had no reminder".
 * - `would`                   — present iff `--dry-run`.
 */
export type TasksRemindClearData = {
  task_id: number;
  already_in_target_state: boolean;
  would?: RemindWould;
};
