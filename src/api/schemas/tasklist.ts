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
