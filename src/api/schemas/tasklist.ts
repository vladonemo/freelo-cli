import { z } from 'zod';

/**
 * Zod schemas for the tasklist entity used by R05 `freelo tasklists list`.
 *
 * Per spec 0014 §4.1: entity shape is `TasklistFull` (OpenAPI :5065-5090).
 * Only `id` and `name` are universally required (inherited from
 * `TasklistBasic`); every extension field is optional.
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

const CurrencySchema = z.object({
  amount: z.string(),
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
