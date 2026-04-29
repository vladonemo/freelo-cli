import { z } from 'zod';

/**
 * Zod schemas for the `reports` (work-reports) resource group, R21 (spec 0033).
 *
 * Wire shape: `WorkReportFull` from OpenAPI :5713-5771 — the response item type
 * for `GET /work-reports`. Extends the simpler `WorkReport` (:5669-5698) with
 * extra task / project / tasklist context.
 *
 * Loose by design: every entity-link block uses `.passthrough()` and most
 * non-id fields are `.nullable().optional()`. Mirrors the conventions in
 * `src/api/schemas/comment.ts` and `src/api/schemas/task.ts`.
 *
 * `UserBasicSchema` is declared **locally** rather than imported from
 * `src/api/schemas/project.ts` because the canonical one is NOT passthrough
 * — and `/work-reports` rows can carry user fields (avatar / email / role)
 * we don't want to drop. See spec 0033 §10 "Risks / known gotchas".
 *
 * `CurrencySchema` is similarly a local copy — same shape and rationale as
 * `src/api/schemas/project.ts` `CurrencySchema` (private to that file). The
 * helper `tasklist.ts` follows the same convention.
 */

/**
 * Money amount as embedded in `WorkReportFull.cost` and `task.cost`.
 *
 * Live Freelo API returns `amount` as either a string (e.g. `"2000"`) or a
 * number (e.g. `2000` or `15000.5`) depending on the endpoint — sometimes per
 * record on the same response. Accept both, normalize to string at parse time
 * so the public envelope contract (`Currency.amount: string`) stays stable.
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
 * Loose user reference. Distinct from `UserBasicSchema` in
 * `src/api/schemas/project.ts` (which is NOT passthrough). `/work-reports`
 * may include avatar / email / role on the embedded user objects — keep them
 * accessible via passthrough so agents can downcast in their own consumers.
 */
const UserRefSchema = z
  .object({
    id: z.number().int(),
    fullname: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * Task block embedded in `WorkReportFull.task`. Only `id` is universally
 * required; other fields are `.nullable().optional()` so partial responses
 * don't fail validation. `passthrough` preserves additional fields
 * (`labels`, `total_time_estimate`, `users_time_estimates`, etc.).
 */
const TaskRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
    minutes: z.number().int().nullable().optional(),
    parent_task_id: z.number().int().nullable().optional(),
    cost: CurrencySchema.nullable().optional(),
  })
  .passthrough();

const ProjectRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

const TasklistRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * `WorkReportFull` — single item in the `/work-reports` paginated response
 * (OpenAPI :5713-5771).
 *
 * Required fields:
 *   - `id` — wire integer; load-bearing identity.
 *   - `date_reported` — `YYYY-MM-DD` (per OpenAPI `format: date`).
 *   - `minutes` — non-negative integer; the unit of work logged.
 *
 * Optional fields are `.nullable().optional()` — the API uses `null` and
 * absent interchangeably and the wire shape is documented loosely. R05.5's
 * sweep applies (every consumer of a Freelo entity has had at least one
 * shape surprise).
 *
 * `passthrough` preserves additional fields the server may add (e.g. a new
 * `currency` summary block, custom-fields per-report). Spec 0033 §4.1.
 */
export const WorkReportFullSchema = z
  .object({
    id: z.number().int(),
    date_add: z.string().nullable().optional(),
    date_reported: z.string(),
    date_edited_at: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    minutes: z.number().int(),
    cost: CurrencySchema.nullable().optional(),
    author: UserRefSchema.nullable().optional(),
    worker: UserRefSchema.nullable().optional(),
    task: TaskRefSchema.nullable().optional(),
    tasklist: TasklistRefSchema.nullable().optional(),
    project: ProjectRefSchema.nullable().optional(),
  })
  .passthrough();

export type WorkReportFull = z.infer<typeof WorkReportFullSchema>;

/**
 * `freelo.reports.list/v1` envelope `data.applied_filters` shape.
 *
 * Always an object (possibly empty `{}`). Only keys the user explicitly set
 * are emitted — unset keys are omitted, mirroring `comments list`'s
 * `applied_filters` precedent (spec 0027 decision 4).
 *
 * Spec 0033 §3.3.
 */
export const ReportsListAppliedFiltersSchema = z.object({
  tasks: z.array(z.number().int()).optional(),
  projects: z.array(z.number().int()).optional(),
  workers: z.array(z.number().int()).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type ReportsListAppliedFilters = z.infer<typeof ReportsListAppliedFiltersSchema>;

/**
 * `freelo.reports.list/v1` envelope `data` shape.
 *
 *   - `applied_filters`: echo of the user's parsed flags (see above).
 *   - `reports`: post-validation `WorkReportFull` array. No client-side
 *     post-filter in v1 (`--from` / `--to` are server-side via
 *     `date_reported_range`).
 *
 * `paging` and `rate_limit` travel at the envelope level. Spec 0033 §3.3.
 */
export const ReportsListDataSchema = z.object({
  applied_filters: ReportsListAppliedFiltersSchema,
  reports: z.array(WorkReportFullSchema),
});
export type ReportsListData = z.infer<typeof ReportsListDataSchema>;

/* ---------------------------------------------------------------------------
 *  R22 — write commands (spec 0034)
 *
 *  Three envelope schemas:
 *    - `freelo.reports.log/v1`     — POST /task/{id}/work-reports
 *    - `freelo.reports.edit/v1`    — POST /work-reports/{id}
 *    - `freelo.reports.delete/v1`  — DELETE /work-reports/{id}
 *
 *  Plus a public-contract `ReportProjection` shape (tightened from
 *  `WorkReportFullSchema`) carried on the live envelopes.
 * ------------------------------------------------------------------------- */

/**
 * Public-contract `WorkReport` projection — the shape emitted on the
 * `freelo.reports.log/v1` and `freelo.reports.edit/v1` envelopes. Same
 * field set as `TimeStopWorkReportSchema` from spec 0032 but local to
 * the reports family for module-locality (avoid cross-domain pulls).
 *
 * Differs from `WorkReportFullSchema` (the wire/list schema) in:
 *   - inner refs are tightened (no `.passthrough()`);
 *   - every nullable wire field is normalized to `null` (never `undefined`);
 *   - the `tasklist` and `project` blocks are dropped — the create / edit
 *     responses don't include them, and surfacing them as `null` would
 *     mislead consumers reading `report.project` and getting `null` even
 *     when the report IS attached to a project (just not in the response).
 *
 * Spec 0034 §6.
 */
export const ReportProjectionSchema = z.object({
  id: z.number().int(),
  date_add: z.string().nullable(),
  date_reported: z.string(),
  minutes: z.number().int(),
  note: z.string().nullable(),
  task: z
    .object({
      id: z.number().int(),
      name: z.string().nullable(),
    })
    .nullable(),
  cost: z
    .object({
      amount: z.string(),
      currency: z.string(),
    })
    .nullable(),
  worker: z
    .object({
      id: z.number().int(),
      fullname: z.string().nullable(),
    })
    .nullable(),
  author: z
    .object({
      id: z.number().int(),
      fullname: z.string().nullable(),
    })
    .nullable(),
});
export type ReportProjection = z.infer<typeof ReportProjectionSchema>;

/**
 * Project the wire `WorkReportFull` onto the public `ReportProjection`
 * shape. Pure function — no I/O. Mirrors `projectWorkReport` from
 * `src/commands/time/stop.ts` byte-for-byte modulo the type names.
 *
 * Spec 0034 §6.
 */
export function projectReport(wire: WorkReportFull): ReportProjection {
  const task: ReportProjection['task'] =
    wire.task !== null && wire.task !== undefined
      ? { id: wire.task.id, name: wire.task.name ?? null }
      : null;
  const cost: ReportProjection['cost'] =
    wire.cost !== null && wire.cost !== undefined
      ? { amount: wire.cost.amount, currency: wire.cost.currency }
      : null;
  const worker: ReportProjection['worker'] =
    wire.worker !== null && wire.worker !== undefined
      ? { id: wire.worker.id, fullname: wire.worker.fullname ?? null }
      : null;
  const author: ReportProjection['author'] =
    wire.author !== null && wire.author !== undefined
      ? { id: wire.author.id, fullname: wire.author.fullname ?? null }
      : null;
  return {
    id: wire.id,
    date_add: wire.date_add ?? null,
    date_reported: wire.date_reported,
    minutes: wire.minutes,
    note: wire.note ?? null,
    task,
    cost,
    worker,
    author,
  };
}

/* ---------------------------------------------------------------------------
 *  freelo.reports.log/v1
 * ------------------------------------------------------------------------- */

/**
 * Echo of the user's `reports log` input. Always includes `task_id` and
 * `minutes` (both required); `date_reported` and `note` are present iff
 * the user passed them. Mirrors the wire body shape (spec 0034 §5.1).
 */
export const ReportsLogAppliedInputSchema = z.object({
  task_id: z.number().int(),
  minutes: z.number().int(),
  date_reported: z.string().optional(),
  note: z.string().optional(),
});
export type ReportsLogAppliedInput = z.infer<typeof ReportsLogAppliedInputSchema>;

/** Live `data` shape for `freelo.reports.log/v1` (post-POST). */
export const ReportsLogLiveDataSchema = z.object({
  report: ReportProjectionSchema,
  applied_input: ReportsLogAppliedInputSchema,
  line_index: z.number().int().min(0).optional(),
});
export type ReportsLogLiveData = z.infer<typeof ReportsLogLiveDataSchema>;

/** Dry-run `data` shape for `freelo.reports.log/v1` (no POST happened). */
export const ReportsLogDryRunDataSchema = z.object({
  applied_input: ReportsLogAppliedInputSchema,
  line_index: z.number().int().min(0).optional(),
});
export type ReportsLogDryRunData = z.infer<typeof ReportsLogDryRunDataSchema>;

/* ---------------------------------------------------------------------------
 *  freelo.reports.edit/v1
 * ------------------------------------------------------------------------- */

/**
 * Echo of the wire body for `reports edit`. Each key is present iff the
 * user actually passed the corresponding flag. At least one key is
 * always present (empty edit rejected at the command layer).
 */
export const ReportsEditAppliedChangesSchema = z.object({
  minutes: z.number().int().optional(),
  note: z.string().optional(),
  date_reported: z.string().optional(),
});
export type ReportsEditAppliedChanges = z.infer<typeof ReportsEditAppliedChangesSchema>;

/** Live `data` shape for `freelo.reports.edit/v1`. */
export const ReportsEditLiveDataSchema = z.object({
  report: ReportProjectionSchema,
  applied_changes: ReportsEditAppliedChangesSchema,
  line_index: z.number().int().min(0).optional(),
});
export type ReportsEditLiveData = z.infer<typeof ReportsEditLiveDataSchema>;

/** Dry-run `data` shape for `freelo.reports.edit/v1`. */
export const ReportsEditDryRunDataSchema = z.object({
  applied_changes: ReportsEditAppliedChangesSchema,
  line_index: z.number().int().min(0).optional(),
});
export type ReportsEditDryRunData = z.infer<typeof ReportsEditDryRunDataSchema>;

/* ---------------------------------------------------------------------------
 *  freelo.reports.delete/v1
 *
 *  Mirrors `TasksDeleteDataSchema` (spec 0024) modulo the field rename
 *  `task_id` → `report_id`. Same idempotency convention: a 404 (or a
 *  body-text-distinguished 400) on DELETE re-classifies as
 *  `already_in_target_state: true` and exit 0.
 * ------------------------------------------------------------------------- */

export const ReportsDeleteDataSchema = z.object({
  report_id: z.number().int(),
  previous_state: z.literal(null),
  current_state: z.literal('deleted'),
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
export type ReportsDeleteData = z.infer<typeof ReportsDeleteDataSchema>;
