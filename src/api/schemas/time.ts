import { z } from 'zod';

/**
 * Zod schemas for the `time` resource group, R19 (spec 0030).
 *
 * Three concerns:
 *
 *   1. Wire shapes for `POST /timetracking/start` and `GET /timetracking/status`
 *      (yaml :2729-2944). The status wire is a **discriminated union** keyed
 *      on HTTP status — 200 yields a session object, 204 yields `null` (the
 *      shared HTTP client passes `null` to the schema on 204; spec 0030 §2.5).
 *   2. Envelope `data` shapes for `freelo.time.start/v1` and
 *      `freelo.time.status/v1`.
 *   3. The status envelope is a public discriminated union on `active: true|false`
 *      so agents can `switch` on the discriminant without nullish checks
 *      (spec 0030 §2.3 / decision 4).
 *
 * `.passthrough()` is applied to the wire substructures so future Freelo
 * additions (e.g. a new `cost` shape) don't break validation.
 */

/* ---------------------------------------------------------------------------
 *  Wire shapes — `GET /timetracking/status` 200 body
 * ------------------------------------------------------------------------- */

const TimeProjectRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

const TimeTasklistRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

const TimeTaskRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
    project: TimeProjectRefSchema.nullable().optional(),
    tasklist: TimeTasklistRefSchema.nullable().optional(),
  })
  .passthrough();

const TimeLabelSchema = z
  .object({
    name: z.string(),
  })
  .passthrough();

/**
 * 200-body shape for `GET /timetracking/status` (yaml :2880-2942). All
 * fields permit `nullable+optional` because Freelo's response shape varies
 * with whether the session is task-bound and which project settings apply.
 */
export const TimeStatusActiveWireSchema = z
  .object({
    uuid: z.string(),
    date_reported: z.string(),
    task: TimeTaskRefSchema.nullable().optional(),
    note: z.string().nullable().optional(),
    cost: z.unknown().optional(),
    is_cost_fixed: z.boolean().optional(),
    labels: z.array(TimeLabelSchema).optional(),
    is_billable: z.boolean().optional(),
    project_setting: z.unknown().nullable().optional(),
  })
  .passthrough();
export type TimeStatusActiveWire = z.infer<typeof TimeStatusActiveWireSchema>;

/**
 * Top-level status wire schema. The shared HTTP client feeds `null` to this
 * schema on 204 No Content (spec 0030 §2.5). The union accepts:
 *
 *   - `null` ⇒ inactive (no timer running).
 *   - active session object ⇒ active (timer is running).
 */
export const TimeStatusWireSchema = z.union([z.null(), TimeStatusActiveWireSchema]);
export type TimeStatusWire = z.infer<typeof TimeStatusWireSchema>;

/* ---------------------------------------------------------------------------
 *  Wire shapes — `POST /timetracking/start` 200 body
 * ------------------------------------------------------------------------- */

/**
 * 200-body shape for `POST /timetracking/start` (yaml :2762-2772). Only
 * `uuid` is documented; passthrough so future additions ride through.
 */
export const TimeStartResponseSchema = z
  .object({
    uuid: z.string(),
  })
  .passthrough();
export type TimeStartResponse = z.infer<typeof TimeStartResponseSchema>;

/* ---------------------------------------------------------------------------
 *  Envelope `data` — `freelo.time.start/v1`
 * ------------------------------------------------------------------------- */

/**
 * Live `data` shape for `freelo.time.start/v1` (post-POST). Always carries:
 *
 *   - `uuid`: server-side UUID of the new running record.
 *   - `task_id`: echo of the `--task` flag (null when omitted).
 *   - `note`: echo of the `--note` flag (null when omitted).
 *
 * `would` is **absent** in live; **present** in `--dry-run` (added by
 * `dryRunEnvelope` from `src/lib/dry-run.ts`).
 *
 * Spec 0030 §2.3.
 */
export const TimeStartLiveDataSchema = z.object({
  uuid: z.string(),
  task_id: z.number().int().nullable(),
  note: z.string().nullable(),
});
export type TimeStartLiveData = z.infer<typeof TimeStartLiveDataSchema>;

/**
 * Dry-run `data` shape for `freelo.time.start/v1`. Identical to the live
 * shape minus `uuid` (no POST happened, no UUID exists). `dryRunEnvelope`
 * splices `would` into `data` itself.
 */
export const TimeStartDryRunDataSchema = z.object({
  task_id: z.number().int().nullable(),
  note: z.string().nullable(),
});
export type TimeStartDryRunData = z.infer<typeof TimeStartDryRunDataSchema>;

/* ---------------------------------------------------------------------------
 *  Envelope `data` — `freelo.time.status/v1`
 * ------------------------------------------------------------------------- */

/**
 * Public-contract session shape on the active branch of `freelo.time.status/v1`.
 *
 * Differs from the wire (`TimeStatusActiveWireSchema`) in three ways:
 *
 *   - `started_at` is the rename of wire `date_reported` (decision 4).
 *   - `elapsed_seconds` is **derived client-side** at envelope build time
 *     (clamped at 0 for clock skew).
 *   - Inner refs are tightened: `project` and `tasklist` are `nullable`
 *     plain objects, not passthrough — the envelope is the public contract
 *     and we own the shape.
 *
 * `cost` and `project_setting` stay `unknown` (passthrough) — these are
 * Freelo's project-setting blobs and we don't promise their shape.
 *
 * Spec 0030 §2.3.
 */
const TimeStatusSessionSchema = z.object({
  uuid: z.string(),
  started_at: z.string(),
  elapsed_seconds: z.number().int().nonnegative(),
  task: z
    .object({
      id: z.number().int(),
      name: z.string().nullable(),
      project: z.object({ id: z.number().int(), name: z.string().nullable() }).nullable(),
      tasklist: z.object({ id: z.number().int(), name: z.string().nullable() }).nullable(),
    })
    .nullable(),
  note: z.string().nullable(),
  is_billable: z.boolean(),
  is_cost_fixed: z.boolean(),
  labels: z.array(z.object({ name: z.string() })),
  cost: z.unknown(),
  project_setting: z.unknown().nullable(),
});
export type TimeStatusSession = z.infer<typeof TimeStatusSessionSchema>;

/**
 * `freelo.time.status/v1` envelope `data` — discriminated union on `active`.
 *
 *   - `{ active: true, session: ... }` — timer is running.
 *   - `{ active: false }` — no timer running (204 No Content branch).
 *
 * `active` is a literal boolean discriminant — agents `switch` on it and
 * TS narrows the union without nullish checks. Spec 0030 §2.3 / decision 3.
 */
export const TimeStatusDataSchema = z.discriminatedUnion('active', [
  z.object({ active: z.literal(true), session: TimeStatusSessionSchema }),
  z.object({ active: z.literal(false) }),
]);
export type TimeStatusData = z.infer<typeof TimeStatusDataSchema>;
