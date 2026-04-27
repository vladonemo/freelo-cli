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

/* ---------------------------------------------------------------------------
 *  R08 — `freelo tasks show <id>` (spec 0018)
 *
 *  TaskDetail is materially richer than TaskFull/TaskSummary — adds
 *  priority_enum, count_subtasks, cost, comments[], custom_fields[], time
 *  estimates, tracking_users[], and the multi_project_task block. Declared
 *  from scratch (not extended) so we don't drag the leaner shapes' field
 *  set as required (spec 0018 §4.1, OQ#5).
 * ------------------------------------------------------------------------- */

const PriorityEnumSchema = z.enum(['l', 'm', 'h']);

/**
 * Money amount embedded in `TaskDetail.cost`. Live Freelo API returns the
 * same union-of-string-or-number that `tasklist.ts` / `project.ts` document
 * for `CurrencySchema`. We normalize to string for envelope stability.
 *
 * Inlined here (not imported) so R08's schema work is self-contained — the
 * cross-module shared `Currency` is a follow-up refactor (same approach as
 * `TimeEstimateSchema` / `UserTimeEstimateSchema` already inlined for R07).
 */
const CurrencySchema = z.object({
  amount: z
    .union([z.string(), z.number()])
    .refine((v) => typeof v === 'string' || (Number.isFinite(v) && !Number.isNaN(v)), {
      message: 'amount must be a finite number or a string',
    })
    .transform((v) => String(v)),
  currency: z.enum(['CZK', 'EUR', 'USD']),
});

const FileBasicSchema = z
  .object({
    id: z.number().int(),
    uuid: z.string(),
    filename: z.string().nullable().optional(),
    size: z.number().int().nullable().optional(),
  })
  .passthrough();

/**
 * Comment embedded inside `TaskDetail.comments[]`. Per OpenAPI :5589-5605 a
 * `CommentWithFiles` extends the bare `Comment` with author / is_description /
 * comments_reactions / files (rich `FileFull`). We accept the loosened shape
 * — author / files / etc. all `.nullable().optional()` — to absorb whatever
 * Freelo returns.
 */
const CommentWithFilesSchema = z
  .object({
    id: z.number().int(),
    content: z.string().nullable().optional(),
    date_add: z.string().nullable().optional(),
    author: UserBasicSchema.nullable().optional(),
    is_description: z.boolean().nullable().optional(),
    files: z.array(FileBasicSchema).nullable().optional(),
  })
  .passthrough();

const ProjectBasicRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

const TasklistBasicRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * Multi-project membership block embedded in `TaskDetail.multi_project_task`.
 *
 * The OpenAPI documents this loosely (description :1676 — *"the response
 * contains a `multi_project_task` block mapping the task across its projects"*)
 * without nailing down the exact shape. We accept any object with an
 * optional `projects: { id, name? }[]` array; `passthrough()` keeps the door
 * open for additional fields Freelo may emit.
 *
 * R08's `--with projects` side-car projects this block into a top-level
 * envelope key (`data.projects`) — see decision 1.
 *
 * Exported because the envelope `data` schema (`TasksShowDataSchema` below)
 * references it, and the human renderer formats it.
 */
export const MultiProjectBlockSchema = z
  .object({
    projects: z
      .array(
        z
          .object({
            id: z.number().int(),
            name: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
  })
  .passthrough();

export type MultiProjectBlock = z.infer<typeof MultiProjectBlockSchema>;

/**
 * `TaskDetail` per OpenAPI :5381-5448. Returned by `GET /task/{id}`.
 *
 * Every optional field is `.nullable().optional()` (Freelo treats null and
 * absent interchangeably, R05.5 hardening). `.passthrough()` lets unknown
 * fields ride through to the envelope (forward-compat).
 *
 * Spec 0018 §4.1.
 */
export const TaskDetailSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
    date_add: z.string().nullable().optional(),
    date_edited_at: z.string().nullable().optional(),
    due_date: z.string().nullable().optional(),
    due_date_end: z.string().nullable().optional(),
    date_finished: z.string().nullable().optional(),
    minutes: z.number().int().nullable().optional(),
    priority_enum: PriorityEnumSchema.nullable().optional(),
    count_subtasks: z.number().int().nullable().optional(),
    parent_task_id: z.number().int().nullable().optional(),
    cost: CurrencySchema.nullable().optional(),
    author: UserBasicSchema.nullable().optional(),
    worker: UserBasicSchema.nullable().optional(),
    state: StateSchema.nullable().optional(),
    comments: z.array(CommentWithFilesSchema).nullable().optional(),
    labels: z.array(TaskLabelSchema).nullable().optional(),
    project: ProjectBasicRefSchema.nullable().optional(),
    tasklist: TasklistBasicRefSchema.nullable().optional(),
    custom_fields: z.array(z.unknown()).nullable().optional(),
    total_time_estimate: TimeEstimateSchema.nullable().optional(),
    users_time_estimates: z.array(UserTimeEstimateSchema).nullable().optional(),
    tracking_users: z.array(UserBasicSchema).nullable().optional(),
    multi_project_task: MultiProjectBlockSchema.nullable().optional(),
  })
  .passthrough();

export type TaskDetail = z.infer<typeof TaskDetailSchema>;

/**
 * `Subtask` per OpenAPI :5482-5530. Inner-array element of
 * `GET /task/{id}/subtasks` (paginated).
 *
 * Spec 0018 §4.2.
 */
export const SubtaskSchema = z
  .object({
    id: z.number().int(),
    task_id: z.number().int().nullable().optional(),
    name: z.string().nullable().optional(),
    date_add: z.string().nullable().optional(),
    due_date: z.string().nullable().optional(),
    due_date_end: z.string().nullable().optional(),
    count_comments: z.number().int().nullable().optional(),
    count_subtasks: z.number().int().nullable().optional(),
    author: UserBasicSchema.nullable().optional(),
    worker: UserBasicSchema.nullable().optional(),
    state: StateSchema.nullable().optional(),
    project: ProjectBasicRefSchema.nullable().optional(),
    tasklist: TasklistBasicRefSchema.nullable().optional(),
    labels: z.array(TaskLabelSchema).nullable().optional(),
  })
  .passthrough();

export type Subtask = z.infer<typeof SubtaskSchema>;

/**
 * Lean `Comment` shape returned by `GET /task/{id}/description` (OpenAPI
 * :5574-5587 + endpoint description :2014).
 *
 * `id` is `.nullable().optional()` — when the task has no description yet,
 * the response is still 200 but fields may be empty / null per OpenAPI :2014.
 * `passthrough()` because Freelo can extend the wire shape.
 *
 * Spec 0018 §4.3.
 */
export const TaskCommentSchema = z
  .object({
    id: z.number().int().nullable().optional(),
    content: z.string().nullable().optional(),
    date_add: z.string().nullable().optional(),
    files: z.array(FileBasicSchema).nullable().optional(),
  })
  .passthrough();

export type TaskComment = z.infer<typeof TaskCommentSchema>;

/**
 * Envelope `data` shape for `freelo.tasks.show/v1` (R08).
 *
 *   - `task` always present (the `/task/{id}` call is mandatory).
 *   - `description` present only when `--with description` was passed.
 *   - `subtasks` present only when `--with subtasks` was passed.
 *   - `projects` present only when `--with projects` was passed; **may be
 *     `null`** when the task is single-project (no `multi_project_task`
 *     block on the wire). Three states matter — absent vs. null vs. object —
 *     and agents key off both `'projects' in data` and the value (decision 2).
 *
 * Spec 0018 §3.2 / §4.4.
 */
export const TasksShowDataSchema = z.object({
  task: TaskDetailSchema,
  description: TaskCommentSchema.optional(),
  subtasks: z.array(SubtaskSchema).optional(),
  projects: MultiProjectBlockSchema.nullable().optional(),
});

export type TasksShowData = z.infer<typeof TasksShowDataSchema>;

/* ---------------------------------------------------------------------------
 *  R09 — `freelo tasks create` (spec 0019)
 * ------------------------------------------------------------------------- */

/**
 * `TaskCreated` — server response shape from `POST /project/{p}/tasklist/{t}/tasks`.
 *
 * OpenAPI :5339-5380. Mirrors R07/R08 conventions:
 *   - `.passthrough()` because Freelo can extend the wire shape;
 *   - non-`id`/`name` fields are `.nullable().optional()` because Freelo treats
 *     null and absent interchangeably for empty data.
 *
 * Spec 0019 §5.
 */
export const TaskCreatedSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    date_add: z.string().nullable().optional(),
    due_date: z.string().nullable().optional(),
    due_date_end: z.string().nullable().optional(),
    worker: UserBasicSchema.nullable().optional(),
    priority_enum: z.string().nullable().optional(),
    labels: z.array(TaskLabelSchema).nullable().optional(),
    tracking_users: z.array(UserBasicSchema).nullable().optional(),
    subtasks: z
      .array(
        z
          .object({
            id: z.number().int(),
            task_id: z.number().int(),
            name: z.string(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
  })
  .passthrough();

export type TaskCreated = z.infer<typeof TaskCreatedSchema>;

/**
 * CLI-side input shape for `buildCreateTaskBody`.
 *
 * Distinct from the wire shape (`CreateTaskBody`) — the CLI accepts the
 * ergonomic `--due YYYY-MM-DD` and `--priority low|normal|high` forms; the
 * builder maps them to `due_date: YYYY-MM-DDT00:00:00Z` (decision 1) and
 * `priority_enum: 'l'|'m'|'h'`.
 */
export type CreateTaskInput = {
  name: string;
  due?: string;
  worker?: number;
  priority?: 'low' | 'normal' | 'high';
  labels?: readonly string[];
  description?: string;
};

/**
 * Wire-shape of the POST body. Matches `TaskCreate` (OpenAPI :5300-5337) for
 * the subset of fields R09 supports. Fields are emitted only when set —
 * matches the `applied_filters` convention in R07.
 */
export type CreateTaskBody = {
  name: string;
  due_date?: string;
  worker?: number;
  priority_enum?: 'h' | 'm' | 'l';
  comment?: { content: string };
  labels?: { name: string }[];
};

/**
 * Envelope `data` shape for `freelo.tasks.create/v1`.
 *
 *   - `task` is **always present** in success envelopes (live mode).
 *   - `tasklist_id` and `project_id` are echoed for round-trip clarity.
 *   - `would` is **only present** in `--dry-run` envelopes (decision: pulled
 *     up to envelope-data so `dry_run: true` + `data.would` is a single
 *     coherent shape).
 *   - `line_index` is **only present** in batch (`--stdin`) mode — 0-indexed.
 *
 * Spec 0019 §3.2.
 */
export const TasksCreateDataSchema = z.object({
  task: TaskCreatedSchema.optional(),
  tasklist_id: z.number().int(),
  project_id: z.number().int().nullable(),
  would: z
    .object({
      method: z.literal('POST'),
      path: z.string(),
      body: z.unknown(),
    })
    .optional(),
  line_index: z.number().int().nonnegative().optional(),
});

export type TasksCreateData = z.infer<typeof TasksCreateDataSchema>;
