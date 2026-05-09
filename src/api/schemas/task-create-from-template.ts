import { z } from 'zod';

/**
 * Zod response schema and CLI input/wire-body types for R39
 * `freelo tasks create-from-template` (spec 0053).
 *
 * Endpoint: `POST /task/create-from-template/{template_id}` (yaml :2187-2253).
 *
 * Body:
 *   - `task_id` (required) — id of the **source task INSIDE the template**.
 *   - `target_project_id` (optional) — destination project.
 *   - `target_tasklist_id` (optional) — destination tasklist inside that project.
 *   - `preset_date_from` (optional) — anchor for floating template due-dates.
 *   - `users_ids` (optional) — template member ids to invite.
 *
 * Response:
 *   `{ id, name, tasklist: { id, name } }` — the freshly-created task plus a
 *   thin reference to the tasklist it landed in.
 *
 * Conventions match `src/api/schemas/tasklist.ts`:
 *  - `.passthrough()` on entity objects — future Freelo additions stay intact.
 *  - `.nullable().optional()` on entity-name fields per the R05.5 hardening
 *    convention (Freelo can return entity objects with the human-readable
 *    name dropped for orphaned / deleted records).
 */

/**
 * Embedded `tasklist: { id, name }` reference inside the response.
 */
const TasklistRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * `TaskFromTemplate` — response shape of
 * `POST /task/create-from-template/{template_id}` (yaml :2238-2252).
 *
 * Documented fields: `id`, `name`, `tasklist: { id, name }`. We keep `name` as
 * non-nullable (a freshly-created task is guaranteed to have a name — copied
 * from the template) but the embedded `tasklist.name` follows the R05.5
 * loosening pattern.
 */
export const TaskFromTemplateSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    tasklist: TasklistRefSchema,
  })
  .passthrough();

export type TaskFromTemplate = z.infer<typeof TaskFromTemplateSchema>;

/* ------------------------------------------------------------------------- *
 *  CLI input + wire body types
 * ------------------------------------------------------------------------- */

/**
 * CLI-side input for `freelo tasks create-from-template`. Camel-case and
 * already-validated by Commander parser callbacks.
 *
 * `workers` is `readonly number[]` because Commander's variadic flag
 * accumulator returns a fresh array each invocation; the readonly hint
 * discourages downstream mutation (mirrors R31 / spec 0047).
 */
export type CreateTaskFromTemplateInput = {
  templateId: number;
  /** Source task id INSIDE the template — body field `task_id`. */
  sourceTaskId: number;
  targetProjectId?: number;
  targetTasklistId?: number;
  /** ISO-8601 calendar date `YYYY-MM-DD`. Validated upstream. */
  dateStart?: string;
  workers?: readonly number[];
};

/**
 * Wire body shape for `POST /task/create-from-template/{template_id}`
 * (yaml :2214-2233). Optional fields are omitted entirely (not emitted as
 * `undefined`) so the JSON serialisation is clean.
 */
export type CreateTaskFromTemplateBody = {
  task_id: number;
  target_project_id?: number;
  target_tasklist_id?: number;
  preset_date_from?: string;
  users_ids?: number[];
};

/* ------------------------------------------------------------------------- *
 *  Envelope `data` shape
 * ------------------------------------------------------------------------- */

/**
 * Envelope `data` shape for `freelo.tasks.create-from-template/v1`
 * (spec 0053 §2.4).
 *
 * `data.template_id` is always present (path-positional, the most keyed-off
 * field for agents).
 * `data.task` is present on **live success** — the parsed `TaskFromTemplate`.
 * `data.would` is present on **--dry-run** — the call that would have happened.
 * Exactly one of `task` / `would` is set per envelope.
 */
export type TasksCreateFromTemplateData = {
  template_id: number;
  task?: TaskFromTemplate;
  would?: {
    method: 'POST';
    /** `/task/create-from-template/{template_id}`. */
    path: string;
    body: CreateTaskFromTemplateBody;
  };
};
