import { z } from 'zod';
import { UserBasicSchema } from './project.js';

/**
 * Zod schemas for the three task entity variants and the related envelope
 * shapes used by R07 `freelo tasks list`.
 *
 * Per spec 0017 §4.1, entity schemas use `.passthrough()` because Freelo
 * documents fields loosely; only `id` and `name` are universally required.
 * Optional fields validate when present, missing fields are tolerated. Each
 * non-required field is `.nullable().optional()` because Freelo treats null
 * and absent interchangeably (same convention as project.ts / tasklist.ts).
 */

const StateSchema = z.object({
  id: z.number().int(),
  state: z.enum(['active', 'archived', 'finished', 'deleted', 'template']),
});

const TaskLabelSchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
    color: z.string().nullable().optional(),
  })
  .passthrough();

const TimeEstimateSchema = z.object({ minutes: z.number().int() }).passthrough();

const UserTimeEstimateSchema = z
  .object({
    minutes: z.number().int(),
    user: UserBasicSchema,
  })
  .passthrough();

const ProjectRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    state: StateSchema.nullable().optional(),
  })
  .passthrough();

const TasklistRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    state: StateSchema.nullable().optional(),
  })
  .passthrough();

/**
 * `TaskSummary` per OpenAPI :5220-5261. Backs `/project/{p}/tasklist/{t}/tasks`.
 * Shared base for `TaskFull` and `TaskFinished` (they extend with extra fields).
 */
export const TaskSummarySchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    date_add: z.string().nullable().optional(),
    date_edited_at: z.string().nullable().optional(),
    due_date: z.string().nullable().optional(),
    due_date_end: z.string().nullable().optional(),
    count_comments: z.number().int().nullable().optional(),
    count_subtasks: z.number().int().nullable().optional(),
    author: UserBasicSchema.nullable().optional(),
    worker: UserBasicSchema.nullable().optional(),
    labels: z.array(TaskLabelSchema).nullable().optional(),
    parent_task_id: z.number().int().nullable().optional(),
    total_time_estimate: TimeEstimateSchema.nullable().optional(),
    users_time_estimates: z.array(UserTimeEstimateSchema).nullable().optional(),
  })
  .passthrough();

/**
 * `TaskFull` per OpenAPI :5263-5287. Backs `/all-tasks`. Adds
 * `state` / `project` / `tasklist` to `TaskSummary`.
 *
 * `.merge` (instead of `.and`) keeps the schema as a `ZodObject` so
 * `.passthrough()` continues to allow forward-compat additions.
 */
export const TaskFullSchema = TaskSummarySchema.merge(
  z.object({
    state: StateSchema.nullable().optional(),
    project: ProjectRefSchema.nullable().optional(),
    tasklist: TasklistRefSchema.nullable().optional(),
  }),
).passthrough();

/**
 * `TaskFinished` per OpenAPI :5289-5298. Backs `/tasklist/{id}/finished-tasks`.
 *
 * **Note for R07 v1**: this schema is declared but the runtime route that
 * emits it (`tasklist-finished-tasks`) is deferred to R07.5 (per spec OQ #4).
 * The schema and the discriminator value live in v1 so R07.5 is purely
 * additive — no `/v2` envelope bump.
 */
export const TaskFinishedSchema = TaskSummarySchema.merge(
  z.object({
    date_finished: z.string().nullable().optional(),
    finished_by: UserBasicSchema.nullable().optional(),
  }),
).passthrough();

export type TaskSummary = z.infer<typeof TaskSummarySchema>;
export type TaskFull = z.infer<typeof TaskFullSchema>;
export type TaskFinished = z.infer<typeof TaskFinishedSchema>;

export type TaskEntityShape = 'task_full' | 'task_summary' | 'task_finished';

/** Endpoint discriminator for `freelo.tasks.list/v1`. Spec 0017 §2.3. */
export type EndpointKey = 'all-tasks' | 'tasklist-tasks' | 'tasklist-finished-tasks';

/**
 * Echo of the filter arguments the user passed, surfaced in the envelope's
 * `data.applied_filters`. Always present (object), even when empty (`{}`).
 *
 * Boolean keys (`no_due`, `finished_overdue`) are typed as `true` only — when
 * the user didn't pass the flag, the key is absent. We never echo `false`.
 */
export type AppliedFilters = {
  projects?: number[];
  tasklists?: number[];
  worker?: number;
  state?: number;
  labels?: string[];
  without_label?: string;
  due_from?: string;
  due_to?: string;
  no_due?: true;
  finished_overdue?: true;
  finished_from?: string;
  finished_to?: string;
  search?: string;
  order_by?: 'priority' | 'name' | 'date_add' | 'date_edited_at';
  order?: 'asc' | 'desc';
};

/**
 * Discriminated union backing the envelope's `data` field. The discriminator
 * is `endpoint` (and equivalently `entity_shape` — they are 1-1 in v1; spec
 * §2.3 explains why both exist).
 */
export type TaskListData =
  | {
      endpoint: 'all-tasks';
      entity_shape: 'task_full';
      applied_filters: AppliedFilters;
      tasks: TaskFull[];
    }
  | {
      endpoint: 'tasklist-tasks';
      entity_shape: 'task_summary';
      applied_filters: AppliedFilters;
      tasks: TaskSummary[];
    }
  | {
      endpoint: 'tasklist-finished-tasks';
      entity_shape: 'task_finished';
      applied_filters: AppliedFilters;
      tasks: TaskFinished[];
    };

/**
 * Default `--fields` registries per entity shape. `--fields` is the trim-down
 * knob — when omitted, the user gets the full payload for the resolved shape.
 */
export const TASK_FULL_DEFAULT_FIELDS: readonly string[] = Object.freeze([
  'id',
  'name',
  'date_add',
  'date_edited_at',
  'due_date',
  'due_date_end',
  'count_comments',
  'count_subtasks',
  'author',
  'worker',
  'labels',
  'parent_task_id',
  'total_time_estimate',
  'state',
  'project',
  'tasklist',
]);

export const TASK_SUMMARY_DEFAULT_FIELDS: readonly string[] = Object.freeze([
  'id',
  'name',
  'date_add',
  'date_edited_at',
  'due_date',
  'due_date_end',
  'count_comments',
  'count_subtasks',
  'author',
  'worker',
  'labels',
  'parent_task_id',
  'total_time_estimate',
]);

export const TASK_FINISHED_DEFAULT_FIELDS: readonly string[] = Object.freeze([
  'id',
  'name',
  'date_add',
  'date_edited_at',
  'due_date',
  'due_date_end',
  'count_comments',
  'count_subtasks',
  'author',
  'worker',
  'labels',
  'parent_task_id',
  'total_time_estimate',
  'date_finished',
  'finished_by',
]);
