import { z, type ZodSchema } from 'zod';

/**
 * Zod schemas for the project entity variants and the per-endpoint paginated
 * wrappers used by R03 `freelo projects list`.
 *
 * Per spec 0009 §4.2: entity schemas use `.passthrough()` because Freelo
 * documents fields loosely; only `id` and `name` are universally required.
 * Optional fields validate when present, missing fields are tolerated.
 */

const StateSchema = z.object({
  id: z.number().int(),
  state: z.enum(['active', 'archived', 'finished', 'deleted', 'template']),
});

export const UserBasicSchema = z.object({
  id: z.number().int(),
  fullname: z.string(),
});

export type UserBasic = z.infer<typeof UserBasicSchema>;

const TasklistBasicSchema = z.object({
  id: z.number().int(),
  name: z.string(),
});

const ClientSchema = z
  .object({
    id: z.number().int(),
    email: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    company: z.string().nullable().optional(),
    company_id: z.string().nullable().optional(),
    company_tax_id: z.string().nullable().optional(),
    street: z.string().nullable().optional(),
    town: z.string().nullable().optional(),
    zip: z.string().nullable().optional(),
  })
  .passthrough();

const CurrencySchema = z.object({
  amount: z.string(),
  currency: z.enum(['CZK', 'EUR', 'USD']),
});

/**
 * Entity returned by `/projects`, `/invited-projects`, `/archived-projects`,
 * `/template-projects`.
 *
 * Every optional field is also `.nullable()` per `.claude/docs/conventions.md`
 * — Freelo uses `null` and absent interchangeably and the wire shape is
 * documented loosely. `.nullable().optional()` accepts both `undefined`
 * (absent) and `null` (returned-as-null).
 */
export const ProjectWithTasklistsSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    date_add: z.string().nullable().optional(),
    date_edited_at: z.string().nullable().optional(),
    tasklists: z.array(TasklistBasicSchema).nullable().optional(),
    client: ClientSchema.nullable().optional(),
  })
  .passthrough();

/** Entity returned by `/all-projects` — richer payload with state, owner, budget. */
export const ProjectFullSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    date_add: z.string().nullable().optional(),
    date_edited_at: z.string().nullable().optional(),
    owner: UserBasicSchema.nullable().optional(),
    state: StateSchema.nullable().optional(),
    minutes_budget: z.number().int().nullable().optional(),
    budget: CurrencySchema.nullable().optional(),
    real_minutes_spent: z.number().int().nullable().optional(),
    real_cost: CurrencySchema.nullable().optional(),
  })
  .passthrough();

export type ProjectWithTasklists = z.infer<typeof ProjectWithTasklistsSchema>;
export type ProjectFull = z.infer<typeof ProjectFullSchema>;

/**
 * `/projects` returns a bare array (no pagination wrapper) per OpenAPI :146-188.
 */
export const ProjectsBareArraySchema = z.array(ProjectWithTasklistsSchema);

/**
 * Build a paginated wrapper schema for one of the four wrapper-shaped endpoints.
 *
 * The wire shape (OpenAPI :4814-4824) is:
 *   { total, count, page, per_page, data: { [innerKey]: T[] } }
 *
 * Different endpoints use different inner keys (`projects`, `invited_projects`,
 * `archived_projects`, `template_projects`) — see spec §2.2.
 */
export function paginatedProjectsWrapperSchema<T>(
  innerKey: string,
  itemSchema: ZodSchema<T>,
): ZodSchema<{
  total: number;
  count: number;
  page: number;
  per_page: number;
  data: Record<string, T[]>;
}> {
  return z.object({
    total: z.number().int(),
    count: z.number().int(),
    page: z.number().int(),
    per_page: z.number().int(),
    data: z.object({
      [innerKey]: z.array(itemSchema),
    }),
  }) as unknown as ZodSchema<{
    total: number;
    count: number;
    page: number;
    per_page: number;
    data: Record<string, T[]>;
  }>;
}

/**
 * Discriminated-union schema for the `data` payload of the
 * `freelo.projects.list/v1` envelope. Agents read `data.entity_shape`
 * to know which fields to expect on each item in `data.projects`.
 */
export const ProjectListDataSchema = z.discriminatedUnion('entity_shape', [
  z.object({
    entity_shape: z.literal('with_tasklists'),
    scope: z.enum(['owned', 'invited', 'archived', 'templates']),
    projects: z.array(ProjectWithTasklistsSchema),
  }),
  z.object({
    entity_shape: z.literal('full'),
    scope: z.literal('all'),
    projects: z.array(ProjectFullSchema),
  }),
]);

export type ProjectListData = z.infer<typeof ProjectListDataSchema>;

export type ProjectsScope = 'owned' | 'invited' | 'archived' | 'templates' | 'all';

/**
 * Default `--fields` per scope (spec §2.7). Used both as the registry for
 * --fields validation (unknown-field detection) and the default column set
 * in human mode.
 *
 * Frozen so accidental mutation throws.
 */
export const DEFAULT_FIELDS: Readonly<Record<ProjectsScope, readonly string[]>> = Object.freeze({
  owned: Object.freeze(['id', 'name', 'date_add', 'date_edited_at', 'tasklists', 'client']),
  invited: Object.freeze(['id', 'name', 'date_add', 'date_edited_at', 'tasklists', 'client']),
  archived: Object.freeze(['id', 'name', 'date_add', 'date_edited_at', 'tasklists', 'client']),
  templates: Object.freeze(['id', 'name', 'date_add', 'date_edited_at', 'tasklists', 'client']),
  all: Object.freeze([
    'id',
    'name',
    'date_add',
    'date_edited_at',
    'owner',
    'state',
    'minutes_budget',
    'budget',
    'real_minutes_spent',
    'real_cost',
  ]),
}) as Readonly<Record<ProjectsScope, readonly string[]>>;

/** Inner data key on the four paginated endpoints (spec §2.2). */
export const INNER_KEY_BY_SCOPE: Readonly<Record<Exclude<ProjectsScope, 'owned'>, string>> =
  Object.freeze({
    invited: 'invited_projects',
    archived: 'archived_projects',
    templates: 'template_projects',
    all: 'projects',
  });

/* ------------------------------------------------------------------------- *
 *  R04 — `freelo projects show <id>` (spec 0013)
 *
 *  ProjectDetail extends ProjectFull with embedded `tasklists` (each carrying
 *  embedded `tasks[]`) and embedded `workers` (each with optional `hour_rate`).
 *  See OpenAPI :4969-5024.
 * ------------------------------------------------------------------------- */

/**
 * Lightweight task summary embedded in a tasklist. Per OpenAPI :4982-5004.
 *
 * Every optional field is `.nullable().optional()` per the project's
 * conventions: Freelo serializes null and absent interchangeably.
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

/** Tasklist with embedded tasks (used only inside ProjectDetail). */
const TasklistWithTasksSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    tasks: z.array(TaskBriefSchema).nullable().optional(),
  })
  .passthrough();

/**
 * Hourly-rate object embedded in `ProjectDetail.workers[*].hour_rate`.
 * Per OpenAPI :5014-5023. The whole object is nullable per the spec.
 */
const HourRateSchema = z
  .object({
    amount: z.number().int(),
    currency: z.string(),
    is_fixed: z.boolean(),
  })
  .passthrough();

/**
 * Worker as embedded in `ProjectDetail.workers`. Richer than `UserBasic`
 * because it carries `hour_rate`. Used only inside ProjectDetail; the
 * `/project/{id}/workers` paginated endpoint returns `UserBasic[]` with no
 * hour_rate (per OpenAPI :609-619).
 */
const WorkerWithHourRateSchema = z
  .object({
    id: z.number().int(),
    fullname: z.string(),
    hour_rate: HourRateSchema.nullable().optional(),
  })
  .passthrough();

/**
 * `GET /project/{id}` response shape — extends `ProjectFull` with embedded
 * `tasklists` and `workers`. Built via `.extend()` to preserve every field
 * already validated by ProjectFullSchema (id, name, owner, state, budget, …).
 *
 * `.passthrough()` retained so any field Freelo adds in the future is not
 * silently dropped when an agent reads `data.project`.
 */
export const ProjectDetailSchema = ProjectFullSchema.extend({
  tasklists: z.array(TasklistWithTasksSchema).nullable().optional(),
  workers: z.array(WorkerWithHourRateSchema).nullable().optional(),
}).passthrough();

export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;

/**
 * Schema for the `data` payload of the `freelo.projects.show/v1` envelope.
 *
 * `data.project` is always present (the `/project/{id}` call is mandatory).
 * `data.workers` is present only when `--with workers` was passed; absent
 * otherwise. See spec 0013 §3.2.
 */
export const ProjectShowDataSchema = z.object({
  project: ProjectDetailSchema,
  workers: z.array(UserBasicSchema).optional(),
});

export type ProjectShowData = z.infer<typeof ProjectShowDataSchema>;
