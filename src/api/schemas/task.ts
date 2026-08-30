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

/**
 * `minutes`-style duration field on response paths. The live Freelo API
 * sometimes returns these as strings (e.g. `"130"` on `GET /task/{id}`)
 * even though the OpenAPI spec types them as integer. Same divergence
 * pattern as `CurrencySchema.amount` below (:243) — accept either, coerce
 * to a number. Do not use this for input/echo schemas where we control
 * the value.
 */
const MinutesSchema = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'string' ? Number.parseInt(v, 10) : v))
  .pipe(z.number().int());

const TimeEstimateSchema = z.object({ minutes: MinutesSchema }).passthrough();

const UserTimeEstimateSchema = z
  .object({
    minutes: MinutesSchema,
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
 * Accepted `order_by` values for `freelo tasks list`, and the single source of
 * truth behind `--order-by`'s runtime allow-list, its help text, and the three
 * compile-time unions that guard the call sites (`ListOpts.orderBy`,
 * `AllTasksFilters.orderBy`, `TasklistTasksOpts.orderBy`).
 *
 * Both task-listing routes document the same five values in
 * `docs/api/freelo-api.yaml` — `/project/{p}/tasklist/{t}/tasks` (line 1522,
 * default `priority`) and `/all-tasks` (line 1639, default `date_add`) — so one
 * list covers both. They differ only in their *default*, which is applied at
 * the call site, not here.
 *
 * `due_date` was added upstream in the PR #112 spec refresh (spec 0063). Per the
 * contract: tasks without a due date always sort last, and all-day tasks sort at
 * the start of their day (00:00). On `/all-tasks` results are additionally
 * tie-broken by task id so page boundaries stay stable. All of that is
 * server-side — the CLI forwards the string and never re-sorts.
 *
 * Note `priority` here is the tasklist's manual/drag board order, not the L/M/H
 * `priority_enum` field that shares the name (spec 0060, issue #108).
 */
export const TASK_ORDER_BY_VALUES = [
  'priority',
  'name',
  'date_add',
  'date_edited_at',
  'due_date',
] as const;

export type TaskOrderBy = (typeof TASK_ORDER_BY_VALUES)[number];

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
  order_by?: TaskOrderBy;
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

/**
 * File attachment embedded in a comment — `TaskDetail.comments[].files[]` (:289)
 * and `TaskComment.files[]` (:422).
 *
 * **No field is required** (spec 0059, issue #105). Freelo's embedded file DTO
 * carries no numeric `id`; when this schema demanded one, every task whose first
 * comment had an attachment failed `GET /task/{id}` outright:
 *
 *     Unexpected response shape from GET /task/18579501:
 *     [{ code: "invalid_type", expected: "number", received: "undefined",
 *        path: ["comments", 0, "files", 0, "id"], message: "Required" }]
 *
 * `uuid` is relaxed with it (decision 3): the two sibling file-ref schemas written
 * later — `FileFullRefSchema` (`comment.ts:62-66`) and `NoteFileRefSchema`
 * (`note.ts:38-42`) — both model this position with `uuid` optional and no `id`,
 * and the module convention at :10-12 says non-universal fields are
 * `.nullable().optional()`. This schema was the outlier.
 *
 * Fields still validate *when present*; `.passthrough()` carries the rest through
 * to the envelope.
 */
const FileBasicSchema = z
  .object({
    id: z.number().int().nullable().optional(),
    uuid: z.string().nullable().optional(),
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
    minutes: MinutesSchema.nullable().optional(),
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
 * `Subtask` per OpenAPI :6374-6433. Inner-array element of
 * `GET /task/{id}/subtasks` (paginated), and the body of
 * `POST /task/{id}/subtasks`.
 *
 * **`type` is present on GET and absent on POST.** Verified against the live
 * API on 2026-08-30 (R14, `docs/runs/2026-08-29-2230-r14-subtask-type/`):
 * the create response carries no `type` key at all, on either the smart or
 * the fallback path. It is therefore `.optional()` — not because the contract
 * marks it so, but because a whole endpoint omits it. Anything deriving from
 * `type` must handle its absence; see `inferStorageForm` in
 * `src/api/subtasks.ts`.
 *
 * Spec 0018 §4.2, spec 0069 §6.
 */
export const SubtaskSchema = z
  .object({
    id: z.number().int(),
    /**
     * `subtask` = smart subtask (carries its own `task_id`);
     * `taskcheck` = simple checklist item (`task_id` is `null`).
     * OpenAPI :6379-6382. GET only — see the schema note above.
     */
    type: z.enum(['subtask', 'taskcheck']).nullable().optional(),
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
 *
 * `labels` is **deliberately absent** here (spec 0041 §5.1). The live
 * `POST /project/{p}/tasklist/{t}/tasks` endpoint requires `{uuid, name, color}`
 * for every label entry — name-only is rejected with HTTP 400. Labels travel
 * out-of-band: the command layer creates the task without labels, then issues
 * a `POST /task-labels/add-to-task/{newId}` for the requested names.
 */
export type CreateTaskBody = {
  name: string;
  due_date?: string;
  worker?: number;
  priority_enum?: 'h' | 'm' | 'l';
  comment?: { content: string };
};

/**
 * Single descriptor for one would-be wire call inside `data.would[]`. Mirrors
 * `EditWouldEntrySchema` (R10) — both R09 (after spec 0041 fix) and R10 fan
 * out across multiple endpoints in `--dry-run`.
 *
 * Spec 0041 §6.2.
 */
export const CreateWouldEntrySchema = z.object({
  method: z.literal('POST'),
  path: z.string(),
  body: z.unknown(),
});

export type CreateWouldEntry = z.infer<typeof CreateWouldEntrySchema>;

/**
 * Per-label attach failure record, surfaced under `data.applied_labels.failed`.
 *
 * Because the attach call is a single batched POST, the failure mode is
 * all-or-nothing: either all requested names land in `attached`, or all land
 * in `failed` (with the same root error repeated per name). Callers that want
 * "everything failed" can simply read `applied_labels.attached.length === 0`.
 *
 * Spec 0041 §6.2.
 */
export const AppliedLabelFailureSchema = z.object({
  name: z.string(),
  error_code: z.string(),
  http_status: z.number().int().nullable(),
  message: z.string(),
});

export type AppliedLabelFailure = z.infer<typeof AppliedLabelFailureSchema>;

/**
 * Envelope `data` shape for `freelo.tasks.create/v2`.
 *
 *   - `task` is **always present** in success envelopes (live mode).
 *   - `tasklist_id` and `project_id` are echoed for round-trip clarity.
 *   - `would` is **only present** in `--dry-run` envelopes. **Bumped to an
 *     array in /v2** (spec 0041 §6.1) — was a single object in /v1. The
 *     create-then-attach flow may emit two entries (create + attach); without
 *     `--label`, the array has length 1.
 *   - `applied_labels` is **only present** when `--label` was passed AND we
 *     reached the live attach phase. Carries the names requested, the names
 *     the attach call confirmed, and per-name failure records when the attach
 *     POST fails. Absent in dry-run; absent when no labels were requested.
 *   - `line_index` is **only present** in batch (`--stdin`) mode — 0-indexed.
 *
 * Spec 0019 §3.2 (R09) + spec 0041 §6 (label-fix bump).
 */
export const TasksCreateDataSchema = z.object({
  task: TaskCreatedSchema.optional(),
  tasklist_id: z.number().int(),
  project_id: z.number().int().nullable(),
  would: z.array(CreateWouldEntrySchema).optional(),
  applied_labels: z
    .object({
      requested: z.array(z.string()),
      attached: z.array(z.string()),
      failed: z.array(AppliedLabelFailureSchema),
    })
    .optional(),
  line_index: z.number().int().nonnegative().optional(),
});

export type TasksCreateData = z.infer<typeof TasksCreateDataSchema>;

/* ---------------------------------------------------------------------------
 *  R10 — `freelo tasks edit <id>` (spec 0020)
 * ------------------------------------------------------------------------- */

/**
 * CLI-side input for `buildEditTaskBody`. Every field is optional — callers
 * pre-flight that at least one mutating flag is set; the builder doesn't.
 *
 * `clearPriority` is mutually exclusive with `priority` (validated at the
 * command layer); when set, the builder emits `priority_enum: null` to signal
 * the explicit clear (OpenAPI :1739 — `priority_enum` is nullable).
 *
 * Spec 0020 §5.
 */
export type EditTaskInput = {
  name?: string;
  due?: string; // YYYY-MM-DD; mapped to YYYY-MM-DDT00:00:00Z
  worker?: number;
  priority?: 'low' | 'normal' | 'high'; // mapped to 'l'|'m'|'h'
  clearPriority?: true; // mutex with `priority`
};

/**
 * Wire shape of `POST /task/{task_id}` body. Subset of the documented
 * whitelist (OpenAPI :1717-1755): only the fields R10 supports.
 *
 * `priority_enum: null` is the explicit-clear signal (decision: only emit
 * this key when the user passes `--clear-priority`).
 */
export type EditTaskBody = {
  name?: string;
  due_date?: string;
  worker?: number;
  priority_enum?: 'l' | 'm' | 'h' | null;
};

/**
 * Single descriptor for one would-be wire call inside `data.would[]`.
 * R10's `would` is an array (not a single object as in R09) because the
 * edit fans out across up to 3 endpoints — see spec 0020 §3.2 / decision 5.
 */
export const EditWouldEntrySchema = z.object({
  method: z.literal('POST'),
  path: z.string(),
  body: z.unknown(),
});

export type EditWouldEntry = z.infer<typeof EditWouldEntrySchema>;

/**
 * Envelope `data` shape for `freelo.tasks.edit/v1`.
 *
 *   - `task`: post-edit `TaskDetail` (a fresh GET runs after every successful
 *     write). May be **null** when all writes succeeded but the refresh GET
 *     failed (decision 11 — surfaced with a `notice` on the envelope).
 *   - `tasklist_id` / `project_id`: derived from the lookup GET; null if the
 *     lookup happened but the wire had no ref (defensive).
 *   - `applied_changes`: honest accumulator — only contains what *succeeded*
 *     on the wire (decision 12). `edit` is the wire body (snake-case keys).
 *     `labels_added` / `labels_removed` carry the input names (not server
 *     UUIDs — those are visible in `task.labels[]`).
 *   - `would`: present only in `--dry-run` envelopes. An array, in the order
 *     the calls would have happened (remove-labels, add-labels, edit).
 *
 * Spec 0020 §3.2.
 */
export const TasksEditDataSchema = z.object({
  task: TaskDetailSchema.nullable().optional(),
  tasklist_id: z.number().int().nullable(),
  project_id: z.number().int().nullable(),
  applied_changes: z.object({
    edit: z.record(z.string(), z.unknown()),
    labels_added: z.array(z.string()),
    labels_removed: z.array(z.string()),
  }),
  would: z.array(EditWouldEntrySchema).optional(),
});

export type TasksEditData = z.infer<typeof TasksEditDataSchema>;

/* ---------------------------------------------------------------------------
 *  R11 — `freelo tasks finish` / `freelo tasks reopen` (spec 0021)
 * ------------------------------------------------------------------------- */

/**
 * Task state values from `TaskDetail.state.state`.
 *
 * Mirrors the `StateSchema` enum declared at the top of this module. Exposed
 * separately so command code can write `'active' | 'finished'` literals
 * without importing from a private module.
 */
export type TaskState = 'active' | 'archived' | 'finished' | 'deleted' | 'template';

/**
 * Envelope `data` shape shared by `freelo.tasks.finish/v1` and
 * `freelo.tasks.reopen/v1`.
 *
 *   - `task_id`: positive integer.
 *   - `previous_state` / `current_state`: lowercase strings from
 *     `TaskDetail.state.state`. Both ALWAYS present in success envelopes; in
 *     dry-run they are equal (no POST happened).
 *   - `already_in_target_state`: `true` ⇔ the POST was skipped because the
 *     observed state already matched the target (idempotent short-circuit).
 *   - `verb`: literal `'finish'` or `'reopen'`. Lets a consumer route on the
 *     payload without re-parsing `schema`.
 *   - `would`: present only in --dry-run AND only when a POST would have run
 *     (i.e. NOT already-in-target).
 *   - `line_index`: present only in --stdin batch (0-indexed across non-empty
 *     input lines). Matches R09's convention.
 *
 * Both schemas — `freelo.tasks.finish/v1` and `freelo.tasks.reopen/v1` —
 * share this `data` shape (only the schema discriminant differs). Two
 * SchemaString constants live in code so agents can route on `schema` alone.
 *
 * Spec 0021 §3.2 / §4.
 */
export const TasksTransitionDataSchema = z.object({
  task_id: z.number().int(),
  previous_state: z.enum(['active', 'archived', 'finished', 'deleted', 'template']),
  current_state: z.enum(['active', 'archived', 'finished', 'deleted', 'template']),
  already_in_target_state: z.boolean(),
  verb: z.enum(['finish', 'reopen']),
  would: z
    .object({
      method: z.literal('POST'),
      path: z.string(),
      body: z.unknown(),
    })
    .optional(),
  line_index: z.number().int().nonnegative().optional(),
});

export type TasksTransitionData = z.infer<typeof TasksTransitionDataSchema>;

/* ---------------------------------------------------------------------------
 *  R12 — `freelo tasks move <id>` (spec 0022)
 * ------------------------------------------------------------------------- */

/**
 * Envelope `data` shape for `freelo.tasks.move/v1`.
 *
 *   - `task_id`: positive integer (the source task).
 *   - `from_tasklist_id`: integer or null. Observed via the pre-check GET on
 *     the source task. Null when the wire's `task.tasklist` ref is missing
 *     (defensive — passthrough may let null through).
 *   - `to_tasklist_id`: integer (always set; comes from `--to-tasklist`).
 *   - `from_project_id`: integer or null (pre-check derived).
 *   - `to_project_id`: integer or null. Live success: post-move refresh GET's
 *     `task.project.id`. Idempotent skip: equals `from_project_id` (no move
 *     happened). Dry-run: null (we do NOT fetch the destination tasklist's
 *     project — that would double the GET load for what is otherwise a
 *     read-only preview).
 *   - `already_in_target_tasklist`: `true` ⇔ the POST was skipped because the
 *     pre-check showed the task already in the target tasklist (R11-style
 *     idempotency).
 *   - `task`: `TaskDetail | null`. Live success: refreshed post-move detail.
 *     Idempotent skip: pre-check detail (the pre-check IS the truth — no
 *     second GET runs). Dry-run: pre-check detail. Refresh-GET-failed: null
 *     (with a `notice` on the envelope; mirrors R10 spec 0020 decision 11).
 *   - `would`: present only in --dry-run AND only when a POST would have run
 *     (i.e. NOT already-in-target-tasklist). Mirrors R11's shape.
 *   - `line_index` (R12.5, additive): set ONLY in `--stdin` batch mode. 0-indexed
 *     across non-empty input lines (mirrors `tasks create --stdin` and
 *     `tasks finish --stdin`). Single-mode envelopes never carry this field —
 *     R12 v1 shape is preserved byte-for-byte for existing callers.
 *
 * Spec 0022 §3.2 / §3.5 / §4. R12.5 / spec 0023 — additive `line_index`.
 */
export const TasksMoveDataSchema = z.object({
  task_id: z.number().int(),
  from_tasklist_id: z.number().int().nullable(),
  to_tasklist_id: z.number().int(),
  from_project_id: z.number().int().nullable(),
  to_project_id: z.number().int().nullable(),
  already_in_target_tasklist: z.boolean(),
  task: TaskDetailSchema.nullable().optional(),
  would: z
    .object({
      method: z.literal('POST'),
      path: z.string(),
      body: z.unknown(),
    })
    .optional(),
  /**
   * R12.5 (additive). Present in `--stdin` batch envelopes; absent in single
   * mode. 0-indexed across non-empty input lines.
   */
  line_index: z.number().int().min(0).optional(),
});

export type TasksMoveData = z.infer<typeof TasksMoveDataSchema>;

/* ---------------------------------------------------------------------------
 *  R13 — `freelo tasks delete <id>` (spec 0024)
 * ------------------------------------------------------------------------- */

/**
 * Envelope `data` shape for `freelo.tasks.delete/v1`.
 *
 *   - `task_id`: positive integer (the task we tried to delete).
 *   - `previous_state`: lowercase task state OR `null` when the CLI did NOT
 *     pre-fetch via GET. R13 deliberately does NOT pre-check (spec 0024
 *     decision 4) — the DELETE response is authoritative and a GET would
 *     double API load on a destructive op. So `previous_state` is **always
 *     `null`** in v1; the field is reserved (typed `nullable`) for future
 *     versions that may decide to pre-fetch on demand.
 *   - `current_state`: literal `'deleted'` (live success path) or the same
 *     state as previous (idempotent skip — but in R13 v1 we never observe
 *     a non-deleted previous_state so this is always `'deleted'` too).
 *   - `already_in_target_state`: `true` ⇔ the DELETE returned 404 (the
 *     task was already deleted before we got there). Mirrors R11's
 *     idempotency convention.
 *   - `would`: present only in `--dry-run` envelopes (and only when a
 *     DELETE would have run; with R13 there is always a wire call to make
 *     in the live path, so `would` is present in every dry-run envelope).
 *   - `line_index`: present only in `--stdin` batch mode. 0-indexed across
 *     non-empty input lines. Mirrors R09/R11/R12.5.
 *
 * Spec 0024 §3.2 / §4.2.
 */
export const TasksDeleteDataSchema = z.object({
  task_id: z.number().int(),
  previous_state: z.enum(['active', 'archived', 'finished', 'deleted', 'template']).nullable(),
  current_state: z.enum(['active', 'archived', 'finished', 'deleted', 'template']),
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

export type TasksDeleteData = z.infer<typeof TasksDeleteDataSchema>;
