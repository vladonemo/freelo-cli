import { z, type ZodSchema, type ZodTypeAny } from 'zod';

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

/**
 * Minimal user object embedded in many response shapes (project owner,
 * task worker, …).
 *
 * `fullname` is `.nullable().optional()` — Freelo can return user objects
 * without a fullname (deleted users, externally-invited users in pending
 * state, system actors). Renderers fall back to `String(id)` for the
 * human label. See spec 0015 §1 (R05.5 Bug #1).
 */
export const UserBasicSchema = z.object({
  id: z.number().int(),
  fullname: z.string().nullable().optional(),
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

/**
 * Money amount embedded in `ProjectFull.budget`, `ProjectFull.real_cost`,
 * and the equivalent fields on `TasklistFull` (see `tasklist.ts`).
 *
 * Live Freelo API returns `amount` as either a string (e.g. `"2000"`)
 * or a number (e.g. `2000` or `15000.5`) depending on the endpoint —
 * sometimes per record on the same response. We accept both and
 * **normalize to string** at parse time so the public envelope contract
 * (`Currency.amount: string`) stays stable. See spec 0015 §2 and
 * decision 1 (R05.5 Bug #2).
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
export function paginatedProjectsWrapperSchema<S extends ZodTypeAny>(
  innerKey: string,
  itemSchema: S,
): ZodSchema<{
  total: number;
  count: number;
  page: number;
  per_page: number;
  data: Record<string, z.output<S>[]>;
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
    data: Record<string, z.output<S>[]>;
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
 *
 * Each field is `.nullable().optional()` — partial-rate records have been
 * observed in live data (per spec 0015 §1, decision 3). The whole
 * `HourRate` is also wrapped `.nullable().optional()` on its parent.
 */
const HourRateSchema = z
  .object({
    amount: z.number().int().nullable().optional(),
    currency: z.string().nullable().optional(),
    is_fixed: z.boolean().nullable().optional(),
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
    fullname: z.string().nullable().optional(),
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

/* ------------------------------------------------------------------------- *
 *  R29 — `freelo projects create` (spec 0042)
 *
 *  `POST /projects` returns the minimal `ProjectBasic` shape (just `id` and
 *  `name`). See OpenAPI :189-234 + :4944-4950.
 * ------------------------------------------------------------------------- */

/**
 * `ProjectBasic` — the response shape of `POST /projects` (OpenAPI :4944-4950).
 *
 * Minimal: `id` + `name`. `.passthrough()` so Freelo can add fields and we
 * tolerate them — the public envelope contract `data.project.id` /
 * `data.project.name` stays stable.
 *
 * Spec 0042 §5.
 */
export const ProjectBasicSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
  })
  .passthrough();

export type ProjectBasic = z.infer<typeof ProjectBasicSchema>;

/** ISO-4217 currency codes accepted by `POST /projects` (OpenAPI :221). */
export const PROJECT_CURRENCY_VALUES = ['CZK', 'EUR', 'USD'] as const;
export type ProjectCurrency = (typeof PROJECT_CURRENCY_VALUES)[number];

/**
 * CLI-side input shape for `freelo projects create`. Camel-case, friendly.
 * The body builder maps it to `CreateProjectBody` (snake-case wire shape).
 */
export type CreateProjectInput = {
  name: string;
  currency: ProjectCurrency;
  projectOwnerId?: number;
};

/** Wire shape for `POST /projects` body (OpenAPI :206-227). */
export type CreateProjectBody = {
  name: string;
  currency_iso: ProjectCurrency;
  project_owner_id?: number;
};

/**
 * Envelope `data` shape for `freelo.projects.create/v1`.
 *
 * `data.project` is present on **live success** (the wire response).
 * `data.would` is present on **--dry-run** (the call that would have happened).
 * Exactly one of the two is present per envelope. Spec 0042 §3.2.
 */
export type ProjectsCreateData = {
  project?: ProjectBasic;
  would?: {
    method: 'POST';
    path: '/projects';
    body: CreateProjectBody;
  };
};
