import { z } from 'zod';

/**
 * Zod schemas + envelope `data` types for R38 `freelo tasks relations` /
 * `tasks find-relations` (spec 0052). Two endpoints, both **read-only**:
 *
 *   - `GET  /task/{task_id}/relations`  (yaml :1943-1969)
 *   - `POST /tasks/relations`           (yaml :1614-1660)
 *
 * The OpenAPI does NOT document any endpoint to create or delete relations —
 * both surfaces are query-only. The CLI command is correctly named
 * `find-relations` accordingly.
 */

/**
 * Discriminator for relation type. Per yaml :1621 / :4874-4875.
 */
export const TaskRelationTypeSchema = z.enum([
  'blocked_by',
  'blocks',
  'related_to',
  'duplicate_of',
]);
export type TaskRelationType = z.infer<typeof TaskRelationTypeSchema>;

/**
 * `TaskRelation` per yaml :4870-4879. The OpenAPI marks none of the fields
 * `required:`; we treat `type` and `related_task_id` as required-on-the-wire,
 * but apply `.nullable().optional()` to `related_task_name` defensively
 * (Freelo occasionally returns null names for orphaned references).
 */
export const TaskRelationSchema = z
  .object({
    type: TaskRelationTypeSchema,
    related_task_id: z.number().int(),
    related_task_name: z.string().nullable().optional(),
  })
  .passthrough();
export type TaskRelation = z.infer<typeof TaskRelationSchema>;

/** `GET /task/{task_id}/relations` response (yaml :1955-1965). */
export const GetTaskRelationsResponseSchema = z
  .object({
    relations: z.array(TaskRelationSchema),
  })
  .passthrough();
export type GetTaskRelationsResponse = z.infer<typeof GetTaskRelationsResponseSchema>;

/**
 * `POST /tasks/relations` response (yaml :1645-1658).
 *
 * Tasks the caller cannot access are silently omitted (yaml :1622). Agents
 * diff `task_ids` against `tasks[*].task_id` to detect inaccessible ids.
 */
export const FindTaskRelationsResponseSchema = z
  .object({
    tasks: z.array(
      z
        .object({
          task_id: z.number().int(),
          relations: z.array(TaskRelationSchema),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type FindTaskRelationsResponse = z.infer<typeof FindTaskRelationsResponseSchema>;

/* ---------------------------------------------------------------------------
 *  Envelope `data` types (consumed by `src/commands/tasks/{relations,find-relations}.ts`).
 * ------------------------------------------------------------------------- */

/**
 * `freelo.tasks.relations/v1` envelope `data`. Read-only — no `would`,
 * no `already_in_target_state`.
 *
 * - `task_id`    — echo of `<id>` positional. Always present.
 * - `relations`  — empty `[]` is a valid response (no relations on this task).
 *                  Always present.
 */
export type TasksRelationsData = {
  task_id: number;
  relations: TaskRelation[];
};

/**
 * `freelo.tasks.find-relations/v1` envelope `data`. Read-only bulk.
 *
 * - `task_ids` — echo of `--task <id>...`, deduplicated (1–100). Always present.
 * - `tasks`    — server response; `tasks[*].task_id` is a subset of `task_ids`
 *                (Freelo silently omits inaccessible tasks). Always present.
 */
export type TasksFindRelationsRow = {
  task_id: number;
  relations: TaskRelation[];
};

export type TasksFindRelationsData = {
  task_ids: number[];
  tasks: TasksFindRelationsRow[];
};
