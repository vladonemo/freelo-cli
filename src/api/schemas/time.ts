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

/* ---------------------------------------------------------------------------
 *  R20 — `freelo time stop` / `time edit`  (spec 0032)
 *
 *  Wire shapes for `POST /timetracking/stop` (returns `WorkReport`) and
 *  `POST /timetracking/edit` (returns `{ uuid }`). The "POST" verb on edit
 *  follows the OpenAPI spec (yaml :2812); the roadmap's `PATCH` was a typo.
 *  See spec 0032 decision 8.
 * ------------------------------------------------------------------------- */

/** Inner refs for the WorkReport wire shape (yaml :5669-5698). */
const TimeStopWireWorkerSchema = z
  .object({
    id: z.number().int(),
    fullname: z.string().nullable().optional(),
  })
  .passthrough();

const TimeStopWireTaskSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

const TimeStopWireCostSchema = z
  .object({
    amount: z.string(),
    currency: z.string(),
  })
  .passthrough();

/**
 * 200-body shape for `POST /timetracking/stop` — a `WorkReport` (yaml :5669-5698).
 *
 * Permissive: every leaf field is `nullable+optional` because Freelo's
 * response shape varies with whether the session was task-bound and which
 * cost / billing settings applied. Inner refs are `.passthrough()` so future
 * field additions ride through.
 *
 * Spec 0032 §3.1.
 */
export const TimeStopResponseSchema = z
  .object({
    id: z.number().int(),
    date_add: z.string(),
    date_reported: z.string(),
    minutes: z.number().int(),
    note: z.string().nullable().optional(),
    cost: TimeStopWireCostSchema.nullable().optional(),
    author: TimeStopWireWorkerSchema.nullable().optional(),
    worker: TimeStopWireWorkerSchema.nullable().optional(),
    task: TimeStopWireTaskSchema.nullable().optional(),
  })
  .passthrough();
export type TimeStopResponse = z.infer<typeof TimeStopResponseSchema>;

/**
 * 200-body shape for `POST /timetracking/edit` (yaml :2844-2855). Only `uuid`
 * is documented; passthrough so future additions ride through.
 */
export const TimeEditResponseSchema = z
  .object({
    uuid: z.string(),
  })
  .passthrough();
export type TimeEditResponse = z.infer<typeof TimeEditResponseSchema>;

/* ---------------------------------------------------------------------------
 *  Envelope `data` — `freelo.time.stop/v1`
 * ------------------------------------------------------------------------- */

/**
 * Public-contract `WorkReport` shape carried on the `freelo.time.stop/v1`
 * envelope's `data.work_report`. Differs from the wire (`TimeStopResponseSchema`)
 * by tightening inner refs — the envelope is the public contract and we own
 * the shape.
 *
 * Fields agents read most:
 *   - `id`, `minutes`: the headline result.
 *   - `task`: `null` when general work; `{ id, name }` otherwise.
 *   - `cost`: `null` when not applicable; `{ amount, currency }` otherwise.
 *
 * Spec 0032 §2.3 / decision 5.
 */
export const TimeStopWorkReportSchema = z.object({
  id: z.number().int(),
  date_add: z.string(),
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
export type TimeStopWorkReport = z.infer<typeof TimeStopWorkReportSchema>;

/**
 * Live `data` shape for `freelo.time.stop/v1`. `would` is added by
 * `dryRunEnvelope` in the dry-run branch.
 */
export const TimeStopLiveDataSchema = z.object({
  work_report: TimeStopWorkReportSchema,
});
export type TimeStopLiveData = z.infer<typeof TimeStopLiveDataSchema>;

/**
 * Dry-run `data` shape for `freelo.time.stop/v1`. The body field is empty
 * (no fields in the wire body) — `dryRunEnvelope` splices the `would`
 * descriptor into `data` itself.
 */
export const TimeStopDryRunDataSchema = z.object({});
export type TimeStopDryRunData = z.infer<typeof TimeStopDryRunDataSchema>;

/* ---------------------------------------------------------------------------
 *  Envelope `data` — `freelo.time.edit/v1`
 * ------------------------------------------------------------------------- */

/**
 * Echo of the wire body — mirrors what the user actually passed (see spec
 * 0032 decision 6). `task_id` is `int|null|absent`; `note` is `str|null|absent`.
 *
 * `task_id: null` means `--no-task` was supplied (disassociate from any task).
 * `task_id: absent` means neither `--task` nor `--no-task` were passed.
 */
export const TimeEditAppliedChangesSchema = z.object({
  task_id: z.number().int().nullable().optional(),
  note: z.string().nullable().optional(),
});
export type TimeEditAppliedChanges = z.infer<typeof TimeEditAppliedChangesSchema>;

/**
 * Live `data` shape for `freelo.time.edit/v1`.
 */
export const TimeEditLiveDataSchema = z.object({
  uuid: z.string(),
  applied_changes: TimeEditAppliedChangesSchema,
});
export type TimeEditLiveData = z.infer<typeof TimeEditLiveDataSchema>;

/**
 * Dry-run `data` shape for `freelo.time.edit/v1` (no `uuid`, no POST happened).
 */
export const TimeEditDryRunDataSchema = z.object({
  applied_changes: TimeEditAppliedChangesSchema,
});
export type TimeEditDryRunData = z.infer<typeof TimeEditDryRunDataSchema>;
