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

const UserBasicSchema = z.object({
  id: z.number().int(),
  fullname: z.string(),
});

const TasklistBasicSchema = z.object({
  id: z.number().int(),
  name: z.string(),
});

const ClientSchema = z
  .object({
    id: z.number().int(),
    email: z.string().optional(),
    name: z.string().optional(),
    company: z.string().optional(),
    company_id: z.string().optional(),
    company_tax_id: z.string().optional(),
    street: z.string().optional(),
    town: z.string().optional(),
    zip: z.string().optional(),
  })
  .passthrough();

const CurrencySchema = z.object({
  amount: z.string(),
  currency: z.enum(['CZK', 'EUR', 'USD']),
});

/** Entity returned by `/projects`, `/invited-projects`, `/archived-projects`, `/template-projects`. */
export const ProjectWithTasklistsSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    date_add: z.string().optional(),
    date_edited_at: z.string().optional(),
    tasklists: z.array(TasklistBasicSchema).optional(),
    client: ClientSchema.optional(),
  })
  .passthrough();

/** Entity returned by `/all-projects` — richer payload with state, owner, budget. */
export const ProjectFullSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    date_add: z.string().optional(),
    date_edited_at: z.string().optional(),
    owner: UserBasicSchema.optional(),
    state: StateSchema.optional(),
    minutes_budget: z.number().int().nullable().optional(),
    budget: CurrencySchema.optional(),
    real_minutes_spent: z.number().int().optional(),
    real_cost: CurrencySchema.optional(),
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
