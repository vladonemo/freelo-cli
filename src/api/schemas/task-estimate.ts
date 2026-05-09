import { z } from 'zod';

/**
 * Zod schemas + envelope `data` types for R37 `freelo tasks estimate`
 * (spec 0051). Four endpoints, one shared response shape:
 *
 *   - `POST   /task/{task_id}/total-time-estimate`
 *   - `DELETE /task/{task_id}/total-time-estimate`
 *   - `POST   /task/{task_id}/users-time-estimates/{user_id}`
 *   - `DELETE /task/{task_id}/users-time-estimates/{user_id}`
 *
 * All four return the generic `SuccessResponse` (yaml :2284-2289, :2304-2309,
 * :2346-2352, :2370-2377). Apply the project-wide `.passthrough()` +
 * nullable.optional convention.
 */

/**
 * Generic `SuccessResponse` from any of the four estimate endpoints.
 * Mirrors the shape used in `tasks-delete.ts` and `tasks-reminder.ts`.
 */
export const EstimateResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();

export type EstimateResponse = z.infer<typeof EstimateResponseSchema>;

/* ---------------------------------------------------------------------------
 *  Envelope `data` types (consumed by `src/commands/tasks/estimate/*.ts`).
 * ------------------------------------------------------------------------- */

/** Wire echo for `--dry-run` envelopes (`set` and `clear`). */
export type EstimateWould = {
  method: 'POST' | 'DELETE';
  path: string;
  body: Record<string, unknown>;
};

/**
 * Discriminator: total task estimate vs. per-user estimate. Derived from
 * whether `--user <id>` is present at the command layer; carried in both
 * envelope `data` types so agents can branch without parsing the wire path.
 */
export type EstimateScope = 'total' | 'user';

/**
 * `freelo.tasks.estimate.set/v1` envelope `data`.
 *
 * - `task_id` — echo of `<id>` positional. Always present.
 * - `user_id` — `null` for total scope; numeric for user scope. Always present.
 * - `minutes` — echo of `--minutes <n>` (server response is `SuccessResponse`,
 *               no minutes echo). Always present.
 * - `scope`   — discriminator derived from `--user` presence. Always present.
 * - `would`   — present iff `--dry-run`.
 *
 * No `already_in_target_state` slot: the OpenAPI does not document a GET on
 * either endpoint, so the wire cannot tell us "this estimate already had
 * this value". Mirrors R36 `share` decision 2 (be honest about wire
 * ambiguity; don't lie).
 */
export type TasksEstimateSetData = {
  task_id: number;
  user_id: number | null;
  minutes: number;
  scope: EstimateScope;
  would?: EstimateWould;
};

/**
 * `freelo.tasks.estimate.clear/v1` envelope `data`.
 *
 * - `task_id`                 — echo of `<id>` positional. Always present.
 * - `user_id`                 — `null` for total scope; numeric for user scope.
 * - `scope`                   — discriminator derived from `--user` presence.
 * - `already_in_target_state` — `true` only on the defensive 404 path
 *                               (decision 6); always `false` on the live
 *                               200 path because the wire cannot distinguish
 *                               "had an estimate" from "had no estimate"
 *                               (yaml :2299, :2362 — server idempotent).
 * - `would`                   — present iff `--dry-run`.
 */
export type TasksEstimateClearData = {
  task_id: number;
  user_id: number | null;
  scope: EstimateScope;
  already_in_target_state: boolean;
  would?: EstimateWould;
};
