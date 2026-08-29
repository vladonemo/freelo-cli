/**
 * Zod schemas for the `task-labels` resource group, R24 (spec 0036).
 *
 * Wire endpoints (yaml :2446-2573):
 *   - `POST /task-labels`                                — bulk-create label definitions
 *   - `POST /task-labels/add-to-task/{task_id}`          — attach labels to a task
 *   - `POST /task-labels/remove-from-task/{task_id}`     — detach labels from a task
 *   - `POST /task-labels/merge`                          — merge labels (M06, yaml :2936)
 *
 * Note: the detach endpoint is **POST** (not DELETE as the roadmap suggests).
 * OpenAPI is authoritative — see spec 0036 decision 01.
 *
 * Loose by design: every leaf is optional/nullable per the project's
 * permissive-schema policy (R05.5 lessons), and `would.body` is `unknown`
 * because dry-run echoes whatever the wire builder emitted.
 */

import { z } from 'zod';

/* ---------------------------------------------------------------------------
 *  Generic Freelo success envelope
 *
 *  Mirrors the local pattern in `src/api/project-labels.ts` and
 *  `src/api/reports.ts`. Tolerates additional fields.
 * ------------------------------------------------------------------------- */

export const SuccessResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();
export type SuccessResponse = z.infer<typeof SuccessResponseSchema>;

/* ---------------------------------------------------------------------------
 *  Common entry shapes (echoed in envelope `data.labels[]`)
 *
 *  Each envelope variant uses the same loose entry shape — `uuid`, `name`,
 *  and `color` are all optional individually. The CLI is responsible for
 *  ensuring the entry conforms to one of the OpenAPI `oneOf` arms before
 *  the wire call (validators in the command layer).
 * ------------------------------------------------------------------------- */

export const TaskLabelEntrySchema = z.object({
  uuid: z.string().optional(),
  name: z.string().optional(),
  color: z.string().optional(),
});
export type TaskLabelEntry = z.infer<typeof TaskLabelEntrySchema>;

/* ---------------------------------------------------------------------------
 *  Shared `would` shape for dry-run envelopes
 * ------------------------------------------------------------------------- */

const WouldSchema = z
  .object({
    method: z.literal('POST'),
    path: z.string(),
    body: z.unknown(),
  })
  .optional();

/* ---------------------------------------------------------------------------
 *  freelo.task_labels.create/v1
 *
 *  Schema string: `freelo.task_labels.create/v1`
 *  Body shape (wire): `{ labels: [{ name, color? }, ...] }`
 *  Idempotent (server-side fetch-or-create — no signal back to CLI).
 * ------------------------------------------------------------------------- */

export const TaskLabelsCreateDataSchema = z.object({
  labels: z.array(TaskLabelEntrySchema),
  count: z.number().int().min(0),
  would: WouldSchema,
});
export type TaskLabelsCreateData = z.infer<typeof TaskLabelsCreateDataSchema>;

/* ---------------------------------------------------------------------------
 *  freelo.task_labels.attach/v1
 * ------------------------------------------------------------------------- */

export const TaskLabelsAttachDataSchema = z.object({
  task_id: z.number().int(),
  labels: z.array(TaskLabelEntrySchema),
  count: z.number().int().min(0),
  would: WouldSchema,
});
export type TaskLabelsAttachData = z.infer<typeof TaskLabelsAttachDataSchema>;

/* ---------------------------------------------------------------------------
 *  freelo.task_labels.detach/v1
 *
 *  Same shape as attach — the CLI emits one envelope per call (one POST
 *  per command, bulk-by-design — spec 0036 decision 05).
 * ------------------------------------------------------------------------- */

export const TaskLabelsDetachDataSchema = z.object({
  task_id: z.number().int(),
  labels: z.array(TaskLabelEntrySchema),
  count: z.number().int().min(0),
  would: WouldSchema,
});
export type TaskLabelsDetachData = z.infer<typeof TaskLabelsDetachDataSchema>;

/* ---------------------------------------------------------------------------
 *  GET /task-labels/find-available  (M04, spec 0062)
 *
 *  Wire item shape: `TaskLabel` (OpenAPI :5949-5958) — **uuid-keyed**.
 *
 *  Do not confuse with `ProjectLabel` (`src/api/schemas/project-label.ts`),
 *  which is **id-keyed** and belongs to the separate `/project-labels/*`
 *  resource group behind `freelo labels list`. Different endpoint, different
 *  key, different CLI command. Spec 0062 §3.1.
 *
 *  Notably `TaskLabel` has **no `id` field** — the roadmap slice's
 *  "id/uuid/name/color" phrasing is wrong; the OpenAPI contract is
 *  authoritative. Spec 0062 §3.2 / decision 02. The schema is `.passthrough()`
 *  so an undocumented extra field would still survive into `--output json`.
 * ------------------------------------------------------------------------- */

export const TaskLabelSchema = z
  .object({
    uuid: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
  })
  .passthrough();
export type TaskLabel = z.infer<typeof TaskLabelSchema>;

/**
 * Response body of `GET /task-labels/find-available` (yaml :2865-2876).
 *
 * `labels` is **required** — a body without the key is a contract violation
 * and must fail validation loudly. An *empty* array is valid and expected:
 * the endpoint returns `{ "labels": [] }` (HTTP 200) both when `project_id`
 * names a project the caller can't reach and when the caller has no
 * accessible projects at all. Spec 0062 §5.
 */
export const FindAvailableTaskLabelsResponseSchema = z
  .object({
    labels: z.array(TaskLabelSchema),
  })
  .passthrough();
export type FindAvailableTaskLabelsResponse = z.infer<typeof FindAvailableTaskLabelsResponseSchema>;

/* ---------------------------------------------------------------------------
 *  freelo.task_labels.find/v1
 *
 *  `count` mirrors the `count` carried by the three sibling `task_labels.*`
 *  envelopes (create/attach/detach) — consistency within the resource group.
 *
 *  `project_id` is present only when `--project` was passed, so a consumer can
 *  distinguish a scoped-and-empty result from an unscoped-and-empty one
 *  without re-reading argv. Spec 0062 §4.1 / decision 03.
 *
 *  No `paging` — the endpoint documents no pagination parameters.
 * ------------------------------------------------------------------------- */

export const TaskLabelsFindDataSchema = z.object({
  labels: z.array(TaskLabelSchema),
  count: z.number().int().min(0),
  project_id: z.number().int().optional(),
});
export type TaskLabelsFindData = z.infer<typeof TaskLabelsFindDataSchema>;

/* ---------------------------------------------------------------------------
 *  GET /task-label-colors  (M05, spec 0067)
 *
 *  Wire item shape: `TaskLabelColor` (OpenAPI :5960-5972) — three fields, all
 *  optional per the permissive-schema policy:
 *
 *    color        hex to send as the label color, e.g. "#15acc0" (lowercase
 *                 on the wire; `PALETTE` in `src/lib/label-color.ts` stores
 *                 uppercase, so every comparison is case-insensitive)
 *    display_name the server's human-readable name — **display only, not
 *                 accepted as input** (yaml :5968). This is why the CLI's
 *                 `--palette <name>` vocabulary stays client-side; see spec
 *                 0067 §3.1(a) and §6.
 *    is_default   true for the color applied when a label is created without
 *                 one (the contract's prose default is "#77787a" = local
 *                 `PALETTE.gray`)
 *
 *  Not paginated — the endpoint declares no query parameters.
 * ------------------------------------------------------------------------- */

export const TaskLabelColorSchema = z
  .object({
    color: z.string().nullable().optional(),
    display_name: z.string().nullable().optional(),
    is_default: z.boolean().nullable().optional(),
  })
  .passthrough();
export type TaskLabelColor = z.infer<typeof TaskLabelColorSchema>;

/**
 * Response body of `GET /task-label-colors` (yaml :2884-2896).
 *
 * `colors` is **required** — a body without the key is a contract violation
 * and must fail validation loudly (exit 4). An *empty* array validates fine;
 * spec 0067 §5 renders it as a zero-row table, exit 0.
 */
export const TaskLabelColorsResponseSchema = z
  .object({
    colors: z.array(TaskLabelColorSchema),
  })
  .passthrough();
export type TaskLabelColorsResponse = z.infer<typeof TaskLabelColorsResponseSchema>;

/* ---------------------------------------------------------------------------
 *  freelo.task_labels.colors/v1
 *
 *  `palette_name` is the **local** `--palette` name whose hex equals this
 *  server color (case-insensitive), or null when the server offers a color the
 *  local table has no name for. Deliberately distinct from `display_name`:
 *  `palette_name` is what the user can type, `display_name` is what Freelo
 *  calls it and is not typeable anywhere. Spec 0067 §4.2.
 *
 *  `count` mirrors the `count` carried by the four sibling `task_labels.*`
 *  envelopes. No `paging` — the endpoint documents none.
 * ------------------------------------------------------------------------- */

export const TaskLabelsColorsEntrySchema = TaskLabelColorSchema.extend({
  palette_name: z.string().nullable(),
});
export type TaskLabelsColorsEntry = z.infer<typeof TaskLabelsColorsEntrySchema>;

export const TaskLabelsColorsDataSchema = z.object({
  colors: z.array(TaskLabelsColorsEntrySchema),
  count: z.number().int().min(0),
  default_color: z.string().nullable(),
  drift: z.object({
    matches: z.boolean(),
    server_only: z.array(z.string()),
    local_only: z.array(z.string()),
  }),
});
export type TaskLabelsColorsData = z.infer<typeof TaskLabelsColorsDataSchema>;

/* ---------------------------------------------------------------------------
 *  POST /task-labels/merge  (M06, spec 0068)
 *
 *  Wire body: `{ from_uuids: string[], to_uuid: string }` — both required
 *  (yaml :2954-2973). Wire response: `SuccessResponse` (yaml :2974-2981), i.e.
 *  `{ "result": "success" }` and nothing else. That emptiness is the whole
 *  design constraint of this envelope.
 *
 *  What is deliberately **absent**, and must stay absent:
 *
 *    tasks_updated / tasks_skipped   The 200 body carries no count and no
 *                                    per-task detail. Synthesising one would
 *                                    be fabricating a measurement the CLI
 *                                    cannot take. Spec 0068 §D1; same call as
 *                                    M03 decision 5 (`already_in_target_state`
 *                                    on taskchecks) and for the same reason.
 *    already_in_target_state         A repeat merge is a server-side no-op and
 *                                    returns the same 200. Unobservable.
 *
 *  `scope` is the single constant, and is a `z.literal` precisely so that its
 *  constancy is legible in the schema rather than something a reader has to
 *  infer from the command source. It restates a contract fact — "the
 *  replacement is applied only to tasks in projects where the caller is a
 *  commander" (yaml :2948) — which is true of every invocation and which a
 *  JSON consumer has no other way to learn. Without it an agent sees an
 *  unqualified success and concludes the merge was complete. Spec 0068 §D1b.
 * ------------------------------------------------------------------------- */

export const TaskLabelsMergeDataSchema = z.object({
  to_uuid: z.string(),
  from_uuids: z.array(z.string()),
  count: z.number().int().min(0),
  scope: z.literal('commander_projects'),
  would: WouldSchema,
});
export type TaskLabelsMergeData = z.infer<typeof TaskLabelsMergeDataSchema>;
