import { z } from 'zod';
import { UserBasicSchema } from './project.js';

/**
 * Zod schemas for the tasklist entity used by R05 `freelo tasklists list` and
 * R06 `freelo tasklists show <id>`.
 *
 * - `TasklistFullSchema` — list-row shape used by R05 (OpenAPI :5065-5090).
 * - `TasklistDetailSchema` — single-resource shape used by R06 (OpenAPI :5092-5126).
 *   Note: `TasklistDetail` is **not** an extension of `TasklistFull` — the
 *   field overlap is partial (see spec 0016 §4.1, decision 3).
 *
 * Conventions match `src/api/schemas/project.ts`:
 *  - `.passthrough()` on entity objects so future Freelo additions are not
 *    silently dropped on the way to envelope `data`.
 *  - `.nullable().optional()` on every optional field (Freelo treats null and
 *    absent interchangeably).
 */

const StateSchema = z.object({
  id: z.number().int(),
  state: z.enum(['active', 'archived', 'finished', 'deleted', 'template']),
});

/**
 * Money amount embedded in `TasklistFull.budget` and `TasklistFull.real_cost`.
 *
 * Live Freelo API returns `amount` as either a string or a number depending
 * on the endpoint and record. We accept both and **normalize to string**
 * so the public envelope contract (`Currency.amount: string`) stays stable.
 * See spec 0015 §2 and decision 1 (R05.5 Bug #2).
 *
 * Mirrors `CurrencySchema` in `src/api/schemas/project.ts`. Pulling these
 * into a shared module is deferred to a follow-up refactor.
 *
 * `NaN` and `Infinity` are rejected — they aren't real amounts.
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

const ProjectRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    state: StateSchema.nullable().optional(),
  })
  .passthrough();

/** `TasklistFull` per OpenAPI :5065-5090. */
export const TasklistFullSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    date_add: z.string().nullable().optional(),
    date_edited_at: z.string().nullable().optional(),
    state: StateSchema.nullable().optional(),
    project: ProjectRefSchema.nullable().optional(),
    real_minutes_spent: z.number().int().nullable().optional(),
    budget: CurrencySchema.nullable().optional(),
    real_cost: CurrencySchema.nullable().optional(),
  })
  .passthrough();

export type TasklistFull = z.infer<typeof TasklistFullSchema>;

/**
 * Envelope `data` shape for `freelo.tasklists.list/v1`.
 *
 * No discriminator — single entity shape across both scopes (`project` and
 * `all`). Agents read `data.scope` and `data.project_id` for round-trip
 * clarity. See spec 0014 §2.3.
 */
export const TasklistListDataSchema = z.object({
  scope: z.enum(['project', 'all']),
  project_id: z.number().int().nullable(),
  tasklists: z.array(TasklistFullSchema),
});

export type TasklistListData = z.infer<typeof TasklistListDataSchema>;

/**
 * Brief task object embedded in `TasklistDetail.tasks`. OpenAPI :5105-5126.
 *
 * Mirrors the `TaskBriefSchema` declared inline in `src/api/schemas/project.ts`
 * for `ProjectDetail.tasklists[*].tasks` — the wire shape is identical.
 * Promoting the two declarations to a shared module is a follow-up refactor.
 */
const TaskBriefSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    due_date: z.string().nullable().optional(),
    due_date_end: z.string().nullable().optional(),
    worker: UserBasicSchema.nullable().optional(),
    parent_task_id: z.number().int().nullable().optional(),
  })
  .passthrough();

/**
 * `TasklistDetail` per OpenAPI :5092-5126. Returned by `GET /tasklist/{id}`.
 *
 * Distinct from `TasklistFull` (which is the list-row shape). Carries:
 *  - `id`, `name` (from `TasklistBasic`)
 *  - `project_id` — required, used by R06 to construct the `/assignable-workers` URL
 *  - `date_add`, `date_edited_at`
 *  - embedded `tasks[]`
 *
 * Does **not** carry `state`, `budget`, `real_cost`, `real_minutes_spent`,
 * or a nested `project` object — those are `TasklistFull`-only.
 *
 * `project_id` is declared **required** (no `.optional()`): the OpenAPI
 * contract guarantees it, and R06 reads it for the second HTTP call. If
 * Freelo ever drops the field, schema validation fails fast at the HTTP
 * layer rather than producing a malformed second URL.
 *
 * Spec 0016 §4.1.
 */
export const TasklistDetailSchema = z
  .object({
    id: z.number().int(),
    /**
     * Tasklist name — `.nullable().optional()` per the R05.5 hardening
     * convention (Freelo can return entity objects with the human-readable
     * name dropped for orphaned / deleted records). Same loosening applied
     * to `UserBasic.fullname`.
     */
    name: z.string().nullable().optional(),
    project_id: z.number().int(),
    date_add: z.string().nullable().optional(),
    date_edited_at: z.string().nullable().optional(),
    tasks: z.array(TaskBriefSchema).nullable().optional(),
  })
  .passthrough();

export type TasklistDetail = z.infer<typeof TasklistDetailSchema>;

/**
 * Envelope `data` shape for `freelo.tasklists.show/v1` (R06).
 *
 * `assignable_workers` is **optional**: present only when the user passed
 * `--with assignable-workers`. Absent (NOT null, NOT empty array by
 * convention) when the flag wasn't passed. See spec 0016 §3.2.
 */
export const TasklistShowDataSchema = z.object({
  tasklist: TasklistDetailSchema,
  assignable_workers: z.array(UserBasicSchema).optional(),
});

export type TasklistShowData = z.infer<typeof TasklistShowDataSchema>;

/**
 * Default `--fields` registry. Both scopes share the same field set since
 * the entity is identical. Used both for `--fields` validation (unknown-field
 * detection) and as the default column set in human mode.
 *
 * Frozen so accidental mutation throws.
 */
export const TASKLIST_DEFAULT_FIELDS: readonly string[] = Object.freeze([
  'id',
  'name',
  'date_add',
  'date_edited_at',
  'state',
  'project',
  'real_minutes_spent',
  'budget',
  'real_cost',
]);

/* ------------------------------------------------------------------------- *
 *  R34 — `freelo tasklists create` (spec 0047)
 *
 *  POST /project/{project_id}/tasklists                           (yaml :1140-1178)
 *  POST /tasklist/create-from-template/{template_id}              (yaml :1290-1358)
 *
 *  Note: `DELETE /tasklist/{id}` is **not documented** in the OpenAPI as of
 *  2026-05-09. Deferred to R34.5 pending Freelo API confirmation.
 * ------------------------------------------------------------------------- */

/**
 * `TasklistWithBudget` — response shape of `POST /project/{id}/tasklists`
 * (yaml :5083-5089). `TasklistBasic` (`id` + `name`) plus optional `budget`.
 *
 * `.passthrough()` so future Freelo additions are not silently dropped. The
 * embedded `Currency` reuses the local `CurrencySchema` already declared
 * above — same wire shape ((string|number) → string normalize, enum currency).
 */
export const TasklistWithBudgetSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    budget: CurrencySchema.nullable().optional(),
  })
  .passthrough();

export type TasklistWithBudget = z.infer<typeof TasklistWithBudgetSchema>;

/**
 * Brief task object embedded in `POST /tasklist/create-from-template/{template_id}`
 * response (yaml :1339-1358). Two documented fields: `id`, `name`.
 *
 * `.passthrough()` preserves any additional fields Freelo may add in future.
 */
const TasklistFromTemplateTaskBriefSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
  })
  .passthrough();

/**
 * `TasklistFromTemplate` — response shape of
 * `POST /tasklist/create-from-template/{template_id}` (yaml :1339-1358).
 * Carries `id`, `name`, and an embedded `tasks` list (lightweight {id,name}).
 */
export const TasklistFromTemplateSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    tasks: z.array(TasklistFromTemplateTaskBriefSchema).nullable().optional(),
  })
  .passthrough();

export type TasklistFromTemplate = z.infer<typeof TasklistFromTemplateSchema>;

/**
 * CLI-side input for `freelo tasklists create`. Camel-case, friendly. The
 * body builder maps it to `CreateTasklistBody` (snake-case wire shape).
 *
 * `budget` is a string (e.g. "100000" = 1000.00 of the project's currency).
 * The CLI validates `^[0-9]+$` upstream — we keep it verbatim through the
 * builder to avoid float-precision drift.
 */
export type CreateTasklistInput = {
  projectId: number;
  name: string;
  budget?: string;
};

/** Wire shape for `POST /project/{id}/tasklists` body (yaml :1158-1171). */
export type CreateTasklistBody = {
  name: string;
  budget?: string;
};

/**
 * Envelope `data` shape for `freelo.tasklists.create/v1` (spec 0047 §3.1).
 *
 * `data.project_id` is always present (path-positional, echoed for agents).
 * `data.tasklist` is present on **live success**.
 * `data.would` is present on **--dry-run**.
 * Exactly one of `tasklist` / `would` is set per envelope.
 */
export type TasklistsCreateData = {
  project_id: number;
  tasklist?: TasklistWithBudget;
  would?: {
    method: 'POST';
    /** `/project/{id}/tasklists` — already includes the project id. */
    path: string;
    body: CreateTasklistBody;
  };
};

/**
 * CLI-side input for `freelo tasklists create-from-template`. Camel-case
 * and validated — `dateStart` matches `^\d{4}-\d{2}-\d{2}$` by the time the
 * builder sees it.
 *
 * `workers` is `readonly number[]` because Commander's variadic flag
 * accumulator returns a fresh array each invocation; the readonly hint
 * discourages downstream mutation (mirrors R31).
 */
export type CreateTasklistFromTemplateInput = {
  templateId: number;
  /** Source tasklist id INSIDE the template project — body field `tasklist_id`. */
  sourceTasklistId: number;
  targetProjectId?: number;
  targetTasklistId?: number;
  /** ISO-8601 calendar date `YYYY-MM-DD`. Validated upstream. */
  dateStart?: string;
  workers?: readonly number[];
};

/**
 * Wire body shape for `POST /tasklist/create-from-template/{template_id}`
 * (yaml :1315-1337). Optional fields are omitted entirely (not emitted
 * as `undefined`) so the JSON serialization is clean.
 */
export type CreateTasklistFromTemplateBody = {
  tasklist_id: number;
  target_project_id?: number;
  target_tasklist_id?: number;
  preset_date_from?: string;
  users_ids?: number[];
};

/**
 * Envelope `data` shape for `freelo.tasklists.create-from-template/v1`
 * (spec 0047 §3.2).
 *
 * `data.template_id` is always present (the path-positional and the most
 * keyed-off output for agents).
 * `data.tasklist` is present on **live success** — the parsed
 * `TasklistFromTemplateSchema` shape.
 * `data.would` is present on **--dry-run** — the call that would have happened.
 * Exactly one of `tasklist` / `would` is set per envelope.
 */
export type TasklistsCreateFromTemplateData = {
  template_id: number;
  tasklist?: TasklistFromTemplate;
  would?: {
    method: 'POST';
    /** `/tasklist/create-from-template/{template_id}`. */
    path: string;
    body: CreateTasklistFromTemplateBody;
  };
};

/* ------------------------------------------------------------------------- *
 *  M02 — `freelo tasklists edit <id>` (spec 0065)
 *
 *  POST /tasklist/{tasklist_id}/edit                              (yaml :1235-1305)
 * ------------------------------------------------------------------------- */

/**
 * Response shape of `POST /tasklist/{tasklist_id}/edit` (yaml :1294-1305).
 *
 * The endpoint returns **exactly one documented field**: `priorityApplied`.
 * No tasklist entity comes back — which is why M02 does not do a refresh GET
 * (spec 0065 decision 6).
 *
 * `priorityApplied` is declared **required** in the OpenAPI (`required:
 * [priorityApplied]`) and is therefore NOT `.optional()` here. A 200 that
 * omits it is a genuine contract break and must fail fast at the HTTP layer
 * rather than silently defaulting — same reasoning as `TasklistDetail.project_id`
 * above.
 *
 * Semantics (yaml :1247): the priority renumber runs **outside** the
 * transaction that commits `name`, `budget`, `time_budget_minutes`,
 * `tracking_users_ids` and `worker_id`. `false` means every other field
 * committed but the reorder did not, and the client may retry the priority
 * change alone. See spec 0065 §3.1 / decision 4 for how the CLI surfaces this.
 *
 * `.passthrough()` per repo convention so future Freelo additions survive.
 */
export const EditTasklistResponseSchema = z
  .object({
    priorityApplied: z.boolean(),
  })
  .passthrough();

export type EditTasklistResponse = z.infer<typeof EditTasklistResponseSchema>;

/**
 * CLI-side input for `freelo tasklists edit`. Camel-case and already
 * validated by the flag parsers by the time the body builder sees it.
 *
 * The `clear*` members are `true`-only (never `false`) so that "flag absent"
 * and "flag passed" are distinguishable without a tri-state. Mirrors
 * `EditTaskInput.clearPriority` (R10).
 *
 * `budget` is a digits-only string in **minor currency units** ("100000" =
 * 1000.00) — validated `^[0-9]+$` upstream and passed through verbatim to
 * avoid float-precision drift. Decimal strings are rejected by Freelo with a
 * 400 (yaml :1272), so the CLI rejects them client-side with a clearer message.
 */
export type EditTasklistInput = {
  name?: string;
  budget?: string;
  clearBudget?: true;
  timeBudgetMinutes?: number;
  clearTimeBudget?: true;
  worker?: number;
  clearWorker?: true;
  trackingUsers?: readonly number[];
  clearTrackingUsers?: true;
  shouldChangeExistingTasks?: true;
  /**
   * New **position** of the tasklist within its project (1 = first).
   * Positional ordering, NOT importance — unrelated to `priority_enum`
   * (l/m/h) elsewhere in this API. See spec 0065 §2.2.
   */
  priority?: number;
};

/**
 * Wire body for `POST /tasklist/{tasklist_id}/edit` (yaml :1262-1292).
 *
 * Every field is optional; only keys the user actually set are emitted.
 * `null` is a meaningful value on three fields (clear semantics) and is
 * distinct from the key being absent:
 *
 *   - `budget: null`               → clear the budget      (decision 8)
 *   - `time_budget_minutes: null`  → clear the time fund
 *   - `worker_id: null`            → clear the default worker
 *   - `tracking_users_ids: []`     → clear all followers
 *
 * Note `time_budget_minutes: 0` is a **real value** (a zero fund), not a
 * clear — the OpenAPI declares `minimum: 0`.
 */
export type EditTasklistBody = {
  name?: string;
  budget?: string | null;
  time_budget_minutes?: number | null;
  priority?: number;
  tracking_users_ids?: number[];
  should_change_existing_tasks?: boolean;
  worker_id?: number | null;
};

/**
 * Envelope `data` shape for `freelo.tasklists.edit/v1` (spec 0065 §3).
 *
 * `tasklist_id`, `priority_requested`, `priority_applied` and
 * `applied_changes` are **always present**. `would` is present iff `--dry-run`.
 *
 * `priority_applied` is deliberately required rather than optional: it is the
 * machine-readable half of the partial-success contract (decision 4), and an
 * optional field can be missed by absence. `priority_requested` disambiguates
 * the API's own conflation — Freelo returns `priorityApplied: true` both when
 * the reorder succeeded and when no reorder was asked for.
 */
export type TasklistsEditData = {
  tasklist_id: number;
  /** Did the user pass `--priority`? */
  priority_requested: boolean;
  /**
   * `false` only when `priority_requested` is `true` and the server reported
   * `priorityApplied: false` — i.e. every other field committed but the
   * reorder did not. Exit code stays 0; the envelope carries a `notice`.
   */
  priority_applied: boolean;
  /** The wire body that was sent (live) or would be sent (`--dry-run`). */
  applied_changes: EditTasklistBody;
  would?: {
    method: 'POST';
    /** `/tasklist/{tasklist_id}/edit`. */
    path: string;
    body: EditTasklistBody;
  };
};
