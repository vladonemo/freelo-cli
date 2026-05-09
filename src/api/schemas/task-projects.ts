import { z } from 'zod';

/**
 * Zod schemas + envelope `data` types for R38 `freelo tasks project add` /
 * `tasks project remove` (spec 0052). Two endpoints:
 *
 *   - `POST   /task/{task_id}/projects`               (yaml :1893-1941)
 *   - `DELETE /task/{task_id}/projects/{project_id}`  (yaml :1971-2000)
 *
 * The POST body takes `tasklist_id` (single, yaml :1919-1922) — the target
 * project is derived from the tasklist by Freelo. The CLI's `--tasklist <id>`
 * is repeatable; each value fans out to one POST (spec 0052 decision 3).
 *
 * Both schemas use `.passthrough()` per project convention (Freelo extends
 * success bodies occasionally without a contract bump).
 */

/**
 * `POST /task/{task_id}/projects` response (yaml :1923-1937).
 *
 * `task.id` is the **child task id** (the new task in the secondary project).
 * `task.uuid` is its UUID. Both required-on-200; the wrapper passthroughs
 * for forward-compat (Freelo may surface `parent_task_id`, `multi_project_task`,
 * etc. without a contract bump).
 */
export const AssignTaskToProjectResponseSchema = z
  .object({
    task: z
      .object({
        id: z.number().int(),
        uuid: z.string(),
      })
      .passthrough(),
  })
  .passthrough();
export type AssignTaskToProjectResponse = z.infer<typeof AssignTaskToProjectResponseSchema>;

/**
 * `DELETE /task/{task_id}/projects/{project_id}` response (yaml :1990-1996) —
 * generic `SuccessResponse`. Mirrors the R37 / R36 clear schemas.
 */
export const RemoveTaskFromProjectResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();
export type RemoveTaskFromProjectResponse = z.infer<typeof RemoveTaskFromProjectResponseSchema>;

/* ---------------------------------------------------------------------------
 *  Envelope `data` types (consumed by `src/commands/tasks/project/*.ts`).
 * ------------------------------------------------------------------------- */

/**
 * One per-tasklist outcome from the live `add` fan-out. On a mid-fan-out
 * failure, the envelope carries only the entries up to the failure point.
 */
export type ProjectAddAssignment = {
  tasklist_id: number;
  child_task_id: number;
  child_task_uuid: string;
};

/**
 * Wire echo for the `add` `--dry-run` envelope. Spec 0052 decision 6 — N
 * fan-out POSTs collapse into one envelope echo with a `tasklist_ids` array.
 * The path is the same for all (`/task/{id}/projects`); only the body
 * varies per call.
 */
export type ProjectAddWould = {
  method: 'POST';
  path: string;
  body: { tasklist_ids: number[] };
};

/**
 * `freelo.tasks.project.add/v1` envelope `data`.
 *
 * - `task_id`      — echo of `<id>` positional (the parent task). Always present.
 * - `tasklist_ids` — echo of `--tasklist <id>...`, deduplicated. Always present.
 * - `assignments`  — present on the live path; one entry per successful POST.
 *                    On a mid-fan-out error this is truncated. Omitted on dry-run.
 * - `would`        — present iff `--dry-run`.
 *
 * No `already_in_target_state` slot — wire ambiguity (spec 0052 decision 4).
 */
export type TasksProjectAddData = {
  task_id: number;
  tasklist_ids: number[];
  assignments?: ProjectAddAssignment[];
  would?: ProjectAddWould;
};

/** Wire echo for the `remove` `--dry-run` envelope. Empty body. */
export type ProjectRemoveWould = {
  method: 'DELETE';
  path: string;
  body: Record<string, never>;
};

/**
 * `freelo.tasks.project.remove/v1` envelope `data`.
 *
 * - `task_id`                 — echo of `<id>` positional. Always present.
 * - `project_id`              — echo of `--project <id>`. Always present.
 * - `already_in_target_state` — `true` only on the 404 path (yaml :1985 —
 *                               documented "not in this project" signal,
 *                               first-class idempotency, not just defensive).
 *                               `false` on live 200. Dry-run: `false`.
 * - `would`                   — present iff `--dry-run`.
 */
export type TasksProjectRemoveData = {
  task_id: number;
  project_id: number;
  already_in_target_state: boolean;
  would?: ProjectRemoveWould;
};
