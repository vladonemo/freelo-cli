import { type ApiResponse, type HttpClient } from './client.js';
import { SubtaskSchema, type Subtask } from './schemas/task.js';
import {
  type CreateSubtaskBody,
  type CreateSubtaskInput,
  type SubtaskStorageForm,
} from './schemas/subtask.js';

/**
 * Wire wrappers for R14 — `freelo subtasks list` / `freelo subtasks add`.
 *
 * `GET /task/{task_id}/subtasks` (`getSubtasksInTask`) is **already declared**
 * in `src/api/tasks.ts` (`getTaskSubtasks`) — used by R08's `--with subtasks`
 * side-car. R14 reuses it byte-for-byte; only the new `POST` and
 * helper-pure-functions land here.
 *
 * Spec 0025 §4.3.
 */

/**
 * `POST /task/{task_id}/subtasks` request options.
 *
 * Body type is `CreateSubtaskBody` — a subset of OpenAPI's `SubtaskCreate`
 * (:5450-5481) for the v1-supported flags (`name`, `due_date`, `worker`).
 */
export type CreateSubtaskOpts = {
  taskId: number;
  body: CreateSubtaskBody;
  signal?: AbortSignal;
  requestId?: string;
};

export type CreateSubtaskResult = {
  subtask: Subtask;
  raw: ApiResponse<Subtask>;
};

/**
 * `POST /task/{task_id}/subtasks` — create a subtask under the given parent.
 *
 * Server may transparently fall back from a **smart taskcheck** (full task
 * with worker, due date, tracking users) to a **simple taskcheck** (a
 * checkbox row with only a name) when the parent's tasklist can't host smart
 * ones — OpenAPI :2425. The body fields the user sent for `worker`, `due_date`,
 * etc. are silently discarded on the simple path; the CLI infers the
 * resulting form via `inferStorageForm` (below) and surfaces the ignored
 * inputs in the response envelope.
 *
 * This wrapper does **not** special-case the fallback — it validates the
 * response shape through `SubtaskSchema` (which tolerates both smart and
 * simple shapes via `.passthrough()` + `.nullable().optional()` on rich
 * fields, courtesy of R08) and lets the leaf command interpret the form.
 *
 * Spec 0025 §4.3.
 */
export async function createSubtask(
  client: HttpClient,
  opts: CreateSubtaskOpts,
): Promise<CreateSubtaskResult> {
  const raw = await client.request({
    method: 'POST',
    path: createSubtaskPath(opts.taskId),
    body: opts.body,
    schema: SubtaskSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { subtask: raw.data, raw };
}

/**
 * Resolve the wire path for a create call. Exposed so `--dry-run` envelopes
 * can echo the path without re-running the network branch (mirrors
 * `createTaskPath` in R09 and `deletePath` in R13).
 */
export function createSubtaskPath(taskId: number): string {
  return `/task/${taskId}/subtasks`;
}

/**
 * Map CLI input → wire body. Mirrors R09's `buildCreateTaskBody`:
 *
 *   - `due` (YYYY-MM-DD) → `due_date: <date>T00:00:00Z`. Spec 0025 §4.3.
 *   - `worker` passes through as-is.
 *   - Fields are emitted only when set (R07's filter-omit convention).
 *
 * Pure function — no I/O, no global state.
 */
export function buildCreateSubtaskBody(input: CreateSubtaskInput): CreateSubtaskBody {
  const body: CreateSubtaskBody = { name: input.name };
  if (input.due !== undefined) {
    body.due_date = `${input.due}T00:00:00Z`;
  }
  if (input.worker !== undefined) {
    body.worker = input.worker;
  }
  return body;
}

/**
 * Infer the storage form (`'smart' | 'simple'`) from the server response
 * shape. The Freelo API does not return an explicit `kind` field — we read
 * it from which fields are populated.
 *
 * **Heuristic** (spec 0025 §4.4):
 *
 *   - Any of `worker`, `due_date`, `due_date_end`, `state`, `tasklist`, or
 *     `project` non-null/non-undefined → `'smart'`.
 *   - All of those absent or null → `'simple'`.
 *
 * **Limitation accepted in v1**: a smart subtask created with no rich fields
 * (e.g. `--name "x"` only on a tasklist that *can* host smart subtasks) can
 * return a lean response and mis-classify as `'simple'`. The trade-off is
 * acceptable because (a) calling that case "simple" is functionally correct
 * — there is no rich data either way — and (b) the alternative (round-trip
 * GET to confirm) costs an extra request per add and still wouldn't give a
 * deterministic answer.
 *
 * Pure function — no I/O.
 */
export function inferStorageForm(s: Subtask): SubtaskStorageForm {
  if (
    s.worker != null ||
    s.due_date != null ||
    s.due_date_end != null ||
    s.state != null ||
    s.tasklist != null ||
    s.project != null
  ) {
    return 'smart';
  }
  return 'simple';
}
